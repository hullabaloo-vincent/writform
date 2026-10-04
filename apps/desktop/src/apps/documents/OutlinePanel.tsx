import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { AlertTriangle, ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { blockOffsets, scanStructure, type StructureEntry } from "../../book/model/structure";
import type { BookDesign } from "../../book/model/presets";
import { presetDesign } from "../../book/model/presets";
import { confirmDialog } from "../../platform";

/**
 * The document's outline — for a manuscript, its binder: parts, chapters
 * and sections with the numbers the book will print, a word count for each,
 * the chapter you're in highlighted. Chapters (with everything under them)
 * reorder by drag on desktop, or with ↑/↓ in Reorder mode on a phone.
 */

const isPhone = () => window.matchMedia("(max-width: 767px)").matches;

type OutlineDesign = Pick<BookDesign, "chapterNumber" | "chapterLabel" | "restartNumbersInParts">;

export function OutlinePanel({
  editor,
  format = "none",
  design,
  commentRanges,
  onNavigate,
  onTidy,
}: {
  editor: Editor | null;
  format?: string;
  design?: OutlineDesign;
  /** Anchored comment ranges, so a move can warn before detaching them. */
  commentRanges?: () => { from: number; to: number }[];
  /** Called after a jump (phones close the overlay). */
  onNavigate?: () => void;
  /** Manuscripts: find structure that isn't marked yet. */
  onTidy?: () => void;
}) {
  const numbering = design ?? presetDesign("classic");
  const scan = useCallback(
    () =>
      editor
        ? scanStructure(editor.state.doc, format, numbering, { words: true })
        : { entries: [], total: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- numbering fields are the deps
    [editor, format, numbering.chapterNumber, numbering.chapterLabel, numbering.restartNumbersInParts],
  );
  const [{ entries, total }, setStructure] = useState(scan);
  const [current, setCurrent] = useState(-1);
  const [reorder, setReorder] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  // Text changes rescan (debounced; counts are cached per paragraph).
  useEffect(() => {
    if (!editor) return;
    setStructure(scan());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setStructure(scan()), 300);
    };
    editor.on("update", update);
    return () => {
      editor.off("update", update);
      if (timer) clearTimeout(timer);
    };
  }, [editor, scan]);

  // The entry containing the cursor.
  useEffect(() => {
    if (!editor) return;
    const locate = () => {
      const at = editor.state.selection.from;
      let lo = 0;
      let hi = entries.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid].pos <= at) {
          found = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      setCurrent(found);
    };
    locate();
    editor.on("selectionUpdate", locate);
    return () => {
      editor.off("selectionUpdate", locate);
    };
  }, [editor, entries]);

  const movable = useMemo(
    () => format === "manuscript" && !!editor?.isEditable,
    [format, editor],
  );

  const jump = (pos: number) => {
    if (!editor) return;
    const selectionPos = Math.min(pos + 1, editor.state.doc.content.size);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(selectionPos))),
    );
    editor.commands.scrollIntoView();
    editor.commands.focus();
    if (isPhone()) onNavigate?.();
  };

  /** Move `entry`'s whole section so it starts at block `targetIndex`. */
  const moveTo = async (entry: StructureEntry, targetIndex: number) => {
    if (!editor) return;
    if (targetIndex >= entry.index && targetIndex <= entry.endIndex) return;
    const offsets = blockOffsets(editor.state.doc);
    const start = offsets[entry.index];
    const end = offsets[entry.endIndex];
    const target = offsets[targetIndex];
    const anchored = (commentRanges?.() ?? []).filter((r) => r.from < end && r.to > start);
    if (anchored.length > 0) {
      const ok = await confirmDialog(
        `${anchored.length} comment${anchored.length === 1 ? " is" : "s are"} attached to text in “${entry.title || entry.label || entry.text}”. Moving it detaches ${anchored.length === 1 ? "it" : "them"} from that text.`,
        { title: "Move section", confirmLabel: "Move anyway" },
      );
      if (!ok) return;
    }
    const doc = editor.state.doc;
    const content = doc.slice(start, end).content;
    const tr = editor.state.tr;
    if (target > end) {
      tr.insert(target, content);
      tr.delete(start, end);
    } else {
      tr.delete(start, end);
      tr.insert(target, content);
    }
    editor.view.dispatch(tr.scrollIntoView());
  };

  const siblingIndex = (i: number, dir: -1 | 1): number | null => {
    const entry = entries[i];
    for (let j = i + dir; j >= 0 && j < entries.length; j += dir) {
      if (entries[j].level < entry.level && dir === 1) return null;
      if (entries[j].level <= entry.level) return j;
    }
    return null;
  };

  const moveBy = (i: number, dir: -1 | 1) => {
    const j = siblingIndex(i, dir);
    if (j === null) return;
    const entry = entries[i];
    const other = entries[j];
    void moveTo(entry, dir === -1 ? other.index : other.endIndex);
  };

  const canMove = (entry: StructureEntry) =>
    movable && (entry.kind === "chapter" || entry.kind === "part" || entry.kind === "section");

  return (
    <aside className="wf-doc-panel wf-doc-outline">
      <header className="wf-doc-panel-header">
        <h3>Outline</h3>
        {total > 0 && (
          <span className="wf-doc-outline-total">{total.toLocaleString()} words</span>
        )}
        <span className="wf-statusbar-spacer" />
        {movable && onTidy && (
          <button
            className="wf-doc-outline-reorder"
            title="Find chapter headings, scene breaks and stray indents that aren’t marked yet"
            onClick={onTidy}
          >
            Tidy up…
          </button>
        )}
        {movable && entries.some(canMove) && (
          <button
            className={`wf-doc-outline-reorder ${reorder ? "active" : ""}`}
            onClick={() => setReorder((v) => !v)}
          >
            {reorder ? "Done" : "Reorder"}
          </button>
        )}
      </header>
      {entries.length === 0 ? (
        <p className="wf-session-meta" style={{ padding: "0 14px" }}>
          {format === "manuscript"
            ? "Chapter, part and section headings appear here. Pick “Chapter Heading” from the element menu (⌘1)."
            : "Headings (and scene or chapter headings) will appear here."}
        </p>
      ) : (
        <ul className="wf-doc-outline-list">
          {entries.map((entry, i) => {
            const draggable = canMove(entry) && !reorder;
            const name = entry.title || (entry.literal === null ? entry.text : "") || "Untitled";
            return (
              <li
                key={`${entry.index}-${entry.text}`}
                className={[
                  i === current ? "current" : "",
                  dropAt === i && dragFrom !== null && dragFrom !== i ? "drop-target" : "",
                ].join(" ")}
                draggable={draggable}
                onDragStart={(e) => {
                  setDragFrom(i);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(i));
                }}
                onDragOver={(e) => {
                  if (dragFrom === null || !canMove(entry)) return;
                  e.preventDefault();
                  setDropAt(i);
                }}
                onDragLeave={() => setDropAt((at) => (at === i ? null : at))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== null && dragFrom !== i) {
                    void moveTo(entries[dragFrom], entry.index);
                  }
                  setDragFrom(null);
                  setDropAt(null);
                }}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDropAt(null);
                }}
              >
                <button
                  className="wf-doc-outline-item"
                  style={{ paddingLeft: 10 + entry.level * 14 }}
                  onClick={() => jump(entry.pos)}
                  title={entry.mismatch ? `Typed as ${entry.literal}; prints as ${entry.label}` : undefined}
                >
                  {draggable && <GripVertical size={12} className="wf-doc-outline-grip" />}
                  <span className="wf-doc-outline-text">
                    {entry.label && (entry.kind === "chapter" || entry.kind === "part") && (
                      <span className="wf-doc-outline-label">
                        {entry.label}
                        {name !== "Untitled" || entry.literal === null ? " · " : ""}
                      </span>
                    )}
                    {entry.literal !== null && !entry.title ? "" : name}
                  </span>
                  {entry.mismatch && <AlertTriangle size={12} className="wf-doc-outline-warn" />}
                  {entry.words > 0 && entry.kind !== "subheading" && (
                    <span className="wf-doc-outline-words">{entry.words.toLocaleString()}</span>
                  )}
                </button>
                {reorder && canMove(entry) && (
                  <span className="wf-doc-outline-moves">
                    <button
                      title="Move up"
                      disabled={siblingIndex(i, -1) === null}
                      onClick={() => moveBy(i, -1)}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      title="Move down"
                      disabled={siblingIndex(i, 1) === null}
                      onClick={() => moveBy(i, 1)}
                    >
                      <ArrowDown size={14} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
