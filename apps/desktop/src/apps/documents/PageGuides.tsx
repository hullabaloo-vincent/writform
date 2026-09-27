import type { PageLayoutResult } from "../../editor/Paginate";

/**
 * The page-view overlay: for each boundary the paginator reports, a
 * physical gap band (the app background showing "between" two sheets) with
 * the next page's number set on the left — or, when a boundary falls
 * inside a block too tall to push (`clean: false`), a hairline. Page 1
 * gets a small corner label so the numbering reads as a sequence.
 * Lives inside `.wf-page` (position: relative; overflow: hidden) and is
 * entirely pointer-transparent.
 */
export function PageGuides({ layout }: { layout: PageLayoutResult | null }) {
  if (!layout) return null;
  return (
    <div className="wf-page-guides" aria-hidden>
      <span className="wf-page-num-first">Page 1</span>
      {layout.bands.map((band) =>
        band.clean ? (
          <div
            key={band.page}
            className="wf-page-gap"
            style={{ top: band.y, height: layout.gap }}
          >
            <span>Page {band.page}</span>
          </div>
        ) : (
          <div key={band.page} className="wf-page-guide" style={{ top: band.y + layout.gap }}>
            <span>Page {band.page}</span>
          </div>
        ),
      )}
    </div>
  );
}
