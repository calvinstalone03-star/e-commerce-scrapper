import type { ReactNode } from 'react';

import { cn } from '@/components/ui/cn';

type EmptyStateProps = {
  title: string;
  /**
   * Why there is nothing here. This is the whole point of the component: a bare
   * "no data" reads as a bug, while "only one snapshot exists so far — scrape
   * this page again another day" reads as a state the tool understands.
   */
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-dashed border-line px-6 py-10 text-center',
        className,
      )}
    >
      <span
        aria-hidden
        className="flex size-9 items-center justify-center rounded-full bg-surface-muted text-muted"
      >
        {icon ?? <DefaultIcon />}
      </span>

      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {description ? (
          <p className="max-w-prose text-sm leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>

      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

function DefaultIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="size-5">
      <path d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5z" strokeLinejoin="round" />
      <path d="M3.5 8.5 12 13l8.5-4.5M12 13v7" strokeLinejoin="round" />
    </svg>
  );
}
