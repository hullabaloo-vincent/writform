// The typesetter's worker, run the way the app runs it: in a thread that has
// no `window` and no `document`. Everything that typesets — the book and
// document previews, the printed page view, every PDF — goes through this
// one script, so a single import that needs the page (the app's backend, an
// editor node view) stops all of them at once. The other harnesses call the
// layout directly and can't see that; this one loads the real worker.
//
// It also plays the app's side against workers that misbehave: one that
// never says a word must not leave a preview waiting for ever.

import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker as NodeWorker } from "node:worker_threads";

if (!isMainThread) {
  // ---- the worker's side: a web worker's own globals, and nothing more.
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.self = scope;
  scope.postMessage = (message: unknown, transfer?: never[]) => parentPort!.postMessage(message, transfer);
  parentPort!.on("message", (data) => (scope.onmessage as ((e: { data: unknown }) => void) | undefined)?.({ data }));
  try {
    await import("../src/book/engine/worker");
  } catch (e) {
    parentPort!.postMessage({ type: "load-failed", message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
} else {
  const env = await import("./env");
  const finish = env.finish;
  /** (The detail is what went wrong; a pass has none.) */
  const check = (name: string, ok: boolean, detail = "") => env.check(name, ok, ok ? "" : detail);
  await import("./dom");
  const Y = await import("yjs");
  const { DEFAULT_SETTINGS } = await import("../src/apps/documents/docSettings");
  const { familiesFor, setPictureSource, setWorkerPatience, Typesetter } = await import("../src/book/engine/client");
  const { png } = await import("./pix");
  const { loadFontFiles } = await import("../src/book/fonts/files");
  const { choosePreset, readBook, updateBook } = await import("../src/book/model/bookMap");
  const { buildModel } = await import("../src/book/model/buildModel");
  const { buildDocModel } = await import("../src/doclayout/model");
  const { manuscript } = await import("./manuscript");
  type Msg = Record<string, any>;

  const self = fileURLToPath(import.meta.url);
  const t = (text: string) => ({ type: "text", text });
  const para = (...content: unknown[]) => ({ type: "paragraph", content });
  const cell = (text: string) => ({ type: "tableCell", content: [para(t(text))] });
  // One of everything whose attributes the layout reads through the editor's
  // own helpers: a picture with a caption, a table, a note, a contents list.
  const content = [
    { type: "heading", attrs: { level: 1 }, content: [t("The Harbour")] },
    { type: "toc", attrs: { depth: 2 } },
    para(t("It was a bright cold day"), { type: "footnote", attrs: { kind: "end" }, content: [t("Or so they said.")] }, t(" and the clocks were striking.")),
    { type: "image", attrs: { src: "pier.png", align: "center", caption: "The pier at dawn" } },
    { type: "table", attrs: { cols: "120 200", lines: "rows", head: true }, content: [{ type: "tableRow", content: [cell("Ship"), cell("Berth")] }, { type: "tableRow", content: [cell("Maria"), cell("Four")] }] },
  ];
  const model = buildDocModel({ type: "doc", content } as never, { title: "Worker", settings: DEFAULT_SETTINGS });
  const images = [{ url: "pier.png", w: 400, h: 200 }];
  const docReq = { kind: "document", doc: model, families: model.families, images };
  const plain = buildDocModel({ type: "doc", content: [content[0], content[2], content[4]] } as never, { title: "Plain", settings: DEFAULT_SETTINGS });
  /** The pier: a small drawing in two colours. */
  const PIER = png(40, 20, (x: number, y: number) => (y < 12 ? [120, 170, 220] : x % 9 < 6 ? [90, 60, 30] : [40, 80, 120]));
  const picturesIn = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1").split("/Subtype /Image").length - 1;
  const textOf = (dl: Msg): string =>
    (dl.pages as Msg[]).flatMap((p) => (p.items as Msg[]).filter((it) => it.t === "text").map((it) => it.text as string)).join(" ");

  // ------------------------------------------------------------ the worker itself

  const thread = new NodeWorker(self);
  const inbox: Msg[] = [];
  let wake: (() => void) | null = null;
  thread.on("message", (m: Msg) => {
    inbox.push(m);
    wake?.();
  });
  thread.on("error", (e) => {
    inbox.push({ type: "load-failed", message: String(e) });
    wake?.();
  });
  /** The next message that matches, or null when none comes in time. */
  const waitFor = async (match: (m: Msg) => boolean, ms = 30_000): Promise<Msg | null> => {
    const until = Date.now() + ms;
    for (;;) {
      const at = inbox.findIndex(match);
      if (at >= 0) return inbox.splice(at, 1)[0];
      const left = until - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };
  const answer = (id: number) => waitFor((m) => m.id === id && m.type !== "progress");

  const hello = await waitFor((m) => m.type === "ready" || m.type === "load-failed");
  check("the worker's script loads where there is no window, and says so first", hello?.type === "ready", hello?.message ?? "nothing heard");

  if (hello?.type === "ready") {
    thread.postMessage({ id: 1, type: "layout", req: docReq, fonts: await loadFontFiles(model.families), channel: "preview" });
    const laid = await answer(1);
    const words = laid?.type === "laidout" ? textOf(laid.dl) : "";
    check("it lays a document out", laid?.type === "laidout" && laid.dl.pages.length >= 1, laid?.message ?? laid?.type);
    check("…with its picture's caption, its table, its note and its contents", ["The pier at dawn", "Maria", "Or so they said", "The Harbour"].every((w) => words.includes(w)), words.slice(0, 200));

    thread.postMessage({ id: 2, type: "pages", req: docReq, channel: "pages" });
    const pages = await answer(2);
    check("it says where a document's pages begin (the printed page view)", pages?.type === "pages" && pages.map.pages === laid?.dl.pages.length && pages.map.starts.length === pages.map.pages, pages?.message ?? pages?.type);

    thread.postMessage({ id: 3, type: "pdf", req: { kind: "document", doc: plain, families: plain.families, images: [] } });
    const pdf = await answer(3);
    check("it writes a PDF", pdf?.type === "done" && Buffer.from(pdf.result.bytes.slice(0, 5)).toString("latin1") === "%PDF-", pdf?.message ?? pdf?.type);

    // A PDF's pictures: asked for once the pages are set (only then is it
    // known how large each prints), and the job waits for the answer.
    thread.postMessage({ id: 5, type: "pdf", req: docReq });
    const asks = await answer(5);
    const want = (asks?.want as Msg[] | undefined) ?? [];
    check("writing a PDF with a picture in it, it asks for the picture and says how large it prints", asks?.type === "images" && want.length === 1 && want[0].url === "pier.png" && want[0].w > 100 && Math.abs(want[0].w / want[0].h - 2) < 0.01, JSON.stringify(asks?.want ?? asks?.type));
    thread.postMessage({ id: 5, type: "images", pictures: new Map([["pier.png", PIER]]) });
    const withPicture = await answer(5);
    check("…and writes it in once it has it", withPicture?.type === "done" && picturesIn(withPicture.result.bytes) === 1, withPicture?.message ?? withPicture?.type);
    thread.postMessage({ id: 6, type: "pdf", req: docReq });
    const again = await answer(6);
    thread.postMessage({ id: 6, type: "images", pictures: new Map() });
    const without = await answer(6);
    check("told there is none to be had, it writes the rest", again?.type === "images" && without?.type === "done" && picturesIn(without.result.bytes) === 0, without?.message ?? without?.type);
    thread.postMessage({ id: 7, type: "pdf", req: { ...docReq, images: [{ ...images[0], bytes: PIER }] } });
    const handed = await answer(7);
    check("a picture handed over with the job is not asked for", handed?.type === "done" && picturesIn(handed.result.bytes) === 1, handed?.type);

    // A book — and fonts it hasn't been sent are asked for, not guessed at.
    const ydoc = new Y.Doc();
    choosePreset(ydoc, "classic");
    updateBook(ydoc, { "meta.title": "The Harbour and the Garden", "meta.author": "A. N. Author" });
    const book = buildModel(manuscript() as never, "manuscript", readBook(ydoc));
    const families = familiesFor("paperback", book);
    const bookReq = { kind: "paperback", model: book, families, images: [], now: Date.UTC(2026, 9, 11) };
    thread.postMessage({ id: 4, type: "layout", req: bookReq, channel: "book" });
    const wants = await answer(4);
    const lacking = (wants?.families as string[] | undefined) ?? [];
    check("asked to set a book in fonts it wasn't sent, it asks for them", wants?.type === "fonts" && lacking.length > 0 && lacking.every((f) => families.includes(f)), wants?.type);
    thread.postMessage({ id: 4, type: "layout", req: bookReq, fonts: await loadFontFiles(lacking), channel: "book", refill: true });
    const set = await answer(4);
    check("…and sets the book once it has them", set?.type === "laidout" && set.dl.pages.length > 20, set?.message ?? set?.type);
  }
  await thread.terminate();

  // ------------------------------------------------------------ the app's side

  const g = globalThis as unknown as Record<string, unknown>;
  const made = { live: 0, dead: 0, broken: 0, slow: 0 };
  let posted = 0;

  /** The real worker, behind the interface the app's code expects. */
  class LiveWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
    private thread = new NodeWorker(self);
    constructor() {
      made.live += 1;
      // (A script that failed to load is, to the app, an error — not a message.)
      this.thread.on("message", (data: Msg) =>
        data.type === "load-failed" ? this.onerror?.({ message: data.message, preventDefault() {} }) : this.onmessage?.({ data }),
      );
      this.thread.on("error", (e) => this.onerror?.({ message: String(e), preventDefault() {} }));
    }
    postMessage(message: unknown, transfer?: never[]) {
      posted += 1;
      this.thread.postMessage(message, transfer);
    }
    terminate() {
      void this.thread.terminate();
    }
  }
  g.Worker = LiveWorker;
  setWorkerPatience(20_000);
  const live = new Typesetter();
  {
    const dl = await live.docLayout(plain as never);
    check("the app's typesetter gets its pages from the worker", !!dl && dl.pages.length >= 1 && made.live === 1 && posted >= 1);
    const before = posted;
    const map = await live.docPages(plain as never);
    check("…and its page map, from the same worker", !!map && map.pages === dl?.pages.length && made.live === 1 && posted > before);

    // Pictures: their sizes from the files (each fetched once for that), the
    // pictures themselves only when a PDF asks.
    const fetched: string[] = [];
    const drawn: number[][] = [];
    const flat = {
      async draw(_bytes: Uint8Array, _type: string, w: number, h: number) {
        drawn.push([w, h]);
        return { pixels: () => new Uint8ClampedArray(w * h * 4).fill(200), jpeg: async () => new Uint8Array(9), free() {} };
      },
    };
    setPictureSource(async (url: string) => {
      fetched.push(url);
      return url === "pier.png" ? PIER : null;
    }, flat as never);
    const shown = await live.docLayout(model as never);
    const placed = (shown?.pages as Msg[] | undefined)?.flatMap((p) => (p.items as Msg[]).filter((it) => it.t === "image")) ?? [];
    check("a layout needs only a picture's size, read from its file", placed.length === 1 && Math.abs(placed[0].w / placed[0].h - 2) < 0.01 && fetched.join() === "pier.png" && drawn.length === 0, `${fetched.join()} ${JSON.stringify(placed)}`);
    await live.docPages(model as never);
    check("…which is remembered", fetched.length === 1);
    const out = await live.docPdf(model as never, false);
    check("a PDF gets the picture itself from the app, when the worker asks", picturesIn(out.result.bytes) === 1 && out.failed === 0 && fetched.length === 2 && drawn.length === 1, `${picturesIn(out.result.bytes)} pictures, ${out.failed} failed, ${fetched.length} fetched`);
    const twice = await live.docPdf(model as never, false);
    check("…and made again, the picture made ready before is used", picturesIn(twice.result.bytes) === 1 && fetched.length === 2 && drawn.length === 1);
    const original = await live.docPdf(model as never, false, () => {}, { pictures: "original", tagged: false, archive: false, source: false });
    check("…as it is, where that is what was asked (it is not even drawn)", picturesIn(original.result.bytes) === 1 && drawn.length === 1 && fetched.length === 3);

    const lost = buildDocModel({ type: "doc", content: [content[0], { type: "image", attrs: { src: "gone.png", width: 200, height: 100 } }, { type: "image", attrs: { src: "pier.png" } }] } as never, { title: "Lost", settings: DEFAULT_SETTINGS });
    const partial = await live.docPdf(lost as never, false);
    check("a picture that cannot be had is counted and left out, and the rest is written", partial.failed === 1 && picturesIn(partial.result.bytes) === 1, `${partial.failed} failed, ${picturesIn(partial.result.bytes)} pictures`);
  }

  /** A worker whose script stopped while loading, in a webview that doesn't
   *  report that: no message, no error, ever. */
  class DeadWorker {
    onmessage = null;
    onerror = null;
    constructor() {
      made.dead += 1;
    }
    postMessage() {}
    terminate() {}
  }
  g.Worker = DeadWorker;
  setWorkerPatience(250);
  {
    const stuck = new Typesetter();
    const started = Date.now();
    const dl = await Promise.race([stuck.docLayout(plain as never), new Promise<"never">((resolve) => setTimeout(() => resolve("never"), 15_000))]);
    const took = Date.now() - started;
    check("a worker that never says a word doesn't leave the preview waiting: the pages come anyway", dl !== "never" && !!dl && dl.pages.length >= 1, dl === "never" ? "still waiting after 15 s" : `${took} ms`);
    check("…after giving it its chance", took >= 240);
    const again = Date.now();
    const second = await stuck.docPages(plain as never);
    check("…and from then on without trying a worker again", !!second && second.pages >= 1 && made.dead === 1 && Date.now() - again < 5_000);
    const pdf = await stuck.docPdf(plain as never, false);
    check("…exports included", Buffer.from(pdf.result.bytes.slice(0, 5)).toString("latin1") === "%PDF-");
    const pictured = await stuck.docPdf(model as never, false);
    check("…with their pictures", picturesIn(pictured.result.bytes) === 1 && pictured.failed === 0);
  }

  /** One whose script fails and the webview says so (an error event). */
  class BrokenWorker {
    onmessage = null;
    onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
    constructor() {
      made.broken += 1;
      setTimeout(() => this.onerror?.({ message: "ReferenceError: window is not defined", preventDefault() {} }), 10);
    }
    postMessage() {}
    terminate() {}
  }
  g.Worker = BrokenWorker;
  setWorkerPatience(60_000);
  {
    const broken = new Typesetter();
    const started = Date.now();
    const dl = await broken.docLayout(plain as never);
    check("a worker that reports its failure is given up on at once", !!dl && dl.pages.length >= 1 && Date.now() - started < 10_000 && made.broken === 1);
  }

  /** A healthy worker with a long job: ready at once, the pages much later. */
  class SlowWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror = null;
    constructor() {
      made.slow += 1;
      setTimeout(() => this.onmessage?.({ data: { type: "ready" } }), 5);
    }
    postMessage(message: { id: number }) {
      setTimeout(() => this.onmessage?.({ data: { id: message.id, type: "laidout", dl: { pages: [], faces: [], warnings: [], marker: "from the slow worker" } } }), 700);
    }
    terminate() {}
  }
  g.Worker = SlowWorker;
  setWorkerPatience(150);
  {
    const patient = new Typesetter();
    const dl = (await patient.docLayout(plain as never)) as unknown as { marker?: string } | null;
    check("a worker that has started is waited for, however long the job", dl?.marker === "from the slow worker" && made.slow === 1);
  }

  finish();
}
