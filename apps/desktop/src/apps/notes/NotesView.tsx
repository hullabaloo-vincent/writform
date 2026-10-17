import { markdown } from "@codemirror/lang-markdown";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  Bold,
  Check,
  ChevronDown,
  ChevronRight,
  CircleQuestionMark,
  Code,
  Columns2,
  ExternalLink,
  Eye,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
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
import { Modal } from "../../platform";
import { toast, toastError } from "../../platform/toast";
import { useSession } from "../../stores/session";
import { friendsApi } from "../friends/FriendsView";
import { Flyout, FlyoutItem } from "../../editor/ui/Flyout";
import { renderMarkdown } from "./markdown";
import { baseOf, buildTree, cleanName, foldersAbove, joinPath, newNoteFor, parentOf, resolveLink, type FolderNode } from "./paths";
import { useNotesPending } from "./pending";

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

/** Reveal the vault folder in Finder/Explorer; a no-op in the dev preview. */
async function revealVault() {
  try {
    const dir = await backend.vaultPath();
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(dir);
  } catch {
    // browser preview or plugin unavailable
  }
}

interface SearchHit {
  name: string;
  snippet: string;
  modified_at: number;
}

const OPEN_KEY = "wf-notes-open";

/** The folders shown open in the sidebar (remembered on this device). */
function loadOpen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : []);
  } catch {
    return new Set();
  }
}

export function NotesView() {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [openFolders, setOpenFolders] = useState<Set<string>>(loadOpen);
  // Where a new note or folder goes: the folder last picked, or the open
  // note's.
  const [place, setPlace] = useState("");
  // A folder being named (made in `parent`, or renamed).
  const [naming, setNaming] = useState<{ kind: "new"; parent: string } | { kind: "rename"; path: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(loadViewMode);
  const [helpOpen, setHelpOpen] = useState(false);

  const show = useCallback((name: string | null) => {
    setActive(name);
    if (name === null) return;
    setPlace(parentOf(name));
    // The folders it's in open, so it can be seen in the list.
    setOpenFolders((prev) => {
      const above = foldersAbove(name);
      if (above.every((f) => prev.has(f))) return prev;
      return new Set([...prev, ...above]);
    });
  }, []);

  // The ⌘K palette and Home can land here on a specific note.
  const pendingName = useNotesPending((s) => s.name);
  useEffect(() => {
    if (pendingName === null) return;
    show(pendingName);
    useNotesPending.getState().clear();
  }, [pendingName, show]);

  const refresh = useCallback(
    () =>
      Promise.all([backend.vaultList(), backend.vaultFolders()])
        .then(([list, dirs]) => {
          setNotes(list);
          setFolders(dirs);
        })
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...openFolders]));
    } catch {
      // Remembering which folders are open is a convenience.
    }
  }, [openFolders]);

  // Content search kicks in from 2 chars, debounced; the name filter below
  // stays instant either way.
  useEffect(() => {
    const query = filter.trim();
    if (query.length < 2) {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      void backend
        .vaultSearch(query)
        .then(setHits)
        .catch(() => setHits(null));
    }, 200);
    return () => clearTimeout(timer);
  }, [filter]);

  const fail = (e: unknown) => setError(isCmdError(e) ? e.message : String(e));

  const createNote = async (folder = place) => {
    const taken = new Set(notes.map((note) => note.name.toLowerCase()));
    const base = joinPath(folder, "Untitled");
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} ${n}`;
    try {
      await backend.vaultWrite(name, "");
      await refresh();
      show(name);
    } catch (e) {
      fail(e);
    }
  };

  const toggleFolder = (path: string) => {
    setPlace(path);
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const finishNaming = async (value: string) => {
    const was = naming;
    setNaming(null);
    if (!was || !value.trim()) return;
    if (value.includes("/")) {
      setError("A folder's name can't have a slash in it.");
      return;
    }
    try {
      if (was.kind === "new") {
        const path = cleanName(joinPath(was.parent, value));
        if (!path) throw { code: "bad_name", message: "That name can't be a folder's." };
        await backend.vaultFolderCreate(path);
        setOpenFolders((prev) => new Set([...prev, ...foldersAbove(`${path}/x`)]));
        setPlace(path);
      } else {
        const next = cleanName(joinPath(parentOf(was.path), value));
        if (!next) throw { code: "bad_name", message: "That name can't be a folder's." };
        if (next === was.path) return;
        const used = await backend.vaultFolderRename(was.path, next);
        const moved = (n: string) => (n === was.path || n.startsWith(`${was.path}/`) ? used + n.slice(was.path.length) : n);
        setOpenFolders((prev) => new Set([...prev].map(moved)));
        if (active) setActive(moved(active));
        setPlace(moved(place));
      }
      setError(null);
      await refresh();
    } catch (e) {
      fail(e);
    }
  };

  const deleteFolder = async (path: string) => {
    const count = notes.filter((n) => n.name.startsWith(`${path}/`)).length;
    try {
      await backend.vaultFolderDelete(path);
      if (active?.startsWith(`${path}/`)) setActive(null);
      if (place === path || place.startsWith(`${path}/`)) setPlace(parentOf(path));
      await refresh();
      toast(count ? `Deleted the folder “${baseOf(path)}” and its ${count === 1 ? "note" : `${count} notes`}.` : `Deleted the folder “${baseOf(path)}”.`, "info", {
        durationMs: 10000,
        action: {
          label: "Undo",
          run: () =>
            void backend
              .vaultFolderRestore(path)
              .then(() => refresh())
              .catch(() => toastError("That folder couldn't be restored.")),
        },
      });
    } catch {
      toastError("That folder couldn't be deleted.");
    }
  };

  const tree = useMemo(() => buildTree(notes, folders), [notes, folders]);
  const noteNames = useMemo(() => notes.map((n) => n.name), [notes]);

  // With ≥2 chars, server-side content search replaces the name filter;
  // while searching the list is flat, each note with its folder.
  const searching = filter.trim().length > 0;
  const listed: SearchHit[] =
    hits !== null
      ? hits
      : notes.filter((n) => n.name.toLowerCase().includes(filter.toLowerCase())).map((n) => ({ name: n.name, snippet: "", modified_at: n.modified_at }));

  const noteRow = (name: string, snippet = "", depth = 0) => (
    <li key={name}>
      <button
        className={`wf-note-item ${name === active ? "active" : ""}`}
        style={depth ? { paddingLeft: 10 + depth * 14 } : undefined}
        title={name}
        onClick={() => show(name)}
      >
        <span className="wf-note-name">{baseOf(name)}</span>
        {searching && parentOf(name) && <span className="wf-note-folder">{parentOf(name)}</span>}
        {snippet && <span className="wf-note-snippet">{snippet}</span>}
      </button>
    </li>
  );

  const nameInput = (depth: number, value: string) => (
    <li key="naming" className="wf-note-folder-row" style={{ paddingLeft: 6 + depth * 14 }}>
      <FolderIcon size={14} />
      <input
        className="wf-note-folder-input"
        autoFocus
        defaultValue={value}
        aria-label="Folder name"
        placeholder="Folder name"
        onBlur={(e) => void finishNaming(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setNaming(null);
        }}
      />
    </li>
  );

  const folderRows = (node: FolderNode, depth: number): React.ReactNode[] => {
    const rows: React.ReactNode[] = [];
    if (naming?.kind === "new" && naming.parent === node.path) rows.push(nameInput(depth, ""));
    for (const folder of node.folders) {
      const isOpen = openFolders.has(folder.path);
      if (naming?.kind === "rename" && naming.path === folder.path) {
        rows.push(nameInput(depth, folder.name));
      } else {
        rows.push(
          <li key={`folder:${folder.path}`} className={`wf-note-folder-row${place === folder.path ? " here" : ""}`}>
            <button
              className="wf-note-folder-toggle"
              style={{ paddingLeft: 6 + depth * 14 }}
              aria-expanded={isOpen}
              title={folder.path}
              onClick={() => toggleFolder(folder.path)}
            >
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {isOpen ? <FolderOpen size={14} /> : <FolderIcon size={14} />}
              <span className="wf-note-name">{folder.name}</span>
            </button>
            <Flyout title={`More for “${folder.name}”`} icon={<MoreHorizontal size={14} />} caret={false} className="wf-note-folder-more">
              {(close) => (
                <>
                  <FlyoutItem
                    onPick={() => {
                      close();
                      void createNote(folder.path);
                    }}
                  >
                    New note here
                  </FlyoutItem>
                  <FlyoutItem
                    onPick={() => {
                      close();
                      setOpenFolders((prev) => new Set([...prev, folder.path]));
                      setNaming({ kind: "new", parent: folder.path });
                    }}
                  >
                    New folder inside
                  </FlyoutItem>
                  <FlyoutItem
                    onPick={() => {
                      close();
                      setNaming({ kind: "rename", path: folder.path });
                    }}
                  >
                    Rename
                  </FlyoutItem>
                  <FlyoutItem
                    onPick={() => {
                      close();
                      void deleteFolder(folder.path);
                    }}
                  >
                    Delete
                  </FlyoutItem>
                </>
              )}
            </Flyout>
          </li>,
        );
      }
      if (isOpen) rows.push(...folderRows(folder, depth + 1));
    }
    for (const note of node.notes) rows.push(noteRow(note.name, "", depth));
    return rows;
  };

  return (
    <div className="wf-notes">
      <aside className="wf-notes-side">
        <div className="wf-notes-side-top">
          <input
            placeholder="search notes…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="wf-icon" title={place ? `New note in “${baseOf(place)}”` : "New note"} onClick={() => void createNote()}>
            +
          </button>
          <button
            className="wf-icon"
            title={place ? `New folder in “${baseOf(place)}”` : "New folder"}
            onClick={() => {
              if (place) setOpenFolders((prev) => new Set([...prev, place]));
              setNaming({ kind: "new", parent: place });
            }}
          >
            <FolderPlus size={14} />
          </button>
          <button
            className="wf-icon"
            title="Show the vault folder in your file manager"
            onClick={() => void revealVault()}
          >
            <ExternalLink size={14} />
          </button>
        </div>
        {error && (
          <p className="wf-connect-error" onClick={() => setError(null)}>
            {error}
          </p>
        )}
        <ul>
          {searching ? listed.map((n) => noteRow(n.name, n.snippet)) : folderRows(tree, 0)}
          {searching && listed.length === 0 && <li className="wf-friend-dim">No matches.</li>}
          {!searching && notes.length === 0 && folders.length === 0 && !naming && <li className="wf-friend-dim">No notes.</li>}
        </ul>
        {!searching && place && (
          <p className="wf-notes-top">
            New notes go in “{baseOf(place)}”.{" "}
            <button className="wf-link-button" onClick={() => setPlace("")}>
              Put them at the top
            </button>
          </p>
        )}
      </aside>
      {active ? (
        <NoteEditor
          key={active}
          name={active}
          noteNames={noteNames}
          folders={folders}
          view={view}
          onViewChange={setView}
          onHelp={() => setHelpOpen(true)}
          onRenamedOrDeleted={(next) => {
            show(next);
            void refresh();
          }}
          onError={setError}
          onOpenNote={(name) => {
            show(name);
            void refresh();
          }}
          onSaved={refresh}
        />
      ) : (
        <div className="wf-notes-empty">
          <p>Select or create a note.</p>
          <p className="wf-notes-empty-hint">
            Notes are plain markdown files stored on this computer. They are private, work
            offline and are never uploaded. Folders here are folders in the vault, as Obsidian has them.
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
  folders,
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
  folders: string[];
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
    () => (view === "edit" ? "" : renderMarkdown(draft, noteNames, name)),
    [draft, noteNames, view, name],
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
    // The title is the note's own name: it stays in its folder.
    const trimmed = cleanName(next.includes("/") ? next : joinPath(parentOf(name), next));
    if (!trimmed || trimmed === name) {
      if (!trimmed && next.trim()) onError("That name can't be a note's.");
      return;
    }
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
            defaultValue={baseOf(name)}
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
            {baseOf(name)}
            <Pencil size={13} />
          </button>
        )}
        <label className="wf-notes-move" title="The folder this note is in. Choose another to move it there.">
          <FolderIcon size={13} />
          <select
            aria-label="Folder"
            value={parentOf(name)}
            onChange={(e) => {
              const folder = e.target.value;
              if (saveTimer.current) clearTimeout(saveTimer.current);
              saveTimer.current = null;
              void backend
                .vaultWrite(name, latest.current)
                .then(() => backend.vaultMove(name, folder))
                .then((moved) => onRenamedOrDeleted(moved))
                .catch((err) => onError(isCmdError(err) ? err.message : String(err)));
            }}
          >
            <option value="">Top of the vault</option>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f.split("/").join(" / ")}
              </option>
            ))}
          </select>
        </label>
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
        {useSession.getState().phase !== "offline" && (
          <button onClick={() => setSharing(true)}>Share</button>
        )}
        <button
          className="wf-danger"
          onClick={() =>
            {
              // No "are you sure": the note goes to the vault's trash, and
              // the toast puts it back.
              if (saveTimer.current) clearTimeout(saveTimer.current);
              saveTimer.current = null;
              const deleted = name;
              void backend
                .vaultWrite(deleted, latest.current)
                .catch(() => {})
                .then(() => backend.vaultDelete(deleted))
                .then(() => {
                  onRenamedOrDeleted(null);
                  toast(`Deleted “${baseOf(deleted)}”.`, "info", {
                    durationMs: 10000,
                    action: {
                      label: "Undo",
                      run: () =>
                        void backend
                          .vaultRestore(deleted)
                          .then((restored) => onRenamedOrDeleted(restored))
                          .catch(() => toastError("That note couldn't be restored.")),
                    },
                  });
                })
                .catch(() => toastError("That note couldn't be deleted."));
            }
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
              if (target) void openOrCreate(target, name, noteNames, onOpenNote, onError);
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
              <button key={l} className="wf-note-link" onClick={() => void openOrCreate(l, name, noteNames, onOpenNote, onError)}>
                [[{l}]]
              </button>
            ))}
          </span>
        )}
        {backlinks.length > 0 && (
          <span>
            backlinks:{" "}
            {backlinks.map((l) => (
              <button key={l} className="wf-note-link" title={l} onClick={() => onOpenNote(l)}>
                {baseOf(l)}
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
                title: baseOf(name),
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

/** Follow a `[[link]]` written in the note `from`: to the note it leads
 *  to, or to a new one made for it (beside `from`, or at the path given). */
async function openOrCreate(link: string, from: string, names: readonly string[], open: (name: string) => void, onError: (e: string | null) => void) {
  const found = resolveLink(names, link, from);
  if (found) {
    open(found);
    return;
  }
  const made = newNoteFor(link, from);
  if (!made) {
    onError(`“${link}” can't be a note's name.`);
    return;
  }
  try {
    await backend.vaultWrite(made, "");
    open(made);
  } catch (e) {
    onError(isCmdError(e) ? e.message : String(e));
  }
}

function extractLinks(content: string): string[] {
  const links = new Set<string>();
  for (const m of content.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g)) {
    links.add(m[1].trim());
  }
  return [...links];
}

const CHEATSHEET: { syntax: string; what: string }[] = [
  { syntax: "# Heading", what: "Headings from `#` through `######`" },
  { syntax: "**bold**  *italic*  ~~strike~~", what: "Emphasis" },
  { syntax: "[[Note Name]]", what: "Link to another note (click to open, or create it if new)" },
  { syntax: "[[Note Name|label]]", what: "The same link with different visible text" },
  { syntax: "- item", what: "Bullet list (`1.` for numbered)" },
  { syntax: "- [ ] todo\n- [x] done", what: "Task list with checkboxes" },
  { syntax: "> quoted text", what: "Blockquote" },
  { syntax: "> [!tip] Title\n> body", what: "Callout: note, tip, warning, danger, success, question, example, quote" },
  { syntax: "> [!warning]- Title", what: "Add `-` to start folded, `+` to start open" },
  { syntax: "`code`", what: "Inline code" },
  { syntax: "```js\ncode\n```", what: "Fenced code block with syntax highlighting" },
  { syntax: "[text](https://…)", what: "Web link (opens in your browser)" },
  { syntax: "| a | b |\n| --- | --- |", what: "Table" },
  { syntax: "---", what: "Horizontal rule" },
];

function MarkdownHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} className="wf-notes-help">
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
    </Modal>
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
    <Modal onClose={onClose}>
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
    </Modal>
  );
}
