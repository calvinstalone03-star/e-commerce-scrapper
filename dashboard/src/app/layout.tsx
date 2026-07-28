import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import { Nav } from '@/components/Nav';

import { Providers } from './providers';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
  display: 'swap',
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Ecom Scraper',
    template: '%s · Ecom Scraper',
  },
  description:
    'Pantau harga, produk, dan toko kompetitor dari hasil scraping Shopee dan Tokopedia.',
  applicationName: 'Ecom Scraper',
  // An internal tool pointed at a local database; nothing here belongs in an index.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0d10' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased">
        <a
          href="#konten"
          className="sr-only rounded-md border border-line bg-surface px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
        >
          Lewati ke konten
        </a>
        <Providers>
          {/* Stacked below `lg`, where `Nav` renders a bar and a drawer; a rail
              beside the content above it. `min-w-0` on the content column stops
              a wide product table from stretching the row and pushing the rail
              off-screen. */}
          <div className="flex min-h-screen flex-col lg:flex-row">
            <Nav />
            <main
              id="konten"
              className="mx-auto w-full max-w-[96rem] min-w-0 flex-1 px-4 py-6 sm:px-6"
            >
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
