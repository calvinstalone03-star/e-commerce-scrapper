'use client';

import { useEffect } from 'react';

import { EmptyState } from '@/components/EmptyState';

/**
 * The route-level error boundary.
 *
 * Every page here reads Postgres during the render, so a database that is down
 * is a thrown render — not an exceptional case but the expected one whenever the
 * scraper's stack is not running. The API routes already answer that case with
 * a 503 and a sentence telling the reader to start Postgres; without this file
 * the rendered pages answered it with Next's bare "Application error" screen,
 * which drops the nav too and leaves no way back to a route that still works.
 *
 * `unstable_retry` rather than `reset`: `reset` only re-renders the boundary's
 * children from the client, so a failed server query would produce the same
 * failure. `unstable_retry` re-fetches the segment, which is the only thing that
 * can succeed once Postgres is back.
 */
export default function RouteError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    // The production digest is all the browser gets; the matching stack is in
    // the server log, and this is what lets someone line the two up.
    console.error('Render gagal', error.digest ?? '', error);
  }, [error]);

  return (
    <EmptyState
      className="mx-auto max-w-2xl"
      title="Halaman ini gagal dimuat"
      description={
        <>
          Dashboard membaca database <code className="font-mono">ecom_scraper</code> setiap kali
          halaman dibuka. Pastikan Postgres sedang berjalan, lalu coba lagi.
          {error.digest ? (
            <>
              {' '}
              Kode kesalahan untuk dicocokkan dengan log server:{' '}
              <code className="font-mono">{error.digest}</code>.
            </>
          ) : null}
        </>
      }
      action={
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          Coba lagi
        </button>
      }
    />
  );
}
