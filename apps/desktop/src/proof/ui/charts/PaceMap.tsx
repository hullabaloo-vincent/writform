import { useRef, useState } from "react";

import type { Series } from "../../reports/types";

const H = 28;

/**
 * The text in order as a band of stretches, each drawn in the tone of its
 * kind (and at its own height, so the kinds are told apart without
 * colour). Move across it to read one off, click or tap to go there.
 */
export function PaceMap({ series, onPick }: { series: Series; onPick: (index: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [at, setAt] = useState<number | null>(null);
  const n = series.values.length;
  const indexOf = (clientX: number): number => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 0;
    return Math.max(0, Math.min(n - 1, Math.floor(((clientX - box.left) / box.width) * n)));
  };
  const said = at === null ? series.label : `Stretch ${at + 1} of ${n}. ${series.labels?.[series.values[at]] ?? ""}.`;
  return (
    <figure className="wf-proof-chart">
      <svg
        ref={ref}
        className="wf-proof-map"
        viewBox={`0 0 ${n} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={series.label}
        tabIndex={0}
        onPointerMove={(e) => setAt(indexOf(e.clientX))}
        onPointerLeave={() => setAt(null)}
        onClick={(e) => onPick(indexOf(e.clientX))}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            setAt(Math.max(0, Math.min(n - 1, (at ?? -1) + (e.key === "ArrowRight" ? 1 : -1))));
          } else if (e.key === "Enter" && at !== null) onPick(at);
        }}
      >
        {series.values.map((band, i) => {
          const h = band === 0 ? H * 0.45 : band === 1 ? H * 0.7 : H;
          return <rect key={i} x={i} y={H - h} width={1.02} height={h} className={`b${band}${i === at ? " at" : ""}`} />;
        })}
      </svg>
      <figcaption>{said}</figcaption>
      <ul className="wf-proof-map-key">
        {(series.labels ?? []).map((label, band) => (
          <li key={label}>
            <i className={`b${band}`} aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
    </figure>
  );
}
