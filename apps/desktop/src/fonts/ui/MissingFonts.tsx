import { X } from "lucide-react";
import { useState } from "react";

import type { FontInfo } from "../css";
import type { DocFonts } from "../store";
import { FontPicker } from "./FontPicker";

/**
 * A quiet line under the ribbon when the document names a font this device
 * can't show or print as itself: what's standing in, and a way to choose
 * another font for good. Stand-ins with the same metrics (and the default
 * body face) aren't worth a notice — nothing moves.
 */
export function MissingFonts({
  missing,
  docFonts,
  docTable,
  onReplace,
}: {
  missing: DocFonts["missing"];
  docFonts: string[];
  docTable: Record<string, FontInfo>;
  onReplace: (from: string, to: string | null, info?: FontInfo) => void;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const first = missing.find((m) => m.id !== null && !m.face.metric && !dismissed.has(m.id));
  if (!first || first.id === null) return null;
  const id = first.id;
  const others = missing.filter((m) => m.id !== null && !m.face.metric && !dismissed.has(m.id)).length - 1;
  return (
    <div className="wf-missing-fonts" role="status">
      <span>
        <strong>{first.face.asked}</strong>{" "}
        {first.face.why === "licence"
          ? `can’t be embedded in a PDF (its license), so it prints in ${first.face.drawn}.`
          : `isn’t on this device, so it is shown and printed in ${first.face.drawn}.`}
        {others > 0 && ` (${others} more)`}
      </span>
      <FontPicker
        value={null}
        docFonts={docFonts.filter((f) => f !== id)}
        docTable={docTable}
        defaultLabel="Replace…"
        title={`Replace ${first.face.asked} throughout the document`}
        className="wf-missing-replace"
        onPick={(to, info) => onReplace(id, to, info)}
      />
      <button className="wf-icon" title="Dismiss" aria-label="Dismiss" onClick={() => setDismissed((prev) => new Set(prev).add(id))}>
        <X size={14} />
      </button>
    </div>
  );
}
