import type { Metadata } from 'next';

import { CredentialsForm } from '@/components/CredentialsForm';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { currentUsername, usingDefaultPassword } from '@/lib/auth';
import { getOwnShops } from '@/lib/queries';

/**
 * Settings: the login, and a plain statement of what this dashboard is reading.
 *
 * The shop list is here rather than only in the topbar because "which shop is
 * ours" is the setting every number depends on, and it is set from a terminal —
 * so the page that owns settings should at least say what the answer currently
 * is, and how to change it.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Pengaturan',
  description: 'Username, password, dan toko yang dianggap milik sendiri.',
};

export default async function SettingsPage() {
  const shops = await getOwnShops();

  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Pengaturan</h1>
        <p className="text-sm text-muted">Akses masuk dan toko yang dianggap milik sendiri.</p>
      </header>

      {usingDefaultPassword() ? (
        <p className="rounded-md border border-negative/40 bg-negative/10 px-3 py-2.5 text-sm leading-relaxed text-negative">
          Password masih bawaan. Dashboard ini hanya mendengarkan di 127.0.0.1, jadi tidak terbuka
          dari jaringan — tapi siapa pun yang memakai laptop ini bisa membukanya. Ganti di bawah.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Akun masuk</CardTitle>
          <span className="text-xs text-muted">username saat ini: {currentUsername()}</span>
        </CardHeader>
        <CardContent>
          <CredentialsForm username={currentUsername()} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Toko sendiri</CardTitle>
          <span className="text-xs text-muted">{shops.length} toko ditandai</span>
        </CardHeader>
        <CardContent className="space-y-3">
          {shops.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted">Belum ada toko yang ditandai.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {shops.map((shop) => (
                <li key={shop.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="font-medium text-foreground">{shop.username}</span>
                  <span className="text-muted">
                    {shop.marketplace} · {shop.products.toLocaleString('id-ID')} produk
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Deliberately read-only. The flag decides what counts as "ours" in
              every comparison, and a scrape has to have seen the shop before it
              can be marked — a text box here would let you name a shop that
              does not exist and get an empty dashboard with no explanation. */}
          <p className="text-sm leading-relaxed text-muted">
            Ditandai dari terminal, karena tokonya harus sudah pernah di-scrape lebih dulu:
          </p>
          <code className="block rounded-md border border-line bg-surface-muted px-3 py-2 font-mono text-xs text-foreground">
            ecom-scraper own-shop shopee i_bricks
            <br />
            ecom-scraper own-shop tokopedia i-bricks
            <br />
            ecom-scraper own-shop <span className="text-muted">— lihat daftarnya</span>
          </code>
        </CardContent>
      </Card>
    </div>
  );
}
