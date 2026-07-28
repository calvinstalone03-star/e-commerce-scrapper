'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { cn } from '@/components/ui/cn';

const LINKS = [
  { href: '/', label: 'Ringkasan' },
  { href: '/stores', label: 'Toko' },
  { href: '/products', label: 'Produk' },
  { href: '/keywords', label: 'Keyword' },
  { href: '/compare', label: 'Perbandingan' },
] as const;

const SIDEBAR_WIDTH = 'w-60';

/**
 * A left sidebar on wide screens, a drawer behind a button on narrow ones.
 *
 * The widest thing in this app is a product table, so the rail is only rendered
 * from `lg` up — below that the same links live in a drawer and give the table
 * the full viewport back. `main` is a flex sibling of the rail rather than
 * sitting under it, so a wide table scrolls inside its own column instead of
 * pushing the page sideways; that is also why `main` carries `min-w-0`.
 */
export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // A drawer that survives the navigation it just triggered would cover the
  // page the user asked for, so every link inside it closes it on the way out.
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      {/* Narrow screens: a bar with the brand and the drawer trigger. */}
      <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur sm:px-6 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Buka navigasi"
          aria-expanded={open}
          aria-controls="navigasi-utama"
          className="-ml-2 rounded-md p-2 text-muted transition-colors hover:text-foreground"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden
            className="size-5"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <Brand className="py-3" />
      </header>

      {/* Wide screens: the rail itself. `h-dvh` + `sticky` keeps it in place
          while the content column scrolls, and lets a long link list scroll on
          its own if it ever outgrows the viewport. */}
      <aside
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 flex-col gap-6 overflow-y-auto border-r border-line bg-surface px-3 py-4 lg:flex',
          SIDEBAR_WIDTH,
        )}
      >
        <Brand className="px-2" />
        <nav aria-label="Navigasi utama" className="min-h-0 flex-1">
          <NavLinks pathname={pathname} />
        </nav>
      </aside>

      {/* Narrow screens: the drawer. Mounted only while open, so nothing of it
          is in the tab order — or on screen — the rest of the time. */}
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Tutup navigasi"
            onClick={close}
            className="absolute inset-0 h-full w-full cursor-default bg-black/40"
          />
          <nav
            id="navigasi-utama"
            aria-label="Navigasi utama"
            className={cn(
              'relative flex h-full flex-col gap-6 border-r border-line bg-surface px-3 py-4',
              SIDEBAR_WIDTH,
            )}
          >
            <Brand className="px-2" onNavigate={close} />
            <NavLinks pathname={pathname} onNavigate={close} />
          </nav>
        </div>
      ) : null}
    </>
  );
}

function Brand({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  return (
    <Link
      href="/"
      onClick={onNavigate}
      className={cn(
        'flex shrink-0 items-center gap-2 text-sm font-semibold tracking-tight',
        className,
      )}
    >
      <span
        aria-hidden
        className="flex size-6 items-center justify-center rounded-md bg-accent/12 text-accent"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          className="size-3.5"
        >
          <path d="M4 18V9M10 18V5M16 18v-6M22 18H2" />
        </svg>
      </span>
      Ecom Scraper
    </Link>
  );
}

/**
 * The link list. Rendered twice — once in the rail, once in the drawer — but
 * only one of the two is ever in the layout, so this is not a duplicate
 * landmark. Each caller supplies its own labelled `<nav>` wrapper.
 */
function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {LINKS.map((link) => {
        const active = isActive(pathname, link.href);
        return (
          <li key={link.href}>
            <Link
              href={link.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'block rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-accent/10 font-medium text-accent'
                  : 'text-muted hover:bg-surface-muted hover:text-foreground',
              )}
            >
              {link.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * `/` only matches itself; every other entry also owns its detail routes, so
 * `/products/1839` keeps "Produk" lit rather than leaving the rail with nothing
 * marked active.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
