import type { JSONContent } from "@tiptap/react";
import { ChevronDown, ChevronRight, Copy, FilePlus2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { SessionPrompt } from "../../bindings/proto/SessionPrompt";
import { RichDoc } from "../../editor/RichEditor";
import { useDarkPaper } from "../../editor/ui/darkPaper";
import { isCmdError } from "../../lib/backend";
import { countWordsInDocJson } from "../../lib/wordCount";
import { confirmDialog } from "../../platform/confirm";
import { toast, toastError } from "../../platform/toast";
import { useSession } from "../../stores/session";
import { draftScope } from "./Desk";
import { dropDraft, onDrafts, pieceText, readDraft, sameWords, type Draft } from "./draft";
import { keepAsDocument, pieceTitle } from "./keep";
import { useSessions } from "./store";

/**
 * What was written to a prompt, once it has ended and everyone's writing
 * is shown: the reader's own piece first, then the others', each on its
 * own sheet with its count, and a way to take a piece away (as text, or
 * as a document of the writer's own).
 */

/** A prompt that ended this recently opens with its writing showing: that
 *  is the moment everyone is waiting for. Older ones stay folded, so a
 *  long session is not an endless page. */
const FRESH_MS = 15 * 60 * 1000;

const wordsLabel = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "word" : "words"}`;

function copyText(text: string, done: string): void {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast(done, "success"))
    .catch(() => toastError("That could not be copied."));
}

function keep(title: string, doc: unknown): void {
  void keepAsDocument(title, doc).catch((e) => toastError(isCmdError(e) ? e.message : "That could not be saved as a document."));
}

/** The copy of this prompt's writing kept on this device, as it changes. */
function useDraft(scope: string, promptId: number): Draft | null {
  const [draft, setDraft] = useState(() => readDraft(scope, promptId));
  useEffect(() => {
    const read = () => setDraft(readDraft(scope, promptId));
    read();
    return onDrafts(read);
  }, [scope, promptId]);
  return draft;
}

export function Pieces({ prompt, index, sessionTitle }: { prompt: SessionPrompt; index: number; sessionTitle: string }) {
  const me = useSession((s) => s.session?.user);
  const addr = useSession((s) => s.session?.addr);
  const scope = draftScope(addr, me?.id);
  const detail = useSessions((s) => s.detail);
  const refreshDetail = useSessions((s) => s.refreshDetail);
  const all = useMemo(() => (detail?.submissions ?? []).filter((s) => s.prompt_id === prompt.id), [detail, prompt.id]);
  const mine = all.find((s) => s.author.id === me?.id);
  const others = all.filter((s) => s.author.id !== me?.id);
  const [open, setOpen] = useState(() => prompt.ended_at != null && Date.now() - prompt.ended_at < FRESH_MS);
  const title = pieceTitle(sessionTitle, index + 1);

  // Words typed on this device that the server never took: the save was
  // still on its way when time ran out.
  const draft = useDraft(scope, prompt.id);
  const settled = !!draft && (draft.sent || sameWords(draft.doc, mine?.doc ?? null));
  const unsent = draft && !settled ? draft : null;
  const asked = useRef(false);
  useEffect(() => {
    if (!draft || !settled) return;
    // A save that landed after the page was last read: read it again.
    if (draft.sent && !sameWords(draft.doc, mine?.doc ?? null) && !asked.current) {
      asked.current = true;
      void refreshDetail().catch(() => {});
      return;
    }
    // The server has these words: the copy here has done its work.
    dropDraft(scope, prompt.id);
  }, [draft, settled, mine, scope, prompt.id, refreshDetail]);

  return (
    <div className="wf-pieces">
      {unsent && (
        <div className="wf-pieces-unsent" role="status">
          <p>
            <strong>Your last words did not reach the server before time was up.</strong> They are kept on this device ({wordsLabel(countWordsInDocJson(unsent.doc))} in all). The others in the session cannot see them.
          </p>
          <div className="wf-pieces-acts">
            <button type="button" onClick={() => copyText(pieceText(unsent.doc), "Your words are copied.")}>
              <Copy size={13} /> Copy them
            </button>
            <button type="button" onClick={() => keep(title, unsent.doc)}>
              <FilePlus2 size={13} /> Save as a document
            </button>
            <button
              type="button"
              className="wf-danger"
              onClick={() =>
                void confirmDialog("Discard the words kept on this device? This is the only copy of what the server did not get.", {
                  title: "Discard these words",
                  confirmLabel: "Discard",
                  danger: true,
                }).then((ok) => {
                  if (ok) dropDraft(scope, prompt.id);
                })
              }
            >
              Discard
            </button>
          </div>
        </div>
      )}
      {all.length === 0 ? (
        <p className="wf-session-meta">No one wrote for this prompt.</p>
      ) : (
        <>
          <button type="button" className="wf-subs-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {open ? "Hide the writing" : `Show ${all.length === 1 ? "the piece" : `all ${all.length} pieces`}`}
            {!open && mine && <span className="wf-session-meta">yours is {wordsLabel(countWordsInDocJson(mine.doc))}</span>}
          </button>
          {open && (
            <div className="wf-pieces-list">
              {mine && <Piece name="Your piece" doc={mine.doc as JSONContent} mine title={title} />}
              {others.map((sub) => (
                <Piece key={sub.id} name={sub.author.display_name ?? sub.author.username} doc={sub.doc as JSONContent} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Piece({ name, doc, mine = false, title = "" }: { name: string; doc: JSONContent | null; mine?: boolean; title?: string }) {
  const words = useMemo(() => countWordsInDocJson(doc), [doc]);
  const dark = useDarkPaper((s) => s.dark);
  return (
    <article className={`wf-piece${mine ? " mine" : ""}`}>
      <header>
        <strong>{name}</strong>
        <span className="wf-session-meta">{wordsLabel(words)}</span>
        <span className="wf-statusbar-spacer" />
        <button type="button" className="wf-piece-act" title="Copy this piece as text" onClick={() => copyText(pieceText(doc), mine ? "Your piece is copied." : "The piece is copied.")}>
          <Copy size={13} /> Copy
        </button>
        {mine && (
          <button type="button" className="wf-piece-act" title="Keep this piece as a document of your own" onClick={() => keep(title, doc)}>
            <FilePlus2 size={13} /> Save as a document
          </button>
        )}
      </header>
      <div className={`wf-paper wf-rich-wrap${dark ? " dark" : ""}`}>
        <RichDoc doc={doc} />
      </div>
    </article>
  );
}
