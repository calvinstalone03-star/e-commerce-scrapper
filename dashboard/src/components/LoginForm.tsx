'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { signIn, type FormState } from '@/app/actions/auth';

/**
 * Username, password, one button.
 *
 * `useActionState` rather than a fetch: the form posts to a Server Action, so
 * it submits and reports its error with JavaScript disabled or still loading.
 * A login screen is the one place that has to work before the bundle does.
 */
export function LoginForm() {
  const [state, formAction] = useActionState<FormState, FormData>(signIn, {});

  return (
    <form action={formAction} className="space-y-3">
      <Field label="Username" name="username" type="text" autoComplete="username" autoFocus />
      <Field label="Password" name="password" type="password" autoComplete="current-password" />

      {state.error ? (
        <p role="alert" className="rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-negative">
          {state.error}
        </p>
      ) : null}

      <Submit />
    </form>
  );
}

function Submit() {
  // `useFormStatus` reads the enclosing form, so a slow scrypt verification
  // shows as a disabled button instead of a page that appears to ignore the
  // click.
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-9 w-full rounded-md bg-accent px-3 text-sm font-medium text-white transition-opacity disabled:opacity-60"
    >
      {pending ? 'Memeriksa…' : 'Masuk'}
    </button>
  );
}

function Field({
  label,
  name,
  type,
  autoComplete,
  autoFocus,
}: {
  label: string;
  name: string;
  type: string;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium tracking-wide text-muted uppercase">{label}</span>
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required
        className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-foreground focus:border-accent focus:outline-none"
      />
    </label>
  );
}
