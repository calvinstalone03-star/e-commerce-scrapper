import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { LoginForm } from '@/components/LoginForm';
import { isSignedIn } from '@/lib/auth';
import { safeNextPath } from '@/lib/next-path';

/**
 * The only page outside the shell.
 *
 * No sidebar, no topbar, no database read — a login screen that queries
 * Postgres to render is a login screen that fails when Postgres does, and being
 * locked out of a dashboard because the thing it reports on is down is the
 * wrong failure.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Masuk',
  description: 'Masuk ke Market Competition Landscape.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await isSignedIn()) redirect('/');

  const params = await searchParams;
  const changed = params.changed !== undefined;
  const next = safeNextPath(params.next);

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <header className="space-y-2 text-center">
          <span
            aria-hidden
            className="mx-auto flex size-10 items-center justify-center rounded-lg bg-accent/12 text-accent"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="size-5">
              <path d="M4 18V9M10 18V5M16 18v-6M22 18H2" />
            </svg>
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Market Competition Landscape
          </h1>
          <p className="text-sm text-muted">Masuk untuk melihat posisi harga dan analitik.</p>
        </header>

        {changed ? (
          <p className="rounded-md border border-positive/40 bg-positive/10 px-3 py-2 text-sm text-positive">
            Kredensial diperbarui. Masuk lagi dengan yang baru.
          </p>
        ) : null}

        <LoginForm next={next} />
      </div>
    </main>
  );
}
