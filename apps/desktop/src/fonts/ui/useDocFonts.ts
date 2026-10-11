import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";

import { fontKey } from "../docFonts";
import { showDocFonts, type DocFonts } from "../store";

/**
 * Keeps a document's fonts on screen: downloads the catalog families it
 * names (and stand-ins for fonts this device lacks) as they come into use,
 * and reports what had to be stood in for. Runs when the set of fonts
 * changes, not on every keystroke.
 */
export function useDocFonts(
  editor: Editor | null,
  bodyFont: string | null,
  enabled: boolean,
  /** Fonts the document's styles name. */
  styleFonts: readonly string[] = [],
): DocFonts["missing"] {
  const extra = styleFonts.join("|");
  const [missing, setMissing] = useState<DocFonts["missing"]>([]);
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!editor || !enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      const key = `${bodyFont ?? ""}#${fontKey(editor)}#${extra}`;
      if (key === last.current) return;
      last.current = key;
      void showDocFonts(editor.getJSON(), bodyFont, extra ? extra.split("|") : [])
        .then((fonts) => {
          if (live) setMissing(fonts.missing);
        })
        .catch(() => {});
    };
    run();
    const onUpdate = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 400);
    };
    editor.on("update", onUpdate);
    return () => {
      live = false;
      editor.off("update", onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [editor, bodyFont, enabled, extra]);

  return missing;
}
