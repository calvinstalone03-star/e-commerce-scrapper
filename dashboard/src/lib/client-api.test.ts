import { describe, expect, test } from 'vitest';

import { apiErrorMessage } from '@/lib/client-api';

/**
 * What a failed fetch tells the user.
 *
 * The routes are behind the login now, so 401 is a state the browser can reach
 * without anything being broken: the session simply expired while the tab sat
 * open. "Permintaan gagal (HTTP 401)" sends whoever reads it looking for a bug;
 * naming the session tells them to reload and sign in.
 */

describe('apiErrorMessage', () => {
  test('a 401 names the expired session', () => {
    expect(apiErrorMessage(401)).toMatch(/sesi/i);
    expect(apiErrorMessage(401)).not.toContain('401');
  });

  test('every other status keeps the code, which is what gets reported', () => {
    expect(apiErrorMessage(503)).toContain('503');
    expect(apiErrorMessage(500)).toContain('500');
  });
});
