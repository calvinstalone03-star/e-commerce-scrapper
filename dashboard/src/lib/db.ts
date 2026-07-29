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

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://calvin@127.0.0.1:5432/ecom_scraper';

declare global {
  // eslint-disable-next-line no-var
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
  globalThis.__ecomSql ??
  postgres(connectionString, {
    max: 8,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      // pg_trgm's `%` operator answers to this GUC, and its 0.3 default is not
      // the threshold the price comparison uses. Left at 0.3 the GIN index
      // returned every loosely-similar title and `similarity() >= 0.45` threw
      // most of them away afterwards — the same answer, 1.2s of it. Setting the
      // operator's own threshold moves that work into the index, where it is
      // 0.4s. Keep in step with NAME_MATCH_THRESHOLD in queries.ts.
      options: '-c pg_trgm.similarity_threshold=0.45',
    },
    // The scraper writes NUMERIC prices. Postgres.js hands those over as
    // strings, which is correct — parsing to a float here would reintroduce the
    // rounding the Python side went out of its way to avoid. Formatting happens
    // at the edge, in `format.ts`.
    transform: { undefined: null },
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__ecomSql = sql;
}
