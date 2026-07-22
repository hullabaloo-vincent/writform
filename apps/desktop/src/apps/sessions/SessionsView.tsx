import type { JSONContent } from "@tiptap/react";
import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { SessionPrompt } from "../../bindings/proto/SessionPrompt";
import type { WritingSession } from "../../bindings/proto/WritingSession";
import { RichDoc, RichEditor } from "../../editor/RichEditor";
import { isCmdError } from "../../lib/backend";
import { notifyNow } from "../../lib/notifications";
import { countWordsInDocJson } from "../../lib/wordCount";
import { confirmDialog, toast } from "../../platform";
import { useSession } from "../../stores/session";
import { chatApi } from "../chat/api";
import { MessageText } from "../chat/MessageText";
import { useChat } from "../chat/store";
import { sessionApi } from "./api";
import { useSessions } from "./store";

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

export function SessionsView() {
  const groups = useChat((s) => s.groups);
  const loadGroups = useChat((s) => s.loadGroups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const channels = useChat((s) => s.channels);
  const activeSessionId = useSessions((s) => s.activeSessionId);

  useEffect(() => {
    if (groups.length === 0) void loadGroups();
  }, [groups.length, loadGroups]);

  if (activeSessionId !== null) return <SessionRoom />;
  if (activeGroupId === null) {
    return <div className="wf-sessions-empty">Join a group first (see the Chat app).</div>;
  }
  return <SessionList channels={channels.filter((c) => c.kind === "text").map((c) => c.id)} />;
}

function SessionList({ channels }: { channels: number[] }) {
  const [channelId, setChannelId] = useState<number | null>(channels[0] ?? null);
  const byChannel = useSessions((s) => s.byChannel);
  const loadChannel = useSessions((s) => s.loadChannel);
  const openSession = useSessions((s) => s.openSession);
  const chatChannels = useChat((s) => s.channels);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (channelId === null && channels.length > 0) setChannelId(channels[0]);
  }, [channels, channelId]);

  useEffect(() => {
    if (channelId !== null) void loadChannel(channelId);
  }, [channelId, loadChannel]);

  const sessions = (channelId !== null && byChannel[channelId]) || [];

  return (
    <div className="wf-sessions">
      <header className="wf-sessions-header">
        <h2>Writing sessions</h2>
        <select
          value={channelId ?? ""}
          onChange={(e) => setChannelId(Number(e.target.value))}
        >
          {channels.map((id) => (
            <option key={id} value={id}>
              #{chatChannels.find((c) => c.id === id)?.name ?? id}
            </option>
          ))}
        </select>
      </header>
      {error && <p className="wf-connect-error">{error}</p>}
      {sessions.length === 0 && (
        <p className="wf-app-empty-hint">
          Sessions are timed group writing sprints: someone posts a prompt, everyone
          writes against the clock, and the pieces reveal together when time is up.
        </p>
      )}
      <div className="wf-sessions-grid">
        {sessions.map((s) => (
          <SessionCard key={s.id} session={s} onOpen={() => void openSession(s.id)} />
        ))}
        {!creating ? (
          <button className="wf-session-card wf-session-new" onClick={() => setCreating(true)}>
            + New session
          </button>
        ) : (
          <form
            className="wf-session-card"
            onSubmit={(e) => {
              e.preventDefault();
              if (!title.trim() || channelId === null) return;
              setError(null);
              sessionApi
                .create({ channel_id: channelId, title: title.trim() })
                .then((s) => {
                  setTitle("");
                  setCreating(false);
                  void loadChannel(channelId);
                  void openSession(s.id);
                })
                .catch((err) => setError(isCmdError(err) ? err.message : String(err)));
            }}
          >
            <input
              placeholder="session title"
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => !title.trim() && setCreating(false)}
            />
            <button className="wf-primary" type="submit" disabled={!title.trim()}>
              Create
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function SessionCard({ session, onOpen }: { session: WritingSession; onOpen: () => void }) {
  const ended = session.state === "ended";
  const me = useSession((s) => s.session?.user);
  const groups = useChat((s) => s.groups);
  const group = groups.find((g) => g.id === (useChat.getState().activeGroupId ?? -1));
  const canDelete = me && (session.creator.id === me.id || group?.my_role === "admin");
  return (
    <div className="wf-session-card-wrap">
      <button className="wf-session-card" onClick={onOpen}>
        <span className={`wf-session-state ${session.state}`}>{ended ? "ended" : "active"}</span>
        <strong>{session.title}</strong>
        <span className="wf-session-meta">
          by {session.creator.display_name ?? session.creator.username} ·{" "}
          {new Date(session.created_at).toLocaleDateString()}
        </span>
      </button>
      {canDelete && (
        <button
          className="wf-session-delete"
          title="Delete session"
          onClick={() =>
            void confirmDialog(
              `Delete "${session.title}" and all its writing and chat? This cannot be undone.`,
              { title: "Delete session", confirmLabel: "Delete forever", danger: true },
            ).then((ok) => {
              if (ok) void sessionApi.deleteSession(session.id).catch(() => {});
            })
          }
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

function SessionRoom() {
  const detail = useSessions((s) => s.detail);
  const closeSession = useSessions((s) => s.closeSession);
  const me = useSession((s) => s.session?.user);
  const groups = useChat((s) => s.groups);
  const [error, setError] = useState<string | null>(null);

  if (!detail) {
    // Escape hatch: if loading stalls (server hiccup), don't trap the user.
    return (
      <div className="wf-sessions-empty">
        Loading… <button onClick={closeSession}>← Back to sessions</button>
      </div>
    );
  }
  const { session, prompts } = detail;
  const group = groups.find((g) => g.id === (useChat.getState().activeGroupId ?? -1));
  const canModerate = me && (session.creator.id === me.id || group?.my_role === "admin");
  const ended = session.state === "ended";

  return (
    <div className="wf-session-room">
      <div className="wf-session-main">
        <header className="wf-session-room-header">
          <button onClick={closeSession}>←</button>
          <h2>{session.title}</h2>
          {ended ? (
            <>
              <span className="wf-session-state ended">ended</span>
              {canModerate && (
                <button
                  className="wf-danger"
                  title="Delete session"
                  onClick={() =>
                    void confirmDialog(
                      `Delete "${session.title}" and all its writing and chat? This cannot be undone.`,
                      { title: "Delete session", confirmLabel: "Delete forever", danger: true },
                    ).then((ok) => {
                      if (ok) {
                        sessionApi
                          .deleteSession(session.id)
                          .then(closeSession)
                          .catch((e) => setError(isCmdError(e) ? e.message : String(e)));
                      }
                    })
                  }
                >
                  <Trash2 size={14} />
                </button>
              )}
            </>
          ) : (
            canModerate && (
              <button
                className="wf-danger"
                onClick={() =>
                  void confirmDialog(
                    "End this session for everyone? Running prompts stop and all writing is revealed.",
                    { title: "End session", confirmLabel: "End session", danger: true },
                  ).then((ok) => {
                    if (!ok) return;
                    sessionApi
                      .end(session.id)
                      .catch((e) => setError(isCmdError(e) ? e.message : String(e)));
                  })
                }
              >
                End session
              </button>
            )
          )}
        </header>
        {error && <p className="wf-connect-error">{error}</p>}
        <div className="wf-session-prompts">
          {prompts.map((p, i) => (
            <PromptCard key={p.id} prompt={p} index={i} sessionEnded={ended} />
          ))}
          {!ended && <NewPrompt sessionId={session.id} />}
        </div>
      </div>
      <aside className="wf-session-chat">
        <SessionChat channelId={session.chat_channel_id} />
      </aside>
    </div>
  );
}

function Countdown({ endsAt, onEnd }: { endsAt: number; onEnd?: () => void }) {
  const [, tick] = useState(0);
  const fired = useRef(false);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.max(0, endsAt - Date.now());
  useEffect(() => {
    if (remaining === 0 && !fired.current) {
      fired.current = true;
      onEnd?.();
    }
  }, [remaining, onEnd]);
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  return (
    <span className={`wf-countdown ${remaining < 30_000 ? "urgent" : ""}`}>
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

function PromptCard({
  prompt,
  index,
  sessionEnded,
}: {
  prompt: SessionPrompt;
  index: number;
  sessionEnded: boolean;
}) {
  const me = useSession((s) => s.session?.user);
  const detail = useSessions((s) => s.detail);
  const groups = useChat((s) => s.groups);
  const group = groups.find((g) => g.id === (useChat.getState().activeGroupId ?? -1));
  const canControl =
    me && (prompt.creator_id === me.id || group?.my_role === "admin");
  const submissions = useMemo(
    () => (detail?.submissions ?? []).filter((s) => s.prompt_id === prompt.id),
    [detail, prompt.id],
  );

  return (
    <section className={`wf-prompt wf-prompt-${prompt.state}`}>
      <header>
        <span className="wf-prompt-n">Prompt {index + 1}</span>
        {prompt.state === "draft" && !sessionEnded && (
          <>
            <span className="wf-prompt-chip">not started</span>
            {prompt.timer_seconds != null && (
              <span className="wf-prompt-chip">⏱ {Math.round(prompt.timer_seconds / 60)}m</span>
            )}
            {canControl && (
              <button className="wf-primary" onClick={() => void sessionApi.startPrompt(prompt.id)}>
                Start
              </button>
            )}
          </>
        )}
        {prompt.state === "running" && (
          <>
            <span className="wf-prompt-chip running">writing…</span>
            {prompt.ends_at != null && (
              <Countdown
                endsAt={prompt.ends_at}
                onEnd={() => {
                  toast("Time's up — the prompt has ended.", "info");
                  void notifyNow("Time's up", "The writing prompt timer just ended.");
                }}
              />
            )}
            {canControl && (
              <button onClick={() => void sessionApi.stopPrompt(prompt.id)}>Stop</button>
            )}
          </>
        )}
        {prompt.state === "ended" && <span className="wf-prompt-chip">done</span>}
      </header>
      <div className="wf-prompt-doc">
        <RichDoc doc={prompt.prompt_doc as JSONContent} />
      </div>

      {prompt.state === "running" && <WritingArea prompt={prompt} />}

      {prompt.state === "ended" && (
        <div className="wf-submissions">
          {submissions.length === 0 && (
            <p className="wf-session-meta">No one submitted for this prompt.</p>
          )}
          {submissions.map((sub) => (
            <article key={sub.id} className="wf-submission">
              <header>{sub.author.display_name ?? sub.author.username}</header>
              <RichDoc doc={sub.doc as JSONContent} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function WritingArea({ prompt }: { prompt: SessionPrompt }) {
  const detail = useSessions((s) => s.detail);
  const me = useSession((s) => s.session?.user);
  const mine = detail?.submissions.find(
    (s) => s.prompt_id === prompt.id && s.author.id === me?.id,
  );
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<JSONContent | null>(null);
  const [words, setWords] = useState(() => countWordsInDocJson(mine?.doc ?? null));

  const flush = async () => {
    if (!latest.current) return;
    setStatus("saving");
    try {
      await sessionApi.saveSubmission(prompt.id, latest.current);
      setStatus("saved");
    } catch {
      setStatus("idle");
    }
  };

  // Final flush when the prompt card unmounts or stops running.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="wf-writing">
      <div className="wf-writing-bar">
        <span>Your writing</span>
        <span className="wf-session-meta">
          {words.toLocaleString()} {words === 1 ? "word" : "words"}
          {" · "}
          {status === "saving" ? "saving…" : status === "saved" ? "saved ✓" : "autosaves"}
        </span>
      </div>
      <RichEditor
        value={(mine?.doc as JSONContent) ?? EMPTY_DOC}
        placeholder="Start writing — it autosaves while the prompt runs."
        autoFocus
        toolbar
        onChange={(doc) => {
          latest.current = doc;
          setWords(countWordsInDocJson(doc));
          setStatus("idle");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void flush(), 1500);
        }}
      />
    </div>
  );
}

/** Side chat bound to the session's chat channel, reusing the chat store. */
function SessionChat({ channelId }: { channelId: number }) {
  const messagesMap = useChat((s) => s.messages);
  const messages = messagesMap[channelId] ?? [];
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // History load; live updates arrive via the chat ws handler.
    void chatApi.messages(channelId).then((history) => {
      useChat.setState((s) => ({ messages: { ...s.messages, [channelId]: history } }));
    });
  }, [channelId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages.length]);

  return (
    <>
      <header className="wf-session-chat-header">Session chat</header>
      <div className="wf-session-chat-messages" data-msg-scroll>
        {messages.map((m) => (
          <div key={m.id} className="wf-msg">
            <div className="wf-msg-meta">
              <span className="wf-msg-author">{m.author.display_name ?? m.author.username}</span>
            </div>
            {m.content && (
              <div className="wf-msg-content">
                <MessageText text={m.content} />
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form
        className="wf-session-chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          const content = draft.trim();
          if (!content) return;
          setDraft("");
          void chatApi.sendMessage(channelId, content);
        }}
      >
        <input
          placeholder="chat while you write…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </form>
    </>
  );
}

function NewPrompt({ sessionId }: { sessionId: number }) {
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState<JSONContent>(EMPTY_DOC);
  const [minutes, setMinutes] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const refreshDetail = useSessions((s) => s.refreshDetail);

  if (!open) {
    return (
      <button className="wf-prompt wf-prompt-new" onClick={() => setOpen(true)}>
        + Add a prompt
      </button>
    );
  }

  return (
    <section className="wf-prompt">
      <header>
        <span className="wf-prompt-n">New prompt</span>
      </header>
      {error && <p className="wf-connect-error">{error}</p>}
      <div className="wf-prompt-doc editable">
        <RichEditor
          value={doc}
          onChange={setDoc}
          placeholder="Write the prompt — formatting and images welcome."
          autoFocus
          toolbar
        />
      </div>
      <div className="wf-prompt-actions">
        <label>
          Timer (minutes, empty = none)
          <input
            type="number"
            min={1}
            max={1440}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </label>
        <button onClick={() => setOpen(false)}>Cancel</button>
        <button
          className="wf-primary"
          onClick={() => {
            setError(null);
            const timerSeconds = minutes.trim() ? Number(minutes) * 60 : null;
            sessionApi
              .createPrompt(sessionId, doc, timerSeconds)
              .then(() => {
                setDoc(EMPTY_DOC);
                setMinutes("");
                setOpen(false);
                void refreshDetail();
              })
              .catch((e) => setError(isCmdError(e) ? e.message : String(e)));
          }}
        >
          Add prompt
        </button>
      </div>
    </section>
  );
}
