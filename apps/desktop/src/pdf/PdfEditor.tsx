import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileInput,
  FileOutput,
  FilePlus,
  Highlighter,
  Layers,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Redo2,
  RotateCcw,
  RotateCw,
  Search,
  Signature,
  Square,
  StickyNote,
  Strikethrough,
  TextCursorInput,
  Trash2,
  Type,
  Underline,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { PasswordForm } from "../apps/documents/import/PdfImportDialog";
import { isPdfUnavailable } from "../lib/pdfjs";
import { saveExport } from "../lib/saveFile";
import { confirmDialog } from "../platform/confirm";
import { toast } from "../platform/toast";
import { usePdfDesk } from "./desk";
import { isEngineFail, type EngineFail, type FieldInfo } from "./engine/client";
import { PageOverlay, selectedLines, type Signing, type Tool } from "./PdfOverlay";
import { PageFrame, Thumb } from "./PdfPage";
import { findInPdf, type Hit, type PageText } from "./search";
import { PdfSession } from "./session";
import { canKeepPdfs, usePdfShelf } from "./shelf";
import { SignDialog } from "./SignDialog";

/**
 * A PDF open in Documents: its pages to read, search and rearrange, and a
 * copy of it to save.
 *
 * The file itself is never written over. What is changed here is changed
 * in memory, and "Save a copy" writes the result where the person says.
 */

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];

/** The tools that make something on a page, in the order they are offered. */
const TOOLS: { id: Tool; label: string; hint: string; icon: React.ReactNode; needs: "annotate" | "fillForms" | "changeText" | null }[] = [
  { id: "read", label: "Read", hint: "Read and select", icon: <MousePointer2 size={16} />, needs: null },
  { id: "note", label: "Note", hint: "Click the page where a note goes", icon: <StickyNote size={16} />, needs: "annotate" },
  { id: "draw", label: "Draw", hint: "Draw on the page", icon: <Pencil size={16} />, needs: "annotate" },
  { id: "box", label: "Box", hint: "Drag a box round something", icon: <Square size={16} />, needs: "annotate" },
  { id: "arrow", label: "Arrow", hint: "Drag an arrow to something", icon: <MoveUpRight size={16} />, needs: "annotate" },
  { id: "type", label: "Type", hint: "Click the page and type", icon: <Type size={16} />, needs: "annotate" },
  { id: "sign", label: "Sign", hint: "Put your signature on the page", icon: <Signature size={16} />, needs: "fillForms" },
  { id: "edit", label: "Change text", hint: "Click a piece of the page’s own text to change it", icon: <TextCursorInput size={16} />, needs: "changeText" },
];

/** What went wrong, as a sentence for whoever is using it. */
function sayFail(e: unknown): string {
  if (isPdfUnavailable(e)) return (e as { message: string }).message;
  if (!isEngineFail(e)) return "That could not be done.";
  switch (e.code) {
    case "NotPermitted":
      return "Whoever made this PDF does not allow that change.";
    case "Unsupported":
      return "This PDF is protected in a way that cannot be opened here.";
    case "Crashed":
      return "Something went wrong and the last step was not made. The PDF is as it was before it.";
    default:
      return e.message ? `${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}.`.replace(/\.\.$/, ".") : "That could not be done.";
  }
}

/** Which of some scrolled things are near the part in view. */
function useNear(count: number, selector: string, margin: string): [React.RefObject<HTMLDivElement | null>, Set<number>] {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState<Set<number>>(() => new Set([0, 1, 2]));
  useEffect(() => {
    const holder = ref.current;
    if (!holder) return;
    // (Nothing to watch with: the first few are drawn.)
    if (typeof IntersectionObserver === "undefined") return;
    const seen = new Set<number>();
    const watcher = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const k = Number((entry.target as HTMLElement).dataset.index);
          if (entry.isIntersecting) seen.add(k);
          else seen.delete(k);
        }
        setNear(new Set(seen));
      },
      { root: holder, rootMargin: margin },
    );
    holder.querySelectorAll(selector).forEach((el) => watcher.observe(el));
    return () => watcher.disconnect();
  }, [count, selector, margin]);
  return [ref, near];
}

function PdfRoom({ session, onClose }: { session: PdfSession; onClose: () => void }) {
  useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    () => session.ticks,
  );
  const { info, revision, busy } = session;
  const count = info.pages.length;
  // (Whoever would show something else in its place asks first: desk.ts.)
  const setDirty = usePdfDesk((d) => d.setDirty);
  useEffect(() => setDirty(info.modified), [setDirty, info.modified]);
  const base = session.name.replace(/\.pdf$/i, "") || "Document";

  const [zoom, setZoom] = useState(1);
  const [paneWidth, setPaneWidth] = useState(820);
  const [paneRef, near] = useNear(count, ".wf-pdf-slot", "900px 0px");
  const [railRef, nearThumbs] = useNear(count, ".wf-pdf-thumb", "400px 0px");
  const [stamps, setStamps] = useState<number[]>(() => info.pages.map(() => 0));
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [current, setCurrent] = useState(0);
  const [dropAt, setDropAt] = useState<number | null>(null);

  // Which pages have to be drawn again after a change.
  useEffect(() => {
    const change = session.lastChange;
    setStamps((prev) => session.info.pages.map((_, k) => (!change || change.structureChanged || change.changedPages.includes(k) || prev[k] === undefined ? revision : prev[k])));
  }, [session, revision]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const measure = () => setPaneWidth(pane.clientWidth || 820);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watcher = new ResizeObserver(measure);
    watcher.observe(pane);
    return () => watcher.disconnect();
  }, [paneRef]);

  // Every page as wide as the widest fits, times the zoom.
  const widest = Math.max(1, ...info.pages.map((page) => page.w));
  const fit = Math.min(2, Math.max(0.15, (paneWidth - 56) / widest));
  const widthOf = (k: number) => Math.round(info.pages[k].w * fit * zoom);

  // The page being looked at: the one across the middle of the pane.
  const onScroll = () => {
    const pane = paneRef.current;
    if (!pane) return;
    const middle = pane.scrollTop + pane.clientHeight / 2;
    const slots = pane.querySelectorAll<HTMLElement>(".wf-pdf-slot");
    for (let k = 0; k < slots.length; k += 1) {
      if (slots[k].offsetTop + slots[k].offsetHeight >= middle) {
        setCurrent(k);
        return;
      }
    }
  };
  const showPage = (k: number) => {
    const pane = paneRef.current;
    const slot = pane?.querySelectorAll<HTMLElement>(".wf-pdf-slot")[k];
    if (pane && slot) pane.scrollTop = slot.offsetTop - 12;
    setCurrent(k);
  };

  // ------------------------------------------------------------- search
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [at, setAt] = useState(-1);
  const [searching, setSearching] = useState(false);
  const texts = useRef<{ revision: number; pages: Map<number, PageText> }>({ revision, pages: new Map() });
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (texts.current.revision !== revision) texts.current = { revision, pages: new Map() };
    if (!query.trim()) {
      setHits([]);
      setAt(-1);
      setSearching(false);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      void findInPdf(session.pdf, query, texts.current.pages, ctrl.signal)
        .then((found) => {
          if (ctrl.signal.aborted) return;
          setHits(found);
          setAt(found.length ? 0 : -1);
          setSearching(false);
        })
        .catch(() => setSearching(false));
    }, 220);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [session, revision, query]);
  // The match stepped to is brought into view.
  useEffect(() => {
    const hit = hits[at];
    const pane = paneRef.current;
    const slot = hit ? pane?.querySelectorAll<HTMLElement>(".wf-pdf-slot")[hit.page] : undefined;
    if (!hit || !pane || !slot) return;
    const top = slot.offsetTop + hit.rects[0].y * slot.offsetHeight;
    if (top < pane.scrollTop + 40 || top > pane.scrollTop + pane.clientHeight - 80) pane.scrollTop = Math.max(0, top - pane.clientHeight / 3);
  }, [hits, at, paneRef]);
  const step = (by: number) => {
    if (hits.length) setAt((k) => (k + by + hits.length) % hits.length);
  };
  const hitsOn = useMemo(() => {
    const by = new Map<number, { hits: Hit[]; current: number }>();
    hits.forEach((hit, k) => {
      const entry = by.get(hit.page) ?? { hits: [], current: -1 };
      if (k === at) entry.current = entry.hits.length;
      entry.hits.push(hit);
      by.set(hit.page, entry);
    });
    return by;
  }, [hits, at]);

  // ------------------------------------------------------------ tools
  const [tool, setTool] = useState<Tool>("read");
  const [signing, setSigning] = useState<Signing | null>(null);
  const [askSign, setAskSign] = useState(false);
  const [fields, setFields] = useState<FieldInfo[]>([]);
  // The form's fields, as they stand after every change.
  useEffect(() => {
    let gone = false;
    void session.read("fields").then(
      (list) => {
        if (!gone) setFields(list);
      },
      () => {
        if (!gone) setFields([]);
      },
    );
    return () => {
      gone = true;
    };
  }, [session, revision]);
  const take = (next: Tool) => {
    if (next === "sign" && !signing) setAskSign(true);
    setTool(next);
  };

  // ------------------------------------------------------------ changes
  const warned = useRef(false);
  const act = async (run: () => Promise<unknown>) => {
    if (session.busy) return;
    // A signature vouches for the file as it was signed: say so, once.
    if (info.signed && !warned.current) {
      if (!(await confirmDialog("This PDF is signed. Changing it means the signature no longer vouches for it.", { title: "Change a signed PDF?", confirmLabel: "Change it" }))) return;
      warned.current = true;
    }
    try {
      await run();
    } catch (e) {
      toast(sayFail(e), "error");
    }
  };
  /** The pages a tool acts on: those picked, or the one being looked at. */
  const targets = (): number[] => (selected.size ? [...selected].sort((a, b) => a - b) : [Math.min(current, count - 1)]);
  const pick = (pages: number[]) => setSelected(new Set(pages));

  const rotate = (degrees: number) => act(() => session.change("rotate", targets(), degrees));
  const remove = () =>
    act(async () => {
      const pages = targets();
      if (pages.length >= count) {
        toast("A PDF keeps at least one page.", "info");
        return;
      }
      await session.change("deletePages", pages);
      pick([]);
    });
  const duplicate = () =>
    act(async () => {
      const pages = targets();
      await session.change("duplicatePages", pages);
      const after = pages[pages.length - 1] + 1;
      pick(pages.map((_, k) => after + k));
    });
  const moveTo = (pages: number[], gap: number) =>
    act(async () => {
      // (Where they go is counted among the pages left once they are out.)
      const to = gap - pages.filter((p) => p < gap).length;
      const first = pages[0];
      const together = pages.every((p, k) => p === first + k);
      if (together && to === first) return;
      await session.change("movePages", pages, to);
      pick(pages.map((_, k) => to + k));
    });
  const nudge = (by: -1 | 1) => {
    const pages = targets();
    const gap = by < 0 ? pages[0] - 1 : pages[pages.length - 1] + 2;
    if (gap < 0 || gap > count) return;
    void moveTo(pages, gap);
  };
  const addBlank = () =>
    act(async () => {
      const after = targets().pop() ?? count - 1;
      const like = info.pages[after];
      await session.change("insertBlank", after + 1, like.w, like.h);
      pick([after + 1]);
    });
  const otherRef = useRef<HTMLInputElement>(null);
  const addFrom = (file: File | undefined) =>
    act(async () => {
      if (!file) return;
      const after = targets().pop() ?? count - 1;
      const before = count;
      try {
        await session.change("insertFrom", new Uint8Array(await file.arrayBuffer()), undefined, [], after + 1);
      } catch (e) {
        const code = (e as EngineFail | null)?.code;
        if (code === "NeedsPassword" || code === "WrongPassword") throw { code: "Invalid", message: "that PDF has a password. Open it on its own and save a copy without one first" } satisfies EngineFail;
        throw e;
      }
      const added = session.info.pages.length - before;
      pick(Array.from({ length: added }, (_, k) => after + 1 + k));
    });
  const splitOut = () =>
    act(async () => {
      const pages = targets();
      await saveExport(`${base} (page${pages.length === 1 ? ` ${pages[0] + 1}` : "s"})`, "pdf", await session.extract(pages));
    });
  const saveCopy = () =>
    act(async () => {
      const result = await saveExport(base, "pdf", await session.copy());
      if (result.status === "saved") await session.markSaved();
    });
  // Kept on this device, it is saved in place (see shelf.ts).
  const shelfId = usePdfDesk((d) => d.open?.shelfId ?? null);
  const keep = () =>
    act(async () => {
      const meta = await usePdfShelf.getState().keep(shelfId, session.name, await session.copy());
      usePdfDesk.getState().kept(meta.id);
      await session.markSaved();
      toast(shelfId ? "Saved on this device." : "Kept on this device. You will find it in Documents.", "success");
    });
  /** Mark the lines of text that are selected. */
  const markSelected = (kind: "highlight" | "underline" | "strikeout") =>
    act(async () => {
      const pane = paneRef.current;
      const lines = pane ? selectedLines(pane) : new Map<number, never[]>();
      if (!lines.size) {
        toast("Select some text on a page first.", "info");
        return;
      }
      for (const [page, rects] of lines) await session.change("addMark", { page, kind, rects });
      window.getSelection()?.removeAllRanges();
    });
  const bakeIn = () =>
    act(async () => {
      if (!(await confirmDialog("Signatures, ticks and typed words become part of the pages. They can then no longer be moved or taken off.", { title: "Make them part of the pages?", confirmLabel: "Make them part" }))) return;
      await session.change("flattenFillSign", []);
    });
  const close = async () => {
    if (info.modified && !(await confirmDialog("Your changes to this PDF are not in any file yet. Save a copy first to keep them.", { title: "Close without saving?", confirmLabel: "Close", danger: true }))) return;
    onClose();
  };

  // (The key for saving does whichever saving this PDF has, as it is now.)
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveRef.current = () => void (shelfId ? keep() : saveCopy());
  });
  // Keys: find, save, undo and redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement | null)?.tagName ?? "");
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      } else if (mod && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        void (e.shiftKey ? session.redo() : session.undo()).catch((err: unknown) => toast(sayFail(err), "error"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session]);

  // ----------------------------------------------- the list of pages
  const drag = useRef<{ from: number; y: number; moving: boolean } | null>(null);
  const gapAt = (y: number): number => {
    const thumbs = railRef.current?.querySelectorAll<HTMLElement>(".wf-pdf-thumb") ?? [];
    for (let k = 0; k < thumbs.length; k += 1) {
      const box = thumbs[k].getBoundingClientRect();
      if (y < box.top + box.height / 2) return k;
    }
    return thumbs.length;
  };
  const onThumbDown = (k: number, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { from: k, y: e.clientY, moving: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onThumbMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !info.may.changePages) return;
    if (!d.moving && Math.abs(e.clientY - d.y) > 6) d.moving = true;
    if (d.moving) setDropAt(gapAt(e.clientY));
  };
  const onThumbUp = (k: number, e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moving) {
      const gap = dropAt ?? gapAt(e.clientY);
      setDropAt(null);
      void moveTo(selected.has(d.from) ? [...selected].sort((a, b) => a - b) : [d.from], gap);
      return;
    }
    // A click: this page, with the others picked (ctrl or command), or all
    // the pages from the last one picked to this (shift).
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      setSelected(next);
    } else if (e.shiftKey && selected.size) {
      const anchor = [...selected].sort((a, b) => a - b)[0];
      pick(Array.from({ length: Math.abs(k - anchor) + 1 }, (_, j) => Math.min(k, anchor) + j));
    } else pick([k]);
    showPage(k);
  };

  const canChange = info.may.changePages && !busy;
  const zoomBy = (by: -1 | 1) => {
    const k = ZOOM_STEPS.findIndex((z) => z >= zoom - 0.001);
    setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (k < 0 ? ZOOM_STEPS.length - 1 : k) + by))]);
  };

  return (
    <div className="wf-doc-room wf-pdf-room">
      <header className="wf-session-room-header wf-doc-header wf-pdf-header">
        <button title="Back to documents" onClick={() => void close()}>
          ←
        </button>
        <span className="wf-pdf-name" title={session.name}>
          {session.name}
        </span>
        <span className="wf-pdf-count">
          Page {Math.min(current, count - 1) + 1} of {count}
        </span>
        <span className="wf-pdf-spacer" />
        <button title="Undo" disabled={!info.canUndo || busy} onClick={() => void act(() => session.undo())}>
          <Undo2 size={17} />
        </button>
        <button title="Redo" disabled={!info.canRedo || busy} onClick={() => void act(() => session.redo())}>
          <Redo2 size={17} />
        </button>
        <button title="Smaller" disabled={zoom <= ZOOM_STEPS[0]} onClick={() => zoomBy(-1)}>
          <ZoomOut size={17} />
        </button>
        <span className="wf-pdf-zoom">{Math.round(zoom * 100)}%</span>
        <button title="Larger" disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} onClick={() => zoomBy(1)}>
          <ZoomIn size={17} />
        </button>
        <label className="wf-pdf-search">
          <Search size={15} />
          <input
            ref={searchRef}
            type="search"
            placeholder="Find in this PDF"
            aria-label="Find in this PDF"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
              else if (e.key === "Escape") setQuery("");
            }}
          />
          {query.trim() !== "" && <span className="wf-pdf-found">{searching ? "Looking" : hits.length ? `${at + 1} of ${hits.length}` : "None"}</span>}
        </label>
        <button title="Previous match" disabled={!hits.length} onClick={() => step(-1)}>
          <ChevronUp size={17} />
        </button>
        <button title="Next match" disabled={!hits.length} onClick={() => step(1)}>
          <ChevronDown size={17} />
        </button>
        {canKeepPdfs() && (
          <button className="wf-pdf-save" title={shelfId ? "Save this PDF on this device" : "Keep this PDF on this device, to come back to"} disabled={busy || (!!shelfId && !info.modified)} onClick={() => void keep()}>
            {shelfId ? "Save" : "Keep on this device"}
          </button>
        )}
        <button className="wf-pdf-save" title="Save a copy of this PDF as it is now" disabled={busy} onClick={() => void saveCopy()}>
          <Download size={16} /> Save a copy
        </button>
      </header>
      <div className="wf-pdf-toolbar" role="toolbar" aria-label="Tools">
        {TOOLS.map((item) => {
          const allowed = item.needs === null || info.may[item.needs];
          return (
            <button key={item.id} className={tool === item.id ? "active" : ""} title={allowed ? item.hint : "Whoever made this PDF does not allow that"} aria-pressed={tool === item.id} disabled={!allowed} onClick={() => take(item.id)}>
              {item.icon}
              <span>{item.label}</span>
              {item.id === "edit" && <em>Beta</em>}
            </button>
          );
        })}
        <span className="wf-pdf-rule" />
        <button title="Highlight the selected text" disabled={!info.may.annotate || busy} onClick={() => void markSelected("highlight")}>
          <Highlighter size={16} />
          <span>Highlight</span>
        </button>
        <button title="Underline the selected text" disabled={!info.may.annotate || busy} onClick={() => void markSelected("underline")}>
          <Underline size={16} />
        </button>
        <button title="Strike through the selected text" disabled={!info.may.annotate || busy} onClick={() => void markSelected("strikeout")}>
          <Strikethrough size={16} />
        </button>
        <span className="wf-pdf-rule" />
        <button title="Make signatures, ticks and typed words part of the pages" disabled={!info.may.fillForms || busy} onClick={() => void bakeIn()}>
          <Layers size={16} />
          <span>Make part of the page</span>
        </button>
        {tool !== "read" && <span className="wf-pdf-hint">{tool === "sign" && !signing ? "Draw your signature first" : TOOLS.find((item) => item.id === tool)?.hint}</span>}
      </div>
      {askSign && (
        <SignDialog
          onCancel={() => {
            setAskSign(false);
            setTool("read");
          }}
          onDone={(signature) => {
            setSigning(signature);
            setAskSign(false);
          }}
        />
      )}
      <div className="wf-pdf-body">
        <aside className="wf-pdf-rail">
          <div className="wf-pdf-tools" role="toolbar" aria-label="Pages">
            <button title="Turn left" disabled={!canChange} onClick={() => void rotate(-90)}>
              <RotateCcw size={16} />
            </button>
            <button title="Turn right" disabled={!canChange} onClick={() => void rotate(90)}>
              <RotateCw size={16} />
            </button>
            <button title="Move up" disabled={!canChange} onClick={() => nudge(-1)}>
              <ArrowUp size={16} />
            </button>
            <button title="Move down" disabled={!canChange} onClick={() => nudge(1)}>
              <ArrowDown size={16} />
            </button>
            <button title="Make a copy of the page" disabled={!canChange} onClick={() => void duplicate()}>
              <Copy size={16} />
            </button>
            <button title="Add an empty page after" disabled={!canChange} onClick={() => void addBlank()}>
              <FilePlus size={16} />
            </button>
            <button title="Add the pages of another PDF after" disabled={!canChange} onClick={() => otherRef.current?.click()}>
              <FileInput size={16} />
            </button>
            <button title="Save these pages as a PDF of their own" disabled={busy} onClick={() => void splitOut()}>
              <FileOutput size={16} />
            </button>
            <button title="Take the page out" disabled={!canChange || count < 2} onClick={() => void remove()}>
              <Trash2 size={16} />
            </button>
            <input
              ref={otherRef}
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                void addFrom(file);
              }}
            />
          </div>
          {!info.may.changePages && <p className="wf-pdf-note">Whoever made this PDF does not allow its pages to be changed.</p>}
          <div ref={railRef} className="wf-pdf-thumbs">
            {info.pages.map((_, k) => (
              <div
                key={k}
                data-index={k}
                className={`wf-pdf-thumb${selected.has(k) ? " selected" : ""}${k === current ? " current" : ""}${dropAt === k ? " drop-before" : ""}${dropAt === count && k === count - 1 ? " drop-after" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`Page ${k + 1}`}
                aria-pressed={selected.has(k)}
                onPointerDown={(e) => onThumbDown(k, e)}
                onPointerMove={onThumbMove}
                onPointerUp={(e) => onThumbUp(k, e)}
                onPointerCancel={() => {
                  drag.current = null;
                  setDropAt(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    pick([k]);
                    showPage(k);
                  }
                }}
              >
                <Thumb session={session} index={k} stamp={stamps[k] ?? revision} near={nearThumbs.has(k)} />
                <span>{k + 1}</span>
              </div>
            ))}
          </div>
        </aside>
        <div ref={paneRef} className="wf-pdf-pane" onScroll={onScroll}>
          {info.pages.map((_, k) => {
            const found = hitsOn.get(k);
            return (
              <div key={k} data-index={k} className="wf-pdf-slot">
                <PageFrame session={session} index={k} width={widthOf(k)} stamp={stamps[k] ?? revision} near={near.has(k)} hits={found?.hits ?? []} current={found?.current ?? -1}>
                  <PageOverlay
                    session={session}
                    index={k}
                    width={widthOf(k)}
                    stamp={stamps[k] ?? revision}
                    near={near.has(k)}
                    tool={tool}
                    signing={signing}
                    fields={fields}
                    act={act}
                    onPlaced={() => {
                      setSigning(null);
                      setTool("read");
                    }}
                  />
                </PageFrame>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The editor for the PDF that is open (see desk.ts), with its password
 *  asked for first where it has one. */
export function PdfEditor() {
  const open = usePdfDesk((s) => s.open);
  const closeDesk = usePdfDesk((s) => s.close);
  const [session, setSession] = useState<PdfSession | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ again: boolean } | null>(null);
  // (Each try is its own: the same wrong password typed again is tried again.)
  const [attempt, setAttempt] = useState<{ password?: string }>({});

  const name = open?.name;
  const bytes = open?.bytes;
  useEffect(() => {
    if (!name || !bytes) return;
    let gone = false;
    let made: PdfSession | null = null;
    PdfSession.open(name, bytes, attempt.password).then(
      (opened) => {
        if (gone) {
          opened.close();
          return;
        }
        made = opened;
        setAsking(null);
        setSession(opened);
      },
      (e: unknown) => {
        if (gone) return;
        const code = (e as EngineFail | null)?.code;
        if (code === "NeedsPassword" || code === "WrongPassword") setAsking({ again: code === "WrongPassword" });
        else setFailed(sayFail(e));
      },
    );
    return () => {
      gone = true;
      made?.close();
      setSession(null);
    };
    // (Not `open` itself: that is made anew when the PDF is kept on the
    // device, which is no reason to open it again.)
  }, [name, bytes, attempt]);

  if (!open) return null;
  if (session) return <PdfRoom key={session.name} session={session} onClose={closeDesk} />;
  return (
    <div className="wf-doc-room wf-pdf-room">
      <header className="wf-session-room-header wf-doc-header wf-pdf-header">
        <button title="Back to documents" onClick={closeDesk}>
          ←
        </button>
        <span className="wf-pdf-name">{open.name}</span>
      </header>
      <div className="wf-pdf-waiting">{failed ?? (asking ? "" : "Opening the PDF")}</div>
      {asking && !failed && (
        <PasswordForm
          key={String(asking.again)}
          again={asking.again}
          onAnswer={(typed) => {
            if (typed === null) closeDesk();
            else setAttempt({ password: typed });
          }}
        />
      )}
    </div>
  );
}
