/**
 * The typesetting worker: runs jobs off the main thread so a long book
 * never freezes the editor, and keeps one session (parsed fonts, shaped
 * words, laid-out chapters) alive between jobs.
 *
 * Messages in: { id, type: "layout" | "pdf", req, fonts?, channel? }.
 * Jobs run one at a time; a layout that's been overtaken by a newer one on
 * the same channel (the live preview while typing) is skipped. Out:
 * progress, then laidout (the display list), done (PDF bytes, transferred),
 * cancelled, or error.
 */

import type { FaceBytes } from "./faces";
import { TypesetSession, type LayoutRequest } from "./run";

interface Request {
  id: number;
  type: "layout" | "pdf";
  req: LayoutRequest;
  /** Font files the session doesn't have yet. */
  fonts?: FaceBytes[];
  /** Layouts on one channel supersede each other. */
  channel?: string;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const session = new TypesetSession();
const latest = new Map<string, number>();
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.fonts?.length) session.addFonts(msg.fonts);
  if (msg.channel) latest.set(msg.channel, msg.id);
  queue = queue.then(() => run(msg));
};

async function run(msg: Request) {
  const { id } = msg;
  if (msg.channel && latest.get(msg.channel) !== id) {
    scope.postMessage({ id, type: "cancelled" });
    return;
  }
  const progress = (message: string) => scope.postMessage({ id, type: "progress", message });
  try {
    if (msg.type === "layout") {
      const { dl } = await session.layout(msg.req, progress);
      scope.postMessage({ id, type: "laidout", dl });
    } else {
      const result = await session.pdf(msg.req, progress);
      scope.postMessage({ id, type: "done", result }, [result.bytes.buffer]);
    }
  } catch (err) {
    scope.postMessage({ id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
