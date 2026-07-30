import { describe, expect, test } from 'vitest';

import { LOCAL_DATABASE_URL, postgresOptions, resolveConnectionString } from '@/lib/db';

/**
 * Which database the dashboard opens, decided before it opens anything.
 *
 * The localhost fallback is right on a laptop and wrong everywhere else. On a
 * deployment there is no Postgres on localhost, so a missing `DATABASE_URL`
 * used to surface as a connection refused — which the UI reports as "make sure
 * Postgres is running", pointing whoever is debugging at the wrong machine
 * entirely. Naming the missing variable is the whole fix.
 */

describe('resolveConnectionString', () => {
  test('uses DATABASE_URL when it is set', () => {
    expect(
      resolveConnectionString({ DATABASE_URL: 'postgresql://neon/db?sslmode=require' }),
    ).toBe('postgresql://neon/db?sslmode=require');
  });

  test('falls back to local Postgres in development', () => {
    expect(resolveConnectionString({})).toBe(LOCAL_DATABASE_URL);
  });

  test('refuses to fall back on a Vercel deployment', () => {
    expect(() => resolveConnectionString({ VERCEL: '1' })).toThrow(/DATABASE_URL/);
  });

  test('refuses to fall back in any production build', () => {
    expect(() => resolveConnectionString({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
  });

  test('treats a blank or whitespace value as unset', () => {
    expect(() => resolveConnectionString({ VERCEL: '1', DATABASE_URL: '   ' })).toThrow(
      /DATABASE_URL/,
    );
    expect(resolveConnectionString({ DATABASE_URL: '' })).toBe(LOCAL_DATABASE_URL);
  });

  test('trims a value pasted with a trailing newline', () => {
    expect(resolveConnectionString({ DATABASE_URL: 'postgresql://neon/db\n' })).toBe(
      'postgresql://neon/db',
    );
  });
});

/**
 * The driver options, which is where two hosted-Postgres failures were hiding.
 *
 * Both were invisible locally: a socket on 127.0.0.1 offers no TLS and there is
 * no pooler in front of it, so the two things that break against Neon are the
 * two things a laptop never exercises.
 */
const NEON = 'postgresql://u:p@ep-x-pooler.aws.neon.tech/neondb?sslmode=require';

describe('postgresOptions', () => {
  test('leaves TLS to the URL by omitting the option, not by passing undefined', () => {
    const options = postgresOptions(NEON, {});

    // postgres.js resolves this with `'ssl' in options` (src/index.js:474), so a
    // key that is present and undefined reads as "TLS off" rather than "let the
    // URL decide" — and Neon then refuses with "connection is insecure".
    expect('ssl' in options).toBe(false);
  });

  test('turns TLS off for a local socket, which does not offer it', () => {
    expect(postgresOptions(LOCAL_DATABASE_URL, {}).ssl).toBe(false);
  });

  test('sends no startup parameters of its own', () => {
    // A pooled Neon endpoint refuses the entire connection over one:
    // "unsupported startup parameter in options: pg_trgm.similarity_threshold".
    // The trigram threshold is set per transaction instead — see queries.ts.
    expect(postgresOptions(NEON, {}).connection?.options).toBeUndefined();
  });

  test('holds one connection per instance on a deployment, eight on a laptop', () => {
    expect(postgresOptions(NEON, { VERCEL: '1' }).max).toBe(1);
    expect(postgresOptions(LOCAL_DATABASE_URL, {}).max).toBe(8);
    expect(postgresOptions(LOCAL_DATABASE_URL, { DATABASE_POOL_MAX: '4' }).max).toBe(4);
  });
});
