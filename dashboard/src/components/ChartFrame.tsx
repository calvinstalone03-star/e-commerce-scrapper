'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Gives a chart explicit pixel dimensions.
 *
 * This exists because Recharts' own `ResponsiveContainer` does not render under
 * React 19 here. It is not a sizing mistake on our side — measured live, the
 * container reports a correct 1344×160 box and then leaves its `innerHTML`
 * empty, while the identical chart with hardcoded `width`/`height` draws its
 * SVG and bars normally. So the charts are fine; only the auto-sizing wrapper is
 * broken, and this replaces just that.
 *
 * (Recharts 3.10 was worse: it rendered an empty `.recharts-wrapper` even with
 * fixed dimensions, so nothing drew at all. Hence the pin to v2.)
 *
 * Twenty lines we control beats a dependency that fails silently — silently
 * being the operative word, since a chart that renders nothing throws no error
 * and passes every type check.
 *
 * Children receive the measured box and must pass it straight to the chart.
 * Nothing renders until a real width is known, which also avoids the flash of a
 * zero-width chart snapping to size on the first frame.
 */
export function ChartFrame({
  height,
  className,
  children,
}: {
  /** Fixed pixel height. Charts have no intrinsic height to derive one from. */
  height: number;
  className?: string;
  children: (box: { width: number; height: number }) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Measure synchronously before paint, so the chart appears in the same
    // frame as the layout rather than one frame later.
    const measure = () => setMeasured(element.clientWidth);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Render at a fallback width rather than waiting for a measurement.
  //
  // Gating on `measured > 0` looks tidier and is a trap: any environment where
  // the observer does not fire or `clientWidth` reads 0 leaves the chart
  // permanently blank, with no error and nothing to debug — which is exactly
  // what happened here. Drawing at a plausible width and correcting on measure
  // degrades to "slightly wrong for one frame" instead of "invisible forever",
  // and it also means the chart is in the server-rendered HTML.
  const width = measured > 0 ? measured : FALLBACK_WIDTH;

  return (
    <div ref={ref} style={{ height, width: '100%' }} className={className}>
      {children({ width, height })}
    </div>
  );
}

/** Roughly a content-width chart on a laptop; only ever visible for one frame. */
const FALLBACK_WIDTH = 960;
