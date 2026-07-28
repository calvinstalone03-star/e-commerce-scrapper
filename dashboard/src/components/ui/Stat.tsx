import type { ReactNode } from 'react';

import { cn } from './cn';

type StatProps = {
  label: ReactNode;
  value: ReactNode;
  /** Secondary line: a delta, a timestamp, the caveat behind the number. */
  hint?: ReactNode;
  className?: string;
};

/**
 * A labelled figure, with no chrome of its own — compose it inside a `Card`, or
 * lay several out in a bordered grid. Keeping the box out of here is what lets
 * a row of stats share one border instead of stacking four.
 *
 * `value` is a ReactNode rather than a number: prices arrive as strings and are
 * formatted by `format.ts`, and forcing them through a numeric prop here would
 * mean parsing money in a display component.
 */
export function Stat({ label, value, hint, className }: StatProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="text-2xl leading-tight font-semibold tracking-tight tabular-nums">
        {value}
      </span>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </div>
  );
}
