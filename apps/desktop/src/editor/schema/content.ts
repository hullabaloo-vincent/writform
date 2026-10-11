/**
 * The document editors' content schema — what a document can hold. One list
 * for the server and on-device editors, the read-only previews and import,
 * so they can't drift apart (a preview missing a node type renders an empty
 * document; an importer missing one drops it).
 *
 * Level 1 (level1.ts) plus what later levels added: level 2 is formatting
 * on a run of text, paragraph indents, borders and shading, checklists,
 * tables, footnotes, a table of contents, picture placement, sections, and
 * tracked changes.
 * Every name here must be in the tables of levels.ts — a harness checks.
 */

import { getSchema, type Extensions } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";

import { DocElement } from "../DocElement";
import { ParaFormat } from "../format/ParaFormat";
import { RUN_MARKS } from "../marks/RunFormat";
import { Footnote } from "../nodes/Footnote";
import { WfImage, WfResizableImage } from "../nodes/Image";
import { ListFormat, TaskItem, TaskList } from "../nodes/TaskList";
import { Toc } from "../nodes/Toc";
import { TRACK_EXTENSIONS } from "../review/TrackMarks";
import { Table, TableCell, TableRow } from "../tables/Table";
import { TextFormat, type TextFormatOptions } from "../TextFormat";

export interface ContentOptions {
  /** Off where collaboration provides undo (the Yjs undo manager). */
  history?: boolean;
  /** Which formatting shortcuts the format binds. */
  textFormat?: Partial<TextFormatOptions>;
  /** Corner handles on pictures (the editors; not previews or import). */
  resizeImages?: boolean;
}

export function docContentExtensions(opts: ContentOptions = {}): Extensions {
  return [
    opts.history === false ? StarterKit.configure({ undoRedo: false }) : StarterKit,
    opts.resizeImages ? WfResizableImage : WfImage,
    DocElement,
    opts.textFormat ? TextFormat.configure(opts.textFormat) : TextFormat,
    // ---- level 2
    ...RUN_MARKS,
    ParaFormat,
    TaskList,
    TaskItem,
    ListFormat,
    Table,
    TableRow,
    TableCell,
    Footnote,
    Toc,
    ...TRACK_EXTENSIONS,
  ];
}

let schema: Schema | null = null;

/** The documents' schema, for code that has a document's JSON but no
 *  editor (exports, comparing versions). */
export function contentSchema(): Schema {
  schema ??= getSchema(docContentExtensions());
  return schema;
}
