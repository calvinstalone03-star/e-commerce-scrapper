'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/components/ui/cn';

const LINKS = [
  { href: '/', label: 'Ringkasan' },
  { href: '/stores', label: 'Toko' },
  { href: '/products', label: 'Produk' },
  { href: '/keywords', label: 'Keyword' },
  { href: '/compare', label: 'Perbandingan' },
] as const;

/**
 * A top bar rather than a sidebar: the widest thing in this app is a product
 * table, and a sidebar would spend 200px of every viewport on five links that
 * never change.
 */
export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[96rem] items-center gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 py-3 text-sm font-semibold tracking-tight"
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

        <nav
          aria-label="Navigasi utama"
          className="scrollbar-slim -mb-px flex flex-1 items-center gap-1 overflow-x-auto"
        >
          {LINKS.map((link) => {
            const active = isActive(pathname, link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'border-b-2 px-3 py-3.5 text-sm whitespace-nowrap transition-colors',
                  active
                    ? 'border-accent font-medium text-foreground'
                    : 'border-transparent text-muted hover:text-foreground',
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

/**
 * `/` only matches itself; every other entry also owns its detail routes, so
 * `/products/1839` keeps "Produk" lit rather than leaving the bar with nothing
 * marked active.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
