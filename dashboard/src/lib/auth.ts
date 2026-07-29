import 'server-only';

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { cookies } from 'next/headers';

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
 * Credentials live in a file, not in Postgres, for the reason `db.ts` gives:
 * the Python side owns the schema and this app never writes to it. A settings
 * page that needed a migration would put two owners on one database.
 */

/** Where the credential file lives. Outside the build output, beside the repo. */
const AUTH_FILE =
  process.env.DASHBOARD_AUTH_FILE ?? join(process.cwd(), '..', '.dashboard-auth.json');

const COOKIE_NAME = 'mcl_session';

//: A week. Long enough not to be a daily nuisance on a machine only its owner
//: uses, short enough that a forgotten laptop stops being logged in.
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

//: What the file is seeded with the first time the dashboard starts. Weak on
//: purpose — it is meant to be changed on the settings page, and a random one
//: nobody is told is just a lockout.
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'ecom123';

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

function readCredentials(): Credentials {
  try {
    const parsed = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as Credentials;
    if (parsed?.username && parsed?.hash && parsed?.salt && parsed?.secret) return parsed;
  } catch {
    /* absent or unreadable — seeded below */
  }
  const seeded = newCredentials(DEFAULT_USERNAME, DEFAULT_PASSWORD);
  writeCredentials(seeded);
  return seeded;
}

function writeCredentials(credentials: Credentials): void {
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  // 0600: the file holds a password hash and the session signing key, and the
  // default umask would leave it world-readable.
  writeFileSync(AUTH_FILE, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

/** Constant-time compare that tolerates different lengths without throwing. */
function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** True when these credentials open the dashboard. */
export function verifyPassword(username: string, password: string): boolean {
  const stored = readCredentials();
  const userOk = sameString(username.trim().toLowerCase(), stored.username.toLowerCase());
  // Hash regardless of whether the username matched: returning early on a bad
  // username makes the response time say which half was wrong.
  const passwordOk = sameString(hashPassword(password, stored.salt), stored.hash);
  return userOk && passwordOk;
}

/** The current username, for display. Never the hash. */
export function currentUsername(): string {
  return readCredentials().username;
}

/** Whether the stored password is still the seeded one, so the UI can nag. */
export function usingDefaultPassword(): boolean {
  const stored = readCredentials();
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
  const { secret } = readCredentials();
  const expiresAt = Date.now() + SESSION_MAX_AGE_S * 1000;
  const store = await cookies();
  store.set(COOKIE_NAME, signToken(expiresAt, secret), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
    // Not `secure`: this is served over plain HTTP on 127.0.0.1, and a secure
    // cookie would simply never be sent back.
    secure: false,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/** Whether this request carries a session we issued and that has not expired. */
export async function isSignedIn(): Promise<boolean> {
  const { secret } = readCredentials();
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
export function updateCredentials(input: {
  currentPassword: string;
  username?: string;
  newPassword?: string;
}): CredentialChange {
  const stored = readCredentials();

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

  writeCredentials(next);
  return { ok: true };
}
