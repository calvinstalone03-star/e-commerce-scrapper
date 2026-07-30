import 'server-only';

import postgres from 'postgres';

/**
 * Read-only Postgres access for the dashboard.
 *
 * The Python side owns the schema and the migrations. This app never writes and
 * never migrates — two migration authorities over one database is how schemas
 * drift apart, and the scraper is the one that has to stay correct. Everything
 * here is a SELECT.
 *
 * Raw SQL rather than an ORM for the same reason: an ORM here would mean a
 * second model definition to keep in step with `scraper/db.py`, for queries that
 * are mostly aggregations an ORM would obscure anyway.
 */

/** The scraper's own database, on the machine that scrapes. */
export const LOCAL_DATABASE_URL = 'postgresql://calvin@127.0.0.1:5432/ecom_scraper';

type Env = {
  DATABASE_URL?: string;
  DATABASE_POOL_MAX?: string;
  VERCEL?: string;
  NODE_ENV?: string;
};

/**
 * Which database to open.
 *
 * The localhost fallback is a convenience for the machine the scraper runs on,
 * where the dashboard and the database are the same laptop. On a deployment it
 * is a trap: there is no Postgres on localhost there, so a `DATABASE_URL` that
 * was never set — or was set for Preview but not Production — surfaces as a
 * refused connection, and every error string in this app then blames a Postgres
 * that is running perfectly well on a machine 10,000km away. Refusing to start
 * names the actual problem once instead.
 */
export function resolveConnectionString(env: Env = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (url) return url;

  if (env.VERCEL || env.NODE_ENV === 'production') {
    throw new Error(
      'DATABASE_URL is not set. The dashboard has no database to read. Set it to the ' +
        'pooled Neon connection string (the host with `-pooler` in it, ending in ' +
        '`?sslmode=require`) for this environment — see README section 7.',
    );
  }

  return LOCAL_DATABASE_URL;
}

const connectionString = resolveConnectionString();

type Options = Parameters<typeof postgres>[1] & { ssl?: unknown };

/**
 * How the driver is configured, and the two hosted-Postgres traps in it.
 *
 * **TLS.** postgres.js reads `sslmode` from the URL, but only when the option is
 * absent — it resolves each option with `'ssl' in options`, so a key that is
 * present and `undefined` means "no TLS", not "let the URL decide". This used to
 * pass `undefined` on purpose and Neon answered "connection is insecure (try
 * using `sslmode=require`)" to a URL that said exactly that. The key has to be
 * missing, so it is built conditionally.
 *
 * **No startup parameters.** The trigram threshold used to travel here as
 * `options: '-c pg_trgm.similarity_threshold=0.45'`, which a pooled Neon
 * endpoint rejects outright — not the statement, the whole connection:
 * "unsupported startup parameter in options". It is set per transaction now, in
 * `queries.ts`, which is the only form a pooler in transaction mode honours.
 *
 * **Pool size.** Eight is right for a laptop, where there is one long-lived
 * server. It is wrong for serverless, where every concurrent invocation is its
 * own instance: eight each against a database whose pooled endpoint allows a few
 * hundred total is how a dashboard takes itself down under a refresh. One per
 * instance, and let the platform's own pooler do the pooling.
 */
export function postgresOptions(url: string, env: Env = process.env): Options {
  const options: Options = {
    max: Number(env.DATABASE_POOL_MAX ?? (env.VERCEL ? 1 : 8)),
    idle_timeout: 20,
    connect_timeout: 10,
    // The scraper writes NUMERIC prices. Postgres.js hands those over as
    // strings, which is correct — parsing to a float here would reintroduce the
    // rounding the Python side went out of its way to avoid. Formatting happens
    // at the edge, in `format.ts`.
    transform: { undefined: null },
  };

  // A local socket offers no TLS, so there the answer is a flat no. Anything
  // carrying `sslmode` is a hosted database describing its own requirement —
  // including `verify-full`, which is why this defers to the URL rather than
  // flattening every case to `require`.
  if (!url.includes('sslmode=')) options.ssl = false;

  return options;
}

declare global {
  var __ecomSql: ReturnType<typeof postgres> | undefined;
}

/**
 * The shared client.
 *
 * Cached on globalThis because Next's dev server re-evaluates modules on every
 * edit; without this each hot reload would open a fresh pool and leak the old
 * one until Postgres refused new connections.
 */
export const sql =
  globalThis.__ecomSql ?? postgres(connectionString, postgresOptions(connectionString));

if (process.env.NODE_ENV !== 'production') {
  globalThis.__ecomSql = sql;
}
