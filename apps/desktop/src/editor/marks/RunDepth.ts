/**
 * Run formatting of level 4: capitals as formatting (`caps`: every letter
 * a capital, or small capitals) and letter spacing (`letterSpacing`, in
 * points). Separate marks, as the level-2 ones are (RunFormat.ts).
 *
 * The letters typed stay as typed: search, the spelling check, the Check
 * panel and a change of mind all see them. Only the drawing changes.
 */

import { Extension, Mark, type Editor } from "@tiptap/core";

import { capsAttr, colorAttr, letterSpacingAttr, underlineKindAttr, type Caps, type UnderlineKind } from "../schema/sanitize";

export const CapsMark = Mark.create({
  name: "caps",
  addAttributes() {
    return {
      v: {
        default: null,
        parseHTML: (el: HTMLElement) => capsAttr(el.getAttribute("data-caps")),
        renderHTML: (attrs: { v?: unknown }) => {
          const v = capsAttr(attrs.v);
          return v ? { "data-caps": v } : {};
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-caps]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
});

export const LetterSpacingMark = Mark.create({
  name: "letterSpacing",
  addAttributes() {
    return {
      pt: {
        default: null,
        parseHTML: (el: HTMLElement) => letterSpacingAttr(Number(el.getAttribute("data-ls"))),
        renderHTML: (attrs: { pt?: unknown }) => {
          const pt = letterSpacingAttr(attrs.pt);
          return pt === null ? {} : { "data-ls": String(pt), style: `--wf-ls: ${pt}pt` };
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-ls]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
});

/**
 * An underline's kind and colour, and a line through drawn twice, as
 * attributes of the level-1 marks (level 4). An underline without them
 * says nothing more than it always did, and stays level 1.
 */
export const LineStyles = Extension.create({
  name: "lineStyles",
  addGlobalAttributes() {
    return [
      {
        types: ["underline"],
        attributes: {
          kind: {
            default: null,
            parseHTML: (el: HTMLElement) => underlineKindAttr(el.getAttribute("data-ul")),
            renderHTML: (attrs: { kind?: unknown }) => {
              const kind = underlineKindAttr(attrs.kind);
              return kind ? { "data-ul": kind } : {};
            },
          },
          c: {
            default: null,
            parseHTML: (el: HTMLElement) => colorAttr(el.getAttribute("data-ulc")),
            renderHTML: (attrs: { c?: unknown }) => {
              const c = colorAttr(attrs.c);
              return c ? { "data-ulc": c, style: `--wf-ulc: ${c}` } : {};
            },
          },
        },
      },
      {
        types: ["strike"],
        attributes: {
          dbl: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.getAttribute("data-dbl") ? true : null),
            renderHTML: (attrs: { dbl?: unknown }) => (attrs.dbl === true ? { "data-dbl": "1" } : {}),
          },
        },
      },
    ];
  },
});

export const DEPTH_MARKS = [CapsMark, LetterSpacingMark, LineStyles];

/** Underline the selection in a kind of line (null: a single one). */
export function setUnderlineKind(editor: Editor, kind: UnderlineKind | null): boolean {
  const c = colorAttr(editor.getAttributes("underline").c);
  return editor.chain().focus().setMark("underline", { kind, c }).run();
}

/** The selection's underline in a colour (null: the text's own). */
export function setUnderlineColor(editor: Editor, c: string | null): boolean {
  const kind = underlineKindAttr(editor.getAttributes("underline").kind);
  return editor.chain().focus().setMark("underline", { kind, c: colorAttr(c) }).run();
}

/** A line through the selection drawn twice (or once again). */
export function toggleDoubleStrike(editor: Editor): boolean {
  const on = editor.getAttributes("strike").dbl === true && editor.isActive("strike");
  const chain = editor.chain().focus();
  return (on ? chain.unsetMark("strike") : chain.setMark("strike", { dbl: true })).run();
}
export const DEPTH_MARK_NAMES = ["caps", "letterSpacing"] as const;

/** Every letter a capital, or small capitals, on the selection (or off,
 *  when it already is). */
export function toggleCaps(editor: Editor, v: Caps): boolean {
  const on = capsAttr(editor.getAttributes("caps").v) === v;
  const chain = editor.chain().focus();
  return (on ? chain.unsetMark("caps") : chain.setMark("caps", { v })).run();
}

/** Letter spacing on the selection, points (null or 0: as the font has it). */
export function setLetterSpacing(editor: Editor, pt: number | null): boolean {
  const v = letterSpacingAttr(pt);
  const chain = editor.chain().focus();
  return (v === null ? chain.unsetMark("letterSpacing") : chain.setMark("letterSpacing", { pt: v })).run();
}

/** The selection's capitals and letter spacing. */
export function curDepth(editor: Editor): { caps: Caps | null; ls: number | null; ul: UnderlineKind | "single" | null; ulc: string | null; dstrike: boolean } {
  const u = editor.isActive("underline") ? editor.getAttributes("underline") : null;
  return {
    caps: capsAttr(editor.getAttributes("caps").v),
    ls: letterSpacingAttr(editor.getAttributes("letterSpacing").pt),
    ul: u ? (underlineKindAttr(u.kind) ?? "single") : null,
    ulc: u ? colorAttr(u.c) : null,
    dstrike: editor.isActive("strike") && editor.getAttributes("strike").dbl === true,
  };
}
