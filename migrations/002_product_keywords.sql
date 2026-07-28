-- Which search terms surfaced which product.
--
-- Many-to-many on purpose. A product legitimately shows up under several
-- searches ("lego", "mainan anak", "balok susun"), so a single
-- products.keyword column would silently overwrite every term but the last and
-- make "group products by keyword" quietly wrong.
--
-- The keyword is also what stands in for a category here: search pages carry no
-- category at all, and the term the user actually typed is the grouping they
-- care about for price comparison.
--
-- Idempotent, like every migration in this directory — there is no applied
-- ledger, so re-running is the recovery path.

CREATE TABLE IF NOT EXISTS product_keywords (
    id           serial PRIMARY KEY,
    product_ref  integer NOT NULL,
    keyword      text    NOT NULL,
    marketplace  text    NOT NULL,
    first_seen   timestamptz,
    last_seen    timestamptz,
    CONSTRAINT fk_product_keywords_product_ref
        FOREIGN KEY (product_ref) REFERENCES products (id) ON DELETE CASCADE,
    -- Normalised (lowercased, trimmed) by the writer, so "LEGO" and "lego "
    -- collapse to one row instead of fragmenting a keyword's product set.
    CONSTRAINT uq_product_keywords_product_keyword UNIQUE (product_ref, keyword)
);

-- The dashboard's two hot reads: every product for a keyword, and every keyword
-- for a product.
CREATE INDEX IF NOT EXISTS ix_product_keywords_keyword
    ON product_keywords (keyword, marketplace);

CREATE INDEX IF NOT EXISTS ix_product_keywords_product_ref
    ON product_keywords (product_ref);
