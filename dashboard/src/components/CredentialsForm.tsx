'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { changeCredentials, type FormState } from '@/app/actions/auth';

/**
 * Change the username, the password, or both.
 *
 * The current password is asked for every time, including when only the
 * username changes: an open session proves a browser was logged in once, not
 * that the person at the keyboard is the one who logged it in.
 */
export function CredentialsForm({ username }: { username: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(changeCredentials, {});

  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="Username"
        name="username"
        type="text"
        defaultValue={username}
        autoComplete="username"
        hint="Kosongkan artinya tetap sama."
      />

      <Field
        label="Password saat ini"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Password baru"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          hint="Minimal 6 karakter. Kosongkan kalau hanya ganti username."
        />
        <Field
          label="Ulangi password baru"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
        />
      </div>

      {state.error ? (
        <p role="alert" className="rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-negative">
          {state.error}
        </p>
      ) : null}

      <p className="text-xs leading-relaxed text-muted">
        Menyimpan akan mengeluarkanmu dari sesi ini — mengganti kredensial memutar kunci
        penandatangan sesi, jadi cookie lama berhenti berlaku. Masuk lagi dengan yang baru.
      </p>

      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-white transition-opacity disabled:opacity-60"
    >
      {pending ? 'Menyimpan…' : 'Simpan'}
    </button>
  );
}

function Field({
  label,
  name,
  type,
  defaultValue,
  autoComplete,
  hint,
  required,
}: {
  label: string;
  name: string;
  type: string;
  defaultValue?: string;
  autoComplete?: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium tracking-wide text-muted uppercase">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        autoComplete={autoComplete}
        required={required}
        className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-foreground focus:border-accent focus:outline-none"
      />
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}
