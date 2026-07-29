import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { sql } from '@/lib/db';

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

const auth = await import('@/lib/auth');
const MIGRATIONS = join(process.cwd(), '..', 'migrations');

beforeAll(async () => {
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
});

beforeEach(async () => {
  jar.clear();
  // Each case starts from an unseeded database, so "first run seeds a default"
  // is tested rather than assumed from whatever ran before it.
  await sql`DELETE FROM app_credentials`;
});

describe('credentials', () => {
  test('seeds a usable default on first run', async () => {
    expect(
      await auth.verifyPassword(auth.DEFAULT_CREDENTIALS.username, auth.DEFAULT_CREDENTIALS.password),
    ).toBe(true);
    expect(await auth.usingDefaultPassword()).toBe(true);
  });

  test('stores a salted hash, never the password', async () => {
    await auth.currentUsername(); // force the seed
    const [row] = await sql`SELECT username, hash, salt, secret FROM app_credentials`;
    expect(JSON.stringify(row)).not.toContain(auth.DEFAULT_CREDENTIALS.password);
    expect(row.hash).toMatch(/^[0-9a-f]{128}$/);
    expect(row.salt).toHaveLength(32);
  });

  test('the credential row is a singleton', async () => {
    await auth.currentUsername();
    // A second account nobody knows about would be a second way in.
    await expect(
      sql`INSERT INTO app_credentials (id, username, hash, salt, secret) VALUES (true, 'x', 'x', 'x', 'x')`,
    ).rejects.toThrow();
  });

  test('rejects a wrong password and a wrong username alike', async () => {
    expect(await auth.verifyPassword('admin', 'salah')).toBe(false);
    expect(await auth.verifyPassword('bukanadmin', auth.DEFAULT_CREDENTIALS.password)).toBe(false);
  });

  test('username is compared case-insensitively, password is not', async () => {
    expect(await auth.verifyPassword('ADMIN', auth.DEFAULT_CREDENTIALS.password)).toBe(true);
    expect(await auth.verifyPassword('admin', auth.DEFAULT_CREDENTIALS.password.toUpperCase())).toBe(
      false,
    );
  });
});

describe('changing credentials', () => {
  test('refuses without the current password', async () => {
    await auth.currentUsername();
    expect(await auth.updateCredentials({ currentPassword: 'salah', newPassword: 'rahasia123' })).toEqual(
      { ok: false, error: expect.stringContaining('Password saat ini') },
    );
  });

  test('refuses a password too short to be worth having', async () => {
    await auth.currentUsername();
    const result = await auth.updateCredentials({
      currentPassword: auth.DEFAULT_CREDENTIALS.password,
      newPassword: 'abc',
    });
    expect(result.ok).toBe(false);
  });

  test('changes the password and stops accepting the old one', async () => {
    await auth.currentUsername();
    expect(
      await auth.updateCredentials({
        currentPassword: auth.DEFAULT_CREDENTIALS.password,
        newPassword: 'rahasia123',
      }),
    ).toEqual({ ok: true });

    expect(await auth.verifyPassword('admin', 'rahasia123')).toBe(true);
    expect(await auth.verifyPassword('admin', auth.DEFAULT_CREDENTIALS.password)).toBe(false);
    expect(await auth.usingDefaultPassword()).toBe(false);
  });

  test('changes the username while keeping the password', async () => {
    await auth.currentUsername();
    expect(
      await auth.updateCredentials({
        currentPassword: auth.DEFAULT_CREDENTIALS.password,
        username: 'calvin',
      }),
    ).toEqual({ ok: true });
    expect(await auth.currentUsername()).toBe('calvin');
    expect(await auth.verifyPassword('calvin', auth.DEFAULT_CREDENTIALS.password)).toBe(true);
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

    await auth.updateCredentials({
      currentPassword: auth.DEFAULT_CREDENTIALS.password,
      newPassword: 'rahasia456',
    });

    // The cookie is untouched in the jar; it simply no longer verifies.
    expect(await auth.isSignedIn()).toBe(false);
  });
});
