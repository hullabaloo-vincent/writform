import { useRef, useState } from "react";

import type { Series } from "../../reports/types";

const H = 64;
const BAR = 2;

/**
 * A text's sentences in order, a bar each (or a bar for every few, in a
 * long text), as tall as the sentence is long. Speech is drawn lighter.
 * Move across it to read a bar off, and click or tap to go there. Plain
 * SVG, scaled to whatever width it is given.
 */
export function LengthStrip({ series, onPick }: { series: Series; onPick: (index: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [at, setAt] = useState<number | null>(null);
  const n = series.values.length;
  const most = Math.max(1, ...series.values);
  const indexOf = (clientX: number): number => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 0;
    return Math.max(0, Math.min(n - 1, Math.floor(((clientX - box.left) / box.width) * n)));
  };
  const per = series.per ?? 1;
  const said = at === null ? series.label : per === 1 ? `Sentence ${at + 1} of ${n}. ${series.values[at]} words.` : `Sentences ${at * per + 1} to ${Math.min(n * per, (at + 1) * per)}. About ${series.values[at]} words each.`;
  return (
    <figure className="wf-proof-chart">
      <svg
        ref={ref}
        className="wf-proof-strip"
        viewBox={`0 0 ${n * BAR} ${H}`}
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
        {series.values.map((value, i) => {
          const h = Math.max(1, (value / most) * H);
          return <rect key={i} x={i * BAR} y={H - h} width={BAR * 0.8} height={h} className={`${series.light?.[i] ? "light" : ""}${i === at ? " at" : ""}`} />;
        })}
      </svg>
      <figcaption>{said}</figcaption>
    </figure>
  );
}
