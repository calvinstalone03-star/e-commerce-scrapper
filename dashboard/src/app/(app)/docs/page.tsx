import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui';

/**
 * How to use this thing, and where to get the half of it that is not a website.
 *
 * The dashboard is only the reading end. Collection happens in the user's own
 * Chrome, through an extension they have to install by hand and point at an
 * ingest server running on their own machine — three moving parts, none of them
 * discoverable from the screens that show the results. Until this page existed
 * that knowledge lived in the repository README, which is exactly where the
 * person looking at a half-empty product table is not.
 *
 * The download is a committed zip (`scripts/pack-extension.mjs`), not a link to
 * the repository: `dashboard/` is the Vercel root, so the extension source is
 * outside the deployment and cannot be zipped on demand.
 */

export const metadata: Metadata = {
  title: 'Panduan',
  description: 'Cara memasang extension, mengumpulkan data, dan membaca dashboard.',
};

/**
 * Rendered per request like every other page in this group, and that is a
 * security property rather than a performance choice: prerendered, Next served
 * the finished HTML **as the body of the 307 to `/login`**, so the page was
 * readable by anyone who ignored the redirect. The cost of doing it per request
 * is one small file read.
 */
export const dynamic = 'force-dynamic';

const ZIP = '/ecom-scraper-extension.zip';

function extensionVersion(): string | null {
  try {
    const raw = readFileSync(join(process.cwd(), 'public', 'extension-package.json'), 'utf8');
    return String(JSON.parse(raw).version ?? '') || null;
  } catch {
    // A checkout that never ran the packer. The page is still worth rendering;
    // only the version chip is unknowable.
    return null;
  }
}

export default function DocsPage() {
  const version = extensionVersion();

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Panduan</h1>
        <p className="text-sm text-muted">
          Dashboard ini hanya sisi baca. Pengumpulan datanya terjadi di Chrome kamu sendiri lewat
          extension — halaman ini cara memasang dan memakainya.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Alurnya</CardTitle>
          <span className="text-xs text-muted">tiga bagian, satu arah</span>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-foreground">
          <pre className="overflow-x-auto rounded-md border border-line bg-canvas px-3 py-2.5 text-xs text-muted">
            {`extension (Chrome kamu)  →  server ingest (mesin kamu)  →  database  →  dashboard`}
          </pre>
          <p>
            Marketplace menolak diakses langsung oleh skrip, tapi tidak menolak halaman yang memang
            sedang kamu buka. Karena itu extension membaca halaman yang sudah dirender browser, lalu
            mengirimkannya ke server ingest di <Code>127.0.0.1:8787</Code>, yang menulis ke database
            yang dibaca dashboard ini. Tidak ada permintaan tambahan ke marketplace selain halaman
            yang memang dibuka.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>1. Pasang extension</CardTitle>
          {version ? <span className="text-xs text-muted">versi {version}</span> : null}
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-foreground">
          <a
            href={ZIP}
            download
            className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-medium text-accent hover:bg-accent/20"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Unduh extension (.zip)
          </a>

          <Steps>
            <Step n={1}>
              Ekstrak zip-nya ke folder yang <em>tidak akan kamu pindahkan</em>. Chrome memuat
              extension dari folder itu terus-menerus, dan ID extension diturunkan dari letaknya —
              memindahkan folder sama dengan memasang extension baru.
            </Step>
            <Step n={2}>
              Buka <Code>chrome://extensions</Code>, nyalakan <b>Developer mode</b> di kanan atas.
            </Step>
            <Step n={3}>
              Klik <b>Load unpacked</b>, pilih folder hasil ekstrak tadi. Kartu &ldquo;ecom-scraper
              collector&rdquo; akan muncul.
            </Step>
            <Step n={4}>
              Klik ikon puzzle 🧩 di toolbar, lalu pin extension-nya supaya ikonnya selalu terlihat.
            </Step>
          </Steps>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Nyalakan server ingest</CardTitle>
          <span className="text-xs text-muted">sekali per mesin</span>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-foreground">
          <p>
            Extension tidak memegang kredensial database. Ia mengirim hasil bacaannya ke server
            lokal, dan server itu yang menulis ke database. Jalankan dari folder repo:
          </p>
          <pre className="overflow-x-auto rounded-md border border-line bg-canvas px-3 py-2.5 text-xs text-foreground">
            ecom-scraper serve
          </pre>
          <p>
            Perintah itu mencetak sebuah <b>token</b>. Buka popup extension, klik ikon ⚙, tempel
            token tersebut, lalu <b>Simpan</b>. Kalau popup menulis
            <em> &ldquo;server tidak aktif&rdquo;</em>, server ingest-nya belum jalan; kalau menulis
            <em> &ldquo;token ingest ditolak&rdquo;</em>, token yang tersimpan bukan yang terbaru.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Ambil data</CardTitle>
          <span className="text-xs text-muted">satu job pada satu waktu</span>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-foreground">
          <p>
            Buka tab Shopee atau Tokopedia lebih dulu — extension membaca tab yang sedang aktif,
            jadi tombolnya mati kalau tab-nya bukan marketplace. Lalu klik ikon extension.
          </p>
          <dl className="divide-y divide-line rounded-md border border-line">
            <Field name="toko">
              Username toko, URL storefront, atau nama tokonya. Diisi = extension menelusuri seluruh
              katalog toko itu, halaman demi halaman. Kalau tab yang aktif sudah berada di halaman
              toko, kotak ini terisi sendiri.
            </Field>
            <Field name="kata kunci">
              Dibiarkan kosong = seluruh katalog. Diisi bersama <b>toko</b> = pencarian di dalam toko
              itu saja (misalnya <Code>lego</Code>). Diisi tanpa toko = pencarian biasa di seluruh
              marketplace.
            </Field>
            <Field name="jumlah produk">
              Batas atas, bukan target yang harus tercapai. Penelusuran berhenti lebih awal begitu
              produk toko habis.
            </Field>
            <Field name="Lokal / Neon">
              Database tujuan. Terkunci begitu job dimulai, jadi pastikan benar sebelum menekan
              mulai — dashboard yang di-deploy membaca Neon.
            </Field>
          </dl>
          <p>
            Tekan <b>Mulai scrape</b>. Popup boleh ditutup: job hidup di service worker, dan popup
            yang dibuka lagi akan menyambung ke job yang sedang jalan. Tombol yang sama berubah jadi
            <b> Batal</b> selama job berjalan. Kalau job sempat terputus, popup menawarkan
            <b> Lanjutkan</b> — itu menyambung dari halaman terakhir yang sudah tersimpan, bukan
            mengulang dari awal.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4. Membaca hasilnya</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-foreground">
          <dl className="divide-y divide-line rounded-md border border-line">
            <Field name="Produk">
              Semua listing yang pernah terbaca, terbaru di atas. Tiap baris menyimpan riwayat
              harganya, bukan hanya harga hari ini.
            </Field>
            <Field name="Posisi harga">
              Set yang toko sendiri jual, disandingkan dengan harga rival pada set yang sama.
            </Field>
            <Field name="Notifikasi">
              Rival yang <em>menggerakkan harga</em> pada set yang kita jual juga. Bukan catatan
              scraping: sebuah baris baru muncul kalau set-nya cocok dengan katalog toko sendiri,
              ada capture pembanding berumur 24 jam–7 hari, dan selisihnya minimal 5%. Karena itu
              men-scrape satu toko dua kali dalam sehari tidak memunculkan apa pun — pembandingnya
              terlalu muda.
            </Field>
            <Field name="Toko & Analitik">
              Ringkasan per toko dan pergerakan lintas waktu.
            </Field>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Kalau ada yang aneh</CardTitle>
        </CardHeader>
        <CardContent className="text-sm leading-relaxed text-foreground">
          <dl className="divide-y divide-line rounded-md border border-line">
            <Field name="Hasilnya cuma ±30 produk lalu selesai">
              Kotak <b>toko</b> kosong saat tombol ditekan, jadi extension hanya membaca halaman yang
              sedang terbuka. Baris progres yang benar berbentuk <Code>0/2000 produk · hal 1</Code>;
              kalau hanya tertulis <Code>34 produk</Code> tanpa pembagi, itu mode halaman.
            </Field>
            <Field name="Muncul halaman verifikasi / CAPTCHA">
              Marketplace sedang meminta verifikasi manusia. Selesaikan di tab itu, lalu mulai lagi.
              Extension tidak menembus verifikasi apa pun.
            </Field>
            <Field name="Angka di dashboard tidak bertambah">
              Produk yang harganya tidak berubah tidak menulis snapshot baru — itu deduplikasi
              bekerja, bukan scrape yang gagal. Yang selalu ikut naik adalah waktu terakhir produk
              terlihat.
            </Field>
            <Field name="Extension baru di-update tapi perilakunya lama">
              Buka <Code>chrome://extensions</Code> lalu tekan Reload (⟳) pada kartunya. Chrome
              memakai kode yang dimuat, bukan yang ada di folder.
            </Field>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border border-line bg-canvas px-1 py-0.5 font-mono text-[0.85em] text-foreground">
      {children}
    </code>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="space-y-2.5">{children}</ol>;
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-xs text-muted">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-3 py-2.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
      <dt className="font-medium text-foreground">{name}</dt>
      <dd className="text-muted">{children}</dd>
    </div>
  );
}
