import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Friend } from "../../bindings/proto/Friend";
import { backend, isCmdError } from "../../lib/backend";
import { friendsApi } from "../friends/FriendsView";

interface NoteMeta {
  name: string;
  modified_at: number;
}

export function NotesView() {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () => backend.vaultList().then(setNotes).catch(() => {}),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createNote = async () => {
    const base = "Untitled";
    let name = base;
    let n = 2;
    const taken = new Set(notes.map((note) => note.name.toLowerCase()));
    while (taken.has(name.toLowerCase())) name = `${base} ${n++}`;
    await backend.vaultWrite(name, `# ${name}\n\n`);
    await refresh();
    setActive(name);
  };

  const visible = notes.filter((n) => n.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="wf-notes">
      <aside className="wf-notes-side">
        <div className="wf-notes-side-top">
          <input
            placeholder="search notes…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button title="New note" onClick={() => void createNote()}>
            +
          </button>
        </div>
        {error && <p className="wf-connect-error">{error}</p>}
        <ul>
          {visible.map((n) => (
            <li key={n.name}>
              <button
                className={`wf-note-item ${n.name === active ? "active" : ""}`}
                onClick={() => setActive(n.name)}
              >
                {n.name}
              </button>
            </li>
          ))}
          {visible.length === 0 && <li className="wf-friend-dim">No notes.</li>}
        </ul>
      </aside>
      {active ? (
        <NoteEditor
          key={active}
          name={active}
          onRenamedOrDeleted={(next) => {
            setActive(next);
            void refresh();
          }}
          onError={setError}
          onOpenNote={(name) => {
            setActive(name);
            void refresh();
          }}
          onSaved={refresh}
        />
      ) : (
        <div className="wf-sessions-empty">Select or create a note.</div>
      )}
    </div>
  );
}

function NoteEditor({
  name,
  onRenamedOrDeleted,
  onOpenNote,
  onError,
  onSaved,
}: {
  name: string;
  onRenamedOrDeleted: (next: string | null) => void;
  onOpenNote: (name: string) => void;
  onError: (e: string | null) => void;
  onSaved: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [backlinks, setBacklinks] = useState<string[]>([]);
  const [links, setLinks] = useState<string[]>([]);
  const [status, setStatus] = useState<"saved" | "dirty" | "saving">("saved");
  const [sharing, setSharing] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<string>("");

  useEffect(() => {
    void backend
      .vaultRead(name)
      .then((text) => {
        setContent(text);
        latest.current = text;
        setLinks(extractLinks(text));
      })
      .catch((e) => onError(isCmdError(e) ? e.message : String(e)));
    void backend.vaultBacklinks(name).then(setBacklinks).catch(() => {});
  }, [name, onError]);

  const save = async () => {
    setStatus("saving");
    try {
      await backend.vaultWrite(name, latest.current);
      setStatus("saved");
      onSaved();
    } catch (e) {
      setStatus("dirty");
      onError(isCmdError(e) ? e.message : String(e));
    }
  };

  if (content === null) return <div className="wf-sessions-empty">Loading…</div>;

  return (
    <main className="wf-notes-main">
      <header className="wf-notes-header">
        <strong>{name}</strong>
        <span className="wf-session-meta">
          {status === "saving" ? "saving…" : status === "dirty" ? "unsaved" : "saved"}
        </span>
        <span className="wf-statusbar-spacer" />
        <button onClick={() => setSharing(true)}>Share</button>
        <button
          onClick={() => {
            if (window.confirm(`Delete "${name}"?`)) {
              void backend.vaultDelete(name).then(() => onRenamedOrDeleted(null));
            }
          }}
        >
          Delete
        </button>
      </header>
      <div className="wf-notes-editor">
        <CodeMirror
          value={content}
          height="100%"
          theme="dark"
          extensions={[markdown()]}
          onChange={(value) => {
            latest.current = value;
            setLinks(extractLinks(value));
            setStatus("dirty");
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => void save(), 1200);
          }}
        />
      </div>
      <footer className="wf-notes-links">
        {links.length > 0 && (
          <span>
            links:{" "}
            {links.map((l) => (
              <button key={l} className="wf-note-link" onClick={() => void openOrCreate(l, onOpenNote)}>
                [[{l}]]
              </button>
            ))}
          </span>
        )}
        {backlinks.length > 0 && (
          <span>
            backlinks:{" "}
            {backlinks.map((l) => (
              <button key={l} className="wf-note-link" onClick={() => onOpenNote(l)}>
                {l}
              </button>
            ))}
          </span>
        )}
      </footer>
      {sharing && (
        <ShareDialog
          onClose={() => setSharing(false)}
          onShare={async (friend) => {
            try {
              const res = await backend.apiFetch("POST", "/api/v1/notes/share", {
                friend_id: friend.user.id,
                title: name,
                content_md: latest.current,
              });
              if (res.status >= 400) {
                const body = res.body as { message?: string };
                throw new Error(body?.message ?? "share failed");
              }
              setSharing(false);
            } catch (e) {
              onError(e instanceof Error ? e.message : String(e));
            }
          }}
        />
      )}
    </main>
  );
}

async function openOrCreate(name: string, open: (name: string) => void) {
  try {
    await backend.vaultRead(name);
  } catch {
    await backend.vaultWrite(name, `# ${name}\n\n`);
  }
  open(name);
}

function extractLinks(content: string): string[] {
  const links = new Set<string>();
  for (const m of content.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g)) {
    links.add(m[1].trim());
  }
  return [...links];
}

function ShareDialog({
  onClose,
  onShare,
}: {
  onClose: () => void;
  onShare: (friend: Friend) => void;
}) {
  const [friends, setFriends] = useState<Friend[]>([]);
  useEffect(() => {
    void friendsApi.friends().then(setFriends).catch(() => {});
  }, []);

  return (
    <div className="wf-modal-backdrop" onClick={onClose}>
      <div className="wf-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Share this note with…</h3>
        <ul className="wf-friend-list">
          {friends.map((f) => (
            <li key={f.user.id}>
              <button className="wf-friend-open" onClick={() => onShare(f)}>
                {f.user.display_name ?? f.user.username}
              </button>
            </li>
          ))}
          {friends.length === 0 && <li className="wf-friend-dim">No friends to share with yet.</li>}
        </ul>
      </div>
    </div>
  );
}
