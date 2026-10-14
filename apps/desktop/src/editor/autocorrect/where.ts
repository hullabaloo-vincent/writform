import type { Node as PmNode } from "@tiptap/pm/model";

/**
 * Where a sentence's capital may be set. Not in the lines a script sets in
 * capitals or gives a shape of their own, and not in verse, where a line
 * begins as the poet began it. (Slips are still set right there.)
 */
const NOT_IN: Record<string, readonly string[] | "all"> = {
  screenplay: ["scene_heading", "character", "parenthetical", "transition"],
  stageplay: ["act_heading", "scene_heading", "character"],
  poetry: "all",
};

export function capitalsHere(format: string, block: PmNode): boolean {
  const rule = NOT_IN[format];
  if (rule === "all") return false;
  const element = block.attrs.element as unknown;
  if (element === "verse") return false;
  return !(rule && typeof element === "string" && rule.includes(element));
}
