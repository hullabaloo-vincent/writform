import { useEffect, useRef, useState } from "react";

/**
 * Hairline + label every 11 inches of the sheet: an honest approximation of
 * print pagination (fonts and margins differ per export target, and explicit
 * page breaks don't reflow the sheet). The sheet's width is CSS-inch based,
 * so the 11in rhythm maps exactly to 96px/in regardless of window width.
 * Lives inside `.wf-page` (position: relative; overflow: hidden).
 */
export function PageGuides() {
  const ref = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState(1);

  useEffect(() => {
    const sheet = ref.current?.parentElement;
    if (!sheet) return;
    const measure = () =>
      setPages(Math.max(1, Math.ceil(sheet.offsetHeight / (11 * 96))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sheet);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} className="wf-page-guides" aria-hidden>
      {Array.from({ length: pages - 1 }, (_, i) => (
        <div key={i} className="wf-page-guide" style={{ top: `${(i + 1) * 11}in` }}>
          Page {i + 2}
        </div>
      ))}
    </div>
  );
}
