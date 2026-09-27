import type { Editor } from "@tiptap/react";
import { Check, Highlighter, MessageSquarePlus, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  createLocalThread,
  deleteLocalThread,
  onLocalFeedbackChange,
  readLocalFeedback,
  replyLocalThread,
  setLocalThreadResolved,
  type LocalThread,
} from "./feedbackLocal";
import { anchorsFromSelection, resolveThreadRange } from "./FeedbackPanel";

/** The Feedback panel for on-device documents: same selection-anchored
 *  threads as server docs (the anchors are Yjs relative positions and the
 *  local editor runs the same ySync binding), backed by the sidecar file.
 *  No avatars — there's only you. */
export function LocalFeedbackPanel({
  docId,
  editor,
  highlightsOn,
  onToggleHighlights,
}: {
  docId: string;
  editor: Editor | null;
  /** Whether highlights stay visible after the panel closes. */
  highlightsOn?: boolean;
  onToggleHighlights?: () => void;
}) {
  const [threads, setThreads] = useState<LocalThread[]>([]);
  const [draft, setDraft] = useState("");
  const [selectionDraft, setSelectionDraft] = useState<{
    content: string;
    anchors: { anchor_b64: string; head_b64: string; excerpt: string };
  } | null>(null);
  const [captured, setCaptured] = useState(() =>
    editor ? anchorsFromSelection(editor) : null,
  );
  const [error, setError] = useState<string | null>(null);

  const reload = () => void readLocalFeedback(docId).then(setThreads);
  useEffect(() => {
    reload();
    return onLocalFeedbackChange(reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is stable per docId
  }, [docId]);

  useEffect(() => {
    if (!editor) {
      setCaptured(null);
      return;
    }
    const update = () => setCaptured(anchorsFromSelection(editor));
    editor.on("selectionUpdate", update);
    update();
    return () => {
      editor.off("selectionUpdate", update);
    };
  }, [editor]);

  const act = (p: Promise<unknown>) => void p.catch((e) => setError(String(e)));

  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);

  const jumpTo = (thread: LocalThread) => {
    if (!editor) return;
    const range = resolveThreadRange(editor, thread);
    if (!range) return;
    editor.chain().focus().setTextSelection(range).scrollIntoView().run();
  };

  return (
    <aside className="wf-doc-panel">
      <header className="wf-doc-panel-header">
        <h3>Notes</h3>
        <span className="wf-statusbar-spacer" />
        {onToggleHighlights && (
          <button
            className={`wf-icon ${highlightsOn ? "active" : ""}`}
            title={
              highlightsOn
                ? "Highlights stay visible while writing — click to show them only here"
                : "Show note highlights while writing"
            }
            onClick={onToggleHighlights}
          >
            <Highlighter size={15} />
          </button>
        )}
        <button
          className="wf-icon"
          title={
            captured ? "Note on the selected text" : "Select some text to attach a note to it"
          }
          disabled={!captured}
          onMouseDown={(event) => {
            // Preserve the selection until it becomes Yjs relative positions.
            event.preventDefault();
          }}
          onClick={() => {
            if (captured) setSelectionDraft({ content: "", anchors: captured });
          }}
        >
          <MessageSquarePlus size={15} />
        </button>
      </header>
      {error && (
        <p className="wf-connect-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      {selectionDraft !== null && (
        <div className="wf-doc-selection-compose">
          <blockquote>“{selectionDraft.anchors.excerpt}”</blockquote>
          <form
            className="wf-doc-panel-row"
            onSubmit={(e) => {
              e.preventDefault();
              const text = selectionDraft.content.trim();
              if (!text) return;
              act(
                createLocalThread(docId, {
                  content: text,
                  anchor_b64: selectionDraft.anchors.anchor_b64,
                  head_b64: selectionDraft.anchors.head_b64,
                  excerpt: selectionDraft.anchors.excerpt,
                }).then(() => setSelectionDraft(null)),
              );
            }}
          >
            <input
              autoFocus
              placeholder="Note to your future self…"
              value={selectionDraft.content}
              maxLength={4000}
              onChange={(e) =>
                setSelectionDraft((cur) => (cur ? { ...cur, content: e.target.value } : null))
              }
            />
            <button type="submit" disabled={!selectionDraft.content.trim()}>
              Add
            </button>
            <button
              className="wf-icon"
              type="button"
              title="Cancel"
              onClick={() => setSelectionDraft(null)}
            >
              <X size={14} />
            </button>
          </form>
        </div>
      )}

      <div className="wf-doc-threads">
        {open.map((t) => (
          <div key={t.id} className="wf-doc-thread">
            {t.excerpt && (
              <button
                className="wf-doc-thread-excerpt"
                title="Jump to text"
                onClick={() => jumpTo(t)}
              >
                “{t.excerpt}”
              </button>
            )}
            {t.messages.map((m) => (
              <div key={m.id} className="wf-doc-thread-msg">
                <p>{m.content}</p>
              </div>
            ))}
            <ThreadActions docId={docId} thread={t} act={act} />
          </div>
        ))}
        {open.length === 0 && (
          <p className="wf-friend-dim">
            No open notes. Select text and leave a note for your future self.
          </p>
        )}
        {resolved.length > 0 && (
          <details className="wf-doc-resolved">
            <summary>Resolved ({resolved.length})</summary>
            {resolved.map((t) => (
              <div key={t.id} className="wf-doc-thread resolved">
                {t.excerpt && (
                  <button
                    className="wf-doc-thread-excerpt"
                    title="Jump to text"
                    onClick={() => jumpTo(t)}
                  >
                    “{t.excerpt}”
                  </button>
                )}
                {t.messages.map((m) => (
                  <div key={m.id} className="wf-doc-thread-msg">
                    <p>{m.content}</p>
                  </div>
                ))}
                <ThreadActions docId={docId} thread={t} act={act} />
              </div>
            ))}
          </details>
        )}
      </div>

      <form
        className="wf-doc-panel-row wf-doc-general"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text) return;
          act(
            createLocalThread(docId, {
              content: text,
              anchor_b64: null,
              head_b64: null,
              excerpt: null,
            }).then(() => setDraft("")),
          );
        }}
      >
        <input
          placeholder="General note…"
          value={draft}
          maxLength={4000}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
    </aside>
  );
}

function ThreadActions({
  docId,
  thread,
  act,
}: {
  docId: string;
  thread: LocalThread;
  act: (p: Promise<unknown>) => void;
}) {
  const [reply, setReply] = useState("");
  return (
    <div className="wf-doc-thread-actions">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const text = reply.trim();
          if (!text) return;
          act(replyLocalThread(docId, thread.id, text).then(() => setReply("")));
        }}
      >
        <input
          placeholder="Reply…"
          value={reply}
          maxLength={4000}
          onChange={(e) => setReply(e.target.value)}
        />
      </form>
      <button
        className="wf-icon"
        title={thread.resolved ? "Reopen" : "Resolve"}
        onClick={() => act(setLocalThreadResolved(docId, thread.id, !thread.resolved))}
      >
        {thread.resolved ? <RotateCcw size={14} /> : <Check size={14} />}
      </button>
      <button
        className="wf-icon"
        title="Delete note"
        onClick={() => act(deleteLocalThread(docId, thread.id))}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
