import { useState } from "react";
import { create } from "zustand";

import { Modal } from "../../../platform/Modal";
import type { Ask } from "./pdf/model";

/**
 * What a PDF import shows while it runs, and what it asks.
 *
 * Most imports are over before anything could be read, so nothing is shown
 * for them. A dialog opens only when there is something to say: a password
 * is wanted, the pages are pictures of text and there is a choice to make,
 * or the work has gone on long enough that someone is waiting (then how
 * far it is, and a way to stop it).
 *
 * The import itself is not a component (it is called from wherever a file
 * was picked), so this is a host mounted once, driven from outside.
 */

type Question =
  | { kind: "password"; again: boolean; answer: (password: string | null) => void }
  | { kind: "scan"; pages: number; canRead: boolean; answer: (choice: "read" | "pictures" | null) => void };

interface Running {
  name: string;
  /** Long enough that it is shown. */
  shown: boolean;
  label: string;
  done: number;
  total: number;
  question: Question | null;
  stopping: boolean;
  stop: () => void;
}

const useImport = create<{ running: Running | null }>(() => ({ running: null }));
const patch = (more: Partial<Running>) => {
  const { running } = useImport.getState();
  if (running) useImport.setState({ running: { ...running, ...more } });
};

/** How long an import runs before it says so. */
export const SHOW_AFTER_MS = 1500;

export interface PdfImportUi {
  signal: AbortSignal;
  ask: Ask;
  progress: (done: number, total: number, label: string) => void;
  /** The import is over, however it went. */
  end: () => void;
}

export function beginPdfImport(name: string): PdfImportUi {
  const ctrl = new AbortController();
  // (One import at a time: a second one takes the first one's place.)
  useImport.getState().running?.stop();
  const mine: Running = {
    name,
    shown: false,
    label: "Opening the PDF",
    done: 0,
    total: 1,
    question: null,
    stopping: false,
    stop: () => {
      ctrl.abort();
      const now = useImport.getState().running;
      if (!now || now.stop !== mine.stop) return;
      const asked = now.question;
      patch({ stopping: true, question: null });
      // (Whoever is waiting on an answer gets one.)
      asked?.answer(null);
    },
  };
  useImport.setState({ running: mine });
  const current = () => {
    const now = useImport.getState().running;
    return now && now.stop === mine.stop ? now : null;
  };
  const timer = setTimeout(() => {
    if (current()) patch({ shown: true });
  }, SHOW_AFTER_MS);
  const asking = <T,>(make: (answer: (value: T | null) => void) => Question): Promise<T | null> =>
    new Promise((resolve) => {
      if (!current() || ctrl.signal.aborted) {
        resolve(null);
        return;
      }
      patch({
        question: make((value) => {
          if (current()) patch({ question: null });
          resolve(value);
        }),
      });
    });
  return {
    signal: ctrl.signal,
    ask: {
      password: (again) => asking<string>((answer) => ({ kind: "password", again, answer })),
      scan: (pages, canRead) => asking<"read" | "pictures">((answer) => ({ kind: "scan", pages, canRead, answer })),
    },
    progress: (done, total, label) => {
      if (current()) patch({ done, total, label });
    },
    end: () => {
      clearTimeout(timer);
      if (current()) useImport.setState({ running: null });
    },
  };
}

export function PasswordForm({ again, onAnswer }: { again: boolean; onAnswer: (password: string | null) => void }) {
  const [value, setValue] = useState("");
  return (
    <Modal className="wf-confirm" onClose={() => onAnswer(null)}>
      <h3>This PDF has a password</h3>
      <p className="wf-confirm-message">{again ? "That password did not open it. Try again." : "Type the password to open it."}</p>
      <form
        className="wf-import-password"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) onAnswer(value);
        }}
      >
        <input type="password" autoFocus autoComplete="off" aria-label="Password" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="wf-connect-row wf-confirm-actions">
          <button type="button" onClick={() => onAnswer(null)}>
            Cancel
          </button>
          <button type="submit" className="wf-primary" disabled={!value}>
            Open
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Mounted once at the root. */
export function PdfImportHost() {
  const running = useImport((s) => s.running);
  if (!running) return null;
  const { question } = running;

  if (question?.kind === "password") return <PasswordForm key={String(question.again)} again={question.again} onAnswer={question.answer} />;

  if (question?.kind === "scan") {
    const many = question.pages !== 1;
    return (
      <Modal className="wf-confirm" onClose={() => question.answer(null)}>
        <h3>{many ? "These pages are pictures" : "This page is a picture"}</h3>
        <p className="wf-confirm-message">
          {many ? `${question.pages} pages of this PDF are scans. They hold pictures of text and no text.` : "A page of this PDF is a scan. It holds a picture of text and no text."}{" "}
          {question.canRead ? "The text can be read out of them so you can edit it. That takes a moment for each page." : "Reading the text out of a scan needs the desktop app."}
        </p>
        <div className="wf-connect-row wf-confirm-actions">
          <button onClick={() => question.answer(null)}>Cancel</button>
          <button className={question.canRead ? "" : "wf-primary"} autoFocus={!question.canRead} onClick={() => question.answer("pictures")}>
            Keep as pictures
          </button>
          {question.canRead && (
            <button className="wf-primary" autoFocus onClick={() => question.answer("read")}>
              Read the text
            </button>
          )}
        </div>
      </Modal>
    );
  }

  if (!running.shown) return null;
  const percent = running.total > 0 ? Math.round((running.done / running.total) * 100) : 0;
  return (
    <Modal onClose={running.stop} className="wf-import-dialog">
      <h3>Importing {running.name}</h3>
      <p className="wf-import-label">{running.label}</p>
      <div className="wf-import-bar">
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="wf-import-actions">
        <button onClick={running.stop} disabled={running.stopping}>
          {running.stopping ? "Stopping" : "Cancel"}
        </button>
      </div>
    </Modal>
  );
}
