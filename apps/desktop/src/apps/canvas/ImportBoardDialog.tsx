import { useEffect, useRef, useState } from "react";

import { Modal, toast } from "../../platform";
import {
  canImportPdf,
  importBoardFile,
  isCancelled,
  type ImportDest,
  type ImportProgress,
} from "./boardFile";

/**
 * Runs one board import with live progress. Closing the modal — backdrop,
 * Escape, or the button — always means CANCEL, never plain dismissal: a
 * stray click must not quietly abandon a half-imported board.
 */
export function ImportBoardDialog({
  file,
  dest,
  onDone,
}: {
  file: File;
  dest: ImportDest;
  /** The new board's id, or null when cancelled/failed. */
  onDone: (boardId: number | null) => void;
}) {
  const [progress, setProgress] = useState<ImportProgress>({
    label: "Starting…",
    done: 0,
    total: 1,
  });
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const ctrl = useRef(new AbortController());

  useEffect(() => {
    const run = async () => {
      if (/\.pdf$/i.test(file.name)) {
        if (!canImportPdf) {
          throw { code: "desktop_only", message: "PDF import needs the desktop app." };
        }
        // Lazily loaded: this chain carries pdf.js.
        const { importPdfAsBoard } = await import("./importPdf");
        return importPdfAsBoard(file, dest, setProgress, ctrl.current.signal);
      }
      return importBoardFile(file, dest, setProgress, ctrl.current.signal);
    };
    run()
      .then((result) => {
        if (result.notice) toast(result.notice, "success");
        onDone(result.boardId);
      })
      .catch((e) => {
        if (isCancelled(e) || ctrl.current.signal.aborted) onDone(null);
        else setError((e as { message?: string } | null)?.message ?? String(e));
      });
    // Runs exactly once for this file; the dialog unmounts via onDone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = () => {
    setCancelling(true);
    ctrl.current.abort();
  };

  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Modal onClose={error ? () => onDone(null) : cancel} className="wf-import-dialog">
      <h3>Importing {file.name}</h3>
      {error ? (
        <>
          <p className="wf-connect-error">{error}</p>
          <div className="wf-import-actions">
            <button onClick={() => onDone(null)}>Close</button>
          </div>
        </>
      ) : (
        <>
          <p className="wf-import-label">
            {progress.label}
            {progress.total > 1 ? ` — ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : ""}
          </p>
          <div className="wf-import-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="wf-import-actions">
            <button onClick={cancel} disabled={cancelling}>
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
