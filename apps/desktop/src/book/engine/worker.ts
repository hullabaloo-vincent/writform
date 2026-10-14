/**
 * The typesetting worker: runs jobs off the main thread so a long book
 * never freezes the editor, and keeps one session (parsed fonts, shaped
 * words, laid-out chapters) alive between jobs.
 *
 * Messages in: { id, type: "layout" | "pdf" | "pages", req, fonts?, channel?, refill? },
 * and { id, type: "images", pictures }, the answer to a PDF's request for
 * its pictures (below).
 * Jobs run one at a time; a layout that's been overtaken by a newer one on
 * the same channel (the live preview while typing) is skipped. Out:
 * progress, then laidout (the display list), done (PDF bytes, transferred),
 * pages (a document's page map), cancelled, or error — or fonts, asking for files the session doesn't have,
 * after which the client sends the request again with them (refill).
 *
 * A PDF's pictures are asked for in the middle of the job: { id, type:
 * "images", want } names those on the pages about to be written and the
 * largest each is printed, and the job waits for the answer. (Only the
 * client can draw them, and only now is it known how large they print.)
 *
 * The first thing out, before any job, is { type: "ready" }: this script and
 * everything it imports loaded. A worker has no `window` and no `document`,
 * so one import that reaches for either stops the whole script before it
 * can say anything — the client waits for "ready" and, not hearing it, does
 * the work on the main thread instead (see client.ts; harness/worker.test.ts
 * runs this file where there is no window).
 */

import type { FaceBytes } from "./faces";
import type { PdfPicture, PictureWant } from "./pictures";
import { TypesetSession, type AnyRequest } from "./run";

interface Request {
  id: number;
  type: "layout" | "pdf" | "pages";
  req: AnyRequest;
  /** Font files the session doesn't have yet. */
  fonts?: FaceBytes[];
  /** Layouts on one channel supersede each other. */
  channel?: string;
  /** Sent again with the files this session asked for: run with what came. */
  refill?: boolean;
}

/** The pictures a job asked for. */
interface Pictures {
  id: number;
  type: "images";
  pictures: Map<string, PdfPicture>;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request | Pictures>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const session = new TypesetSession();
const latest = new Map<string, number>();
let queue: Promise<void> = Promise.resolve();
/** Jobs waiting for their pictures. */
const awaited = new Map<number, (pictures: Map<string, PdfPicture>) => void>();

scope.onmessage = (e) => {
  const msg = e.data;
  // An answer, not a job: it goes to the job that is waiting for it (which
  // holds the line until it comes).
  if (msg.type === "images") {
    awaited.get(msg.id)?.(msg.pictures instanceof Map ? msg.pictures : new Map());
    awaited.delete(msg.id);
    return;
  }
  if (msg.fonts?.length) session.addFonts(msg.fonts);
  // Ids only grow; a request sent again keeps its place in line.
  if (msg.channel) latest.set(msg.channel, Math.max(latest.get(msg.channel) ?? 0, msg.id));
  queue = queue.then(() => run(msg));
};

scope.postMessage({ type: "ready" });

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
    } else if (msg.type === "pages") {
      scope.postMessage({ id, type: "pages", map: await session.pageMap(msg.req) });
    } else {
      const pictures = (want: PictureWant[]) =>
        new Promise<Map<string, PdfPicture>>((resolve) => {
          awaited.set(id, resolve);
          scope.postMessage({ id, type: "images", want });
        });
      const result = await session.pdf(msg.req, progress, pictures);
      scope.postMessage({ id, type: "done", result }, [result.bytes.buffer]);
    }
  } catch (err) {
    scope.postMessage({ id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
