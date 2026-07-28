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
    // The scraper writes NUMERIC prices. Postgres.js hands those over as
    // strings, which is correct — parsing to a float here would reintroduce the
    // rounding the Python side went out of its way to avoid. Formatting happens
    // at the edge, in `format.ts`.
    transform: { undefined: null },
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__ecomSql = sql;
}
