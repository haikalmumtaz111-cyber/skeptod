# Laporan Uji Pipeline Render bpy (Suzanne Emas)

Tanggal: 25 November 2026
Script: `render_test.py` (commit `159f746` di branch `claude/modest-dijkstra-nkzuei`)
Video: [`render_test_assets/render_test.mp4`](render_test_assets/render_test.mp4)

## Ringkasan

Pipeline headless dari bpy ke PNG sequence lalu ke MP4 jalan sampai selesai. Videonya berdurasi 5,000 detik, isinya 120 frame di 24 fps dengan codec H.264 yuv420p. Cek durasi, jumlah frame, frame item, dan posisi Suzanne di dalam frame semuanya lolos.

Ada dua hal yang belum sesuai brief:

1. **Budget 10 menit terlewati.** Setting paling ringan yang diizinkan brief (960x540, 16 sampel) tetap butuh 827,2 detik untuk merender 120 frame, sekitar 13,8 menit.
2. **Rotasinya belum linear.** Bug ini baru ketahuan setelah video dikirim. Keyframe-nya keluar sebagai Bezier (ease in/out), jadi Suzanne melambat di awal dan akhir dan loop-nya tersendat di sambungan. Perbaikannya sudah masuk ke `render_test.py`, tapi videonya belum dirender ulang.

## Lingkungan

| Komponen | Nilai |
|---|---|
| Blender | Tidak ada binary `blender`. Dipakai modul `bpy` 5.3.0 dari pip |
| Python | 3.13.18 |
| CPU / RAM | 4 core, 15 GB, tanpa GPU |
| ffmpeg / ffprobe | Sudah terpasang di `/usr/bin`, jadi `imageio-ffmpeg` tidak perlu dipasang |
| Denoiser | OpenImageDenoise tersedia (`_cycles.with_openimagedenoise = True`) |
| Lain-lain | Pillow 13.0.0 dan numpy 2.5.3 dipakai untuk mengecek frame |

Sebelum ada brief, `bpy` sudah dicoba dengan render Cycles 200x200 dan 8 sampel. File PNG-nya tersimpan setelah 0,9 detik, jadi render headless sudah terbukti jalan sejak awal.

## Isi scene

| Elemen | Setting |
|---|---|
| Suzanne | `primitive_monkey_add`, posisi `(0, 0, 1)`, Subdivision level 2 untuk viewport dan render, shade smooth |
| Material emas | Principled, base `(1.0, 0.766, 0.336)`, metallic 1,0, roughness 0,22 |
| Lantai | Plane 400 m, base `(0.018, 0.018, 0.022)`, roughness 0,28 |
| Background | Gradasi biru tua menurut posisi vertikal di layar, dari `(0.020, 0.045, 0.120)` ke `(0.002, 0.005, 0.022)` di tepi atas. Hanya terlihat oleh camera ray. Pantulan dan pencahayaan memakai biru tua polos `(0.012, 0.025, 0.070)` |
| Key light | Area 900 W, warna hangat `(1.0, 0.82, 0.62)`, ukuran 3 m, di `(4.5, -4, 5)` |
| Fill light | Area 300 W, warna dingin `(0.62, 0.75, 1.0)`, ukuran 4 m, di `(-5, -3, 2.5)` |
| Rim light | Area 800 W, warna `(0.9, 0.95, 1.0)`, ukuran 2 m, di `(0.5, 5.5, 4)`, dari belakang |
| Animasi Suzanne | Rotasi Z 0° di frame 1 dan 360° di frame 121, supaya frame 121 sama dengan frame 1 |
| Kamera | Lensa 50 mm, anak dari empty `CamPivot` yang berputar −15° ke +15° (total 30°). Posisi lokalnya maju dari `(0, -10, 2.3)` ke `(0, -8.5, 2.1)`. Constraint Track To mengarah ke Suzanne |
| Render | Cycles CPU, OIDN aktif, 24 fps, frame 1 sampai 120, PNG RGB 8-bit, persistent data aktif |

## Cara kerja script

`render_test.py` membangun scene dari factory settings kosong, jadi hasilnya tidak tergantung file .blend. Urutannya:

1. **Cek framing.** Untuk tiap frame dari 1 sampai 120, semua vertex Suzanne hasil subdivision diproyeksikan ke kamera. Kalau ada satu yang keluar frame, script berhenti sebelum render.
2. **Pilih setting.** Script mencoba tiga tingkat berurutan: 1280x720 32 sampel, 960x540 32 sampel, lalu 960x540 16 sampel. Di tiap tingkat satu frame dirender dan waktunya dikali 120. Tingkat pertama yang estimasinya di bawah 600 detik langsung dipakai. Kalau semuanya lewat, dipakai tingkat terakhir. Pilihan ini dikunci di `settings.json` supaya resume tidak mencampur resolusi.
3. **Render per frame.** Frame yang file-nya sudah ada dilewati. Tiap frame ditulis dulu ke `.partial`, baru di-rename setelah selesai, sehingga render yang terputus tidak meninggalkan file setengah jadi yang lalu dianggap selesai. Waktu tiap frame dicatat ke `frame_times.json`.
4. **Encode.** ffmpeg dipakai dengan `-framerate 24 -frames:v 120 -c:v libx264 -pix_fmt yuv420p -crf 18`. Kalau ffmpeg tidak ada, script memasang `imageio-ffmpeg` lewat pip.

## Kronologi pengerjaan

### 1. Test render pertama (1280x720, 32 sampel)

Cek framing lolos dengan rentang NDC x 0,291 sampai 0,728 dan y 0,185 sampai 0,770. Satu frame butuh 21,34 detik, sehingga estimasi untuk 120 frame 2561 detik (42,7 menit).

Hasil gambarnya bermasalah di background. Yang terlihat cuma pita biru rata di bagian atas, dan tepi lantai muncul sebagai garis tegas di tengah frame.

![Test frame dengan background versi akhir](render_test_assets/test_1280x720_32spp.jpg)

*Gambar di atas berasal dari test ulang dengan background versi akhir. File test pertama dengan background lama sudah terhapus.*

Penyebabnya geometri kamera. Kamera di ketinggian 3,4 m membidik titik setinggi 1 m dari jarak 10 m, jadi menunduk sekitar 13,5°. Setengah sudut pandang vertikal lensa 50 mm di 16:9 hanya sekitar 11,4°, sehingga tepi atas frame masih 2° di bawah horizon. Langit tidak pernah masuk frame. Yang terlihat di atas cuma bagian background di balik tepi lantai berukuran 40 m, dan di arah itu gradasi lama (berbasis arah Z dunia) mentok di satu warna.

Perbaikannya:

- Lantai diperbesar jadi 400 m sehingga tepinya jatuh tepat di horizon.
- Kamera diturunkan ke z 2,3 lalu 2,1. Kamera tetap menunduk sekitar 7,4°, tetapi tepi atas frame sekarang sekitar 4° di atas horizon.
- Gradasi diganti ke koordinat layar (Window Y), dicampur lewat node Light Path "Is Camera Ray". Gradasinya selalu kelihatan di bagian atas frame tanpa memengaruhi pantulan emas.

### 2. Test render kedua (960x540, 16 sampel)

Satu frame butuh 8,12 detik, estimasinya 974 detik (16,2 menit). Dengan dua penurunan sekaligus pun budget masih lewat.

### 3. Run penuh pertama gagal tanpa ketahuan

Perintahnya dibungkus `/usr/bin/time`, padahal program itu tidak ada di container. Proses langsung mati tanpa merender apa pun. Status background task tetap melaporkan exit code 0 karena yang dinilai exit code `grep | tail` di ujung pipe, bukan exit code Python. Kegagalan ini baru ketahuan setelah `settings.json` dan folder frame dicek dan ternyata kosong. Run berikutnya diukur pakai `date +%s`.

### 4. Commit script

Hook repo meminta file yang belum di-track untuk di-commit, jadi `render_test.py` di-commit dan di-push sebagai `159f746`.

### 5. Run penuh kedua (hasil yang dilaporkan)

Ladder setting dijalankan dari awal:

| Setting | Waktu 1 frame | Estimasi 120 frame |
|---|---|---|
| 1280x720, 32 sampel | 22,80 dtk | 2736 dtk (45,6 mnt) |
| 960x540, 32 sampel | 12,03 dtk | 1444 dtk (24,1 mnt) |
| 960x540, 16 sampel | 7,83 dtk | 939 dtk (15,7 mnt) |

Tidak ada tingkat yang lolos 600 detik, jadi script memakai 960x540 16 sampel.

## Hasil

**Setting akhir:** 960x540, Cycles CPU 16 sampel, denoise OIDN aktif, 24 fps, frame 1 sampai 120.

| Ukuran | Nilai |
|---|---|
| Total render 120 frame | 827,2 dtk (13,8 mnt) |
| Rata-rata per frame | 6,89 dtk |
| Median | 6,82 dtk |
| Tercepat | 6,24 dtk (frame 57) |
| Terlambat | 8,41 dtk (frame 1) |
| Wall-clock seluruh run | 876 dtk (14,6 mnt) |
| Ukuran PNG sequence | 54 MB |
| Ukuran MP4 | 524.078 byte |

Dari 876 detik wall-clock, 827,2 detik habis untuk render frame dan 42,7 detik untuk tiga test render. Sisanya sekitar 6 detik dipakai membangun scene, mengecek framing, dan encode.

Waktu aktualnya (827,2 detik) ternyata 12% lebih cepat dari estimasi test render (939 detik). Frame 1 juga paling lambat di run penuh. Dugaan saya, belum diukur terpisah: frame pertama menanggung biaya awal seperti sinkronisasi scene dan inisialisasi denoiser, dan biaya ini tidak terulang di frame berikutnya karena persistent data aktif.

## Verifikasi

**Metadata MP4 (ffprobe dengan `-count_frames`):** h264, 960x540, yuv420p, `r_frame_rate` dan `avg_frame_rate` 24/1, `nb_read_frames` 120, durasi 5,000000 detik.

**Frame 1, 60, dan 120** diambil dua kali, dari PNG aslinya dan dari hasil decode MP4. Kecerahan dihitung dalam grayscale 0 sampai 255:

| Frame | Rata-rata PNG | Rata-rata MP4 | Piksel < 5 |
|---|---|---|---|
| 1 | 50,3 | 49,0 | 0,0% |
| 60 | 51,0 | 49,7 | 0,0% |
| 120 | 55,7 | 54,4 | 0,0% |

Ketiganya juga dilihat langsung. Suzanne terlihat utuh: frame 1 dari depan, frame 60 dari belakang, dan frame 120 dari depan lagi.

| Frame 1 | Frame 60 | Frame 120 |
|---|---|---|
| ![frame 1](render_test_assets/frame_001.jpg) | ![frame 60](render_test_assets/frame_060.jpg) | ![frame 120](render_test_assets/frame_120.jpg) |

**Framing di 120 frame:** semua vertex ada di dalam frame. Rentang terluarnya x 0,287 sampai 0,732 dan y 0,187 sampai 0,773 (0 dan 1 adalah tepi frame).

## Bug: rotasi tidak linear

Bug ini ditemukan saat menyiapkan laporan, setelah videonya dikirim. Nilai animasi dicek langsung di scene yang dipakai untuk render:

| Frame | Rotasi Suzanne | Seharusnya (linear) | Rotasi pivot kamera | Posisi kamera (y, z) |
|---|---|---|---|---|
| 1 | 0,00° | 0° | −15,00° | `(-10.000, 2.300)` |
| 31 | 56,25° | 90° | −10,24° | `(-9.762, 2.268)` |
| 61 | 180,00° | 180° | 0,19° | `(-9.241, 2.199)` |
| 91 | 303,75° | 270° | 10,52° | `(-8.724, 2.130)` |
| 120 | 359,93° | 357° | 15,00° | `(-8.500, 2.100)` |

Angka 56,25° di frame 31 cocok dengan kurva ease in/out Bezier. Kalau linear, langkahnya 3° per frame. Di video ini langkah dari frame 120 ke frame 1 cuma 0,07°, padahal di tengah animasi bisa lebih dari 3°. Akibatnya Suzanne kelihatan berhenti sebentar tiap kali video di-loop. Gerak kamera juga ikut ease in/out, meski efeknya tidak separah rotasi.

**Penyebab.** Script mengandalkan preferensi `keyframe_new_interpolation_type = "LINEAR"`, dan preferensi itu tidak berpengaruh pada keyframe yang dibuat lewat modul `bpy` dari pip. Penyebab teknisnya belum ditelusuri lebih jauh.

**Kenapa lolos verifikasi.** Semua cek di atas memeriksa file output (durasi, jumlah frame, kecerahan, framing). Tidak ada cek yang membaca kurva animasinya.

**Perbaikan di `render_test.py`** (sudah di-commit, belum dirender):

- Fungsi `make_linear()` mengeset interpolasi LINEAR langsung di tiap keyframe Suzanne, pivot, dan kamera. F-curve dibaca lewat API Action slotted, dengan fallback ke API lama. Jalur fallback ini belum dites.
- Fungsi `check_linear()` memastikan rotasi Suzanne tepat 3° per frame. Kalau tidak, script berhenti sebelum render.

Hasil perbaikan sudah dicek tanpa render: rotasi di frame 1, 31, 61, 91, dan 120 menjadi 0°, 90°, 180°, 270°, dan 357°, dengan selisih maksimal 0,000029°. Render ulang sempat dijalankan tapi dihentikan setelah beberapa frame atas permintaan, jadi **video di laporan ini masih versi Bezier**.

## Catatan dan keterbatasan

- Budget 10 menit tidak tercapai di mesin ini, bahkan setelah resolusi dan sampel sama-sama diturunkan.
- Pesan `WARNING CUEW initialization failed` di log muncul karena Cycles mencoba memuat library CUDA, sementara container tidak punya GPU. Render CPU tidak terpengaruh.
- Kamera hanya mengorbit sekali dari −15° ke +15°. Kalau video di-loop, kamera akan melompat balik ke posisi awal. Ini sesuai brief, karena yang diminta loop mulus cuma rotasi Suzanne.
- Garis horizon antara lantai dan langit masih terlihat tegas.
- Gradasi background hanya terlihat oleh kamera. Pantulan di emas dan lantai memakai biru tua polos.

## Pilihan langkah berikutnya

1. Render ulang dengan perbaikan linear di setting yang sama. Perkiraannya sekitar 14 menit, berdasarkan run sebelumnya.
2. Kalau budget 10 menit wajib, perlu satu penurunan lagi di luar dua opsi dari brief, misalnya mengurangi max bounces atau resolusi. Keduanya mengubah tampilan, jadi perlu keputusan dulu.
3. Kalau mau 1280x720 32 sampel, waktunya sekitar 45 menit di mesin ini.

## Menjalankan ulang

```bash
pip install bpy
python3 render_test.py --out render_out --test-only            # 1 frame + estimasi
python3 render_test.py --out render_out                        # ladder otomatis, render, encode
python3 render_test.py --out render_out --res 960x540 --samples 16   # setting dipaksa
```

Kalau run terputus, jalankan perintah yang sama lagi. Frame yang sudah ada akan dilewati, dan setting diambil dari `render_out/settings.json`.

## File

| File | Isi |
|---|---|
| `render_test.py` | Script pipeline |
| `render_test_assets/render_test.mp4` | Video hasil run penuh kedua (versi Bezier) |
| `render_test_assets/frame_001.jpg`, `frame_060.jpg`, `frame_120.jpg` | Frame dari hasil decode MP4 |
| `render_test_assets/test_1280x720_32spp.jpg` | Test frame 1280x720 dengan background versi akhir |
| `render_test_assets/settings.json` | Setting yang dikunci |
| `render_test_assets/frame_times.json` | Waktu render per frame |
