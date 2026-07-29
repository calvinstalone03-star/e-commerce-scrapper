-- The dashboard's login.
--
-- One row, ever. `id boolean PRIMARY KEY DEFAULT true` with a CHECK is the
-- usual trick for a singleton table: there is no second row to disagree with
-- the first, and an accidental INSERT fails loudly instead of quietly creating
-- a second account nobody knows about.
--
-- This is the one table the dashboard writes to, and it is deliberate. Every
-- other table here is scraped data, owned by the Python side and written only
-- by the ingest server. This one is the dashboard's own state, and it lives in
-- Postgres rather than on disk for a reason that only shows up in production:
-- a serverless deployment has no writable, persistent filesystem, so a
-- file-backed credential store re-seeds itself on every cold start, rotating
-- the session key and signing everyone out at random intervals.
--
-- Idempotent, like every migration in this directory — there is no applied
-- ledger, so re-running is the recovery path.

CREATE TABLE IF NOT EXISTS app_credentials (
    id         boolean PRIMARY KEY DEFAULT true CHECK (id),
    username   text        NOT NULL,
    -- scrypt(password, salt). Never the password.
    hash       text        NOT NULL,
    salt       text        NOT NULL,
    -- Signs session cookies. Rotated whenever the credentials change, which is
    -- what makes a password change end the sessions opened with the old one.
    secret     text        NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
