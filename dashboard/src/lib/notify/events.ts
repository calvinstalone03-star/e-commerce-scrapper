import 'server-only';

import type { Ceilings, Sql, Watermark } from '@/lib/notify/watermark';

/**
 * What has happened since the watermark.
 *
 * Three questions, three queries, all bounded above by the ceilings so that no
 * row is examined twice and a row arriving mid-run waits for the next run
 * instead. The one thing that bound does not promise is that nothing is ever
 * skipped — see `readCeilings` in `watermark.ts` for the window that leaves
 * open and why it is left open.
 */

export type PriceChange = {
  productId: number;
  name: string | null;
  setCode: string | null;
  marketplace: string;
  url: string | null;
  storeId: number | null;
  username: string | null;
  isOwn: boolean;
  /** NUMERIC, so a string. Converted only where it is formatted. */
  previousPrice: string;
  price: string;
  scrapedAt: Date;
};

export type NewStore = {
  storeId: number;
  marketplace: string;
  username: string;
  name: string | null;
  products: number;
};

export type NewProduct = {
  productId: number;
  name: string | null;
  setCode: string | null;
  marketplace: string;
  url: string | null;
  storeId: number;
  username: string;
};

export type Events = {
  priceChanges: PriceChange[];
  newStores: NewStore[];
  newProducts: NewProduct[];
};

export function hasAny(events: Events): boolean {
  return (
    events.priceChanges.length > 0 ||
    events.newStores.length > 0 ||
    events.newProducts.length > 0
  );
}

/**
 * Price movements worth reporting.
 *
 * Not `lag()`. The comparison this needs is not "the previous snapshot" but
 * "the newest snapshot at least `minGapHours` older", because in this database
 * adjacent captures disagree about price without anything having been repriced:
 * 37 of 38 pairs taken 1.5-3.5 hours apart differ, against 3 of 1,335 taken a
 * day apart, and `sold` is identical across the near pairs. A per-row search
 * for a qualifying predecessor is a LATERAL, not a window.
 *
 * `CROSS JOIN LATERAL` rather than `LEFT JOIN LATERAL`: a product with no
 * old-enough comparison produces no row at all, which is the wanted behaviour.
 * Without a trustworthy predecessor there is nothing to say — and that also
 * subsumes the "price became known" rule, since `price IS NOT NULL` is required
 * on both sides.
 *
 * `DISTINCT ON (product_ref)` collapses a product captured several times in one
 * run to its newest capture: one product, one event.
 *
 * The LATERAL is served by `ix_price_snapshots_product_ref_scraped_at`
 * (migrations/001_init.sql:94) — its column order and DESC direction already
 * match, so each lookup is one index seek rather than a scan.
 */
async function selectPriceChanges(
  tx: Sql,
  watermark: Watermark,
  ceilings: Ceilings,
  minGapHours: number,
): Promise<PriceChange[]> {
  const rows = await tx<
    {
      product_id: number;
      name: string | null;
      set_code: string | null;
      marketplace: string;
      url: string | null;
      store_id: number | null;
      username: string | null;
      is_own: boolean | null;
      previous_price: string;
      price: string;
      scraped_at: Date;
    }[]
  >`
    WITH latest_new AS (
      SELECT DISTINCT ON (ps.product_ref)
             ps.id, ps.product_ref, ps.price, ps.scraped_at
        FROM price_snapshots ps
       WHERE ps.id > ${watermark.lastSnapshotId}
         AND ps.id <= ${ceilings.snapshotId}
         AND ps.price IS NOT NULL
       ORDER BY ps.product_ref, ps.scraped_at DESC, ps.id DESC
    )
    SELECT p.id                AS product_id,
           p.name             AS name,
           p.set_code         AS set_code,
           p.marketplace      AS marketplace,
           p.url              AS url,
           s.id               AS store_id,
           s.username         AS username,
           s.is_own           AS is_own,
           older.price        AS previous_price,
           latest_new.price   AS price,
           latest_new.scraped_at AS scraped_at
      FROM latest_new
      CROSS JOIN LATERAL (
        SELECT ps.price
          FROM price_snapshots ps
         WHERE ps.product_ref = latest_new.product_ref
           -- Otherwise the nearest match at gap 0: the row itself always
           -- satisfies scraped_at <= its own scraped_at and wins the tie-break
           -- below, so without this it would be "compared" to itself.
           AND ps.id <> latest_new.id
           AND ps.price IS NOT NULL
           AND ps.scraped_at <= latest_new.scraped_at - make_interval(hours => ${minGapHours})
         ORDER BY ps.scraped_at DESC, ps.id DESC
         LIMIT 1
      ) AS older
      JOIN products p ON p.id = latest_new.product_ref
      LEFT JOIN stores s ON s.id = p.shop_ref
     WHERE latest_new.price <> older.price
     ORDER BY latest_new.id`;

  return rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
    setCode: row.set_code,
    marketplace: row.marketplace,
    url: row.url,
    storeId: row.store_id,
    username: row.username,
    // A product whose shop was never resolved has no `is_own` to read. It is
    // not ours until something says it is.
    isOwn: row.is_own ?? false,
    previousPrice: String(row.previous_price),
    price: String(row.price),
    scrapedAt: row.scraped_at,
  }));
}

async function selectNewStores(
  tx: Sql,
  watermark: Watermark,
  ceilings: Ceilings,
): Promise<NewStore[]> {
  const rows = await tx<
    {
      store_id: number;
      marketplace: string;
      username: string;
      name: string | null;
      products: string;
    }[]
  >`
    SELECT s.id          AS store_id,
           s.marketplace AS marketplace,
           s.username    AS username,
           s.name        AS name,
           (SELECT count(*) FROM products p WHERE p.shop_ref = s.id) AS products
      FROM stores s
     WHERE s.id > ${watermark.lastStoreId}
       AND s.id <= ${ceilings.storeId}
     ORDER BY s.id`;

  return rows.map((row) => ({
    storeId: row.store_id,
    marketplace: row.marketplace,
    username: row.username,
    name: row.name,
    products: Number(row.products),
  }));
}

/**
 * New listings in shops that were already known.
 *
 * `s.id <= watermark.lastStoreId` is the whole requirement in one clause. A
 * shop discovered in this same run has not passed the watermark, so its
 * catalogue — up to 1,600 listings — is not reported listing by listing. The
 * shop itself is the news; its listings become news from the next run on.
 */
async function selectNewProducts(
  tx: Sql,
  watermark: Watermark,
  ceilings: Ceilings,
): Promise<NewProduct[]> {
  const rows = await tx<
    {
      product_id: number;
      name: string | null;
      set_code: string | null;
      marketplace: string;
      url: string | null;
      store_id: number;
      username: string;
    }[]
  >`
    SELECT p.id          AS product_id,
           p.name        AS name,
           p.set_code    AS set_code,
           p.marketplace AS marketplace,
           p.url         AS url,
           s.id          AS store_id,
           s.username    AS username
      FROM products p
      JOIN stores s ON s.id = p.shop_ref
     WHERE p.id > ${watermark.lastProductId}
       AND p.id <= ${ceilings.productId}
       AND s.id <= ${watermark.lastStoreId}
     ORDER BY p.id`;

  return rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
    setCode: row.set_code,
    marketplace: row.marketplace,
    url: row.url,
    storeId: row.store_id,
    username: row.username,
  }));
}

export async function collectEvents(
  tx: Sql,
  watermark: Watermark,
  ceilings: Ceilings,
  minGapHours: number,
): Promise<Events> {
  const [priceChanges, newStores, newProducts] = await Promise.all([
    selectPriceChanges(tx, watermark, ceilings, minGapHours),
    selectNewStores(tx, watermark, ceilings),
    selectNewProducts(tx, watermark, ceilings),
  ]);
  return { priceChanges, newStores, newProducts };
}

/**
 * The newest observation in the database the notifier is reading.
 *
 * Not an event — the input to the staleness guard. Silence is the notifier's
 * correct answer when nothing changed and its symptom when nothing is being
 * written, and this is what distinguishes the two.
 */
export async function latestScrapedAt(tx: Sql): Promise<Date | null> {
  const [row] = await tx<{ latest: Date | null }[]>`
    SELECT max(scraped_at) AS latest FROM price_snapshots`;
  return row?.latest ?? null;
}
