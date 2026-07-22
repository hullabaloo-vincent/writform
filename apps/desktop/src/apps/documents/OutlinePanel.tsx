import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { useEffect, useState } from "react";

/**
 * Document outline: headings (rich format) plus scene/chapter headings
 * (screenplay/manuscript element paragraphs). Click to jump.
 */

interface OutlineEntry {
  pos: number;
  text: string;
  /** Indent tier: heading level, or 1 for element headings. */
  level: number;
}

const HEADING_ELEMENTS = new Set(["scene_heading", "chapter_heading", "act_heading", "stanza_title"]);

function collectOutline(editor: Editor): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "heading") {
      entries.push({
        pos: offset,
        text: node.textContent || "(untitled)",
        level: (node.attrs.level as number) ?? 1,
      });
    } else if (
      node.type.name === "paragraph" &&
      HEADING_ELEMENTS.has((node.attrs.element as string) ?? "")
    ) {
      entries.push({ pos: offset, text: node.textContent || "(empty)", level: 1 });
    }
  });
  return entries;
}

export function OutlinePanel({ editor }: { editor: Editor | null }) {
  const [entries, setEntries] = useState<OutlineEntry[]>([]);

  useEffect(() => {
    if (!editor) return;
    setEntries(collectOutline(editor));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setEntries(collectOutline(editor)), 300);
    };
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
      if (timer) clearTimeout(timer);
    };
  }, [editor]);

  const jump = (pos: number) => {
    if (!editor) return;
    const selectionPos = Math.min(pos + 1, editor.state.doc.content.size);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(selectionPos))),
    );
    editor.commands.scrollIntoView();
    editor.commands.focus();
  };

  return (
    <aside className="wf-doc-panel wf-doc-outline">
      <header className="wf-doc-panel-header">
        <h3>Outline</h3>
      </header>
      {entries.length === 0 ? (
        <p className="wf-session-meta" style={{ padding: "0 14px" }}>
          Headings (and scene or chapter headings) will appear here.
        </p>
      ) : (
        <ul className="wf-doc-outline-list">
          {entries.map((e) => (
            <li key={e.pos}>
              <button
                className="wf-doc-outline-item"
                style={{ paddingLeft: 10 + (e.level - 1) * 14 }}
                onClick={() => jump(e.pos)}
              >
                {e.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
