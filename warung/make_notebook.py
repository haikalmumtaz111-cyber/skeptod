#!/usr/bin/env python3
"""Bangun render_colab.ipynb dari warung_diorama.py supaya isi cell script selalu sama persis
dengan file script di repo.   python3 make_notebook.py"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = open(os.path.join(HERE, 'warung_diorama.py'), encoding='utf-8').read()

MD_INTRO = """# Warung tenda diorama: render final di Colab (GPU T4)

Notebook ini merender 120 frame (1080x1920, 24 fps, Cycles 512 sample) lalu menggabungnya jadi MP4.
Semua frame, log dan cache simulasi disimpan di Google Drive, folder `MyDrive/warung_diorama`.
Kalau sesi Colab mati di tengah jalan, buka lagi notebook ini lalu **Run all**: frame yang sudah ada dilewati.

**Langkah**
1. `Runtime > Change runtime type > T4 GPU > Save`.
2. `Runtime > Run all`, lalu izinkan akses Google Drive waktu diminta.
3. Tunggu cell 6 mencetak device yang terpakai, waktu frame pertama dan ETA 120 frame.
4. Biarkan cell 7 jalan sampai 120 frame. Kalau sesi putus, ulangi langkah 1 dan 2.
5. Cell 8 membuat `warung_diorama.mp4`, menampilkannya, menyimpannya ke Drive dan mengunduhnya ke komputer.
"""

C_CONFIG = r'''#@title 0. Konfigurasi (tidak perlu diubah)
BLENDER_VER = '4.5.17'      # sama dengan versi yang dipakai waktu scene dibangun dan dites
BLENDER_URL = f'https://download.blender.org/release/Blender4.5/blender-{BLENDER_VER}-linux-x64.tar.xz'
DRIVE_ROOT = '/content/drive/MyDrive/warung_diorama'
WORK = '/content'
RES = '1080x1920'
SAMPLES = 512
FRAME_START, FRAME_END = 1, 120
FPS = 24


class Berhenti(Exception):
    """Dipakai untuk menghentikan Run all dengan pesan yang jelas."""
'''

C_GPU = r'''#@title 1. Cek GPU
import shutil, subprocess

_r = subprocess.run(['nvidia-smi'], capture_output=True, text=True) if shutil.which('nvidia-smi') else None
if _r is None or _r.returncode != 0:
    raise Berhenti(
        '\n\nTIDAK ADA GPU DI RUNTIME INI.\n'
        'Cara ganti: menu Runtime > Change runtime type > Hardware accelerator: T4 GPU > Save.\n'
        'Setelah runtime nyala lagi: Runtime > Run all.\n'
        'Kalau pilihan T4 tidak bisa dipilih, kuota GPU gratis akun ini sedang habis; coba lagi beberapa jam kemudian.\n')
print(_r.stdout)
_g = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'],
                    capture_output=True, text=True).stdout.strip()
print('GPU terdeteksi:', _g)
'''

C_DRIVE = r'''#@title 2. Mount Google Drive (frame, log, cache simulasi disimpan di sini)
import os

if not os.path.isdir('/content/drive/MyDrive'):
    from google.colab import drive
    drive.mount('/content/drive')
FRAMES_DIR = f'{DRIVE_ROOT}/frames'
LOG_DIR = f'{DRIVE_ROOT}/logs'
CACHE_DIR = f'{DRIVE_ROOT}/sim_cache'
for _d in (FRAMES_DIR, LOG_DIR, CACHE_DIR):
    os.makedirs(_d, exist_ok=True)


def frame_path(f):
    return f'{FRAMES_DIR}/frame_{f:04d}.png'


def frame_ada():
    return [f for f in range(FRAME_START, FRAME_END + 1)
            if os.path.exists(frame_path(f)) and os.path.getsize(frame_path(f)) > 1000]


print('Folder kerja di Drive :', DRIVE_ROOT)
print('Frame yang sudah ada   : %d dari %d' % (len(frame_ada()), FRAME_END - FRAME_START + 1))
'''

C_BLENDER = r'''#@title 3. Download Blender resmi dari download.blender.org
import os, subprocess

BL_DIR = f'{WORK}/blender-{BLENDER_VER}-linux-x64'
BLENDER = f'{BL_DIR}/blender'
if not os.path.exists(BLENDER):
    print('Mengunduh', BLENDER_URL)
    subprocess.run(['wget', '-q', '-O', f'{WORK}/blender.tar.xz', BLENDER_URL], check=True)
    subprocess.run(['tar', '-xf', f'{WORK}/blender.tar.xz', '-C', WORK], check=True)
    os.remove(f'{WORK}/blender.tar.xz')
# pustaka sistem yang dibutuhkan binary Blender walau jalan tanpa layar
subprocess.run('apt-get install -y -qq libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libxkbcommon0 '
               'libsm6 libice6 libx11-6 libxext6 > /dev/null 2>&1', shell=True)
_miss = subprocess.run(f'ldd {BLENDER} | grep "not found"', shell=True, capture_output=True, text=True).stdout.strip()
if _miss:
    raise Berhenti('\n\nBlender tidak bisa jalan, pustaka sistem ini belum ada:\n' + _miss)
_v = subprocess.run([BLENDER, '-b', '--version'], capture_output=True, text=True).stdout.strip().splitlines()[0]
print(_v)
if BLENDER_VER not in _v:
    raise Berhenti(f'\n\nVersi Blender tidak cocok: dapat "{_v}", harusnya {BLENDER_VER}')
'''

C_RUN = r'''#@title 5. Fungsi untuk menjalankan Blender dan menampilkan progres
import csv, os, subprocess, sys, time

SCRIPT_PATH = f'{WORK}/warung_diorama.py'


def fmt(s):
    s = int(s)
    return '%dj %02dm %02dd' % (s // 3600, s % 3600 // 60, s % 60)


def jalankan(frames, nama_log):
    """Jalankan script scene. Baris [warung ...] dicetak langsung, baris progres sample dari
    Cycles diringkas jadi satu baris tiap menit, log lengkap ditulis ke Drive."""
    cmd = [BLENDER, '-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '-P', SCRIPT_PATH, '--',
           '--device', 'AUTO', '--res', RES, '--samples', str(SAMPLES), '--frames', frames,
           '--out', FRAMES_DIR, '--assets', f'{WORK}/assets', '--cache', CACHE_DIR]
    logpath = f'{LOG_DIR}/{nama_log}_{time.strftime("%Y%m%d_%H%M%S")}.log'
    print('log lengkap:', logpath)
    last, tail = time.time(), []
    with open(logpath, 'w') as lf:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, errors='replace')
        for line in p.stdout:
            tail = (tail + [line])[-40:]
            if line.startswith('Fra:'):
                if time.time() - last > 60:
                    last = time.time()
                    print('   ...', line.strip()[:150])
                    sys.stdout.flush()
                continue
            lf.write(line)
            lf.flush()
            if line.startswith('[warung') or 'Error' in line or 'Traceback' in line or 'Info: Fluid' in line:
                print(line, end='')
                last = time.time()
        rc = p.wait()
    if rc != 0:
        print(''.join(tail))
        raise Berhenti(f'\n\nBlender berhenti dengan kode {rc}. Lihat potongan log di atas, log lengkap di {logpath}')


def baca_log_render():
    rows = {}
    f = f'{FRAMES_DIR}/render_log.csv'
    if os.path.exists(f):
        for r in csv.DictReader(open(f)):
            rows[int(r['frame'])] = r
    return rows
'''

C_FIRST = r'''#@title 6. Pilih device (OptiX > CUDA > CPU), render 1 frame, cetak waktu dan ETA
_t = time.time()
jalankan(str(FRAME_START), 'frame_pertama')
_total = time.time() - _t
_row = baca_log_render().get(FRAME_START)
_n = FRAME_END - FRAME_START + 1
_sisa = _n - len(frame_ada())
if _row:
    _dt = float(_row['detik'])
    print('\n==============================================================')
    print('Device yang terpakai      :', _row['device'])
    print('Waktu render frame %-4d   : %s  (%s, %s sample)' % (FRAME_START, fmt(_dt), _row['lebar'] + 'x' + _row['tinggi'], _row['samples']))
    print('ETA %d frame             : %s' % (_n, fmt(_dt * _n)))
    print('ETA sisa %d frame        : %s' % (_sisa, fmt(_dt * _sisa)))
    print('Waktu cell ini (termasuk unduh aset + bake simulasi): %s' % fmt(_total))
    print('==============================================================')
    if _row['device'] == 'CPU':
        print('PERINGATAN: render jatuh ke CPU. OptiX dan CUDA dua-duanya gagal, cek log di atas.')
else:
    print('Frame pertama tidak ada di render_log.csv')
'''

C_ALL = r'''#@title 7. Render semua frame (frame yang sudah ada di Drive dilewati)
jalankan(f'{FRAME_START}-{FRAME_END}', 'render')
print('Frame di Drive: %d dari %d' % (len(frame_ada()), FRAME_END - FRAME_START + 1))
'''

C_ENCODE = r'''#@title 8. Encode MP4 (H.264, yuv420p), cek pakai ffprobe, tampilkan, simpan ke Drive
import json, shutil, subprocess

_n = FRAME_END - FRAME_START + 1
_kurang = [f for f in range(FRAME_START, FRAME_END + 1) if f not in set(frame_ada())]
if _kurang:
    raise Berhenti(f'\n\n{len(_kurang)} frame belum ada (contoh: {_kurang[:10]}). '
                   'Jalankan Runtime > Run all lagi, frame yang sudah ada dilewati.')
MP4 = f'{WORK}/warung_diorama.mp4'
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-start_number', str(FRAME_START),
                '-i', f'{FRAMES_DIR}/frame_%04d.png', '-frames:v', str(_n),
                '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p',
                '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
                '-b:v', '40M', '-maxrate', '50M', '-bufsize', '100M', '-r', str(FPS),
                '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
                '-movflags', '+faststart', MP4], check=True)
_p = json.loads(subprocess.run(
    ['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
     'stream=codec_name,pix_fmt,width,height,r_frame_rate,nb_read_frames:format=duration,bit_rate',
     '-of', 'json', MP4], capture_output=True, text=True, check=True).stdout)
_s, _f = _p['streams'][0], _p['format']
_dur = float(_f['duration'])
print('codec %s | %s | %sx%s | %s fps | %s frame | durasi %.3f detik | bitrate %.1f Mbps'
      % (_s['codec_name'], _s['pix_fmt'], _s['width'], _s['height'], _s['r_frame_rate'], _s['nb_read_frames'],
         _dur, float(_f['bit_rate']) / 1e6))
_w, _h = [int(v) for v in RES.split('x')]
_ok = (_s['codec_name'] == 'h264' and _s['pix_fmt'] == 'yuv420p' and int(_s['nb_read_frames']) == _n
       and abs(_dur - _n / FPS) < 0.0005 and int(_s['width']) == _w and int(_s['height']) == _h)
if not _ok:
    raise Berhenti('\n\nffprobe: hasil encode tidak sesuai spek (lihat baris di atas)')
print('ffprobe OK: %d frame, %.3f detik' % (_n, _dur))
shutil.copy(MP4, f'{DRIVE_ROOT}/warung_diorama.mp4')
print('Tersimpan di Drive:', f'{DRIVE_ROOT}/warung_diorama.mp4')
try:
    from IPython.display import Video, display
    display(Video(MP4, embed=True, width=405, html_attributes='controls loop autoplay muted'))
except Exception as e:
    print('Tidak bisa menampilkan video di sini:', e)
try:
    from google.colab import files
    files.download(MP4)
except Exception as e:
    print('Unduh otomatis tidak jalan (%s). Ambil file dari Drive atau dari panel Files.' % e)
'''


def code(src):
    return {'cell_type': 'code', 'metadata': {}, 'execution_count': None, 'outputs': [],
            'source': src.splitlines(keepends=True)}


def md(src):
    return {'cell_type': 'markdown', 'metadata': {}, 'source': src.splitlines(keepends=True)}


def build():
    assert '\n%%' not in SCRIPT
    cells = [md(MD_INTRO), code(C_CONFIG), code(C_GPU), code(C_DRIVE), code(C_BLENDER),
             md('### 4. Script scene\nCell di bawah menulis `warung_diorama.py` (isi sama persis dengan file di repo). Tidak ada clone repo.'),
             code('%%writefile /content/warung_diorama.py\n' + SCRIPT),
             code(C_RUN), code(C_FIRST), code(C_ALL), code(C_ENCODE)]
    nb = {'cells': cells, 'nbformat': 4, 'nbformat_minor': 5,
          'metadata': {'accelerator': 'GPU', 'colab': {'provenance': [], 'gpuType': 'T4', 'name': 'render_colab.ipynb'},
                       'kernelspec': {'display_name': 'Python 3', 'name': 'python3'},
                       'language_info': {'name': 'python'}}}
    for i, c in enumerate(cells):
        c['id'] = 'cell%02d' % i
    out = os.path.join(HERE, 'render_colab.ipynb')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(nb, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print('ditulis:', out, '(%d cell, script %d baris)' % (len(cells), SCRIPT.count('\n')))


if __name__ == '__main__':
    build()
