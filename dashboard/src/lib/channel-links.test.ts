import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

/**
 * The channel-scoped screens promise that every link they build keeps the
 * `?kanal=` a visitor arrived with — that promise lives entirely in whether
 * each construction site calls `withChannel` or builds the URL by hand. A
 * rendered-page test cannot see that difference: the bug this guards against
 * is textual, a site that skips `withChannel` and hands back a perfectly
 * valid, perfectly wrong URL (page 2 of the wrong shop's worklist, for
 * instance). So this reads the source instead — the same idea `queries.test.ts`
 * already uses to read migration files rather than mock them.
 *
 * The matcher is deliberately dumb, on purpose: it flags a JSX `href` or a
 * `router.replace`/`router.push` first argument that is a bare string or
 * template literal starting with a scoped route. Nothing more sophisticated
 * than that is needed, and nothing more sophisticated is trusted — a matcher
 * clever enough to "understand" `withChannel` calls would be clever enough to
 * hide the next regression too. An already-wrapped `href={withChannel(...)}`
 * is a call expression, not a literal, so it never matches either pattern —
 * there is no allowlist to keep in sync with `withChannel` itself. `/products`
 * and `/stores` are cross-marketplace by design and are simply absent from the
 * scoped list below; `product.url`/`rival.url` are bare identifiers, not
 * literals, so they never match either.
 */

/** Routes that answer for one shop of ours and mean nothing without `kanal`. */
const SCOPED_PREFIXES = ['/pricing', '/analytics', '/settings'];

function isScopedTarget(value: string): boolean {
  if (value === '/' || value.startsWith('/?')) return true;
  return SCOPED_PREFIXES.some((prefix) => value.startsWith(prefix));
}

// `href="/pricing..."` — a bare string-literal JSX attribute.
const HREF_STRING = /href="([^"]*)"/;
// `href={`/pricing...`}` — a bare template-literal JSX attribute.
const HREF_TEMPLATE = /href=\{`([^`]*)`\}/;
// `router.replace(`/pricing...`` / `router.push("/pricing..."` — the
// client-side navigation `PricingSearch` does instead of rendering a `Link`.
const ROUTER_STRING = /router\.(?:replace|push)\("([^"]*)"/;
const ROUTER_TEMPLATE = /router\.(?:replace|push)\(`([^`]*)`/;

const PATTERNS = [HREF_STRING, HREF_TEMPLATE, ROUTER_STRING, ROUTER_TEMPLATE];

type Violation = { line: number; target: string; snippet: string };

/** Every scoped link built without `withChannel`, one entry per source line. */
function findBareLinks(source: string): Violation[] {
  const violations: Violation[] = [];
  source.split('\n').forEach((text, index) => {
    for (const pattern of PATTERNS) {
      const match = pattern.exec(text);
      if (match && isScopedTarget(match[1])) {
        violations.push({ line: index + 1, target: match[1], snippet: text.trim() });
      }
    }
  });
  return violations;
}

/** The channel-scoped screens and the shell, exactly as named in the brief. */
const FILES = [
  'src/app/(app)/page.tsx',
  'src/app/(app)/pricing/page.tsx',
  'src/app/(app)/pricing/[id]/page.tsx',
  'src/app/(app)/analytics/page.tsx',
  'src/app/(app)/settings/page.tsx',
  'src/components/shell/AppShell.tsx',
  'src/components/OwnShopScorecard.tsx',
  'src/components/PricingSearch.tsx',
];

describe('channel-scoped screens carry kanal on every link', () => {
  test.each(FILES)('%s has no scoped link built outside withChannel', (relativePath) => {
    const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
    expect(findBareLinks(source)).toEqual([]);
  });
});
