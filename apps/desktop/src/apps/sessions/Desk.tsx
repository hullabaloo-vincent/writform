import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import { Bold, Ellipsis, Italic, List, ListOrdered, Maximize2, Minimize2, Minus, Moon, Quote, Redo2, Underline, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { SessionPrompt } from "../../bindings/proto/SessionPrompt";
import { RichDoc } from "../../editor/RichEditor";
import { quoteStyleFor, SmartPunctuation } from "../../editor/SmartPunctuation";
import { LEVEL1_EXTENSIONS } from "../../editor/schema/level1";
import { useDarkPaper } from "../../editor/ui/darkPaper";
import { Flyout, FlyoutItem } from "../../editor/ui/Flyout";
import { KeyboardDock } from "../../editor/ui/KeyboardDock";
import { uploadToServer } from "../../lib/upload";
import { countWordsInDocJson } from "../../lib/wordCount";
import { toastError } from "../../platform/toast";
import { useSession } from "../../stores/session";
import { useChat } from "../chat/store";
import { sessionApi } from "./api";
import { DraftSaver, pace, readDraft, sameWords, writingLine, writingNow, type SaveState } from "./draft";
import { useSessions } from "./store";
import { withKeys } from "../../editor/commands/catalog";

/**
 * Where a prompt is written to while it runs: a page of paper in the
 * type a document is written in, a bar that stays in sight with the clock,
 * the count and whether the words are safe, and a view that leaves only
 * the prompt and the page.
 *
 * Prompts and what is written to them are not documents: they stay on the
 * vocabulary every released app knows (see editor/schema/level1.ts).
 */

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

const language = (): string => (typeof navigator !== "undefined" && navigator.language ? navigator.language : "en");

/** Made once: the editor is set up again whenever its extensions change. */
const DESK_EXTENSIONS = [
  ...LEVEL1_EXTENSIONS,
  Placeholder.configure({ placeholder: "Start writing. Your words are saved as you go." }),
  // Curly quotes and dashes as they are typed, as in a document. (Rules
  // for what is typed only: nothing an older app would not know.)
  SmartPunctuation.configure({ quotes: () => quoteStyleFor(language()) }),
];
/** The bar rides over the top of the page as it scrolls: the caret is kept
 *  clear of it (and a little off the foot) when the keys move it. */
const CLEAR = { top: 112, right: 0, bottom: 28, left: 0 };
/** (A constant: the editor compares its props by identity.) */
const DESK_PROPS = { attributes: { spellcheck: "true", lang: language() }, scrollThreshold: CLEAR, scrollMargin: CLEAR };

const SAVE_LABELS: Record<SaveState, string> = {
  clean: "Saved as you write",
  waiting: "Saving",
  saving: "Saving",
  saved: "Saved",
  retrying: "Not saved yet. Trying again",
  closed: "Time is up",
};

/** Whose drafts are whose on this device: the server and the person. */
export function draftScope(addr: string | undefined, userId: number | undefined): string {
  return `${addr ?? "server"}#${userId ?? 0}`;
}

export function WritingDesk({ prompt, clock }: { prompt: SessionPrompt; clock?: ReactNode }) {
  const me = useSession((s) => s.session?.user);
  const addr = useSession((s) => s.session?.addr);
  const scope = draftScope(addr, me?.id);
  const writers = useSessions((s) => s.writers[prompt.id]);
  const members = useChat((s) => s.members);

  // What the desk opens with: the server's copy, unless this device holds
  // words the server never got (the app was closed, or the save failed).
  const [first] = useState(() => {
    const mine = useSessions.getState().detail?.submissions.find((s) => s.prompt_id === prompt.id && s.author.id === me?.id);
    const server = (mine?.doc as JSONContent | null | undefined) ?? null;
    const local = readDraft(scope, prompt.id);
    if (local && !local.sent && !sameWords(local.doc, server)) return { doc: local.doc, restored: true };
    return { doc: server ?? EMPTY_DOC, restored: false };
  });
  const [words, setWords] = useState(() => countWordsInDocJson(first.doc));
  const [save, setSave] = useState<SaveState>("clean");
  const [focus, setFocus] = useState(false);
  // The same paper as the document editor's (Dark paper, on this device).
  const dark = useDarkPaper((s) => s.dark);
  const setDark = useDarkPaper((s) => s.set);
  const [showPrompt, setShowPrompt] = useState(true);

  const endsAt = useRef(prompt.ends_at);
  endsAt.current = prompt.ends_at;
  const saver = useRef<DraftSaver | null>(null);
  useEffect(() => {
    const made = new DraftSaver({
      promptId: prompt.id,
      scope,
      save: async (doc) => {
        await sessionApi.saveSubmission(prompt.id, doc);
      },
      endsAt: () => endsAt.current,
      onState: setSave,
    });
    saver.current = made;
    // Words put back from this device go to the server at the first chance.
    if (first.restored) made.change(first.doc);
    return () => {
      saver.current = null;
      void made.stop();
    };
  }, [prompt.id, scope, first]);
  // Stop was pressed, or the clock was set: the last saves aim at the new end.
  useEffect(() => {
    saver.current?.rearm();
  }, [prompt.ends_at]);

  const editor = useEditor({
    extensions: DESK_EXTENSIONS,
    content: first.doc,
    autofocus: "end",
    editorProps: DESK_PROPS,
    onUpdate: ({ editor: e }) => {
      const doc = e.getJSON();
      setWords(countWordsInDocJson(doc));
      saver.current?.change(doc);
    },
  });

  // Escape leaves the focus view (a menu that is open takes it first).
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setFocus(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  // Who else is writing, looked at again every few seconds so that someone
  // who has stopped drops off the line.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const others = writingLine(writingNow(writers, me?.id, now), (id) => {
    const user = members.find((m) => m.user.id === id)?.user;
    return user ? (user.display_name ?? user.username) : null;
  });

  const rate = pace(words, prompt.started_at, Date.now());

  return (
    // (In the focus view a sideways swipe is not the room's to act on: the
    // chat it would open is behind this.)
    <div className={`wf-desk${focus ? " focus" : ""}`} onTouchStart={focus ? (e) => e.stopPropagation() : undefined}>
      <div className="wf-desk-bar">
        <div className="wf-desk-status">
          {clock}
          <span className="wf-desk-count">
            <b>{words.toLocaleString()}</b> {words === 1 ? "word" : "words"}
          </span>
          {rate !== null && <span className="wf-desk-rate">{rate} a minute</span>}
          <span className="wf-statusbar-spacer" />
          {/* (Read out only when something is wrong: "Saved" every few seconds is noise.) */}
          <span className={`wf-desk-save ${save}`} aria-live={save === "retrying" ? "polite" : "off"}>
            {SAVE_LABELS[save]}
          </span>
          <button
            type="button"
            className={`wf-icon wf-desk-paper${dark ? " active" : ""}`}
            title={dark ? "Light paper" : "Dark paper"}
            aria-label="Dark paper"
            aria-pressed={dark}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setDark(!dark)}
          >
            <Moon size={15} />
          </button>
          {focus && (
            <button type="button" className={`wf-desk-toggle${showPrompt ? " active" : ""}`} aria-pressed={showPrompt} onMouseDown={(e) => e.preventDefault()} onClick={() => setShowPrompt((v) => !v)}>
              Prompt
            </button>
          )}
          <button
            type="button"
            className="wf-icon wf-desk-focus"
            title={focus ? "Back to the session (Esc)" : "Only the prompt and the page"}
            aria-label={focus ? "Back to the session" : "Only the prompt and the page"}
            aria-pressed={focus}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setFocus((v) => !v);
              editor?.commands.focus();
            }}
          >
            {focus ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
        {editor && (
          <KeyboardDock editor={editor}>
            <DeskTools editor={editor} />
          </KeyboardDock>
        )}
      </div>
      <div className="wf-desk-scroll">
        {focus && showPrompt && (
          <div className="wf-desk-prompt">
            <RichDoc doc={prompt.prompt_doc as JSONContent} />
          </div>
        )}
        {first.restored && save !== "saved" && <p className="wf-desk-note">Words from this device that had not been saved were put back.</p>}
        <div className={`wf-paper wf-rich-wrap${dark ? " dark" : ""}`}>
          <EditorContent className="wf-rich editable" editor={editor} />
        </div>
        {others && <p className="wf-desk-others">{others}</p>}
      </div>
    </div>
  );
}

/** The few tools a sprint wants within reach, and the rest under More. */
function DeskTools({ editor }: { editor: Editor }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // Drawn again as the caret moves, so the buttons show what is on.
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
      chain().setImage({ src: await uploadToServer(file) }).run();
    } catch {
      toastError("That picture could not be added.");
    } finally {
      setUploading(false);
    }
  };

  const btn = (title: string, icon: ReactNode, run: () => void, active = false, disabled = false) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={active ? "active" : ""}
      disabled={disabled}
      // (Mousedown only keeps the text's focus. The click does the work,
      // so the keyboard can press these too.)
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {icon}
    </button>
  );

  return (
    <div className="wf-editor-toolbar wf-desk-tools">
      {btn(withKeys("Bold", "Mod-b"), <Bold size={15} />, () => chain().toggleBold().run(), editor.isActive("bold"))}
      {btn(withKeys("Italic", "Mod-i"), <Italic size={15} />, () => chain().toggleItalic().run(), editor.isActive("italic"))}
      {btn(withKeys("Underline", "Mod-u"), <Underline size={15} />, () => chain().toggleUnderline().run(), editor.isActive("underline"))}
      <span className="wf-toolbar-sep" />
      {btn("Quote", <Quote size={15} />, () => chain().toggleBlockquote().run(), editor.isActive("blockquote"))}
      {btn("Bullet list", <List size={15} />, () => chain().toggleBulletList().run(), editor.isActive("bulletList"))}
      {btn("Numbered list", <ListOrdered size={15} />, () => chain().toggleOrderedList().run(), editor.isActive("orderedList"))}
      {btn("Divider", <Minus size={15} />, () => chain().setHorizontalRule().run())}
      <span className="wf-toolbar-sep" />
      {btn(withKeys("Undo", "Mod-z"), <Undo2 size={15} />, () => chain().undo().run(), false, !editor.can().undo())}
      {btn(withKeys("Redo", "Mod-Shift-z"), <Redo2 size={15} />, () => chain().redo().run(), false, !editor.can().redo())}
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
      <Flyout title="More" icon={<Ellipsis size={15} />} caret={false} active={editor.isActive("heading") || editor.isActive("strike")}>
        {(close) => (
          <>
            <FlyoutItem
              checked={editor.isActive("heading", { level: 1 })}
              onPick={() => {
                chain().toggleHeading({ level: 1 }).run();
                close();
              }}
            >
              Heading
            </FlyoutItem>
            <FlyoutItem
              checked={editor.isActive("heading", { level: 2 })}
              onPick={() => {
                chain().toggleHeading({ level: 2 }).run();
                close();
              }}
            >
              Smaller heading
            </FlyoutItem>
            <FlyoutItem
              checked={editor.isActive("strike")}
              onPick={() => {
                chain().toggleStrike().run();
                close();
              }}
            >
              Strikethrough
            </FlyoutItem>
            <FlyoutItem
              disabled={uploading}
              onPick={() => {
                fileRef.current?.click();
                close();
              }}
            >
              {uploading ? "Adding the picture" : "Picture"}
            </FlyoutItem>
          </>
        )}
      </Flyout>
    </div>
  );
}
