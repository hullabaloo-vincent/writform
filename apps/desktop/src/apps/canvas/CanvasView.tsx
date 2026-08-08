import { HardDrive } from "lucide-react";
import { useEffect, useState } from "react";

import type { CanvasBoard } from "../../bindings/proto/CanvasBoard";
import { isCmdError, isWeb } from "../../lib/backend";
import { useSession } from "../../stores/session";
import { GroupChip } from "../chat/GroupChip";
import { useChat } from "../chat/store";
import { canvasApi } from "./api";
import { BoardRoom } from "./BoardRoom";
import { useLocalBoards, type LocalBoardMeta } from "./local";
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

  useEffect(() => {
    if (groupId !== null) void loadBoards(groupId).catch(() => {});
  }, [groupId, loadBoards]);

  const boards = groupId !== null ? (byGroup[groupId] ?? []) : [];
  const fail = (e: unknown) => setError(isCmdError(e) ? e.message : String(e));

  /** Opening marks the board active before it loads, so a failure has to put
   *  the list back rather than leave an empty room on screen. */
  const open = (boardId: number) =>
    void openBoard(boardId).catch((e) => {
      useCanvas.getState().closeBoard();
      fail(e);
    });

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
        {groupId !== null && <GroupChip />}
      </header>
      {error && <p className="wf-connect-error">{error}</p>}

      {groupId === null ? (
        <p className="wf-app-empty-hint">
          {offline
            ? "Boards shared with a group live on a server — they appear here once you connect. Boards on this device work without one."
            : "Join a group first (see the Chat app) for shared boards. Boards on this device work without a group."}
        </p>
      ) : (
        <>
          {boards.length === 0 && (
            <p className="wf-app-empty-hint">
              Boards are shared visual spaces for your group — sticky notes, images, frames,
              connectors, and live document excerpts, all synced in real time. Create one to
              start storyboarding together.
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
          </div>
        </>
      )}

      {!isWeb && (
        <section className="wf-documents-section">
          <h3>
            <HardDrive size={14} /> On this device
          </h3>
          <div className="wf-sessions-grid">
            {localBoards.map((b) => (
              <LocalBoardCard key={b.id} board={b} onOpen={() => open(b.id)} />
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
          </div>
        </section>
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

function LocalBoardCard({ board, onOpen }: { board: LocalBoardMeta; onOpen: () => void }) {
  return (
    <button className="wf-session-card" onClick={onOpen}>
      <strong>{board.name}</strong>
      <span className="wf-session-meta">
        on this device · edited {new Date(board.updated_at).toLocaleDateString()}
      </span>
    </button>
  );
}
