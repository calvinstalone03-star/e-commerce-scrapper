# Satu produk satu pesan, untuk barang yang kita jual juga

Tanggal: 2026-08-03

Lanjutan dari [notifikasi Telegram](2026-08-03-telegram-notifications-design.md).
Yang di sana tetap berlaku kecuali yang dinyatakan berbeda di sini.

## Masalah

Notifier yang ada mengirim satu digest terkelompok. Uji nyata pertamanya —
scrape ulang `lego.indonesia` setelah lima hari — menghasilkan **449 perubahan
harga dalam 3 pesan**. Secara teknis benar dan hemat, tapi tidak terbaca oleh
orang yang harus bertindak atasnya.

Admin toko membaca ini untuk satu keputusan: perlukah harga kita disesuaikan.
Digest 449 baris tidak menjawab itu. Ia menyerahkan penyaringan ke pembacanya,
di layar ponsel, di grup.

Permintaan awalnya "satu produk satu pesan". Diambil apa adanya itu **449 pesan**
— Telegram membatasi satu grup sekitar 20 pesan per menit, jadi ~23 menit
mengirim, dan tiap penolakan membawa jeda `retry_after` yang ditunggu di dalam
transaksi pemegang kunci watermark. Itu persis kemacetan yang batas 4 pesan
dibuat untuk mencegahnya.

Yang salah bukan formatnya, melainkan tidak adanya penyaring.

## Angka yang menentukan rancangan ini

Dari 449 perubahan pada scrape 2026-08-03 16:39:

| | |
|---|---|
| Total perubahan harga | 449 |
| Ada di set yang **kita jual juga** | **77** |
| Punya posisi yang layak dipercaya | 71 |
| Gap ekstrem — pembanding tidak sebanding | 6 |
| Tidak kita jual → tetap digest | 372 |

Penyaringnya bukan besarnya gerakan, melainkan **apakah barangnya kita jual**.
Rival menurunkan harga set yang tidak ada di rak kita bukan keputusan yang bisa
diambil siapapun; gerakan 1% di set yang kita jual bisa.

## Keputusan

### Dua aliran, bukan satu

**Perubahan di set yang kita jual → satu produk satu pesan.** Tiap pesan berdiri
sendiri: nama produk, harga lama → baru, persentase, posisi kita di set itu, dan
link ke halaman posisi harga.

**Sisanya → satu digest,** persis seperti sekarang. Set yang tidak kita jual
tetap layak diketahui, tapi sebagai gambaran pasar, bukan sebagai tugas.

Toko baru dan produk baru tidak berubah — keduanya tetap di digest.

### Penyaringnya keanggotaan set, bukan ambang persentase

Sebuah perubahan naik ke aliran per-produk kalau `products.set_code`-nya ada di
himpunan set yang toko `is_own` kita jual. Tidak ada ambang persentase.

Alternatif yang ditolak: ambang 5%, yang menyisakan 48 dari 77. Ia membuang
gerakan kecil di barang yang kita jual — dan gerakan kecil dari rival terdekat
justru yang paling sering menuntut respons, karena selisih Rp 5.000 di set yang
sama-sama kita jual mengubah siapa yang termurah.

Listing tanpa `set_code` — aksesoris, bundel, tiruan — tidak pernah masuk aliran
per-produk, karena tidak ada dasar untuk menyebutnya barang yang sama.

### Posisi kita ikut di tiap pesan, dihitung sekali untuk semua set

Yang membuat pesan per-produk berguna bukan harga rivalnya, melainkan **posisi
kita setelah rival bergerak**. Tanpa itu pembacanya harus membuka dashboard
untuk tiap pesan.

Satu query menghitung posisi untuk seluruh set yang kita jual sekaligus: 28 ms,
dibanding 9,5 ms × 77 kalau ditanyakan satu per satu. Ia mengembalikan harga
kita, harga rival termurah, dan jumlah rival per `set_code`.

### Gap ekstrem mengganti baris posisi, tidak membuang pesannya

`set_code` memuat barang yang tidak sebanding pada seri Minifigures. Contoh
nyata, set `8827`:

| Toko | Barang | Harga |
|---|---|---|
| i-bricks (kita) | Series 6 **box** — 60 bungkus tersegel | Rp 8.500.000 |
| brickzproject | "Complete 1 set" — 16 figur | Rp 2.999.000 |
| cupliss | **satu figur**, Lady Liberty | Rp 397.000 |

Ketiganya `set_code = 8827`. Baris posisi untuk ini akan berbunyi "kita lebih
mahal Rp 8,1 juta", yang bukan cuma salah tapi merusak kepercayaan pada 71 pesan
lain yang benar.

Dashboard sudah menanganinya: `queries.ts:285` menetapkan `EXTREME_GAP = 1.0`
dan menyembunyikan baris semacam ini secara default. Notifier memakai **konstanta
yang sama**, diekspor dari sana — bukan disalin, karena dua ambang dengan satu
nama adalah cara keduanya diam-diam berbeda pendapat.

Ketika gap ≥ ambang, pesannya **tetap dikirim** — rival memang mengubah harga,
itu fakta — tapi baris posisinya diganti keterangan bahwa pembandingnya tidak
sebanding, dengan link untuk memeriksa sendiri. Hari ini itu 6 dari 77.

### Ada batas, dan batasnya bisa diatur

`NOTIFY_PER_PRODUCT_MAX`, default **30**. Yang melebihi turun ke digest dengan
keterangan berapa yang tidak ditampilkan.

Angka 30 datang dari batas Telegram, bukan dari selera: pada ~20 pesan per menit,
30 pesan per-produk ditambah paling banyak 4 pesan digest adalah ~1,7 menit
mengirim, di dalam fungsi yang batas waktunya 300 detik. Marginnya nyaman.

Menaikkannya boleh dan didukung, tapi konsekuensinya harus terbaca: makin tinggi
angkanya makin lama transaksi memegang kunci watermark, dan melewati batas waktu
fungsi berarti transaksinya batal, watermark tidak maju, dan jalan berikutnya
menyusun antrean yang sama tapi lebih panjang. Itu kemacetan yang tidak keluar
sendiri.

Urutannya persentase terbesar dulu, jadi kalau batasnya menggigit, yang bertahan
adalah yang paling menuntut keputusan.

Angka 77 hari ini adalah kasus tumpukan — lima hari perubahan satu toko sekaligus.
Scrape harian menghasilkan volume jauh lebih kecil.

## Bentuk pesan

```
📉 LEGO Technic 42218 John Deere 1470H
lego.indonesia · Shopee

Rp 186.850 → Rp 150.100   (−19,7%)

Kita        Rp 165.000  (i_bricks)
Termurah    Rp 150.100  dari 4 toko
→ kita TERMAHAL, selisih Rp 14.900

[posisi kita di 42218]
```

Ketika gap ekstrem, tiga baris posisi diganti satu:

```
Pembanding tidak sebanding — set ini memuat
barang berbeda di bawah satu nomor.
[periksa di dashboard]
```

Escaping, pemecahan, dan aturan link mengikuti modul yang sudah ada. Pesan
per-produk selalu muat dalam satu pesan Telegram; tidak ada pemecahan di sini.

## Bentuk data

Tidak ada migrasi. Tidak ada kolom baru. Watermark tidak berubah bentuknya —
kedua aliran maju bersama dalam satu transaksi, sama seperti sekarang, karena
keduanya berasal dari kumpulan kejadian yang sama.

Satu perubahan di luar modul notifier: `EXTREME_GAP` di
`dashboard/src/lib/queries.ts:285` berubah dari `const` jadi `export const`.

## Kasus tepi

| Keadaan | Perilaku |
|---|---|
| Set kita jual, tapi kita tak punya harga tercatat | Baris posisi berbunyi "kita belum berharga di set ini" |
| Set kita jual, nol rival selain yang bergerak | Posisi tetap dihitung; "dari 1 toko" |
| `set_code` NULL | Tidak pernah masuk aliran per-produk |
| Lebih dari `NOTIFY_PER_PRODUCT_MAX` | Kelebihannya turun ke digest dengan jumlahnya disebut |
| Nol perubahan di set kita, ada perubahan lain | Nol pesan per-produk, digest seperti biasa |
| Nol kejadian sama sekali | Tidak mengirim apapun — tidak berubah dari sekarang |
| Telegram gagal di pesan per-produk ke-15 | Watermark tidak maju; seluruh 77 dikirim ulang di jalan berikutnya. Duplikat, bukan kehilangan — tidak berubah dari sekarang |

## Pengujian

Fungsi murni:

1. Pemilahan dua aliran: set kita jual naik ke per-produk, sisanya ke digest,
   `set_code` NULL selalu ke digest.
2. Perenderan per-produk: naik, turun, posisi termurah, posisi termahal, kita
   tanpa harga, dan gap ekstrem.
3. Escaping nama produk yang memuat `&`, `<`, `>` di jalur per-produk.
4. Batas: 40 perubahan dengan batas 30 → 30 pesan per-produk dan digest yang
   menyebut 10 sisanya; urutan persentase terbesar bertahan.

Terhadap database:

5. Query posisi mengembalikan harga kita, rival termurah, dan jumlah rival yang
   benar untuk set dengan dua toko sendiri, satu toko sendiri, dan nol.
6. Deteksi gap ekstrem memakai ambang yang sama dengan dashboard — impor
   `EXTREME_GAP`, bukan angka literal.

Patokan verifikasi terhadap data 2026-08-03, watermark snapshot 18830:

| Keluaran | Harus |
|---|---|
| Total perubahan harga | 449 |
| Naik ke aliran per-produk | 77 |
| Di antaranya, posisi layak dipercaya | 71 |
| Di antaranya, gap ekstrem | 6 |
| Turun ke digest | 372 |

## Di luar lingkup

- **Perintah di grup** (`/harga 42218`). Bot ini sekarang hanya mengirim;
  menerima perintah butuh webhook, route penerima, penguraian perintah, dan
  keputusan siapa yang berhak. Fitur tersendiri, dan query posisinya bisa dipakai
  ulang di sana.
- **Memperbaiki pemasangan `set_code` pada seri Minifigures.** Ia menyentuh
  seluruh dashboard posisi harga, bukan hanya notifikasi. Spec ini bekerja di
  sekitarnya lewat ambang yang sudah ada.
- **Ambang persentase.** Ditolak di atas, dengan alasannya.
- **Antrean kejadian yang tahan mati.** Akan membuat batas per-jalan tidak perlu,
  tapi ia menambah tabel dan siklus hidupnya sendiri. Batas plus tumpahan ke
  digest menyelesaikan masalah yang sama dengan cara yang jauh lebih kecil.
