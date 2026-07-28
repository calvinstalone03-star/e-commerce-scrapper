'use client';

/**
 * Last resort: an error thrown by the root layout itself, which `error.tsx`
 * cannot catch because it sits inside that layout.
 *
 * This file replaces the whole document, so it gets neither `globals.css` nor
 * the Geist fonts — every style here has to be inline, and the palette is
 * expressed with `light-dark()` against a declared `color-scheme` so it still
 * follows the reader's OS theme without a stylesheet.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="id">
      <body
        style={{
          colorScheme: 'light dark',
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          background: 'light-dark(#f6f7f9, #0b0d10)',
          color: 'light-dark(#111418, #e6e9ee)',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        }}
      >
        <title>Terjadi kesalahan · Ecom Scraper</title>
        <main style={{ maxWidth: '34rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.125rem', fontWeight: 600, margin: '0 0 0.5rem' }}>
            Dashboard gagal dimuat
          </h1>
          <p style={{ fontSize: '0.875rem', lineHeight: 1.6, margin: '0 0 1.25rem', opacity: 0.75 }}>
            Kesalahan terjadi sebelum halaman sempat dirender. Pastikan Postgres sedang berjalan,
            lalu muat ulang.
            {error.digest ? ` Kode kesalahan: ${error.digest}.` : null}
          </p>
          <button
            type="button"
            onClick={() => unstable_retry()}
            style={{
              font: 'inherit',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: 'pointer',
              padding: '0.5rem 0.875rem',
              borderRadius: '0.375rem',
              border: '1px solid light-dark(#d4d8de, #2a2f37)',
              background: 'light-dark(#ffffff, #151920)',
              color: 'inherit',
            }}
          >
            Coba lagi
          </button>
        </main>
      </body>
    </html>
  );
}
