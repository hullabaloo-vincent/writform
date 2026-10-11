import type { Editor } from "@tiptap/react";
import { Check, Eye, MessageSquarePlus, X } from "lucide-react";
import type { ReactNode } from "react";

import { changesAt, changesOf, type Change } from "./changes";
import { resolveAll, resolveInEditor, showChange, type ReviewMode } from "./Suggesting";
import { revColor } from "./TrackMarks";
import type { ReviewItem, ReviewState } from "./useReview";

const MODES: { mode: ReviewMode; label: string; hint: string }[] = [
  { mode: "edit", label: "Editing", hint: "Change the text directly" },
  { mode: "suggest", label: "Suggesting", hint: "Your edits become suggestions that can be accepted or rejected" },
  { mode: "view", label: "Viewing", hint: "Read it as it would be with every suggestion accepted (nothing can be changed)" },
];

/** Editing / Suggesting / Viewing. Someone who can only read chooses
 *  between seeing the suggestions and the text without them. */
export function ModeSwitch({ review }: { review: ReviewState }) {
  const modes = review.canResolve
    ? MODES.filter((m) => m.mode !== "suggest" || review.canSuggest)
    : [
        { mode: "edit" as const, label: "With suggestions", hint: "Show what has been suggested" },
        { mode: "view" as const, label: "Without", hint: "Read it as it would be with every suggestion accepted" },
      ];
  return (
    <div className="wf-review-modes" role="group" aria-label="Mode">
      {modes.map((m) => (
        <button
          key={m.mode}
          type="button"
          title={m.hint}
          aria-pressed={review.mode === m.mode}
          className={review.mode === m.mode ? "active" : ""}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => review.setMode(m.mode)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** The changes an entry of the list stands for, as they are in the text
 *  right now (the list is a moment behind the typing). */
function current(editor: Editor, item: ReviewItem): Change[] {
  const all = changesOf(editor.state.doc);
  const ids = new Set(item.changes.map((c) => c.id));
  const same = all.filter((c) => ids.has(c.id));
  if (same.length === item.changes.length) return same;
  return changesAt(all, item.from, item.to).filter((c) => c.author === item.author);
}

function when(time: number): string {
  if (!time) return "";
  const date = new Date(time * 1000);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return clock;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) })}, ${clock}`;
}

/**
 * The list of suggested changes, in the order they come in the text: who,
 * when, what — click one to see it, accept or reject it, or start a
 * comment on it.
 */
export function ChangesList({
  editor,
  review,
  onComment,
  empty,
}: {
  editor: Editor | null;
  review: ReviewState;
  /** Start a comment on a change's text (absent: no comment button). */
  onComment?: (item: ReviewItem) => void;
  empty?: ReactNode;
}) {
  if (!editor) return null;
  const { items } = review;
  // Deciding is editing: not while only viewing.
  const decide = review.canResolve && review.mode !== "view";
  return (
    <div className="wf-changes">
      <div className="wf-changes-top">
        <ModeSwitch review={review} />
        {review.mode === "view" && (
          <p className="wf-changes-note">
            <Eye size={13} /> The text is shown as it would read with every suggestion accepted.
          </p>
        )}
        {review.mode === "suggest" && <p className="wf-changes-note">What you type, delete or paste is suggested rather than changed.</p>}
        {decide && items.length > 1 && (
          <div className="wf-changes-all">
            <button type="button" onClick={() => resolveAll(editor, "accept")}>
              Accept all
            </button>
            <button type="button" onClick={() => resolveAll(editor, "reject")}>
              Reject all
            </button>
          </div>
        )}
      </div>
      <div className="wf-doc-threads">
        {items.map((item) => (
          <div key={item.id} className="wf-change" data-c={revColor(item.author)} data-kind={item.kind}>
            <button type="button" className="wf-change-body" title="Show in the text" onClick={() => showChange(editor, item)}>
              <span className="wf-change-who">
                <i aria-hidden />
                <b>{item.author || "Someone"}</b>
                <small>{when(item.time)}</small>
              </span>
              <span className="wf-change-what">
                {item.verb} {item.thing ? item.text : <q>{item.text}</q>}
                {item.becomes !== undefined && (
                  <>
                    {" "}
                    with <q>{item.becomes}</q>
                  </>
                )}
              </span>
            </button>
            {(decide || onComment) && (
              <div className="wf-change-actions">
                {decide && (
                  <>
                    <button type="button" className="wf-icon" title="Accept" onClick={() => resolveInEditor(editor, current(editor, item), "accept")}>
                      <Check size={15} />
                    </button>
                    <button type="button" className="wf-icon" title="Reject" onClick={() => resolveInEditor(editor, current(editor, item), "reject")}>
                      <X size={15} />
                    </button>
                  </>
                )}
                {onComment && (
                  <button type="button" className="wf-icon" title="Comment on this change" onMouseDown={(e) => e.preventDefault()} onClick={() => onComment(item)}>
                    <MessageSquarePlus size={15} />
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {items.length === 0 &&
          (empty ?? (
            <p className="wf-friend-dim">
              No suggested changes.
              {review.canSuggest && review.mode !== "suggest" && " Switch to Suggesting to propose edits without changing the text."}
            </p>
          ))}
      </div>
    </div>
  );
}

/** Shown in place of the toolbar while Viewing: what this is, and the way
 *  back. */
export function ViewingBar({ review, trailing }: { review: ReviewState; trailing?: ReactNode }) {
  return (
    <div className="wf-viewing-bar">
      <Eye size={15} />
      <span className="wf-viewing-text">Viewing: the text as it reads with every suggestion accepted.</span>
      <span className="wf-statusbar-spacer" />
      <ModeSwitch review={review} />
      {trailing}
    </div>
  );
}
