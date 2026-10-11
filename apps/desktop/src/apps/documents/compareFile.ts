import type { JSONContent } from "@tiptap/core";

import type { CompareSide } from "./CompareView";

/** A Word file as one side of a comparison. (Its text only: the pictures
 *  in it aren't loaded.) */
export async function sideFromFile(file: File): Promise<CompareSide> {
  const { readDocx } = await import("../../docx/read");
  const read = await readDocx(await file.arrayBuffer());
  return { title: file.name, doc: read.content as JSONContent };
}
