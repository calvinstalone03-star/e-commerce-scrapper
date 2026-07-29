'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { cn } from './cn';

/**
 * The one dropdown this app uses.
 *
 * It replaced two things that had grown apart: rows of filter chips on the
 * price screens, and native `<select>`s on the product list. Chips read fine
 * with three options and stopped scaling at five — by the time there were four
 * groups of them, the controls took more vertical space than the table and gave
 * no clue which group did what. A labelled dropdown says what it filters even
 * when closed, and costs one line whatever the number of options.
 *
 * Custom rather than a styled `<select>` because a native option list cannot
 * carry a description or a count, and those are what make "belum ada lawan" and
 * "cocok via nama" understandable without a legend elsewhere on the page.
 *
 * What it keeps from the native control, deliberately: it is a real button with
 * `aria-expanded`, the list is a `listbox` with `option` children, Escape closes
 * it, Enter and Space open it, and the arrow keys move through it. Anything less
 * is a div that looks like a select.
 */

export type ChoiceOption<T extends string> = {
  value: T;
  label: string;
  /** Shown under the label in the open list. Never truncated into the button. */
  hint?: string;
};

export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  disabled,
}: {
  /** Rendered above the control. It is what the control filters, not a title. */
  label: string;
  value: T;
  options: ChoiceOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const rootRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const selected = options.find((option) => option.value === value) ?? options[0];

  // Close on anything that means "I am done here": a click elsewhere, or Escape.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const commit = (index: number) => {
    const option = options[index];
    if (!option) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  const onButtonKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive((current) => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
        return (next + options.length) % options.length;
      });
      return;
    }
    if (open && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      commit(active);
    }
  };

  return (
    <div ref={rootRef} className={cn('relative min-w-0', className)}>
      <span id={`${id}-label`} className="mb-1 block text-xs font-medium tracking-wide text-muted uppercase">
        {label}
      </span>

      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label`}
        onClick={() => {
          setActive(Math.max(0, options.findIndex((option) => option.value === value)));
          setOpen((current) => !current);
        }}
        onKeyDown={onButtonKeyDown}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 text-sm transition-colors',
          disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-accent/40',
          open && 'border-accent/60',
        )}
      >
        <span className="truncate text-foreground">{selected?.label ?? '–'}</span>
        <svg
          viewBox="0 0 20 20"
          aria-hidden
          className={cn('size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
        >
          <path d="M6 8l4 4 4-4" />
        </svg>
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-labelledby={`${id}-label`}
          className="absolute z-30 mt-1 max-h-72 w-full min-w-max overflow-auto rounded-md border border-line bg-surface py-1 shadow-lg"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <li key={option.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => commit(index)}
                  className={cn(
                    'block w-full px-3 py-1.5 text-left text-sm transition-colors',
                    index === active ? 'bg-surface-muted' : '',
                    isSelected ? 'font-medium text-accent' : 'text-foreground',
                  )}
                >
                  {option.label}
                  {option.hint ? (
                    <span className="mt-0.5 block text-xs font-normal text-muted">{option.hint}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
