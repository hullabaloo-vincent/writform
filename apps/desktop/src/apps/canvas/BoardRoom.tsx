import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ExternalLink,
  Frame as FrameIcon,
  ChevronDown,
  Crop,
  FlipHorizontal,
  FlipVertical,
  Maximize2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Grid3x3,
  Map as MapIcon,
  Italic,
  Link2,
  List,
  MousePointer2,
  Spline,
  StickyNote,
  Trash2,
  Type,
  Underline,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CanvasElement } from "../../bindings/proto/CanvasElement";
import type { LinkPreview } from "../../bindings/proto/LinkPreview";
import { attachmentUrl, isCmdError } from "../../lib/backend";
import { uploadBlob } from "../../lib/upload";
import { confirmDialog } from "../../platform";
import { useSession } from "../../stores/session";
import { useChat } from "../chat/store";
import { CanvasDocCard } from "../documents/CanvasDocCard";
import { canvasApi } from "./api";
import { useCanvas } from "./store";

/** One preview fetch per URL per session; cards share the promise. */
const previewCache = new Map<string, Promise<LinkPreview>>();
function fetchPreview(url: string): Promise<LinkPreview> {
  let p = previewCache.get(url);
  if (!p) {
    p = canvasApi.linkPreview(url);
    previewCache.set(url, p);
  }
  return p;
}

/** Link card: server-fetched title/description/thumbnail, opens externally. */
function LinkCard({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  useEffect(() => {
    let live = true;
    fetchPreview(url)
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [url]);
  let domain = url;
  try {
    domain = new URL(url).host;
  } catch {
    // keep raw url
  }
  return (
    <div className="wf-el-link-card">
      {preview?.image_url && (
        <img className="wf-el-link-thumb" src={preview.image_url} alt="" draggable={false} />
      )}
      <div className="wf-el-link-body">
        <span className="wf-el-link-title">
          <Link2 size={13} /> {preview?.title ?? domain}
        </span>
        {preview?.description && (
          <span className="wf-el-link-desc">{preview.description}</span>
        )}
        <span className="wf-el-link-domain">{domain}</span>
      </div>
      <a
        className="wf-el-link-open"
        href={url}
        target="_blank"
        rel="noreferrer"
        title="Open link"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <ExternalLink size={14} />
      </a>
    </div>
  );
}

const STICKY_COLORS: Record<string, string> = {
  yellow: "#e8d478",
  pink: "#e89ab0",
  blue: "#8ab6e8",
  green: "#93d3a2",
  purple: "#b7a3ea",
};

/** Soft translucent frame fills (Freeform-style); "" = plain frame. */
const FRAME_COLORS: Record<string, { bg: string; border: string }> = {
  orange: { bg: "rgba(232, 147, 60, 0.28)", border: "rgba(232, 147, 60, 0.75)" },
  purple: { bg: "rgba(150, 117, 190, 0.28)", border: "rgba(150, 117, 190, 0.75)" },
  green: { bg: "rgba(139, 190, 120, 0.28)", border: "rgba(139, 190, 120, 0.75)" },
  yellow: { bg: "rgba(226, 200, 92, 0.28)", border: "rgba(226, 200, 92, 0.75)" },
  pink: { bg: "rgba(224, 140, 178, 0.28)", border: "rgba(224, 140, 178, 0.75)" },
  blue: { bg: "rgba(112, 158, 214, 0.28)", border: "rgba(112, 158, 214, 0.75)" },
};

/** Per-element text styling, stored as JSON in the `style` column. */
interface TextStyle {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  list?: "bullet";
  /** Image transforms — stored here so they need no schema change. */
  rotate?: number;
  flipX?: boolean;
  flipY?: boolean;
  /** How the image fills its box: contain (default) or cover (crop). */
  fit?: "contain" | "cover";
}

function textStyle(raw: string): TextStyle {
  try {
    const parsed = JSON.parse(raw) as TextStyle | null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** CSS transform for an image element's stored rotate/flip. */
function imageTransform(st: TextStyle): string | undefined {
  const parts: string[] = [];
  if (st.rotate) parts.push(`rotate(${st.rotate}deg)`);
  if (st.flipX) parts.push("scaleX(-1)");
  if (st.flipY) parts.push("scaleY(-1)");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

const FONT_SIZES = [12, 14, 16, 20, 24, 32, 40, 48];
const ALIGN_CYCLE: NonNullable<TextStyle["align"]>[] = ["left", "center", "right"];

/**
 * Stacking bands. DOM order is stable (by id) so focus is never lost when
 * someone else's `z` changes; layering comes from these instead. The gaps are
 * far larger than `MAX_ELEMENTS_PER_BOARD`, so per-element `z` can never
 * bleed from one band into the next.
 */
const Z_BAND_FRAME = 0;
const Z_BAND_CONNECTOR = 100_000;
const Z_BAND_BODY = 200_000;
// Peers' pointers sit above every element band so they're never hidden behind
// a note or frame — same stacking context, so a plain CSS z-index would lose
// to the inline band numbers above.
const Z_BAND_CURSOR = 900_000;

/** Grid step for snap-to-grid (world units). */
const GRID = 8;

type Tool = "select" | "sticky" | "text" | "frame" | "connect";

/** Connector styling, stored as JSON in the connector element's `text`. */
type ConnAnchor = "auto" | "top" | "bottom" | "left" | "right";
type ConnCap = "none" | "arrow" | "dot";
interface ConnStyle {
  from_anchor: ConnAnchor;
  to_anchor: ConnAnchor;
  dash: boolean;
  start_cap: ConnCap;
  end_cap: ConnCap;
}

const CONN_DEFAULTS: ConnStyle = {
  from_anchor: "auto",
  to_anchor: "auto",
  dash: false,
  start_cap: "none",
  end_cap: "none",
};

function connStyle(text: string): ConnStyle {
  try {
    const parsed = JSON.parse(text) as Partial<ConnStyle>;
    return { ...CONN_DEFAULTS, ...parsed };
  } catch {
    return { ...CONN_DEFAULTS };
  }
}

/** Endpoint of a connector on an element for the chosen anchor side. */
function anchorPoint(el: CanvasElement, a: ConnAnchor): { x: number; y: number } {
  switch (a) {
    case "top":
      return { x: el.x + el.w / 2, y: el.y };
    case "bottom":
      return { x: el.x + el.w / 2, y: el.y + el.h };
    case "left":
      return { x: el.x, y: el.y + el.h / 2 };
    case "right":
      return { x: el.x + el.w, y: el.y + el.h / 2 };
    default:
      return { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  }
}

/** Where the segment from `el`'s center toward `toward` exits `el`'s rect —
 *  used for "auto" anchors so end decorations aren't hidden under elements. */
function clipToRect(el: CanvasElement, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const tx = dx !== 0 ? el.w / 2 / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? el.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** Cap shapes drawn as ordinary siblings of the connector line. SVG
 *  <marker> refs are deliberately avoided: WKWebView doesn't repaint a
 *  marker-start/end changed in place on an already-painted line, so caps
 *  set during a live session stayed invisible until the board remounted. */
function ConnectorCap({
  kind,
  at,
  angleDeg,
}: {
  kind: ConnCap;
  at: { x: number; y: number };
  angleDeg: number;
}) {
  if (kind === "arrow") {
    return (
      <path
        className="wf-cap"
        d="M0,0 L-14,7 L-14,-7 Z"
        transform={`translate(${at.x}, ${at.y}) rotate(${angleDeg})`}
      />
    );
  }
  if (kind === "dot") {
    return <circle className="wf-cap" cx={at.x} cy={at.y} r={5} />;
  }
  return null;
}

const CAP_CYCLE: ConnCap[] = ["none", "arrow", "dot"];
const CAP_LABEL: Record<ConnCap, string> = { none: "—", arrow: "▶", dot: "●" };

interface Viewport {
  tx: number;
  ty: number;
  scale: number;
}

interface CanvasHistoryAction {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

function createRequest(el: CanvasElement, from_id = el.from_id, to_id = el.to_id) {
  return {
    kind: el.kind, x: el.x, y: el.y, w: el.w, h: el.h, text: el.text,
    color: el.color, style: el.style, from_id, to_id,
  };
}

/** Move the local copy of an element without touching updated_at, so the
 *  server echo (same values, newer stamp) still applies cleanly. */
function patchLocal(id: number, patch: Partial<CanvasElement>) {
  useCanvas.setState((s) => {
    const el = s.elements[id];
    if (!el) return s;
    return { elements: { ...s.elements, [id]: { ...el, ...patch } } };
  });
}

function maxZ(elements: Record<number, CanvasElement>): number {
  let z = 0;
  for (const el of Object.values(elements)) if (el.z > z) z = el.z;
  return z;
}

export function BoardRoom() {
  const board = useCanvas((s) => s.board);
  const elements = useCanvas((s) => s.elements);
  const closeBoard = useCanvas((s) => s.closeBoard);
  const hold = useCanvas((s) => s.hold);
  const cursors = useCanvas((s) => s.cursors);
  const me = useSession((s) => s.session?.user);
  const groups = useChat((s) => s.groups);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ tx: 60, ty: 40, scale: 1 });
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null,
  );
  const [editing, setEditing] = useState<number | null>(null);
  const [connectFrom, setConnectFrom] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState(() => localStorage.getItem("wf-canvas-snap") !== "off");
  const undoStack = useRef<CanvasHistoryAction[]>([]);
  const redoStack = useRef<CanvasHistoryAction[]>([]);
  const liveIds = useRef(new Map<number, number>());
  const historyBusy = useRef(false);
  const [, refreshHistory] = useState(0);

  const viewRef = useRef(view);
  viewRef.current = view;
  // Must live above the `!board` early return: hooks cannot be conditional.
  const lastCursorSent = useRef(0);
  /** Text an edit began with — autosave rewrites `el.text` mid-edit, so this
   *  is what "did anything actually change?" and undo must compare against. */
  const editingOriginal = useRef("");

  // The wheel gesture zooms the board, but React registers `onWheel`
  // passively, so the event also bubbles to `.wf-main` (overflow: auto) and
  // scrolls the app shell — which flashes a scrollbar over the canvas while
  // you work. Claiming it on a non-passive native listener stops that.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const swallow = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", swallow, { passive: false });
    return () => el.removeEventListener("wheel", swallow);
  }, [board?.id]);

  // Peers do not announce leaving, so drop pointers that have gone quiet.
  useEffect(() => {
    const timer = setInterval(() => useCanvas.getState().pruneCursors(), 2000);
    return () => clearInterval(timer);
  }, []);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  /** Quantize a world coordinate to the grid when snapping is on. */
  const snapv = (v: number) => (snapRef.current ? Math.round(v / GRID) * GRID : v);

  const fail = (e: unknown) => setError(isCmdError(e) ? e.message : String(e));

  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    liveIds.current.clear();
    refreshHistory((n) => n + 1);
  }, [board?.id]);

  const resolveId = (logicalId: number) => liveIds.current.get(logicalId) ?? logicalId;
  const pushHistory = (action: CanvasHistoryAction) => {
    if (historyBusy.current) return;
    undoStack.current = [...undoStack.current.slice(-14), action];
    redoStack.current = [];
    refreshHistory((n) => n + 1);
  };
  const undo = async () => {
    if (historyBusy.current) return;
    const action = undoStack.current.pop();
    if (!action) return;
    historyBusy.current = true;
    refreshHistory((n) => n + 1);
    try {
      await action.undo();
      redoStack.current.push(action);
    } catch (e) {
      undoStack.current.push(action);
      fail(e);
    } finally {
      historyBusy.current = false;
      refreshHistory((n) => n + 1);
    }
  };
  const redo = async () => {
    if (historyBusy.current) return;
    const action = redoStack.current.pop();
    if (!action) return;
    historyBusy.current = true;
    refreshHistory((n) => n + 1);
    try {
      await action.redo();
      undoStack.current.push(action);
    } catch (e) {
      redoStack.current.push(action);
      fail(e);
    } finally {
      historyBusy.current = false;
      refreshHistory((n) => n + 1);
    }
  };
  /**
   * Optimistic edit + authoritative confirm.
   *
   * `patchLocal` deliberately leaves `updated_at` alone so the element's own
   * echo still applies. The cost is that the local copy looks OLDER than it
   * is, so any other echo arriving before the server confirms this patch wins
   * the staleness comparison in `applyElement` and silently reverts the edit.
   * With one person on a board there is no other traffic and it never shows;
   * with two it reverts constantly. Holding the element for the duration of
   * the request closes that window, and applying the response makes the local
   * copy authoritative (correct `updated_at`) the moment it lands.
   */
  const commitPatch = async (id: number, patch: Partial<CanvasElement>) => {
    patchLocal(id, patch);
    hold(id, true);
    try {
      const updated = await canvasApi.updateElement(id, patch);
      hold(id, false); // release first: applyElement ignores held elements
      useCanvas.getState().applyElement(updated);
    } catch (e) {
      hold(id, false);
      throw e;
    }
  };
  const applyRemotePatch = async (logicalId: number, patch: Partial<CanvasElement>) => {
    await commitPatch(resolveId(logicalId), patch);
  };
  const recordPatch = (logicalId: number, before: Partial<CanvasElement>, after: Partial<CanvasElement>, label: string) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    pushHistory({
      label,
      undo: () => applyRemotePatch(logicalId, before),
      redo: () => applyRemotePatch(logicalId, after),
    });
  };
  const applyPatchWithHistory = (el: CanvasElement, patch: Partial<CanvasElement>, label: string) => {
    const before: Partial<CanvasElement> = {};
    for (const key of Object.keys(patch) as (keyof CanvasElement)[]) {
      (before as Record<string, unknown>)[key] = el[key];
    }
    void commitPatch(el.id, patch).catch(fail);
    recordPatch(el.id, before, patch, label);
  };
  const recordCreate = (el: CanvasElement, label: string) => {
    const logicalId = el.id;
    liveIds.current.set(logicalId, el.id);
    pushHistory({
      label,
      undo: async () => {
        const id = resolveId(logicalId);
        await canvasApi.deleteElement(id);
        useCanvas.getState().removeElement(id);
      },
      redo: async () => {
        const from = el.from_id === null ? null : resolveId(el.from_id);
        const to = el.to_id === null ? null : resolveId(el.to_id);
        const created = await canvasApi.createElement(el.board_id, createRequest(el, from, to));
        liveIds.current.set(logicalId, created.id);
        useCanvas.getState().applyElement(created);
      },
    });
  };

  const deleteSelected = (ids: Set<number>) => {
    if (ids.size === 0) return;
    const current = useCanvas.getState().elements;
    const logicalIds = new Set(ids);
    for (const el of Object.values(current)) {
      if ((el.from_id !== null && ids.has(el.from_id)) || (el.to_id !== null && ids.has(el.to_id))) logicalIds.add(el.id);
    }
    const snapshots = [...logicalIds].map((id) => current[id]).filter(Boolean);
    for (const el of snapshots) liveIds.current.set(el.id, el.id);
    const remove = async () => {
      const bodyIds = snapshots.filter((el) => el.kind !== "connector").map((el) => resolveId(el.id));
      const connectorIds = snapshots.filter((el) => el.kind === "connector").map((el) => resolveId(el.id));
      for (const id of [...connectorIds, ...bodyIds]) {
        await canvasApi.deleteElement(id).catch(() => {});
        useCanvas.getState().removeElement(id);
      }
    };
    const restore = async () => {
      for (const el of snapshots.filter((item) => item.kind !== "connector")) {
        const created = await canvasApi.createElement(el.board_id, createRequest(el));
        liveIds.current.set(el.id, created.id);
        useCanvas.getState().applyElement(created);
      }
      for (const el of snapshots.filter((item) => item.kind === "connector")) {
        const created = await canvasApi.createElement(el.board_id, createRequest(el, el.from_id === null ? null : resolveId(el.from_id), el.to_id === null ? null : resolveId(el.to_id)));
        liveIds.current.set(el.id, created.id);
        useCanvas.getState().applyElement(created);
      }
    };
    void remove().catch(fail);
    pushHistory({ label: snapshots.length === 1 ? "Delete element" : `Delete ${snapshots.length} elements`, undo: restore, redo: remove });
    setSelected(new Set());
  };

  // Keyboard history and deletion (unless typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "textarea" || tag === "input") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void redo(); else void undo();
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selected.size > 0) deleteSelected(selected);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  // Paste onto the board: images become image elements, URLs become link
  // cards, other text becomes a sticky — placed at the viewport center.
  useEffect(() => {
    const centerWorld = () => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      const v = viewRef.current;
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (rect.width / 2 - v.tx) / v.scale,
        y: (rect.height / 2 - v.ty) / v.scale,
      };
    };
    const create = (
      kind: string,
      text: string,
      w: number,
      h: number,
      color = "",
    ) => {
      const boardId = useCanvas.getState().board?.id;
      if (boardId === undefined) return;
      const { x, y } = centerWorld();
      canvasApi
        .createElement(boardId, {
          kind,
          x: snapv(x - w / 2),
          y: snapv(y - h / 2),
          w,
          h,
          text,
          color,
          style: "",
          from_id: null,
          to_id: null,
        })
        .then((el) => {
          useCanvas.getState().applyElement(el);
          setSelected(new Set([el.id]));
          recordCreate(el, `Add ${kind}`);
        })
        .catch(fail);
    };
    const onPaste = (e: ClipboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "textarea" || tag === "input") return; // typing somewhere
      const item = [...(e.clipboardData?.items ?? [])].find((i) =>
        i.type.startsWith("image/"),
      );
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        void uploadBlob(file, "pasted.png")
          .then((meta) => {
            // Natural aspect ratio, capped at 480px on the long edge.
            const img = new window.Image();
            img.onload = () => {
              const scale = Math.min(1, 480 / Math.max(img.width, img.height));
              create(
                "image",
                String(meta.id),
                Math.max(60, Math.round(img.width * scale)),
                Math.max(60, Math.round(img.height * scale)),
              );
            };
            img.onerror = () => create("image", String(meta.id), 320, 240);
            img.src = URL.createObjectURL(file);
          })
          .catch(fail);
        return;
      }
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (!text) return;
      e.preventDefault();
      if (/^https?:\/\/\S+$/.test(text)) create("link", text, 280, 96);
      else create("sticky", text.slice(0, 4000), 180, 140, "yellow");
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!board) return <div className="wf-sessions-empty">Loading…</div>;
  const group = groups.find((g) => g.id === board.group_id);
  const canDelete = me && (board.creator.id === me.id || group?.my_role === "admin");

  // Broadcast our pointer to peers, throttled. Fire-and-forget: a dropped
  // frame is corrected by the next move, so failures are ignored.
  const broadcastCursor = (clientX: number, clientY: number) => {
    const boardId = useCanvas.getState().board?.id;
    if (boardId === undefined) return;
    const now = Date.now();
    if (now - lastCursorSent.current < 50) return; // ~20/s
    lastCursorSent.current = now;
    const { x, y } = toWorld(clientX, clientY);
    void canvasApi.cursor(boardId, x, y).catch(() => {});
  };

  /** Centre the viewport on a world point (used by the minimap). */
  const jumpTo = (worldX: number, worldY: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    setView((v) => ({
      ...v,
      tx: rect.width / 2 - worldX * v.scale,
      ty: rect.height / 2 - worldY * v.scale,
    }));
  };

  const toWorld = (clientX: number, clientY: number) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - rect.left - v.tx) / v.scale,
      y: (clientY - rect.top - v.ty) / v.scale,
    };
  };

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    setView((v) => {
      const scale = Math.min(2.5, Math.max(0.2, v.scale * factor));
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const wx = (px - v.tx) / v.scale;
      const wy = (py - v.ty) / v.scale;
      return { scale, tx: px - wx * scale, ty: py - wy * scale };
    });
  };

  const placeElement = (kind: "sticky" | "text" | "frame", x: number, y: number) => {
    const defaults =
      kind === "sticky"
        ? { w: 180, h: 140, text: "", color: "yellow" }
        : kind === "text"
          ? { w: 240, h: 48, text: "", color: "" }
          : { w: 520, h: 360, text: "Frame", color: "" };
    canvasApi
      .createElement(board.id, {
        kind,
        x: snapv(x - defaults.w / 2),
        y: snapv(y - defaults.h / 2),
        w: defaults.w,
        h: defaults.h,
        text: defaults.text,
        color: defaults.color,
        style: "",
        from_id: null,
        to_id: null,
      })
      .then((el) => {
        useCanvas.getState().applyElement(el);
        setSelected(new Set([el.id]));
        if (kind !== "frame") beginEditing(el);
        recordCreate(el, `Add ${kind}`);
      })
      .catch(fail);
    setTool("select");
  };

  const onSurfaceDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (tool === "sticky" || tool === "text" || tool === "frame") {
      const { x, y } = toWorld(e.clientX, e.clientY);
      placeElement(tool, x, y);
      return;
    }
    e.preventDefault();
    if (e.shiftKey) {
      // Marquee select.
      const start = toWorld(e.clientX, e.clientY);
      const rect = { x1: start.x, y1: start.y, x2: start.x, y2: start.y };
      setMarquee(rect);
      const onMove = (ev: PointerEvent) => {
        const now = toWorld(ev.clientX, ev.clientY);
        rect.x2 = now.x;
        rect.y2 = now.y;
        setMarquee({ ...rect });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setMarquee(null);
        const [lx, hx] = [Math.min(rect.x1, rect.x2), Math.max(rect.x1, rect.x2)];
        const [ly, hy] = [Math.min(rect.y1, rect.y2), Math.max(rect.y1, rect.y2)];
        const hit = new Set<number>();
        for (const el of Object.values(useCanvas.getState().elements)) {
          if (el.kind === "connector") continue;
          if (el.x < hx && el.x + el.w > lx && el.y < hy && el.y + el.h > ly) hit.add(el.id);
        }
        setSelected(hit);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }
    // Pan.
    // A click that closes an open text editor only leaves edit mode — the
    // element stays selected so it can be dragged straight away. Clicking
    // blank canvas again then deselects, so one gesture changes one thing.
    if (editing === null) setSelected(new Set());
    setEditing(null);
    setConnectFrom(null);
    const start = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      setView((v) => ({ ...v, tx: start.tx + ev.clientX - start.x, ty: start.ty + ev.clientY - start.y }));
    };
    const onUp = () => {
      target.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onElementDown = (e: React.PointerEvent, el: CanvasElement) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (tool === "connect") {
      if (connectFrom === null) {
        setConnectFrom(el.id);
      } else if (connectFrom !== el.id) {
        canvasApi
          .createElement(board.id, {
            kind: "connector",
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            text: "",
            color: "",
            style: "",
            from_id: connectFrom,
            to_id: el.id,
          })
          .then((c) => {
            useCanvas.getState().applyElement(c);
            recordCreate(c, "Add connector");
          })
          .catch(fail);
        setConnectFrom(null);
        setTool("select");
      }
      return;
    }
    e.preventDefault(); // stops native image drag + text selection
    // Shift-click toggles membership without dragging.
    if (e.shiftKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(el.id)) next.delete(el.id);
        else next.add(el.id);
        return next;
      });
      return;
    }
    // Click on an unselected element selects just it; a selected one keeps
    // the group so the whole selection drags together.
    const dragSet = new Set(selected.has(el.id) ? selected : [el.id]);
    if (!selected.has(el.id)) setSelected(new Set([el.id]));
    if (editing !== null && editing !== el.id) setEditing(null);

    const all = useCanvas.getState().elements;
    // A frame carries everything whose center sits inside it.
    for (const id of [...dragSet]) {
      const f = all[id];
      if (!f || f.kind !== "frame") continue;
      for (const other of Object.values(all)) {
        if (other.id === f.id || other.kind === "connector") continue;
        const cx = other.x + other.w / 2;
        const cy = other.y + other.h / 2;
        if (cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h) {
          dragSet.add(other.id);
        }
      }
    }

    // Bring the grabbed element to front once per grab.
    const top = maxZ(all);
    if (el.z < top) {
      patchLocal(el.id, { z: top + 1 });
      canvasApi.updateElement(el.id, { z: top + 1 }).catch(() => {});
    }

    // Drag to move, throttled sync while moving, final patch on release.
    const origins = new Map<number, { x: number; y: number }>();
    for (const id of dragSet) {
      const item = all[id];
      if (!item) continue;
      origins.set(id, { x: item.x, y: item.y });
      hold(id, true);
    }
    const startWorld = toWorld(e.clientX, e.clientY);
    const last = new Map<number, { x: number; y: number }>(origins);
    let lastSent = 0;
    const onMove = (ev: PointerEvent) => {
      const now = toWorld(ev.clientX, ev.clientY);
      const dx = now.x - startWorld.x;
      const dy = now.y - startWorld.y;
      const t = Date.now();
      const send = t - lastSent > 120;
      if (send) lastSent = t;
      for (const [id, origin] of origins) {
        const pos = { x: snapv(origin.x + dx), y: snapv(origin.y + dy) };
        last.set(id, pos);
        patchLocal(id, pos);
        if (send) canvasApi.updateElement(id, pos).catch(() => {});
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      for (const [id, pos] of last) {
        const origin = origins.get(id);
        // The element stays held until the server confirms this final
        // position, then the response makes the local copy authoritative —
        // otherwise a concurrent echo can snap it back to where it was.
        canvasApi
          .updateElement(id, pos)
          .then((updated) => {
            hold(id, false);
            useCanvas.getState().applyElement(updated);
          })
          .catch((e) => {
            hold(id, false);
            fail(e);
          });
        if (origin) recordPatch(id, origin, pos, dragSet.size > 1 ? "Move selection" : "Move element");
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onResizeDown = (e: React.PointerEvent, el: CanvasElement) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    hold(el.id, true);
    const startWorld = toWorld(e.clientX, e.clientY);
    const origin = { w: el.w, h: el.h };
    let last = { w: el.w, h: el.h };
    let lastSent = 0;
    const onMove = (ev: PointerEvent) => {
      const now = toWorld(ev.clientX, ev.clientY);
      last = {
        w: Math.max(60, snapv(origin.w + now.x - startWorld.x)),
        h: Math.max(36, snapv(origin.h + now.y - startWorld.y)),
      };
      patchLocal(el.id, last);
      const t = Date.now();
      if (t - lastSent > 120) {
        lastSent = t;
        canvasApi.updateElement(el.id, last).catch(() => {});
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvasApi
        .updateElement(el.id, last)
        .then((updated) => {
          hold(el.id, false);
          useCanvas.getState().applyElement(updated);
        })
        .catch((e) => {
          hold(el.id, false);
          fail(e);
        });
      recordPatch(el.id, origin, last, "Resize element");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** Snap the element box back to the image's natural aspect ratio, keeping
   *  the current width. Rotation is applied to the content, not the box, so
   *  a quarter-turn swaps the ratio. */
  const fitImageToContent = (el: CanvasElement) => {
    const img = new window.Image();
    img.onload = () => {
      if (!img.width || !img.height) return;
      const quarterTurned = Math.abs(((textStyle(el.style).rotate ?? 0) / 90) % 2) === 1;
      const ratio = quarterTurned ? img.width / img.height : img.height / img.width;
      const h = Math.max(60, Math.round(el.w * ratio));
      applyPatchWithHistory(el, { h }, "Fit image");
    };
    img.src = attachmentUrl(Number(el.text));
  };

  const beginEditing = (el: CanvasElement) => {
    editingOriginal.current = el.text;
    setEditing(el.id);
  };

  /** Persist while typing so an interrupted edit can never lose work. No
   *  history entry — the whole edit becomes one undo step on commit. */
  const autosaveText = (el: CanvasElement, text: string) => {
    if (text === el.text) return;
    void commitPatch(el.id, { text }).catch(() => {});
  };

  const commitText = (el: CanvasElement, text: string) => {
    setEditing(null);
    const original = editingOriginal.current;
    if (text === original) return;
    void commitPatch(el.id, { text }).catch(fail);
    recordPatch(el.id, { text: original }, { text }, "Edit text");
  };

  const all = Object.values(elements);
  // Render order is by id — deliberately NOT by `z`. Stacking is expressed
  // with z-index instead (see Z_BAND_*), because sorting the DOM by `z` made
  // React *move* nodes whenever anyone's `z` changed, and every click
  // rewrites `z` and broadcasts it. Moving a node blurs whatever is focused
  // inside it, so another person clicking anything killed your open text
  // editor mid-edit and silently dropped what you typed.
  const byId = (a: CanvasElement, b: CanvasElement) => a.id - b.id;
  const frames = all.filter((el) => el.kind === "frame").sort(byId);
  const bodies = all
    .filter((el) => ["sticky", "text", "image", "link", "document"].includes(el.kind))
    .sort(byId);
  const connectors = all.filter((el) => el.kind === "connector");
    // Single-selection element (color swatches, connector styling, resize).
  /**
   * Where to float the contextual toolbar: centred over the selection's top
   * edge, in SCREEN space (the stage is transformed, so world coords are
   * converted through the current viewport). Flips below when it would sit
   * off the top of the board.
   */
  const selectionBox = (() => {
    if (selected.size === 0) return null;
    const picked = [...selected].map((id) => elements[id]).filter(Boolean);
    if (picked.length === 0) return null;
    // Connectors have no meaningful box; anchor to their endpoints instead.
    const boxes = picked.map((el) => {
      if (el.kind !== "connector") return el;
      const from = el.from_id !== null ? elements[el.from_id] : undefined;
      const to = el.to_id !== null ? elements[el.to_id] : undefined;
      if (!from || !to) return el;
      const x = Math.min(from.x, to.x);
      const y = Math.min(from.y, to.y);
      return {
        x,
        y,
        w: Math.max(from.x + from.w, to.x + to.w) - x,
        h: Math.max(from.y + from.h, to.y + to.h) - y,
      };
    });
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const centreX = (minX + maxX) / 2;
    const screenX = centreX * view.scale + view.tx;
    const screenY = minY * view.scale + view.ty;
    const GAP = 12;
    const below = screenY < 64; // not enough headroom above the selection
    return {
      left: screenX,
      top: below ? screenY + (Math.max(...boxes.map((b) => b.y + b.h)) - minY) * view.scale + GAP : screenY - GAP,
      below,
    };
  })();

  const soleId = selected.size === 1 ? [...selected][0] : null;
  const selectedEl = soleId !== null ? elements[soleId] : undefined;

  return (
    <div className="wf-board-wrap">
      <header className="wf-session-room-header wf-board-header">
        <button onClick={closeBoard}>←</button>
        <h2>{board.name}</h2>
        <span className="wf-session-meta">
          {group?.name} · by {board.creator.display_name ?? board.creator.username}
        </span>
        <span className="wf-statusbar-spacer" />
        {canDelete && (
          <button
            className="wf-danger"
            onClick={() =>
              void confirmDialog("Delete this board for everyone? This cannot be undone.", {
                title: "Delete board",
                confirmLabel: "Delete board",
                danger: true,
              }).then((ok) => {
                if (!ok) return;
                canvasApi.deleteBoard(board.id).then(closeBoard).catch(fail);
              })
            }
          >
            Delete board
          </button>
        )}
      </header>
      {error && (
        <p className="wf-connect-error wf-board-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      <div
        ref={surfaceRef}
        className={`wf-board wf-board-tool-${tool}`}
        onPointerDown={onSurfaceDown}
        onPointerMove={(e) => broadcastCursor(e.clientX, e.clientY)}
        onWheel={(e) => zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.08 : 1 / 1.08)}
      >
        <div
          className="wf-board-stage"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
        >
          {frames.map((el) => (
            <div
              key={el.id}
              className={`wf-el wf-el-frame ${selected.has(el.id) ? "selected" : ""} ${connectFrom === el.id ? "connect-from" : ""}`}
              style={{
                left: el.x,
                top: el.y,
                width: el.w,
                height: el.h,
                zIndex: Z_BAND_FRAME + el.z,
                background: FRAME_COLORS[el.color]?.bg,
                borderColor: FRAME_COLORS[el.color]?.border,
              }}
              onPointerDown={(e) => onElementDown(e, el)}
              onDoubleClick={() => beginEditing(el)}
            >
              <ElementText
                el={el}
                editing={editing === el.id}
                onCommit={(text) => commitText(el, text)}
                onDraft={(text) => autosaveText(el, text)}
                className="wf-el-frame-label"
              />
              {selected.has(el.id) && selected.size === 1 && (
                <span className="wf-el-resize" onPointerDown={(e) => onResizeDown(e, el)} />
              )}
            </div>
          ))}

          <svg className="wf-board-links" style={{ zIndex: Z_BAND_CONNECTOR }}>
            {connectors.map((c) => {
              const from = c.from_id !== null ? elements[c.from_id] : undefined;
              const to = c.to_id !== null ? elements[c.to_id] : undefined;
              if (!from || !to) return null;
              const cs = connStyle(c.text);
              const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
              const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
              // Auto anchors attach at the element edge (center-to-center
              // endpoints would bury the arrowheads under the elements).
              const p1 =
                cs.from_anchor === "auto"
                  ? clipToRect(from, toCenter)
                  : anchorPoint(from, cs.from_anchor);
              const p2 =
                cs.to_anchor === "auto"
                  ? clipToRect(to, fromCenter)
                  : anchorPoint(to, cs.to_anchor);
              const angleDeg = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
              const capped = Math.hypot(p2.x - p1.x, p2.y - p1.y) >= 1;
              return (
                <g key={c.id}>
                  <line
                    className="wf-link-hit"
                    x1={p1.x}
                    y1={p1.y}
                    x2={p2.x}
                    y2={p2.y}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelected(new Set([c.id]));
                    }}
                  />
                  <line
                    className={`wf-link ${selected.has(c.id) ? "selected" : ""}`}
                    x1={p1.x}
                    y1={p1.y}
                    x2={p2.x}
                    y2={p2.y}
                    strokeDasharray={cs.dash ? "7 5" : undefined}
                  />
                  {capped && (
                    <ConnectorCap kind={cs.start_cap} at={p1} angleDeg={angleDeg + 180} />
                  )}
                  {capped && <ConnectorCap kind={cs.end_cap} at={p2} angleDeg={angleDeg} />}
                </g>
              );
            })}
          </svg>

          {bodies.map((el) => (
            <div
              key={el.id}
              className={`wf-el wf-el-${el.kind} ${selected.has(el.id) ? "selected" : ""} ${connectFrom === el.id ? "connect-from" : ""}`}
              style={{
                left: el.x,
                top: el.y,
                width: el.w,
                height: el.h,
                zIndex: Z_BAND_BODY + el.z,
                background: el.kind === "sticky" ? (STICKY_COLORS[el.color] ?? STICKY_COLORS.yellow) : undefined,
              }}
              onPointerDown={(e) => onElementDown(e, el)}
              onDoubleClick={() =>
                el.kind !== "image" &&
                el.kind !== "link" &&
                el.kind !== "document" &&
                beginEditing(el)
              }
            >
              {el.kind === "image" ? (
                <img
                  className="wf-el-img"
                  src={attachmentUrl(Number(el.text))}
                  alt=""
                  draggable={false}
                  style={{
                    transform: imageTransform(textStyle(el.style)),
                    objectFit: textStyle(el.style).fit ?? "contain",
                  }}
                />
              ) : el.kind === "link" ? (
                <LinkCard url={el.text} />
              ) : el.kind === "document" ? (
                <CanvasDocCard payload={el.text} />
              ) : (
                <ElementText
                  el={el}
                  editing={editing === el.id}
                  onCommit={(text) => commitText(el, text)}
                  onDraft={(text) => autosaveText(el, text)}
                  className={el.kind === "sticky" ? "wf-el-sticky-text" : "wf-el-text-text"}
                />
              )}
              {selected.has(el.id) && selected.size === 1 && (
                <span className="wf-el-resize" onPointerDown={(e) => onResizeDown(e, el)} />
              )}
            </div>
          ))}

          {marquee && (
            <div
              className="wf-marquee"
              style={{
                left: Math.min(marquee.x1, marquee.x2),
                top: Math.min(marquee.y1, marquee.y2),
                width: Math.abs(marquee.x2 - marquee.x1),
                height: Math.abs(marquee.y2 - marquee.y1),
              }}
            />
          )}

          {/* Peers' pointers live in world space so they track the board as
              you pan and zoom; the counter-scale keeps them a constant size. */}
          {Object.values(cursors).map((c) => (
            <div
              key={c.user.id}
              className="wf-cursor"
              style={{
                left: c.x,
                top: c.y,
                zIndex: Z_BAND_CURSOR,
                transform: `scale(${1 / view.scale})`,
                color: c.user.accent_color ?? cursorColor(c.user.username),
              }}
            >
              <MousePointer2 size={16} className="wf-cursor-arrow" />
              {/* Background is set here rather than via `currentColor` in CSS:
                  the label also sets its own text colour, which would make
                  `currentColor` resolve to that instead of the cursor's. */}
              <span
                className="wf-cursor-label"
                style={{
                  background: c.user.accent_color ?? cursorColor(c.user.username),
                  color: contrastText(c.user.accent_color ?? cursorColor(c.user.username)),
                }}
              >
                {c.user.display_name ?? c.user.username}
              </span>
            </div>
          ))}
        </div>

        {selectionBox && (
          <div
            className={`wf-selection-toolbar ${selectionBox.below ? "below" : ""}`}
            style={{ left: selectionBox.left, top: selectionBox.top }}
            // Keep the board from panning, and keep focus where it is so
            // formatting an element mid-edit doesn't close its text editor.
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.preventDefault()}
          >
            {selectedEl && selectedEl.kind === "connector" && (
              <ConnectorControls
                connector={selectedEl}
                onChange={(cs) => {
                  const text = JSON.stringify(cs);
                  applyPatchWithHistory(selectedEl, { text }, "Style connector");
                }}
              />
            )}
            {selectedEl && selectedEl.kind === "sticky" && (
              <>
                {Object.entries(STICKY_COLORS).map(([key, css]) => (
                  <button
                    key={key}
                    className={`wf-board-swatch ${selectedEl.color === key ? "active" : ""}`}
                    style={{ background: css }}
                    title={key}
                    onClick={() => {
                      applyPatchWithHistory(selectedEl, { color: key }, "Change sticky color");
                    }}
                  />
                ))}
              </>
            )}
            {selectedEl && selectedEl.kind === "image" && (
              <ImageControls
                element={selectedEl}
                onChange={(st) =>
                  applyPatchWithHistory(selectedEl, { style: JSON.stringify(st) }, "Transform image")
                }
                onFitBox={() => fitImageToContent(selectedEl)}
              />
            )}
            {selectedEl && selectedEl.kind === "frame" && (
              <>
                <button
                  className={`wf-board-swatch wf-board-swatch-none ${selectedEl.color === "" ? "active" : ""}`}
                  title="No fill"
                  onClick={() => {
                    applyPatchWithHistory(selectedEl, { color: "" }, "Change frame fill");
                  }}
                />
                {Object.entries(FRAME_COLORS).map(([key, css]) => (
                  <button
                    key={key}
                    className={`wf-board-swatch ${selectedEl.color === key ? "active" : ""}`}
                    style={{ background: css.border }}
                    title={key}
                    onClick={() => {
                      applyPatchWithHistory(selectedEl, { color: key }, "Change frame fill");
                    }}
                  />
                ))}
              </>
            )}
            {selectedEl && (selectedEl.kind === "sticky" || selectedEl.kind === "text") && (
              <TextStyleControls
                element={selectedEl}
                onChange={(st) => {
                  const style = JSON.stringify(st);
                  applyPatchWithHistory(selectedEl, { style }, "Format text");
                }}
              />
            )}
            {selected.size > 0 && (
              <>
                {selectedEl && <span className="wf-board-toolbar-sep" />}
                <button
                  title="Delete element"
                  onClick={() => deleteSelected(selected)}
                >
                  <Trash2 size={17} />
                </button>
              </>
            )}
          </div>
        )}

        <Minimap elements={elements} view={view} surfaceRef={surfaceRef} onJump={jumpTo} />

        <div className="wf-board-toolbar" onPointerDown={(e) => e.stopPropagation()}>
          <ToolButton tool="select" active={tool} set={setTool} title="Select / pan">
            <MousePointer2 size={17} />
          </ToolButton>
          <ToolButton tool="sticky" active={tool} set={setTool} title="Sticky note (click to place)">
            <StickyNote size={17} />
          </ToolButton>
          <ToolButton tool="text" active={tool} set={setTool} title="Text (click to place)">
            <Type size={17} />
          </ToolButton>
          <ToolButton tool="frame" active={tool} set={setTool} title="Frame (click to place)">
            <FrameIcon size={17} />
          </ToolButton>
          <ToolButton
            tool="connect"
            active={tool}
            set={(t) => {
              setConnectFrom(null);
              setTool(t);
            }}
            title="Connector (click two elements)"
          >
            <Spline size={17} />
          </ToolButton>
          <span className="wf-board-toolbar-sep" />
          <button title={`Undo${undoStack.current.length ? `: ${undoStack.current[undoStack.current.length - 1].label}` : ""}`} disabled={undoStack.current.length === 0 || historyBusy.current} onClick={() => void undo()}>
            <Undo2 size={17} />
          </button>
          <button title={`Redo${redoStack.current.length ? `: ${redoStack.current[redoStack.current.length - 1].label}` : ""}`} disabled={redoStack.current.length === 0 || historyBusy.current} onClick={() => void redo()}>
            <Redo2 size={17} />
          </button>
          <span className="wf-board-history-count" title="Canvas history keeps the last 15 actions">{undoStack.current.length}/15</span>
          <span className="wf-board-toolbar-sep" />
          <button title="Zoom out" onClick={() => zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2)}>
            <ZoomOut size={17} />
          </button>
          <span className="wf-board-zoom">{Math.round(view.scale * 100)}%</span>
          <button title="Zoom in" onClick={() => zoomAt(innerWidth / 2, innerHeight / 2, 1.2)}>
            <ZoomIn size={17} />
          </button>
          <button
            title={snap ? "Snap to grid: on" : "Snap to grid: off"}
            className={snap ? "active" : ""}
            onClick={() => {
              const next = !snap;
              setSnap(next);
              localStorage.setItem("wf-canvas-snap", next ? "on" : "off");
            }}
          >
            <Grid3x3 size={17} />
          </button>
        </div>
        {tool === "connect" && (
          <div className="wf-board-hint">
            {connectFrom === null
              ? "Connector: click the first element"
              : "Now click the element to connect to"}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolButton({
  tool,
  active,
  set,
  title,
  children,
}: {
  tool: Tool;
  active: Tool;
  set: (t: Tool) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button className={active === tool ? "active" : ""} title={title} onClick={() => set(tool)}>
      {children}
    </button>
  );
}

/** CSS derived from an element's TextStyle for both display and editing. */
function textStyleCss(st: TextStyle): React.CSSProperties {
  return {
    fontSize: st.size,
    fontWeight: st.bold ? 700 : undefined,
    fontStyle: st.italic ? "italic" : undefined,
    textDecoration: st.underline ? "underline" : undefined,
    textAlign: st.align,
  };
}

function ElementText({
  el,
  editing,
  onCommit,
  onDraft,
  className,
}: {
  el: CanvasElement;
  editing: boolean;
  onCommit: (text: string) => void;
  /** Called on a pause in typing, so work survives an interrupted edit. */
  onDraft?: (text: string) => void;
  className: string;
}) {
  const [draft, setDraft] = useState(el.text);
  useEffect(() => {
    if (editing) setDraft(el.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Autosave after a short pause; the blur commit still records the undo step.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!editing || !onDraft) return;
    const timer = setTimeout(() => onDraft(draftRef.current), 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editing]);

  // Editing can also end from outside (clicking the canvas closes it), and
  // that path may not fire `blur` — flush whatever was typed since the last
  // autosave tick so nothing is lost.
  useEffect(() => {
    if (!editing || !onDraft) return;
    return () => onDraft(draftRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const st = textStyle(el.style);
  const css = textStyleCss(st);

  if (!editing) {
    if (!el.text) {
      return (
        <div className={className} style={css}>
          <span className="wf-el-placeholder">double-click to write</span>
        </div>
      );
    }
    if (st.list === "bullet") {
      return (
        <ul className={`${className} wf-el-bullets`} style={css}>
          {el.text.split("\n").map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      );
    }
    return (
      <div className={className} style={css}>
        {el.text}
      </div>
    );
  }
  return (
    <textarea
      className={`${className} wf-el-edit`}
      style={css}
      value={draft}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        // Commits rather than reverts — the draft has been autosaving,
        // so discarding here would only roll back the last few seconds.
        if (e.key === "Escape") onCommit(draft);
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onCommit(draft);
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

/** B/I/U, font size, alignment, bullet controls for sticky/text elements. */
function TextStyleControls({
  element,
  onChange,
}: {
  element: CanvasElement;
  onChange: (st: TextStyle) => void;
}) {
  const st = textStyle(element.style);
  const size = st.size ?? 14;
  const align = st.align ?? "left";
  const stepSize = (dir: 1 | -1) => {
    const idx = FONT_SIZES.findIndex((s) => s >= size);
    const at = idx === -1 ? FONT_SIZES.length - 1 : idx;
    const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, at + dir))];
    onChange({ ...st, size: next });
  };
  const AlignIcon = align === "center" ? AlignCenter : align === "right" ? AlignRight : AlignLeft;
  return (
    <>
      <button
        title="Bold"
        className={st.bold ? "active" : ""}
        onClick={() => onChange({ ...st, bold: !st.bold || undefined })}
      >
        <Bold size={15} />
      </button>
      <button
        title="Italic"
        className={st.italic ? "active" : ""}
        onClick={() => onChange({ ...st, italic: !st.italic || undefined })}
      >
        <Italic size={15} />
      </button>
      <button
        title="Underline"
        className={st.underline ? "active" : ""}
        onClick={() => onChange({ ...st, underline: !st.underline || undefined })}
      >
        <Underline size={15} />
      </button>
      <button title="Smaller text" onClick={() => stepSize(-1)}>
        −
      </button>
      <span className="wf-board-fontsize" title="Font size">
        {size}
      </span>
      <button title="Larger text" onClick={() => stepSize(1)}>
        +
      </button>
      <button
        title={`Align: ${align} (click to change)`}
        onClick={() => {
          const next = ALIGN_CYCLE[(ALIGN_CYCLE.indexOf(align) + 1) % ALIGN_CYCLE.length];
          onChange({ ...st, align: next === "left" ? undefined : next });
        }}
      >
        <AlignIcon size={15} />
      </button>
      <button
        title="Bullet list"
        className={st.list === "bullet" ? "active" : ""}
        onClick={() => onChange({ ...st, list: st.list === "bullet" ? undefined : "bullet" })}
      >
        <List size={15} />
      </button>
    </>
  );
}

/** Anchor + line-style controls shown while a connector is selected. */
function ConnectorControls({
  connector,
  onChange,
}: {
  connector: CanvasElement;
  onChange: (cs: ConnStyle) => void;
}) {
  const cs = connStyle(connector.text);
  const anchors: ConnAnchor[] = ["auto", "top", "right", "bottom", "left"];
  const cycleCap = (v: ConnCap) => CAP_CYCLE[(CAP_CYCLE.indexOf(v) + 1) % CAP_CYCLE.length];
  return (
    <>
      <button
        title={`Start decoration: ${cs.start_cap} (click to change)`}
        className="wf-conn-cap"
        onClick={() => onChange({ ...cs, start_cap: cycleCap(cs.start_cap) })}
      >
        {CAP_LABEL[cs.start_cap]}
      </button>
      <select
        title="Start attaches to this side"
        value={cs.from_anchor}
        onChange={(e) => onChange({ ...cs, from_anchor: e.target.value as ConnAnchor })}
      >
        {anchors.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <button
        title={cs.dash ? "Dashed (click for solid)" : "Solid (click for dashed)"}
        className={cs.dash ? "active" : ""}
        onClick={() => onChange({ ...cs, dash: !cs.dash })}
      >
        {cs.dash ? "┅" : "—"}
      </button>
      <select
        title="End attaches to this side"
        value={cs.to_anchor}
        onChange={(e) => onChange({ ...cs, to_anchor: e.target.value as ConnAnchor })}
      >
        {anchors.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <button
        title={`End decoration: ${cs.end_cap} (click to change)`}
        className="wf-conn-cap"
        onClick={() => onChange({ ...cs, end_cap: cycleCap(cs.end_cap) })}
      >
        {CAP_LABEL[cs.end_cap]}
      </button>
    </>
  );
}


/** Stable per-user cursor colour when they have no accent set. */
const CURSOR_COLORS = ["#c96f4a", "#5a9e6f", "#5d8fc9", "#a878c9", "#c9a44a", "#c96f9a", "#4aa8a0"];
function cursorColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CURSOR_COLORS[h % CURSOR_COLORS.length];
}

/**
 * Readable text colour for an arbitrary background. Accent colours are
 * user-chosen and can be pale, so a fixed white label would be unreadable.
 */
function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? "#101014" : "#fff";
}

/** Bounding box of everything on the board, in world coordinates. */
function contentBounds(elements: Record<number, CanvasElement>) {
  const items = Object.values(elements).filter((el) => el.kind !== "connector");
  if (items.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of items) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.w);
    maxY = Math.max(maxY, el.y + el.h);
  }
  return { minX, minY, maxX, maxY };
}

const MINIMAP_W = 180;
const MINIMAP_H = 120;

/**
 * Overview of the board with the current viewport drawn on it. Click or drag
 * to recentre. Hidden on an empty board, where it would show nothing useful.
 */
function Minimap({
  elements,
  view,
  surfaceRef,
  onJump,
}: {
  elements: Record<number, CanvasElement>;
  view: Viewport;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  onJump: (worldX: number, worldY: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("wf-canvas-minimap") === "off",
  );
  const bounds = contentBounds(elements);
  if (!bounds) return null;

  const rect = surfaceRef.current?.getBoundingClientRect();
  // Include the visible viewport in the extent so the indicator stays inside
  // the minimap even when you pan away from the content.
  const viewW = (rect?.width ?? 800) / view.scale;
  const viewH = (rect?.height ?? 600) / view.scale;
  const viewX = -view.tx / view.scale;
  const viewY = -view.ty / view.scale;
  const minX = Math.min(bounds.minX, viewX);
  const minY = Math.min(bounds.minY, viewY);
  const maxX = Math.max(bounds.maxX, viewX + viewW);
  const maxY = Math.max(bounds.maxY, viewY + viewH);
  const pad = 40;
  const worldW = maxX - minX + pad * 2;
  const worldH = maxY - minY + pad * 2;
  const scale = Math.min(MINIMAP_W / worldW, MINIMAP_H / worldH);
  const toMini = (x: number, y: number) => ({
    left: (x - minX + pad) * scale,
    top: (y - minY + pad) * scale,
  });

  const jumpFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const worldX = (e.clientX - box.left) / scale + minX - pad;
    const worldY = (e.clientY - box.top) / scale + minY - pad;
    onJump(worldX, worldY);
  };

  if (collapsed) {
    return (
      <button
        className="wf-minimap-toggle wf-icon"
        title="Show minimap"
        // Without this the board's pan handler takes pointer capture and the
        // click never lands on the button (the expanded minimap stops it on
        // its wrapper for the same reason).
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          setCollapsed(false);
          localStorage.setItem("wf-canvas-minimap", "on");
        }}
      >
        <MapIcon size={15} />
      </button>
    );
  }

  return (
    <div className="wf-minimap" onPointerDown={(e) => e.stopPropagation()}>
      <div
        className="wf-minimap-surface"
        style={{ width: MINIMAP_W, height: MINIMAP_H }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          jumpFromEvent(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) jumpFromEvent(e);
        }}
      >
        {Object.values(elements)
          .filter((el) => el.kind !== "connector")
          .map((el) => {
            const pos = toMini(el.x, el.y);
            return (
              <span
                key={el.id}
                className={`wf-minimap-el ${el.kind === "frame" ? "frame" : ""}`}
                style={{
                  ...pos,
                  width: Math.max(2, el.w * scale),
                  height: Math.max(2, el.h * scale),
                  background:
                    el.kind === "sticky"
                      ? (STICKY_COLORS[el.color] ?? STICKY_COLORS.yellow)
                      : undefined,
                }}
              />
            );
          })}
        <span
          className="wf-minimap-view"
          style={{
            ...toMini(viewX, viewY),
            width: Math.max(6, viewW * scale),
            height: Math.max(6, viewH * scale),
          }}
        />
      </div>
      <button
        className="wf-minimap-hide wf-icon"
        title="Hide minimap"
        onClick={() => {
          setCollapsed(true);
          localStorage.setItem("wf-canvas-minimap", "off");
        }}
      >
        <ChevronDown size={13} />
      </button>
    </div>
  );
}


/** Rotate / flip / fit controls shown while an image element is selected. */
function ImageControls({
  element,
  onChange,
  onFitBox,
}: {
  element: CanvasElement;
  onChange: (st: TextStyle) => void;
  onFitBox: () => void;
}) {
  const st = textStyle(element.style);
  const rotate = st.rotate ?? 0;
  // Keep rotation in [0, 360) so the label stays readable after many turns.
  const turn = (delta: number) => onChange({ ...st, rotate: (((rotate + delta) % 360) + 360) % 360 });
  return (
    <>
      <button className="wf-icon" title="Rotate left" onClick={() => turn(-90)}>
        <RotateCcw size={15} />
      </button>
      <button className="wf-icon" title="Rotate right" onClick={() => turn(90)}>
        <RotateCw size={15} />
      </button>
      <span className="wf-board-fontsize" title="Rotation">
        {rotate}°
      </span>
      <button
        className={`wf-icon ${st.flipX ? "active" : ""}`}
        title="Flip horizontally"
        onClick={() => onChange({ ...st, flipX: !st.flipX || undefined })}
      >
        <FlipHorizontal size={15} />
      </button>
      <button
        className={`wf-icon ${st.flipY ? "active" : ""}`}
        title="Flip vertically"
        onClick={() => onChange({ ...st, flipY: !st.flipY || undefined })}
      >
        <FlipVertical size={15} />
      </button>
      <button
        className={`wf-icon ${st.fit === "cover" ? "active" : ""}`}
        title={st.fit === "cover" ? "Filling the box (click to fit inside)" : "Fitting inside the box (click to fill)"}
        onClick={() => onChange({ ...st, fit: st.fit === "cover" ? undefined : "cover" })}
      >
        <Crop size={15} />
      </button>
      <button className="wf-icon" title="Match the image's aspect ratio" onClick={onFitBox}>
        <Maximize2 size={15} />
      </button>
      {(rotate !== 0 || st.flipX || st.flipY || st.fit) && (
        <button
          className="wf-icon"
          title="Reset transform"
          onClick={() =>
            onChange({ ...st, rotate: undefined, flipX: undefined, flipY: undefined, fit: undefined })
          }
        >
          <RefreshCw size={15} />
        </button>
      )}
    </>
  );
}
