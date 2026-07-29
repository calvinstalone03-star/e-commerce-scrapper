-- Comparing our own catalogue against competitors'.
--
-- Two columns and three indexes. The columns answer the two questions the
-- comparison rests on — which listing is which box, and which shop is ours —
-- and neither can be derived from what is already stored:
--
--   products.set_code  the LEGO set number carried in the title. Extracted on
--                      the way in by scraper/set_code.py, because the rules are
--                      full of exceptions ("109 Pieces" is not a set, "1000Pcs"
--                      is not a set) that belong somewhere unit-testable, and
--                      because re-deriving it from 1600 names on every request
--                      pays the same cost repeatedly for an answer that does
--                      not change. `ecom-scraper backfill-set-codes` recomputes
--                      the column when those rules are tuned.
--
--   stores.is_own      whether this is a shop we sell from. As an environment
--                      variable the dashboard and the scraper would each hold
--                      their own idea of who "we" are and could disagree
--                      silently; one column cannot.
--
-- Idempotent, like every migration in this directory — there is no applied
-- ledger, so re-running is the recovery path.

ALTER TABLE products ADD COLUMN IF NOT EXISTS set_code text;

ALTER TABLE stores ADD COLUMN IF NOT EXISTS is_own boolean NOT NULL DEFAULT false;

-- Partial, because the comparison only ever joins rows that have a set number,
-- and most of the marketplace does not.
CREATE INDEX IF NOT EXISTS ix_products_set_code
    ON products (set_code) WHERE set_code IS NOT NULL;

-- Partial for the same reason, and far more extreme: one shop out of hundreds.
CREATE INDEX IF NOT EXISTS ix_stores_is_own
    ON stores (is_own) WHERE is_own;

-- The fallback for listings with no set number in them: accessories, bundles,
-- and the knock-offs that never carry one. Trigram similarity is not trusted to
-- decide anything on its own — the dashboard marks these matches as the weaker
-- kind — but it is the only thing left when there is no number to match on.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS ix_products_name_trgm
    ON products USING gin (name gin_trgm_ops);
