import type { Editor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { presetDesign } from "../../book/model/presets";
import { scanStructure } from "../../book/model/structure";
import type { PageMapFor } from "../../editor/Paginate";
import { showRange } from "../../editor/ui/reveal";
import { Modal } from "../../platform/Modal";
import { matchHeadings, pageOf, pagePos, parseGoTo, type PageSource } from "./goTo";

/**
 * Go to a page or a heading. One field: a page's number, "+2" or "-1" for
 * pages from here, or some words of a heading (the ones that match are
 * listed as they are typed).
 *
 * The pages are page view's when it is showing them. Otherwise they are
 * worked out once, when the box opens. A book's pages are the book's own
 * (its preview has them), so a manuscript goes by headings only.
 */
export function GoToBox({
  editor,
  format,
  shown,
  ask,
  onClose,
}: {
  editor: Editor;
  format: string;
  /** Page view's pages, when it has them for the text as it is. */
  shown: () => PageMapFor | null;
  /** Work the pages out (null for a kind of document that has none here). */
  ask: PageSource | null;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState(0);
  const [pages, setPages] = useState<{ pages: number; starts: PageMapFor["starts"] } | null>(() => shown());
  const [counting, setCounting] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pages || !ask) return;
    let gone = false;
    setCounting(true);
    void ask(editor.getJSON()).then(
      (map) => {
        if (gone) return;
        setCounting(false);
        if (map) setPages(map);
      },
      () => {
        if (!gone) setCounting(false);
      },
    );
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the text as it was when the box opened
  }, []);

  const headings = useMemo(
    () => scanStructure(editor.state.doc, format, presetDesign("classic")).entries.filter((entry) => entry.title.trim()),
    [editor, format],
  );
  const here = pages ? pageOf(pages.starts, editor.state.selection.head) : 1;
  const wish = parseGoTo(text, here, pages ? pages.pages : null);
  const found = wish?.kind === "heading" ? matchHeadings(headings, wish.words).slice(0, 8) : [];

  const go = (pos: number | null) => {
    if (pos === null) return;
    onClose();
    // (At the start of what is there: a heading's own words, a page's first.)
    showRange(editor.view, Math.min(pos + 1, editor.state.doc.content.size), undefined, true);
  };
  const submit = () => {
    if (wish?.kind === "page" && pages) go(pagePos(pages.starts, wish.page));
    else if (found.length) go(found[Math.min(picked, found.length - 1)].pos);
  };

  const hint = !ask && !pages
    ? "Type some words of a heading."
    : counting
      ? "Counting pages…"
      : pages
        ? `Page ${here} of ${pages.pages}. Type a page number, +2 or -1 for pages from here, or some words of a heading.`
        : "Type some words of a heading.";

  return (
    <Modal onClose={onClose} className="wf-goto">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h3>Go to</h3>
        <input
          ref={input}
          autoFocus
          value={text}
          aria-label="Go to a page or a heading"
          placeholder={pages ? "12, +2, -1 or a heading" : "A heading"}
          onChange={(e) => {
            setText(e.target.value);
            setPicked(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setPicked((i) => Math.min(i + 1, Math.max(0, found.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setPicked((i) => Math.max(0, i - 1));
            }
          }}
        />
        <p className="wf-goto-hint">{wish?.kind === "page" && pages ? `Page ${wish.page} of ${pages.pages}` : hint}</p>
        {found.length > 0 && (
          <ul className="wf-goto-list">
            {found.map((entry, i) => (
              <li key={entry.pos}>
                <button type="button" className={i === picked ? "picked" : ""} onMouseEnter={() => setPicked(i)} onClick={() => go(entry.pos)}>
                  {entry.title}
                </button>
              </li>
            ))}
          </ul>
        )}
        {wish?.kind === "heading" && !found.length && <p className="wf-goto-hint">No heading has those words.</p>}
        <div className="wf-connect-row">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="wf-primary" disabled={!(wish?.kind === "page" && pages) && !found.length}>
            Go
          </button>
        </div>
      </form>
    </Modal>
  );
}
