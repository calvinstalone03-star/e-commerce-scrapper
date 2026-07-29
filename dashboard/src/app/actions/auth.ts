'use server';

import { redirect } from 'next/navigation';

import { createSession, destroySession, updateCredentials, verifyPassword } from '@/lib/auth';

/**
 * The three things a session can do: start, end, and change what starts it.
 *
 * Server Actions rather than route handlers so the forms work without
 * JavaScript — a login screen that needs hydration before it accepts a password
 * is a login screen that locks you out when a bundle fails to load.
 */

export type FormState = { error?: string; ok?: boolean };

export async function signIn(_previous: FormState, formData: FormData): Promise<FormState> {
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');

  if (!(await verifyPassword(username, password))) {
    // One message for both halves: saying which was wrong tells whoever is
    // guessing that the username exists.
    return { error: 'Username atau password salah.' };
  }

  await createSession();
  redirect('/');
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect('/login');
}

export async function changeCredentials(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const currentPassword = String(formData.get('currentPassword') ?? '');
  const username = String(formData.get('username') ?? '').trim();
  const newPassword = String(formData.get('newPassword') ?? '');
  const confirmPassword = String(formData.get('confirmPassword') ?? '');

  if (newPassword && newPassword !== confirmPassword) {
    return { error: 'Konfirmasi password tidak sama.' };
  }

  const result = await updateCredentials({
    currentPassword,
    username: username || undefined,
    newPassword: newPassword || undefined,
  });

  if (!result.ok) return { error: result.error };

  // Changing either credential rotates the signing secret, so the cookie in
  // this browser is no longer valid — send the user back to the login screen
  // rather than to a page that will bounce them anyway.
  await destroySession();
  redirect('/login?changed=1');
}
