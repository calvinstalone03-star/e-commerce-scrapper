'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import {
  readRail,
  readRailOnServer,
  subscribeRail,
  writeRail,
} from '@/components/shell/rail-store';
import { cn } from '@/components/ui/cn';

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


export function AppShell({
  shops,
  username,
  warnDefaultPassword,
  signOutAction,
  children,
}: {
  shops: ShopBadge[];
  username: string;
  warnDefaultPassword: boolean;
  signOutAction: () => Promise<void>;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const collapsed = useSyncExternalStore(subscribeRail, readRail, readRailOnServer);
  const [drawer, setDrawer] = useState(false);

  const toggle = () => writeRail(!collapsed);

  return (
    <div className="flex min-h-screen flex-col">
      <Topbar
        shops={shops}
        username={username}
        warnDefaultPassword={warnDefaultPassword}
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
            <NavLinks pathname={pathname} collapsed={collapsed} />
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
                  a link, the backdrop, or the page underneath. */}
              <NavLinks
                pathname={pathname}
                collapsed={false}
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
  username,
  warnDefaultPassword,
  signOutAction,
  onOpenDrawer,
  onToggleRail,
  collapsed,
}: {
  shops: ShopBadge[];
  username: string;
  warnDefaultPassword: boolean;
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
      <Link href="/" className="flex min-w-0 items-center gap-2">
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

      {/* Which shops every number on every page is relative to. Without this the
          dashboard says "kita" everywhere and never says who that is. */}
      <div className="ml-2 hidden min-w-0 items-center gap-1.5 md:flex">
        {shops.length === 0 ? (
          <span className="rounded-md border border-dashed border-line px-2 py-1 text-xs text-muted">
            belum ada toko sendiri
          </span>
        ) : (
          shops.map((shop) => (
            <span
              key={shop.id}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-muted px-2 py-1 text-xs whitespace-nowrap text-muted"
              title={`${shop.products} produk ter-scrape`}
            >
              <span
                aria-hidden
                className={cn(
                  'size-1.5 rounded-full',
                  shop.marketplace === 'shopee' ? 'bg-shopee' : 'bg-tokopedia',
                )}
              />
              <span className="font-medium text-foreground">{shop.username}</span>
              <span className="tabular-nums">{shop.products.toLocaleString('id-ID')}</span>
            </span>
          ))
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {warnDefaultPassword ? (
          <Link
            href="/settings"
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
  onNavigate,
}: {
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
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
];
