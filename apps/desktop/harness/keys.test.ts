// Keys as each platform has them: ⌘ on a Mac, Ctrl on Windows and Linux.
// The bindings use ProseMirror's Mod (Ctrl off a Mac, never the Windows or
// Super key a tiling window manager keeps for itself), and every label the
// app shows is made from the same key, never written out as a Mac symbol.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Editor } from "@tiptap/core";
import ts from "typescript";

import { FORMAT_SPECS } from "../src/apps/documents/formats/elements";
import { keyCaps, keyLabel, modName, withKeys } from "../src/editor/commands/catalog";
import { shortcutSections } from "../src/platform/shortcuts";

check("a Mac's keys", keyLabel("Mod-1", true) === "⌘1" && keyLabel("Mod-Shift-z", true) === "⇧⌘Z" && keyLabel("Mod-Enter", true) === "⌘↩" && modName(true) === "⌘");
check("Windows and Linux: Ctrl, spelled out", keyLabel("Mod-1", false) === "Ctrl+1" && keyLabel("Mod-Shift-z", false) === "Ctrl+Shift+Z" && keyLabel("Mod-Enter", false) === "Ctrl+Enter" && keyLabel("Alt-ArrowUp", false) === "Alt+↑" && modName(false) === "Ctrl");
check("a name with its keys", withKeys("Previous", "Shift-Enter", "Mod-Shift-g") === `Previous (${keyLabel("Shift-Enter")}, ${keyLabel("Mod-Shift-g")})`);
check("(this harness is not a Mac)", keyLabel("Mod-b") === "Ctrl+B" && withKeys("Bold", "Mod-b") === "Bold (Ctrl+B)");

// ------------------------------------------------------------ the element keys

const elements = Object.values(FORMAT_SPECS).flatMap((spec) => spec?.elements ?? []);
const keyed = elements.filter((el) => el.shortcut);
check("every element's key is a key, not a label", keyed.length >= 15 && keyed.every((el) => /^Mod-\d$/.test(el.shortcut!)), keyed.map((el) => el.shortcut).join(" "));
check("…shown as Ctrl here", keyCaps(keyed[0].shortcut!).join("+") === "Ctrl+1");

{
  const { docContentExtensions } = await import("../src/editor/schema/content");
  const { formatKeymap } = await import("../src/apps/documents/formats/FormatKeymap");
  const e = new Editor({
    element: mountPoint(),
    extensions: [...docContentExtensions(), formatKeymap("manuscript")],
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Chapter One" }] }] },
  });
  e.commands.setTextSelection(3);
  const press = (key: string, mods: { ctrlKey?: boolean; metaKey?: boolean }) => {
    const ev = new KeyboardEvent("keydown", { key, code: `Digit${key}`, keyCode: 48 + Number(key), ...mods, bubbles: true });
    return e.view.someProp("handleKeyDown", (f) => f(e.view, ev)) ?? false;
  };
  const elementHere = () => {
    const node = e.state.selection.$from.parent;
    return `${node.type.name}:${node.attrs.element ?? ""}:${node.attrs.level ?? ""}`;
  };
  const before = elementHere();
  check("the Windows or Super key does nothing to the text", !press("1", { metaKey: true }) && elementHere() === before);
  check("Ctrl and a digit chooses the element", press("1", { ctrlKey: true }) && elementHere() !== before, `${before} then ${elementHere()}`);
  e.destroy();
}

// ------------------------------------------------------------ the cheat sheet

const sheet = shortcutSections().flatMap((s) => s.rows);
check("the cheat sheet has no Mac symbol here", sheet.every((row) => !/[⌘⌥⌃]/.test(row.keys.join("") + row.what)), JSON.stringify(sheet.filter((row) => /[⌘⌥⌃]/.test(row.keys.join("") + row.what))));
check("…and spells out what it puts together", sheet.some((row) => row.what.includes("Ctrl+Shift+G")));

// ------------------------------------------------------------ no symbol written out by hand

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../src");
const MADE_HERE = [/editor\/commands\/catalog\.ts$/, /platform\/shortcuts\.ts$/, /src\/bindings\//];
const found: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (/\.(ts|tsx)$/.test(name) && !MADE_HERE.some((re) => re.test(file))) scan(file);
  }
};
function scan(file: string) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node) ? node.text : ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.text : null;
    if (text !== null && /[⌘⌥⌃]|⇧[A-Z↩↵]/.test(text)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${path.relative(src, file)}:${line + 1}  ${text.trim().slice(0, 60)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
walk(src);
check("no label in the app writes a Mac key out by hand", found.length === 0, `\n  ${found.join("\n  ")}`);

finish();
