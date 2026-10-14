// Three characters that look like ordinary ones and are not: a space the
// line may not break at, a hyphen it may not break at, and a hyphen that
// shows only where it does. Typed by key or from the Symbol menu, seen
// through by Find, kept by Word files, and honoured where lines are set.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import JSZip from "jszip";

import { DEFAULT_SETTINGS, type DocSettings } from "../src/apps/documents/docSettings";
import { findInDoc } from "../src/apps/documents/find/findInDoc";
import { TypesetSession, type DocRequest } from "../src/book/engine/run";
import type { DLText } from "../src/book/engine/types";
import { loadFontFiles } from "../src/book/fonts/files";
import { buildDocModel } from "../src/doclayout/model";
import { readDocx } from "../src/docx/read";
import { writeDocx } from "../src/docx/write";
import { EDITOR_COMMANDS, keyLabel, keysOf } from "../src/editor/commands/catalog";
import { CommandKeys } from "../src/editor/commands/CommandKeys";
import type { CommandCtx } from "../src/editor/commands/run";
import { insertSpecial } from "../src/editor/format/commands";
import { docContentExtensions } from "../src/editor/schema/content";
import { SPECIAL_CHARACTERS, specialCharacter } from "../src/editor/ui/symbols";

const NBSP = String.fromCharCode(0x00a0);
const NBHY = String.fromCharCode(0x2011);
const SHY = String.fromCharCode(0x00ad);
const t = (text: string, ...marks: string[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const ctx: CommandCtx = { format: "none", rich: null, editable: true, shell: {} };
const editorWith = (content: JSONContent[]): Editor =>
  new Editor({ element: mountPoint(), extensions: [...docContentExtensions(), CommandKeys.configure({ ctx: () => ctx })], content: { type: "doc", content } });
const press = (e: Editor, key: string, keyCode: number, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): boolean => {
  const event = new KeyboardEvent("keydown", { key, keyCode, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, bubbles: true, cancelable: true } as KeyboardEventInit);
  for (const plugin of e.state.plugins) {
    if (plugin.props.handleKeyDown?.call(plugin, e.view, event)) return true;
  }
  return false;
};

// ------------------------------------------------------------ typing them

{
  check("the three are offered by name", SPECIAL_CHARACTERS.map((c) => c.label).join("|") === "No-break space|No-break hyphen|Optional hyphen");
  check("each is the character it says", specialCharacter("nbsp") === NBSP && specialCharacter("nbhyphen") === NBHY && specialCharacter("softhyphen") === SHY && specialCharacter("nonsense") === null);

  const e = editorWith([p(t("Mr Jones"))]);
  e.commands.setTextSelection({ from: 3, to: 4 });
  check("from the Symbol menu one goes in over what is selected", insertSpecial(e, "nbsp") && e.state.doc.textContent === `Mr${NBSP}Jones`);
  e.commands.setContent({ type: "doc", content: [p(t("well", "bold"), t("known"))] });
  e.commands.setTextSelection(5);
  insertSpecial(e, "nbhyphen");
  const first = e.getJSON().content?.[0]?.content?.[0];
  check("and takes the formatting it is typed into", first?.text === `well${NBHY}` && first.marks?.[0]?.type === "bold", JSON.stringify(e.getJSON().content?.[0]?.content));

  // The keys (not a Mac here).
  e.commands.setContent({ type: "doc", content: [p(t("ab"))] });
  e.commands.setTextSelection(2);
  check("Ctrl+Shift+Space types a no-break space", press(e, " ", 32, { ctrl: true, shift: true }) && e.state.doc.textContent === `a${NBSP}b`, JSON.stringify(e.state.doc.textContent));
  e.commands.setTextSelection(2);
  check("Ctrl+Shift+Hyphen a no-break hyphen", press(e, "_", 189, { ctrl: true, shift: true }) && e.state.doc.textContent === `a${NBHY}${NBSP}b`, JSON.stringify(e.state.doc.textContent));
  e.commands.setTextSelection(2);
  check("Ctrl+Hyphen an optional hyphen", press(e, "-", 189, { ctrl: true }) && e.state.doc.textContent === `a${SHY}${NBHY}${NBSP}b`, JSON.stringify(e.state.doc.textContent));
  const row = (id: string) => EDITOR_COMMANDS.find((r) => r.id === id)!;
  check("the keys are in the list by those names", keyLabel(keysOf(row("doc.nbsp"), false)!, false) === "Ctrl+Shift+Space" && keyLabel(keysOf(row("doc.nbhyphen"), false)!, false) === "Ctrl+Shift+-" && keyLabel(keysOf(row("doc.softhyphen"), false)!, false) === "Ctrl+-");
  check("on a Mac the no-break space is Option with the space bar, as the system has it", keyLabel(keysOf(row("doc.nbsp"), true)!, true) === "⌥Space" && keyLabel(keysOf(row("doc.softhyphen"), true)!, true) === "⌘-");
  e.setEditable(false);
  check("a reader types none", !insertSpecial(e, "nbsp"));
  e.destroy();
}

// ------------------------------------------------------------ Find sees through them

{
  const e = editorWith([p(t(`A well${NBHY}known extra${SHY}ordinary co${SHY}operation of Mr${NBSP}Jones.`))]);
  const found = (q: string, opts = {}) => findInDoc(e.state.doc, q, opts).matches.map((m) => e.state.doc.textBetween(m.from, m.to));
  check("a word with an optional hyphen in it is found as the word it is", found("extraordinary").join("|") === `extra${SHY}ordinary` && found("cooperation").length === 1);
  check("a no-break hyphen is found as a hyphen", found("well-known").join("|") === `well${NBHY}known`);
  check("a no-break space as a space, as before", found("Mr Jones").length === 1);
  check("a search that is exact takes them as written", found("extraordinary", { exact: true }).length === 0 && found("well-known", { exact: true }).length === 0 && found(`well${NBHY}known`, { exact: true }).length === 1);
  check("an optional hyphen in what is searched for is passed over too", found(`extra${SHY}ordinary`).length === 1 && found(`ex${SHY}traordinary`).length === 1);
  check("part of such a word is still found, and its place is right", found("ordinary").join("|") === "ordinary" && found("extra").join("|") === "extra");
  e.destroy();
}

// ------------------------------------------------------------ Word files keep them

{
  const doc: JSONContent = { type: "doc", content: [p(t(`well${NBHY}known and extra${SHY}ordinary, Mr${NBSP}Jones`))] };
  const written = await writeDocx(doc, { title: "Special", format: "none" });
  const xml = await (await JSZip.loadAsync(written.bytes)).file("word/document.xml")!.async("string");
  check("a Word file holds the two hyphens as Word's own elements", xml.includes("<w:noBreakHyphen/>") && xml.includes("<w:softHyphen/>") && !xml.includes(NBHY) && !xml.includes(SHY));
  check("with the words either side of them still text", xml.includes(">well</w:t>") && xml.includes(">known and extra</w:t>"), xml.slice(xml.indexOf("<w:body>"), xml.indexOf("<w:body>") + 400));
  const back = await readDocx(written.bytes);
  const text = JSON.stringify(back.content);
  check("and read back they are the same characters", text.includes(`well${NBHY}known and extra${SHY}ordinary, Mr${NBSP}Jones`), text.slice(0, 300));
}

// ------------------------------------------------------------ where lines are set

{
  const session = new TypesetSession();
  const narrow: Partial<DocSettings> = { pageSize: "custom", pw: 3.2, ph: 9, ml: 0.5, mr: 0.5, mt: 0.5, mb: 0.5, fR: "" };
  /** The lines a paragraph is set in, top to bottom, page after page. */
  const linesOf = async (text: string): Promise<string[]> => {
    const model = buildDocModel({ type: "doc", content: [p(t(text))] }, { title: "Lines", author: "", settings: { ...DEFAULT_SETTINGS, ...narrow }, date: "", styles: {} });
    session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
    const req: DocRequest = { kind: "document", doc: model, families: model.families, images: [] };
    const { dl } = await session.layout(req);
    const out: string[] = [];
    for (const page of dl.pages) {
      const rows = new Map<number, DLText[]>();
      for (const it of page.items) {
        if (it.t !== "text") continue;
        const key = Math.round(it.y * 10);
        rows.set(key, [...(rows.get(key) ?? []), it]);
      }
      for (const [, items] of [...rows.entries()].sort((a, b) => a[0] - b[0])) out.push(items.sort((a, b) => a.x - b.x).map((i) => i.text).join(" "));
    }
    return out;
  };
  // (Words of many lengths between, so the lines end in many places.)
  const FILL = ["a", "filler", "to", "something", "be", "or", "not", "wonderful", "at", "all"];
  const many = (unit: string) => Array.from({ length: 60 }, (_, n) => `${unit} ${FILL[n % FILL.length]}`).join(" ");
  const show = (lines: string[]) => lines.slice(0, 5).join(" / ");

  const plain = await linesOf(many("Mr Jones"));
  const kept = await linesOf(many(`Mr${NBSP}Jones`));
  check("two words with an ordinary space are parted at some line's end", plain.length > 8 && plain.some((line) => / Mr$/.test(line)), show(plain));
  check("with a no-break space between them they never are", kept.length > 8 && kept.every((line) => !/(^| )Mr$/.test(line) && !/^Jones/.test(line)) && kept.join(" ").includes(`Mr${NBSP}Jones`), show(kept));

  const hyphened = await linesOf(many("mother-in-law"));
  const held = await linesOf(many(`mother${NBHY}in${NBHY}law`));
  const HY = `[-${NBHY}]`;
  check("a word with ordinary hyphens may be broken at one", hyphened.some((line) => /-$/.test(line)), show(hyphened));
  check("with no-break hyphens it never is", held.length > 8 && held.every((line) => !new RegExp(`${HY}$`).test(line) && !/^(in|law)\b/.test(line)), show(held));
  check("and every one of them is whole, drawn with a hyphen", (held.join(" ").match(new RegExp(`mother${HY}in${HY}law`, "g")) ?? []).length === 60, show(held));

  const soft = await linesOf(many(`extra${SHY}ordinary`));
  check("an optional hyphen is never drawn where the line goes on", soft.every((line) => !line.includes(SHY)) && soft.some((line) => line.includes("extraordinary")), show(soft));
  const at = soft.findIndex((line) => /extra-$/.test(line));
  check("and is a hyphen where the line breaks at it, with the rest of the word on the next", at >= 0 && soft[at + 1].startsWith("ordinary"), show(soft));
}

finish();
