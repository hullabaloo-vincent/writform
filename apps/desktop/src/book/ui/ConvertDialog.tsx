import type { Editor } from "@tiptap/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type * as Y from "yjs";

import { Modal, toast } from "../../platform";
import { updateBook } from "../model/bookMap";
import { applyToEditor, frontMatterPatch } from "../convert/apply";
import {
  detectStructure,
  planOps,
  summarize,
  type Candidate,
  type CandidateKind,
  type PlanChoices,
} from "../convert/detect";

const KIND_LABEL: Record<CandidateKind, string> = {
  chapter: "Chapter",
  part: "Part",
  section: "Unnumbered",
  subtitle: "Subtitle",
  subheading: "Subheading",
};

/**
 * "Make it a book": find the manuscript's structure (chapters however they
 * were typed, scene breaks, the hand-made title page) and turn it into book
 * elements in one step — or, for a manuscript already, tidy what's left.
 * One summary line and a Convert button; the details are one click away.
 */
export function ConvertDialog({
  editor,
  ydoc,
  mode,
  onSwitchFormat,
  onClose,
}: {
  editor: Editor;
  ydoc: Y.Doc;
  /** "convert": Plain → Manuscript; "tidy": an existing manuscript. */
  mode: "convert" | "tidy";
  /** Switch the document to the Manuscript format (convert mode). */
  onSwitchFormat?: () => Promise<void>;
  onClose: () => void;
}) {
  const detected = useMemo(() => detectStructure(editor.getJSON().content ?? []), [editor]);
  const [candidates, setCandidates] = useState<Candidate[]>(detected.candidates);
  const [choices, setChoices] = useState<PlanChoices>({
    blankPolicy: detected.blankPolicy,
    extractFront: detected.front.indexes.length > 0,
    removeContents: detected.front.contents.length > 0,
  });
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const result = useMemo(() => ({ ...detected, candidates }), [detected, candidates]);
  const summary = summarize(result, choices);
  const between = detected.empties.filter((e) => e.between).length;
  const front = detected.front;

  const convert = async () => {
    setBusy(true);
    try {
      applyToEditor(editor, planOps(result, choices));
      if (choices.extractFront) {
        const patch = frontMatterPatch(front);
        if (Object.keys(patch).length) updateBook(ydoc, patch);
      }
      if (mode === "convert") await onSwitchFormat?.();
      toast(mode === "convert" ? `Now a book manuscript: ${summary}.` : `Tidied: ${summary}.`, "success");
      onClose();
    } catch (e) {
      toast(String(e), "error");
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} className="wf-convert-modal">
      <h3>{mode === "convert" ? "Make it a book manuscript" : "Tidy up the manuscript"}</h3>
      <p className="wf-convert-lede">
        {mode === "convert"
          ? "Chapters, parts and scene breaks become book elements, so the book’s design can lay them out — and editing can’t break the formatting."
          : "Finds chapter headings, scene breaks and stray indents that aren’t marked yet."}
      </p>
      <p className="wf-convert-summary">{summary}</p>

      <button className="wf-convert-review-toggle" onClick={() => setReview((v) => !v)}>
        {review ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Review
      </button>
      {review && (
        <div className="wf-convert-review">
          {candidates.length > 0 && (
            <ul className="wf-convert-list">
              {candidates.map((c, i) => (
                <li key={c.index}>
                  <label title={c.reason}>
                    <input
                      type="checkbox"
                      checked={c.accepted}
                      onChange={(e) =>
                        setCandidates((list) =>
                          list.map((x, j) => (j === i ? { ...x, accepted: e.target.checked } : x)),
                        )
                      }
                    />
                    <span className="wf-convert-kind">{KIND_LABEL[c.kind]}</span>
                    <span className="wf-convert-text">{c.text || "(empty)"}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {detected.empties.length > 0 && (
            <fieldset className="wf-convert-field">
              <legend>Blank lines ({detected.empties.length})</legend>
              <label>
                <input
                  type="radio"
                  checked={choices.blankPolicy === "scene"}
                  onChange={() => setChoices((c) => ({ ...c, blankPolicy: "scene" }))}
                />
                Blank lines between paragraphs are scene breaks ({between})
              </label>
              <label>
                <input
                  type="radio"
                  checked={choices.blankPolicy === "delete"}
                  onChange={() => setChoices((c) => ({ ...c, blankPolicy: "delete" }))}
                />
                They’re just spacing — remove them
              </label>
            </fieldset>
          )}
          {front.indexes.length > 0 && (
            <label className="wf-convert-check">
              <input
                type="checkbox"
                checked={choices.extractFront}
                onChange={(e) => setChoices((c) => ({ ...c, extractFront: e.target.checked }))}
              />
              Move the typed title page into Book details
              <small>
                {[
                  front.title && `title “${front.title}”`,
                  front.author && `author ${front.author}`,
                  front.copyright && "copyright",
                  front.dedication && "dedication",
                  front.alsoBy?.length && "also-by list",
                ]
                  .filter(Boolean)
                  .join(", ")}{" "}
                — the book generates these pages.
              </small>
            </label>
          )}
          {front.contents.length > 0 && (
            <label className="wf-convert-check">
              <input
                type="checkbox"
                checked={choices.removeContents}
                onChange={(e) => setChoices((c) => ({ ...c, removeContents: e.target.checked }))}
              />
              Remove the typed table of contents
              <small>The book builds one with real page numbers.</small>
            </label>
          )}
        </div>
      )}

      <div className="wf-connect-row wf-convert-actions">
        <button onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {mode === "convert" && (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void (onSwitchFormat?.() ?? Promise.resolve()).finally(onClose);
            }}
          >
            Just switch format
          </button>
        )}
        <button className="wf-primary" disabled={busy} onClick={() => void convert()}>
          {busy ? "Converting…" : mode === "convert" ? "Convert" : "Tidy up"}
        </button>
      </div>
    </Modal>
  );
}
