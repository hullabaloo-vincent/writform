// How footnotes and endnotes are numbered: the formats, starting again at
// each section or on each page, on screen, in print and in Word files, and
// every note of one kind made the other.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import JSZip from "jszip";

import { DEFAULT_SETTINGS, type DocSettings } from "../src/apps/documents/docSettings";
import { TypesetSession, type DocRequest } from "../src/book/engine/run";
import { loadFontFiles } from "../src/book/fonts/files";
import { buildDocModel } from "../src/doclayout/model";
import { readDocx } from "../src/docx/read";
import { writeDocx } from "../src/docx/write";
import { listNotes } from "../src/editor/nodes/Footnote";
import { convertNotes, noteLabelAt, NoteNumbers, refreshNoteNumbers, USUAL_NUMBERING, type NoteNumbering } from "../src/editor/nodes/NoteNumbers";
import { docContentExtensions } from "../src/editor/schema/content";
import { noteLabel } from "../src/editor/schema/sanitize";

// ------------------------------------------------------------ the labels

check("numbers, and in capitals or small", noteLabel(4, "1") === "4" && noteLabel(4, "i") === "iv" && noteLabel(9, "I") === "IX");
check("letters, then doubled as Word has them", noteLabel(1, "a") === "a" && noteLabel(26, "a") === "z" && noteLabel(27, "a") === "aa" && noteLabel(28, "A") === "BB");
check("marks, then twice over", noteLabel(1, "*") === "*" && noteLabel(2, "*") === String.fromCharCode(0x2020) && noteLabel(7, "*") === "**" && noteLabel(8, "*") === String.fromCharCode(0x2020).repeat(2));
check("past the end of the Roman numbers, still a number", noteLabel(5000, "1") === "5000");

// ------------------------------------------------------------ on screen

const note = (text: string, kind?: "end"): JSONContent => ({ type: "footnote", ...(kind ? { attrs: { kind } } : {}), content: [{ type: "text", text }] });
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const t = (text: string): JSONContent => ({ type: "text", text });
const content: JSONContent[] = [
  para(t("One"), note("a"), t(" two"), note("b")),
  para(t("Three"), note("c", "end")),
  { type: "paragraph", attrs: { sect: "sect" }, content: [t("A new section"), note("d")] },
];

let numbering: NoteNumbering = USUAL_NUMBERING;
let pages: (string | null)[] | null = null;
const e = new Editor({
  element: mountPoint(),
  extensions: [...docContentExtensions(), NoteNumbers.configure({ numbering: () => numbering, pageLabels: () => pages })],
  content: { type: "doc", content },
});
const shown = () => [...e.view.dom.querySelectorAll("sup.wf-fn")].map((el) => el.getAttribute("data-n") ?? "-").join(" ");
const listed = () => listNotes(e.state.doc, (pos, kind, n) => noteLabelAt(e.state, pos, kind, n)).map((n) => n.label).join(" ");

check("the usual numbers are the stylesheet's own", shown() === "- - - -" && !e.view.dom.hasAttribute("data-fnf") && listed() === "1 2 i 3", listed());

numbering = { fnFormat: "I", enFormat: "1", fnRestart: "doc" };
refreshNoteNumbers(e);
check("capitals and plain numbers are counted in their own style", shown() === "- - - -" && e.view.dom.getAttribute("data-fnf") === "upper" && e.view.dom.getAttribute("data-enf") === "digits" && listed() === "I II 1 III", listed());

numbering = { fnFormat: "*", enFormat: "i", fnRestart: "doc" };
refreshNoteNumbers(e);
const dagger = String.fromCharCode(0x2020);
const ddagger = String.fromCharCode(0x2021);
check("marks are said on each note", shown() === `* ${dagger} - ${ddagger}`, shown());

numbering = { fnFormat: "1", enFormat: "i", fnRestart: "section" };
refreshNoteNumbers(e);
check("footnotes from 1 again at a section", shown() === "1 2 - 1" && listed() === "1 2 i 1", shown());

numbering = { fnFormat: "1", enFormat: "i", fnRestart: "page" };
pages = ["1", "1", "i", "2"];
refreshNoteNumbers(e);
check("on each page: the numbers the pages were set with", shown() === "1 1 - 2", shown());
pages = null;
refreshNoteNumbers(e);
check("…and running on until the pages are known", shown() === "1 2 - 3", shown());

numbering = USUAL_NUMBERING;
refreshNoteNumbers(e);
const made = convertNotes(e, "foot");
const kinds = () => listNotes(e.state.doc).map((n) => n.kind).join(" ");
check("every footnote made an endnote", made === 3 && kinds() === "end end end end", kinds());
e.commands.undo();
check("…as one step", kinds() === "foot foot end foot", kinds());
check("and back", convertNotes(e, "end") === 1 && kinds() === "foot foot foot foot");
e.destroy();

// ------------------------------------------------------------ in print

const session = new TypesetSession();
const settingsWith = (patch: Partial<DocSettings>): DocSettings => ({ ...DEFAULT_SETTINGS, bodyFont: "mono", bodySize: 12, ...patch });
const lay = async (doc: JSONContent[], patch: Partial<DocSettings>) => {
  const model = buildDocModel({ type: "doc", content: doc }, { title: "Notes", author: "", date: "", settings: settingsWith(patch) });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const req = { kind: "document", doc: model, families: model.families, images: [] } as DocRequest;
  return { model, req, dl: (await session.layout(req)).dl };
};

{
  const { model } = await lay(content, { fnFormat: "a", enFormat: "I" });
  check("printed in the document's own way", model.notes.map((n) => n.number).join(" ") === "a b I c", model.notes.map((n) => n.number).join(" "));
  const ref = model.blocks.flatMap((b) => (b.kind === "para" ? b.runs : [])).filter((r) => r.note !== undefined).map((r) => r.text).join(" ");
  check("…in the text and at the note alike", ref === "a b I c" && model.notes[0].para.runs[0].text === "a", ref);
  const sections = await lay(content, { fnRestart: "section" });
  check("from 1 again at a section, in print too", sections.model.notes.map((n) => n.number).join(" ") === "1 2 i 1");
}

{
  // A long text with a footnote in every paragraph: three pages or more.
  const long: JSONContent[] = Array.from({ length: 90 }, (_, i) => para(t(`Paragraph ${i + 1} has words enough to fill a line or so of the page.`), note(`Note ${i + 1}.`)));
  const running = await lay(long, {});
  check("numbered through the document, nothing is set twice", running.dl.noteLabels === undefined && running.dl.pages.length >= 3);
  const paged = await lay(long, { fnRestart: "page" });
  const labels = paged.dl.noteLabels ?? [];
  const ones = labels.filter((l) => l === "1").length;
  check("on each page from 1 again", labels.length === 90 && labels[0] === "1" && ones >= 3 && ones <= paged.dl.pages.length, JSON.stringify(labels));
  let rising = true;
  for (let i = 1; i < labels.length; i += 1) if (labels[i] !== "1" && Number(labels[i]) !== Number(labels[i - 1]) + 1) rising = false;
  check("…and in order within each", rising);
  const map = await session.pageMap(paged.req);
  check("the page map carries them to the screen", JSON.stringify(map.notes) === JSON.stringify(labels));
}

// ------------------------------------------------------------ Word

{
  const written = await writeDocx({ type: "doc", content }, { title: "Notes", format: "none", settings: settingsWith({ fnFormat: "a", enFormat: "I", fnRestart: "page" }) });
  const xml = await (await JSZip.loadAsync(written.bytes)).file("word/settings.xml")!.async("string");
  check("Word is told how notes are numbered", xml.includes('<w:footnotePr><w:numFmt w:val="lowerLetter"/><w:numRestart w:val="eachPage"/>') && xml.includes('<w:endnotePr><w:numFmt w:val="upperRoman"/>'), xml.slice(xml.indexOf("<w:footnotePr"), xml.indexOf("<w:footnotePr") + 200));
  const back = await readDocx(written.bytes);
  check("…and read back", back.settings.fnFormat === "a" && back.settings.enFormat === "I" && back.settings.fnRestart === "page", JSON.stringify(back.settings));
}

finish();
