import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { useEffect } from "react";

import { docContentExtensions } from "./schema/content";

/**
 * A document rendered read-only with the full document schema — version
 * previews and document cards on boards. (RichDoc renders session prompts
 * with the level-1 schema, which would show a newer document as empty.)
 */
export function DocPreview({ doc, format }: { doc: JSONContent | null; format?: string }) {
  const editor = useEditor({
    extensions: docContentExtensions(),
    content: doc ?? undefined,
    editable: false,
  });

  useEffect(() => {
    if (editor && doc) editor.commands.setContent(doc);
  }, [editor, doc]);

  return (
    <div className={`wf-rich-wrap${format ? ` wf-fmt-${format}` : ""}`}>
      <EditorContent className="wf-rich" editor={editor} />
    </div>
  );
}
