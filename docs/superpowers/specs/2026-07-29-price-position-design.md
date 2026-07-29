# Posisi harga: membandingkan katalog sendiri dengan kompetitor

Tanggal: 2026-07-29

## Masalah

Scraper sudah bisa mengambil katalog penuh satu toko. Yang belum ada: cara
menjawab "produk mana milikku yang harganya kalah, dan kalah berapa". Halaman
`/compare` yang ada menjawab pertanyaan lain — sebaran harga antar toko untuk
satu kata kunci — dan tidak mengenal konsep "toko saya".

Data yang akan masuk: ~1600 produk dari toko Shopee `i_bricks` (LEGO), plus
katalog beberapa toko kompetitor.

## Keputusan

### Pencocokan bertumpu pada nomor set, nama sebagai cadangan

Nama produk LEGO hampir selalu memuat nomor set 4–7 digit. Dua produk dengan
nomor set sama adalah barang yang sama persis, apa pun kata di sekitarnya —
presisi yang tidak bisa didekati oleh kemiripan teks. Kemiripan teks justru
paling rapuh di kasus terpenting: `42217` dan `42218` beda satu digit tetapi
barangnya berbeda, sedangkan `similarity()` menilainya 0.86.

Produk tanpa nomor set (aksesori, bundle, KW) dicocokkan dengan `pg_trgm` pada
ambang 0.45, dan barisnya **ditandai berbeda di UI**. Tanpa penanda itu, satu
salah-cocok merusak kepercayaan pada seluruh tabel.

### Nomor set diekstrak saat ingest, bukan saat query

Kolom `products.set_code text` diisi oleh `scraper/set_code.py`. Aturannya penuh
perkecualian dan akan disetel berkali-kali; itu butuh unit test, dan unit test
ada di Python, bukan di regex dalam sebuah view. Menghitung ulang 1600 nama tiap
request juga membayar ongkos yang sama berulang untuk jawaban yang tidak berubah.

Jebakan yang harus ditangani aturannya:

| nama | hasil | alasan |
|---|---|---|
| `LEGO Technic 42218 John Deere 9RX` | `42218` | |
| `1000Pcs Mainan Balok Minicraft` | – | satuan `pcs` |
| `LEGO City 60486 EV Supercar (109 Pieces)` | `60486` | `109` ditolak: `pieces` |
| `Lego Duplo 10451 3in1 usia 2-5 tahun` | `10451` | `3`, `2`, `5` terlalu pendek |
| `LEGO 71052 Series 29 (8 Pieces)` | `71052` | `29`, `8` terlalu pendek |

Aturan: deretan digit 4–7 yang berdiri sendiri; ditolak bila bersebelahan dengan
satuan (`pcs`, `pieces`, `buah`, `cm`, `mm`, `gr`, `ml`, `rb`) atau didahului
`rp`; bila tersisa lebih dari satu kandidat, yang 5 digit menang, karena set LEGO
modern hampir selalu 5 digit.

Perintah `ecom-scraper backfill-set-codes` menghitung ulang seluruh tabel supaya
aturan bisa disetel tanpa scrape ulang.

### Toko sendiri ditandai di database

Kolom `stores.is_own boolean NOT NULL DEFAULT false`, diisi lewat
`ecom-scraper own-shop shopee i_bricks`. Sebagai env var, dashboard dan scraper
punya dua sumber kebenaran yang bisa berbeda diam-diam; satu kolom tidak bisa.

### Perbandingan lintas marketplace

Set 42218 di Tokopedia tetap dihitung sebagai lawan produk Shopee, karena pembeli
membandingkan lintas platform. Kolom toko menyebutkan marketplace-nya dan ada
saringan per marketplace.

### Kompetitor masuk lewat scrape katalog toko

Daftar toko saingan di-scrape satu per satu dengan mode toko yang sudah ada.
Pencocokan terjadi di database, bukan saat scrape, jadi biaya scraping tetap dan
tidak tumbuh seiring jumlah produk sendiri. Tidak ada kode baru untuk ini.
Menyimpan daftar toko di database baru berguna kalau ada penjadwalan otomatis —
belum ada, jadi belum dibangun.

## Bentuk data

```sql
ALTER TABLE products ADD COLUMN set_code text;
CREATE INDEX ix_products_set_code ON products (set_code) WHERE set_code IS NOT NULL;

ALTER TABLE stores ADD COLUMN is_own boolean NOT NULL DEFAULT false;
CREATE INDEX ix_stores_is_own ON stores (is_own) WHERE is_own;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX ix_products_name_trgm ON products USING gin (name gin_trgm_ops);
```

Perbandingan dihitung satu query, tanpa tabel turunan: snapshot terbaru tiap
produk lewat `LATERAL` (indeks `(product_ref, scraped_at DESC)` sudah ada), lalu
produk bernomor set sama milik toko `is_own = false`. Skala 1600 × beberapa ribu
baris dengan indeks di `set_code` adalah query milidetik; materialized view
menunggu sampai terbukti lambat.

## Layar

Rute `/pricing`, label nav "Posisi harga". `/compare` tetap seperti sekarang.

Tabel utama, satu baris per produk sendiri:

```
Produk                          Set     Harga saya   Termurah lawan       Posisi   Δ
LEGO Technic 42218 John Deere   42218   Rp1.245.000  Rp1.089.000          4/4    +14,3%
                                                     brickstore.id · Shopee
Bundle Baseplate 3pcs           ~nama   Rp  145.000  Rp  132.000          3/3     +9,8%
                                                     toko-brick-jkt · Tokopedia
```

`~nama` menandai baris yang cocok lewat kemiripan, bukan nomor set.

Saringan: hanya yang kemahalan, minimal N lawan, marketplace, jenis pencocokan.
Urutan: Δ% dua arah, posisi, jumlah lawan, harga. Semua lewat URL seperti halaman
produk yang sudah ada, jadi halaman tetap Server Component dan bisa di-bookmark.

Detail `/pricing/[id]`: produk sendiri di atas, semua lawan di bawah dengan
harga, toko, terjual, rating, selisih. Grafik riwayat muncul bila produk punya
lebih dari satu snapshot.

Tiga keadaan kosong yang akan sering muncul di awal dan harus ditangani
tersendiri: belum ada toko `is_own`, produk sendiri tanpa lawan sama sekali, dan
produk tanpa nomor set.

## Scraper

Dua perubahan, syarat untuk run 1600 produk:

**Plafon halaman jadi turunan target.** `MAX_PAGES = 30` yang tetap memotong run
besar diam-diam: 30 halaman × ~30 kartu berhenti di ~900 produk dan popup
melaporkannya sebagai sukses. Ganti dengan
`Math.min(200, Math.max(30, Math.ceil(target / 20)))`; pagar 200 menjaga agar
kondisi berhenti yang rusak tidak menjadi crawl tanpa batas.

**Job bertahan hidup.** Job hanya ada di memori service worker, dan MV3 bisa
membunuhnya. Simpan `{template, page, unique, seen}` ke `chrome.storage.local`
tiap halaman; saat worker bangun, tawarkan lanjut dari halaman terakhir.

## Pengujian

Ekstraksi nomor set diuji atas nama produk asli, termasuk yang menjebak:
`1000Pcs`, `(109 Pieces)`, `Series 29`, `usia 2-5`, dan nama tanpa nomor. Ini
bagian yang paling mungkin salah dan paling mahal bila salah — kesalahan
ekstraksi tidak hanya menyembunyikan lawan, tapi bisa mencocokkan produk ke
barang yang sama sekali lain.

Query pencocokan diuji atas database berisi pasangan yang sengaja dibuat: set
sama beda toko, set sama toko sendiri (harus dikecualikan), nama mirip tanpa set,
dan produk tanpa lawan.
