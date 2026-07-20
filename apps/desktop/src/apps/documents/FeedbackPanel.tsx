import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import { Check, MessageSquarePlus, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import * as Y from "yjs";

import type { DocumentThread } from "../../bindings/proto/DocumentThread";
import { isCmdError } from "../../lib/backend";
import { Avatar } from "../../platform/Avatar";
import { useSession } from "../../stores/session";
import { documentsApi } from "./api";
import { b64decode, b64encode, type DocProvider } from "./collab";
import { useDocuments } from "./store";

const feedbackKey = new PluginKey("wf-feedback");

/** Carries feedback-range highlights; ranges map through edits, and the
 *  panel pushes full recomputes via setMeta. */
export const FeedbackHighlights = Extension.create({
  name: "feedbackHighlights",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: feedbackKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const pushed = tr.getMeta(feedbackKey) as DecorationSet | undefined;
            if (pushed) return pushed;
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return feedbackKey.getState(state) as DecorationSet;
          },
        },
      }),
    ];
  },
});

/** Anchor the current selection as Yjs relative positions + excerpt. */
interface SelectionAnchors {
  anchor_b64: string;
  head_b64: string;
  excerpt: string;
}

interface SelectionFeedbackDraft {
  content: string;
  anchors: SelectionAnchors;
}

export function anchorsFromSelection(editor: Editor): SelectionAnchors | null {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const ystate = ySyncPluginKey.getState(editor.state);
  if (!ystate?.binding) return null;
  const relFrom = absolutePositionToRelativePosition(from, ystate.type, ystate.binding.mapping);
  const relTo = absolutePositionToRelativePosition(to, ystate.type, ystate.binding.mapping);
  if (!relFrom || !relTo) return null;
  return {
    anchor_b64: b64encode(Y.encodeRelativePosition(relFrom)),
    head_b64: b64encode(Y.encodeRelativePosition(relTo)),
    excerpt: editor.state.doc.textBetween(from, to, " ").slice(0, 300),
  };
}

/** Where a thread's anchored range sits in today's document, if resolvable. */
export function resolveThreadRange(
  editor: Editor,
  thread: DocumentThread,
): { from: number; to: number } | null {
  if (!thread.anchor_b64 || !thread.head_b64) return null;
  const ystate = ySyncPluginKey.getState(editor.state);
  if (!ystate?.binding) return null;
  try {
    const relA = Y.decodeRelativePosition(b64decode(thread.anchor_b64));
    const relH = Y.decodeRelativePosition(b64decode(thread.head_b64));
    const a = relativePositionToAbsolutePosition(
      ystate.doc,
      ystate.type,
      relA,
      ystate.binding.mapping,
    );
    const h = relativePositionToAbsolutePosition(
      ystate.doc,
      ystate.type,
      relH,
      ystate.binding.mapping,
    );
    if (a === null || h === null || a === h) return null;
    return a <= h ? { from: a, to: h } : { from: h, to: a };
  } catch {
    return null;
  }
}

/** Keep highlight decorations in sync with the open threads. */
export function useFeedbackDecorations(
  editor: Editor | null,
  provider: DocProvider,
  threads: DocumentThread[],
  enabled: boolean,
) {
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const apply = () => {
      if (editor.isDestroyed) return;
      let set = DecorationSet.empty;
      if (enabled) {
        const decos: Decoration[] = [];
        for (const t of threads) {
          if (t.resolved) continue;
          const range = resolveThreadRange(editor, t);
          if (range) {
            decos.push(
              Decoration.inline(range.from, range.to, {
                class: "wf-feedback-hl",
                "data-thread": String(t.id),
              }),
            );
          }
        }
        set = DecorationSet.create(editor.state.doc, decos);
      }
      editor.view.dispatch(editor.state.tr.setMeta(feedbackKey, set));
    };
    apply();
    // Remote edits can make anchors resolvable/unresolvable; recompute after
    // bursts of updates settle.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(apply, 400);
    };
    provider.doc.on("update", onUpdate);
    return () => {
      provider.doc.off("update", onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [editor, provider, threads, enabled]);
}

export function FeedbackPanel({
  editor,
  provider,
}: {
  editor: Editor | null;
  provider: DocProvider;
}) {
  void provider;
  const docId = useDocuments((s) => s.activeDocId);
  const threads = useDocuments((s) => s.threads);
  const myAccess = useDocuments((s) => s.myAccess);
  const me = useSession((s) => s.session?.user);
  const [draft, setDraft] = useState("");
  const [selectionDraft, setSelectionDraft] = useState<SelectionFeedbackDraft | null>(null);
  const [capturedSelection, setCapturedSelection] = useState<SelectionAnchors | null>(() =>
    editor ? anchorsFromSelection(editor) : null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editor) {
      setCapturedSelection(null);
      return;
    }
    const update = () => setCapturedSelection(anchorsFromSelection(editor));
    editor.on("selectionUpdate", update);
    update();
    return () => {
      editor.off("selectionUpdate", update);
    };
  }, [editor]);

  if (docId === null) return null;
  const isOwner = myAccess === "owner";
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);

  const submit = async (content: string, anchors: SelectionAnchors | null) => {
    const text = content.trim();
    if (!text) return;
    try {
      await documentsApi.createThread(docId, {
        content: text,
        anchor_b64: anchors?.anchor_b64 ?? null,
        head_b64: anchors?.head_b64 ?? null,
        excerpt: anchors?.excerpt ?? null,
      });
      if (anchors) setSelectionDraft(null);
      else setDraft("");
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    }
  };

  const jumpTo = (thread: DocumentThread) => {
    if (!editor) return;
    const range = resolveThreadRange(editor, thread);
    if (!range) return;
    editor.chain().focus().setTextSelection(range).scrollIntoView().run();
  };

  const beginSelectionFeedback = () => {
    if (capturedSelection) {
      setSelectionDraft({ content: "", anchors: capturedSelection });
    }
  };

  return (
    <aside className="wf-doc-panel">
      <header className="wf-doc-panel-header">
        <h3>Feedback</h3>
        <span className="wf-statusbar-spacer" />
        <button
          className="wf-icon"
          title={
            capturedSelection
              ? "Comment on the selected text"
              : "Select some text to attach feedback to it"
          }
          disabled={!capturedSelection}
          onMouseDown={(event) => {
            // Preserve the ProseMirror selection until the click handler has
            // converted it to stable Yjs relative positions.
            event.preventDefault();
          }}
          onClick={beginSelectionFeedback}
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
              void submit(selectionDraft.content, selectionDraft.anchors);
            }}
          >
            <input
              autoFocus
              placeholder="Feedback on the selection…"
              value={selectionDraft.content}
              maxLength={4000}
              onChange={(e) =>
                setSelectionDraft((current) =>
                  current ? { ...current, content: e.target.value } : null,
                )
              }
            />
            <button type="submit" disabled={!selectionDraft.content.trim()}>
              Send
            </button>
            <button className="wf-icon" type="button" title="Cancel" onClick={() => setSelectionDraft(null)}>
              <X size={14} />
            </button>
          </form>
        </div>
      )}

      <div className="wf-doc-threads">
        {open.map((t) => (
          <ThreadCard
            key={t.id}
            thread={t}
            canControl={isOwner || t.author.id === me?.id}
            onJump={() => jumpTo(t)}
            onError={setError}
          />
        ))}
        {open.length === 0 && (
          <p className="wf-friend-dim">No open feedback. Select text and comment on it.</p>
        )}
        {resolved.length > 0 && (
          <details className="wf-doc-resolved">
            <summary>Resolved ({resolved.length})</summary>
            {resolved.map((t) => (
              <ThreadCard
                key={t.id}
                thread={t}
                canControl={isOwner || t.author.id === me?.id}
                onJump={() => jumpTo(t)}
                onError={setError}
              />
            ))}
          </details>
        )}
      </div>

      <form
        className="wf-doc-panel-row wf-doc-general"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(draft, null);
        }}
      >
        <input
          placeholder="General feedback…"
          value={draft}
          maxLength={4000}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}

function ThreadCard({
  thread,
  canControl,
  onJump,
  onError,
}: {
  thread: DocumentThread;
  canControl: boolean;
  onJump: () => void;
  onError: (e: string) => void;
}) {
  const [reply, setReply] = useState("");

  const act = (p: Promise<unknown>) =>
    p.catch((e) => onError(isCmdError(e) ? e.message : String(e)));

  return (
    <div className={`wf-doc-thread ${thread.resolved ? "resolved" : ""}`}>
      {thread.excerpt && (
        <button className="wf-doc-thread-excerpt" title="Jump to text" onClick={onJump}>
          “{thread.excerpt}”
        </button>
      )}
      {thread.messages.map((m) => (
        <div key={m.id} className="wf-doc-thread-msg">
          <Avatar
            name={m.author.display_name ?? m.author.username}
            attachmentId={m.author.avatar_attachment_id}
            accentColor={m.author.accent_color}
            size={18}
          />
          <div>
            <span className="wf-doc-thread-author">
              {m.author.display_name ?? m.author.username}
            </span>
            <p>{m.content}</p>
          </div>
        </div>
      ))}
      <div className="wf-doc-thread-actions">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = reply.trim();
            if (!text) return;
            void act(documentsApi.replyThread(thread.id, text).then(() => setReply("")));
          }}
        >
          <input
            placeholder="Reply…"
            value={reply}
            maxLength={4000}
            onChange={(e) => setReply(e.target.value)}
          />
        </form>
        {canControl && (
          <>
            <button
              className="wf-icon"
              title={thread.resolved ? "Reopen" : "Resolve"}
              onClick={() =>
                void act(documentsApi.setThreadResolved(thread.id, !thread.resolved))
              }
            >
              {thread.resolved ? <RotateCcw size={14} /> : <Check size={14} />}
            </button>
            <button
              className="wf-icon"
              title="Delete thread"
              onClick={() => void act(documentsApi.deleteThread(thread.id))}
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
