import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

/**
 * `safeNextPath` only protects the two places that read `next` off the
 * request if those two places actually call it — a rendered-page test cannot
 * see the difference between `redirect(safeNextPath(...))` and
 * `redirect(String(formData.get('next') ?? '/'))`. Both compile, both lint
 * clean, both pass every other test in this suite, and only one of them is
 * an open redirect. That is the same blind spot `channel-links.test.ts`
 * guards for `withChannel`, so this reads the source the same way it does.
 *
 * The matcher is deliberately dumb, on purpose, same as there: find the line
 * that pulls the raw value out of the request, and require `safeNextPath` to
 * appear on that same line. It cannot tell a real fix from one that merely
 * mentions `safeNextPath` in a comment, but it does catch the regression this
 * exists for — the call site being "simplified" back to the raw value — which
 * is the only thing anything else in this repo would not have caught.
 */

const CHECKS = [
  {
    file: 'src/app/actions/auth.ts',
    // Where `next` comes off the submitted form, on its way into `redirect`.
    rawSource: /redirect\([^\n]*formData\.get\(['"]next['"]\)/,
  },
  {
    file: 'src/app/(app)/layout.tsx',
    // The header `proxy.ts` publishes, read back out for the redirect target.
    rawSource: /\.get\(PATH_HEADER\)/,
  },
];

describe('the next= destination is validated at the point it is read off the request', () => {
  test.each(CHECKS)('$file calls safeNextPath on the line that reads it', ({ file, rawSource }) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const line = source.split('\n').find((text) => rawSource.test(text));

    // If this fails, the line this test was written against has moved or
    // been reworded — not proof the protection is still there.
    expect(line, `expected a line matching ${rawSource} in ${file}`).toBeTruthy();
    expect(line).toContain('safeNextPath(');
  });
});
