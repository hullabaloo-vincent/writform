/**
 * Loading primitives: a spinner for full-pane waits, skeleton rows for lists.
 * Replaces bare "Loading…" strings and — worse — blank panes during fetches.
 */

export function Loading({ label }: { label?: string }) {
  return (
    <div className="wf-loading">
      <span className="wf-spinner" aria-hidden />
      {label && <span>{label}</span>}
    </div>
  );
}

/** Shimmering placeholder rows sized like list items. */
export function SkeletonRows({ rows = 5, avatar = false }: { rows?: number; avatar?: boolean }) {
  return (
    <div className="wf-skeleton-list" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="wf-skeleton-row">
          {avatar && <span className="wf-skeleton wf-skeleton-avatar" />}
          <span
            className="wf-skeleton wf-skeleton-line"
            style={{ width: `${55 + ((i * 17) % 40)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
