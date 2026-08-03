# Dua toko sendiri: satu kanal aktif, bukan satu kolam

Tanggal: 2026-07-30

## Masalah

Toko sendiri sekarang ada dua: `i_bricks` di Shopee (1.516 listing) dan
`i-bricks` di Tokopedia (1.452 listing). Keduanya sudah ditandai `is_own` dan
keduanya berharga lengkap. Yang belum ada: dimensi kanal di angka-angkanya.

Ringkasan, Posisi harga dan Analitik semuanya mengambil "milik kita" lewat
`JOIN stores s ON s.id = p.shop_ref AND s.is_own` tanpa menyebut marketplace,
jadi dua toko dilebur menjadi satu kolam. Akibatnya tiga hal:

1. **Tak ada satu angka pun yang menggambarkan satu toko.** Tidak ada cara
   menjawab "di Tokopedia kita sedang di mana", padahal itu pertanyaan yang
   menentukan harga di Tokopedia.

2. **Dobel-hitung.** 1.174 set kami terdaftar di kedua toko sekaligus (hanya 105
   yang di satu toko). Panel posisi menghitung *listing*, jadi satu set yang
   termurah di Shopee tetapi termahal di Tokopedia masuk dua bucket berbeda tanpa
   jejak bahwa itu barang yang sama. Uang di meja tertampil ~Rp 340,9jt padahal
   tak ada toko yang punya angka sebesar itu.

3. **Daftar "penekan harga" terbaca timpang.** Pemasangan menyeberang
   marketplace, dan Tokopedia menyumbang 6.170 pasangan hanya dari 5 toko rival
   sementara 25 toko rival Shopee menyumbang 2.662. Tanpa dimensi kanal, yang
   terlihat adalah kepadatan listing rival, bukan posisi kita.

Ringkasan sendiri tidak menyebut toko sendiri sama sekali — isinya total katalog
(32 toko, 12.502 produk). Halaman pertama yang dibuka tiap hari tak menjawab
"kita sedang di mana".

## Keputusan

### Satu kanal aktif, tanpa angka gabungan

Dashboard punya pemilih kanal: Shopee atau Tokopedia, satu aktif sekali waktu.
Tidak ada tampilan gabungan, tidak ada penjumlahan lintas kanal — jadi tidak ada
tempat bagi dobel-hitung untuk muncul kembali. Judul setiap layar yang berlingkup
kanal menyebut marketplace dan username tokonya, supaya tak pernah ambigu angka
itu milik siapa.

Alternatif yang ditolak: menggabung per set dengan dua kolom harga
("satu produk, dua harga"). Itu jawaban yang lebih kaya, tapi memaksa setiap
tabel dan setiap agregat punya bentuk baru; keputusan hariannya sendiri tetap
per kanal.

### Rival tetap lintas marketplace

Posisi dan gap dihitung lawan **seluruh** toko rival dari kedua marketplace,
seperti sekarang. Set 42218 di Tokopedia tetap lawan bagi listing Shopee kami,
karena pembeli membandingkan lintas platform — keputusan yang sama dengan spec
2026-07-29 dan tidak diubah di sini. Yang berlingkup kanal adalah sisi kami,
bukan sisi mereka.

Konsekuensi yang diterima sadar: listing Shopee bisa berstatus "termahal" karena
penjual Tokopedia lebih murah. Kolom marketplace pada daftar rival yang
menjelaskannya, dan itu justru informasi yang dicari.

### Pemilih kanal hanya mengunci layar yang relatif ke kita

| Ikut kanal aktif | Tidak ikut |
|---|---|
| Ringkasan, Posisi harga, Analitik | Produk, Toko |

Produk dan Toko adalah layar riset pasar, bukan penilaian diri; keduanya tetap
katalog penuh 32 toko dengan saringan marketplace masing-masing. Mengunci
keduanya ke kanal aktif akan menghapus satu-satunya cara melihat seluruh pasar
dalam satu layar — padahal pasar penuh itulah dasar peringkat kami.

### Kanal hidup di URL

`?kanal=shopee` | `?kanal=tokopedia`, mengikuti pola yang sudah dipakai semua
saringan di app ini: link bisa dibagikan dan di-bookmark persis seperti yang
dilihat, reload tidak mengubah apa pun, dan Back mengembalikan kanal sebelumnya.
Halaman tetap Server Component; tidak ada state klien baru.

Harganya: setiap tautan navigasi harus membawa parameter itu, atau kanal
diam-diam kembali ke default saat pindah halaman. Satu helper di `AppShell` yang
menempelkannya, dipakai oleh rail, drawer, dan tautan silang antar layar.

Cookie ditolak: link yang dibagikan akan menampilkan kanal milik penerima, dan
Back tidak mengembalikan kanal sebelumnya.

### Definisi "milik kita" hidup di satu fragmen

`ourProducts` yang sekarang fragmen statis (`queries.ts:305`) menjadi pabrik
`ourListings(kanal)`. Setiap query yang bicara "kita" menerima kanal dan memakai
fragmen itu; tidak ada lagi fragmen tanpa-kanal untuk dipakai, jadi layar yang
ditambahkan nanti tidak bisa lupa memfilter.

Alternatif yang ditolak: menyisipkan `AND s.marketplace = …` di masing-masing
query. Aturan yang sama ditulis tiga kali, dan rapor Ringkasan akan menduplikasi
seluruh CTE pemasangan milik Analitik. Menyaring di TypeScript setelah query juga
ditolak: Analitik mengagregasi di SQL, jadi menyaring sesudahnya mustahil, dan
itu memindahkan aturan data ke UI.

### Pemasangan rival di-cache lima menit, dibagi Ringkasan dan Analitik

Rapor Ringkasan butuh pemasangan yang sama dengan Analitik, dan di Neon
pemasangan itu 2,9–3,3s. Tanpa cache, halaman pertama yang dibuka tiap kali
menjadi yang paling lambat.

Satu fungsi ter-cache, `getPairingSnapshot(kanal)`, mengembalikan seluruh
agregat yang lahir dari pemasangan: sebaran posisi, uang di meja, tabel penekan
harga, band harga, gap vs volume. Rapor Ringkasan adalah subset dari objek itu,
Analitik memakai sisanya — satu perhitungan, dua layar, dan keduanya tidak bisa
berselisih karena berasal dari nilai yang sama.

`unstable_cache` dengan kunci `['pairing', kanal]` dan `revalidate: 300`.
Snapshot hanya berubah saat scrape dijalankan, jadi data lima menit basi adalah
data yang sama; kunjungan pertama membayar ~3s, sisanya instan.

Posisi harga **tidak** ter-cache: hasilnya bergantung pada saringan dan halaman,
jadi kuncinya akan berbeda hampir setiap permintaan dan cache-nya hanya
menumpuk. Halaman itu tetap membayar pemasangannya sendiri, seperti sekarang.

Bukan `use cache`: itu menuntut `cacheComponents: true`, yang menjadikan PPR
perilaku default dan memaksa migrasi `force-dynamic` di seluruh route — blast
radius yang tidak sepadan untuk fitur ini. Lihat "Utang teknis".

Materialized view di Postgres ditolak untuk sekarang: lebih cepat dan selalu
sinkron, tapi menambah migrasi dan membuat sisi Python ikut bertanggung jawab
me-refresh — mengaburkan batas antara scraper dan dashboard yang sekarang rapi.

## Bentuk data

```ts
// src/lib/channel.ts (baru)
export type Channel = Marketplace;

/** Kanal aktif dari URL, jatuh ke toko sendiri pertama menurut abjad marketplace. */
export function resolveChannel(raw: string | undefined, shops: OwnShop[]): Channel | null;

/** Menempelkan ?kanal= ke sebuah href, dipakai semua tautan navigasi. */
export function withChannel(href: string, channel: Channel | null): string;
```

```ts
// src/lib/queries.ts
const ourListings = (channel: Channel) => sql`…AND s.marketplace = ${channel}`;

export async function getOwnShopScorecard(channel: Channel): Promise<OwnShopScorecard>;
export async function getPricingAnalytics(channel: Channel): Promise<PricingAnalytics>;
export async function getPricePositions(
  channel: Channel,
  filter: PricePositionFilter,
): Promise<Paged<PricePositionRow>>;
```

`scored` — jumlah rival, termurah, berapa yang mengalahkan, per listing kami —
sekarang hidup di dalam `getPricingAnalytics`. Ia diangkat menjadi fragmen
bersama supaya rapor Ringkasan tidak menulis ulang pemasangan yang sama.

```ts
type OwnShopScorecard = {
  channel: Channel;
  shopUsername: string;
  listings: number;
  withRivals: number;
  position: { cheapest: number; middle: number; dearest: number; unmatched: number };
  atStake: string;   // NUMERIC, tetap string sampai diformat
};
```

`atStake` memakai definisi yang sudah dipakai panel band hari ini — selisih ke
rival termurah dijumlahkan untuk listing yang kemahalan, tanpa menyaring gap
ekstrem. Angkanya jadi sebanding dengan yang sekarang; penyaringan gap ekstrem
adalah pertanyaan terpisah dan tidak dijawab di sini.

`PricePositionFilter` kehilangan field `marketplace`: artinya tumpang tindih
dengan pemilih kanal. URL lama yang masih membawa `?marketplace=` tetap membuka
halaman — `z.object` mengabaikan kunci yang tidak dikenalnya — jadi bookmark
tidak pecah, hanya kehilangan efek saringannya.

## Layar

**Ringkasan.** Rapor kanal aktif di atas, pasar sebagai konteks di bawah:

```
Ringkasan · Shopee · i_bricks

  1.516          930            394            Rp 170.870.071
  listing kita   punya rival    termurah       uang di meja

  Sebaran posisi   termurah 394 · tengah 252 · termahal 284 · tanpa rival 586

  ── Pasar ──────────────────────────────────────────────────────
  32 toko · 12.502 produk · 12.502 snapshot · terakhir 29 Jul 17:04
```

**Posisi harga.** `mine` disaring ke kanal aktif; saringan `marketplace` dihapus
dari halaman ini. Kolom marketplace pada daftar rival tetap, karena rival lintas
kanal. Saringan lain — stance, matched, extreme, minRivals — tidak berubah.

**Analitik.** Keempat panel berlingkup kanal aktif. Panel "siapa menekan harga
kita" tetap mengelompokkan per toko rival dengan lencana marketplace-nya; dari
kanal Shopee, itulah yang menunjukkan hitam-putih bahwa penekan terbesar adalah
penjual Tokopedia.

**Produk, Toko.** Tidak disentuh.

**Pengaturan.** Daftar "Toko sendiri" menandai mana yang sedang aktif. Copy
empty-state Analitik yang hanya menyebut perintah Shopee diperbaiki menjadi
kedua marketplace.

**Pemilih kanal.** Di topbar, menggantikan lencana toko yang sekarang hanya
memajang keduanya secara pasif. Dua toko → dua tombol, satu aktif. Satu toko →
label statis tanpa tombol. Nol toko → tidak dirender.

## Kasus tepi

| Keadaan | Perilaku |
|---|---|
| `?kanal=` tidak ada, atau nilainya ngawur | Toko sendiri pertama menurut abjad marketplace — dengan data sekarang berarti Shopee. Bukan error: URL yang diketik tangan tetap membuka halaman. |
| `?kanal=tokopedia` tapi toko itu sudah dilepas tandanya | Jatuh ke toko sendiri yang tersisa. Judul layar selalu menyebut kanal dan username, jadi pergeserannya terbaca tanpa notifikasi tambahan. |
| Hanya satu toko sendiri | Semua layar berlingkup ke toko itu; pemilih jadi label statis. |
| Nol toko sendiri | Empty state yang sudah ada, dengan perintah untuk kedua marketplace. Tidak ada query pemasangan yang dijalankan. |
| Toko sendiri ada tapi belum ada listing berharga | Rapor menampilkan nol dengan penjelasan, bukan crash atau angka kosong tanpa sebab. |
| Scrape baru selesai | Angka bisa tertinggal sampai lima menit. Tidak ada tombol refresh manual di lingkup ini. |
| Kanal diganti | Kunci cache memuat kanal, jadi tidak ada kemungkinan menampilkan angka kanal lain. |

## Pengujian

Terhadap Postgres nyata, mengikuti `queries.test.ts` yang sudah ada. Fixture
dasar: dua toko sendiri, satu set yang ada di keduanya, satu rival Shopee dan
satu rival Tokopedia dengan harga berbeda.

1. `ourListings` tidak pernah mengembalikan listing kanal lain — trap utama
   seluruh perubahan ini.
2. Satu set yang ada di dua toko sendiri dihitung **sekali** di rapor tiap kanal;
   tidak ada layar yang menampilkan jumlah keduanya.
3. Rival lintas kanal tetap terhitung: satu-satunya rival yang lebih murah ada di
   marketplace lain, dan ia harus muncul sebagai rival bagi kanal aktif.
4. Rapor Ringkasan dan panel posisi Analitik untuk kanal yang sama menghasilkan
   sebaran identik — keduanya berbagi `scored`, dan tes ini yang menjaganya.
5. `resolveChannel`: kosong, ngawur, kanal yang tokonya hilang, satu toko, nol
   toko.
6. `withChannel`: href tanpa query, href yang sudah punya query, kanal null.
7. Toko sendiri tanpa listing berharga → rapor nol, bukan exception.

Angka patokan untuk verifikasi setelah implementasi, dari data di Neon
per 2026-07-30:

| Kanal | Listing | Punya rival | Termurah | Tengah | Termahal | Tanpa rival | Uang di meja |
|---|---|---|---|---|---|---|---|
| shopee | 1.516 | 930 | 394 | 252 | 284 | 586 | Rp 170.870.071 |
| tokopedia | 1.452 | 890 | 385 | 232 | 273 | 562 | Rp 170.068.254 |

## Di luar lingkup

- Tampilan per set dengan dua harga berdampingan (alternatif yang ditolak di
  atas). Kalau nanti dibutuhkan, ia layar baru, bukan perubahan pada layar ini.
- Tren waktu. Masih belum ada snapshot cukup banyak per produk untuk digambar.
- Tombol refresh manual atau revalidasi cache setelah scrape.
- Menyaring gap ekstrem dari "uang di meja".
- Lebih dari dua toko sendiri. Desain ini tidak mengasumsikan dua, tapi juga
  tidak dites di luar dua.

## Utang teknis

`unstable_cache` ditandai "replaced by `use cache`" di dokumen Next 16. Migrasi
ke Cache Components adalah pekerjaan tersendiri: ia menyalakan PPR sebagai
default dan menyentuh setiap route segment config di app ini. Dicatat di sini
supaya pilihan ini terbaca sebagai keputusan berlingkup, bukan kelalaian.
