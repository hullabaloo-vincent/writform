import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";

/**
 * Shared TipTap editor — used for prompts and submissions (and later by the
 * `editor` plugin API). Docs are TipTap JSON; the server sanitizes size/depth.
 */
export function RichEditor({
  value,
  onChange,
  editable = true,
  placeholder,
  autoFocus,
}: {
  value: JSONContent | null;
  onChange?: (doc: JSONContent) => void;
  editable?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Image.configure({ allowBase64: false }),
      Placeholder.configure({ placeholder: placeholder ?? "Write…" }),
    ],
    content: value ?? undefined,
    editable,
    autofocus: autoFocus ? "end" : false,
    onUpdate: ({ editor }) => onChange?.(editor.getJSON()),
  });

  // Keep read-only renderers in sync when the doc changes externally.
  useEffect(() => {
    if (editor && !editable && value) {
      editor.commands.setContent(value);
    }
  }, [editor, editable, value]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  return <EditorContent className={`wf-rich ${editable ? "editable" : ""}`} editor={editor} />;
}

/** Render a stored TipTap doc read-only (prompt display, final outputs). */
export function RichDoc({ doc }: { doc: JSONContent | null }) {
  return <RichEditor value={doc} editable={false} />;
}
