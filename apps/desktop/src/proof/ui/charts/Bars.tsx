import type { Series } from "../../reports/types";

/** A few named amounts, one bar each, with what share of the whole each
 *  is. Laid out in rows, so it reads the same at any width. */
export function Bars({ series }: { series: Series }) {
  const total = series.values.reduce((n, v) => n + v, 0);
  const most = Math.max(1, ...series.values);
  return (
    <figure className="wf-proof-chart">
      <figcaption>{series.label}</figcaption>
      <ul className="wf-proof-bars">
        {series.values.map((value, i) => (
          <li key={i}>
            <span>{series.labels?.[i]}</span>
            <i aria-hidden="true">
              <b style={{ width: `${(value / most) * 100}%` }} />
            </i>
            <em>{total ? `${Math.round((value / total) * 100)}%` : ""}</em>
          </li>
        ))}
      </ul>
    </figure>
  );
}
