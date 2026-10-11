import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { listNotes, mountNoteEditor, openNotes, type NoteEditorHandle, type NoteEntry } from "../nodes/Footnote";

/** A note being written in the list: its own small editor, bound to the
 *  note in the document (see mountNoteEditor). */
function NoteField({ editor, pos, onDone }: { editor: Editor; pos: number; onDone: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const handle = useRef<NoteEditorHandle | null>(null);
  const at = useRef(pos);
  const done = useRef(onDone);
  useEffect(() => {
    at.current = pos;
    done.current = onDone;
  });

  useEffect(() => {
    const node = editor.state.doc.nodeAt(at.current);
    if (!mount.current || !node || node.type.name !== "footnote") return;
    const box = mount.current;
    const made = mountNoteEditor({ editor, position: () => at.current, node, mount: box, onDone: () => done.current() });
    handle.current = made;
    openNotes.set(box, made.view);
    made.focusEnd();
    return () => {
      handle.current = null;
      openNotes.delete(box);
      made.destroy();
    };
  }, [editor]);

  // The note as it stands after every change to the document — this
  // editor's own typing comes back the same, anyone else's is taken in.
  useEffect(() => {
    const sync = () => {
      const node = editor.state.doc.nodeAt(at.current);
      if (node?.type.name === "footnote") handle.current?.update(node);
    };
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor]);

  return <div ref={mount} className="wf-fn-body wf-docnotes-field" />;
}

/**
 * The document's footnotes and endnotes, listed under its last page.
 *
 * In the text a note is only its number; on paper, footnotes sit at the
 * foot of their pages and endnotes at the end. This is where they can all
 * be seen while writing: click a note's words to change them right here,
 * or its number to go to the place that cites it. Nothing is shown for a
 * document without notes.
 */
export function NotesList({ editor, style }: { editor: Editor; style?: CSSProperties }) {
  const [notes, setNotes] = useState<NoteEntry[]>(() => listNotes(editor.state.doc));
  /** The note being written here, by where its reference is. */
  const [active, setActive] = useState<number | null>(null);
  const [editable, setEditable] = useState(editor.isEditable);

  useEffect(() => {
    const onChange = ({ transaction }: { transaction: { docChanged: boolean; mapping: { map(pos: number, assoc?: number): number } } }) => {
      setEditable(editor.isEditable);
      if (!transaction.docChanged) return;
      const doc = editor.state.doc;
      setNotes(listNotes(doc));
      // The note being written stays the same note as the text around it moves.
      setActive((was) => {
        if (was === null) return null;
        const now = transaction.mapping.map(was, 1);
        return doc.nodeAt(now)?.type.name === "footnote" ? now : null;
      });
    };
    // (Being made read-only — Viewing, a lost permission — is announced as
    // an update, not a transaction.)
    const onMode = () => setEditable(editor.isEditable);
    setNotes(listNotes(editor.state.doc));
    onMode();
    editor.on("transaction", onChange);
    editor.on("update", onMode);
    return () => {
      editor.off("transaction", onChange);
      editor.off("update", onMode);
    };
  }, [editor]);

  if (notes.length === 0) return null;

  /** Go to where a note is cited (its number is selected, its own editor
   *  opens beside it). */
  const show = (note: NoteEntry) => {
    setActive(null);
    const { state, view } = editor;
    if (state.doc.nodeAt(note.pos)?.type.name !== "footnote") return;
    view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, note.pos)).scrollIntoView());
    view.focus();
  };

  const groups = (["foot", "end"] as const).map((kind) => ({ kind, items: notes.filter((n) => n.kind === kind) })).filter((g) => g.items.length > 0);

  return (
    <section className="wf-docnotes" style={style} aria-label="Notes in this document">
      {groups.map((group) => (
        <div key={group.kind} className="wf-docnotes-group">
          <h4>{group.kind === "end" ? "Endnotes" : "Footnotes"}</h4>
          <p className="wf-docnotes-hint">
            {group.kind === "end"
              ? "Printed at the end of the document."
              : "Each is printed at the foot of the page that cites it."}
            {editable ? " Click a note to change it; its number shows where it is cited." : " Click a note to see where it is cited."}
          </p>
          <ol>
            {group.items.map((note) => (
              <li key={`${note.kind}:${note.label}`} className={`${active === note.pos ? "editing" : ""}${note.removed ? " removed" : ""}`}>
                <button type="button" className="wf-docnotes-num" title="Show where this note is cited" aria-label={`Note ${note.label}: show where it is cited`} onClick={() => show(note)}>
                  {note.label}
                </button>
                {active === note.pos && editable ? (
                  <div
                    className="wf-docnotes-edit"
                    onBlur={(e) => {
                      // Leaving the note (not moving within it): done.
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(null);
                    }}
                  >
                    <NoteField
                      editor={editor}
                      pos={note.pos}
                      onDone={() => setActive(null)}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="wf-docnotes-text"
                    title={editable ? "Change this note" : "Show where this note is cited"}
                    onClick={() => (editor.isEditable ? setActive(note.pos) : show(note))}
                  >
                    {note.text || <em>Empty note</em>}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
