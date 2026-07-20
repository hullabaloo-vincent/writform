import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ExternalLink,
  Frame as FrameIcon,
  Grid3x3,
  Italic,
  Link2,
  List,
  MousePointer2,
  Spline,
  StickyNote,
  Trash2,
  Type,
  Underline,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CanvasElement } from "../../bindings/proto/CanvasElement";
import type { LinkPreview } from "../../bindings/proto/LinkPreview";
import { isCmdError } from "../../lib/backend";
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
}

function textStyle(raw: string): TextStyle {
  try {
    const parsed = JSON.parse(raw) as TextStyle | null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const FONT_SIZES = [12, 14, 16, 20, 24, 32, 40, 48];
const ALIGN_CYCLE: NonNullable<TextStyle["align"]>[] = ["left", "center", "right"];

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

const CAP_CYCLE: ConnCap[] = ["none", "arrow", "dot"];
const CAP_LABEL: Record<ConnCap, string> = { none: "—", arrow: "▶", dot: "●" };

interface Viewport {
  tx: number;
  ty: number;
  scale: number;
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

  const viewRef = useRef(view);
  viewRef.current = view;
  const snapRef = useRef(snap);
  snapRef.current = snap;
  /** Quantize a world coordinate to the grid when snapping is on. */
  const snapv = (v: number) => (snapRef.current ? Math.round(v / GRID) * GRID : v);

  const fail = (e: unknown) => setError(isCmdError(e) ? e.message : String(e));

  // Delete key removes the selection (unless typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "textarea" || tag === "input") return;
      if (selected.size > 0) {
        for (const id of selected) {
          canvasApi.deleteElement(id).catch(fail);
          useCanvas.getState().removeElement(id);
        }
        setSelected(new Set());
      }
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
        if (kind !== "frame") setEditing(el.id);
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
    setSelected(new Set());
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
          .then((c) => useCanvas.getState().applyElement(c))
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
        canvasApi
          .updateElement(id, pos)
          .catch(fail)
          .finally(() => hold(id, false));
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
        .catch(fail)
        .finally(() => hold(el.id, false));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const commitText = (el: CanvasElement, text: string) => {
    setEditing(null);
    if (text === el.text) return;
    patchLocal(el.id, { text });
    canvasApi.updateElement(el.id, { text }).catch(fail);
  };

  const all = Object.values(elements);
  const frames = all.filter((el) => el.kind === "frame").sort((a, b) => a.z - b.z);
  const bodies = all
    .filter((el) => ["sticky", "text", "image", "link", "document"].includes(el.kind))
    .sort((a, b) => a.z - b.z);
  const connectors = all.filter((el) => el.kind === "connector");
    // Single-selection element (color swatches, connector styling, resize).
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
                background: FRAME_COLORS[el.color]?.bg,
                borderColor: FRAME_COLORS[el.color]?.border,
              }}
              onPointerDown={(e) => onElementDown(e, el)}
              onDoubleClick={() => setEditing(el.id)}
            >
              <ElementText
                el={el}
                editing={editing === el.id}
                onCommit={(text) => commitText(el, text)}
                className="wf-el-frame-label"
              />
              {selected.has(el.id) && selected.size === 1 && (
                <span className="wf-el-resize" onPointerDown={(e) => onResizeDown(e, el)} />
              )}
            </div>
          ))}

          <svg className="wf-board-links">
            <defs>
              <marker
                id="wf-cap-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" className="wf-cap" />
              </marker>
              <marker id="wf-cap-dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6">
                <circle cx="5" cy="5" r="4" className="wf-cap" />
              </marker>
            </defs>
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
              const cap = (v: ConnCap) =>
                v === "arrow" ? "url(#wf-cap-arrow)" : v === "dot" ? "url(#wf-cap-dot)" : undefined;
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
                    markerStart={cap(cs.start_cap)}
                    markerEnd={cap(cs.end_cap)}
                  />
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
                background: el.kind === "sticky" ? (STICKY_COLORS[el.color] ?? STICKY_COLORS.yellow) : undefined,
              }}
              onPointerDown={(e) => onElementDown(e, el)}
              onDoubleClick={() =>
                el.kind !== "image" &&
                el.kind !== "link" &&
                el.kind !== "document" &&
                setEditing(el.id)
              }
            >
              {el.kind === "image" ? (
                <img
                  className="wf-el-img"
                  src={`writform-att://attachment/${el.text}`}
                  alt=""
                  draggable={false}
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
        </div>

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
          {selectedEl && selectedEl.kind === "connector" && (
            <ConnectorControls
              connector={selectedEl}
              onChange={(cs) => {
                const text = JSON.stringify(cs);
                patchLocal(selectedEl.id, { text });
                canvasApi.updateElement(selectedEl.id, { text }).catch(fail);
              }}
            />
          )}
          {selectedEl && selectedEl.kind === "sticky" && (
            <>
              <span className="wf-board-toolbar-sep" />
              {Object.entries(STICKY_COLORS).map(([key, css]) => (
                <button
                  key={key}
                  className={`wf-board-swatch ${selectedEl.color === key ? "active" : ""}`}
                  style={{ background: css }}
                  title={key}
                  onClick={() => {
                    patchLocal(selectedEl.id, { color: key });
                    canvasApi.updateElement(selectedEl.id, { color: key }).catch(fail);
                  }}
                />
              ))}
            </>
          )}
          {selectedEl && selectedEl.kind === "frame" && (
            <>
              <span className="wf-board-toolbar-sep" />
              <button
                className={`wf-board-swatch wf-board-swatch-none ${selectedEl.color === "" ? "active" : ""}`}
                title="No fill"
                onClick={() => {
                  patchLocal(selectedEl.id, { color: "" });
                  canvasApi.updateElement(selectedEl.id, { color: "" }).catch(fail);
                }}
              />
              {Object.entries(FRAME_COLORS).map(([key, css]) => (
                <button
                  key={key}
                  className={`wf-board-swatch ${selectedEl.color === key ? "active" : ""}`}
                  style={{ background: css.border }}
                  title={key}
                  onClick={() => {
                    patchLocal(selectedEl.id, { color: key });
                    canvasApi.updateElement(selectedEl.id, { color: key }).catch(fail);
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
                patchLocal(selectedEl.id, { style });
                canvasApi.updateElement(selectedEl.id, { style }).catch(fail);
              }}
            />
          )}
          {selected.size > 0 && (
            <>
              <span className="wf-board-toolbar-sep" />
              <button
                title="Delete element"
                onClick={() => {
                  for (const id of selected) {
                    canvasApi.deleteElement(id).catch(fail);
                    useCanvas.getState().removeElement(id);
                  }
                  setSelected(new Set());
                }}
              >
                <Trash2 size={17} />
              </button>
            </>
          )}
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
  className,
}: {
  el: CanvasElement;
  editing: boolean;
  onCommit: (text: string) => void;
  className: string;
}) {
  const [draft, setDraft] = useState(el.text);
  useEffect(() => {
    if (editing) setDraft(el.text);
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
        if (e.key === "Escape") onCommit(el.text);
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
      <span className="wf-board-toolbar-sep" />
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
      <span className="wf-board-toolbar-sep" />
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
