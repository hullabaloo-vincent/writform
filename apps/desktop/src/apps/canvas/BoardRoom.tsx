import {
  ExternalLink,
  Frame as FrameIcon,
  Link2,
  MousePointer2,
  Spline,
  StickyNote,
  Trash2,
  Type,
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

type Tool = "select" | "sticky" | "text" | "frame" | "connect";

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
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [connectFrom, setConnectFrom] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;

  const fail = (e: unknown) => setError(isCmdError(e) ? e.message : String(e));

  // Delete key removes the selection (unless typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "textarea" || tag === "input") return;
      if (selected !== null) {
        canvasApi.deleteElement(selected).catch(fail);
        useCanvas.getState().removeElement(selected);
        setSelected(null);
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
          x: x - w / 2,
          y: y - h / 2,
          w,
          h,
          text,
          color,
          from_id: null,
          to_id: null,
        })
        .then((el) => {
          useCanvas.getState().applyElement(el);
          setSelected(el.id);
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
        x: x - defaults.w / 2,
        y: y - defaults.h / 2,
        w: defaults.w,
        h: defaults.h,
        text: defaults.text,
        color: defaults.color,
        from_id: null,
        to_id: null,
      })
      .then((el) => {
        useCanvas.getState().applyElement(el);
        setSelected(el.id);
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
    // Pan.
    setSelected(null);
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
    setSelected(el.id);
    if (editing !== null && editing !== el.id) setEditing(null);

    // Bring to front once per grab.
    const top = maxZ(useCanvas.getState().elements);
    if (el.z < top) {
      patchLocal(el.id, { z: top + 1 });
      canvasApi.updateElement(el.id, { z: top + 1 }).catch(() => {});
    }

    // Drag to move, throttled sync while moving, final patch on release.
    hold(el.id, true);
    const startWorld = toWorld(e.clientX, e.clientY);
    const origin = { x: el.x, y: el.y };
    let last = { x: el.x, y: el.y };
    let lastSent = 0;
    const onMove = (ev: PointerEvent) => {
      const now = toWorld(ev.clientX, ev.clientY);
      last = { x: origin.x + now.x - startWorld.x, y: origin.y + now.y - startWorld.y };
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
        w: Math.max(60, origin.w + now.x - startWorld.x),
        h: Math.max(36, origin.h + now.y - startWorld.y),
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
    .filter((el) => ["sticky", "text", "image", "link"].includes(el.kind))
    .sort((a, b) => a.z - b.z);
  const connectors = all.filter((el) => el.kind === "connector");
  const selectedEl = selected !== null ? elements[selected] : undefined;

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
              className={`wf-el wf-el-frame ${selected === el.id ? "selected" : ""} ${connectFrom === el.id ? "connect-from" : ""}`}
              style={{ left: el.x, top: el.y, width: el.w, height: el.h }}
              onPointerDown={(e) => onElementDown(e, el)}
              onDoubleClick={() => setEditing(el.id)}
            >
              <ElementText
                el={el}
                editing={editing === el.id}
                onCommit={(text) => commitText(el, text)}
                className="wf-el-frame-label"
              />
              {selected === el.id && (
                <span className="wf-el-resize" onPointerDown={(e) => onResizeDown(e, el)} />
              )}
            </div>
          ))}

          <svg className="wf-board-links">
            {connectors.map((c) => {
              const from = c.from_id !== null ? elements[c.from_id] : undefined;
              const to = c.to_id !== null ? elements[c.to_id] : undefined;
              if (!from || !to) return null;
              const x1 = from.x + from.w / 2;
              const y1 = from.y + from.h / 2;
              const x2 = to.x + to.w / 2;
              const y2 = to.y + to.h / 2;
              return (
                <g key={c.id}>
                  <line
                    className="wf-link-hit"
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelected(c.id);
                    }}
                  />
                  <line
                    className={`wf-link ${selected === c.id ? "selected" : ""}`}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                  />
                </g>
              );
            })}
          </svg>

          {bodies.map((el) => (
            <div
              key={el.id}
              className={`wf-el wf-el-${el.kind} ${selected === el.id ? "selected" : ""} ${connectFrom === el.id ? "connect-from" : ""}`}
              style={{
                left: el.x,
                top: el.y,
                width: el.w,
                height: el.h,
                background: el.kind === "sticky" ? (STICKY_COLORS[el.color] ?? STICKY_COLORS.yellow) : undefined,
              }}
              onPointerDown={(e) => onElementDown(e, el)}
              onDoubleClick={() => el.kind !== "image" && el.kind !== "link" && setEditing(el.id)}
            >
              {el.kind === "image" ? (
                <img
                  className="wf-el-image"
                  src={`writform-att://attachment/${el.text}`}
                  alt=""
                  draggable={false}
                />
              ) : el.kind === "link" ? (
                <LinkCard url={el.text} />
              ) : (
                <ElementText
                  el={el}
                  editing={editing === el.id}
                  onCommit={(text) => commitText(el, text)}
                  className={el.kind === "sticky" ? "wf-el-sticky-text" : "wf-el-text-text"}
                />
              )}
              {selected === el.id && (
                <span className="wf-el-resize" onPointerDown={(e) => onResizeDown(e, el)} />
              )}
            </div>
          ))}
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
          {selectedEl && (
            <>
              <span className="wf-board-toolbar-sep" />
              <button
                title="Delete element"
                onClick={() => {
                  canvasApi.deleteElement(selectedEl.id).catch(fail);
                  useCanvas.getState().removeElement(selectedEl.id);
                  setSelected(null);
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

  if (!editing) {
    return <div className={className}>{el.text || <span className="wf-el-placeholder">double-click to write</span>}</div>;
  }
  return (
    <textarea
      className={`${className} wf-el-edit`}
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
