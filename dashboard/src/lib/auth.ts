import 'server-only';

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { cookies } from 'next/headers';

import { sql } from '@/lib/db';

/**
 * Who may open this dashboard.
 *
 * The bar this has to clear is "not readable by whoever wanders onto the
 * machine", not "survives an attacker on the network" — the server binds
 * 127.0.0.1 (see scripts/dashboard-server.sh) and never leaves the laptop. What
 * that changes is the threat model, not the craft: the password is still stored
 * as a scrypt hash with a per-credential salt, compared in constant time, and
 * the session is a signed token rather than the username in a cookie. Those
 * cost nothing here and are the difference between a lock and the appearance of
 * one.
 *
 * Credentials live in `app_credentials`, one of the two tables this app writes
 * to — `notify_seen` (`lib/notify/seen.ts`) is the other, and
 * everything the scraper owns is read-only here, as `lib/db.ts` sets out. On
 * disk would be simpler and is what this started as, right up until the first
 * serverless deploy: there is no writable persistent filesystem there, so a
 * file-backed store re-seeds on every cold start, rotates the signing key and
 * signs everyone out at intervals nobody can predict. The schema is still
 * authored on the Python side, in migrations/004_app_credentials.sql.
 */

const COOKIE_NAME = 'mcl_session';

//: A week. Long enough not to be a daily nuisance on a machine only its owner
//: uses, short enough that a forgotten laptop stops being logged in.
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

//: What the row is seeded with the first time the dashboard starts, when the
//: environment says nothing. Weak on purpose — it is meant to be changed on the
//: settings page, and a random one nobody is told is just a lockout.
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'ecom123';

/**
 * What the first run seeds.
 *
 * The published default above is fine on a laptop and is a hole on a
 * deployment: the app is reachable the moment it answers its first request, and
 * `admin` / `ecom123` is written in the README. `DASHBOARD_PASSWORD` closes the
 * window between the deploy finishing and someone reaching /settings — set it
 * with the database URL and the dashboard is never briefly open.
 *
 * Read at seed time, not per request: once the row exists the environment is
 * ignored, so changing the password in the UI is not undone by the next cold
 * start, and clearing the variable does not lock anyone out.
 */
function seedCredentials(): { username: string; password: string } {
  return {
    username: process.env.DASHBOARD_USERNAME?.trim() || DEFAULT_USERNAME,
    // Trimmed because these are usually pasted, and a trailing newline in a
    // password is a lockout nobody would think to look for.
    password: process.env.DASHBOARD_PASSWORD?.trim() || DEFAULT_PASSWORD,
  };
}

type Credentials = {
  username: string;
  /** scrypt(password, salt) — never the password. */
  hash: string;
  salt: string;
  /** Signs session tokens. Rotating it logs everyone out, which is the point. */
  secret: string;
  updatedAt: string;
};

function hashPassword(password: string, salt: string): string {
  // N=16384 is scrypt's usual interactive cost: a few milliseconds per attempt
  // here, and enough to make a stolen file unpleasant to brute-force.
  return scryptSync(password, salt, 64).toString('hex');
}

function newCredentials(username: string, password: string): Credentials {
  const salt = randomBytes(16).toString('hex');
  return {
    username,
    salt,
    hash: hashPassword(password, salt),
    secret: randomBytes(32).toString('hex'),
    updatedAt: new Date().toISOString(),
  };
}

async function readCredentials(): Promise<Credentials> {
  const [row] = await sql`
    SELECT username, hash, salt, secret, updated_at AS "updatedAt"
    FROM app_credentials
    WHERE id
  `;
  if (row?.username && row?.hash && row?.salt && row?.secret) return row as Credentials;

  // First run: seed the singleton. ON CONFLICT DO NOTHING rather than a check
  // then an insert — two cold starts can arrive at once, and the loser of that
  // race must read the winner's row, not overwrite it with a different secret.
  const seed = seedCredentials();
  const seeded = newCredentials(seed.username, seed.password);
  await sql`
    INSERT INTO app_credentials (id, username, hash, salt, secret)
    VALUES (true, ${seeded.username}, ${seeded.hash}, ${seeded.salt}, ${seeded.secret})
    ON CONFLICT (id) DO NOTHING
  `;
  return readCredentials();
}

async function writeCredentials(credentials: Credentials): Promise<void> {
  await sql`
    INSERT INTO app_credentials (id, username, hash, salt, secret, updated_at)
    VALUES (true, ${credentials.username}, ${credentials.hash}, ${credentials.salt},
            ${credentials.secret}, now())
    ON CONFLICT (id) DO UPDATE SET
      username = excluded.username,
      hash = excluded.hash,
      salt = excluded.salt,
      secret = excluded.secret,
      updated_at = excluded.updated_at
  `;
}

/** Constant-time compare that tolerates different lengths without throwing. */
function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** True when these credentials open the dashboard. */
export async function verifyPassword(username: string, password: string): Promise<boolean> {
  const stored = await readCredentials();
  const userOk = sameString(username.trim().toLowerCase(), stored.username.toLowerCase());
  // Hash regardless of whether the username matched: returning early on a bad
  // username makes the response time say which half was wrong.
  const passwordOk = sameString(hashPassword(password, stored.salt), stored.hash);
  return userOk && passwordOk;
}

/** The current username, for display. Never the hash. */
export async function currentUsername(): Promise<string> {
  return (await readCredentials()).username;
}

/** Whether the stored password is still the seeded one, so the UI can nag. */
export async function usingDefaultPassword(): Promise<boolean> {
  const stored = await readCredentials();
  return sameString(hashPassword(DEFAULT_PASSWORD, stored.salt), stored.hash);
}

export const DEFAULT_CREDENTIALS = { username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD };

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * `<expiry>.<signature>` — the cookie carries when it dies and proof that we
 * issued it, and nothing else. There is one account, so the token has no
 * identity to carry; changing the password rotates the secret and every
 * outstanding token stops verifying.
 */
function signToken(expiresAt: number, secret: string): string {
  const signature = createHmac('sha256', secret).update(String(expiresAt)).digest('hex');
  return `${expiresAt}.${signature}`;
}

function tokenIsValid(token: string | undefined, secret: string): boolean {
  if (!token) return false;
  const [rawExpiry, signature] = token.split('.');
  const expiresAt = Number(rawExpiry);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  if (!signature) return false;
  return sameString(
    signature,
    createHmac('sha256', secret).update(String(expiresAt)).digest('hex'),
  );
}

export async function createSession(): Promise<void> {
  const { secret } = await readCredentials();
  const expiresAt = Date.now() + SESSION_MAX_AGE_S * 1000;
  const store = await cookies();
  store.set(COOKIE_NAME, signToken(expiresAt, secret), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
    // Secure in production, where the deployment is HTTPS; not locally, where
    // the server is plain HTTP on 127.0.0.1 and a secure cookie would never be
    // sent back at all.
    secure: process.env.NODE_ENV === 'production',
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/** Whether this request carries a session we issued and that has not expired. */
export async function isSignedIn(): Promise<boolean> {
  const { secret } = await readCredentials();
  const store = await cookies();
  return tokenIsValid(store.get(COOKIE_NAME)?.value, secret);
}

// ---------------------------------------------------------------------------
// Changing the credentials
// ---------------------------------------------------------------------------

export type CredentialChange =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Change the username, the password, or both.
 *
 * The current password is required even when only the username changes: the
 * session cookie proves someone opened the dashboard, not that they are still
 * the person who logged in.
 */
export async function updateCredentials(input: {
  currentPassword: string;
  username?: string;
  newPassword?: string;
}): Promise<CredentialChange> {
  const stored = await readCredentials();

  if (!sameString(hashPassword(input.currentPassword, stored.salt), stored.hash)) {
    return { ok: false, error: 'Password saat ini salah.' };
  }

  const username = (input.username ?? stored.username).trim();
  if (username.length < 3) {
    return { ok: false, error: 'Username minimal 3 karakter.' };
  }

  const password = input.newPassword?.trim();
  if (password !== undefined && password.length > 0 && password.length < 6) {
    return { ok: false, error: 'Password baru minimal 6 karakter.' };
  }

  // A new secret on every change, so any session opened with the old password
  // stops working the moment the password does.
  const next = password
    ? newCredentials(username, password)
    : { ...stored, username, secret: randomBytes(32).toString('hex'), updatedAt: new Date().toISOString() };

  await writeCredentials(next);
  return { ok: true };
}
