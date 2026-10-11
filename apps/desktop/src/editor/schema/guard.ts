import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

import { downlevelSlice } from "./downlevel";
import { DOC_SCHEMA_LEVEL, levels as buildLevels, UNKNOWN_LEVEL, type Levels } from "./levels";

export interface SchemaGuardOptions {
  /** The level this document may hold right now: the lower of what the app
   *  and its server understand. */
  level: () => number;
  levels: Levels;
}

/**
 * Keeps a document at the level its server can store. The toolbar already
 * hides what the level doesn't offer; this is the backstop for everything
 * that isn't a button — a paste from a newer document, a drop, a shortcut:
 * pasted content is down-converted, and any other local change that would
 * introduce newer vocabulary is refused.
 */
export const SchemaGuard = Extension.create<SchemaGuardOptions>({
  name: "schemaGuard",

  addOptions() {
    return { level: () => DOC_SCHEMA_LEVEL, levels: buildLevels };
  },

  addProseMirrorPlugins() {
    const { level, levels } = this.options;
    return [
      new Plugin({
        key: new PluginKey("wf-schema-guard"),
        filterTransaction: (tr) => {
          // Content arriving from Yjs (collaborators, undo) is what it is.
          if (!tr.docChanged || tr.getMeta(ySyncPluginKey)) return true;
          const max = level();
          return tr.steps.every((step, i) => {
            const needs = levels.ofStep(step, tr.docs[i]);
            // Vocabulary missing from the tables is a bug in the tables, not
            // the writer's: never lock the editor over it.
            return needs <= max || needs === UNKNOWN_LEVEL;
          });
        },
        props: {
          transformPasted: (slice, view) => downlevelSlice(slice, level(), view.state.schema, levels),
        },
      }),
    ];
  },
});
