import type { Editor } from "@tiptap/core";

import { entryName } from "../../editor/ChapterFocus";
import { untracked } from "../../editor/review/Suggesting";
import { toast } from "../../platform/toast";
import type { BookDesign } from "../model/presets";
import { scanStructure } from "../model/structure";
import type { ChapterArtSource } from "../ui/ChapterArt";

/**
 * The manuscript's chapters for Book ▸ Design ▸ Chapter art, and a way to
 * set one's own art on its heading (a setting of the heading's, so never a
 * suggestion). `level` is the newest format level this document may take.
 */
export function chapterArtSource(editor: Editor, design: BookDesign, level: number): ChapterArtSource {
  const doc = editor.state.doc;
  const rows = scanStructure(doc, "manuscript", design)
    .entries.filter((e) => e.kind === "chapter")
    .map((e) => {
      const attrs = doc.nodeAt(e.pos)?.attrs ?? {};
      return { pos: e.pos, name: entryName(e), art: typeof attrs.art === "string" ? attrs.art : null, facing: typeof attrs.artFacing === "string" ? attrs.artFacing : null };
    });
  const set = (pos: number, which: "art" | "artFacing", value: string | null) => {
    const node = editor.state.doc.nodeAt(pos);
    // (A picture still on its way while the text moved: the heading may be elsewhere now.)
    if (!node || !(which in node.attrs) || !scanStructure(editor.state.doc, "manuscript", design).entries.some((e) => e.pos === pos && e.kind === "chapter")) {
      toast("The chapters have changed since. Try again.", "info");
      return;
    }
    editor.view.dispatch(untracked(editor.state.tr.setNodeAttribute(pos, which, value)));
  };
  return { rows, set, level };
}
