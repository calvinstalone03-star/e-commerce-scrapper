import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Tests for the SQL, run against a real Postgres.
 *
 * A mocked database would only prove the query string was assembled, and the
 * things that go wrong here — a join that quietly matches the wrong rows, a
 * trigram threshold that lets half the marketplace through, an aggregate
 * Postgres refuses to plan — are all things only Postgres can tell us.
 *
 * `server-only` is aliased away because `queries.ts` imports it to stay out of
 * client bundles, and outside a React Server Component that import throws.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The scratch database the Python suite already uses. Never the real one:
    // these tests truncate between cases.
    env: {
      DATABASE_URL:
        process.env.ECOM_SCRAPER_TEST_DATABASE_URL ??
        'postgresql://calvin@127.0.0.1:5432/ecom_scraper_test',
    },
    // One file, one connection pool, and cases that share a database — running
    // them in parallel would have each truncating the others' fixtures.
    fileParallelism: false,
  },
});
