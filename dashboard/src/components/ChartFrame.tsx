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
 *
 * The chart is also deliberately absent from the server-rendered HTML. Recharts
 * decides which axis ticks fit by measuring the rendered text, and its
 * measurement helper returns a hard-coded `{width: 0, height: 0}` whenever there
 * is no DOM (`Global.isSsr`). Server and client therefore compute *different*
 * ticks from identical props — different labels, at different positions — which
 * React reports as a hydration mismatch and "repairs" by discarding the whole
 * chart and rendering it again on the client. Rendering it only after mount
 * makes the first client render the only render.
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
  // `null` means "has not mounted yet" and is the only thing gating the chart.
  //
  // Gating on a *measurement* instead looks tidier and is a trap: any
  // environment where the observer does not fire or `clientWidth` reads 0 leaves
  // the chart permanently blank, with no error and nothing to debug — which is
  // exactly what happened here. So a zero measurement still falls back to a
  // plausible width, degrading to "slightly wrong" instead of "invisible".
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Measure synchronously before paint, so the chart appears in the same
    // frame as the layout rather than one frame later.
    const measure = () => setWidth(element.clientWidth || FALLBACK_WIDTH);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The box keeps its height on the server and on the first client render, so
  // the chart lands in space already reserved for it rather than shoving the
  // rest of the card down when it appears.
  return (
    <div ref={ref} style={{ height, width: '100%' }} className={className}>
      {width === null ? null : children({ width, height })}
    </div>
  );
}

/** Roughly a content-width chart on a laptop; only ever visible for one frame. */
const FALLBACK_WIDTH = 960;
