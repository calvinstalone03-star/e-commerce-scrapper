import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The login, tested where it actually decides things.
 *
 * Auth is the one part of this dashboard where being roughly right is being
 * wrong, and most of it is invisible from the screen: whether the password is
 * stored rather than hashed, whether a wrong username short-circuits before the
 * hash and leaks which half failed, whether an expired or forged cookie is
 * refused, whether changing the password actually ends the sessions opened with
 * the old one. Each of those is a test below.
 *
 * `next/headers` is stubbed with a plain map so the session functions can run
 * outside a request.
 */

const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
}));

const AUTH_FILE = join(mkdtempSync(join(tmpdir(), 'mcl-auth-')), 'auth.json');
process.env.DASHBOARD_AUTH_FILE = AUTH_FILE;

// Imported after the env var is set: the module resolves its path at load.
const auth = await import('@/lib/auth');

beforeEach(() => {
  jar.clear();
});

describe('credentials', () => {
  test('seeds a usable default on first run', () => {
    expect(auth.verifyPassword(auth.DEFAULT_CREDENTIALS.username, auth.DEFAULT_CREDENTIALS.password)).toBe(
      true,
    );
    expect(auth.usingDefaultPassword()).toBe(true);
  });

  test('stores a salted hash, never the password', () => {
    const raw = readFileSync(AUTH_FILE, 'utf8');
    expect(raw).not.toContain(auth.DEFAULT_CREDENTIALS.password);
    const stored = JSON.parse(raw);
    expect(stored.hash).toMatch(/^[0-9a-f]{128}$/);
    expect(stored.salt).toHaveLength(32);
  });

  test('the credential file is not readable by anyone else', () => {
    // It holds the password hash and the session signing key; the default umask
    // would leave it world-readable.
    expect(statSync(AUTH_FILE).mode & 0o077).toBe(0);
  });

  test('rejects a wrong password and a wrong username alike', () => {
    expect(auth.verifyPassword('admin', 'salah')).toBe(false);
    expect(auth.verifyPassword('bukanadmin', auth.DEFAULT_CREDENTIALS.password)).toBe(false);
  });

  test('username is compared case-insensitively, password is not', () => {
    expect(auth.verifyPassword('ADMIN', auth.DEFAULT_CREDENTIALS.password)).toBe(true);
    expect(auth.verifyPassword('admin', auth.DEFAULT_CREDENTIALS.password.toUpperCase())).toBe(false);
  });
});

describe('changing credentials', () => {
  test('refuses without the current password', () => {
    const result = auth.updateCredentials({ currentPassword: 'salah', newPassword: 'rahasia123' });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Password saat ini') });
  });

  test('refuses a password too short to be worth having', () => {
    const result = auth.updateCredentials({
      currentPassword: auth.DEFAULT_CREDENTIALS.password,
      newPassword: 'abc',
    });
    expect(result.ok).toBe(false);
  });

  test('changes the password and stops accepting the old one', () => {
    expect(auth.updateCredentials({
      currentPassword: auth.DEFAULT_CREDENTIALS.password,
      newPassword: 'rahasia123',
    })).toEqual({ ok: true });

    expect(auth.verifyPassword('admin', 'rahasia123')).toBe(true);
    expect(auth.verifyPassword('admin', auth.DEFAULT_CREDENTIALS.password)).toBe(false);
    expect(auth.usingDefaultPassword()).toBe(false);
  });

  test('changes the username while keeping the password', () => {
    expect(auth.updateCredentials({ currentPassword: 'rahasia123', username: 'calvin' })).toEqual({
      ok: true,
    });
    expect(auth.currentUsername()).toBe('calvin');
    expect(auth.verifyPassword('calvin', 'rahasia123')).toBe(true);
  });
});

describe('sessions', () => {
  test('a fresh session is accepted', async () => {
    await auth.createSession();
    expect(await auth.isSignedIn()).toBe(true);
  });

  test('no cookie is not signed in', async () => {
    expect(await auth.isSignedIn()).toBe(false);
  });

  test('signing out ends it', async () => {
    await auth.createSession();
    await auth.destroySession();
    expect(await auth.isSignedIn()).toBe(false);
  });

  test('a token we did not sign is refused', async () => {
    // The shape is right and the expiry is in the future; only the signature is
    // invented. This is the case a cookie carrying just a username would pass.
    jar.set('mcl_session', `${Date.now() + 60_000}.${'0'.repeat(64)}`);
    expect(await auth.isSignedIn()).toBe(false);
  });

  test('an expired token is refused even though we signed it', async () => {
    await auth.createSession();
    const token = jar.get('mcl_session')!;
    const [, signature] = token.split('.');
    jar.set('mcl_session', `${Date.now() - 1000}.${signature}`);
    expect(await auth.isSignedIn()).toBe(false);
  });

  test('changing the password invalidates sessions opened before it', async () => {
    await auth.createSession();
    expect(await auth.isSignedIn()).toBe(true);

    auth.updateCredentials({ currentPassword: 'rahasia123', newPassword: 'rahasia456' });

    // The cookie is untouched in the jar; it simply no longer verifies.
    expect(await auth.isSignedIn()).toBe(false);
  });
});
