import type { Editor } from "@tiptap/react";
import { Captions } from "lucide-react";
import { useEffect, useState } from "react";

import { CAPTION_MAX, imageCaption, selectedImage, setImageAttrs } from "../nodes/Image";
import { Flyout } from "./Flyout";

/** The line of text under the selected picture. */
export function CaptionFlyout({ editor }: { editor: Editor }) {
  const current = imageCaption(selectedImage(editor)?.node.attrs.caption) ?? "";
  return (
    <Flyout title="Caption — a line of text under the picture" icon={<Captions size={15} />} label="Caption" active={!!current} panelClass="wf-link-flyout">
      {(close) => <CaptionForm editor={editor} initial={current} close={close} />}
    </Flyout>
  );
}

function CaptionForm({ editor, initial, close }: { editor: Editor; initial: string; close: () => void }) {
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const save = (value: string | null) => {
    setImageAttrs(editor, { caption: value });
    close();
  };
  return (
    <form
      className="wf-link-form"
      onSubmit={(e) => {
        e.preventDefault();
        save(text);
      }}
    >
      <label>
        <span>Caption</span>
        <input value={text} maxLength={CAPTION_MAX} autoFocus placeholder="Figure 1. …" onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="wf-link-actions">
        {initial && (
          <button type="button" onClick={() => save(null)}>
            Remove
          </button>
        )}
        <button type="submit" className="wf-primary">
          Save
        </button>
      </div>
    </form>
  );
}
