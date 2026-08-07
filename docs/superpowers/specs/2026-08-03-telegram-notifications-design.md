# Notifikasi Telegram: yang berubah sejak terakhir, bukan apa yang ada

> **SUPERSEDED.** The feature this document describes was replaced by the
> in-dashboard notifications page. See
> [`docs/superpowers/specs/2026-08-07-dashboard-notifications-design.md`](2026-08-07-dashboard-notifications-design.md).
> Kept as the record of what was built and why it was removed; nothing here
> describes code that still exists.

Tanggal: 2026-08-03

## Masalah

Database ini sudah jadi deret waktu yang benar — `price_snapshots` append-only,
satu baris per (produk, scrape), dan `recent_price_changes` di
`scraper/store.py:804` sudah tahu cara membandingkan satu snapshot dengan
pendahulunya lewat `lag()`. Yang belum ada: siapapun yang memberi tahu.

Konsekuensinya, satu-satunya cara mengetahui rival menurunkan harga adalah
membuka dashboard dan mencarinya. Padahal keputusan yang bergantung padanya —
menyesuaikan harga sendiri — punya jendela waktu. Rival yang turun Senin pagi
dan baru ketahuan Kamis sore adalah tiga hari berjualan di harga yang salah.

Tiga kejadian yang layak mengganggu:

1. **Harga berubah** pada produk yang sudah pernah tercatat.
2. **Toko baru** muncul, belum pernah ada di `stores`.
3. **Produk baru** di toko yang **sudah** pernah di-scrape.

Poin ketiga sengaja dibatasi. Toko baru membawa serta ratusan sampai 1.600
listing sekaligus; kalau masing-masing jadi satu pesan, notifikasi pertama dari
toko baru akan menenggelamkan segalanya. Toko baru cukup diumumkan sebagai satu
kejadian — "toko baru, 1.600 listing" — dan listing per-listing baru jadi berita
setelah tokonya dikenal.

### Volume sebenarnya, dan jebakan di dalamnya

Rancangan awal mengasumsikan volume besar dari ukuran katalog. Data aslinya
membantah itu — lalu, waktu diperiksa lebih dekat, membantah bantahannya
sendiri. Ini yang ada di database:

| | |
|---|---|
| Hari yang punya tangkapan | 2 (29 Juli, 3 Agustus) |
| Perubahan harga menurut `lag()` polos | 40 |
| Produk dengan ≥2 snapshot | 1.373 dari 12.468 |
| Baris di `scrape_runs` | **0** |

Baris terakhir itu yang membuka semuanya: `ecom-scraper run` belum pernah
dijalankan. Seluruh 13.841 snapshot masuk lewat ekstensi browser
(`scraper/ingest.py`). Dan begitu 40 perubahan itu dipilah menurut jarak waktu
antara snapshot yang dibandingkan, angkanya pecah jadi dua populasi yang sama
sekali berbeda:

| Jarak antar snapshot | Pasangan | Berubah harga | Laju |
|---|---|---|---|
| 1,5 – 3,5 jam (dalam satu hari) | 38 | **37** | 97% |
| 111,9 jam (29 Juli → 3 Agustus) | 1.335 | **3** | 0,2% |

Laju yang berbeda 400 kali lipat. Harga pasar tidak berperilaku begitu.

Buktinya menumpuk waktu satu pasangan dibuka utuh: `sold` **identik byte per
byte** di kedua snapshot — 3.000 tetap 3.000, 385 tetap 385 — padahal tiga jam
berlalu di listing yang terjual ribuan. Dan "perubahan"-nya berupa +Rp 25.000
rata di 33 listing sekaligus. Listing yang benar-benar berganti harga akan
menggeser `sold`-nya juga; 33 listing yang bergeser serempak dengan `sold` beku
adalah satu payload yang dibaca dua kali, bukan 33 keputusan penjual.

Kesimpulannya: **selisih harga antara dua tangkapan berjarak dekat bukan
perubahan harga.** Kemungkinan besar dua bentuk payload yang berbeda — halaman
hasil pencarian dan grid toko melaporkan angka yang tidak sama untuk barang yang
sama — tapi akar persisnya tidak perlu dipastikan untuk merancang di sekitarnya.

Jadi volume nyata perubahan harga hari-ke-hari adalah **3 dalam 5 hari**, bukan
40. Itu yang membuat **tidak ada ambang persentase** di rancangan ini: ketiganya
besar (+16,3%, +25,0%, +66,7%) dan tidak ada yang perlu disaring. Yang perlu
disaring bukan besarnya perubahan, melainkan pasangan yang terlalu berdekatan
untuk bisa dipercaya.

## Keputusan

### Notifier hidup di Vercel, bukan di Python

Notifier adalah route handler Next.js di deployment dashboard, bukan perintah
`ecom-scraper`. Tiga alasan, berurut dari yang paling menentukan:

**Link butuh basis URL yang bisa diklik dari HP.** Dashboard lokal terikat ke
`127.0.0.1:3100` (`scripts/dashboard-server.sh:52`); link ke situ mati di
perangkat lain. Di dalam deployment, basis URL-nya tersedia sebagai
`VERCEL_PROJECT_PRODUCTION_URL` tanpa dikonfigurasi siapapun, dan ia mengikuti
domain produksi kalau nanti ada domain kustom.

**Ada dua jalur tulis, bukan satu.** `scraper/runner.py:1202` (scrape CLI) dan
`scraper/ingest.py:396` (server ekstensi) sama-sama menulis snapshot. Notifier
yang menempel di jalur tulis butuh dua kait yang harus dijaga tetap sinkron
selamanya. Notifier yang **membaca database** tidak butuh kait sama sekali, dan
otomatis mencakup penulis ketiga yang belum ada.

**Panggilan jaringan tidak boleh masuk transaksi.** `runner._execute_target`
bekerja keras menjaga fetch di luar transaksi (dokumennya di `runner.py:976`);
menyisipkan HTTP ke api.telegram.org di dalam `_persist` membatalkan usaha itu.

Alternatif yang ditolak: trigger Postgres + `LISTEN/NOTIFY`. Ia menangkap semua
penulis termasuk yang belum ada, tapi memindahkan logika format pesan ke
PL/pgSQL dan menuntut satu proses daemon hidup terus-menerus — dua hal yang
tidak dimiliki maupun diinginkan proyek ini.

### Laptop yang memicu, bukan cron Vercel

Cron Vercel di plan Hobby dibatasi **sekali sehari**, dan ekspresi yang lebih
sering **gagal saat deploy**, bukan gagal diam-diam. Presisinya pun ±59 menit.
Notifikasi yang tiba sampai 25 jam setelah kejadian tidak menyelesaikan masalah
yang membuat fitur ini ada.

Jadi pemicunya dari luar: selesai scrape, mesin lokal mengirim `POST` ke
`/api/notify` dengan token bearer. Notifikasi tiba beberapa detik setelah baris
terakhir ditulis.

```bash
# setelah ecom-scraper run, di cron laptop
curl -fsS -X POST \
  -H "Authorization: Bearer $NOTIFY_SECRET" \
  "$NOTIFY_URL/api/notify"
```

Tidak ada `crons` di `dashboard/vercel.json`. Konsekuensi yang diterima sadar: kalau
laptop mati, tidak ada notifikasi. Itu benar secara logika — kalau laptop mati,
tidak ada yang men-scrape, jadi tidak ada yang perlu dinotifikasi. Dan karena
watermark berbasis id (di bawah), tidak ada yang **terlewat**: kejadian yang
menumpuk selama laptop mati akan terkirim pada pemicuan berikutnya.

### Watermark berbasis id, bukan waktu

State-nya satu baris, tiga integer: id snapshot, produk, dan toko terakhir yang
sudah dinotifikasi. Query-nya "yang id-nya lebih besar dari itu".

`price_snapshots.id` adalah `bigserial`, `products.id` dan `stores.id` adalah
`serial` — ketiganya naik monoton. Akibatnya rancangan ini kebal terhadap
seluruh kelas bug yang menghantui watermark berbasis waktu: tidak ada clock
skew antara laptop dan Neon, tidak ada jendela overlap yang perlu ditebak, tidak
ada baris yang tertulis dengan `scraped_at` mundur (yang nyata terjadi di sini —
`insert_snapshot_if_changed` di `store.py:348` sudah punya `abs()` justru karena
timestamp bisa datang tidak berurutan).

Alternatif yang ditolak: jendela waktu tanpa state ("kirim perubahan 25 jam
terakhir"). Ia menghindari penulisan sama sekali, tapi menukarnya dengan
duplikat di setiap overlap dan kehilangan diam-diam setiap kali pemicuan gagal.

### Pembanding harus cukup tua

Snapshot baru **tidak** dibandingkan dengan pendahulu terdekatnya, melainkan
dengan snapshot terakhir yang setidaknya `NOTIFY_MIN_GAP_HOURS` (default 12)
lebih tua. Kalau tidak ada yang cukup tua, tidak ada perbandingan, dan produk
itu tidak menghasilkan kejadian.

Ini yang menjinakkan temuan di atas. Terhadap data yang ada, aturan ini
membuang 37 selisih semu berjarak 1,5–3,5 jam dan mempertahankan ketiga
perubahan berjarak 111,9 jam — dari 40 jadi 3, dan ketiganya yang benar.

Alternatif yang ditolak, dan alasannya:

- **Ambang persentase.** Tidak menyentuh masalahnya. Selisih semu +Rp 25.000 di
  listing Rp 153.400 adalah 16,3%, lebih besar daripada dua dari tiga perubahan
  asli. Ambang apapun yang membuang yang semu juga membuang yang asli.
- **Menunggu konfirmasi dua tangkapan berturut-turut.** Benar, tapi menunda
  setiap notifikasi satu putaran penuh — menghapus keunggulan pemicuan langsung
  yang jadi alasan tidak memakai cron Vercel.
- **Memperbaiki sumbernya di `ingest.py`.** Itu perbaikan yang sesungguhnya, dan
  bukan milik spec ini. Dicatat di bawah sebagai pekerjaan tersendiri.

Yang jujur perlu dicatat: aturan ini menyembunyikan gejala, bukan menyembuhkan
penyakitnya. Selama dua bentuk payload melaporkan harga yang berbeda, kolom
`price` yang dipakai dashboard posisi harga juga membandingkan angka yang belum
tentu sebanding. Notifier cukup aman dengan jarak minimum; dashboard belum tentu.

### Menulis watermark melanggar satu aturan, dengan sengaja

`dashboard/src/lib/db.ts` menyatakan aplikasi ini *"never writes and never
migrates"*, dan alasannya bagus: dua otoritas migrasi atas satu database adalah
cara skema bercerai. Notifier harus menulis watermark.

Komprominya menjaga alasan aslinya tetap utuh:

- **Skema tetap milik Python.** Tabelnya dibuat `migrations/005_notify_watermark.sql`
  dan `ecom-scraper initdb`, sama seperti tabel lain. Dashboard tidak pernah
  memigrasi apapun.
- **Tulisannya satu tabel, satu baris.** Dashboard tidak pernah menulis ke
  `stores`, `products`, `price_snapshots`, atau `scrape_runs`.
- **Tulisannya terkurung di satu modul,** `notify/watermark.ts`. Isolasinya di
  tingkat modul, bukan koneksi: klien `sql` dari `db.ts` tetap dipakai bersama.
  Klien kedua akan menggandakan koneksi per instance, dan `db.ts:80` menjelaskan
  kenapa angka itu sengaja 1 di Vercel — delapan koneksi per instance terhadap
  endpoint pooled adalah cara dashboard menjatuhkan dirinya sendiri. Klien
  terpisah juga tidak membeli apa-apa: ia memakai peran Postgres yang sama, jadi
  "read-only" di `db.ts` selalu berupa disiplin, bukan izin.

## Bentuk data

### `migrations/005_notify_watermark.sql`

Idempoten seperti tetangganya — tidak ada ledger migrasi di direktori ini, jadi
menjalankan ulang adalah jalur pemulihan.

```sql
CREATE TABLE IF NOT EXISTS notify_watermark (
    id                      integer     PRIMARY KEY,
    last_snapshot_id        bigint      NOT NULL DEFAULT 0,
    last_product_id         integer     NOT NULL DEFAULT 0,
    last_store_id           integer     NOT NULL DEFAULT 0,
    last_stale_warning_at   timestamptz,
    updated_at              timestamptz,
    CONSTRAINT ck_notify_watermark_singleton CHECK (id = 1)
);
```

Baris awalnya **tidak** nol. Ia diisi dengan id maksimum yang ada saat migrasi
dijalankan:

```sql
INSERT INTO notify_watermark (id, last_snapshot_id, last_product_id, last_store_id, updated_at)
VALUES (1,
        COALESCE((SELECT max(id) FROM price_snapshots), 0),
        COALESCE((SELECT max(id) FROM products), 0),
        COALESCE((SELECT max(id) FROM stores), 0),
        now())
ON CONFLICT (id) DO NOTHING;
```

Tanpa ini, pemicuan pertama akan mengumumkan **32 toko** yang sudah dikenal
berminggu-minggu sebagai toko baru, dan setiap perubahan harga sepanjang sejarah
sebagai kabar hari ini. Sejarah sebelum notifier ada bukan berita.

`CHECK (id = 1)` membuat tabel ini singleton di tingkat skema, bukan lewat
kesepakatan. `ON CONFLICT DO NOTHING` membuat migrasinya aman dijalankan ulang
tanpa mengembalikan watermark ke belakang.

### Tiga query

Semua dijalankan dalam **satu transaksi** bersama `UPDATE` watermark-nya, supaya
"terkirim" dan "tercatat terkirim" tidak bisa terpisah.

**Perubahan harga.** Bukan `lag()`. Aturan "pembanding harus cukup tua" bukan
sesuatu yang bisa dinyatakan sebagai jendela geser, karena pendahulu yang
dicari bukan yang sebelumnya melainkan yang **terakhir sebelum ambang umur** —
dan itu pencarian per baris, yaitu `LATERAL`:

```sql
WITH baru AS (
  SELECT DISTINCT ON (ps.product_ref)
         ps.id, ps.product_ref, ps.price, ps.scraped_at
  FROM price_snapshots ps
  WHERE ps.id > $1 AND ps.price IS NOT NULL
  ORDER BY ps.product_ref, ps.scraped_at DESC, ps.id DESC
)
SELECT b.id, b.price, b.scraped_at,
       lama.price AS prev, lama.scraped_at AS prev_at,
       p.id AS product_id, p.name, p.set_code, p.marketplace, p.url,
       s.id AS store_id, s.username, s.is_own
FROM baru b
CROSS JOIN LATERAL (
  SELECT ps.price, ps.scraped_at
  FROM price_snapshots ps
  WHERE ps.product_ref = b.product_ref
    AND ps.price IS NOT NULL
    -- Tanpa ini, pada ambang 0 baris itu sendiri lolos predikat waktu dan
    -- ORDER BY memilihnya sebagai pembanding terdekat. Hasilnya nol, selalu.
    AND ps.id <> b.id
    AND ps.scraped_at <= b.scraped_at - make_interval(hours => $2)
  ORDER BY ps.scraped_at DESC, ps.id DESC
  LIMIT 1
) lama
JOIN products p ON p.id = b.product_ref
LEFT JOIN stores s ON s.id = p.shop_ref
WHERE b.price <> lama.price
ORDER BY b.id;
```

Tiga hal yang dikerjakan bentuk ini, masing-masing sengaja:

`DISTINCT ON (product_ref)` mengambil **satu** snapshot terbaru per produk. Satu
produk yang tertangkap tiga kali dalam satu putaran adalah satu kejadian, bukan
tiga pesan.

`CROSS JOIN` — bukan `LEFT JOIN` — pada `LATERAL`-nya. Produk yang tidak punya
pendahulu cukup tua menghasilkan nol baris dan hilang dari hasil, yang persis
perilaku yang diinginkan: tanpa pembanding yang sah, tidak ada yang bisa
dikatakan. Ini juga yang menggantikan `prev IS NOT NULL` di
`recent_price_changes` — "harga jadi diketahui" tetap bukan perubahan harga,
karena `ps.price IS NOT NULL` menyaring kedua sisi.

Subquery `LATERAL`-nya dilayani persis oleh indeks yang sudah ada,
`ix_price_snapshots_product_ref_scraped_at (product_ref, scraped_at DESC)` di
`migrations/001_init.sql:94` — urutan kolomnya dan arah `DESC`-nya kebetulan
sudah tepat, jadi tiap pencarian adalah satu penelusuran indeks, bukan
pemindaian tabel.

**Toko baru.** `SELECT ... FROM stores WHERE id > $1 ORDER BY id`, dengan jumlah
listing-nya sebagai subquery.

**Produk baru di toko lama.** Klausa keduanya yang membawa seluruh persyaratan:

```sql
SELECT p.id, p.name, p.set_code, p.marketplace, p.url, s.id AS store_id, s.username
FROM products p
JOIN stores s ON s.id = p.shop_ref
WHERE p.id > $1        -- produk baru
  AND s.id <= $2       -- di toko yang sudah dikenal sebelum putaran ini
ORDER BY p.id;
```

`s.id <= $2` memakai watermark toko, bukan watermark produk. Efeknya persis yang
diminta: 1.600 listing toko baru tidak jadi 1.600 pesan, karena tokonya sendiri
belum melewati watermark. Ia jadi satu pesan "toko baru". Listing berikutnya dari
toko itu, di putaran berikutnya, baru terhitung produk baru.

## Pesan

### Format

HTML, bukan MarkdownV2. MarkdownV2 mewajibkan meng-escape sekitar 15 karakter,
dan nama listing di sini penuh `(`, `)`, `-`, `.`, `–` — satu yang terlewat
membuat Telegram menolak seluruh pesan dengan 400. HTML hanya butuh `&`, `<`,
`>`.

Satu digest per pemicuan, dikelompokkan per jenis kejadian. Delta yang identik
dari toko yang sama dilipat jadi satu baris — itu yang mengubah 38 baris
`lego.indonesia` jadi satu fakta:

Contoh di bawah bukan ilustrasi. Ini **keluaran sebenarnya** kalau notifier
dijalankan atas data per 2026-08-03 dengan watermark disetel ke akhir 29 Juli:

```
📊 3 Agustus 2026, 09:54

📈 Naik harga — 3

  • Lego Architecture 21037 LEGO House — kenjiro13 · Tokopedia
    Rp 3.000.000 → Rp 5.000.000  (+66,7%)
    → posisi kita di 21037

  • Lego Creator 10272 Old Trafford - Manchester — kenjiro13 · Tokopedia
    Rp 12.000.000 → Rp 15.000.000  (+25,0%)
    → posisi kita di 10272

  • Lego 71040 Disney Castle — kenjiro13 · Tokopedia
    Rp 8.600.000 → Rp 10.000.000  (+16,3%)
    → posisi kita di 71040

📦 Produk baru di toko lama — 4

  • Lego Art 31209 The Amazing Spider-Man — kenjiro13 · Tokopedia → lihat
  • Lego Art 31208 Hokusai - The Great Wave — kenjiro13 · Tokopedia → lihat
  • Lego Friends 41731 Heartlake International School — kenjiro13 · Tokopedia → lihat
  • Lego SuperHeroes 76104 The Hulkbuster Smash-Up — kenjiro13 · Tokopedia → lihat
```

Tujuh baris, semuanya benar. Rancangan sebelum aturan jarak minimum akan
mengirim 44 baris di tempat ini, 37 di antaranya mengarang gerakan harga yang
tidak pernah terjadi.

Urutan di dalam kelompok: persentase terbesar dulu. Yang bergerak 66,7% lebih
layak dibaca pertama daripada yang bergerak 1,3%.

### Pelipatan

≥3 listing dari toko yang sama dengan delta absolut identik dilipat jadi satu
baris — "`+Rp 25.000 serempak di 33 listing`". Di bawah tiga, tampil satu per
satu, karena dua perubahan yang kebetulan sama besar bukan pola.

Aturan ini **tidak menyala** pada data di atas: ketiga perubahannya punya delta
berbeda. Ia tetap ada karena penetapan harga borongan itu nyata — toko yang
menaikkan seluruh katalognya serempak akan menghasilkannya — dan karena tanpa
itu satu kejadian semacam itu jadi tembok teks yang menenggelamkan sisanya.

Batas 4.096 karakter Telegram dipecah per kelompok, bukan di tengah baris.

Pemotongannya **tidak** menunggu satu kelompok melewati batas karakter, seperti
draf pertama spec ini menuliskannya. Ia tegas di **12 entri per kelompok**, dan
seluruh digest dibatasi **4 pesan**. Alasannya muncul di review menyeluruh:
tanpa batas, 1.600 produk baru menghasilkan 63 pesan, sementara Telegram
membatasi satu chat sekitar 20 pesan per menit. Setiap 429 membeli satu tidur
`retry_after` **di dalam transaksi** yang memegang `FOR UPDATE`; lewat batas
waktu fungsi, transaksinya rollback, watermark tidak maju, dan jalan berikutnya
menyusun digest yang sama tapi lebih besar. Macet tanpa jalan keluar otomatis.
Dan 1.600 itu bukan angka karangan — `scraper/ingest.py:372` commit satu
transaksi per halaman tangkapan, jadi baris tokonya bisa lewat watermark di satu
putaran sementara sisa listing-nya menyusul di putaran berikutnya.

Sisanya diringkas "… N lainnya", dan angka itu menghitung **listing**, bukan
baris terlipat — jadi yang ditampilkan ditambah sisanya selalu sama dengan angka
di judul kelompok. Judul tidak pernah bohong soal berapa yang sebenarnya
berubah, dan itu tetap berlaku setelah pelipatan menggabungkan banyak listing
jadi satu baris.

Konsekuensi yang diterima sadar: pemotongan ini **permanen, bukan ditunda**.
Watermark tetap maju, jadi entri yang terbuang tidak dikirim ulang di putaran
berikutnya. Digest yang membuat notifier macet selamanya lebih buruk daripada
digest yang memberi tahu 12 gerakan terbesar dan menyebutkan sisanya ada.

### Link

`/pricing/[id]` hanya menerima produk toko sendiri: `queries.ts:769` menjoin
`AND s.is_own`, dan id rival menghasilkan `notFound()` di
`pricing/[id]/page.tsx:61`. Karena ketiga perubahan harga yang ada milik rival —
dan wajar begitu, harga toko sendiri kamu yang menetapkan — link tidak bisa
seragam.

| Kejadian | Tujuan | Alasan |
|---|---|---|
| Harga produk sendiri berubah | `/pricing/<products.id>` | Halaman ini membetulkan `?kanal=` sendiri (`page.tsx:68`), jadi link telanjang mendarat benar |
| Harga rival berubah, punya `set_code` | `/pricing?kanal=<mp>&q=<set_code>` | Yang ingin dilihat saat rival bergerak bukan listing dia, tapi **posisi kita** di set itu. `/pricing` mencari `set_code` lewat prefix (`queries.ts:409`) |
| Harga rival berubah, tanpa `set_code` | `/products?q=<nama>` | Aksesoris dan bundel tidak punya nomor set. `/products` mencari nama (`queries.ts:193`) dan lintas-marketplace |
| Toko baru | `/stores/<stores.id>` | |
| Produk baru di toko lama | `/products?storeId=<stores.id>` | |

Tidak ada rute yang menerima `item_id` marketplace — semua `[id]` di dashboard
adalah primary key Postgres kita. Pesan membawa `products.id` dan `stores.id`,
bukan id marketplace.

Basis URL: `https://` + `VERCEL_PROJECT_PRODUCTION_URL`, dapat ditimpa
`NOTIFY_BASE_URL`. `VERCEL_URL` **tidak** dipakai — ia berubah setiap deploy,
jadi link di riwayat Telegram akan membusuk.

### Login tidak lagi membuang tujuan

Klik dari HP tanpa cookie `mcl_session` yang masih hidup akan mendarat di
`/login`, lalu dibuang ke `/` — tujuan aslinya hilang, karena `login/page.tsx:23`
hanya membaca param `changed` dan aksi sign-in di `actions/auth.ts:28`
selalu ke `/`. Cookie bertahan 7 hari, jadi ini hanya menggigit kalau dashboard
jarang dibuka; tapi justru itu keadaan orang yang mengklik notifikasi.

Perbaikannya: penjaga rute menyimpan tujuan sebagai `?next=`, halaman login
meneruskannya, aksi sign-in mengembalikannya.

**`next` wajib divalidasi**, bukan diteruskan mentah. Hanya path relatif yang
diterima: harus mulai `/`, dan **tidak** boleh mulai `//` atau `/\` — keduanya
protocol-relative dan berubah jadi redirect ke domain asing. Apapun selain itu
jatuh ke `/`.

Mekanisme penangkapan path-nya butuh dibaca dulu di
`node_modules/next/dist/docs/` sebelum ditulis, sesuai `dashboard/AGENTS.md`:
layout App Router tidak menerima pathname, dan Next 16 mengganti nama
`middleware.ts`. Ini keputusan waktu implementasi, bukan tebakan waktu desain.

## Penjaga kebasian

Repo ini tidak punya `.env` di root sama sekali, jadi `scraper/config.py:53`
jatuh ke `DEFAULT_DATABASE_URL` — scraper dan ingest server menulis ke Postgres
laptop, sementara dashboard membaca Neon. Snapshot terbaru di laptop bertanggal
3 Agustus; Neon kemungkinan berhenti di 29–30 Juli.

README-nya sendiri sudah memperingatkan bentuk kegagalan ini di baris 587: *"the
extension will go on filling the local database while the dashboard reads the
hosted one and reports that nothing has changed since the day you deployed."*
Notifier yang polos akan mewujudkannya sebagai keheningan sempurna — nol pesan,
selamanya, tanpa satupun tanda ada yang salah.

Jadi: kalau `max(scraped_at)` di database yang dibaca lebih tua dari
`NOTIFY_STALE_HOURS` (default 36), notifier mengirim peringatan alih-alih diam,
dan **tidak** memajukan watermark.

```
⚠️ Data tidak bergerak

Snapshot terbaru: 29 Juli 2026, 21:14 (128 jam lalu).
Notifier membaca database ini, tapi tidak ada yang menulis ke sini.

Periksa DATABASE_URL di root .env — kalau ia menunjuk 127.0.0.1,
scrape masuk ke laptop dan tidak pernah sampai ke sini.
```

Peringatan ini dibatasi sekali per 24 jam lewat `last_stale_warning_at`, supaya
database yang basi berminggu-minggu tidak jadi sumber spam-nya sendiri.

Ini menyelesaikan setengah masalah. Setengah lainnya — mengarahkan ingest ke
Neon — pekerjaan operasional, di luar lingkup spec ini, dan dicatat di bawah.

## Keamanan

`/api/notify` adalah jalur mesin-ke-mesin, jadi ia tidak bisa berada di balik
cookie sesi maupun `withSession` (`api-session.ts:35`) yang menjaga rute JSON
lain. Penjaganya sendiri:

- **`POST` saja.** Ia memajukan watermark; `GET` yang mengubah state akan
  ditembak prefetcher dan crawler.
- **Bearer token** `NOTIFY_SECRET`, dibandingkan **waktu-konstan**
  (`crypto.timingSafeEqual` atas digest panjang tetap, supaya panjang token
  tidak bocor lewat perbandingan yang gagal cepat).
- **Tidak ada tanpa token.** `NOTIFY_SECRET` yang kosong atau tidak diset =
  route menolak semua permintaan, bukan membuka diri.
- **Token tidak pernah masuk log maupun pesan galat.** Sama seperti alasan
  `repr=False` pada `Settings.database_url` (`config.py:79`): galat di proyek
  ini berakhir tersimpan di database.
- **Balasan tidak membocorkan isi.** Sukses membalas ringkasan jumlah
  (`{sent: 3, priceChanges: 40, ...}`), bukan nama produk.

`TELEGRAM_BOT_TOKEN` memberi kendali penuh atas bot, dan `TELEGRAM_CHAT_ID`
menentukan siapa yang menerima. Keduanya env var Vercel, tidak pernah masuk
repo, dan `.env.example` hanya memuat namanya dengan nilai kosong.

## Variabel lingkungan

| Nama | Di mana | Wajib | Default |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Vercel | ya | — |
| `TELEGRAM_CHAT_ID` | Vercel | ya | — |
| `NOTIFY_SECRET` | Vercel + laptop | ya | — |
| `NOTIFY_BASE_URL` | Vercel | tidak | `https://$VERCEL_PROJECT_PRODUCTION_URL` |
| `NOTIFY_MIN_GAP_HOURS` | Vercel | tidak | `12` |
| `NOTIFY_STALE_HOURS` | Vercel | tidak | `36` |

Tanpa `TELEGRAM_BOT_TOKEN` atau `TELEGRAM_CHAT_ID`, route menolak start dengan
pesan yang menyebut variabel mana yang kurang — pola yang sama dengan
`resolveConnectionString` di `db.ts:40`, yang menolak jalan diam-diam justru
supaya galatnya menyalahkan mesin yang benar.

## Berkas

```
migrations/005_notify_watermark.sql          tabel + baris awal
dashboard/src/lib/notify/watermark.ts        baca/tulis watermark, klien penulis
dashboard/src/lib/notify/events.ts           tiga query → tipe kejadian
dashboard/src/lib/notify/links.ts            kejadian → URL dashboard
dashboard/src/lib/notify/format.ts           kejadian → HTML, pelipatan, pemecahan
dashboard/src/lib/notify/telegram.ts         klien Bot API
dashboard/src/app/api/notify/route.ts        penjaga + orkestrasi
```

Pemisahannya mengikuti aturan yang sama dengan sisa app ini: `format.ts` dan
`links.ts` tidak menyentuh jaringan maupun database, jadi keduanya dapat dites
sebagai fungsi murni — dan justru di situ hampir semua bug format bersembunyi.

**Tidak ada `vercel.json` yang disentuh.** Tanpa `crons`, tidak ada yang perlu
dikonfigurasi: Fluid Compute memberi 300 detik sebagai default di semua plan, dan
route ini mengerjakan tiga query lalu satu POST ke Telegram — hitungan sub-detik,
bukan sesuatu yang butuh `maxDuration`. Berkas `dashboard/vercel.json` memang
ada di branch `pin-vercel-framework` yang belum digabung, tapi ia menyelesaikan
masalah lain (preset framework) dan tidak perlu diubah untuk fitur ini.

Deployment-nya adalah projek Vercel milik Calvin, `e-commerce-scrapper`, ter-link
ke repo GitHub `calvinstalone03-star/e-commerce-scrapper` dengan Root Directory
`dashboard`. Konsekuensinya untuk alur kerja: **deploy terjadi saat merge ke
`main`**, bukan lewat `vercel --prod` dari mesin ini. Direktori
`dashboard/.vercel/` di laptop menunjuk projek lain bernama `mcl-dashboard` —
sisa percobaan CLI, ter-gitignore, tidak pernah ikut ke repo, dan tidak
memengaruhi deployment yang sebenarnya.

## Kasus tepi

| Keadaan | Perilaku |
|---|---|
| Pemicuan pertama setelah migrasi | Watermark sudah di id maksimum; nol kejadian, nol pesan |
| Tidak ada yang berubah | Tidak mengirim apapun. Balas `{sent: 0}`. Diam adalah jawaban yang benar |
| Toko baru dengan 1.600 listing | Satu pesan toko baru; 1.600 listing-nya tidak jadi produk baru |
| Produk dengan `shop_ref` NULL | Tetap dinotifikasi, kolom toko diisi "toko tak dikenal". Backfill toko bukan urusan notifier |
| Harga dari NULL jadi ada nilai | Bukan perubahan harga. Tidak dikirim |
| Produk baru yang baru punya satu snapshot | Tidak ada pembanding cukup tua → nol kejadian harga. Ia muncul sebagai produk baru, bukan sebagai perubahan harga |
| Dua tangkapan berjarak 3 jam, harga beda | Tidak dikirim. Inilah artefak yang aturan jarak minimum ada untuk membuangnya |
| Satu produk tertangkap tiga kali satu putaran | Satu kejadian, memakai snapshot terbaru |
| Snapshot dengan `scraped_at` mundur | Tidak berpengaruh pada watermark (memakai id), tapi **berpengaruh** pada pemilihan pembanding, yang memang memakai waktu. Yang mundur melewati ambang umur lebih cepat — diterima sadar, karena alternatifnya mengurutkan umur dengan id yang tidak mengukur waktu |
| Telegram membalas 429 | Hormati `retry_after`, coba lagi sekali. Gagal lagi → watermark **tidak** maju, kejadiannya terkirim di pemicuan berikutnya |
| Telegram membalas 200 tapi badannya bukan JSON | **Gagal**, bukan sukses. Gateway yang menjawab 200 dengan halaman HTML error akan membuat watermark maju padahal tak ada yang terkirim — kehilangan senyap, persis yang dicegah desain ini. Ditemukan di review; `readBody` sekarang membedakan tiga keadaan, bukan dua |
| `fetch` menolak sebelum ada respons | Galatnya **tidak** diteruskan apa adanya. URL permintaan memuat bot token, dan sebagian pembungkus `fetch` menyertakan URL di pesan galatnya. Pesan yang dilempar dibangun hanya dari `error.name` |
| Telegram gagal di tengah digest berbilah | Watermark tidak maju sama sekali. Duplikat lebih baik daripada hilang diam-diam |
| Dua pemicuan bersamaan | `SELECT ... FOR UPDATE` pada baris watermark; yang kedua menunggu lalu tidak menemukan apa-apa |
| Database basi | Peringatan, maksimal sekali per 24 jam. Watermark tidak maju |
| `next` berisi `//jahat.com` | Ditolak validasi, jatuh ke `/` |

## Pengujian

Fungsi murni, tanpa jaringan maupun database:

1. **Pelipatan delta identik**: 33 listing satu toko delta sama → satu baris;
   2 listing delta sama → dua baris; delta sama tapi beda toko → tidak dilipat.
2. **Format rupiah dan persen**: negatif, nol, pecahan, angka besar.
3. **Pemecahan 4.096 karakter**: tidak pernah memotong di tengah baris; jumlah di
   judul kelompok tetap jumlah penuh meski isinya dipotong.
4. **Escape HTML**: nama listing berisi `&`, `<`, `>`.
5. **Pemilihan link**: produk sendiri, rival ber-`set_code`, rival tanpa
   `set_code`, toko baru, produk baru.
6. **Validasi `next`**: `/pricing/3` lolos; `//jahat.com`, `/\jahat.com`,
   `https://jahat.com`, dan string kosong jatuh ke `/`.

Terhadap database:

7. **Watermark maju** persis ke id maksimum yang dilihat, bukan ke `max(id)`
   tabel — dua nilai itu berbeda kalau ada baris masuk saat query berjalan.
8. **Produk baru di toko baru tidak terhitung produk baru**; produk baru
   berikutnya di toko itu terhitung.
9. **Harga NULL di salah satu sisi tidak dikirim.**
10. **Jarak minimum**: dua snapshot berjarak 3 jam dengan harga berbeda → nol
    kejadian; berjarak 13 jam → satu kejadian. Produk yang **hanya** punya
    snapshot berdekatan hilang sepenuhnya dari hasil, bukan muncul dengan
    pembanding kosong.
11. **Satu produk, tiga snapshot baru dalam satu putaran** → satu kejadian,
    memakai yang terbaru, bukan tiga.
12. **Kegagalan Telegram membatalkan pemajuan watermark** — jalankan lagi,
    kejadian yang sama muncul lagi.
13. **Penjaga kebasian** menyala di atas ambang, diam di bawahnya, dan tidak
    mengulang peringatan dalam 24 jam.

### Patokan verifikasi

Angka-angka ini sudah dijalankan terhadap database yang ada, jadi implementasi
yang benar harus mereproduksinya persis. Watermark disetel ke keadaan akhir
29 Juli — `last_snapshot_id = 12508`, `last_product_id = 12950`,
`last_store_id = 248` — lalu notifier dijalankan:

| Watermark | Keluaran | Harus |
|---|---|---|
| 12508 / 12950 / 248 | Perubahan harga (ambang 12 jam) | **3** |
| 12508 / 12950 / 248 | Toko baru | **0** |
| 12508 / 12950 / 248 | Produk baru di toko lama | **4** |
| 12508 / 12950 / 248 | Produk baru di toko baru (tidak dikirim) | **0** |
| snapshot 0 | Perubahan harga (ambang **0** jam) | **40** |
| snapshot 0 | Perubahan harga (ambang 12 jam) | **3** |

Dua baris terakhir yang membuktikan aturan jarak minimum, dan keduanya harus
memakai watermark **nol** — bukan 12508. Alasannya terukur: ke-37 pasangan
artefak punya baris barunya di id snapshot 2718–3012, sedangkan ketiga
perubahan asli di 13656–13840. Watermark 12508 berada di atas seluruh artefak,
jadi tidak ada ambang yang bisa memunculkannya kembali; di sana ambang 0 dan
ambang 12 sama-sama menghasilkan 3, dan itu benar.

Ambang **0** adalah tes kesetaraan: dengan penyaring dimatikan, query ini harus
sepakat persis dengan `lag()` polos atas seluruh tabel, yang menghitung 40
secara independen. Kalau tidak 40, LATERAL-nya memilih pendahulu yang berbeda
dari yang `lag()` pilih, dan selisih itu bug — bukan ambang.

Satu jebakan yang sudah memakan korban sekali: pada ambang 0, predikat
`scraped_at <= scraped_at` memasukkan baris itu sendiri, dan `ORDER BY ... DESC
LIMIT 1` lalu memilihnya. Tanpa `AND ps.id <> latest_new.id` setiap produk
dibandingkan dengan dirinya sendiri dan hasilnya selalu nol.

## Di luar lingkup

- **Mengarahkan ingest ke Neon.** Pekerjaan operasional (README bagian 7 langkah
  5), prasyarat agar fitur ini berguna, tapi bukan kode. Penjaga kebasian ada
  supaya kelalaian ini terlihat, bukan supaya tidak perlu dikerjakan.
- **Cron Vercel.** Tidak dipasang; pemicunya laptop. Kalau nanti pindah ke plan
  Pro, `dashboard/vercel.json` tinggal ditambahi `crons` dan route-nya tidak
  berubah.
- **Menemukan kenapa dua tangkapan berdekatan melaporkan harga berbeda.**
  Pekerjaan tersendiri, di `scraper/ingest.py`, dan lebih penting daripada spec
  ini — ia menyentuh kolom `price` yang dipakai seluruh dashboard posisi harga,
  bukan hanya notifikasi. Aturan jarak minimum di sini membuat notifier tahan
  terhadapnya; ia tidak memperbaikinya. Titik mulai yang disarankan: catat
  path payload asal di `price_snapshots`, lalu bandingkan harga per path untuk
  satu `item_id` yang sama.
- **Ambang penyaring persentase.** Ditolak: ia tidak memisahkan yang semu dari
  yang asli (16,3% muncul di kedua populasi). Kalau nanti tetap dibutuhkan, ia
  satu klausa `WHERE` di `events.ts` — bukan perubahan bentuk.
- **Perubahan stok, sold, atau rating.** Snapshot menyimpannya, tapi tidak ada
  keputusan harian yang menggantunginya.
- **Notifikasi per-pengguna atau lebih dari satu chat.** Satu `TELEGRAM_CHAT_ID`.
- **Tombol aksi di Telegram** (inline keyboard untuk menyesuaikan harga).
  Membutuhkan jalur tulis dari Telegram ke database — fitur tersendiri dengan
  model ancaman tersendiri.
- **Riwayat notifikasi yang bisa dilihat di dashboard.** Watermark menyimpan
  posisi, bukan arsip.

## Utang teknis

`recent_price_changes` di `scraper/store.py:804` dan query perubahan harga di
`events.ts` menjawab pertanyaan yang mirip dalam dua bahasa. Keduanya sudah
terlanjur ada di sisi berlawanan dari batas Python/TypeScript yang memang
disengaja proyek ini (`db.ts` menjelaskan kenapa dashboard memakai SQL mentah
alih-alih ORM), jadi menyatukannya berarti memilih satu sisi.

Perlu dicatat bahwa keduanya kini **tidak lagi setara**: `recent_price_changes`
memakai `lag()` polos, jadi ia masih melaporkan 40 perubahan — termasuk 37 yang
merupakan artefak tangkapan. Ia dipakai `ecom-scraper stats`. Menyelaraskannya
dengan aturan jarak minimum adalah pekerjaan kecil di Python, tapi ia mengubah
keluaran perintah yang sudah ada dan punya tesnya sendiri, jadi ia perubahan
tersendiri — bukan efek samping spec ini.
