import type { Editor } from "@tiptap/react";
import { Copy, ExternalLink, Pencil, Unlink } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { openLink } from "../../lib/openLink";
import { toast, toastError } from "../../platform/toast";
import { placeUnder, textWindow } from "./bubblePlace";
import { canOpenHref, describeHref, linkAtSelection, normalizeHref, unlinkAt, updateLink, type LinkHere } from "../format/commands";

const keyOf = (link: LinkHere | null): string | null => (link ? `${link.from}:${link.to}:${link.href}` : null);

function follow(href: string) {
  void openLink(href).catch((e: unknown) => toastError((e as { message?: string } | null)?.message ?? "That link couldn't be opened."));
}

/** The form behind "Edit": the link's words and where it goes. */
function EditLink({ link, onSave, onCancel }: { link: LinkHere; onSave: (href: string, text: string | null) => void; onCancel: () => void }) {
  const [text, setText] = useState(link.text);
  const [href, setHref] = useState(link.href.replace(/^mailto:/i, ""));
  const [bad, setBad] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);
  return (
    <form
      className="wf-link-form"
      onSubmit={(e) => {
        e.preventDefault();
        const clean = normalizeHref(href);
        if (!clean) {
          setBad(true);
          return;
        }
        onSave(clean, link.plain ? text : null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {link.plain && (
        <label>
          <span>Text</span>
          <input ref={first} type="text" value={text} placeholder="The words to show" onChange={(e) => setText(e.target.value)} />
        </label>
      )}
      <label>
        <span>Address</span>
        <input
          ref={link.plain ? undefined : first}
          type="text"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="example.com/page"
          value={href}
          aria-invalid={bad}
          onChange={(e) => {
            setHref(e.target.value);
            setBad(false);
          }}
        />
      </label>
      {bad && <p className="wf-link-bad">That doesn’t look like a web address or an email.</p>}
      <div className="wf-link-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="wf-primary">
          Save
        </button>
      </div>
    </form>
  );
}

/**
 * What a link is, said beside it: put the caret on a link and a small panel
 * shows where it goes, with Open, Copy, Edit (its address and its words)
 * and Remove. A click in the text therefore never follows a link by
 * accident — ⌘/Ctrl-click does, and so does any click where the document
 * can't be edited (a reader has nothing to edit, only somewhere to go).
 *
 * The panel never takes the caret out of the text: its buttons leave focus
 * where it is, and only the edit form's fields take it. Escape puts it away
 * until the caret next lands on a link.
 */
export function LinkBubble({ editor }: { editor: Editor }) {
  const [link, setLink] = useState<LinkHere | null>(null);
  const [editing, setEditing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [tick, setTick] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const key = keyOf(link);

  // Which link the caret is on, while the text (or this panel) has focus.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      timer = null;
      if (editor.isDestroyed) return;
      const inPanel = !!boxRef.current && boxRef.current.contains(document.activeElement);
      // Typing in the form: the link being edited stays as it is.
      if (inPanel) return;
      // Words selected with a mouse have the selection menu (which has
      // Link in it): two panels over one selection would be one too many.
      const selecting = !editor.state.selection.empty && !window.matchMedia?.("(pointer: coarse)").matches;
      setLink(editor.isEditable && editor.isFocused && !selecting ? linkAtSelection(editor.state) : null);
      setTick((n) => n + 1);
    };
    const sync = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (editor.isDestroyed) return;
      if (editor.isFocused) read();
      // The text has lost focus — perhaps to this panel's own form, which
      // is told so before its field has it: look once focus has landed.
      else timer = setTimeout(read, 0);
    };
    sync();
    editor.on("selectionUpdate", sync);
    editor.on("transaction", sync);
    editor.on("focus", sync);
    editor.on("blur", sync);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("selectionUpdate", sync);
      editor.off("transaction", sync);
      editor.off("focus", sync);
      editor.off("blur", sync);
    };
  }, [editor]);

  // A different link (or none): start afresh.
  useEffect(() => {
    setEditing(false);
    setDismissed((was) => (was === key ? was : null));
    if (!key) setPlace(null);
  }, [key]);

  // Clicks on links in the text: followed when asked to (⌘/Ctrl), or when
  // there is nothing else a click could mean (the text can't be edited).
  useEffect(() => {
    let dom: HTMLElement;
    try {
      dom = editor.view.dom;
    } catch {
      return; // not mounted
    }
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as Element | null)?.closest?.("a[href]");
      if (!anchor || !dom.contains(anchor)) return;
      const href = anchor.getAttribute("href") ?? "";
      // Whatever the click turns out to mean, following the link is this
      // code's decision alone — never the webview's own (which would
      // navigate, or open a window, on its own say-so).
      e.preventDefault();
      if (editor.isEditable && !(e.metaKey || e.ctrlKey)) return;
      if (canOpenHref(href)) follow(href);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(keyOf(linkAtSelection(editor.state)));
    };
    dom.addEventListener("click", onClick);
    dom.addEventListener("keydown", onKey);
    return () => {
      dom.removeEventListener("click", onClick);
      dom.removeEventListener("keydown", onKey);
    };
  }, [editor]);

  const shown = !!link && key !== dismissed;

  // Follow the text as it scrolls and the window as it changes.
  useEffect(() => {
    if (!shown) return;
    let frame = 0;
    const bump = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTick((n) => n + 1));
    };
    window.addEventListener("scroll", bump, true);
    window.addEventListener("resize", bump);
    window.visualViewport?.addEventListener("resize", bump);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", bump, true);
      window.removeEventListener("resize", bump);
      window.visualViewport?.removeEventListener("resize", bump);
    };
  }, [shown]);

  // Under the line the caret is on — or above it, when there's no room
  // (the foot of the window, the keyboard, a toolbar riding on it).
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!shown || !box || editor.isDestroyed) return;
    try {
      const caret = editor.view.coordsAtPos(editor.state.selection.from);
      // Null once the link has scrolled out of the page's view: the panel
      // goes with it rather than floating on over the toolbar.
      setPlace(placeUnder(caret, box.getBoundingClientRect(), textWindow(editor.view.dom)));
    } catch {
      // The caret's place can't be measured (not laid out yet): next time.
    }
  }, [shown, editing, tick, key, editor]);

  if (!shown || !link) return null;

  const stay = (e: { preventDefault(): void }) => e.preventDefault();
  const copy = () =>
    void navigator.clipboard
      .writeText(link.href)
      .then(() => toast("Link copied.", "success"))
      .catch(() => toastError("The link couldn't be copied."));

  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label="Link"
      className={`wf-flyout wf-link-bubble${editing ? " editing" : ""}`}
      style={{ left: place?.left ?? -9999, top: place?.top ?? 0 }}
    >
      {editing ? (
        <EditLink
          link={link}
          onCancel={() => {
            setEditing(false);
            editor.view.focus();
          }}
          onSave={(href, text) => {
            // Where the link is now (the text may have moved while typing here).
            const now = linkAtSelection(editor.state) ?? link;
            setEditing(false);
            updateLink(editor, now, href, text);
          }}
        />
      ) : (
        <div className="wf-link-row">
          <button
            type="button"
            className="wf-link-where"
            title={canOpenHref(link.href) ? `Open ${link.href}` : link.href}
            disabled={!canOpenHref(link.href)}
            onMouseDown={stay}
            onClick={() => follow(link.href)}
          >
            <ExternalLink size={14} />
            <span>{describeHref(link.href)}</span>
          </button>
          <button type="button" className="wf-icon" title="Copy the link" aria-label="Copy the link" onMouseDown={stay} onClick={copy}>
            <Copy size={14} />
          </button>
          <button type="button" className="wf-icon" title="Edit the link and its text" aria-label="Edit the link and its text" onMouseDown={stay} onClick={() => setEditing(true)}>
            <Pencil size={14} />
          </button>
          <button
            type="button"
            className="wf-icon"
            title="Remove the link (the text stays)"
            aria-label="Remove the link"
            onMouseDown={stay}
            onClick={() => unlinkAt(editor, linkAtSelection(editor.state) ?? link)}
          >
            <Unlink size={14} />
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
