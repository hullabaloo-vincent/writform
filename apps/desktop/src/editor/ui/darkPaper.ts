import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { parseBorder } from "../schema/sanitize";

/**
 * Dark paper: the page shown dark with light text while writing, for the
 * eyes at night. A choice of this device, and of the screen only. Print,
 * PDF and Word files are what they always were.
 *
 * Text that was given a colour keeps it where it can still be read, and is
 * made lighter where it could not (a navy heading on a dark page). Inside a
 * highlight, a shaded paragraph or a shaded cell the text keeps its own
 * colours and dark ink: those carry their own light ground with them.
 */

const KEY = "wf-doc-paper";

export const useDarkPaper = create<{ dark: boolean; set: (dark: boolean) => void }>((set) => ({
  dark: (() => {
    try {
      return localStorage.getItem(KEY) === "dark";
    } catch {
      return false;
    }
  })(),
  set: (dark) => {
    set({ dark });
    try {
      localStorage.setItem(KEY, dark ? "dark" : "light");
    } catch {
      // A convenience only.
    }
  },
}));

/** The dark page and the ink on it. */
export const DARK_PAPER = "#1d1d22";
export const DARK_INK = "#dcdce2";

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const lin = (v: number) => (v <= 10.31475 ? v / 3294.6 : Math.pow((v + 14.025) / 269.025, 2.4));
const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/** How far apart two colours are to the eye (1 to 21, as accessibility guidance counts it). */
export function contrast(a: string, b: string): number {
  const la = luminance(rgb(a));
  const lb = luminance(rgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const hex = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");

/**
 * A text colour as it is shown on dark paper: itself when it can be read
 * there, else mixed towards white until it can. Near black and near grey
 * with no colour to speak of becomes the page's own ink.
 */
export function onDarkPaper(color: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return DARK_INK;
  const c = color.toLowerCase();
  if (contrast(c, DARK_PAPER) >= 4.5) return c;
  const [r, g, b] = rgb(c);
  if (Math.max(r, g, b) - Math.min(r, g, b) < 24) return DARK_INK;
  for (let step = 1; step <= 20; step += 1) {
    const t = step / 20;
    const mixed = `#${hex(r + (255 - r) * t)}${hex(g + (255 - g) * t)}${hex(b + (255 - b) * t)}`;
    if (contrast(mixed, DARK_PAPER) >= 4.5) return mixed;
  }
  return DARK_INK;
}

/**
 * The rules that show each of these text colours, and each of these colours
 * of a paragraph's border, as it should be on dark paper. (The colour is on
 * the text itself, as a style, so each rule must be marked important to be
 * heard. The second rule of a pair gives it back unchanged on a light
 * ground of its own.)
 */
export function darkPaperCss(colors: readonly string[], lines: readonly string[] = []): string {
  let css = "";
  for (const color of colors) {
    if (!/^#[0-9a-f]{6}$/.test(color)) continue;
    const shown = onDarkPaper(color);
    if (shown === color) continue;
    css += `.wf-paper-dark [data-tc="${color}"]{--wf-tc:${shown} !important}`;
    css += `.wf-paper-dark :is([data-hl],[data-shade],td[data-bg]) [data-tc="${color}"]{--wf-tc:${color} !important}`;
  }
  for (const color of lines) {
    if (!/^#[0-9a-f]{6}$/.test(color)) continue;
    const shown = onDarkPaper(color);
    if (shown === color) continue;
    // (The colour is the last word of what the paragraph says of its border.)
    const said = `[data-bdr-v$=" ${color}"]`;
    css += `.wf-paper-dark ${said}{--wf-bc:${shown} !important}`;
    css += `.wf-paper-dark :is([data-shade]${said},td[data-bg] ${said}){--wf-bc:${color} !important}`;
  }
  return css;
}

/** The text colours a document uses. */
export function textColors(editor: Editor): string[] {
  const seen = new Set<string>();
  editor.state.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === "textColor" && typeof mark.attrs.c === "string") seen.add(mark.attrs.c.toLowerCase());
    }
  });
  return [...seen].sort();
}

/** The colours of the borders its paragraphs have. */
export function lineColors(editor: Editor): string[] {
  const seen = new Set<string>();
  editor.state.doc.descendants((node) => {
    if (!node.isTextblock) return;
    const border = parseBorder(node.attrs.bdr);
    if (border) seen.add(border.color.toLowerCase());
  });
  return [...seen].sort();
}

/** The rules for the document that is open, kept up as colours are used
 *  (looked at again a moment after the text changes). Empty on light paper. */
export function useDarkPaperCss(editor: Editor | null, dark: boolean): string {
  const [css, setCss] = useState("");
  useEffect(() => {
    if (!editor || !dark) {
      setCss("");
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      timer = null;
      if (!editor.isDestroyed) setCss(darkPaperCss(textColors(editor), lineColors(editor)));
    };
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, 400);
    };
    read();
    editor.on("update", soon);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("update", soon);
    };
  }, [editor, dark]);
  return css;
}
