'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import {
  readRail,
  readRailOnServer,
  subscribeRail,
  writeRail,
} from '@/components/shell/rail-store';
import { cn } from '@/components/ui/cn';
import { CHANNEL_PARAM, resolveChannel, withChannel, type Channel } from '@/lib/channel';
import { MARKETPLACE_LABELS } from '@/lib/format';

/**
 * The frame every signed-in page sits in: a rail that collapses, a topbar that
 * says which shops the numbers are about, and the content column.
 *
 * The rail collapses because the widest thing in this app is a product table
 * and the second widest is a price comparison; on a laptop those want the 15rem
 * the links occupy. Collapsed it keeps the icons, so navigation never becomes a
 * memory game, and the choice is remembered — a toggle that resets on every
 * page load is a toggle nobody uses twice.
 *
 * The full product name lives up here rather than in the rail. "Market
 * Competition Landscape" wraps to three lines in a 15rem sidebar and reads as
 * clutter; in the topbar it has room, and the rail carries the short mark.
 */

export type ShopBadge = {
  id: number;
  marketplace: string;
  username: string;
  products: number;
};

type NavItem = { href: string; label: string; icon: ReactNode };

/**
 * What the bell shows, as the layout worked it out.
 *
 * `capped` rather than a raw number past the cap: the count query stops early on
 * purpose (it runs on every signed-in page), so beyond the cap the only honest
 * claim is "at least this many" — which is what a "99+" reads as.
 */
export type UnreadBadge = { count: number; capped: boolean };

export function AppShell({
  shops,
  username,
  warnDefaultPassword,
  unread,
  signOutAction,
  children,
}: {
  shops: ShopBadge[];
  username: string;
  warnDefaultPassword: boolean;
  unread: UnreadBadge;
  signOutAction: () => Promise<void>;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // A layout cannot read search params, so the shell — already a client
  // component for the rail and the drawer — reads `kanal` itself and resolves
  // it against the same `shops` the layout already fetched.
  const searchParams = useSearchParams();
  const channel = resolveChannel(searchParams.get(CHANNEL_PARAM), shops);
  // The rest of the query — `stance`, `matched`, `page` and the like — so the
  // shop switcher keeps a filtered worklist's filters instead of resetting it
  // to the bare page. Guarded rather than always appending `?`: an empty
  // `URLSearchParams#toString()` would otherwise leave every switcher href
  // ending in a bare `?`.
  const query = searchParams.toString();
  const pathWithQuery = query ? `${pathname}?${query}` : pathname;
  const collapsed = useSyncExternalStore(subscribeRail, readRail, readRailOnServer);
  const [drawer, setDrawer] = useState(false);

  const toggle = () => writeRail(!collapsed);

  return (
    <div className="flex min-h-screen flex-col">
      <Topbar
        shops={shops}
        pathname={pathname}
        pathWithQuery={pathWithQuery}
        channel={channel}
        username={username}
        warnDefaultPassword={warnDefaultPassword}
        unread={unread}
        signOutAction={signOutAction}
        onOpenDrawer={() => setDrawer(true)}
        onToggleRail={toggle}
        collapsed={collapsed}
      />

      <div className="flex flex-1 flex-col lg:flex-row">
        <aside
          className={cn(
            'sticky top-14 hidden h-[calc(100dvh-3.5rem)] shrink-0 overflow-y-auto border-r border-line bg-surface px-2 py-3 transition-[width] duration-150 lg:block',
            collapsed ? 'w-[4.25rem]' : 'w-56',
          )}
        >
          <nav aria-label="Navigasi utama">
            <NavLinks pathname={pathname} collapsed={collapsed} channel={channel} />
          </nav>
        </aside>

        {drawer ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <button
              type="button"
              aria-label="Tutup navigasi"
              onClick={() => setDrawer(false)}
              className="absolute inset-0 h-full w-full cursor-default bg-black/40"
            />
            <nav
              aria-label="Navigasi utama"
              className="relative h-full w-60 border-r border-line bg-surface px-2 py-3"
            >
              {/* Closed by the tap that navigates, rather than by watching the
                  pathname: the drawer would otherwise stay open over the page it
                  just opened, and every way out of it is a tap we already own —
                  a link, the backdrop, or the page underneath. The switcher
                  gets the same treatment as the nav links below it: below `md`
                  this drawer is the only place the channel can be changed at
                  all, and a chip that left the drawer open would be the one
                  tap in here that behaved differently from every other. */}
              <div className="mb-3 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
                <ShopSwitcher
                  shops={shops}
                  channel={channel}
                  pathWithQuery={pathWithQuery}
                  onNavigate={() => setDrawer(false)}
                />
              </div>
              <NavLinks
                pathname={pathname}
                collapsed={false}
                channel={channel}
                onNavigate={() => setDrawer(false)}
              />
            </nav>
          </div>
        ) : null}

        <main
          id="konten"
          className="mx-auto w-full max-w-[96rem] min-w-0 flex-1 px-4 py-6 sm:px-6"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

function Topbar({
  shops,
  pathname,
  pathWithQuery,
  channel,
  username,
  warnDefaultPassword,
  unread,
  signOutAction,
  onOpenDrawer,
  onToggleRail,
  collapsed,
}: {
  shops: ShopBadge[];
  pathname: string;
  pathWithQuery: string;
  channel: Channel | null;
  username: string;
  warnDefaultPassword: boolean;
  unread: UnreadBadge;
  signOutAction: () => Promise<void>;
  onOpenDrawer: () => void;
  onToggleRail: () => void;
  collapsed: boolean;
}) {
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-3 backdrop-blur sm:px-4">
      {/* Name first, then the control. The brand is what the eye lands on and it
          belongs at the corner; the toggle belongs beside the column it opens
          and closes, which is the one to its right. */}
      <Link href={withChannel('/', channel)} className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="size-4">
            <path d="M4 18V9M10 18V5M16 18v-6M22 18H2" />
          </svg>
        </span>
        <span className="truncate text-sm font-semibold tracking-tight text-foreground">
          Market Competition Landscape
        </span>
      </Link>

      <button
        type="button"
        onClick={onOpenDrawer}
        aria-label="Buka navigasi"
        className="rounded-md p-2 text-muted transition-colors hover:text-foreground lg:hidden"
      >
        <BurgerIcon />
      </button>
      <button
        type="button"
        onClick={onToggleRail}
        aria-label={collapsed ? 'Lebarkan navigasi' : 'Ciutkan navigasi'}
        aria-pressed={collapsed}
        className="hidden rounded-md p-2 text-muted transition-colors hover:text-foreground lg:block"
      >
        <BurgerIcon />
      </button>

      {/* Which shop every number on every page is about, and the switch that
          changes it. Without this the dashboard says "kita" everywhere and
          never says who that is, or lets you ask the same question of the
          other shop. Hidden below `md`; the drawer renders the same
          `ShopSwitcher` for narrower screens. */}
      <div className="ml-2 hidden min-w-0 items-center gap-1.5 md:flex">
        <ShopSwitcher shops={shops} channel={channel} pathWithQuery={pathWithQuery} />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <NotificationBell active={isActive(pathname, '/notifications')} channel={channel} unread={unread} />
        {warnDefaultPassword ? (
          <Link
            href={withChannel('/settings', channel)}
            className="hidden rounded-md border border-negative/40 bg-negative/10 px-2 py-1 text-xs text-negative sm:block"
          >
            password masih bawaan
          </Link>
        ) : null}
        <span className="hidden text-xs text-muted sm:block">{username}</span>
        <SignOutButton signOutAction={signOutAction} />
      </div>
    </header>
  );
}

/**
 * The way in to the notifications page, and the only thing on screen that says
 * there is anything to read.
 *
 * **`prefetch={false}`, and it is load-bearing.** `/notifications` is
 * `force-dynamic`, and this bell is in the topbar of *every* signed-in page — so
 * with the default viewport prefetch, merely rendering any screen in the app
 * would run the full 14-day feed query on the server, ordering and all, for a
 * page nobody has asked for yet. The design also names the sharper version of
 * the same worry: nothing that clears the queue may be reachable without a
 * deliberate click. (The clearing POST itself is in a client effect, so a
 * prefetched payload does not fire it — but "the badge is only safe because of
 * where the POST happens to live" is a guarantee one refactor away from being
 * false, and this is the cheap way not to depend on it.)
 *
 * `withChannel` rather than a bare `/notifications`: the page itself is
 * cross-marketplace and ignores the parameter, but the shop switcher three
 * elements to the left reads it, and arriving without it would silently reset
 * the visitor to the default shop for everything they do next.
 */
function NotificationBell({
  active,
  channel,
  unread,
}: {
  active: boolean;
  channel: Channel | null;
  unread: UnreadBadge;
}) {
  const label =
    unread.count === 0
      ? 'Notifikasi'
      : `Notifikasi, ${unread.count}${unread.capped ? ' atau lebih' : ''} belum dibaca`;

  return (
    <Link
      href={withChannel('/notifications', channel)}
      prefetch={false}
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative rounded-md p-2 transition-colors',
        active ? 'text-accent' : 'text-muted hover:text-foreground',
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="size-5"
      >
        <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" />
      </svg>

      {unread.count > 0 ? (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-negative px-1 text-center text-[10px] leading-4 font-medium text-white tabular-nums"
        >
          {unread.count}
          {unread.capped ? '+' : ''}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * The border/background/text classes for an own-shop chip, active or not.
 * Both the two-shop switcher's `Link` above and the one-shop static
 * `ShopBadgeChip` below call this rather than each carrying its own copy, so
 * restyling a chip cannot update one rendering and silently miss the other.
 */
function chipClassName(active: boolean): string {
  return cn(
    'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs whitespace-nowrap transition-colors',
    active
      ? 'border-accent/40 bg-accent/10 text-foreground'
      : 'border-line bg-surface-muted text-muted hover:text-foreground',
  );
}

/**
 * The dot, username and product count inside an own-shop chip — shared by the
 * switcher and `ShopBadgeChip` for the same reason as `chipClassName`. Neither
 * span sets its own text color; both inherit active/inactive from whichever
 * `chipClassName`-styled element wraps this, so the username can never end up
 * a different shade than the count beside it. (It used to: `ShopBadgeChip`
 * hardcoded `text-foreground` on the username, invisible only because it was
 * always called with `active`.)
 */
function ShopBadgeContent({ shop }: { shop: ShopBadge }) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          shop.marketplace === 'shopee' ? 'bg-shopee' : 'bg-tokopedia',
        )}
      />
      <span className="font-medium">{shop.username}</span>
      <span className="tabular-nums">{shop.products.toLocaleString('id-ID')}</span>
    </>
  );
}

/**
 * The one-shop case: nothing to switch to, so a static chip rather than a
 * `Link` that would only ever point at the page already on screen. Built from
 * the same `chipClassName` and `ShopBadgeContent` the two-shop switcher uses,
 * so the two renderings share one definition instead of two
 * independently-maintained copies that can silently drift apart.
 *
 * `marketplace` is the shop's own marketplace, already resolved to a real
 * `Channel` by the caller (the same `resolveChannel` call the two-shop
 * switcher makes) — the dot next to the username is otherwise the only thing
 * that says Shopee or Tokopedia, and it is `aria-hidden`.
 */
function ShopBadgeChip({
  shop,
  marketplace,
  active,
}: {
  shop: ShopBadge;
  marketplace: Channel | null;
  active?: boolean;
}) {
  return (
    <span
      className={chipClassName(Boolean(active))}
      title={`${shop.products} produk ter-scrape`}
      aria-label={marketplace ? `${MARKETPLACE_LABELS[marketplace]} · ${shop.username}` : shop.username}
    >
      <ShopBadgeContent shop={shop} />
    </span>
  );
}

/**
 * The switch itself: nothing to show, one static chip, or a chip per shop —
 * shared between the topbar (`md` and up) and the mobile drawer, which below
 * `md` is the only place it can be reached at all. `onNavigate` closes the
 * drawer on a tap, the same treatment every `NavLinks` item gets; the topbar
 * passes nothing, since there is no drawer over it to close.
 */
function ShopSwitcher({
  shops,
  channel,
  pathWithQuery,
  onNavigate,
}: {
  shops: ShopBadge[];
  channel: Channel | null;
  pathWithQuery: string;
  onNavigate?: () => void;
}) {
  if (shops.length === 0) {
    return (
      <span className="rounded-md border border-dashed border-line px-2 py-1 text-xs text-muted">
        belum ada toko sendiri
      </span>
    );
  }

  if (shops.length === 1) {
    return (
      <ShopBadgeChip shop={shops[0]} marketplace={resolveChannel(shops[0].marketplace, shops)} active />
    );
  }

  return (
    <>
      {shops.map((shop) => {
        // `ShopBadge.marketplace` is a bare string (kept decoupled from the
        // schema types the pages use), so it is resolved once against the same
        // `shops` list to get back a real `Channel` — reused for both the href
        // and the accessible name — `channel.ts` itself is untouched.
        const shopChannel = resolveChannel(shop.marketplace, shops);
        return (
          <Link
            key={shop.id}
            href={withChannel(pathWithQuery, shopChannel)}
            aria-current={shop.marketplace === channel ? 'true' : undefined}
            aria-label={
              shopChannel ? `${MARKETPLACE_LABELS[shopChannel]} · ${shop.username}` : shop.username
            }
            onClick={onNavigate}
            className={chipClassName(shop.marketplace === channel)}
            title={`${shop.products} produk ter-scrape`}
          >
            <ShopBadgeContent shop={shop} />
          </Link>
        );
      })}
    </>
  );
}

/**
 * Sign out, behind a confirmation.
 *
 * Not because signing out is destructive — it is one click to undo — but
 * because the button sits in the corner every other toolbar puts a harmless
 * icon in, and being thrown back to a password prompt mid-task is a
 * disproportionate answer to a misplaced click.
 *
 * A `<dialog>` rather than `window.confirm`: the native prompt blocks the whole
 * renderer, cannot be styled to look like it belongs to this app, and reads as
 * a browser warning rather than a question the page is asking. This keeps the
 * form — and therefore the Server Action — intact underneath.
 */
function SignOutButton({ signOutAction }: { signOutAction: () => Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
      >
        Keluar
      </button>

      <dialog
        ref={dialogRef}
        // Clicking the backdrop closes it: the dialog element reports those
        // clicks as landing on itself, never on its contents.
        onClick={(event) => {
          if (event.target === dialogRef.current) dialogRef.current?.close();
        }}
        className="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-foreground backdrop:bg-black/50"
      >
        <div className="space-y-4 p-5">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Keluar dari dashboard?</h2>
            <p className="text-sm leading-relaxed text-muted">
              Sesi ini berakhir dan kamu perlu memasukkan username dan password lagi untuk masuk.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="h-9 rounded-md border border-line px-3 text-sm text-muted transition-colors hover:text-foreground"
            >
              Batal
            </button>
            <form action={signOutAction}>
              <button
                type="submit"
                className="h-9 rounded-md bg-negative px-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Keluar
              </button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}

function NavLinks({
  pathname,
  collapsed,
  channel,
  onNavigate,
}: {
  pathname: string;
  collapsed: boolean;
  channel: Channel | null;
  onNavigate?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={withChannel(item.href, channel)}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              title={collapsed ? item.label : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                collapsed && 'justify-center px-0',
                active
                  ? 'bg-accent/10 font-medium text-accent'
                  : 'text-muted hover:bg-surface-muted hover:text-foreground',
              )}
            >
              <span aria-hidden className="shrink-0">
                {item.icon}
              </span>
              {collapsed ? <span className="sr-only">{item.label}</span> : item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * `/` matches only itself; everything else owns its detail routes, so
 * `/pricing/985` keeps "Posisi harga" lit.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Icon({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4.5"
    >
      <path d={path} />
    </svg>
  );
}

function BurgerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden className="size-5">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

const NAV: NavItem[] = [
  { href: '/', label: 'Ringkasan', icon: <Icon path="M4 12h4v8H4zM10 4h4v16h-4zM16 9h4v11h-4z" /> },
  { href: '/pricing', label: 'Posisi harga', icon: <Icon path="M3 17l6-6 4 4 8-8M15 7h6v6" /> },
  { href: '/analytics', label: 'Analitik', icon: <Icon path="M21 21H3V3M7 15l4-6 4 3 5-8" /> },
  { href: '/products', label: 'Produk', icon: <Icon path="M4 7l8-4 8 4-8 4zM4 7v10l8 4 8-4V7" /> },
  { href: '/stores', label: 'Toko', icon: <Icon path="M4 9h16l-1 11H5zM9 9V6a3 3 0 016 0v3" /> },
  { href: '/settings', label: 'Pengaturan', icon: <Icon path="M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 00-1.7-1L14.4 3H9.6l-.4 2.6a7 7 0 00-1.7 1l-2.4-1-2 3.4L5.1 11a7 7 0 000 2l-2 1.6 2 3.4 2.4-1a7 7 0 001.7 1l.4 2.6h4.8l.4-2.6a7 7 0 001.7-1l2.4 1 2-3.4-2-1.6c.1-.3.1-.7.1-1z" /> },
  // Last, and deliberately not first: it is the entry a new user needs once and
  // an existing one never — but it is also where the extension is downloaded
  // from, which is the only part of this product that cannot be reached from
  // any other screen.
  { href: '/docs', label: 'Panduan', icon: <Icon path="M4 5a2 2 0 012-2h11v18H6a2 2 0 01-2-2zM9 7h5M9 11h5" /> },
];
