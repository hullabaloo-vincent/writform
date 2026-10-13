import { AlertTriangle, AlignCenter, AlignLeft, AlignRight, Bold, BringToFront, Copy, ImagePlus, Italic, Redo2, SendToBack, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type * as Y from "yjs";

import { fontLabel } from "../../fonts/css";
import { fontLicence, OPEN_LICENCES } from "../../fonts/licence";
import { FontPicker } from "../../fonts/ui/FontPicker";
import { normalizeAttachmentSrc, type CmdError } from "../../lib/backend";
import { saveExport } from "../../lib/saveFile";
import { Modal } from "../../platform";
import { toast, toastError } from "../../platform/toast";
import { coverKeys, coverPatch, hasCover, printPieces, type BookCover, type CoverSlot } from "../cover/art";
import { newText, newTextId, PLAIN_LOOK, startingTexts, TEXT_MAX, type CoverPanel, type CoverText, type CoverWords, type PanelLook, type TextKind } from "../cover/design";
import type { CoverFile } from "../cover/files";
import { coverGeometry, movedText, pannedLook, printNotes, resizedText, sizeWords, slotBox, SPINE_TEXT_PAGES, spineDrift, textRun } from "../cover/geometry";
import { updateBook, type Book } from "../model/bookMap";
import { estimatePages } from "../model/trims";
import { pagesKey, usePrintedPages, type CoverPictures } from "./Cover";
import { CoverSvg, useCoverScene, type CoverViewOf } from "./CoverView";

const messageOf = (e: unknown, fallback: string): string => (e as Partial<CmdError> | null)?.message || fallback;

type Selected = { text: string } | { slot: CoverSlot } | null;

const VIEWS: [CoverViewOf, string][] = [
  ["all", "Whole cover"],
  ["back", "Back"],
  ["spine", "Spine"],
  ["front", "Front"],
];
const SLOT_NAMES: Record<CoverSlot, string> = { front: "Front cover", back: "Back cover", spine: "Spine", wrap: "Whole cover" };
const ADD: [TextKind, string][] = [
  ["title", "Title"],
  ["subtitle", "Subtitle"],
  ["author", "Author"],
  ["blurb", "Blurb"],
  ["spine", "Spine line"],
  ["plain", "Other words"],
];

/** Where new words of a kind go, given what is being looked at. */
function panelFor(kind: TextKind, view: CoverViewOf): CoverPanel {
  if (kind === "spine") return "spine";
  if (view !== "all") return view;
  return kind === "blurb" ? "back" : "front";
}

interface Drag {
  kind: "move" | "size" | "pan";
  at: { x: number; y: number };
  /** What it started from. */
  text?: CoverText;
  side?: "start" | "end";
  slot?: CoverSlot;
  look?: PanelLook;
  moved: boolean;
}

/**
 * The cover editor. The sheet is drawn as it prints. Click a part of it to
 * change its picture or its paper's colour (drag a picture to choose what
 * shows). Click words to change them, their font, size and colour, and drag
 * them where they belong. What is made is kept with the manuscript as it is
 * made, and from here the template and the cover for the printer are saved.
 *
 * The words are real text, set by the book's own typesetting engine in open
 * fonts (the app's and the online library's: every one free to use on a
 * book that is sold).
 */
export function CoverEditor({
  ydoc,
  book,
  readonly,
  words,
  chapters,
  pictures,
  countPages,
  onClose,
}: {
  ydoc: Y.Doc;
  book: Book;
  readonly: boolean;
  words: number;
  chapters: number;
  pictures?: CoverPictures;
  countPages?: () => Promise<number | null>;
  onClose: () => void;
}) {
  const { pages, exact } = usePrintedPages(countPages, estimatePages(words, chapters, book.print, book.design), pagesKey(book, words));
  const printKey = JSON.stringify(book.print);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `printKey` is the print settings, said once
  const g = useMemo(() => coverGeometry(book.print, pages), [printKey, pages]);
  const size = sizeWords(g);

  // ------------------------------------------------ the cover being worked on
  const [cover, setCover] = useState<BookCover>(book.cover);
  const latest = useRef(cover);
  /** What the book has, as far as this editor knows. */
  const written = useRef(coverKeys(book.cover));
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<Drag | null>(null);
  const past = useRef<BookCover[]>([]);
  const future = useRef<BookCover[]>([]);
  const [, bump] = useState(0);

  const flush = useCallback(() => {
    if (waiting.current) clearTimeout(waiting.current);
    waiting.current = null;
    const next = coverKeys(latest.current);
    const patch = coverPatch(written.current, next);
    written.current = next;
    if (!readonly && Object.keys(patch).length > 0) updateBook(ydoc, patch);
  }, [ydoc, readonly]);

  /**
   * Change the cover. "now" writes it to the book at once, "soon" a moment
   * after the last change (typing), "hold" not yet (a drag, written when it
   * ends). `record` keeps what it was, to go back to.
   */
  const change = useCallback(
    (next: BookCover, how: "now" | "soon" | "hold" = "now", record = true) => {
      if (readonly) return;
      if (record) {
        past.current.push(latest.current);
        if (past.current.length > 60) past.current.shift();
        future.current = [];
      }
      latest.current = next;
      setCover(next);
      if (how === "now") flush();
      else if (how === "soon") {
        if (waiting.current) clearTimeout(waiting.current);
        waiting.current = setTimeout(flush, 350);
      }
    },
    [flush, readonly],
  );

  // Someone else's change (or this editor's own, come back from the book):
  // taken when nothing here is waiting to be written.
  useEffect(() => {
    if (waiting.current || drag.current) return;
    const theirs = coverKeys(book.cover);
    if (Object.keys(coverPatch(written.current, theirs)).length === 0) return;
    written.current = theirs;
    latest.current = book.cover;
    setCover(book.cover);
  }, [book.cover]);
  useEffect(() => flush, [flush]);

  const step = (from: BookCover[], to: BookCover[]) => {
    const back = from.pop();
    if (!back) return;
    to.push(latest.current);
    latest.current = back;
    setCover(back);
    flush();
    bump((n) => n + 1);
  };
  const undo = () => step(past.current, future.current);
  const redo = () => step(future.current, past.current);

  // ------------------------------------------------------ what is looked at
  const [view, setView] = useState<CoverViewOf>("all");
  const [guides, setGuides] = useState(true);
  const [selected, setSelected] = useState<Selected>(null);
  const { scene, standIns } = useCoverScene(cover, g);
  const svgRef = useRef<SVGSVGElement>(null);
  const sheetRef = useRef<SVGGElement>(null);
  const text = selected && "text" in selected ? (cover.texts.find((t) => t.id === selected.text) ?? null) : null;
  const slot = selected && "slot" in selected ? selected.slot : null;
  const box = text ? (scene?.texts.find((t) => t.id === text.id)?.bounds ?? null) : null;

  const setText = (next: CoverText, how: "now" | "soon" | "hold" = "now", record = true) => {
    change({ ...latest.current, texts: latest.current.texts.map((t) => (t.id === next.id ? next : t)) }, how, record);
  };
  /** A change to the words being typed: one step back for the whole burst. */
  const typeText = (next: CoverText) => setText(next, "soon", waiting.current === null);
  const setLook = (which: CoverSlot, look: PanelLook, how: "now" | "soon" | "hold" = "now", record = true) => {
    change({ ...latest.current, looks: { ...latest.current.looks, [which]: look } }, how, record);
  };

  const bookWords: CoverWords = { title: book.meta.title, subtitle: book.meta.subtitle, author: book.meta.author, description: book.meta.description };
  const add = (kind: TextKind) => {
    if (latest.current.texts.length >= TEXT_MAX) {
      toast(`A cover holds up to ${TEXT_MAX} pieces of text.`, "info");
      return;
    }
    const panel = panelFor(kind, view);
    const made = newText(kind, panel, bookWords, latest.current.texts, text?.font);
    change({ ...latest.current, texts: [...latest.current.texts, made] });
    setSelected({ text: made.id });
    if (view !== "all" && view !== made.panel) setView(made.panel);
  };
  const start = () => {
    change({ ...latest.current, texts: startingTexts(bookWords, g.spineText) });
    setSelected(null);
  };
  const remove = (id: string) => {
    change({ ...latest.current, texts: latest.current.texts.filter((t) => t.id !== id) });
    setSelected(null);
  };
  const copy = (from: CoverText) => {
    if (latest.current.texts.length >= TEXT_MAX) return;
    const top = latest.current.texts.reduce((z, t) => Math.max(z, t.z), 0) + 1;
    const made = { ...movedText(from, 12, 12, g), id: newTextId(latest.current.texts.map((t) => t.id)), z: top };
    change({ ...latest.current, texts: [...latest.current.texts, made] });
    setSelected({ text: made.id });
  };
  const restack = (which: CoverText, to: "top" | "bottom") => {
    const others = latest.current.texts.filter((t) => t.id !== which.id);
    const ordered = to === "top" ? [...others, which] : [which, ...others];
    change({ ...latest.current, texts: ordered.map((t, i) => ({ ...t, z: i + 1 })) });
  };

  // ------------------------------------------------------------ pictures
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const choosing = useRef<CoverSlot>("front");
  const choose = async (which: CoverSlot, file: File) => {
    if (!pictures) return;
    setBusy(true);
    try {
      const { storeArt } = await import("../cover/files");
      const { art, resaved } = await storeArt(file, pictures.upload, pictures.limit);
      change({
        ...latest.current,
        [which]: art,
        looks: { ...latest.current.looks, [which]: { ...PLAIN_LOOK, color: latest.current.looks[which].color } },
        // (What depends on the spine's width was made for this many pages.)
        ...(which === "wrap" || which === "spine" ? { pages: g.pages } : {}),
      });
      if (resaved) toast("That picture was too heavy to keep as it was, so it was saved as a JPEG.", "info");
    } catch (e) {
      toastError(messageOf(e, "That picture couldn’t be added."));
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------- pointing
  /** A place on screen as a place on the sheet, points (whatever part of
   *  it is looked at, however it is turned). */
  const toSheet = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const ctm = sheetRef.current?.getScreenCTM?.();
    if (!ctm) return null;
    const m = ctm.inverse();
    return { x: m.a * e.clientX + m.c * e.clientY + m.e, y: m.b * e.clientX + m.d * e.clientY + m.f };
  };
  const slotAt = (at: { x: number; y: number }): CoverSlot => {
    if (latest.current.wrap) return "wrap";
    const x = at.x / 72;
    return x < g.spineBox.x ? "back" : x < g.spineBox.x + g.spine ? "spine" : "front";
  };
  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const handle = target.closest("[data-handle]")?.getAttribute("data-handle") as "start" | "end" | null | undefined;
    const id = handle ? text?.id : target.closest("[data-text]")?.getAttribute("data-text");
    const at = toSheet(e);
    const hit = id ? latest.current.texts.find((t) => t.id === id) : undefined;
    if (hit) {
      setSelected({ text: hit.id });
      if (at && !readonly) drag.current = handle ? { kind: "size", side: handle, at, text: hit, moved: false } : { kind: "move", at, text: hit, moved: false };
    } else if (at) {
      const which = slotAt(at);
      setSelected({ slot: which });
      if (!readonly && latest.current[which]) drag.current = { kind: "pan", at, slot: which, look: latest.current.looks[which], moved: false };
    }
    if (drag.current) e.currentTarget.setPointerCapture?.(e.pointerId);
    // (So the arrow keys and Delete are the cover's from here.)
    e.currentTarget.focus?.({ preventScroll: true });
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    const at = d && toSheet(e);
    if (!d || !at) return;
    const dx = at.x - d.at.x;
    const dy = at.y - d.at.y;
    // (A press that hardly moves is a click, not a drag.)
    if (!d.moved && Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5) return;
    const first = !d.moved;
    d.moved = true;
    if (d.kind === "move" && d.text) setText(movedText(d.text, dx, dy, g), "hold", first);
    else if (d.kind === "size" && d.text && d.side) setText(resizedText(d.text, d.side, d.text.panel === "spine" ? dy : dx, g), "hold", first);
    else if (d.kind === "pan" && d.slot && d.look) {
      const art = latest.current[d.slot];
      if (art) setLook(d.slot, pannedLook(d.look, art, slotBox(g, d.slot), dx, dy), "hold", first);
    }
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) flush();
  };
  const onKey = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    if (!text || readonly) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(text.id);
      return;
    }
    const by = e.shiftKey ? 10 : 1;
    const arrow: Record<string, [number, number]> = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] };
    const move = arrow[e.key];
    if (!move) return;
    e.preventDefault();
    setText(movedText(text, move[0], move[1], g), "soon", waiting.current === null);
  };
  // ⌘Z here is this editor's own (not while a field has it).
  const onShortcut = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
    const el = e.target as HTMLElement;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return;
    e.preventDefault();
    flush();
    if (e.shiftKey) redo();
    else undo();
  };

  // --------------------------------------------------------- what to save
  const [making, setMaking] = useState<"template" | "cover" | null>(null);
  const [made, setMade] = useState<CoverFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMade(null);
  }, [cover, g]);
  const make = async (what: "template" | "cover") => {
    flush();
    setMaking(what);
    setError(null);
    setMade(null);
    try {
      const files = await import("../cover/files");
      const now = { ...book, cover: latest.current };
      setMade(what === "template" ? await files.buildTemplateFile(now, g) : await files.buildCoverFile(now, g));
    } catch (e) {
      setError(messageOf(e, "That file couldn’t be made."));
    } finally {
      setMaking(null);
    }
  };
  const save = async () => {
    if (!made) return;
    const result = await saveExport(made.fileName, "pdf", made.bytes).catch((e: unknown) => {
      setError(messageOf(e, String(e)));
      return null;
    });
    if (result?.status === "saved") setMade(null);
  };

  const checks: string[] = [];
  if (!exact) checks.push("The pages are still being counted, so the spine’s width is an estimate. Wait for the count before you save a file.");
  for (const piece of printPieces(cover)) checks.push(...printNotes(piece, cover[piece]!, g, cover.looks[piece]).map((note) => `${SLOT_NAMES[piece]}: ${note}`));
  if (!g.spineText && cover.texts.some((t) => t.panel === "spine" && t.text.trim() !== "")) {
    checks.push(`Under ${SPINE_TEXT_PAGES} pages a spine is too narrow for words. Printers turn away covers that have them.`);
  }
  const drift = spineDrift(cover, g);
  if (drift) checks.push(`The artwork was put in when the book had ${drift.was} pages. It has ${drift.now} now, so the spine is ${Math.abs(drift.by).toFixed(3)} in ${drift.by > 0 ? "wider" : "narrower"}.`);
  if (standIns.length > 0) checks.push(`${standIns.join(" and ")} couldn’t be fetched, so ${standIns.length === 1 ? "its" : "their"} words are in another font for now.`);

  const fontsInUse = [...new Set(cover.texts.map((t) => t.font))];
  const licence = text ? fontLicence(text.font) : null;
  /** Along the selected text's own line, on the sheet: across, or down the spine. */
  const handles = box && text ? (text.panel === "spine" ? [{ side: "start", x: box.x + box.w / 2, y: box.y }, { side: "end", x: box.x + box.w / 2, y: box.y + box.h }] : [{ side: "start", x: box.x, y: box.y + box.h / 2 }, { side: "end", x: box.x + box.w, y: box.y + box.h / 2 }]) : [];

  return (
    <Modal onClose={onClose} className="wf-cover-editor">
      <div className="wf-cover-ed" onKeyDown={onShortcut}>
        <header className="wf-cover-ed-bar">
          <h3>Cover</h3>
          <div className="wf-cover-ed-views" role="tablist" aria-label="What to look at">
            {VIEWS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? "active" : ""} onClick={() => setView(id)}>
                {label}
              </button>
            ))}
          </div>
          <label className="wf-cover-toggle">
            <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} /> Guides
          </label>
          <span className="wf-cover-ed-steps">
            <button type="button" className="wf-icon" title="Undo (⌘Z)" aria-label="Undo" disabled={readonly || past.current.length === 0} onClick={undo}>
              <Undo2 size={15} />
            </button>
            <button type="button" className="wf-icon" title="Redo (⌘⇧Z)" aria-label="Redo" disabled={readonly || future.current.length === 0} onClick={redo}>
              <Redo2 size={15} />
            </button>
          </span>
        </header>

        <div className="wf-cover-ed-body">
          <div className="wf-cover-ed-stage">
            <CoverSvg
              g={g}
              scene={scene}
              view={view}
              guides={guides}
              className="editing"
              svgRef={svgRef}
              sheetRef={sheetRef}
              tabIndex={0}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onKeyDown={onKey}
            >
              {slot && (
                <rect className="wf-cover-pick panel" x={slotBox(g, slot).x * 72} y={slotBox(g, slot).y * 72} width={slotBox(g, slot).w * 72} height={slotBox(g, slot).h * 72} pointerEvents="none" />
              )}
              {box && <rect className="wf-cover-pick" x={box.x} y={box.y} width={box.w} height={box.h} pointerEvents="none" />}
              {!readonly && handles.map((h) => <circle key={h.side} className="wf-cover-handle" data-handle={h.side} cx={h.x} cy={h.y} r={7} />)}
            </CoverSvg>
            <p className="wf-cover-ed-size">
              {g.trim.w} × {g.trim.h} in, {exact ? "" : "about "}
              {g.pages.toLocaleString("en-US")} pages. The sheet is {size.inches} with a spine of {size.spine}.
            </p>
          </div>

          <aside className="wf-cover-ed-side">
            {text ? (
              <TextPanel
                key={text.id}
                text={text}
                disabled={readonly}
                fonts={fontsInUse}
                licence={licence}
                run={textRun(g, text.panel)}
                onType={typeText}
                onSet={(next) => setText(next)}
                onSlide={(next) => setText(next, "soon", waiting.current === null)}
                onCopy={() => copy(text)}
                onRemove={() => remove(text.id)}
                onStack={(to) => restack(text, to)}
              />
            ) : slot ? (
              <section className="wf-cover-ed-group">
                <h4>{SLOT_NAMES[slot]}</h4>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void choose(choosing.current, file);
                  }}
                />
                <div className="wf-cover-ed-picture">
                  <div className="wf-cover-thumb">{cover[slot] ? <img src={normalizeAttachmentSrc(cover[slot]!.src)} alt="" decoding="async" /> : <ImagePlus size={16} aria-hidden />}</div>
                  <div className="wf-cover-slot-text">
                    <span>{cover[slot] ? `${cover[slot]!.w.toLocaleString("en-US")} × ${cover[slot]!.h.toLocaleString("en-US")} pixels` : "No picture. A JPEG or a PNG."}</span>
                    <div className="wf-cover-slot-actions">
                      <button
                        type="button"
                        disabled={readonly || busy || !pictures}
                        onClick={() => {
                          choosing.current = slot;
                          fileRef.current?.click();
                        }}
                      >
                        {busy ? "Adding…" : cover[slot] ? "Replace…" : "Choose a picture…"}
                      </button>
                      {cover[slot] && (
                        <button type="button" className="wf-icon" disabled={readonly} title="Remove the picture" aria-label="Remove the picture" onClick={() => change({ ...latest.current, [slot]: null })}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                {cover[slot] && (
                  <>
                    <label className="wf-cover-field">
                      <span>Size of the picture</span>
                      <input
                        type="range"
                        min={1}
                        max={4}
                        step={0.01}
                        value={cover.looks[slot].zoom}
                        disabled={readonly}
                        onChange={(e) => setLook(slot, { ...latest.current.looks[slot], zoom: Number(e.target.value) }, "soon", waiting.current === null)}
                      />
                    </label>
                    <p className="wf-inspector-dim">Drag the picture on the cover to choose which part of it shows.</p>
                    <button type="button" disabled={readonly} onClick={() => setLook(slot, { ...PLAIN_LOOK, color: latest.current.looks[slot].color })}>
                      Fit and centre it
                    </button>
                  </>
                )}
                {slot !== "wrap" && (
                  <label className="wf-cover-field row">
                    <span>Paper colour</span>
                    <input type="color" value={cover.looks[slot].color} disabled={readonly} onChange={(e) => setLook(slot, { ...latest.current.looks[slot], color: e.target.value }, "soon", waiting.current === null)} />
                  </label>
                )}
                {slot !== "wrap" && !cover.wrap && (
                  <p className="wf-inspector-dim">
                    Have the whole cover as one picture?{" "}
                    <button type="button" className="wf-link" onClick={() => setSelected({ slot: "wrap" })}>
                      Use one picture for back, spine and front
                    </button>
                  </p>
                )}
                {cover[slot] && printNotes(slot, cover[slot]!, g, cover.looks[slot]).map((note) => (
                  <p key={note} className="wf-cover-note">
                    <AlertTriangle size={12} aria-hidden /> {note}
                  </p>
                ))}
              </section>
            ) : (
              <section className="wf-cover-ed-group">
                <h4>Make the cover</h4>
                <p className="wf-inspector-dim">Click a part of the cover to give it a picture or a colour. Click words to change them, and drag them where they belong.</p>
                {cover.texts.length === 0 && !readonly && (
                  <button type="button" className="wf-primary" onClick={start}>
                    Start with the book’s title and author
                  </button>
                )}
              </section>
            )}

            {!readonly && (
              <section className="wf-cover-ed-group">
                <h4>Add words</h4>
                <div className="wf-cover-ed-add">
                  {ADD.map(([kind, label]) => (
                    <button key={kind} type="button" onClick={() => add(kind)}>
                      {label}
                    </button>
                  ))}
                </div>
                <p className="wf-inspector-dim">Every font offered here is open-licensed and free to use on a book you sell.</p>
              </section>
            )}

            {checks.length > 0 && (
              <div className="wf-preflight">
                <p className="wf-preflight-head">
                  <AlertTriangle size={14} /> To check
                </p>
                <ul>
                  {checks.map((line) => (
                    <li key={line}>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        </div>

        {made && (
          <p className="wf-export-ready">
            Ready: {made.fileName}
            {made.unread.length > 0 ? `. ${made.unread.map((s) => SLOT_NAMES[s]).join(" and ")} couldn’t be read and ${made.unread.length === 1 ? "was" : "were"} left out.` : ""}
          </p>
        )}
        {error && <p className="wf-connect-error">{error}</p>}
        <footer className="wf-connect-row wf-export-actions wf-cover-dialog-actions">
          <button onClick={onClose}>Close</button>
          {made ? (
            <button className="wf-primary" onClick={() => void save()}>
              Save…
            </button>
          ) : (
            <>
              <button disabled={making !== null} title="The sheet at this exact size with its guides, to make artwork over elsewhere" onClick={() => void make("template")}>
                {making === "template" ? "Making…" : "Make a template (PDF)"}
              </button>
              <button className="wf-primary" disabled={making !== null || !hasCover(cover)} title="The cover for the printer, as it is here" onClick={() => void make("cover")}>
                {making === "cover" ? "Making…" : "Make the cover (PDF)"}
              </button>
            </>
          )}
        </footer>
      </div>
    </Modal>
  );
}

/** What can be changed about a piece of text. */
function TextPanel({
  text,
  disabled,
  fonts,
  licence,
  run,
  onType,
  onSet,
  onSlide,
  onCopy,
  onRemove,
  onStack,
}: {
  text: CoverText;
  disabled: boolean;
  fonts: string[];
  licence: string | null;
  /** The length its width is a part of, points. */
  run: number;
  /** A change while typing (written a moment later, one step to undo). */
  onType: (next: CoverText) => void;
  onSet: (next: CoverText) => void;
  /** A change from a slider or a colour well (many in a row). */
  onSlide: (next: CoverText) => void;
  onCopy: () => void;
  onRemove: () => void;
  onStack: (to: "top" | "bottom") => void;
}) {
  const spine = text.panel === "spine";
  const toggle = (label: string, on: boolean, icon: React.ReactNode, next: Partial<CoverText>) => (
    <button type="button" className={on ? "active" : ""} aria-pressed={on} title={label} aria-label={label} disabled={disabled} onClick={() => onSet({ ...text, ...next })}>
      {icon}
    </button>
  );
  const number = (value: string, min: number, max: number, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && value.trim() !== "" ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return (
    <section className="wf-cover-ed-group">
      <h4>{spine ? "Words on the spine" : text.panel === "back" ? "Words on the back" : "Words on the front"}</h4>
      <textarea className="wf-cover-ed-words" rows={spine ? 2 : 4} value={text.text} disabled={disabled} aria-label="The words" onChange={(e) => onType({ ...text, text: e.target.value })} />
      <div className="wf-cover-field row">
        <span>Font</span>
        <FontPicker value={text.font} docFonts={fonts} defaultLabel={fontLabel(text.font)} scope="book" disabled={disabled} onPick={(id) => id && onSet({ ...text, font: id })} />
      </div>
      <p className="wf-inspector-dim">{licence ? `${OPEN_LICENCES[licence]}. Free for commercial use.` : "An open-licensed font. Free for commercial use."}</p>
      <div className="wf-cover-field row">
        <span>Size</span>
        <span className="wf-cover-ed-size-field">
          <input type="number" min={4} max={400} step={1} value={Math.round(text.size * 10) / 10} disabled={disabled} aria-label="Size in points" onChange={(e) => onType({ ...text, size: number(e.target.value, 4, 400, text.size) })} />
          pt
        </span>
      </div>
      <div className="wf-cover-ed-seg">
        {toggle("Bold", text.bold, <Bold size={14} />, { bold: !text.bold })}
        {toggle("Italic", text.italic, <Italic size={14} />, { italic: !text.italic })}
        {toggle("Capitals", text.caps, <span className="wf-cover-ed-aa">AA</span>, { caps: !text.caps })}
        <span className="gap" />
        {toggle("Align left", text.align === "left", <AlignLeft size={14} />, { align: "left" })}
        {toggle("Centre", text.align === "center", <AlignCenter size={14} />, { align: "center" })}
        {toggle("Align right", text.align === "right", <AlignRight size={14} />, { align: "right" })}
      </div>
      <label className="wf-cover-field row">
        <span>Colour</span>
        <input type="color" value={text.color} disabled={disabled} onChange={(e) => onSlide({ ...text, color: e.target.value })} />
      </label>
      <label className="wf-cover-field">
        <span>Width</span>
        <input type="range" min={0.05} max={1.2} step={0.005} value={text.w} disabled={disabled} onChange={(e) => onSlide({ ...text, w: Number(e.target.value) })} />
      </label>
      <label className="wf-cover-field">
        <span>Space between letters</span>
        <input type="range" min={-50} max={400} step={5} value={text.tracking} disabled={disabled} onChange={(e) => onSlide({ ...text, tracking: Number(e.target.value) })} />
      </label>
      {!spine && (
        <label className="wf-cover-field">
          <span>Space between lines</span>
          <input type="range" min={0.8} max={2.4} step={0.05} value={text.leading} disabled={disabled} onChange={(e) => onSlide({ ...text, leading: Number(e.target.value) })} />
        </label>
      )}
      <label className="wf-cover-field row">
        <span>
          <input type="checkbox" checked={text.back !== null} disabled={disabled} onChange={(e) => onSet({ ...text, back: e.target.checked ? "#ffffff" : null })} /> A band of colour behind
        </span>
        {text.back !== null && <input type="color" value={text.back} disabled={disabled} onChange={(e) => onSlide({ ...text, back: e.target.value })} />}
      </label>
      <div className="wf-cover-ed-row">
        <button type="button" disabled={disabled} title="Centre it across" onClick={() => onSet({ ...text, x: (1 - text.w) / 2, align: "center" })}>
          Centre it
        </button>
        <button type="button" className="wf-icon" disabled={disabled} title="Bring to the front" aria-label="Bring to the front" onClick={() => onStack("top")}>
          <BringToFront size={14} />
        </button>
        <button type="button" className="wf-icon" disabled={disabled} title="Send to the back" aria-label="Send to the back" onClick={() => onStack("bottom")}>
          <SendToBack size={14} />
        </button>
        <button type="button" className="wf-icon" disabled={disabled} title="Make a copy" aria-label="Make a copy" onClick={onCopy}>
          <Copy size={14} />
        </button>
        <button type="button" className="wf-icon" disabled={disabled} title="Remove these words" aria-label="Remove these words" onClick={onRemove}>
          <Trash2 size={14} />
        </button>
      </div>
      <p className="wf-inspector-dim">
        {spine ? "Drag it along the spine. " : "Drag it on the cover. "}
        The arrow keys move it a point at a time. It is {Math.round((text.w * run) / 7.2) / 10} in wide.
      </p>
    </section>
  );
}
