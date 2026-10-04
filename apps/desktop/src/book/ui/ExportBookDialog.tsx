import type { Editor } from "@tiptap/react";
import { AlertTriangle, ImagePlus, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type * as Y from "yjs";

import type { SaveKind } from "../../lib/backend";
import { saveExport } from "../../lib/saveFile";
import { Modal } from "../../platform";
import { updateBook, type Book } from "../model/bookMap";
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
  const [cover, setCover] = useState<{ bytes: Uint8Array; type: "image/jpeg" | "image/png"; name: string } | null>(null);
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
        const urls = model.sections.flatMap((s) =>
          s.blocks.flatMap((b) => (b.kind === "image" ? [b.url] : [])),
        );
        const { images, failed } = await collectImages(urls);
        let uuid = book.ebook.uuid;
        if (!uuid) {
          uuid = crypto.randomUUID();
          if (!readonly) updateBook(ydoc, { "ebook.uuid": uuid });
        }
        setProgress("Writing the ebook…");
        const { buildEpub } = await import("../epub/epub");
        const bytes = await buildEpub(model, { uuid, cover, images });
        const extra: Warning[] = failed
          ? [{ kind: "image", message: `${failed} image${failed === 1 ? "" : "s"} couldn’t be loaded and ${failed === 1 ? "was" : "were"} left out.` }]
          : [];
        result = {
          bytes,
          fileName: `${bookFileName(book)}.epub`,
          saveKind: "epub",
          warnings: extra,
          summary: `${model.sections.length} sections · ${model.words.toLocaleString()} words${cover ? " · with cover" : ""}`,
        };
      } else {
        const { buildPrintFile } = await import("../exportBook");
        result = await buildPrintFile(kind, model, (p) => setProgress(p));
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

      {kind === "epub" && phase !== "ready" && (
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
            Optional. For Kindle (KDP), leave it out — the cover you upload on KDP is used. Apple
            Books and Kobo use the one inside the file.
          </small>
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
