import type { JSONContent } from "@tiptap/react";
import { ChevronDown, ChevronRight, Copy, FilePlus2, ThumbsUp, Trophy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { PromptVotes } from "../../bindings/proto/PromptVotes";
import type { SessionPrompt } from "../../bindings/proto/SessionPrompt";
import type { Submission } from "../../bindings/proto/Submission";
import { RichDoc } from "../../editor/RichEditor";
import { useDarkPaper } from "../../editor/ui/darkPaper";
import { isCmdError } from "../../lib/backend";
import { countWordsInDocJson } from "../../lib/wordCount";
import { confirmDialog } from "../../platform/confirm";
import { toast, toastError } from "../../platform/toast";
import { useSession } from "../../stores/session";
import { draftScope } from "./Desk";
import { dropDraft, onDrafts, pieceText, readDraft, sameWords, type Draft } from "./draft";
import { sessionApi } from "./api";
import { keepAsDocument, pieceTitle } from "./keep";
import { patchVotes, useSessions } from "./store";

/**
 * What was written to a prompt, once it has ended and everyone's writing
 * is shown: the reader's own piece first, then the others', each on its
 * own sheet with its count, and a way to take a piece away (as text, or
 * as a document of the writer's own).
 *
 * With two pieces or more, everyone in the session may vote for the one
 * they liked best (not their own). Who voted for which is never shown.
 * Whoever runs the prompt closes the voting, and then each piece shows its
 * votes, the most voted first.
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

const votesLabel = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "vote" : "votes"}`;
const nameOf = (sub: Submission): string => sub.author.display_name ?? sub.author.username;

/** "Ana", "Ana and Bo", "Ana, Bo and Cy". */
function names(list: string[]): string {
  return list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export function Pieces({
  prompt,
  index,
  sessionTitle,
  canClose = false,
}: {
  prompt: SessionPrompt;
  index: number;
  sessionTitle: string;
  /** May close the voting (the prompt's starter, the session's creator, an admin). */
  canClose?: boolean;
}) {
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

  // Voting: on the pieces with words in them, when there are two or more
  // (and the server counts votes at all).
  const counted = useMemo(() => new Map(all.map((s) => [s.id, countWordsInDocJson(s.doc)])), [all]);
  const candidates = all.filter((s) => (counted.get(s.id) ?? 0) > 0);
  const votes: PromptVotes | null = (candidates.length >= 2 && detail?.votes?.find((v) => v.prompt_id === prompt.id)) || null;
  const closed = votes?.closed_at != null;
  const tally = new Map((votes?.tally ?? []).map((t) => [t.submission_id, t.votes]));
  const most = closed ? Math.max(0, ...tally.values()) : 0;
  const leaders = most > 0 ? all.filter((s) => tally.get(s.id) === most) : [];
  const ordered = [...(mine ? [mine] : []), ...others];
  if (closed) ordered.sort((a, b) => (tally.get(b.id) ?? 0) - (tally.get(a.id) ?? 0));
  const myVote = votes?.my_vote ?? null;

  const vote = async (sub: Submission) => {
    if (!votes || closed) return;
    const taking = myVote === sub.id;
    try {
      if (taking) await sessionApi.withdrawVote(prompt.id);
      else await sessionApi.vote(prompt.id, sub.id);
      patchVotes(prompt.id, (v) => ({
        ...v,
        my_vote: taking ? null : sub.id,
        votes_cast: Math.max(0, v.votes_cast + (taking ? -1 : v.my_vote == null ? 1 : 0)),
      }));
    } catch (e) {
      toastError(isCmdError(e) && e.code === "voting_closed" ? "Voting on this prompt has closed." : "Your vote could not be counted. Try again.");
      void refreshDetail().catch(() => {});
    }
  };
  const closeVoting = () =>
    void confirmDialog("Close the voting and show how many votes each piece got? No one can vote after this.", {
      title: "Close voting",
      confirmLabel: "Close voting",
    }).then((ok) => {
      if (!ok) return;
      void sessionApi
        .closeVoting(prompt.id)
        .then(() => refreshDetail())
        .catch(() => toastError("The voting could not be closed. Try again."));
    });

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
            {!open && leaders.length > 0 && <span className="wf-session-meta">most votes: {names(leaders.map((s) => (s === mine ? "you" : nameOf(s))))}</span>}
            {!open && leaders.length === 0 && mine && <span className="wf-session-meta">yours is {wordsLabel(countWordsInDocJson(mine.doc))}</span>}
          </button>
          {open && votes && (
            <div className={`wf-vote-bar${closed ? " closed" : ""}`} role="status">
              <p>
                {closed ? (
                  <>
                    <strong>Voting is closed.</strong>{" "}
                    {leaders.length === 0
                      ? "No one voted."
                      : leaders.length === 1
                        ? `${leaders[0] === mine ? "Your piece" : nameOf(leaders[0])} got the most votes (${votesLabel(most)}).`
                        : `${names(leaders.map((s) => (s === mine ? "You" : nameOf(s))))} tied with ${votesLabel(most)} each.`}
                  </>
                ) : (
                  <>
                    <strong>Vote for the piece you liked best.</strong> {votesLabel(votes.votes_cast)} so far. Each piece’s votes show when the voting closes.
                  </>
                )}
              </p>
              {!closed && canClose && (
                <button type="button" onClick={closeVoting}>
                  Close voting
                </button>
              )}
            </div>
          )}
          {open && (
            <div className="wf-pieces-list">
              {ordered.map((sub) => (
                <Piece
                  key={sub.id}
                  name={sub === mine ? "Your piece" : nameOf(sub)}
                  doc={sub.doc as JSONContent}
                  mine={sub === mine}
                  title={sub === mine ? title : ""}
                  votes={closed ? (tally.get(sub.id) ?? 0) : null}
                  most={closed && leaders.includes(sub)}
                  vote={votes && !closed && sub !== mine && (counted.get(sub.id) ?? 0) > 0 ? { mine: myVote === sub.id, cast: () => void vote(sub) } : null}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Piece({
  name,
  doc,
  mine = false,
  title = "",
  votes = null,
  most = false,
  vote = null,
}: {
  name: string;
  doc: JSONContent | null;
  mine?: boolean;
  title?: string;
  /** Its votes, once the voting has closed. */
  votes?: number | null;
  /** It got the most votes. */
  most?: boolean;
  /** Voting for it while the voting is open (not for one's own). */
  vote?: { mine: boolean; cast: () => void } | null;
}) {
  const words = useMemo(() => countWordsInDocJson(doc), [doc]);
  const dark = useDarkPaper((s) => s.dark);
  return (
    <article className={`wf-piece${mine ? " mine" : ""}${most ? " most" : ""}`}>
      <header>
        <strong>{name}</strong>
        <span className="wf-session-meta">{wordsLabel(words)}</span>
        {votes !== null && (
          <span className={`wf-piece-votes${most ? " most" : ""}`}>
            {most && <Trophy size={12} />}
            {votesLabel(votes)}
          </span>
        )}
        <span className="wf-statusbar-spacer" />
        {vote && (
          <button
            type="button"
            className={`wf-piece-vote${vote.mine ? " active" : ""}`}
            aria-pressed={vote.mine}
            title={vote.mine ? "Take back your vote" : "Vote for this piece"}
            onClick={vote.cast}
          >
            <ThumbsUp size={13} /> {vote.mine ? "Your vote" : "Vote"}
          </button>
        )}
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
