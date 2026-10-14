import type { Editor } from "@tiptap/react";
import { AlertTriangle, ImagePlus, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type * as Y from "yjs";

import type { SaveKind } from "../../lib/backend";
import { saveExport } from "../../lib/saveFile";
import { Modal } from "../../platform";
import type { PressOptions } from "../engine/run";
import { updateBook, type Book } from "../model/bookMap";
import { modelPictureUrls, modelPictureViews } from "../model/pictures";
import { buildModel } from "../model/buildModel";
import type { BookModel, Warning } from "../model/types";

export type BookExportKind = "epub" | "paperback" | "booklet" | "submission-pdf";

export interface BuiltFile {
  bytes: Uint8Array;
  fileName: string;
  saveKind: SaveKind;
  /** Problems found while building (missing glyphs, overfull lines…). */
  warnings: Warning[];
  /** One-line description of what was made ("312 pages, 5.5 × 8.5 in"). */
  summary: string;
}

/** What a press was asked for last time, on this device. */
const PRESS_KEY = "wf-book-press";
function loadPress(): Required<PressOptions> {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESS_KEY) ?? "{}") as Record<string, unknown>;
    return { x1a: raw.x1a === true, bleed: raw.bleed === true };
  } catch {
    return { x1a: false, bleed: false };
  }
}
function savePress(press: Required<PressOptions>): void {
  try {
    localStorage.setItem(PRESS_KEY, JSON.stringify(press));
  } catch {
    // (Not remembered, then.)
  }
}

const TITLES: Record<BookExportKind, string> = {
  epub: "Export ebook (EPUB)",
  paperback: "Export print-ready PDF",
  booklet: "Export booklet PDF (print at home)",
  "submission-pdf": "Export submission manuscript (PDF)",
};

/**
 * One dialog for the book outputs: a preflight list (each item can take you
 * to the paragraph in question), the output's options, then Build → Save.
 * Saving is its own tap — on iOS the share sheet and on the web the
 * download both need one, and big books take a moment to build.
 */
export function ExportBookDialog({
  kind,
  editor,
  ydoc,
  book,
  format,
  readonly,
  onShowSource,
  onClose,
}: {
  kind: BookExportKind;
  editor: Editor;
  ydoc: Y.Doc;
  book: Book;
  format: string;
  readonly: boolean;
  /** Select a manuscript block (by top-level index) and close. */
  onShowSource: (src: number) => void;
  onClose: () => void;
}) {
  const model = useMemo<BookModel>(() => buildModel(editor.getJSON(), format, book), [editor, format, book]);
  const modelHasArt = model.sections.some((section) => section.art);
  const [cover, setCover] = useState<{ bytes: Uint8Array; type: "image/jpeg" | "image/png"; name: string } | null>(null);
  // The cover kept with the book (Book ▸ Cover) goes in unless asked not to.
  // (A front cover: its picture, or one made in the cover editor.)
  const savedCover = !!book.cover.front || !!book.cover.wrap || book.cover.texts.some((t) => t.panel === "front" && t.text.trim() !== "");
  const [useSaved, setUseSaved] = useState(true);
  const [press, setPress] = useState(loadPress);
  const [phase, setPhase] = useState<"preflight" | "building" | "ready" | "error">("preflight");
  const [progress, setProgress] = useState("");
  const [built, setBuilt] = useState<BuiltFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const coverRef = useRef<HTMLInputElement>(null);

  const warnings = [...model.warnings, ...(built?.warnings ?? [])];

  const build = async () => {
    setPhase("building");
    setError(null);
    try {
      let result: BuiltFile;
      if (kind === "epub") {
        setProgress("Gathering images…");
        const { collectImages, bookFileName } = await import("../exportBook");
        // The pictures in the text, and the book's own.
        const urls = modelPictureUrls(model);
        const { images, failed } = await collectImages(urls);
        // A picture shown cropped or turned goes in as a file of that part
        // alone: never the whole of it.
        const views = modelPictureViews(model);
        if (views.length) {
          const { viewedFile } = await import("../engine/pictureCanvas");
          for (const v of views) {
            const whole = images.get(v.url);
            const made = whole ? await viewedFile(whole.bytes, v.view).catch(() => null) : null;
            if (made) images.set(v.key, made);
          }
        }
        let uuid = book.ebook.uuid;
        if (!uuid) {
          uuid = crypto.randomUUID();
          if (!readonly) updateBook(ydoc, { "ebook.uuid": uuid });
        }
        // The book's own fonts, when it asks for them inside the file.
        let fonts: Awaited<ReturnType<typeof import("../fonts/embed").epubFonts>> | null = null;
        if (book.ebook.embedFonts) {
          setProgress("Gathering the fonts…");
          const { epubFonts } = await import("../fonts/embed");
          fonts = await epubFonts(model);
        }
        const extra: Warning[] = failed
          ? [{ kind: "image", message: `${failed} image${failed === 1 ? "" : "s"} couldn’t be loaded and ${failed === 1 ? "was" : "were"} left out.` }]
          : [];
        let inside: { bytes: Uint8Array; type: "image/jpeg" | "image/png" } | null = cover;
        if (savedCover && useSaved) {
          setProgress("Fetching the cover…");
          const [{ ebookCover }, { coverGeometry }] = await Promise.all([import("../cover/files"), import("../cover/geometry")]);
          // (The front is the same whatever the spine's width: any count will do.)
          inside = await ebookCover(book, coverGeometry(book.print, 100));
          if (!inside) extra.push({ kind: "image", message: "The book’s cover couldn’t be read and was left out." });
        }
        setProgress("Writing the ebook…");
        const { buildEpub } = await import("../epub/epub");
        const bytes = await buildEpub(model, { uuid, cover: inside, images, ...(fonts?.fonts.length ? { fonts: fonts.fonts } : {}) });
        if (fonts?.missing.length) {
          extra.push({ kind: "font", message: `${fonts.missing.join(" and ")} couldn’t be fetched and ${fonts.missing.length === 1 ? "isn’t" : "aren’t"} in the file, so readers will see their device’s own type there.` });
        }
        result = {
          bytes,
          fileName: `${bookFileName(book)}.epub`,
          saveKind: "epub",
          warnings: extra,
          summary: `${model.sections.length} sections · ${model.words.toLocaleString()} words${inside ? " · with cover" : ""}${fonts?.fonts.length ? " · fonts embedded" : ""}`,
        };
      } else {
        const { buildPrintFile } = await import("../exportBook");
        if (kind === "paperback") savePress(press);
        result = await buildPrintFile(kind, model, (p) => setProgress(p), kind === "paperback" ? press : undefined);
      }
      setBuilt(result);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  const save = async () => {
    if (!built) return;
    const result = await saveExport(built.fileName, built.saveKind, built.bytes).catch((e) => {
      setError(String(e));
      return null;
    });
    if (result?.status === "saved") onClose();
  };

  return (
    <Modal onClose={onClose} className="wf-export-book-modal">
      <h3>{TITLES[kind]}</h3>

      {warnings.length > 0 ? (
        <div className="wf-preflight">
          <p className="wf-preflight-head">
            <AlertTriangle size={14} /> {warnings.length} thing{warnings.length === 1 ? "" : "s"} to check
          </p>
          <ul>
            {warnings.slice(0, 50).map((w, i) => (
              <li key={i}>
                <span>{w.message}</span>
                {w.src !== undefined && (
                  <button className="wf-link-button" onClick={() => onShowSource(w.src!)}>
                    Show
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="wf-preflight-ok">Everything looks ready.</p>
      )}

      {kind === "epub" && phase !== "ready" && savedCover && (
        <div className="wf-export-cover">
          <label className="wf-export-cover-chosen">
            <input type="checkbox" checked={useSaved} onChange={(e) => setUseSaved(e.target.checked)} /> Put the book’s cover inside the file
          </label>
          <small>
            This is the front cover from Book ▸ Cover, with the words put on it there. For Kindle (KDP) you can leave it out, because
            the cover you upload on KDP is used. Apple Books and Kobo use the one inside the file.
          </small>
        </div>
      )}
      {kind === "epub" && phase !== "ready" && !savedCover && (
        <div className="wf-export-cover">
          <input
            ref={coverRef}
            type="file"
            accept="image/jpeg,image/png"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const type = file.type === "image/png" ? "image/png" : "image/jpeg";
              setCover({ bytes: new Uint8Array(await file.arrayBuffer()), type, name: file.name });
            }}
          />
          {cover ? (
            <span className="wf-export-cover-chosen">
              Cover: {cover.name}
              <button className="wf-icon" title="Remove cover" onClick={() => setCover(null)}>
                <X size={13} />
              </button>
            </span>
          ) : (
            <button onClick={() => coverRef.current?.click()}>
              <ImagePlus size={14} /> Add a cover image…
            </button>
          )}
          <small>
            Optional. For Kindle (KDP), leave it out because the cover you upload on KDP is used. Apple
            Books and Kobo use the one inside the file. To keep a cover with the book, add it under Book ▸ Cover.
          </small>
        </div>
      )}

      {kind === "paperback" && phase !== "ready" && (
        <div className="wf-export-press">
          <label className="wf-print-option">
            <input type="checkbox" checked={press.x1a} disabled={phase === "building"} onChange={(e) => setPress({ ...press, x1a: e.target.checked })} />
            <span>
              PDF/X-1a for a printer
              <small>The form IngramSpark and many printers ask for. It is for black ink only, so pictures are made grey.</small>
            </span>
          </label>
          <label className="wf-print-option">
            <input type="checkbox" checked={press.bleed} disabled={phase === "building"} onChange={(e) => setPress({ ...press, bleed: e.target.checked })} />
            <span>
              With bleed
              <small>Each page is made 0.125 in larger at the top, the bottom and the outside edge. Choose it when the printer asks for a file with bleed.</small>
              {!press.bleed && modelHasArt && <small className="wf-export-art-note">This book has chapter art. Without bleed the printer may trim it short of the paper’s edge.</small>}
            </span>
          </label>
        </div>
      )}

      {phase === "building" && <p className="wf-export-progress">{progress || "Building…"}</p>}
      {phase === "ready" && built && <p className="wf-export-ready">Ready: {built.summary}</p>}
      {error && <p className="wf-connect-error">{error}</p>}

      <div className="wf-connect-row wf-export-actions">
        <button onClick={onClose}>{phase === "ready" ? "Close" : "Cancel"}</button>
        {phase === "ready" ? (
          <button className="wf-primary" onClick={() => void save()}>
            Save…
          </button>
        ) : (
          <button className="wf-primary" disabled={phase === "building"} onClick={() => void build()}>
            {phase === "building" ? "Building…" : kind === "epub" ? "Create EPUB" : "Create PDF"}
          </button>
        )}
      </div>
    </Modal>
  );
}
