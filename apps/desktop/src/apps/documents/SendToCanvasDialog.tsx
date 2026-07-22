import type { Editor } from "@tiptap/react";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import * as Y from "yjs";

import type { CanvasBoard } from "../../bindings/proto/CanvasBoard";
import { isCmdError } from "../../lib/backend";
import { Modal } from "../../platform";
import { canvasApi } from "../canvas/api";
import { useChat } from "../chat/store";
import { b64encode } from "./collab";
import { useDocuments } from "./store";

/**
 * Place a reference to this document (whole, or the selected blocks) on one
 * of a group's canvas boards. Selection anchors are block-level Yjs relative
 * positions, so they track the blocks through concurrent edits.
 */
export function SendToCanvasDialog({
  editor,
  onClose,
}: {
  editor: Editor | null;
  onClose: () => void;
}) {
  const docId = useDocuments((s) => s.activeDocId);
  const groups = useChat((s) => s.groups);
  const [groupId, setGroupId] = useState<number | null>(
    useChat.getState().activeGroupId ?? groups[0]?.id ?? null,
  );
  const [boards, setBoards] = useState<CanvasBoard[]>([]);
  const [boardId, setBoardId] = useState<number | null>(null);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const hasSelection = editor ? !editor.state.selection.empty : false;

  useEffect(() => {
    if (groupId === null) return;
    setBoards([]);
    setBoardId(null);
    void canvasApi
      .boards(groupId)
      .then((b) => {
        setBoards(b);
        setBoardId(b[0]?.id ?? null);
      })
      .catch((e) => setError(isCmdError(e) ? e.message : String(e)));
  }, [groupId]);

  if (docId === null) return null;

  const send = async () => {
    if (boardId === null) return;
    let anchor_b64: string | undefined;
    let head_b64: string | undefined;
    if (selectionOnly && editor && hasSelection) {
      const ystate = ySyncPluginKey.getState(editor.state);
      if (ystate?.type) {
        const { $from, $to } = editor.state.selection;
        const start = $from.index(0);
        const end = $to.index(0) + 1;
        anchor_b64 = b64encode(
          Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ystate.type, start)),
        );
        head_b64 = b64encode(
          Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ystate.type, end)),
        );
      }
    }
    const payload = JSON.stringify({
      document_id: docId,
      mode: anchor_b64 ? "selection" : "doc",
      anchor_b64,
      head_b64,
    });
    try {
      await canvasApi.createElement(boardId, {
        kind: "document",
        x: 120,
        y: 120,
        w: 420,
        h: 320,
        text: payload,
        color: "",
        style: "",
        from_id: null,
        to_id: null,
      });
      setDone(true);
      setTimeout(onClose, 900);
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    }
  };

  return (
    <Modal onClose={onClose}>
      <header className="wf-doc-panel-header">
        <h3>Send to canvas</h3>
        <span className="wf-statusbar-spacer" />
        <button className="wf-icon" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      {error && (
        <p className="wf-connect-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      <p className="wf-doc-share-note">
        Members of the board's group need the document shared with them to see its content.
      </p>
      <div className="wf-doc-panel-row">
        <select
          value={groupId ?? ""}
          onChange={(e) => setGroupId(Number(e.target.value))}
        >
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <select
          value={boardId ?? ""}
          onChange={(e) => setBoardId(Number(e.target.value))}
          disabled={boards.length === 0}
        >
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
          {boards.length === 0 && <option value="">No boards in this group</option>}
        </select>
      </div>
      <label className="wf-doc-share-note">
        <input
          type="checkbox"
          checked={selectionOnly && hasSelection}
          disabled={!hasSelection}
          onChange={(e) => setSelectionOnly(e.target.checked)}
        />{" "}
        Only the selected text {!hasSelection && "(select text first)"}
      </label>
      <div className="wf-doc-panel-row">
        <span className="wf-statusbar-spacer" />
        <button className="wf-primary" disabled={boardId === null || done} onClick={() => void send()}>
          {done ? "Added to board ✓" : "Add to board"}
        </button>
      </div>
    </Modal>
  );
}
