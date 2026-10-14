/**
 * The PDF engine as the page uses it: one open document, asked to do things
 * and answering later.
 *
 * In the app it is a worker. A harness hands in one that runs in place
 * (`setEngineMaker`), since nothing there can start a worker.
 *
 * The engine is WebAssembly, and a fault in it is a trap: after one nothing
 * it holds can be trusted. So a trap ends that worker. The next thing asked
 * starts a new one, which is given the file as it last stood (what was
 * undone or could be undone is lost with the old one).
 */

import type { EngineCall, EngineCalls, EngineChange, EngineFail, EngineInfo, EngineRead, EngineReads } from "./core";
import type { EngineAnswer, EngineReply, EngineRequest } from "./protocol";

export type { AddedInfo, BlockInfo, Box, EngineCall, EngineCalls, EngineChange, EngineFail, EngineInfo, EnginePage, EngineRead, EngineReads, FieldInfo, FieldValue, MarkInfo, MarkPatch, MarkSpec, NewText, Point, Rgb } from "./core";
export { isEngineFail } from "./core";

export interface Engine {
  open(bytes: Uint8Array, password?: string): Promise<EngineInfo>;
  info(): Promise<EngineInfo>;
  call<K extends EngineCall>(method: K, ...args: EngineCalls[K]): Promise<EngineChange>;
  /** Read something of the document (its marks, its form, a page's text). */
  read<K extends EngineRead>(what: K, ...args: EngineReads[K]["args"]): Promise<EngineReads[K]["value"]>;
  /** The document as a file (`full`: written afresh). */
  bytes(full: boolean): Promise<Uint8Array>;
  extract(pages: number[]): Promise<Uint8Array>;
  saved(bytes: Uint8Array): Promise<void>;
  close(): void;
}

class WorkerEngine implements Engine {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private next = 1;
  private waiting = new Map<number, { resolve: (value: EngineAnswer) => void; reject: (fail: EngineFail) => void }>();
  /** The file as it last stood, and its password: what a new worker is
   *  given after the old one failed. */
  private last: { bytes: Uint8Array; password?: string } | null = null;

  private async start(): Promise<Worker> {
    if (this.worker && this.ready) {
      await this.ready;
      return this.worker;
    }
    const { default: EngineWorker } = await import("./worker?worker");
    const worker: Worker = new EngineWorker();
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<EngineReply>) => {
        const reply = e.data;
        if ("ready" in reply) {
          if (reply.ready) resolve();
          else reject({ code: "Crashed", message: "The PDF engine could not start." } satisfies EngineFail);
          return;
        }
        const asked = this.waiting.get(reply.id);
        if (!asked) return;
        this.waiting.delete(reply.id);
        if (reply.ok) asked.resolve(reply.value);
        else {
          if (reply.fail.code === "Crashed") this.drop();
          asked.reject(reply.fail);
        }
      };
      worker.onerror = () => {
        reject({ code: "Crashed", message: "The PDF engine could not start." } satisfies EngineFail);
        this.drop();
      };
    });
    await this.ready;
    return worker;
  }

  /** End the worker, and everything that was waiting on it. */
  private drop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    const lost = [...this.waiting.values()];
    this.waiting.clear();
    for (const asked of lost) asked.reject({ code: "Crashed", message: "The PDF engine stopped." });
  }

  private async ask(request: EngineRequest, transfer: Transferable[] = []): Promise<EngineAnswer> {
    const fresh = !this.worker;
    const worker = await this.start();
    // A new worker after a failure knows nothing: it is given the file again.
    if (fresh && this.last && request.op !== "open") await this.send(worker, { op: "open", bytes: this.last.bytes.slice(), password: this.last.password });
    return this.send(worker, request, transfer);
  }

  private send(worker: Worker, request: EngineRequest, transfer: Transferable[] = []): Promise<EngineAnswer> {
    const id = this.next++;
    return new Promise<EngineAnswer>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ id, request }, transfer);
    });
  }

  async open(bytes: Uint8Array, password?: string): Promise<EngineInfo> {
    this.last = { bytes: bytes.slice(), password };
    return (await this.ask({ op: "open", bytes: bytes.slice(), password })) as EngineInfo;
  }

  async info(): Promise<EngineInfo> {
    return (await this.ask({ op: "info" })) as EngineInfo;
  }

  async call<K extends EngineCall>(method: K, ...args: EngineCalls[K]): Promise<EngineChange> {
    return (await this.ask({ op: "call", method, args })) as EngineChange;
  }

  async read<K extends EngineRead>(what: K, ...args: EngineReads[K]["args"]): Promise<EngineReads[K]["value"]> {
    return (await this.ask({ op: "read", what, args })) as EngineReads[K]["value"];
  }

  async bytes(full: boolean): Promise<Uint8Array> {
    const bytes = (await this.ask({ op: "bytes", full })) as Uint8Array;
    // (Not the clean copy: that one is not what later saves build on.)
    if (!full && this.last) this.last = { ...this.last, bytes: bytes.slice() };
    return bytes;
  }

  async extract(pages: number[]): Promise<Uint8Array> {
    return (await this.ask({ op: "extract", pages })) as Uint8Array;
  }

  async saved(bytes: Uint8Array): Promise<void> {
    this.last = this.last ? { ...this.last, bytes: bytes.slice() } : { bytes: bytes.slice() };
    await this.ask({ op: "saved", bytes: bytes.slice() });
  }

  close(): void {
    this.last = null;
    this.drop();
  }
}

let maker: () => Engine = () => new WorkerEngine();

/** For tests: where an engine comes from (one that runs in place). */
export function setEngineMaker(make: () => Engine): void {
  maker = make;
}

export function newEngine(): Engine {
  return maker();
}
