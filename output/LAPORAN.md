# Laporan: Diorama Rumah Minimalis 3D (bpy + Cycles, dirender lewat Google Colab)

Tanggal kerja: 26 sampai 27 November 2026. Semua jam di bawah pakai WIB.

## Ringkasan

Videonya jadi: 5,00 detik, 1080x1920, 24 fps, 120 frame, H.264 yuv420p, 29,4 Mbps, 18,4 MB. Dari lu bilang "coba B" sampai MP4 keluar butuh sekitar 16 jam 20 menit (26 Nov 08.42 sampai 27 Nov 01.03).

Frame 1 sampai 107 dirender di GPU T4 Colab gratis, 142,7 detik per frame. Google mutus sesinya di frame 107 dan nolak ngasih T4 lagi, jadi 13 frame terakhir kepaksa dirender di CPU dengan 2.524 detik per frame. Setting kualitasnya sama dari frame pertama sampai terakhir, ga ada yang diturunin.

## File hasil

| File | Isi |
| --- | --- |
| `output/house_diorama.mp4` | Video final |
| `output/still_frame_0060.png` | Still frame 60, putaran 4 |
| `output/render.log` | Log render |
| `house_diorama.py` | Script scene, 2.109 baris |

Semuanya ada di branch `claude/keen-rubin-xuhx93`. Folder `assets/` (tekstur 66 MB) dan `render/` (120 PNG) sengaja ga ikut ke git, script-nya ngunduh ulang tekstur sendiri.

## Kronologi

| Jam | Kejadian |
| --- | --- |
| 08.42 | Lu pilih jalur B (gua yang nyetir Colab). Gua pasang google-colab-cli 0.8.0 dan bikin link login Google pertama |
| 08.56 | Tekstur dan HDRI dari Poly Haven keunduh, mulai nulis script |
| 09.19 | Still putaran 1 jalan di CPU container gua, kelar 891 detik |
| 09.35 | Link login kedua dibuat karena yang pertama ga pernah nyampe ke lu |
| 09.39 | Lu kirim kode verifikasi, login tembus, T4 dapet di akun gratis |
| 09.42 | Still putaran 2 di T4, 83,6 detik |
| 09.55 | Still putaran 3 di T4, 80,8 detik |
| 10.02 | Still putaran 4 di T4 pakai 1024 sample, 148,0 detik |
| 10.05 | Render 120 frame mulai di Colab |
| 14.20 | Frame 107 kelar, abis itu Google mutus sesinya |
| 15.17 | Gua baru nyadar sesinya ilang pas cek per jam. Minta T4 baru, ditolak |
| 15.19 | Render CPU pertama dijalanin, mati sebelum ngasilin frame karena container gua ke-restart |
| 15.49 | Render CPU dijalanin ulang sebagai tugas latar, mundur dari frame 120 |
| 01.03 | Frame 108 kelar, MP4 di-encode |

## Scene yang dibangun

Semua geometri dibikin prosedural dari script, ga ada model jadi yang diimpor.

| Elemen | Jumlah |
| --- | --- |
| Total | 45 objek mesh, 7,27 juta vertex, 9,03 juta face |
| Bata | 3.365 biji, tiap bata satu kotak ber-bevel, nat dari dinding di belakangnya |
| Daun pohon | 185.445 helai (151.467 di pohon tinggi, 33.978 di pohon kecil) |
| Cabang | 2.397 di pohon tinggi, 551 di pohon kecil |
| Bilah rumput | 297.822 |
| Kerikil 3D | 81.921 |

Tekstur PBR dan HDRI semuanya CC0 dari Poly Haven dan semuanya berhasil keunduh, jadi ga ada yang jatuh ke versi prosedural: white_plaster_02, concrete_floor_worn_001, concrete_layers_02, oak_veneer_01, oak_wood_planks, sakura_bark, dark_rock, forrest_ground_01, floor_pebbles_01, dan HDRI lonely_road_afternoon_puresky 4k. Material daun, rumput, kaca, logam, dan kain dibikin prosedural dari awal.

Satu catatan soal cahaya: matahari di HDRI itu elevasinya cuma 9 derajat, kerendahan buat scene ini. Jadi matahari HDRI gua potong dan diganti lampu Sun di elevasi 24 derajat, HDRI-nya tinggal jadi cahaya pengisi.

## Putaran still

| Putaran | Mesin | Sample | Waktu | Yang masih palsu, lalu dibenerin |
| --- | --- | --- | --- | --- |
| 1 | CPU | 384 | 891 detik | Beton polos, sofa gosong putih kena matahari, batu kayak kacang item |
| 2 | T4 | 384 | 83,6 detik | Noda beton belum kebaca, batu masih licin |
| 3 | T4 | 384 | 80,8 detik | Noda beton dan faset batu udah muncul, cahaya kurang hangat |
| 4 | T4 | 1024 | 148,0 detik | Matahari dibikin lebih hangat. Ini yang dipakai buat final |

Sebelum putaran 1 ada beberapa preview resolusi rendah. Dari situ yang diubah: kanopi dinaikin dari 2,50 m ke 2,80 m dan pintu dipindah ke dinding coakan yang kena matahari (di posisi awal pintunya ketutup kanopi dari sudut kamera), ditambah skylight, pipa ventilasi, dan daun gugur di atap, tajuk pohon dilebarin, dan ujung bata di tepi jendela ditutup lis.

## Render video

| Bagian | Frame | Mesin | Rata-rata per frame | Total |
| --- | --- | --- | --- | --- |
| Colab | 1 sampai 107 | Tesla T4, OptiX | 142,7 detik | 4,24 jam |
| Lokal | 108 sampai 120 | CPU 4 core | 2.524 detik | 9,11 jam |

Waktu render murni 13,35 jam, dan 68 persennya abis buat 13 frame terakhir. Kalau T4 ga diputus, 120 frame kelar sekitar 4,76 jam.

Spek mesin Colab gratis yang kepake: Tesla T4 15.360 MiB, driver 580.82.07, 2 core CPU, 12 GB RAM, Blender 5.2.5 LTS. VRAM yang kepake sekitar 2 GB. Container gua sendiri 4 core, 15 GB RAM, tanpa GPU.

Sambungan GPU ke CPU gua ukur lewat selisih rata-rata antar-frame: 1,208 (106 ke 107), 1,147 (107 ke 108), 1,072 (108 ke 109). Angkanya turun mulus, ga ada loncatan di frame 108. Rata-rata kecerahan frame juga nyambung (166,003 lalu 166,005).

## Yang beda dari prompt awal

| Di prompt | Yang dipakai | Alasan |
| --- | --- | --- |
| Cycles CPU | GPU OptiX buat frame 1 sampai 107, CPU buat 108 sampai 120 | Lu minta pakai Colab. CPU kepake lagi karena T4 ditolak |
| Minimal 256 sample | 1024 sample | T4 cukup cepet, jadi dinaikin |
| Light bounce jangan dipangkas | Maksimal 16, diffuse 8, glossy 8, transmission 16 | Di atas default Cycles. Clamp indirect tetap 10 (default) |
| Nohup, lanjut dari frame terakhir | Sama, plus frame ditarik berkala ke container gua | Biar frame ga ilang kalau Colab mati |

Ga ada target yang diturunin. Density daun dan rumput penuh, resolusi penuh.

## Yang berhasil realistis

- Pohon: percabangan sampai ranting, daun per helai dengan variasi warna dan cahaya tembus.
- Rumput per bilah, rumput hias, dan kerikil 3D.
- Bata yang kebaca satu-satu dari dekat, lengkap dengan nat.
- Bilah kayu teras, dek, dan bak tanaman.
- Cahaya sore: bayangan panjang ke kiri dengan tepi lembut, backdrop krem bersih.

## Yang gagal atau masih keliatan CG

- Kaca jendela besar hampir ga mantulin apa-apa dari sudut kamera ini. Secara fisika itu benar, tapi kacanya jadi kurang kebaca.
- Pelat pijakan, tangga, dan coping masih terlalu bersih.
- Furnitur interior cuma kotak-kotak, lampunya kurang kebaca.
- Tinggi rumput terlalu rata.
- Batu masih kurang detail.
- Kerikil di atap cuma tekstur gambar, bukan kerikil 3D kayak di taman.
- Bevel cuma chamfer satu segmen, di 1080p hampir ga keliatan.

Sebabnya kemampuan dan waktu modeling gua. Bukan batas bpy, bukan memori, bukan jaringan.

## Masalah di jalan

1. **Link login pertama ga nyampe ke lu.** Gua nulis link-nya di tengah kerjaan, dan aplikasi ngeringkas pesan itu tanpa link. Gua sempat nuduh lu ngeskip, padahal lu emang ga pernah nerima. Itu salah gua.
2. **Koneksi ke kernel Colab putus kira-kira tiap jam.** Kernel gua restart tiga kali (12.01, 13.18, 14.18). Proses render-nya sendiri ga pernah mati.
3. **Sesi Colab diputus Google setelah sekitar 4 jam 40 menit.** Permintaan T4 baru dicoba 14 kali sampai tengah malam, semuanya ditolak ("Service Unavailable" dan sekali "Allocation refused"). Google ga ngasih alasan. Dugaan gua jatah GPU gratis hariannya abis, tapi itu ga bisa gua pastiin.
4. **Sesi putus baru ketauan sejam kemudian**, karena gua cuma ngecek tiap jam.
5. **Render CPU pertama mati** gara-gara container gua ke-restart pas nganggur. Abis itu render dijalanin sebagai tugas latar per jendela 2 jam yang berhenti rapi di antara frame.

## Yang belum dicek

- Videonya ga gua tonton sebagai video. Yang gua cek cuma frame 1, 60, 107, 108, dan 120 sebagai gambar, plus angka selisih frame 102 sampai 113.
- Kedipan denoise antar-frame di bagian daun dan rumput ga gua ukur.

## Sisa beres-beres

Token login Google lu masih ada di container gua. Buat nyabut dari sisi lu: buka myaccount.google.com/permissions dan hapus akses "Google Auth Library".
