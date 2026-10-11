/**
 * The level-1 document vocabulary: every node, mark and attribute shipped
 * through 1.0.6, which every client that has ever been released understands.
 *
 * The Yjs binding deletes, for everyone, content whose node type or marks a
 * client's schema doesn't know (and strips unknown attributes when it
 * rewrites a node). So this list is frozen: newer vocabulary lives in
 * `content.ts` behind a document's schema level, and editors that aren't
 * documents — session prompts and submissions — stay on this one.
 */

import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

import { DocElement } from "../DocElement";
import { WfImageLevel1 } from "../nodes/Image";
import { TextFormat } from "../TextFormat";

export const LEVEL1_EXTENSIONS: Extensions = [StarterKit, WfImageLevel1, DocElement, TextFormat];
