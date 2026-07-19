import { useEffect, useState } from "react";

import type { CanvasBoard } from "../../bindings/proto/CanvasBoard";
import { isCmdError } from "../../lib/backend";
import { useChat } from "../chat/store";
import { canvasApi } from "./api";
import { BoardRoom } from "./BoardRoom";
import { useCanvas } from "./store";

export function CanvasView() {
  const groups = useChat((s) => s.groups);
  const loadGroups = useChat((s) => s.loadGroups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const activeBoardId = useCanvas((s) => s.activeBoardId);

  useEffect(() => {
    if (groups.length === 0) void loadGroups();
  }, [groups.length, loadGroups]);

  if (activeBoardId !== null) return <BoardRoom />;
  if (activeGroupId === null) {
    return <div className="wf-sessions-empty">Join a group first (see the Chat app).</div>;
  }
  return <BoardList groupId={activeGroupId} />;
}

function BoardList({ groupId }: { groupId: number }) {
  const byGroup = useCanvas((s) => s.byGroup);
  const loadBoards = useCanvas((s) => s.loadBoards);
  const openBoard = useCanvas((s) => s.openBoard);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadBoards(groupId).catch(() => {});
  }, [groupId, loadBoards]);

  const boards = byGroup[groupId] ?? [];

  return (
    <div className="wf-sessions">
      <header className="wf-sessions-header">
        <h2>Canvas boards</h2>
      </header>
      {error && <p className="wf-connect-error">{error}</p>}
      <div className="wf-sessions-grid">
        {boards.map((b) => (
          <BoardCard key={b.id} board={b} onOpen={() => void openBoard(b.id)} />
        ))}
        {!creating ? (
          <button className="wf-session-card wf-session-new" onClick={() => setCreating(true)}>
            + New board
          </button>
        ) : (
          <form
            className="wf-session-card"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              setError(null);
              canvasApi
                .createBoard(groupId, name.trim())
                .then((b) => {
                  setName("");
                  setCreating(false);
                  void loadBoards(groupId);
                  void useCanvas.getState().openBoard(b.id);
                })
                .catch((err) => setError(isCmdError(err) ? err.message : String(err)));
            }}
          >
            <input
              placeholder="board name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onBlur={() => !name.trim() && setCreating(false)}
            />
            <button className="wf-primary" type="submit" disabled={!name.trim()}>
              Create
            </button>
          </form>
        )}
      </div>
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
