import { useEffect, useRef, useState } from "react";

import type { PdfOptions, PictureQuality } from "../../book/render/options";
import { saveExport } from "../../lib/saveFile";
import { Modal } from "../../platform/Modal";
import { DocDetails } from "./DocSettingsPanel";
import type { DocSettings } from "./docSettings";
import { loadPdfOptions, savePdfOptions } from "./pdfOptions";

export interface BuiltPdf {
  bytes: Uint8Array;
  pages: number;
  /** Things worth knowing: stand-in fonts, pictures that could not be read. */
  notes: string[];
}

/** How pictures go in: the choice, and what it means for the file. */
const PICTURES: { id: PictureQuality; label: string; hint: string }[] = [
  { id: "screen", label: "Screen", hint: "Small enough to send. Pictures are kept to 150 pixels an inch." },
  { id: "print", label: "Print", hint: "Sharp on paper. Pictures are kept to 300 pixels an inch." },
  { id: "original", label: "Original", hint: "Every picture as it is in the document. The file can be large." },
];

/**
 * Export PDF: what goes into the file is chosen here, the file is made,
 * then saved. Saving is its own tap, as it is for a book: on a phone the
 * share sheet opens only from one, and a long document takes a moment.
 *
 * The choices are remembered on this device. The details (what it is
 * about, the words to find it by, its language) are the document's own and
 * are kept with it.
 */
export function ExportPdfDialog({
  title,
  details,
  build,
  onClose,
}: {
  title: string;
  /** The document's details, where it has them (a Document) and whether
   *  they can be changed here. */
  details: { settings: DocSettings; readonly: boolean; onPatch: (patch: Partial<DocSettings>) => void } | null;
  /** Typeset the document and write the file. */
  build: (options: PdfOptions, onProgress: (message: string) => void) => Promise<BuiltPdf>;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<PdfOptions>(loadPdfOptions);
  const [phase, setPhase] = useState<"choose" | "building" | "ready">("choose");
  const [progress, setProgress] = useState("");
  const [built, setBuilt] = useState<BuiltPdf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const buildRef = useRef(build);
  useEffect(() => {
    buildRef.current = build;
  }, [build]);
  /** Which making is the current one (a change of mind starts another). */
  const run = useRef(0);

  // What was made is of the choices and details as they then stood.
  const stale = () => {
    run.current += 1;
    setBuilt(null);
    setPhase("choose");
  };
  const choose = (patch: Partial<PdfOptions>) => {
    setOptions((now) => ({ ...now, ...patch }));
    if (phase === "ready") stale();
  };
  const busy = phase === "building";

  const make = async () => {
    const mine = (run.current += 1);
    setPhase("building");
    setError(null);
    setProgress("");
    savePdfOptions(options);
    try {
      const made = await buildRef.current(options, (message) => {
        if (run.current === mine) setProgress(message);
      });
      if (run.current !== mine) return;
      setBuilt(made);
      setPhase("ready");
    } catch (e) {
      if (run.current !== mine) return;
      setError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));
      setPhase("choose");
    }
  };

  const save = async () => {
    if (!built) return;
    const result = await saveExport(`${safeName(title)}.pdf`, "pdf", built.bytes).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    });
    if (result?.status === "saved") onClose();
  };

  return (
    <Modal onClose={onClose} className="wf-export-pdf-modal">
      <header className="wf-doc-panel-header">
        <h3>Export “{title}” as a PDF</h3>
      </header>

      <fieldset className="wf-export-pdf-pictures" disabled={busy}>
        <legend>Pictures</legend>
        <div>
          {PICTURES.map((choice) => (
            <label key={choice.id} className={options.pictures === choice.id ? "on" : ""}>
              <input type="radio" name="wf-export-pdf-pictures" checked={options.pictures === choice.id} onChange={() => choose({ pictures: choice.id })} />
              {choice.label}
            </label>
          ))}
        </div>
        <small>{PICTURES.find((choice) => choice.id === options.pictures)?.hint}</small>
      </fieldset>

      <label className="wf-print-option">
        <input type="checkbox" checked={options.tagged} disabled={busy} onChange={(e) => choose({ tagged: e.target.checked })} />
        <span>
          Tags for screen readers
          <small>Headings, lists, tables and picture descriptions are written into the file, so it can be read aloud and its text can reflow.</small>
        </span>
      </label>

      <label className="wf-print-option">
        <input type="checkbox" checked={options.archive} disabled={busy} onChange={(e) => choose({ archive: e.target.checked })} />
        <span>
          Archive copy (PDF/A)
          <small>A file made to open the same way in many years. Its fonts and what its colors mean are kept inside it.</small>
        </span>
      </label>

      <label className="wf-print-option">
        <input type="checkbox" checked={options.source} disabled={busy} onChange={(e) => choose({ source: e.target.checked })} />
        <span>
          Keep an editable copy inside
          <small>Anyone who has this PDF can open the whole document in subScribe, with its styles and pictures. Suggested changes are saved as accepted. Comments and history are left out.</small>
        </span>
      </label>

      {details && (
        <details className="wf-export-pdf-fold">
          <summary>Details</summary>
          <DocDetails
            settings={details.settings}
            disabled={details.readonly || busy}
            onPatch={(patch) => {
              details.onPatch(patch);
              if (phase === "ready") stale();
            }}
          />
          <p className="wf-inspector-dim">Kept with the document. A PDF says them where search and screen readers look.</p>
        </details>
      )}

      {phase === "building" && (
        <p className="wf-export-progress" aria-live="polite">
          {progress || "Setting the pages…"}
        </p>
      )}
      {phase === "ready" && built && (
        <p className="wf-export-ready" aria-live="polite">
          Ready: {built.pages.toLocaleString()} {built.pages === 1 ? "page" : "pages"}
        </p>
      )}
      {phase === "ready" && built && built.notes.length > 0 && (
        <ul className="wf-print-notes">
          {built.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {error && <p className="wf-connect-error">{error}</p>}

      <div className="wf-connect-row wf-export-actions">
        <button onClick={onClose}>{phase === "ready" ? "Close" : "Cancel"}</button>
        {phase === "ready" ? (
          <button className="wf-primary" onClick={() => void save()} autoFocus>
            Save…
          </button>
        ) : (
          <button className="wf-primary" disabled={busy} onClick={() => void make()} autoFocus>
            {busy ? "Making the PDF…" : "Create PDF"}
          </button>
        )}
      </div>
    </Modal>
  );
}

function safeName(title: string): string {
  return (title.trim() || "document").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120);
}
