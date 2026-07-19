import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { uploadBlob } from "../lib/upload";

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
  toolbar = false,
}: {
  value: JSONContent | null;
  onChange?: (doc: JSONContent) => void;
  editable?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Show the formatting toolbar (WYSIWYG controls + image upload). */
  toolbar?: boolean;
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

  return (
    <div className="wf-rich-wrap">
      {toolbar && editable && editor && <Toolbar editor={editor} />}
      <EditorContent className={`wf-rich ${editable ? "editable" : ""}`} editor={editor} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // Re-render on selection/content changes so active states track the cursor.
  const [, bump] = useState(0);
  useEffect(() => {
    const update = () => bump((n) => n + 1);
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  const chain = () => editor.chain().focus();
  const insertImage = async (file: File) => {
    setUploading(true);
    try {
      const meta = await uploadBlob(file, file.name);
      chain().setImage({ src: `writform-att://attachment/${meta.id}` }).run();
    } catch {
      // upload failed — nothing inserted
    } finally {
      setUploading(false);
    }
  };

  const btn = (
    title: string,
    icon: React.ReactNode,
    run: () => void,
    active = false,
    disabled = false,
  ) => (
    <button
      type="button"
      title={title}
      className={active ? "active" : ""}
      disabled={disabled}
      onMouseDown={(e) => {
        e.preventDefault(); // keep editor focus
        run();
      }}
    >
      {icon}
    </button>
  );

  return (
    <div className="wf-editor-toolbar">
      {btn("Bold", <Bold size={15} />, () => chain().toggleBold().run(), editor.isActive("bold"))}
      {btn(
        "Italic",
        <Italic size={15} />,
        () => chain().toggleItalic().run(),
        editor.isActive("italic"),
      )}
      {btn(
        "Strikethrough",
        <Strikethrough size={15} />,
        () => chain().toggleStrike().run(),
        editor.isActive("strike"),
      )}
      {btn(
        "Inline code",
        <Code size={15} />,
        () => chain().toggleCode().run(),
        editor.isActive("code"),
      )}
      <span className="wf-toolbar-sep" />
      {btn(
        "Heading 1",
        <Heading1 size={15} />,
        () => chain().toggleHeading({ level: 1 }).run(),
        editor.isActive("heading", { level: 1 }),
      )}
      {btn(
        "Heading 2",
        <Heading2 size={15} />,
        () => chain().toggleHeading({ level: 2 }).run(),
        editor.isActive("heading", { level: 2 }),
      )}
      {btn(
        "Bullet list",
        <List size={15} />,
        () => chain().toggleBulletList().run(),
        editor.isActive("bulletList"),
      )}
      {btn(
        "Numbered list",
        <ListOrdered size={15} />,
        () => chain().toggleOrderedList().run(),
        editor.isActive("orderedList"),
      )}
      {btn(
        "Quote",
        <Quote size={15} />,
        () => chain().toggleBlockquote().run(),
        editor.isActive("blockquote"),
      )}
      {btn("Divider", <Minus size={15} />, () => chain().setHorizontalRule().run())}
      <span className="wf-toolbar-sep" />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void insertImage(file);
          e.target.value = "";
        }}
      />
      {btn(
        uploading ? "Uploading…" : "Insert image",
        <ImagePlus size={15} />,
        () => fileRef.current?.click(),
        false,
        uploading,
      )}
      <span className="wf-toolbar-sep" />
      {btn(
        "Undo",
        <Undo2 size={15} />,
        () => chain().undo().run(),
        false,
        !editor.can().undo(),
      )}
      {btn(
        "Redo",
        <Redo2 size={15} />,
        () => chain().redo().run(),
        false,
        !editor.can().redo(),
      )}
    </div>
  );
}

/** Render a stored TipTap doc read-only (prompt display, final outputs). */
export function RichDoc({ doc }: { doc: JSONContent | null }) {
  return <RichEditor value={doc} editable={false} />;
}
