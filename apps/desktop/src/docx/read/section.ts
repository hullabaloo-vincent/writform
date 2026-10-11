/**
 * A Word section's page setup (`w:sectPr`), in the terms a paragraph's
 * `sect` attribute uses: what a section sets for itself.
 */

import { matchPageSize } from "../../apps/documents/docSettings";
import type { SectionProps } from "../../editor/schema/sanitize";
import { child, int, type XNode } from "../xml";

const inches = (twips: number | undefined): number | undefined =>
  twips === undefined ? undefined : Math.round((twips / 1440) * 1000) / 1000;

/** Everything a `w:sectPr` says that a section here can carry. */
export function sectionProps(sect: XNode | null | undefined): SectionProps {
  const out: SectionProps = {};
  if (!sect) return out;
  const size = child(sect, "w:pgSz");
  const w = inches(int(size?.attrs["w:w"]));
  const h = inches(int(size?.attrs["w:h"]));
  if (w && h) {
    // (A sheet with no name keeps the document's: sections name their paper.)
    const named = matchPageSize(w, h);
    if (named) {
      out.size = named.pageSize;
      out.landscape = named.landscape;
    } else out.landscape = w > h;
  }
  const mar = child(sect, "w:pgMar");
  if (mar) {
    for (const [key, attr] of [
      ["mt", "w:top"],
      ["mr", "w:right"],
      ["mb", "w:bottom"],
      ["ml", "w:left"],
    ] as const) {
      const v = inches(int(mar.attrs[attr]));
      if (v !== undefined) out[key] = Math.min(3, Math.abs(v));
    }
  }
  const cols = int(child(sect, "w:cols")?.attrs["w:num"]);
  out.cols = cols && cols > 1 ? Math.min(3, cols) : 1;
  const start = int(child(sect, "w:pgNumType")?.attrs["w:start"]);
  if (start !== undefined && start >= 0) out.pn = start;
  return out;
}

/** What a section sets that the document's own setup (`base`) doesn't. */
export function sectionDiff(own: SectionProps, base: SectionProps): SectionProps {
  const out: SectionProps = {};
  if (own.size !== undefined && own.size !== base.size) out.size = own.size;
  if (own.landscape !== undefined && own.landscape !== (base.landscape ?? false)) out.landscape = own.landscape;
  for (const key of ["mt", "mr", "mb", "ml"] as const) {
    if (own[key] !== undefined && Math.abs(own[key]! - (base[key] ?? own[key]!)) > 0.005) out[key] = own[key];
  }
  if (own.cols !== undefined && own.cols !== (base.cols ?? 1)) out.cols = own.cols;
  // A page number to start from is the section's own, whatever the base says.
  if (own.pn !== undefined) out.pn = own.pn;
  return out;
}
