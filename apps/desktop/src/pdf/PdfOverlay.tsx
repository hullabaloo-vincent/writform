import { useEffect, useRef, useState } from "react";

import { toast } from "../platform/toast";
import type { BlockInfo, Box, FieldInfo, FieldValue, MarkInfo, MarkSpec, Point } from "./engine/client";
import type { PdfSession } from "./session";

/**
 * What lies over a page of a PDF while it is being worked on: the form's
 * fields as things to type into and tick, the marks already on it as things
 * to pick up, and whatever the tool in hand makes (a note, a drawing, a
 * box, typed words, a signature, a block of the page's own text to change).
 *
 * Everything here is measured as the engine measures a page: points, from
 * the top left of the page as shown. The page is `k` screen pixels to the
 * point.
 */

/** What is in hand. `read` is none: the page's words can be selected. */
export type Tool = "read" | "note" | "draw" | "box" | "arrow" | "type" | "sign" | "edit";

/** A signature waiting to be put on a page. */
export interface Signing {
  /** Drawn: its strokes, each point as parts of its box (0 to 1). */
  strokes?: Point[][];
  /** A picture: its pixels, four bytes each. */
  picture?: { pixels: Uint8Array; w: number; h: number };
  /** How wide it is for how tall. */
  aspect: number;
}

/** A mark without the page it goes on (each kind of mark kept its own). */
type Marking = MarkSpec extends infer M ? (M extends unknown ? Omit<M, "page"> : never) : never;

/** How wide a signature is put down, points. */
const SIGN_WIDTH = 170;
const TYPE_SIZE = 12;

interface Props {
  session: PdfSession;
  index: number;
  /** How wide the page is shown, CSS pixels. */
  width: number;
  /** Changes when the page was changed. */
  stamp: number;
  near: boolean;
  tool: Tool;
  signing: Signing | null;
  fields: FieldInfo[];
  /** Run a change (it is the room that says what went wrong). */
  act: (run: () => Promise<unknown>) => Promise<void>;
  /** A signature was put down: the tool is done. */
  onPlaced: () => void;
}

const place = (rect: Box, k: number): React.CSSProperties => ({ left: rect[0] * k, top: rect[1] * k, width: Math.max(1, rect[2] * k), height: Math.max(1, rect[3] * k) });

function FieldControl({ field, widget, k, disabled, onSet }: { field: FieldInfo; widget: FieldInfo["widgets"][number]; k: number; disabled: boolean; onSet: (value: FieldValue) => void }) {
  const style = place(widget.rect, k);
  const label = field.tooltip ?? field.name;
  const off = disabled || field.readOnly;
  if (field.kind === "check") return <input className="wf-pdf-field" type="checkbox" style={style} aria-label={label} title={label} disabled={off} checked={widget.on} onChange={() => onSet({ check: !widget.on })} />;
  if (field.kind === "radio") return <input className="wf-pdf-field" type="radio" style={style} aria-label={label} title={label} disabled={off} checked={widget.on} onChange={() => onSet({ radio: widget.onState })} />;
  if (field.kind === "combo" || field.kind === "list") {
    return (
      <select className="wf-pdf-field" style={style} aria-label={label} title={label} disabled={off} value={field.value[0] ?? ""} onChange={(e) => onSet({ choice: e.target.value ? [e.target.value] : [] })}>
        <option value="" />
        {field.options.map(([value, shown]) => (
          <option key={value} value={value}>
            {shown}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind !== "text") return null;
  const value = field.value[0] ?? "";
  const common = {
    className: "wf-pdf-field",
    style: { ...style, fontSize: Math.max(8, Math.min(widget.rect[3] * 0.62, 14) * k) },
    "aria-label": label,
    title: label,
    disabled: off,
    defaultValue: value,
    maxLength: field.maxLen ?? undefined,
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.target.value !== value) onSet({ text: e.target.value });
    },
  };
  // (Keyed by what it holds: a value set from elsewhere shows.)
  return field.multiline ? <textarea key={value} {...common} /> : <input key={value} type={field.password ? "password" : "text"} {...common} />;
}

export function PageOverlay({ session, index, width, stamp, near, tool, signing, fields, act, onPlaced }: Props) {
  const page = session.info.pages[index];
  const k = page ? width / page.w : 1;
  const holder = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<MarkInfo[]>([]);
  const [blocks, setBlocks] = useState<BlockInfo[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  /** Something being drawn: where the pointer has been. */
  const [trail, setTrail] = useState<Point[] | null>(null);
  /** Words being typed: a note or typed text at a place, or a block of the page's own text. */
  const [typing, setTyping] = useState<{ kind: "note" | "type"; at: Point } | { kind: "block"; block: BlockInfo } | { kind: "mark"; mark: MarkInfo } | null>(null);
  const moving = useRef<{ index: number; from: Point; by: Point } | null>(null);
  /** The press now under way began with a box of words open (see `onDown`). */
  const closing = useRef(false);
  const [nudge, setNudge] = useState<Point | null>(null);

  // The marks on this page, whenever it has changed.
  useEffect(() => {
    if (!near) return;
    let gone = false;
    void session.read("marks", index).then(
      (list) => {
        if (!gone) setMarks(list);
      },
      () => {
        if (!gone) setMarks([]);
      },
    );
    return () => {
      gone = true;
    };
  }, [session, index, stamp, near]);
  // Its own text as blocks, while that is what is being changed.
  useEffect(() => {
    if (!near || tool !== "edit") return;
    let gone = false;
    void session.read("textBlocks", index).then(
      (list) => {
        if (!gone) setBlocks(list);
      },
      () => {
        if (!gone) setBlocks([]);
      },
    );
    return () => {
      gone = true;
    };
  }, [session, index, stamp, near, tool]);

  if (!page) return null;
  const at = (e: { clientX: number; clientY: number }): Point => {
    const box = holder.current?.getBoundingClientRect();
    return box ? [(e.clientX - box.left) / k, (e.clientY - box.top) / k] : [0, 0];
  };
  const add = (mark: Marking, pixels?: Uint8Array) => act(() => session.change("addMark", { ...mark, page: index } as MarkSpec, pixels));
  const making = tool === "note" || tool === "draw" || tool === "box" || tool === "arrow" || tool === "type" || (tool === "sign" && !!signing);

  const onDown = (e: React.PointerEvent) => {
    // (Pressed while a box of words is open: this press is what closes it,
    // and the click it ends in is not one that asks for another.)
    closing.current = !!typing;
    if (e.button !== 0 || typing) return;
    // A note and typed words are put down by the click, not the press: see
    // `onPlace`.
    if (tool === "note" || tool === "type") return;
    const p = at(e);
    if (tool === "sign" && signing) {
      const w = Math.min(SIGN_WIDTH, page.w * 0.6);
      const h = w / Math.max(0.2, signing.aspect);
      const rect: Box = [Math.max(0, Math.min(page.w - w, p[0] - w / 2)), Math.max(0, Math.min(page.h - h, p[1] - h / 2)), w, h];
      if (signing.picture) void add({ kind: "picture", rect, w: signing.picture.w, h: signing.picture.h }, signing.picture.pixels).then(onPlaced);
      else if (signing.strokes) void add({ kind: "signature", strokes: signing.strokes.map((stroke) => stroke.map(([x, y]): Point => [rect[0] + x * w, rect[1] + y * h])) }).then(onPlaced);
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setTrail([p]);
  };
  /**
   * A note, or words to type, where the page was clicked: a box to write in
   * opens there.
   *
   * On the CLICK, once the button is up. Opened on the press, the box got
   * the caret and lost it again at once: a press on the page moves the
   * focus to what was pressed, which took it out of the new box, and a box
   * that loses the focus is taken as finished (with nothing in it).
   */
  const onPlace = (e: React.MouseEvent) => {
    if (e.button !== 0 || typing || (tool !== "note" && tool !== "type")) return;
    if (closing.current) {
      closing.current = false;
      return;
    }
    setTyping({ kind: tool, at: at(e) });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!trail) return;
    const p = at(e);
    setTrail(tool === "draw" ? [...trail, p] : [trail[0], p]);
  };
  const onUp = () => {
    const drawn = trail;
    setTrail(null);
    if (!drawn || drawn.length < 2) return;
    const [a, b] = [drawn[0], drawn[drawn.length - 1]];
    const far = Math.hypot(b[0] - a[0], b[1] - a[1]) > 4;
    if (tool === "draw") void add({ kind: "ink", strokes: [drawn] });
    else if (tool === "box" && far) void add({ kind: "rect", rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])] });
    else if (tool === "arrow" && far) void add({ kind: "line", from: a, to: b, arrow: true });
  };

  /** What was typed is put where it belongs. */
  const commit = (text: string) => {
    const was = typing;
    setTyping(null);
    if (!was) return;
    const said = text.trim();
    if (was.kind === "block") {
      if (text === was.block.text || !said) return;
      void act(async () => {
        const change = await session.change("replaceBlock", index, was.block.index, text);
        // (Most PDFs carry only the letters they use.)
        if (change?.substituted) toast("Some letters are not in this PDF’s own font. They were set in a standard one.", "info");
      });
    } else if (was.kind === "mark") {
      if (said !== (was.mark.text ?? "")) void act(() => session.change("updateMark", index, was.mark.index, { text: said }));
    } else if (said) {
      if (was.kind === "note") void add({ kind: "note", at: was.at, text: said });
      else {
        // As wide as its longest line and as tall as its lines (near enough:
        // the engine draws it, and it can be moved after).
        const lines = said.split("\n");
        const wide = Math.min(page.w - was.at[0] - 4, Math.max(40, Math.max(...lines.map((line) => line.length)) * TYPE_SIZE * 0.56 + 8));
        void add({ kind: "text", rect: [was.at[0], was.at[1], wide, lines.length * TYPE_SIZE * 1.35 + 6], size: TYPE_SIZE, text: said });
      }
    }
  };

  // A mark picked up and moved.
  const onMarkDown = (mark: MarkInfo, e: React.PointerEvent) => {
    if (e.button !== 0 || tool !== "read") return;
    e.stopPropagation();
    setPicked(mark.index);
    if (mark.locked) return;
    moving.current = { index: mark.index, from: at(e), by: [0, 0] };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onMarkMove = (e: React.PointerEvent) => {
    const m = moving.current;
    if (!m) return;
    const p = at(e);
    m.by = [p[0] - m.from[0], p[1] - m.from[1]];
    setNudge(m.by);
  };
  const onMarkUp = () => {
    const m = moving.current;
    moving.current = null;
    setNudge(null);
    if (m && Math.hypot(m.by[0], m.by[1]) > 2) void act(() => session.change("updateMark", index, m.index, { by: m.by }));
  };
  const chosen = marks.find((mark) => mark.index === picked) ?? null;
  const here = fields.flatMap((field) => field.widgets.filter((widget) => widget.page === index).map((widget, n) => ({ field, widget, n })));
  const path = trail && trail.length > 1 ? trail.map((p, n) => `${n ? "L" : "M"}${(p[0] * k).toFixed(1)} ${(p[1] * k).toFixed(1)}`).join(" ") : null;
  const typed = typing
    ? typing.kind === "block"
      ? { rect: typing.block.rect, text: typing.block.text, size: typing.block.size }
      : typing.kind === "mark"
        ? { rect: [typing.mark.rect[0], typing.mark.rect[1] + typing.mark.rect[3] + 4, 200, 70] as Box, text: typing.mark.text ?? "", size: 11 }
        : { rect: [typing.at[0], typing.at[1], Math.min(220, page.w - typing.at[0] - 4), typing.kind === "note" ? 70 : 28] as Box, text: "", size: typing.kind === "note" ? 11 : TYPE_SIZE }
    : null;

  return (
    <div ref={holder} className={`wf-pdf-over${making ? " making" : ""}`} onPointerDown={making ? onDown : undefined} onPointerMove={making ? onMove : undefined} onPointerUp={making ? onUp : undefined} onPointerCancel={() => setTrail(null)} onClick={making ? onPlace : undefined}>
      {here.map(({ field, widget, n }) => (
        <FieldControl key={`${field.name}-${n}`} field={field} widget={widget} k={k} disabled={!session.info.may.fillForms || session.busy} onSet={(value) => void act(() => session.change("setField", field.name, value))} />
      ))}
      {tool === "read" &&
        marks.map((mark) => {
          const moved: Box = nudge && moving.current?.index === mark.index ? [mark.rect[0] + nudge[0], mark.rect[1] + nudge[1], mark.rect[2], mark.rect[3]] : mark.rect;
          return (
            <div
              key={mark.index}
              className={`wf-pdf-mark${mark.index === picked ? " picked" : ""}`}
              style={place(moved, k)}
              title={mark.text ?? undefined}
              role="button"
              tabIndex={0}
              aria-label={mark.text ? `Mark: ${mark.text}` : "Mark"}
              onPointerDown={(e) => onMarkDown(mark, e)}
              onPointerMove={onMarkMove}
              onPointerUp={onMarkUp}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setPicked(mark.index);
                else if ((e.key === "Delete" || e.key === "Backspace") && !mark.locked) void act(() => session.change("deleteMark", index, mark.index));
              }}
            />
          );
        })}
      {tool === "read" && chosen && !typing && (
        <div className="wf-pdf-markbar" style={{ left: chosen.rect[0] * k, top: Math.max(0, chosen.rect[1] * k - 34) }}>
          {(chosen.subtype === "Text" || chosen.subtype === "FreeText") && !chosen.locked && <button onClick={() => setTyping({ kind: "mark", mark: chosen })}>Change the words</button>}
          {!chosen.locked && (
            <button
              onClick={() => {
                setPicked(null);
                void act(() => session.change("deleteMark", index, chosen.index));
              }}
            >
              Take it off
            </button>
          )}
          <button onClick={() => setPicked(null)}>Done</button>
        </div>
      )}
      {tool === "edit" &&
        !typing &&
        blocks.map((block) => (
          <button key={block.index} className="wf-pdf-block" style={place(block.rect, k)} title="Change this text" aria-label={`Change this text: ${block.text.slice(0, 60)}`} disabled={!session.info.may.changeText || session.busy} onClick={() => setTyping({ kind: "block", block })} />
        ))}
      {path && (
        <svg className="wf-pdf-trail" aria-hidden>
          {tool === "box" && trail ? (
            <rect x={Math.min(trail[0][0], trail[1][0]) * k} y={Math.min(trail[0][1], trail[1][1]) * k} width={Math.abs(trail[1][0] - trail[0][0]) * k} height={Math.abs(trail[1][1] - trail[0][1]) * k} />
          ) : (
            <path d={path} />
          )}
        </svg>
      )}
      {typed && typing && (
        <textarea
          className={`wf-pdf-typing${typing.kind === "block" ? " block" : ""}`}
          style={{ ...place([typed.rect[0], typed.rect[1], Math.max(typed.rect[2], 60), Math.max(typed.rect[3], typed.size * 1.6)], k), fontSize: Math.max(9, typed.size * k) }}
          autoFocus
          defaultValue={typed.text}
          aria-label={typing.kind === "note" ? "What the note says" : typing.kind === "block" ? "The text" : "The words"}
          placeholder={typing.kind === "note" ? "What the note says" : typing.kind === "type" ? "Type here" : undefined}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setTyping(null);
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit((e.target as HTMLTextAreaElement).value);
            }
          }}
        />
      )}
    </div>
  );
}

/** The lines of text that are selected on the pages, as boxes on each. */
export function selectedLines(root: HTMLElement): Map<number, Box[]> {
  const out = new Map<number, Box[]>();
  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  if (!selection || selection.isCollapsed || !selection.rangeCount) return out;
  const frames = [...root.querySelectorAll<HTMLElement>(".wf-pdf-page")];
  const rects = [...selection.getRangeAt(0).getClientRects()].filter((r) => r.width > 1 && r.height > 1);
  for (const frame of frames) {
    const box = frame.getBoundingClientRect();
    const index = Number(frame.dataset.page);
    const pageWidth = Number(frame.dataset.points) || box.width;
    const k = box.width / pageWidth;
    const mine: Box[] = [];
    for (const r of rects) {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) continue;
      const next: Box = [(r.left - box.left) / k, (r.top - box.top) / k, r.width / k, r.height / k];
      // (The layer has a piece to each run of words: those on one line are one box.)
      const same = mine.find((m) => Math.abs(m[1] - next[1]) < next[3] * 0.5 && next[0] <= m[0] + m[2] + next[3] && next[0] + next[2] >= m[0] - next[3]);
      if (same) {
        const right = Math.max(same[0] + same[2], next[0] + next[2]);
        same[0] = Math.min(same[0], next[0]);
        same[2] = right - same[0];
        same[3] = Math.max(same[3], next[3]);
      } else mine.push(next);
    }
    if (mine.length) out.set(index, mine);
  }
  return out;
}
