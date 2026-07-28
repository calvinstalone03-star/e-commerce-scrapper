'use client';

import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';

import { cn } from './cn';

/**
 * Client components even though neither holds state: both exist to be
 * controlled, and a `value`/`onChange` pair can only be handed over from a
 * client component. Declaring the boundary here means an accidental import into
 * a server tree fails with "functions cannot be passed to Client Components"
 * pointing at the caller, instead of at a ref that silently never attaches.
 */
const FIELD =
  'h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-foreground ' +
  'transition-colors hover:border-muted/50 disabled:cursor-not-allowed disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type = 'text', ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(FIELD, 'placeholder:text-muted', className)}
        {...props}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...props }, ref) {
    // Native appearance kept on purpose: `color-scheme` on :root already makes
    // the popup match the theme, which a custom-drawn control would not.
    return <select ref={ref} className={cn(FIELD, 'cursor-pointer pr-1.5', className)} {...props} />;
  },
);
