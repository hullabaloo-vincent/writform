import { useEffect, useRef, useState } from "react";

import { Modal } from "../../platform";
import { useChat } from "../chat/store";
import { isCancelled, publishLocalBoard, type ImportProgress } from "./boardFile";
import { useCanvas } from "./store";

/**
 * Publish a copy of a board on this device to a group on the server you're
 * connected to. One way: the board here stays, and what's changed on it
 * later doesn't follow. While it runs, closing the dialog cancels — and the
 * half-made copy is removed.
 */
export function PublishBoardDialog({
  board,
  onClose,
  onOpen,
}: {
  board: { id: number; name: string };
  onClose: () => void;
  /** Open the published copy (the dialog closes itself first). */
  onOpen: (boardId: number) => void;
}) {
  const groups = useChat((s) => s.groups);
  const loadGroups = useChat((s) => s.loadGroups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const [groupId, setGroupId] = useState<number | null>(activeGroupId);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ boardId: number; notice: string | null } | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    if (groups.length === 0) void loadGroups();
  }, [groups.length, loadGroups]);

  const chosen = groups.find((g) => g.id === groupId) ?? groups[0] ?? null;
  const busy = progress !== null;

  const publish = () => {
    if (!chosen || busy) return;
    const control = new AbortController();
    ctrl.current = control;
    setError(null);
    setProgress({ label: "Starting…", done: 0, total: 1 });
    publishLocalBoard(board.id, chosen.id, setProgress, control.signal)
      .then((result) => {
        void useCanvas.getState().loadBoards(chosen.id).catch(() => {});
        setDone(result);
      })
      .catch((e) => {
        if (!isCancelled(e) && !control.signal.aborted) setError((e as { message?: string } | null)?.message ?? String(e));
      })
      .finally(() => setProgress(null));
  };

  const close = () => {
    ctrl.current?.abort();
    onClose();
  };

  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Modal onClose={close} className="wf-import-dialog">
      <h3>Publish “{board.name}” to a server</h3>
      {error && <p className="wf-connect-error">{error}</p>}
      {done ? (
        <>
          <p className="wf-doc-share-note">
            Published ✓ Everyone in {chosen?.name ?? "the group"} can open it now.
            {done.notice ? ` (${done.notice}.)` : ""}
          </p>
          <div className="wf-import-actions">
            <button onClick={onClose}>Done</button>
            <button
              className="wf-primary"
              onClick={() => {
                onClose();
                onOpen(done.boardId);
              }}
            >
              Open the published board
            </button>
          </div>
        </>
      ) : busy ? (
        <>
          <p className="wf-import-label">
            {progress.label}
            {progress.total > 1 ? ` (${Math.min(progress.done + 1, progress.total)} of ${progress.total})` : ""}
          </p>
          <div className="wf-import-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="wf-import-actions">
            <button onClick={close}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p className="wf-doc-share-note">
            Publishes a copy with its pictures to a group on the server you’re connected to. The board on this
            device stays here, and later changes to it do <strong>not</strong> reach the published copy.
          </p>
          {groups.length === 0 ? (
            <p className="wf-doc-share-note">Boards on a server belong to a group. Join or create one in Chat first.</p>
          ) : (
            <label className="wf-settings-field">
              Group
              <select value={chosen?.id ?? ""} onChange={(e) => setGroupId(Number(e.target.value))}>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="wf-import-actions">
            <button onClick={onClose}>Cancel</button>
            <button className="wf-primary" disabled={!chosen} onClick={publish}>
              Publish
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
