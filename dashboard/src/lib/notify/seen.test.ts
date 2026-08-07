import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { sql } from '@/lib/db';
import { advanceSeen, readSeen } from '@/lib/notify/seen';

/**
 * The read marker, against a real database.
 *
 * Every case here is about a marker that has been moved by something other than
 * this reader reading — a second browser tab, a request that arrived out of
 * order, a mirror that replaced the id space underneath it. Those are the only
 * ways this can go wrong, and none of them are reachable through a mocked
 * client: `GREATEST` and `LEAST` are evaluated by Postgres, so a fake that
 * returned whatever it was handed would prove nothing at all.
 */

const MIGRATIONS = join(process.cwd(), '..', 'migrations');

/** The listing every seeded snapshot hangs off. Nothing here reads it. */
const PRODUCT = 1;

/**
 * The largest snapshot id seeded before each case.
 *
 * Well above the markers the monotonicity case sets, so that the clamp in
 * `readSeen` is not what makes that case pass — it has to be able to fail for
 * the reason it names.
 */
const MAX_SEEDED = 1000;

beforeAll(async () => {
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await sql`TRUNCATE price_snapshots, product_keywords, products, stores RESTART IDENTITY CASCADE`;
  await sql`
    INSERT INTO stores (id, marketplace, shop_id, username, is_own, first_seen, last_seen)
    VALUES (1, 'shopee', 1000, 'rival-a', false, now(), now())`;
  await sql`
    INSERT INTO products (id, marketplace, item_id, shop_ref, name, set_code, url, first_seen, last_seen)
    VALUES (${PRODUCT}, 'shopee', 100, 1, 'Test product', '42218', 'https://shopee.co.id/p/1',
            now(), now())`;
  // Ids chosen, not generated: the marker is compared against max(id), so the
  // cases need to know what that maximum is.
  for (const id of [1, 500, MAX_SEEDED]) {
    await sql`
      INSERT INTO price_snapshots (id, product_ref, price, sold, scraped_at)
      VALUES (${id}, ${PRODUCT}, 100000, 1, now())`;
  }

  // The migration's own seed depends on what was in the database when it first
  // ran, and it is `ON CONFLICT DO NOTHING`, so it will not correct itself on a
  // second pass. Each case starts from a marker it chose.
  //
  // An upsert rather than an UPDATE: two cases below delete the row, and an
  // UPDATE would silently restore nothing and leave the next case running
  // against an empty table.
  await sql`
    INSERT INTO notify_seen (id, last_seen_snapshot_id, updated_at) VALUES (1, 0, now())
    ON CONFLICT (id) DO UPDATE SET last_seen_snapshot_id = 0, updated_at = now()`;
});

async function maxSnapshotId(): Promise<string> {
  const [row] = await sql<{ max: string | null }[]>`SELECT max(id) AS max FROM price_snapshots`;
  return String(row.max);
}

describe('the read marker', () => {
  test('advance is monotonic', async () => {
    await advanceSeen('500');
    await advanceSeen('300');
    expect(await readSeen()).toBe('500');
  });

  test('a marker above max(id) is clamped on read', async () => {
    // The state after a destructive mirror: sync TRUNCATEs and copies ids
    // verbatim, so the target's max(id) can fall below its own marker.
    await sql`UPDATE notify_seen SET last_seen_snapshot_id = 999999 WHERE id = 1`;
    expect(await readSeen()).toBe(String(await maxSnapshotId()));
  });

  test('a missing row is an error, not a silent zero', async () => {
    await sql`DELETE FROM notify_seen`;
    await expect(readSeen()).rejects.toThrow(/006_notify_seen/);
  });

  test('advancing a missing row is an error too, not a silent no-op', async () => {
    // `UPDATE ... WHERE id = 1` over an empty table affects nothing and raises
    // nothing. Without the check, the POST that advances the marker would
    // answer 200 to a database where the marker does not exist, and the badge
    // would come back on the next load with no error anywhere to explain it.
    await sql`DELETE FROM notify_seen`;
    await expect(advanceSeen('500')).rejects.toThrow(/006_notify_seen/);
  });

  test('advance answers with the marker as it now stands', async () => {
    // The caller writes this straight into its response, so a stale request
    // that lost the GREATEST must still be told where the marker actually is —
    // not the id it asked for.
    expect(await advanceSeen('500')).toBe('500');
    expect(await advanceSeen('300')).toBe('500');
  });
});
