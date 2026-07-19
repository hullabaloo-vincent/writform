import { create } from "zustand";

import type { CanvasBoard } from "../../bindings/proto/CanvasBoard";
import type { CanvasElement } from "../../bindings/proto/CanvasElement";
import { backend } from "../../lib/backend";
import { canvasApi } from "./api";

interface CanvasState {
  /** Boards per group id. */
  byGroup: Record<number, CanvasBoard[]>;
  activeBoardId: number | null;
  board: CanvasBoard | null;
  /** Elements of the active board, by element id. */
  elements: Record<number, CanvasElement>;
  /** Element ids being dragged/edited locally — remote echoes are ignored. */
  localHold: Set<number>;

  loadBoards: (groupId: number) => Promise<void>;
  openBoard: (boardId: number) => Promise<void>;
  closeBoard: () => void;
  applyElement: (el: CanvasElement) => void;
  removeElement: (elementId: number) => void;
  hold: (elementId: number, held: boolean) => void;
}

export const useCanvas = create<CanvasState>((set, get) => ({
  byGroup: {},
  activeBoardId: null,
  board: null,
  elements: {},
  localHold: new Set(),

  loadBoards: async (groupId) => {
    const boards = await canvasApi.boards(groupId);
    set((s) => ({ byGroup: { ...s.byGroup, [groupId]: boards } }));
  },

  openBoard: async (boardId) => {
    set({ activeBoardId: boardId, board: null, elements: {} });
    await backend.wsSub([`canvas:${boardId}`]);
    const detail = await canvasApi.detail(boardId);
    const elements: Record<number, CanvasElement> = {};
    for (const el of detail.elements) elements[el.id] = el;
    set({ board: detail.board, elements });
  },

  closeBoard: () => {
    const { activeBoardId } = get();
    if (activeBoardId !== null) void backend.wsUnsub([`canvas:${activeBoardId}`]);
    set({ activeBoardId: null, board: null, elements: {}, localHold: new Set() });
  },

  applyElement: (el) => {
    set((s) => {
      if (el.board_id !== s.activeBoardId) return s;
      if (s.localHold.has(el.id)) return s; // mid-drag: local wins until release
      const existing = s.elements[el.id];
      if (existing && existing.updated_at > el.updated_at) return s; // stale
      return { elements: { ...s.elements, [el.id]: el } };
    });
  },

  removeElement: (elementId) => {
    set((s) => {
      if (!(elementId in s.elements)) return s;
      const elements = { ...s.elements };
      delete elements[elementId];
      // Connectors attached to a deleted element die with it (server cascades).
      for (const el of Object.values(elements)) {
        if (el.from_id === elementId || el.to_id === elementId) delete elements[el.id];
      }
      return { elements };
    });
  },

  hold: (elementId, held) => {
    set((s) => {
      const localHold = new Set(s.localHold);
      if (held) localHold.add(elementId);
      else localHold.delete(elementId);
      return { localHold };
    });
  },
}));

/** Apply canvas WS events. Installed once by the canvas app. */
export function installCanvasWsHandler(): () => void {
  return backend.onWsEvent((event) => {
    if (event.ev !== "event") return;
    const { kind, data } = event;
    const state = useCanvas.getState();

    if (kind === "canvas.element.created" || kind === "canvas.element.updated") {
      state.applyElement(data as CanvasElement);
    } else if (kind === "canvas.element.deleted") {
      const { board_id, element_id } = data as { board_id: number; element_id: number };
      if (board_id === state.activeBoardId) state.removeElement(element_id);
    } else if (kind === "canvas.board.created") {
      const board = data as CanvasBoard;
      useCanvas.setState((s) => {
        const list = s.byGroup[board.group_id] ?? [];
        if (list.some((b) => b.id === board.id)) return s;
        return { byGroup: { ...s.byGroup, [board.group_id]: [board, ...list] } };
      });
    } else if (kind === "canvas.board.deleted") {
      const { board_id } = data as { board_id: number };
      useCanvas.setState((s) => {
        const byGroup: typeof s.byGroup = {};
        for (const [gid, list] of Object.entries(s.byGroup)) {
          byGroup[Number(gid)] = list.filter((b) => b.id !== board_id);
        }
        return { byGroup };
      });
      if (state.activeBoardId === board_id) state.closeBoard();
    }
  });
}
