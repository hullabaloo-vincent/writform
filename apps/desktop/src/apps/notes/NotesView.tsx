import { markdown } from "@codemirror/lang-markdown";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  Bold,
  Check,
  CircleQuestionMark,
  Code,
  Columns2,
  Eye,
  Heading,
  Italic,
  Link2,
  List,
  ListChecks,
  Pencil,
  Quote,
  Strikethrough,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Friend } from "../../bindings/proto/Friend";
import { backend, isCmdError } from "../../lib/backend";
import { confirmDialog } from "../../platform";
import { friendsApi } from "../friends/FriendsView";
import { renderMarkdown } from "./markdown";

interface NoteMeta {
  name: string;
  modified_at: number;
}

type ViewMode = "edit" | "split" | "read";

const VIEW_KEY = "wf-notes-view";

function loadViewMode(): ViewMode {
  const v = localStorage.getItem(VIEW_KEY);
  return v === "edit" || v === "split" || v === "read" ? v : "split";
}

export function NotesView() {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(loadViewMode);
  const [helpOpen, setHelpOpen] = useState(false);

  const refresh = useCallback(
    () => backend.vaultList().then(setNotes).catch(() => {}),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  const createNote = async () => {
    const base = "Untitled";
    let name = base;
    let n = 2;
    const taken = new Set(notes.map((note) => note.name.toLowerCase()));
    while (taken.has(name.toLowerCase())) name = `${base} ${n++}`;
    await backend.vaultWrite(name, "");
    await refresh();
    setActive(name);
  };

  const visible = notes.filter((n) => n.name.toLowerCase().includes(filter.toLowerCase()));
  const noteNames = useMemo(() => notes.map((n) => n.name), [notes]);

  return (
    <div className="wf-notes">
      <aside className="wf-notes-side">
        <div className="wf-notes-side-top">
          <input
            placeholder="search notes…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="wf-icon" title="New note" onClick={() => void createNote()}>
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
          {visible.length === 0 && (
            <li className="wf-friend-dim">{filter ? "No matches." : "No notes."}</li>
          )}
        </ul>
      </aside>
      {active ? (
        <NoteEditor
          key={active}
          name={active}
          noteNames={noteNames}
          view={view}
          onViewChange={setView}
          onHelp={() => setHelpOpen(true)}
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
        <div className="wf-notes-empty">
          <p>Select or create a note.</p>
          <p className="wf-notes-empty-hint">
            Notes are plain markdown files stored on this computer — private, offline, and
            never uploaded.
          </p>
          <div className="wf-notes-empty-actions">
            <button className="wf-primary" onClick={() => void createNote()}>
              New note
            </button>
            <button onClick={() => setHelpOpen(true)}>
              <CircleQuestionMark size={14} /> Formatting guide
            </button>
          </div>
        </div>
      )}
      {helpOpen && <MarkdownHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function NoteEditor({
  name,
  noteNames,
  view,
  onViewChange,
  onHelp,
  onRenamedOrDeleted,
  onOpenNote,
  onError,
  onSaved,
}: {
  name: string;
  noteNames: string[];
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  onHelp: () => void;
  onRenamedOrDeleted: (next: string | null) => void;
  onOpenNote: (name: string) => void;
  onError: (e: string | null) => void;
  onSaved: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [backlinks, setBacklinks] = useState<string[]>([]);
  const [links, setLinks] = useState<string[]>([]);
  const [status, setStatus] = useState<"saved" | "dirty" | "saving">("saved");
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<string>("");
  const cm = useRef<ReactCodeMirrorRef>(null);

  useEffect(() => {
    void backend
      .vaultRead(name)
      .then((text) => {
        setContent(text);
        setDraft(text);
        latest.current = text;
        setLinks(extractLinks(text));
      })
      .catch((e) => onError(isCmdError(e) ? e.message : String(e)));
    void backend.vaultBacklinks(name).then(setBacklinks).catch(() => {});
  }, [name, onError]);

  const save = useCallback(async () => {
    setStatus("saving");
    try {
      await backend.vaultWrite(name, latest.current);
      setStatus("saved");
      onSaved();
    } catch (e) {
      setStatus("dirty");
      onError(isCmdError(e) ? e.message : String(e));
    }
  }, [name, onSaved, onError]);

  const html = useMemo(
    () => (view === "edit" ? "" : renderMarkdown(draft, noteNames)),
    [draft, noteNames, view],
  );

  /** Wraps the selection, or inserts the marker pair at the cursor. */
  const wrap = (before: string, after = before) => {
    const editor = cm.current?.view;
    if (!editor) return;
    const { from, to } = editor.state.selection.main;
    editor.dispatch({
      changes: { from, to, insert: `${before}${editor.state.sliceDoc(from, to)}${after}` },
      selection: { anchor: from + before.length, head: to + before.length },
      scrollIntoView: true,
    });
    editor.focus();
  };

  /** Prefixes every line the selection touches (lists, quotes, headings). */
  const prefixLines = (prefix: string) => {
    const editor = cm.current?.view;
    if (!editor) return;
    const { from, to } = editor.state.selection.main;
    const first = editor.state.doc.lineAt(from).number;
    const last = editor.state.doc.lineAt(to).number;
    const changes: { from: number; insert: string }[] = [];
    for (let n = first; n <= last; n++) {
      const line = editor.state.doc.line(n);
      if (!line.text.startsWith(prefix)) {
        changes.push({ from: line.from, insert: prefix });
      }
    }
    if (changes.length) editor.dispatch({ changes, scrollIntoView: true });
    editor.focus();
  };

  const onChange = (value: string) => {
    latest.current = value;
    setDraft(value);
    setLinks(extractLinks(value));
    setStatus("dirty");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), 1200);
  };

  const rename = async (next: string) => {
    setRenaming(false);
    const trimmed = next.trim();
    if (!trimmed || trimmed === name) return;
    try {
      // Flush first: the rename remounts this editor and would drop the
      // pending debounced write.
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await backend.vaultWrite(name, latest.current);
      const used = await backend.vaultRename(name, trimmed);
      onError(null);
      onRenamedOrDeleted(used);
    } catch (e) {
      onError(isCmdError(e) ? e.message : String(e));
    }
  };

  // Flush on unmount so switching notes never loses the last keystrokes.
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        void backend.vaultWrite(name, latest.current).catch(() => {});
      }
    };
  }, [name]);

  if (content === null) return <div className="wf-notes-empty">Loading…</div>;

  return (
    <main className="wf-notes-main">
      <header className="wf-notes-header">
        {renaming ? (
          <input
            className="wf-notes-title-input"
            autoFocus
            defaultValue={name}
            onBlur={(e) => void rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setRenaming(false);
              }
            }}
          />
        ) : (
          <button
            className="wf-notes-title"
            title="Rename note"
            onClick={() => setRenaming(true)}
          >
            {name}
            <Pencil size={13} />
          </button>
        )}
        <span className="wf-session-meta">
          {status === "saving" ? "saving…" : status === "dirty" ? "unsaved" : "saved"}
        </span>
        <span className="wf-statusbar-spacer" />
        <div className="wf-notes-modes">
          <button
            className={`wf-icon ${view === "edit" ? "active" : ""}`}
            title="Edit only"
            onClick={() => onViewChange("edit")}
          >
            <Pencil size={14} />
          </button>
          <button
            className={`wf-icon ${view === "split" ? "active" : ""}`}
            title="Split view"
            onClick={() => onViewChange("split")}
          >
            <Columns2 size={14} />
          </button>
          <button
            className={`wf-icon ${view === "read" ? "active" : ""}`}
            title="Preview only"
            onClick={() => onViewChange("read")}
          >
            <Eye size={14} />
          </button>
        </div>
        <button className="wf-icon" title="Formatting guide" onClick={onHelp}>
          <CircleQuestionMark size={14} />
        </button>
        <button onClick={() => setSharing(true)}>Share</button>
        <button
          className="wf-danger"
          onClick={() =>
            void confirmDialog(`Delete "${name}"? This removes the file from your vault.`, {
              title: "Delete note",
              confirmLabel: "Delete",
              danger: true,
            }).then((ok) => {
              if (ok) {
                if (saveTimer.current) clearTimeout(saveTimer.current);
                saveTimer.current = null;
                void backend.vaultDelete(name).then(() => onRenamedOrDeleted(null));
              }
            })
          }
        >
          Delete
        </button>
      </header>

      {view !== "read" && (
        <div className="wf-notes-toolbar">
          <button className="wf-icon" title="Bold" onClick={() => wrap("**")}>
            <Bold size={14} />
          </button>
          <button className="wf-icon" title="Italic" onClick={() => wrap("*")}>
            <Italic size={14} />
          </button>
          <button className="wf-icon" title="Strikethrough" onClick={() => wrap("~~")}>
            <Strikethrough size={14} />
          </button>
          <span className="wf-notes-toolbar-sep" />
          <button className="wf-icon" title="Heading" onClick={() => prefixLines("## ")}>
            <Heading size={14} />
          </button>
          <button className="wf-icon" title="Bullet list" onClick={() => prefixLines("- ")}>
            <List size={14} />
          </button>
          <button className="wf-icon" title="Task" onClick={() => prefixLines("- [ ] ")}>
            <ListChecks size={14} />
          </button>
          <button className="wf-icon" title="Quote" onClick={() => prefixLines("> ")}>
            <Quote size={14} />
          </button>
          <span className="wf-notes-toolbar-sep" />
          <button className="wf-icon" title="Code" onClick={() => wrap("`")}>
            <Code size={14} />
          </button>
          <button className="wf-icon" title="Link to another note" onClick={() => wrap("[[", "]]")}>
            <Link2 size={14} />
          </button>
          <button title="Callout" onClick={() => prefixLines("> [!tip] ")}>
            Callout
          </button>
        </div>
      )}

      <div className={`wf-notes-body wf-notes-body-${view}`}>
        {view !== "read" && (
          <div className="wf-notes-editor">
            <CodeMirror
              ref={cm}
              value={content}
              height="100%"
              theme="dark"
              extensions={[markdown()]}
              onChange={onChange}
            />
          </div>
        )}
        {view !== "edit" && (
          <div
            className="wf-notes-preview"
            onClick={(e) => {
              const link = (e.target as HTMLElement).closest<HTMLElement>("button.wf-wikilink");
              const target = link?.dataset.wfNote;
              if (target) void openOrCreate(target, onOpenNote);
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
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
    await backend.vaultWrite(name, "");
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

const CHEATSHEET: { syntax: string; what: string }[] = [
  { syntax: "# Heading", what: "Headings, `#` through `######`" },
  { syntax: "**bold**  *italic*  ~~strike~~", what: "Emphasis" },
  { syntax: "[[Note Name]]", what: "Link to another note — click to open, or create it if new" },
  { syntax: "[[Note Name|label]]", what: "Same link, different visible text" },
  { syntax: "- item", what: "Bullet list (`1.` for numbered)" },
  { syntax: "- [ ] todo\n- [x] done", what: "Task list with checkboxes" },
  { syntax: "> quoted text", what: "Blockquote" },
  { syntax: "> [!tip] Title\n> body", what: "Callout — note, tip, warning, danger, success, question, example, quote" },
  { syntax: "> [!warning]- Title", what: "Add `-` to start folded, `+` to start open" },
  { syntax: "`code`", what: "Inline code" },
  { syntax: "```js\ncode\n```", what: "Fenced code block with syntax highlighting" },
  { syntax: "[text](https://…)", what: "Web link — opens in your browser" },
  { syntax: "| a | b |\n| --- | --- |", what: "Table" },
  { syntax: "---", what: "Horizontal rule" },
];

function MarkdownHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="wf-modal-backdrop" onClick={onClose}>
      <div className="wf-modal wf-notes-help" onClick={(e) => e.stopPropagation()}>
        <h3>Formatting</h3>
        <p className="wf-friend-dim">
          Notes are Obsidian-compatible markdown. The vault is a folder of plain{" "}
          <code>.md</code> files on this computer.
        </p>
        <dl className="wf-cheatsheet">
          {CHEATSHEET.map((row) => (
            <div key={row.syntax}>
              <dt>
                <code>{row.syntax}</code>
              </dt>
              <dd>{row.what}</dd>
            </div>
          ))}
        </dl>
        <div className="wf-notes-help-actions">
          <button className="wf-primary" onClick={onClose}>
            <Check size={14} /> Done
          </button>
        </div>
      </div>
    </div>
  );
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
