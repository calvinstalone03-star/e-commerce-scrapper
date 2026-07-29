import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AppShell } from '@/components/shell/AppShell';
import { signOut } from '@/app/actions/auth';
import { currentUsername, isSignedIn, usingDefaultPassword } from '@/lib/auth';
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
  if (!(await isSignedIn())) redirect('/login');

  // The topbar names the shops every "kita" on every page refers to. Cheap
  // enough to read per request, and it changes the moment `own-shop` runs.
  const shops = await getOwnShops();

  return (
    <AppShell
      username={currentUsername()}
      warnDefaultPassword={usingDefaultPassword()}
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
