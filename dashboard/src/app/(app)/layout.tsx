import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AppShell, type UnreadBadge } from '@/components/shell/AppShell';
import { signOut } from '@/app/actions/auth';
import { currentUsername, isSignedIn, usingDefaultPassword } from '@/lib/auth';
import { PATH_HEADER, safeNextPath } from '@/lib/next-path';
import { BADGE_CAP, DEFAULT_WINDOW, unreadRivalMoves } from '@/lib/notify/rival-moves';
import { readSeen } from '@/lib/notify/seen';
import { getOwnShops } from '@/lib/queries';

/**
 * The gate, and the frame behind it.
 *
 * Every signed-in page is inside this route group, so the check lives here
 * rather than being repeated per page — a page added next month is protected by
 * where its file sits, which is the only kind of protection nobody forgets to
 * apply. `/login` sits outside the group and renders with no shell at all.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!(await isSignedIn())) {
    // Where they were going, so the login can put them back there. Clicking a
    // notification on a phone with an expired cookie is exactly the case this
    // exists for.
    const attempted = safeNextPath((await headers()).get(PATH_HEADER));
    redirect(attempted === '/' ? '/login' : `/login?next=${encodeURIComponent(attempted)}`);
  }

  // The topbar names the shops every "kita" on every page refers to. Cheap
  // enough to read per request, and it changes the moment `own-shop` runs.
  const shops = await getOwnShops();

  return (
    <AppShell
      username={await currentUsername()}
      warnDefaultPassword={await usingDefaultPassword()}
      unread={await unreadBadge()}
      signOutAction={signOut}
      shops={shops.map((shop) => ({
        id: shop.id,
        marketplace: shop.marketplace,
        username: shop.username,
        products: shop.products,
      }))}
    >
      {children}
    </AppShell>
  );
}

/** What the bell shows when the count cannot be taken at all. */
const NO_BADGE: UnreadBadge = { count: 0, capped: false };

/**
 * How many rival moves are above the read marker.
 *
 * This layout wraps **every** signed-in page, so what runs here runs on the
 * overview, the product table and the settings screen alike. That is why it is
 * `unreadRivalMoves` — a bounded `count(*)` that stops at the cap — and not
 * `rivalMoves(...).length`: fetching the feed to count it would put the
 * notifications page's whole cost, ordering and our-price join included, on
 * every screen in the app in order to render two digits.
 *
 * Two statements rather than one, and on purpose: the marker is read through
 * `readSeen` so that the clamp lives in exactly one place. Inlining
 * `notify_seen` into the count query would mean a second copy of `LEAST(marker,
 * COALESCE(max(id), 0))`, and a database left by a destructive mirror would then
 * be counted against an id no row can reach — a badge permanently reading zero
 * with nothing to explain it.
 *
 * **A badge may never take the app down.** Everything below the redirect is
 * decoration, and `readSeen` throws by design on a database where migration 006
 * has not been applied — which is an ordinary state, not a broken one, until
 * `initdb` has run everywhere. Left uncaught that would turn a missing bell into
 * a 500 on every signed-in page. The notifications page itself catches the same
 * error and explains it; here the honest response is no badge.
 */
async function unreadBadge(): Promise<UnreadBadge> {
  try {
    const { id } = await readSeen();
    return await unreadRivalMoves(DEFAULT_WINDOW, id, BADGE_CAP);
  } catch {
    return NO_BADGE;
  }
}
