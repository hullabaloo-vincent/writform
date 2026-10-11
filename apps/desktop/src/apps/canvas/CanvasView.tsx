import { HardDrive, MoreHorizontal, Search, Share2, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CanvasBoard } from "../../bindings/proto/CanvasBoard";
import { backend, isCmdError, isWeb } from "../../lib/backend";
import { useSession } from "../../stores/session";
import { useWhenConnected } from "../../stores/whenConnected";
import { ContextMenu, type MenuItem } from "../documents/organizer/ContextMenu";
import { GroupChip } from "../chat/GroupChip";
import { useChat } from "../chat/store";
import { canvasApi } from "./api";
import { BoardRoom } from "./BoardRoom";
import type { ImportDest } from "./boardFile";
import { ImportBoardDialog } from "./ImportBoardDialog";
import { searchLocalBoards, useLocalBoards, type LocalBoardMeta } from "./local";
import { PublishBoardDialog } from "./PublishBoardDialog";
import { useCanvas } from "./store";

export function CanvasView() {
  const groups = useChat((s) => s.groups);
  const loadGroups = useChat((s) => s.loadGroups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const activeBoardId = useCanvas((s) => s.activeBoardId);
  const offline = useSession((s) => s.phase === "offline");

  useEffect(() => {
    if (!offline && groups.length === 0) void loadGroups();
  }, [groups.length, loadGroups, offline]);

  // Re-read on every visit so the "edited" dates reflect the last session.
  useEffect(() => {
    if (!isWeb) void useLocalBoards.getState().load().catch(() => {});
  }, []);

  if (activeBoardId !== null) return <BoardRoom />;
  return <BoardList groupId={offline ? null : activeGroupId} offline={offline} />;
}

function BoardList({ groupId, offline }: { groupId: number | null; offline: boolean }) {
  const byGroup = useCanvas((s) => s.byGroup);
  const loadBoards = useCanvas((s) => s.loadBoards);
  const openBoard = useCanvas((s) => s.openBoard);
  const localBoards = useLocalBoards((s) => s.items);
  const [creating, setCreating] = useState<"group" | "local" | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importJob, setImportJob] = useState<{ file: File; dest: ImportDest } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingDest = useRef<ImportDest>({ kind: "local" });
  const [query, setQuery] = useState("");
  /** Boards on this device a search found: id → the words around the match. */
  const [foundFor, setFoundFor] = useState<{ query: string; hits: Map<number, string> } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [publishing, setPublishing] = useState<{ id: number; name: string } | null>(null);
  /** Publishing needs a server: not connected, it follows the connect sheet. */
  const publish = useWhenConnected((board: { id: number; name: string }) => setPublishing(board));

  useEffect(() => {
    if (groupId !== null) void loadBoards(groupId).catch(() => {});
  }, [groupId, loadBoards]);

  // Names are matched from the list; the words on a board, on disk.
  useEffect(() => {
    const q = query.trim();
    if (!q || isWeb) {
      setFoundFor(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void searchLocalBoards(q)
        .then((hits) => live && setFoundFor({ query: q, hits }))
        .catch(() => live && setFoundFor({ query: q, hits: new Map() }));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, localBoards]);

  const q = query.trim().toLowerCase();
  // Only what was found for the words now in the field.
  const found = foundFor && foundFor.query === query.trim() ? foundFor.hits : null;
  const boards = (groupId !== null ? (byGroup[groupId] ?? []) : []).filter((b) => !q || b.name.toLowerCase().includes(q));
  const localShown = q ? localBoards.filter((b) => b.name.toLowerCase().includes(q) || found?.has(b.id)) : localBoards;
  const fail = (e: unknown) => setError(isCmdError(e) ? e.message : String(e));

  const localMenu = (board: LocalBoardMeta, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: "Open", onClick: () => open(board.id) },
        { label: "Publish to a server…", icon: <Share2 size={14} />, onClick: () => publish({ id: board.id, name: board.name }) },
        {
          label: "Delete",
          icon: <Trash2 size={14} />,
          danger: true,
          // To Recently Deleted, with an Undo in the toast.
          onClick: () => void useLocalBoards.getState().remove(board.id).catch(fail),
        },
      ],
    });

  /** Opening marks the board active before it loads, so a failure has to put
   *  the list back rather than leave an empty room on screen. */
  const open = (boardId: number) =>
    void openBoard(boardId).catch((e) => {
      useCanvas.getState().closeBoard();
      fail(e);
    });

  const pickImport = (dest: ImportDest) => {
    pendingDest.current = dest;
    fileRef.current?.click();
  };

  const onImportFile = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".pdf") && isWeb) {
      // Same tier as the notes vault: reconstruction runs on the desktop app.
      setError("PDF import needs the desktop app.");
      return;
    }
    if (!lower.endsWith(".pdf") && !lower.endsWith(".wfboard")) {
      setError("Import a .pdf (FigJam / Freeform export) or a .wfboard file.");
      return;
    }
    setImportJob({ file, dest: pendingDest.current });
  };

  const createBoard = () => {
    if (groupId === null || !name.trim()) return;
    setError(null);
    canvasApi
      .createBoard(groupId, name.trim())
      .then((b) => {
        setName("");
        setCreating(null);
        void loadBoards(groupId);
        open(b.id);
      })
      .catch(fail);
  };

  const createLocal = () => {
    if (!name.trim()) return;
    setError(null);
    void useLocalBoards
      .getState()
      .create(name.trim())
      .then((id) => {
        setName("");
        setCreating(null);
        open(id);
      })
      .catch(fail);
  };

  const nameForm = (submit: () => void) => (
    <form
      className="wf-session-card"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        placeholder="board name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onBlur={() => !name.trim() && setCreating(null)}
      />
      <button className="wf-primary" type="submit" disabled={!name.trim()}>
        Create
      </button>
    </form>
  );

  return (
    <div className="wf-sessions">
      <header className="wf-sessions-header">
        <h2>Canvas boards</h2>
        {(localBoards.length > 0 || boards.length > 0 || q) && (
          <div className="wf-doc-search">
            <Search size={14} />
            <input
              placeholder={isWeb ? "Search boards…" : "Search boards and the words on them…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search boards"
            />
            {query && (
              <button title="Clear search" onClick={() => setQuery("")}>
                ×
              </button>
            )}
          </div>
        )}
        {groupId !== null && <GroupChip />}
      </header>
      {error && <p className="wf-connect-error">{error}</p>}

      {groupId === null ? (
        <p className="wf-app-empty-hint">
          {offline
            ? "Boards shared with a group live on a server and appear here once you connect. Boards on this device work without one."
            : "Join a group first (see the Chat app) for shared boards. Boards on this device work without a group."}
        </p>
      ) : (
        <>
          {boards.length === 0 && !q && (
            <p className="wf-app-empty-hint">
              Boards are shared visual spaces for your group. They hold sticky notes, images,
              frames, connectors and live document excerpts, and they sync in real time. Create
              one to start storyboarding together.
            </p>
          )}
          <div className="wf-sessions-grid">
            {boards.map((b) => (
              <BoardCard key={b.id} board={b} onOpen={() => open(b.id)} />
            ))}
            {creating === "group" ? (
              nameForm(createBoard)
            ) : (
              <button
                className="wf-session-card wf-session-new"
                onClick={() => {
                  setName("");
                  setCreating("group");
                }}
              >
                + New board
              </button>
            )}
            <button
              className="wf-session-card wf-session-new"
              title="Import a board file or a FigJam / Freeform PDF export"
              onClick={() => pickImport({ kind: "group", groupId })}
            >
              <Upload size={15} /> Import board
            </button>
          </div>
        </>
      )}

      {!isWeb && (
        <section className="wf-documents-section">
          <h3>
            <HardDrive size={14} /> On this device
          </h3>
          <div className="wf-sessions-grid">
            {localShown.map((b) => (
              <LocalBoardCard
                key={b.id}
                board={b}
                snippet={q ? found?.get(b.id) || null : null}
                onOpen={() => open(b.id)}
                onMenu={(x, y) => localMenu(b, x, y)}
              />
            ))}
            {creating === "local" ? (
              nameForm(createLocal)
            ) : (
              <button
                className="wf-session-card wf-session-new"
                onClick={() => {
                  setName("");
                  setCreating("local");
                }}
              >
                + New local board
              </button>
            )}
            <button
              className="wf-session-card wf-session-new"
              title="Import a board file or a FigJam / Freeform PDF export"
              onClick={() => pickImport({ kind: "local" })}
            >
              <Upload size={15} /> Import board
            </button>
          </div>
          {q && localShown.length === 0 && <p className="wf-app-empty-hint">No board on this device matches “{query.trim()}”.</p>}
          <DeletedBoards watch={localBoards.length} />
        </section>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {publishing && <PublishBoardDialog board={publishing} onClose={() => setPublishing(null)} onOpen={open} />}

      <input
        ref={fileRef}
        type="file"
        hidden
        // PDF reconstruction is desktop-only; the web client takes .wfboard.
        accept={isWeb ? ".wfboard" : ".pdf,application/pdf,.wfboard"}
        onChange={(e) => {
          onImportFile(e.target.files);
          e.target.value = "";
        }}
      />
      {importJob && (
        <ImportBoardDialog
          file={importJob.file}
          dest={importJob.dest}
          onDone={(boardId) => {
            const job = importJob;
            setImportJob(null);
            if (boardId === null) return;
            if (job.dest.kind === "group") void loadBoards(job.dest.groupId).catch(() => {});
            open(boardId);
          }}
        />
      )}
    </div>
  );
}

function BoardCard({ board, onOpen }: { board: CanvasBoard; onOpen: () => void }) {
  return (
    <button className="wf-session-card" onClick={onOpen}>
      <strong>{board.name}</strong>
      <span className="wf-session-meta">
        by {board.creator.display_name ?? board.creator.username} ·{" "}
        {new Date(board.created_at).toLocaleDateString()}
      </span>
    </button>
  );
}

function LocalBoardCard({
  board,
  snippet,
  onOpen,
  onMenu,
}: {
  board: LocalBoardMeta;
  /** The words around a search match on the board. */
  snippet: string | null;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  return (
    <div
      className="wf-session-card-wrap wf-board-card"
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <button className="wf-session-card" onClick={onOpen}>
        <strong>{board.name}</strong>
        {snippet && <span className="wf-board-card-snippet">{snippet}</span>}
        <span className="wf-session-meta">
          on this device · edited {new Date(board.updated_at).toLocaleDateString()}
        </span>
      </button>
      <button
        className="wf-board-card-more"
        title="Board options"
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left, r.bottom + 4);
        }}
      >
        <MoreHorizontal size={15} />
      </button>
    </div>
  );
}

/** Boards deleted from this device in the last 30 days: restore, or let go. */
function DeletedBoards({ watch }: { watch: number }) {
  const [items, setItems] = useState<{ id: string; name: string; updated_at: number }[]>([]);
  const [open, setOpen] = useState(false);
  const refresh = () => void backend.localboardTrashList().then(setItems).catch(() => {});
  // Deleting or restoring changes the list beside this one.
  useEffect(refresh, [watch]);
  if (items.length === 0) return null;
  return (
    <div className="wf-board-trash">
      <button className="wf-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Recently deleted ({items.length})
      </button>
      {open && (
        <ul>
          {items.map((b) => (
            <li key={b.id}>
              <span>
                {b.name}
                <small> · deleted {new Date(b.updated_at).toLocaleDateString()}</small>
              </span>
              <button
                onClick={() =>
                  void backend
                    .localboardRestore(b.id)
                    .then(() => useLocalBoards.getState().load())
                    .then(refresh)
                    .catch(() => {})
                }
              >
                Restore
              </button>
              <button className="wf-danger" title="Delete for good" onClick={() => void backend.localboardPurge(b.id).then(refresh).catch(() => {})}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
