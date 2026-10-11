import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import type * as Y from "yjs";

import { bodyLook, type DocSettings } from "../../apps/documents/docSettings";
import type { FontInfo } from "../../fonts/css";
import type { FormatContext } from "../format/effective";
import { stylesCss } from "./css";
import { onDocStylesChange, readDocStyles, writeDocStyle } from "./docStyles";
import { resolveStyles, type ResolvedStyles, type StyleEntry, type StyleOverrides } from "./sheet";

export interface DocStyles {
  /** What the document has changed (as stored), for exports and previews. */
  overrides: StyleOverrides;
  styles: ResolvedStyles;
  /** Styles and schema level, for the formatting commands. */
  format: FormatContext;
  /** The same, readable from a key handler set up once. */
  formatRef: RefObject<FormatContext | null>;
  /** A value for the page element's `data-wfs` attribute… */
  scope: string;
  /** …and the stylesheet that draws the changed styles inside it. */
  css: string;
  save: (id: string, entry: StyleEntry | null) => void;
}

/**
 * A document's paragraph styles, live: read from its style table, resolved
 * against its body text, and kept current as either changes.
 */
export function useDocStyles(doc: Y.Doc, settings: DocSettings, level: number, fonts: Record<string, FontInfo> = {}): DocStyles {
  const [overrides, setOverrides] = useState(() => readDocStyles(doc));
  useEffect(() => {
    setOverrides(readDocStyles(doc));
    return onDocStylesChange(doc, () => setOverrides(readDocStyles(doc)));
  }, [doc]);

  const { bodyFont, bodySize, bodyLine, paraSpacing, firstIndent } = settings;
  const styles = useMemo(
    () => resolveStyles(bodyLook({ bodyFont, bodySize, bodyLine, paraSpacing, firstIndent }), overrides),
    [bodyFont, bodySize, bodyLine, paraSpacing, firstIndent, overrides],
  );
  const format = useMemo<FormatContext>(() => ({ styles, level }), [styles, level]);
  const formatRef = useRef<FormatContext | null>(null);
  useEffect(() => {
    formatRef.current = format;
  }, [format]);

  // useId's punctuation doesn't belong in an attribute selector.
  const scope = useId().replace(/[^a-zA-Z0-9]/g, "");
  const css = useMemo(() => stylesCss(`[data-wfs="${scope}"]`, styles, fonts), [scope, styles, fonts]);
  const save = useCallback((id: string, entry: StyleEntry | null) => writeDocStyle(doc, id, entry), [doc]);

  return { overrides, styles, format, formatRef, scope, css, save };
}
