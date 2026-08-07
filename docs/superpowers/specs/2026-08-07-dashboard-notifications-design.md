# Notifikasi pindah ke dashboard: Telegram dihapus, event jadi turunan

Tanggal: 2026-08-07

Menggantikan: [2026-08-03-telegram-notifications-design](2026-08-03-telegram-notifications-design.md)
dan [2026-08-03-per-product-notifications-design](2026-08-03-per-product-notifications-design.md).

## Masalah

Notifier yang ada bekerja, dan bekerjanya lewat Telegram. Itu membawa serta bot
token, chat id, batas 20 pesan per menit, `retry_after`, penanganan chat id yang
ditolak, anggaran fungsi 60 detik yang membatasi satu run ke 10 pesan
per-produk, dan sebuah LaunchAgent yang menembak endpoint tiap 30 menit. Semua
itu ada untuk mengurus *pengiriman*, bukan untuk mengurus *apa yang layak
dilaporkan*.

Yang diminta sekarang: notifikasi hidup di dashboard, Telegram dihapus total.

Dan satu penyempitan yang mengubah nilainya: yang dilaporkan bukan lagi setiap
perubahan di seluruh katalog, melainkan **gerakan harga rival pada set yang
i-bricks jual**. Itu satu-satunya golongan kejadian yang menuntut keputusan
harga.

## Keputusan yang sudah dipatok

| | |
|---|---|
| Cakupan | Listing rival (`stores.is_own = false`) yang `set_code`-nya dijual toko `is_own` |
| Toko sendiri | `i_bricks` (Shopee, id 25), `i-bricks` (Tokopedia, id 164) |
| Pemicu | Gerak absolut ≥ 5% |
| Pembanding | Snapshot terbaru yang setidaknya 24 jam lebih tua |
| Status baca | Satu penanda global, tanpa status per item. Tab Baru menahan satu gerakan sampai sudah dibaca **dan** lewat sehari |
| Kanal | Halaman dashboard. Telegram dihapus seluruhnya |
| Database | **Neon**, yang dibaca deployment Vercel |

Volume terukur di database **lokal**: 1.279 set yang kita jual, 2.968 listing
sendiri, 4.285 listing rival di set itu. Pada hari tersibuk 3 Agustus ada 85
perubahan harga rival, 57 di antaranya ≥5%, dan **2** yang benar-benar menyalip
harga kita.

Angka-angka itulah yang dipakai saat memutuskan ambang 5%. Halaman ini membaca
**Neon**, yang isinya berbeda: 4.349 listing rival, dan 57 event memenuhi syarat
melawan 56 di lokal. Setiap angka di dokumen ini menyebut database asalnya.

Angka terakhir itu ditawarkan sebagai pemicu alternatif dan ditolak: yang
dipakai ≥5%. Konsekuensinya diterima sadar — puluhan item di hari sibuk, bukan
dua.

## Data membantah rancangan pertama, lima kali

Rancangan pertama menyimpan penanda "sudah kulihat sampai id ini", memakainya
untuk menyaring daftar, dan menyeed-nya dari `notify_watermark`. Semuanya
diukur, dan semuanya salah.

### 1. Halaman pengganti akan tampil kosong di hari pertama

`notify_watermark.last_snapshot_id` lokal bernilai **22154**, yang persis sama
dengan `max(price_snapshots.id)` — watermark memang maju ke ceiling di setiap
run notifier, termasuk run yang tidak mengirim apa-apa. Id event tertinggi yang
memenuhi syarat adalah **22089**.

Setiap satu dari 56 event berada di bawah seed. Menyeed `notify_seen` dari
watermark berarti nol yang belum dibaca: Telegram dihapus, penggantinya
menampilkan halaman kosong.

Di Neon kebalikannya — watermark 22076 melawan `max(id)` 26320, tertinggal
4.244 snapshot. Seed yang sama berarti dua hal yang sama sekali berbeda
tergantung database mana yang dibaca.

### 2. "Tandai terbaca sampai id tertinggi yang ditampilkan" menghancurkan baris

Aturan itu ditulis untuk mencegah baris yang masuk saat halaman terbuka ikut
tertandai terbaca. Aturan itu memang mencegahnya, dan memperkenalkan kegagalan
yang jauh lebih buruk.

Diukur: dari 56 event, ambil 20 teratas menurut persentase. Id tertinggi yang
ditampilkan adalah 22089, dan **seluruh 36 sisanya ber-id di bawah 22089** —
bukan sebagian, semuanya. Memajukan penanda ke sana menandai ketiga puluh enam
baris itu terbaca tanpa pernah dirender. Penanda hanya maju dan tidak ada status
per item, jadi baris itu tidak bisa dipulihkan tanpa SQL manual.

Mengurut ulang jadi newest-first memberi id maksimum yang sama. Jadi ini bukan
keanehan urutan besaran: **pembatasan apa pun atas urutan apa pun selain id
akan menelantarkan baris**, karena "yang ditampilkan" bukan awalan dari urutan
id.

### 3. Rancangan tidak pernah menyebut apakah penanda menyaring

Tiga pernyataannya — query hidup tanpa tabel, seed supaya tidak banjir, dan
tandai semua terbaca saat dibuka — hanya konsisten kalau penanda menyaring
query. Dan kalau menyaring, sekali dibuka daftarnya kosong permanen dan tidak
pernah bisa dibaca dua kali. Kalau tidak menyaring, seed-nya sia-sia.

Yang digantikan, Telegram, adalah scrollback permanen yang bisa dicari. Halaman
dengan satu penanda global, tanpa status per item dan tanpa riwayat, lebih
buruk daripada yang digantikannya: satu lirikan di HP menghapus daftar kerja 56
item yang setelah itu tidak ada di mana pun.

### 4. Migrasi 006 versi pertama gagal di percobaan pertama, dan tidak bisa diulang

Referensi statik ke relasi yang hilang gagal saat **parse**, bukan saat
evaluasi — `COALESCE` tidak menolongnya:

```
SELECT COALESCE((SELECT last_snapshot_id FROM nope_watermark WHERE id=1), 0);
ERROR:  relation "nope_watermark" does not exist
```

`scraper/db.py:438` mengirim tiap berkas migrasi sebagai satu `exec_driver_sql`
di dalam satu `engine.begin()`, jadi error itu membatalkan seluruh 006.
`notify_seen` tidak pernah dibuat dan `initdb` keluar dengan status bukan nol.

Tidak ada ledger migrasi — header 005 sendiri menyatakan menjalankan ulang
*adalah* jalur pemulihannya — dan kedua runner mengeksekusi ulang seluruh
direktori tiap kali. Karena 005 berisi `CREATE TABLE IF NOT EXISTS` + `INSERT`,
menjalankannya lagi setelah 006 akan **menghidupkan kembali tabel yang baru
dihapus**.

Bentuk berpenjaga terbukti aman, karena cabang yang tidak diambil tidak pernah
di-plan:

```
DO $$ DECLARE seed bigint; BEGIN
  IF to_regclass('public.nope_watermark') IS NOT NULL THEN
    SELECT last_snapshot_id INTO seed FROM nope_watermark WHERE id=1;
  END IF;
  RAISE NOTICE 'seed=%', COALESCE(seed,-1);
END $$;
NOTICE:  seed=-1
```

### 5. `sync` berhenti mengurus penanda tanpa mengeluh

`reseed_watermark` di `scraper/sync.py:309` memeriksa `information_schema` untuk
string harfiah `notify_watermark` dan mengembalikan `None` saat tabelnya tidak
ada. `cli.py:1543` lalu mencetak pesan yang menenangkan.

Setelah 006 menghapus tabelnya, **setiap `ecom-scraper sync` mengambil cabang
itu dan tidak pernah menyentuh `notify_seen`**. Ini bukan hipotesis: lokal
memegang 22.121 snapshot dengan `max(id)` 22.154, Neon 26.287 dengan `max(id)`
26.320. `mirror()` melakukan TRUNCATE lalu menyalin id apa adanya, jadi
mirroring lokal ke Neon menghapus 4.166 baris dan menjatuhkan `max(id)` target
ke **bawah** penanda yang diseed dari riwayat Neon sendiri. Halaman merender nol
baris selamanya, tanpa error dan tanpa baris log.

`notify_watermark` juga ada di `OWNED_BY_TARGET` (`sync.py:76`).

### Bonus: pilihan 24 jam tidak berpengaruh apa pun

Query dijalankan pada 1, 6, 12, 24, 48 dan 72 jam dan mengembalikan **56 baris
yang identik**. Baru berubah di 96 jam (55).

Yang mengikat bukan lantai jaraknya, melainkan jarak scraping. Di 56 baris yang
ada, snapshot pembanding yang terpilih berumur **78 jam paling muda, 123 jam
rata-rata, 140 jam maksimum**.

Karena LATERAL mengambil "terbaru yang setidaknya N jam lebih tua" **tanpa batas
atas**, yang sebenarnya dilaporkan halaman adalah "bergerak 5% sejak kapan pun
terakhir kami melihat listing ini" — bisa enam hari, dan untuk rival yang jarang
di-scrape bisa jauh lebih lama.

## Rancangan

Notifikasi adalah **turunan penuh** dari `price_snapshots`. Tidak ada tabel
event. Satu-satunya state yang disimpan adalah batas "sudah kulihat sampai
mana", dan batas itu **tidak menyaring apa pun**.

```
price_snapshots ──┐
products ─────────┼──> rivalMoves({gapHours, threshold, windowDays,
stores (is_own) ──┘        maxLookbackDays, graceHours, limit, offset}) ──> /notifications
                                                                               │
notify_seen.last_seen_snapshot_id ──> gaya "baru" + separuh predikat tab Baru ──┘
```

### Penanda tidak menyaring

Halaman selalu merender jendela bergulir **14 hari** dari gerakan yang memenuhi
syarat. Penanda hanya memutuskan baris mana yang bergaya "baru".

Dua tab dari fungsi yang sama, predikat penanda sebagai parameter:

- **Semua** — jendela bergulir, penanda diabaikan. Ini yang jadi tampilan awal.
- **Baru** — `id > last_seen_snapshot_id` **ATAU**
  `scraped_at > now() - graceHours` (default 24 jam).

Tampilan awal sengaja **Semua**, supaya muat pertama membuktikan query-nya
bekerja alih-alih menampilkan halaman kosong yang tidak bisa dibedakan dari
kerusakan.

Ini sekaligus menyelesaikan tiga temuan pertama: tidak ada yang bisa disembunyikan
oleh penandaan terbaca, seed jadi tidak menentukan isi, dan riwayat yang hilang
bersama Telegram kembali dengan ongkos satu predikat yang tidak dipasang.

#### Masa tenggang sehari di tab Baru

Predikat tab Baru berbentuk **ATAU**, dan itu perbaikan atas cacat yang
dilaporkan pemakainya, bukan hiasan. Membuka halaman ini mem-POST penanda ke
ceiling jendela, jadi dengan `id > penanda` sebagai satu-satunya syarat **satu
kali refresh mengosongkan tab Baru**: gerakan yang cuma sempat terlihat tiga
detik hilang sebelum sempat dibaca.

Satu gerakan keluar dari tab Baru hanya kalau **dua-duanya** sudah terjadi:
sudah dibaca (penanda lewat) dan sudah lebih dari sehari.

Sehari itu dihitung dari `scraped_at`, bukan dari kolom "pertama kali terlihat"
per baris — kolom seperti itu tidak ada dan menambahkannya berarti menyimpan
satu baris per kejadian, di fitur yang seluruh bentuknya justru tidak menyimpan
apa pun. Substitusi itu sah selama urutan id dan urutan waktu sejalan, dan itu
diperiksa, bukan diasumsikan: **nol dari 28.287 snapshot di Neon punya
`scraped_at` lebih tua daripada pendahulu ber-id lebih kecil**. Karena sejalan,
tidak ada baris di atas penanda yang lebih tua daripada baris di bawahnya, jadi
kedua cabang ATAU itu bersarang — isi tab selalu satu runtun dalam urutan id,
baris keluar dari yang paling tua dulu, dan tidak ada yang kembali. Kalau suatu
saat ada backfill, impor, atau skew jam yang memasukkan snapshot ber-id besar
dengan `scraped_at` lama, **predikat inilah yang patah**.

`graceHours` adalah parameter `rivalMoves`, bukan interval yang dipaku di SQL —
sejajar dengan `gapHours`, `threshold`, `windowDays` dan `maxLookbackDays`. Ia
sengaja **tidak** ikut masuk `DEFAULT_WINDOW`: `rivalMovesCeiling` dan
`unreadRivalMoves` tidak boleh melihatnya.

**Lonceng tetap ketat `id > penanda`, dan itu keputusan.** Badge harus bisa
nol begitu halaman dibuka; badge yang baru mau padam sehari kemudian adalah
badge yang lama-lama tidak dilirik orang. Konsekuensinya: lonceng bisa
menunjukkan 0 sementara tab Baru masih berisi, dan baris di dalamnya muncul
tanpa label "baru". Dua-duanya benar, dan dua-duanya **wajib dikatakan di teks
halaman** supaya tidak terbaca sebagai kerusakan.

### Penanda maju ke hasil lengkap, bukan ke yang ditampilkan

Penanda hanya boleh maju ke `max(id)` dari **himpunan hasil lengkap jendela
berjalan** — query yang sama tanpa limit, tanpa paginasi, tanpa filter pengguna.
Karena jendela selalu dirender penuh terlepas dari status baca, tidak ada baris
yang bisa hilang karenanya.

Naiknya monoton lewat `GREATEST`, sehingga permintaan yang datang terlambat atau
bersamaan tidak bisa memundurkannya.

Saat dibaca, kalau `last_seen_snapshot_id > max(price_snapshots.id)` — yang
terjadi setelah mirror destruktif — perlakukan sebagai maksimum dan katakan di
halaman, bukan merender daftar kosong.

### Tanpa `DISTINCT ON`

Satu baris per snapshot yang memenuhi syarat, bukan satu baris per produk.

Dengan `DISTINCT ON (product_ref)` himpunan event bisa **menyusut**: di Neon
saat ini 57 event memenuhi syarat lintas seluruh snapshot, bentuk `DISTINCT ON`
mengembalikan 49, dan **8 sudah terkubur** oleh capture berikutnya yang tidak
berubah. `scraper/store.py` tetap menulis snapshot tak berubah begitu lewat
jendela dedupe, jadi scrape berikutnya membuat harga yang bergerak bukan lagi
yang terbaru dan pembanding 24 jamnya berhenti memenuhi syarat. Event yang belum
dibaca lenyap dari daftar **dan** dari badge, tanpa jejak.

Tanpa `DISTINCT ON`, himpunan event hanya bertambah dalam urutan id — dan
penanda berbasis id jadi punya dasar. Produk yang bergerak dua kali digabung di
UI, bukan di SQL.

### Batas atas pembanding

Parameter kedua, `maxLookbackDays`:

```sql
AND ps.scraped_at >= n.scraped_at - make_interval(days => ${maxLookbackDays})
```

Listing tanpa pendahulu di dalam jendela menghasilkan nol baris, bukan
perbandingan melawan riwayat purba. `older.scraped_at` diproyeksikan — barisnya
sudah benar, cuma belum diambil — dan tiap baris menyebut jendela sebenarnya:
"−11% vs 5 hari lalu".

### Batas kesegaran dan paginasi

`AND n.scraped_at > now() - interval '14 days'` pada CTE `newest`, plus `LIMIT`
dan paginasi. Yang ada sekarang berasal dari sebagian kecil cakupan: 4.349
listing rival di dalam set kita (Neon; lokal 4.285), dan baru sebagian kecil
yang punya pembanding cukup tua. Begitu sapuan harian mencakup katalog, keadaan
tunaknya ratusan baris dan terus tumbuh.

Predikat yang sama juga yang menjaga performanya.

Urutan: yang **menyalip harga kita** dulu, lalu besaran gerak. Bukan urutan id.

### Skema

`migrations/006_notify_seen.sql`, lima hal yang wajib bersamaan:

1. `CREATE TABLE IF NOT EXISTS notify_seen` **lebih dulu** — singleton
   (`CHECK id = 1`), satu kolom `last_seen_snapshot_id bigint NOT NULL`, plus
   `updated_at`.
2. Seed di dalam `DO $$ ... $$` berpenjaga `to_regclass`, tiga arm dalam urutan
   ini: `notify_watermark.last_snapshot_id` → `max(price_snapshots.id)` → `0`.
   Arm kedua wajib ada; `COALESCE` dua arm ke 0 akan mengumumkan seluruh riwayat
   pada database yang belum pernah kena 005.
3. `ON CONFLICT (id) DO NOTHING`, tidak pernah `DO UPDATE`, supaya menjalankan
   ulang tidak memundurkan maupun melompatkan penanda.
4. `migrations/005_notify_watermark.sql` digunting jadi nisan komentar **di
   commit yang sama**. Tanpa itu tiap `initdb` dan tiap `beforeAll` vitest
   membuat ulang tabel yang baru dihapus, sambil mengambil `ACCESS EXCLUSIVE`
   melawan Neon lewat jaringan.
5. `DROP TABLE notify_watermark` **ditunda ke 007**, setelah seed di kedua
   database terbukti benar. Drop itu membawa serta `last_product_id`,
   `last_store_id` dan `last_stale_warning_at`, dan tidak menyisakan apa pun
   untuk menyeed ulang kalau seed-nya meleset.

### `sync` harus ikut pindah di perubahan yang sama

Port `reseed_watermark` ke `notify_seen` (atau tambah `reseed_seen`), panggil
dari tempat yang sama di `cli.py`, ganti `notify_watermark` dengan `notify_seen`
di `OWNED_BY_TARGET`, dan arahkan ulang `tests/test_sync.py:274-308` alih-alih
menghapusnya.

Ini tidak boleh menyusul. Begitu `notify_watermark` hilang, `sync` berhenti
mengurus penanda sambil mencetak pesan sukses.

### UI

- `dashboard/src/app/(app)/notifications/page.tsx`, `export const dynamic =
  'force-dynamic'`.
- `dashboard/src/components/NotificationsList.tsx` — komponen klien; POST penanda
  sekali setelah paint, bukan sebagai efek samping render atau GET.
- Lonceng dan badge di `dashboard/src/components/shell/AppShell.tsx`, bukan di
  `layout.tsx`. `prefetch={false}` pada tautan lonceng, supaya prefetch viewport
  tidak mengosongkan antrean.
- `layout.tsx` mengoper jumlah belum dibaca ke `AppShell`. Layout ini jalan di
  **setiap** halaman yang sudah login, jadi query hitungannya harus yang murah
  dan berbatas, bukan feed penuh.
- Pengelompokan per set dan pengurutan pindah ke `lib/notify/group.ts`
  (`foldPriceChanges` + `FOLD_MIN_GROUP` dari `format.ts`, diketik ulang ke
  `RivalMove`). Itu pengelompokan tabel, bukan perakitan pesan.

## Manifest

63 entri, sudah diverifikasi terhadap importir sebenarnya.

**BUAT (10)** — `migrations/006_notify_seen.sql`; di `dashboard/src/lib/notify/`:
`rival-moves.ts`, `seen.ts`, `group.ts` dan ketiga tesnya;
`app/api/notifications/seen/route.ts`; `app/(app)/notifications/page.tsx`;
`components/NotificationsList.tsx`.

**HAPUS (18)** — `notify/{telegram,run,watermark,events,format}.ts` dan tesnya;
`app/api/notify/`; `scraper/notify_trigger.py`; `tests/test_notify_trigger.py`;
`scripts/notify.sh`; `~/Library/LaunchAgents/com.ecomscraper.notify.plist`;
`logs/notify*.log`.

**SUNTING (24)** — termasuk `sync.py`, `cli.py`, `ingest.py` (delapan titik),
`config.py`, `proxy.ts` (buang lookahead negatif `api/notify`), `db.ts` dan
`auth.ts` (dua komentar yang menyebut `notify_watermark` sebagai tabel kedua
yang ditulis app), `queries.ts` (tiga komentar), `channel-links.test.ts`
(tambahkan halaman baru ke daftar `FILES`, kalau tidak penjaga pelestarian kanal
diam-diam berhenti mencakupnya), empat berkas env, dan `README.md`.

**PERTAHANKAN, penting karena mudah salah hapus:**

- `dashboard/src/lib/price-change.ts` — punya **dua importir non-notify**
  (`queries.ts:9`, `products/page.tsx:9`). Menghapusnya mematahkan build.
- `dashboard/src/lib/notify/positions.ts` — nol Telegram, 28 ms untuk seluruh
  katalog, dan justru ini yang memasok sinyal "rival sekarang lebih murah dari
  kita". Hanya impor tipe `Sql`-nya yang perlu dipindah.
- `scripts/daily_scrape.py` — bukan bagian perubahan ini.

Tipe `Sql` diekspor dari `watermark.ts:22` dan diimpor `positions.ts:3`. **Harus
dipindahkan sebelum `watermark.ts` dihapus**, kalau tidak `positions.ts` berhenti
kompilasi.

## Urutan kerja

Langkah tak terpulihkan ditandai.

1. Hentikan **dua** pemicu Telegram yang hidup, sebelum satu berkas pun dihapus.
   `launchctl bootout gui/$(id -u)/com.ecomscraper.notify` dulu — menghapus
   `notify.sh` saat agent masih termuat akan mencatat error bash tiap 30 menit.
   Lalu kosongkan `NOTIFY_URL` dan `NOTIFY_SECRET` di `.env` dan restart ingest:
   server ingest adalah pemicu kedua yang **berdiri sendiri** dan selamat dari
   agent yang di-bootout.
2. **[TAK TERPULIHKAN]** Cabut bot token lewat @BotFather `/revoke`. Menghapus
   barisnya di `.env.local` tidak menonaktifkan botnya.
3. Bangun jalur baca baru **di samping yang lama yang masih utuh**, supaya
   keduanya bisa dibandingkan di data nyata. Belum menghapus apa pun.
4. Terapkan 006 ke **kedua** database terpisah dan periksa seed masing-masing
   dengan tangan. Lokal: watermark 22154 melawan id event tertinggi 22089 —
   **nol belum dibaca adalah hasil yang diperkirakan, bukan bug**. Neon: 22076
   melawan `max(id)` 26320.
5. Port `reseed_watermark` ke `notify_seen`. Bersamaan dengan 006, bukan
   sesudahnya.
6. Baru sekarang hapus pohon notify di dashboard. Pindahkan tipe `Sql` lebih
   dulu.
7. Hapus jalur push Python: `notify_trigger.py`, lalu delapan titik di
   `ingest.py` (yang terlewat jadi `ImportError` saat ingest-server boot), lalu
   `config.py`, lalu `cli.py:967-979` yang membaca `app.state.notify_triggers`
   yang baru saja berhenti diterbitkan.
8. **[TAK TERPULIHKAN]** Hapus `scripts/notify.sh`, plist-nya, dan log-nya.
9. **[TAK TERPULIHKAN]** `vercel env rm` untuk `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_CHAT_ID`, `NOTIFY_SECRET` di proyek Vercel. Di luar repo; sapuan
   berkas tidak akan menemukannya.
10. Rebuild dashboard dan restart agent-nya — `scripts/dashboard-server.sh`
    menyajikan bundel yang sudah dibangun, jadi `/api/notify` tetap menjawab
    sampai rebuild mendarat.
11. Perbarui `README.md` dan beri header "digantikan oleh" pada empat dokumen
    lama, bukan menghapusnya.

## Risiko yang diterima secara sadar

Dicatat di sini karena keduanya keputusan sadar, bukan kelalaian.

**Halaman membaca Neon, dan mirror ke Neon tidak terjadwal.** `sync` adalah
mirror destruktif dan tidak ada cron maupun LaunchAgent yang menjalankannya.
Tampilan yang dibaca dari HP bisa membeku tanpa pemberitahuan sementara laptop
tetap segar. Saat ini keduanya memang sudah berbeda: 26.287 snapshot melawan
22.121, 49 event melawan 56.

**Peringatan data mandek dihapus tanpa pengganti.** `run.ts` sekarang mengirim
peringatan kalau database tidak bergerak lebih dari 36 jam, dan
`last_stale_warning_at` lokal menunjukkan peringatan itu menyala 5 Agustus 2026
untuk alasan nyata. Setelah perubahan ini, "tidak ada rival yang mengubah
harga", "scraper berhenti", "laptop tertidur" dan "mirror Neon berhenti" semuanya
tampil sebagai halaman yang sama.

Kegagalannya menyembunyikan diri: scraper mati menghasilkan halaman sepi, dan
halaman sepi terlihat seperti kabar baik. Menambahkan baris "Data terakhir:
<waktu>" nanti biayanya satu query yang sudah ada (`latestScrapedAt`).

## Tes

Yang wajib ada, karena masing-masing menangkap satu kegagalan yang sudah
terbukti:

- **Penanda maju ke hasil lengkap, bukan ke yang ditampilkan.** Dengan limit
  lebih kecil dari hasil, tidak ada baris yang boleh tertandai terbaca tanpa
  dirender. Ini yang menangkapnya kalau nanti ada yang "menyederhanakan".
- **Batas ambang tepat 5%** dan **jarak tepat 24 jam**, kedua sisinya.
- **Empat kombinasi tab Baru**, satu kasus masing-masing, karena intinya justru
  syarat DAN itu: belum dibaca + segar → masuk; belum dibaca + basi → masuk;
  sudah dibaca + segar → **masuk** (ini yang dulu gagal); sudah dibaca + basi →
  tidak masuk. Plus batas tepat di `graceHours`, dan bukti `unreadRivalMoves`
  masih menghitung ketat lewat penanda.
- **Pembagi nol** — `ingest.py` bisa memasok harga 0.
- **Id tidak berurutan** — `scraped_at` datang tidak terurut di database ini.
- **Penanda di atas `max(id)`** — keadaan setelah mirror destruktif; harus
  di-clamp dan dikatakan, bukan merender kosong.
- **`GREATEST` monoton** — dua POST bersamaan tidak boleh memundurkan penanda.
- **Baris hilang tanpa `DISTINCT ON`** — satu produk yang bergerak lalu
  di-capture ulang tanpa perubahan harus tetap muncul.
- **Migrasi idempoten** — jalankan seluruh direktori dua kali; 006 harus lolos
  di lintasan kedua.
- **Seed pada database tanpa 005** — arm `max(price_snapshots.id)` terpakai.

Dan satu yang harus dihapus, bukan diselamatkan: `route.test.ts` menegaskan
`maxDuration === FUNCTION_BUDGET_SECONDS`, yang menjadi `expect(60).toBe(60)`
kalau dipindahkan. Dua negatif `marks == 0` di `tests/test_ingest.py:261-363`
juga terus lolos sambil tidak menegaskan apa pun — hapus seluruh bagiannya.
