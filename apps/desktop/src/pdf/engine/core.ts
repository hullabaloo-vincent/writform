/**
 * The PDF engine, as one open document that is asked to do things.
 *
 * The engine itself is `pkg/` (this project's copy, built to WebAssembly
 * from pdf-engine/). This is the little that sits on it: what can be asked,
 * how it is answered, and the plain shapes that cross to whoever asks. The
 * worker (worker.ts) is this behind messages. A harness runs it as it is.
 */

import { PdfDoc } from "./pkg/wfpdf.js";

/** Why something could not be done. */
export interface EngineFail {
  /** `NeedsPassword`, `WrongPassword`, `Unsupported` (a kind of protection
   *  the engine does not know), `NotPermitted` (its owner does not allow
   *  it), `Invalid` (it cannot be done to this file), or `Crashed` (the
   *  engine itself failed, and was started again). */
  code: "NeedsPassword" | "WrongPassword" | "Unsupported" | "NotPermitted" | "Invalid" | "Crashed";
  message: string;
}

export const isEngineFail = (e: unknown): e is EngineFail => typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" && typeof (e as { message?: unknown }).message === "string";

export interface EnginePage {
  /** As shown (turned as it is turned), points. */
  w: number;
  h: number;
  rotation: number;
}

export interface EngineInfo {
  pages: EnginePage[];
  title: string | null;
  encrypted: boolean;
  /** It carries a signature, which a change breaks. */
  signed: boolean;
  may: { changePages: boolean; annotate: boolean; fillForms: boolean; changeText: boolean };
  canUndo: boolean;
  canRedo: boolean;
  modified: boolean;
}

export interface EngineChange {
  /** Pages whose look changed, as numbered after the change (from 0). */
  changedPages: number[];
  /** Pages were added, taken out or moved. */
  structureChanged: boolean;
  /** Where the mark that was made is among its page's marks. */
  index?: number;
  /** The font that stood in for letters a block's own font lacks. */
  substituted?: string | null;
}

/** A place on a page as it is shown: points from its top left corner. */
export type Point = [x: number, y: number];
/** A box there. */
export type Box = [x: number, y: number, width: number, height: number];
/** Red, green and blue, each from 0 to 1. */
export type Rgb = [number, number, number];

/** A mark to make on a page. */
export type MarkSpec = { page: number; color?: Rgb; opacity?: number; width?: number; fill?: Rgb; text?: string; author?: string } & (
  | { kind: "highlight" | "underline" | "strikeout"; rects: Box[] }
  | { kind: "note"; at: Point }
  | { kind: "ink" | "signature"; strokes: Point[][] }
  | { kind: "rect" | "oval"; rect: Box }
  | { kind: "line"; from: Point; to: Point; arrow?: boolean }
  | { kind: "text"; rect: Box; size: number }
  /** A picture (a signature), `w` by `h` pixels: the pixels go beside it,
   *  four bytes each. */
  | { kind: "picture"; rect: Box; w: number; h: number }
);

/** A mark that is on a page. */
export interface MarkInfo {
  /** Its place among the page's marks (it shifts when one is added or taken out). */
  index: number;
  /** As the file names its kind: Highlight, Text (a note), Ink, Square, FreeText… */
  subtype: string;
  text: string | null;
  author: string | null;
  rect: Box;
  color: Rgb | null;
  locked: boolean;
  /** Put there by filling in or signing. */
  fillSign: boolean;
}

export interface MarkPatch {
  /** So far right and so far down. */
  by?: Point;
  rect?: Box;
  text?: string;
  color?: Rgb;
  opacity?: number;
  width?: number;
}

export interface FieldInfo {
  name: string;
  kind: "text" | "check" | "radio" | "combo" | "list" | "button" | "signature";
  value: string[];
  /** For a choice: each value, and how it is shown. */
  options: [value: string, shown: string][];
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  password: boolean;
  many: boolean;
  maxLen: number | null;
  tooltip: string | null;
  widgets: { page: number; rect: Box; onState: string | null; on: boolean }[];
}

export type FieldValue = { text: string } | { check: boolean } | { radio: string | null } | { choice: string[] };

/** A block of a page's own text. */
export interface BlockInfo {
  /** Good until the page's text is next changed. */
  index: number;
  text: string;
  rect: Box;
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  color: Rgb;
  rotation: number;
}

export interface NewText {
  rect: Box;
  text: string;
  family?: "sans" | "serif" | "mono";
  bold?: boolean;
  italic?: boolean;
  size: number;
  color?: Rgb;
  align?: "left" | "center" | "right" | "justify";
}

export interface AddedInfo {
  index: number;
  rect: Box;
  text: string | null;
  size: number | null;
}

/** What can be read of the open document, each with what it takes and gives. */
export interface EngineReads {
  marks: { args: [page: number]; value: MarkInfo[] };
  fields: { args: []; value: FieldInfo[] };
  textBlocks: { args: [page: number]; value: BlockInfo[] };
  added: { args: [page: number]; value: AddedInfo[] };
}
export type EngineRead = keyof EngineReads;

/** The changes that can be asked for, each with what it takes. Pages are
 *  counted from 0. */
export interface EngineCalls {
  rotate: [pages: number[], degrees: number];
  deletePages: [pages: number[]];
  movePages: [pages: number[], to: number];
  duplicatePages: [pages: number[]];
  insertBlank: [at: number, width: number, height: number];
  /** Pages of another PDF (all of them when `pages` is empty) before `at`. */
  insertFrom: [bytes: Uint8Array, password: string | undefined, pages: number[], at: number];
  undo: [];
  redo: [];
  addMark: [mark: MarkSpec, pixels?: Uint8Array];
  updateMark: [page: number, index: number, patch: MarkPatch];
  deleteMark: [page: number, index: number];
  setField: [name: string, value: FieldValue];
  /** Make what was filled in and signed part of the pages (all when none are named). */
  flattenFillSign: [pages: number[]];
  replaceBlock: [page: number, block: number, text: string];
  addText: [page: number, text: NewText];
  updateText: [page: number, index: number, text: NewText];
  deleteAdded: [page: number, index: number];
}
export type EngineCall = keyof EngineCalls;

/** What the engine throws is JSON in text. Anything else is the engine
 *  itself failing (a trap), after which it cannot be trusted. */
export function failOf(thrown: unknown): EngineFail {
  if (isEngineFail(thrown)) return thrown;
  if (typeof thrown === "string") {
    try {
      const said = JSON.parse(thrown) as unknown;
      if (isEngineFail(said)) return said;
    } catch {
      // Not ours.
    }
  }
  return { code: "Crashed", message: "The PDF engine stopped." };
}

const u32 = (pages: number[]) => Uint32Array.from(pages);
const now = () => Math.floor(Date.now() / 1000);

/** One open PDF. Everything throws an `EngineFail`. */
export class EngineCore {
  private doc: PdfDoc | null = null;

  private get open(): PdfDoc {
    if (!this.doc) throw { code: "Invalid", message: "No PDF is open." } satisfies EngineFail;
    return this.doc;
  }

  private run<T>(f: () => T): T {
    try {
      return f();
    } catch (e) {
      throw failOf(e);
    }
  }

  openPdf(bytes: Uint8Array, password?: string): EngineInfo {
    this.close();
    this.doc = this.run(() => new PdfDoc(bytes, password || undefined));
    return this.info();
  }

  info(): EngineInfo {
    return this.run(() => JSON.parse(this.open.info()) as EngineInfo);
  }

  call<K extends EngineCall>(method: K, args: EngineCalls[K]): EngineChange {
    const doc = this.open;
    const a = args as unknown[];
    // (The engine reads no clock: it is told the time for what it makes.)
    this.run(() => doc.clock(now()));
    const said = this.run((): string => {
      switch (method) {
        case "rotate":
          return doc.rotate(u32(a[0] as number[]), a[1] as number);
        case "deletePages":
          return doc.deletePages(u32(a[0] as number[]));
        case "movePages":
          return doc.movePages(u32(a[0] as number[]), a[1] as number);
        case "duplicatePages":
          return doc.duplicatePages(u32(a[0] as number[]));
        case "insertBlank":
          return doc.insertBlank(a[0] as number, a[1] as number, a[2] as number);
        case "insertFrom":
          return doc.insertFrom(a[0] as Uint8Array, (a[1] as string | undefined) || undefined, u32(a[2] as number[]), a[3] as number);
        case "undo":
          return doc.undo();
        case "redo":
          return doc.redo();
        case "addMark":
          return doc.addMark(JSON.stringify(a[0]), (a[1] as Uint8Array | undefined) ?? undefined);
        case "updateMark":
          return doc.updateMark(a[0] as number, a[1] as number, JSON.stringify(a[2]));
        case "deleteMark":
          return doc.deleteMark(a[0] as number, a[1] as number);
        case "setField":
          return doc.setField(a[0] as string, JSON.stringify(a[1]));
        case "flattenFillSign":
          return doc.flattenFillSign(u32(a[0] as number[]));
        case "replaceBlock":
          return doc.replaceBlock(a[0] as number, a[1] as number, a[2] as string);
        case "addText":
          return doc.addText(a[0] as number, JSON.stringify(a[1]));
        case "updateText":
          return doc.updateText(a[0] as number, a[1] as number, JSON.stringify(a[2]));
        case "deleteAdded":
          return doc.deleteAdded(a[0] as number, a[1] as number);
        default:
          throw JSON.stringify({ code: "Invalid", message: "The engine does not know how to do that." });
      }
    });
    // (Some answers say more than what changed: where a mark went, what
    // font stood in. They are made one shape here.)
    const told = JSON.parse(said) as EngineChange | (Partial<EngineChange> & { change: EngineChange });
    return "change" in told ? { ...told.change, ...(told.index !== undefined ? { index: told.index } : {}), ...(told.substituted !== undefined ? { substituted: told.substituted } : {}) } : told;
  }

  /** Read something of the document (nothing is changed). */
  read<K extends EngineRead>(what: K, args: EngineReads[K]["args"]): EngineReads[K]["value"] {
    const doc = this.open;
    const a = args as unknown[];
    const said = this.run((): string => {
      switch (what) {
        case "marks":
          return doc.marks(a[0] as number);
        case "fields":
          return doc.fields();
        case "textBlocks":
          return doc.textBlocks(a[0] as number);
        case "added":
          return doc.added(a[0] as number);
        default:
          throw JSON.stringify({ code: "Invalid", message: "The engine does not know how to read that." });
      }
    });
    return JSON.parse(said) as EngineReads[K]["value"];
  }

  /** The document as a file: `full` written afresh, else the changes added
   *  to the file as it was opened. */
  bytes(full: boolean): Uint8Array {
    return this.run(() => this.open.save(full, now()));
  }

  /** Some pages as a PDF of their own. */
  extract(pages: number[]): Uint8Array {
    return this.run(() => this.open.extract(u32(pages), now()));
  }

  /** Those bytes were saved: later saves build on them. */
  saved(bytes: Uint8Array): void {
    this.run(() => this.open.markSaved(bytes));
  }

  close(): void {
    try {
      this.doc?.free();
    } catch {
      // (Already gone.)
    }
    this.doc = null;
  }
}
