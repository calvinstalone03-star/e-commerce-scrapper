import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { IngestToken } from '@/components/IngestToken';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui';

/**
 * How to use this thing, and where to get the half of it that is not a website.
 *
 * Three steps, and the length is the design. An earlier draft explained the
 * architecture, the token, and every field in the popup — accurate, and exactly
 * the shape of thing nobody reads before clicking. What made it shortenable was
 * removing the steps rather than the words: the extension pairs itself over
 * loopback (`GET /pair`), and a storefront tab fills the popup's fields, so what
 * is left to say is install, start the server once, press the button.
 *
 * What is deliberately still here is the "kalau ada yang aneh" card. Every row
 * in it is a real failure someone hit — a run that read one page because the
 * shop box was empty, an empty notifications list that was working correctly —
 * and each is indistinguishable from a broken product until it is named.
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
          Tiga langkah. Data dikumpulkan oleh Chrome kamu sendiri lewat extension — dashboard ini
          hanya membacanya.
        </p>
      </header>

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
              Ekstrak ke folder yang tidak akan dipindahkan — Chrome memuat extension dari folder itu
              terus-menerus.
            </Step>
            <Step n={2}>
              Buka <Code>chrome://extensions</Code>, nyalakan <b>Developer mode</b>, klik{' '}
              <b>Load unpacked</b>, pilih folder tadi.
            </Step>
            <Step n={3}>Klik ikon puzzle di toolbar, lalu pin extension-nya.</Step>
          </Steps>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Hubungkan ke penyimpannya</CardTitle>
          <span className="text-xs text-muted">sekali per browser</span>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-foreground">
          <p>
            Extension mengirim hasil bacaannya ke server yang menulis ke database bersama. Ambil
            alamat dan tokennya di sini, lalu tempel di popup extension → ikon ⚙ → <b>Simpan</b>.
          </p>

          <IngestToken />

          <p className="text-muted">
            Punya server sendiri di mesin ini (<Code>ecom-scraper serve</Code>)? Extension
            memakainya otomatis tanpa token — ia mendeteksi server lokal saat pertama dibuka, dan
            hanya memakai server awan kalau tidak menemukannya.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Ambil data</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-foreground">
          <Steps>
            <Step n={1}>Buka halaman toko di Shopee atau Tokopedia.</Step>
            <Step n={2}>
              Klik ikon extension. Popup menyebut toko yang akan diambil.
            </Step>
            <Step n={3}>
              Klik <b>Scrape toko ini</b>. Popup boleh ditutup — prosesnya lanjut sendiri, dan
              hasilnya muncul di <b>Produk</b> dalam beberapa menit.
            </Step>
          </Steps>
          <p className="text-muted">
            Perlu mengambil sebagian saja, atau memilih database lain? Buka <b>Opsi</b> di popup:
            kotak toko, kata kunci, jumlah produk, dan tujuan penyimpanan ada di sana.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Kalau ada yang aneh</CardTitle>
        </CardHeader>
        <CardContent className="text-sm leading-relaxed text-foreground">
          <dl className="divide-y divide-line rounded-md border border-line">
            <Field name="Popup minta pairing">
              Server ingest belum jalan, atau jendela pairing sudah tutup. Jalankan{' '}
              <Code>ecom-scraper pair</Code> di mesin tempat servernya jalan.
            </Field>
            <Field name="Hasilnya cuma ±30 produk">
              Kotak toko kosong saat tombol ditekan, jadi hanya halaman yang terbuka yang dibaca.
              Baris progres yang benar menyebut dua angka, misalnya <Code>0/2000 produk</Code>.
            </Field>
            <Field name="Muncul verifikasi / CAPTCHA">
              Selesaikan di tab itu, lalu mulai lagi. Extension tidak menembus verifikasi apa pun.
            </Field>
            <Field name="Angka tidak bertambah">
              Produk yang harganya tidak berubah tidak menulis baris baru — itu deduplikasi bekerja,
              bukan scrape yang gagal.
            </Field>
            <Field name="Notifikasi kosong padahal baru scrape">
              Notifikasi butuh pembanding berumur 24 jam–7 hari dan selisih harga minimal 5%.
              Men-scrape toko yang sama dua kali sehari tidak memunculkan apa pun.
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
