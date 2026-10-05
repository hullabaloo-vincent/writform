/**
 * The typesetting worker: runs jobs off the main thread so a long book
 * never freezes the editor, and keeps one session (parsed fonts, shaped
 * words, laid-out chapters) alive between jobs.
 *
 * Messages in: { id, type: "layout" | "pdf", req, fonts?, channel?, refill? }.
 * Jobs run one at a time; a layout that's been overtaken by a newer one on
 * the same channel (the live preview while typing) is skipped. Out:
 * progress, then laidout (the display list), done (PDF bytes, transferred),
 * cancelled, or error — or fonts, asking for files the session doesn't have,
 * after which the client sends the request again with them (refill).
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
  /** Sent again with the files this session asked for: run with what came. */
  refill?: boolean;
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
  // Ids only grow; a request sent again keeps its place in line.
  if (msg.channel) latest.set(msg.channel, Math.max(latest.get(msg.channel) ?? 0, msg.id));
  queue = queue.then(() => run(msg));
};

async function run(msg: Request) {
  const { id } = msg;
  if (msg.channel && latest.get(msg.channel) !== id) {
    scope.postMessage({ id, type: "cancelled" });
    return;
  }
  // The client sends each family's files once per worker. If they never
  // arrived here (this worker started while they were on their way to the
  // one before), ask for them rather than fail.
  const missing = session.missingFamilies(msg.req.families);
  if (missing.length && !msg.refill) {
    scope.postMessage({ id, type: "fonts", families: missing });
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
