import type { Editor } from "@tiptap/react";
import { Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { applyLink, normalizeHref, removeLink } from "../format/commands";
import { Flyout } from "./Flyout";
import { withKeys } from "../commands/catalog";

function LinkForm({ editor, close }: { editor: Editor; close: () => void }) {
  const current = (editor.getAttributes("link").href as string | undefined) ?? "";
  const { empty } = editor.state.selection;
  const [href, setHref] = useState(current);
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const apply = () => {
    const clean = normalizeHref(href);
    if (!clean) {
      setBad(true);
      return;
    }
    applyLink(editor, clean, text);
    close();
  };

  return (
    <form
      className="wf-link-form"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <label>
        <span>Address</span>
        <input
          ref={inputRef}
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
      {empty && !current && (
        <label>
          <span>Text</span>
          <input type="text" placeholder="The words to show" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      )}
      {bad && <p className="wf-link-bad">That doesn’t look like a web address or an email.</p>}
      <div className="wf-link-actions">
        {current && (
          <button
            type="button"
            onClick={() => {
              removeLink(editor);
              close();
            }}
          >
            Remove link
          </button>
        )}
        <button type="submit" className="wf-primary">
          {current ? "Update" : "Link"}
        </button>
      </div>
    </form>
  );
}

/** The Link button: an address (and, with nothing selected, the words to
 *  show). On a link already, it edits or removes it. */
export function LinkFlyout({ editor, openSignal, label }: { editor: Editor; openSignal?: number; label?: string }) {
  return (
    <Flyout
      title={withKeys("Link", "Mod-Shift-k")}
      icon={<Link2 size={15} />}
      label={label}
      caret={false}
      active={editor.isActive("link")}
      className="wf-link-flyout-button"
      panelClass="wf-link-flyout"
      openSignal={openSignal}
    >
      {(close) => <LinkForm editor={editor} close={close} />}
    </Flyout>
  );
}
