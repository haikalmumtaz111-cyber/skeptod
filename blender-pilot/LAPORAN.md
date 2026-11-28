# Laporan pilot video 3D Blender headless

Topik: kenapa jalan butuh lapisan batu pecah. Durasi 15 detik. Tanggal kerja 28 November 2026. Jam yang gue tulis di bawah itu jam container, diambil dari waktu file.

## 1. Hasil singkat

Video jadi dan udah gue tonton lewat frame hasil render, bukan cuma lewat log.

| Hal | Nilai |
|---|---|
| File | `out/pilot.mp4`, 11,3 MB |
| Format | H.264, yuv420p, 1080x1920, 30 fps, 450 frame, 15,000 detik, tanpa stream audio (hasil ffprobe) |
| Blender | 5.3.0, modul `bpy` dari pip, Python 3.13.18, headless |
| Engine | EEVEE di atas Mesa llvmpipe (software GL), 8 sample, view transform Standard |
| Resolusi render | native 1080x1920, tanpa upscale |
| Detik per frame | rata-rata 10,17 (min 7,77, maks 12,53) |
| Total render | 87,0 menit: 76,3 menit buat 450 frame + 10,7 menit render ulang 65 frame |
| Mesin | 4 core CPU, RAM 15 GB, tanpa GPU |

Angka 87 menit itu cuma render final. Render preview resolusi kecil dan tes engine ga gue masukin.

## 2. Yang lu minta

Pilot uji kelayakan: bisa ga pipeline Blender lewat script Python ngeluarin gaya video referensi sebelum lu pesen versi panjang. Lu minta hasil jujur, bukan hasil yang keliatan beres.

Spesifikasinya 1080x1920, 30 fps, pas 15,0 detik, H.264, tanpa audio. Tiga shot: karakter bercaping ngeratain jalan tanah, truk lewat terus rodanya ambles dengan panah "8 ton", lalu lapisan batu pecah tumbuh di bawah jalan dan truk lewat lagi tanpa ambles. Caption 14 kartu dengan teks dan waktu yang udah lu tentuin. Render harus di bawah 90 menit, dan kalo 1080x1920 ga muat boleh turun ke 720x1280 lalu di-upscale.

## 3. Kronologi

**Pelajari referensi.** Video referensi 1080x1920, 30 fps, 70,5 detik. Gue ekstrak 1 fps, gue susun jadi dua contact sheet, lalu gue catat cirinya: langit biru gradasi, awan gumpalan low-poly, sawah hijau, rumah atap merah dan pohon di kejauhan, tanah dipotong kayak blok diorama, caption putih di sekitar 65% tinggi frame.

**Pasang alat (sampai 12:15).** Blender ga ada di mesin, jadi gue pasang `bpy` 5.3.0 lewat pip. Font Plus Jakarta Sans gagal diunduh dari `github.com/google/fonts` karena akses repo itu ga dibuka di sesi ini. Gue ambil dari `raw.githubusercontent.com`, lalu gue bikin instance statis SemiBold dan Bold pake fontTools (12:27).

**Bangun scene.** Semua adegan ditulis di `scene.py` (1.334 baris). Ga ada aset luar selain font.

**Tes engine (12:32 sampai 12:43).** Cycles langsung jalan. EEVEE mati dengan pesan "Couldn't open libEGL.so.1" dan ngebunuh proses tesnya, makanya `engine_test.json` ga pernah ketulis. Setelah `apt-get update` dan pasang paket Mesa (libegl1, libegl-mesa0, libgl1-mesa-dri, libgl1, libgles2, mesa-vulkan-drivers, libvulkan1), EEVEE dan Workbench bisa render lewat software GL.

**Perbaikan dari preview.** Tiap kali render preview gue liat frame-nya, dan ini yang gue benerin sebelum render final:

- Bercak biru tua di gunung ternyata bayangan awan. Awan gue set ga ngelempar bayangan, gunung gue bikin tanpa shading.
- Caption nutupin titik temu roda dan tanah. Kamera gue arahin ulang supaya aksinya ada di atas 62% tinggi frame.
- Pose berdiri karakter kaku dengan lengan lurus dan garu nyilang di muka. Posisi garu gue pindah, lalu gue tambah gerakan tangan ke tepi caping dan anggukan, soalnya caping yang simetris bikin tolehan kepala ga keliatan.
- Batu pecah keliatan jarang. Penyebabnya dua lapis batu ada di belakang bidang latar. Semua lapis gue majuin, jumlah batu jadi 2.549.
- Latar gelap batu jalan lebih dulu dari batunya. Gue bikin telat 0,62 detik.

**Render final (12:58 sampai 14:15).** Percobaan pertama segfault setelah frame 43. Lanjutannya ada di bagian 6.

**Cek hasil dan render ulang (14:16 sampai 14:30).** Dari contact sheet gue nemu kamera shot 2 nyaris diem di 2 detik terakhir. Gue tambah push-in, render ulang frame 241 sampai 305, encode ulang, cek lagi, lalu simpen `pilot.blend`.

## 4. Cara scene dibangun

Sumbu X searah jalan, Y menjauh dari penonton, Z ke atas. Bidang potong diorama ada di y = 0, permukaan jalan di z = 0, lebar jalan 3,6 m. Garis tengah truk di y = 1,06 sehingga sisi ban terdekat ada di y = 0,06. Artinya potongan tanah lewat persis di samping jejak roda, dan itu yang bikin amblesnya kebaca di penampang.

`scene.build(res)` bikin semua objek sekali. `scene.apply_frame(f)` lalu nyetel posisi tiap objek dan deformasi tiap vertex buat frame itu, jadi pas render ga ada keyframe yang dipake.

- **Lingkungan:** langit gradasi, matahari satu arah, 15 gumpalan awan dari icosphere yang geser pelan, sekitar 25,9 ribu rumpun padi dalam satu mesh, 12 rumah, pohon, kelapa, satu saung, gunung di belakang.
- **Tanah:** grid halus buat permukaan dan grid buat muka potongan dengan pita warna tiap lapisan. Kedalaman jejak dihitung dari tapak lingkaran roda sepanjang waktu (8 langkah per frame), lalu vertex muka potongan digeser turun dan makin kecil ke bawah.
- **Karakter:** desain sendiri, tanpa wajah, bercaping, kaos kuning, celana pendek biru. Badannya potongan kaku yang ditaruh pake IK dua ruas analitik. Siklus garu 1,15 detik, mulai berdiri di detik 2,35.
- **Truk:** bak datar kuning dan toska dengan muatan. Di shot 2 truk ngerem di atas potongan lalu roda belakang turun 0,25 m, tambah 0,05 m pas panah nekan. Roda depan turun 0,55 kalinya.
- **Panah 8 ton:** panah merah bertepi putih dan label "8 ton" di lencana biru tua, muncul di detik 8,9 dan nekan ke sumbu roda.
- **Batu pecah:** 2.549 batu bersudut dari convex hull dalam satu mesh, tumbuh dari kiri ke kanan mulai detik 10,4.
- **Kamera:** gerak terus di tiap shot. Cut keras di frame 138 (4,6 detik) dan 306 (10,2 detik).
- **Caption:** ditempel setelah render pake PIL, Plus Jakarta Sans SemiBold 76 px, putih, bayangan blur, rata tengah, titik tengah di 65% tinggi frame.

## 5. Tes engine

Semua diukur di mesin ini pada 1080x1920 kecuali yang ditulis lain.

| Engine | Detik per frame | Perkiraan 450 frame | Catatan |
|---|---|---|---|
| Cycles CPU 16 spp | sekitar 25 | sekitar 3 jam | lewat budget |
| Cycles CPU 16 spp di 720x1280 | sekitar 11,4 | sekitar 85 menit | harus upscale |
| EEVEE 16 sample | 14,8 sampai 25,8 | | tes pertama, frame awal kena kompilasi shader |
| EEVEE 8 sample | sekitar 9,9 | sekitar 74 menit | dipilih |
| EEVEE 4 sample | sekitar 6 | sekitar 45 menit | |
| Workbench | 1,1 sampai 3,3 | | tanpa lighting, tampilan abu-abu |

EEVEE 8 sample gue pilih karena cuma itu yang muat di 90 menit pada resolusi native dengan lighting yang masih layak.

## 6. Render final

Percobaan pertama mati setelah frame 43 (417,6 detik jalan). `dmesg` nyatet segfault python3 di libc. RAM waktu itu 1,5 sampai 1,7 GB dengan 12 GB masih kosong, dan frame 44 lolos pas diulang, jadi ini bukan kehabisan memori dan bukan frame tertentu yang rusak. Penyebab pastinya ga gue telusuri. Yang gue tau cuma crash-nya acak di jalur EEVEE dan llvmpipe.

Solusinya `run_render.sh`: render per 30 frame, tiap potong proses baru, dan frame yang udah ada di disk dilewatin. Setelah itu 14 potong render utama dan 2 potong render ulang semuanya keluar normal.

| Tahap | Frame | Waktu |
|---|---|---|
| Render utama | 450 | 4.578 detik (76,3 menit), rata-rata 10,17 detik |
| Render ulang kamera shot 2 | 65 (241 sampai 305) | 641 detik (10,7 menit), rata-rata 9,86 detik |
| Total | | 5.219 detik (87,0 menit) |

Sisa dari budget 90 menit cuma 3 menit. Kalo ada satu perbaikan lagi yang butuh render ulang, budget-nya jebol.

## 7. Pemeriksaan hasil

Ini yang gue liat sendiri di mp4 final lewat contact sheet 1 fps, 18 frame resolusi lebih besar di sekitar cut dan momen penting, plus scan angka di semua 450 frame.

- Ga ada frame hitam. Kecerahan rata-rata terendah 91,7 dari 255.
- Kamera gerak di semua shot. Selisih antar frame terkecil di shot 2 naik dari 0,246 ke 0,607 setelah push-in ditambah.
- Cut ada di frame 138 dan 306, sesuai 4,6 dan 10,2 detik.
- Caption: teks sesuai tabel lu, ga ada yang kepotong, kartu terpanjang "kalau kamu ratain tanah" masih muat. Jeda tanpa caption di 4,4 sampai 4,6 detik sesuai tabel.
- Shot 1: karakter ngegaru, lalu berdiri megang garu, tangan ke tepi caping. Kaki napak di tanah, ga melayang.
- Shot 2: truk dateng, roda turun, pita lapisan tanah di penampang ikut melengkung. Panah dan label "8 ton" muncul bareng caption "nanggung beban 8 ton" dan ujung panahnya jatuh di sumbu roda.
- Shot 3: batu pecah abu-abu bersudut tumbuh di bawah lapisan permukaan, truk lewat dan rodanya tetep di permukaan.

## 8. Yang ga tercapai atau disederhanain

- **Caption bukan dari Blender.** Ditempel di post pake PIL dan ffmpeg. Kartu ganti sesuai tabel waktu tanpa animasi masuk.
- **Jalan ga kebaca "di tengah sawah".** Sawah cuma ada di sisi jauh, karena potongan diorama gue taro di samping jejak roda.
- **Tanah di shot 1 ga keliatan jadi rata.** Yang ada gerakan garu dan beberapa gumpalan kecil. Permukaan jalan juga cuma keliatan sebagai garis tipis karena sudut kamera rendah.
- **Karakter tanpa armature.** Potongan kaku dengan IK analitik, sendinya kotak-kotak.
- **Ambles itu rumus, bukan simulasi tanah.** Vertex digeser pake fungsi.
- **Batu pecah cuma di muka potongan,** setebel sekitar 10 cm, ga di bawah seluruh jalan.
- **Bekas ambles ilang pas cut ke shot 3.** Ga ada adegan tanah digali atau diperbaiki.
- **`pilot.blend` ga mandiri penuh.** Gerak kamera, truk, karakter, panah, dan awan udah jadi keyframe. Deformasi tanah dan tumbuhnya batu masih butuh `scene.py`, dan caption ga ada di dalemnya.
- **Ga ada** motion blur, debu, padi goyang, atau ambient occlusion.

## 9. Masalah yang masih keliatan

- Sekitar 40% bagian bawah frame shot 1 isinya dinding tanah kosong.
- Gagang garu nyilang di depan caping dan tangan pas pose berdiri.
- Bayangan keras dan tanpa ambient occlusion, jadi gambarnya lebih flat dari referensi.
- Tekstur lapisan tanah paling bawah belang halus, kurang nyatu sama gaya low-poly.
- Truk di shot 3 jalan kecepatan konstan tanpa reaksi suspensi.

## 10. Estimasi kalo dipanjangin jadi 70 detik

Fakta dari ukuran: 2.100 frame x 10,1 detik = sekitar 5,9 jam render di mesin ini dengan setting yang sama, wajib dipecah per potong karena crash acak tadi. EEVEE 4 sample bakal sekitar 3,5 jam, tapi mutu gambarnya di 4 sample belum gue bandingin frame demi frame.

Opini gue: render bukan biaya terbesarnya. Pilot ini 3 shot, versi 70 detik dengan cut tiap 4 sampai 6 detik butuh sekitar 14 shot, dan tiap shot baru berarti nulis adegan dan animasi baru. Truk, karakter, dan lingkungan bisa dipake ulang.

## 11. Penilaian kelayakan (opini)

Pipeline-nya sanggup buat langit, awan, sawah, rumah, diorama potongan tanah, dan caption di mesin tanpa GPU. Dua titik lemahnya animasi karakter dan kedalaman lighting. Kalo targetnya sehalus referensi, dua itu yang perlu digarap dulu: karakter pake armature beneran, dan render di mesin ber-GPU supaya bisa nyalain ambient occlusion atau pindah ke Cycles.

## 12. Isi folder

| File | Isi |
|---|---|
| `out/pilot.mp4` | video final |
| `out/contact_sheet.jpg` | contact sheet 1 fps dari mp4 final |
| `pilot.blend` | scene Blender, 11,2 MB |
| `scene.py` | semua adegan dan animasi |
| `render.py`, `run_render.sh` | render per frame, bisa dilanjut, dipecah per 30 frame |
| `captions.py` | tempel caption dan encode mp4 |
| `contact_sheet.sh` | bikin contact sheet |
| `save_blend.py` | bikin `pilot.blend` |
| `engine_test.py`, `engine_test_gl.py`, `engine_test/` | tes engine dan gambar hasilnya |
| `frames/` | 450 frame PNG final |
| `frames_old_shot2tail/` | 65 frame lama sebelum kamera shot 2 dibenerin |
| `render_log.jsonl`, `rerender_log.jsonl` | waktu render tiap frame |
| `fonts/` | Plus Jakarta Sans SemiBold dan Bold |

Ukuran folder 992 MB, sebagian besar dari frame PNG.

## 13. Cara ngulang dari nol

```
pip install bpy
apt-get update && apt-get install -y libegl1 libegl-mesa0 libgl1-mesa-dri libgl1 libgles2 mesa-vulkan-drivers libvulkan1
./run_render.sh
python3 captions.py --frames frames --out out/pilot.mp4
./contact_sheet.sh
python3 save_blend.py
```

## 14. Status git

Belum ada yang di-commit atau di-push, sesuai instruksi lu. Folder `blender-pilot/` masih untracked. Container ini sementara, jadi isinya ilang kalo sesi mati sebelum disimpen.
