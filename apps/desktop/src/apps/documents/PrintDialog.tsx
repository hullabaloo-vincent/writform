import { Printer } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { printPdf } from "../../lib/printFile";
import { saveExport } from "../../lib/saveFile";
import { Modal } from "../../platform/Modal";
import { toast } from "../../platform/toast";

export interface Printable {
  bytes: Uint8Array;
  /** Pages of the document (absent when the builder doesn't count them). */
  pages?: number;
  /** Sheets of paper (booklets). */
  sheets?: number;
  /** Things worth knowing before printing: stand-in fonts, missing pictures. */
  notes: string[];
}

/**
 * Print: the document is typeset into a PDF here, and Print hands that PDF
 * to the system — so what comes out of the printer is what the preview
 * shows, on every platform. The PDF is built before the button is pressed
 * because phones only open their print and share sheets from a tap.
 */
export function PrintDialog({
  title,
  build,
  onClose,
}: {
  title: string;
  /** Typeset the document (straight, or imposed as a booklet). */
  build: (booklet: boolean) => Promise<Printable>;
  onClose: () => void;
}) {
  const [booklet, setBooklet] = useState(false);
  const [ready, setReady] = useState<Printable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const buildRef = useRef(build);
  useEffect(() => {
    buildRef.current = build;
  }, [build]);

  useEffect(() => {
    let live = true;
    setReady(null);
    setError(null);
    buildRef.current(booklet).then(
      (made) => {
        if (live) setReady(made);
      },
      (e) => {
        if (live) setError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));
      },
    );
    return () => {
      live = false;
    };
  }, [booklet]);

  const print = async () => {
    if (!ready) return;
    setBusy(true);
    const outcome = await printPdf(ready.bytes, booklet ? `${title} (booklet)` : title);
    setBusy(false);
    if (outcome === "failed") {
      setError("Printing couldn’t start here. Save the PDF and print it from there.");
      return;
    }
    if (outcome === "opened") toast("Opened as a PDF. Print it from there.", "info");
    if (outcome !== "cancelled") onClose();
  };

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const result = await saveExport(`${safeName(title)}${booklet ? " (booklet)" : ""}.pdf`, "pdf", ready.bytes);
      if (result.status === "saved") onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const summary = !ready
    ? "Setting the pages…"
    : ready.pages === undefined
      ? "Ready to print"
      : booklet && ready.sheets
        ? `${count(ready.pages, "page")} on ${count(ready.sheets, "sheet")}`
        : count(ready.pages, "page");

  return (
    <Modal onClose={onClose} className="wf-print-modal">
      <header className="wf-doc-panel-header">
        <h3>Print “{title}”</h3>
      </header>
      <p className="wf-print-summary" aria-live="polite">
        {summary}
      </p>
      <label className="wf-print-option">
        <input type="checkbox" checked={booklet} disabled={busy} onChange={(e) => setBooklet(e.target.checked)} />
        <span>
          As a booklet
          <small>Two pages to a sheet. Print two-sided, flipping on the short edge, then fold.</small>
        </span>
      </label>
      {ready && ready.notes.length > 0 && (
        <ul className="wf-print-notes">
          {ready.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {error && <p className="wf-connect-error">{error}</p>}
      <div className="wf-connect-row">
        <button onClick={onClose}>Cancel</button>
        <button disabled={!ready || busy} onClick={() => void save()}>
          Save as PDF…
        </button>
        <button className="wf-primary" disabled={!ready || busy} onClick={() => void print()} autoFocus>
          <Printer size={15} /> Print…
        </button>
      </div>
    </Modal>
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function safeName(title: string): string {
  return (title.trim() || "document").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120);
}
