/**
 * The PDF engine in a worker: it parses and rewrites whole files, which is
 * no work for the thread the page is drawn on. It answers one request at a
 * time, in the order they come.
 */

import { EngineCore, failOf } from "./core";
import init from "./pkg/wfpdf.js";
import wasmUrl from "./pkg/wfpdf_bg.wasm?url";
import type { EngineAnswer, EngineReply, EngineRequest } from "./protocol";

const scope = self as unknown as { postMessage(message: EngineReply, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<{ id: number; request: EngineRequest }>) => void) | null };
const core = new EngineCore();

const started: Promise<void> = init({ module_or_path: wasmUrl }).then(
  () => scope.postMessage({ ready: true }),
  (e: unknown) => {
    scope.postMessage({ ready: false, message: String((e as { message?: unknown } | null)?.message ?? e) });
    throw e;
  },
);

function answer(request: EngineRequest): EngineAnswer {
  switch (request.op) {
    case "open":
      return core.openPdf(request.bytes, request.password);
    case "info":
      return core.info();
    case "call":
      return core.call(request.method, request.args);
    case "read":
      return core.read(request.what, request.args);
    case "bytes":
      return core.bytes(request.full);
    case "extract":
      return core.extract(request.pages);
    case "saved":
      core.saved(request.bytes);
      return null;
    case "close":
      core.close();
      return null;
  }
}

scope.onmessage = (e) => {
  const { id, request } = e.data;
  void started.then(
    () => {
      try {
        const value = answer(request);
        scope.postMessage({ id, ok: true, value }, value instanceof Uint8Array ? [value.buffer as ArrayBuffer] : []);
      } catch (thrown) {
        scope.postMessage({ id, ok: false, fail: failOf(thrown) });
      }
    },
    () => scope.postMessage({ id, ok: false, fail: { code: "Crashed", message: "The PDF engine could not start." } }),
  );
};
