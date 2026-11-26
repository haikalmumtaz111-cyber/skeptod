#!/usr/bin/env python3
"""
house_diorama.py - diorama rumah minimalis modern, isometrik, sore musim gugur.

Jalan sebagai modul bpy (pip install bpy) atau lewat Blender:
    python house_diorama.py --still 60
    blender -b -P house_diorama.py -- --anim

Semua geometri dibangun prosedural (numpy -> mesh). Tekstur PBR dan HDRI diunduh
dari Poly Haven (CC0) ke ./assets. Kalau unduhan gagal, material jatuh ke versi
prosedural dan dicatat di log.
"""
import bpy, bmesh, math, os, sys, time, json, argparse, shutil, subprocess, urllib.request
import numpy as np
from mathutils import Vector, noise as mnoise

HERE = os.path.dirname(os.path.abspath(__file__))
T0 = time.time()


def parse():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser()
    p.add_argument('--still', type=int, help='render satu frame')
    p.add_argument('--anim', action='store_true', help='render frame start..end + encode MP4')
    p.add_argument('--encode-only', action='store_true')
    p.add_argument('--start', type=int, default=1)
    p.add_argument('--end', type=int, default=120)
    p.add_argument('--samples', type=int, default=1024)
    p.add_argument('--device', default='AUTO', choices=['AUTO', 'CPU', 'GPU'])
    p.add_argument('--scale', type=int, default=100, help='persen resolusi (preview saja)')
    p.add_argument('--density', type=float, default=1.0, help='pengali jumlah daun/rumput (preview saja)')
    p.add_argument('--crop', default=None, help='x0,x1,y0,y1 (0..1) render sebagian frame')
    p.add_argument('--out', default=os.path.join(HERE, 'render'))
    p.add_argument('--assets', default=os.path.join(HERE, 'assets'))
    p.add_argument('--tag', default='')
    p.add_argument('--save-blend', default=None)
    p.add_argument('--threads', type=int, default=0)
    p.add_argument('--reverse', action='store_true', help='render dari frame akhir mundur')
    p.add_argument('--budget', type=float, default=0, help='batas detik; berhenti rapi sebelum frame yang ga bakal keburu')
    p.add_argument('--frame-guess', type=float, default=2700, help='perkiraan detik per frame sebelum ada ukuran')
    return p.parse_args(argv)


ARGS = parse()
os.makedirs(ARGS.out, exist_ok=True)
os.makedirs(ARGS.assets, exist_ok=True)
LOGFILE = os.path.join(ARGS.out, 'render.log')


def log(*a):
    s = '[%7.1fs] ' % (time.time() - T0) + ' '.join(str(x) for x in a)
    print(s, flush=True)
    with open(LOGFILE, 'a') as f:
        f.write(time.strftime('%H:%M:%S ') + s + '\n')


RNG = np.random.default_rng(11)
DENS = ARGS.density

# --------------------------------------------------------------------------------------
# Tata letak (meter). Kamera tengah ngadep pojok (+x, -y) rumah.
# --------------------------------------------------------------------------------------
SITE = 6.0                                  # setengah lebar tapak 12 x 12
X0, X1, Y0, Y1 = -5.2, 1.8, -1.8, 5.2       # tapak rumah 7 x 7
NX, NY = X1 - 2.5, Y0 + 2.5                 # coakan teras 2.5 x 2.5 di pojok (+x,-y)
FL = 0.30                                   # level lantai
COURSE, BL, BH, BD, MJ = 0.075, 0.215, 0.065, 0.1025, 0.010   # modul bata
NROWS = 38
WTOP = FL + NROWS * COURSE                  # 3.15, + coping 6 cm = 3.21
WT = 0.30                                   # tebal dinding total
CEIL = 2.80
SUN_AZ = math.atan2(-0.30, 1.0)             # arah ke matahari (dari kanan kamera)
SUN_EL = math.radians(24.0)
CAM_EL = math.radians(35.0)
CAM_AZ0 = math.radians(-45.0)
ORBIT = math.radians(40.0)

SLABS = [  # cx, cy, sx, sy, yaw(deg)
    (3.45, -0.58, 1.45, 2.05, 1.5), (3.95, -2.42, 1.75, 1.00, -3.0), (2.95, -3.55, 1.10, 0.92, 4.0),
    (4.55, -3.85, 1.50, 1.00, -2.0), (1.30, -4.00, 1.60, 1.00, 3.0), (-0.50, -3.55, 1.25, 0.92, -5.0),
    (-2.05, -4.20, 1.50, 1.00, 2.5), (4.30, 1.55, 1.05, 1.50, -3.0), (4.05, 3.20, 1.10, 1.40, 4.0),
]
ROCKS = [  # cx, cy, ukuran
    (2.15, -5.05, 0.34), (2.62, -4.82, 0.20), (1.86, -4.72, 0.15),
    (5.10, -5.05, 0.30), (4.72, -5.30, 0.16),
    (-1.15, -5.25, 0.26), (-0.80, -5.00, 0.14),
    (5.25, 2.45, 0.28), (5.05, 2.05, 0.15), (5.40, 2.85, 0.13),
    (-5.10, -5.10, 0.30), (-4.75, -5.35, 0.15),
    (-4.95, -2.45, 0.22), (-0.95, -2.35, 0.17), (2.85, 5.25, 0.25),
]
CLUMPS = [  # cx, cy, tinggi, kering(0..1)
    (-4.55, -2.55, 0.95, 0.35), (-1.55, -2.50, 0.80, 0.65), (-3.05, -5.30, 1.05, 0.50),
    (0.55, -5.35, 0.90, 0.25), (3.40, -5.30, 1.00, 0.70), (5.30, -1.15, 0.85, 0.40),
    (5.35, 0.55, 1.05, 0.60), (2.70, 4.95, 0.90, 0.45), (5.35, 5.30, 1.10, 0.30),
    (-5.30, -3.90, 0.85, 0.55), (1.55, -5.20, 0.70, 0.75), (5.30, -3.10, 0.75, 0.50),
]
GRAVEL_BLOBS = [(2.2, -5.0, 1.0), (4.95, -5.1, 0.9), (-1.0, -5.15, 0.85), (5.25, 2.4, 0.95), (-5.0, -5.0, 1.0),
                (-3.05, -5.3, 0.6), (0.55, -5.35, 0.55), (3.4, -5.3, 0.6), (5.3, -1.15, 0.6), (5.35, 0.55, 0.6),
                (5.35, 5.3, 0.75), (2.75, 5.05, 0.8), (-5.3, -3.9, 0.6), (5.3, -3.1, 0.55), (1.55, -5.2, 0.5)]
TREE_TALL = (-4.05, -3.75)
TREE_SMALL = (5.00, 3.95)
SHRUB = (3.00, 1.08, 0.44)
SKY = (-3.9, -2.8, 3.1, 4.2)                 # lubang skylight di atap
POT = (-0.12, -1.28)
PLANTER = (X1 + 0.03, X1 + 0.60, 1.30, 4.60, 0.44)   # x0,x1,y0,y1,tinggi
STEPS_Y = (-1.70, 0.60)
POST = (X1 + 0.42, Y0 - 0.42)

# --------------------------------------------------------------------------------------
# Aset Poly Haven (CC0)
# --------------------------------------------------------------------------------------
TEX = {'plaster': 'white_plaster_02', 'concrete': 'concrete_floor_worn_001', 'layers': 'concrete_layers_02',
       'wood': 'oak_veneer_01', 'floor': 'oak_wood_planks', 'bark': 'sakura_bark', 'rock': 'dark_rock',
       'soil': 'forrest_ground_01', 'pebble': 'floor_pebbles_01'}
HDRI = 'lonely_road_afternoon_puresky'
HDRI_SUN_U = 0.600          # posisi matahari di HDRI ini (diukur dari piksel paling terang)
TEXFILES = {}
MISSING = []
UA = {'User-Agent': 'Mozilla/5.0 (diorama-render)'}


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return True
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r, \
                open(path + '.part', 'wb') as f:
            shutil.copyfileobj(r, f)
        os.replace(path + '.part', path)
        return True
    except Exception as e:
        log('UNDUH GAGAL', url, repr(e))
        return False


def ph_files(slug):
    cache = os.path.join(ARGS.assets, slug + '.json')
    if not os.path.exists(cache):
        with urllib.request.urlopen(urllib.request.Request('https://api.polyhaven.com/files/' + slug, headers=UA),
                                    timeout=60) as r:
            open(cache, 'wb').write(r.read())
    return json.load(open(cache))


def ensure_assets():
    for key, slug in TEX.items():
        want = {k: os.path.join(ARGS.assets, '%s_%s_2k.jpg' % (slug, k)) for k in ('diff', 'rough', 'disp')}
        if not all(os.path.exists(p) for p in want.values()):
            try:
                d = ph_files(slug)
                for k, kk in (('diff', 'Diffuse'), ('rough', 'Rough'), ('disp', 'Displacement')):
                    fetch(d[kk]['2k']['jpg']['url'], want[k])
            except Exception as e:
                log('API Poly Haven gagal untuk', slug, repr(e))
        if all(os.path.exists(p) for p in want.values()):
            TEXFILES[key] = want
        else:
            MISSING.append(slug)
    hp = os.path.join(ARGS.assets, HDRI + '_4k.hdr')
    if not os.path.exists(hp):
        try:
            fetch(ph_files(HDRI)['hdri']['4k']['hdr']['url'], hp)
        except Exception as e:
            log('API Poly Haven gagal untuk HDRI', repr(e))
    if os.path.exists(hp):
        TEXFILES['hdri'] = hp
    else:
        MISSING.append(HDRI)
    log('aset siap; yang gagal:', MISSING or 'tidak ada')


# --------------------------------------------------------------------------------------
# Pembangun mesh
# --------------------------------------------------------------------------------------
class Geo:
    def __init__(s):
        s.V, s.I, s.S, s.M, s.A, s.UV = [], [], [], [], {}, []
        s.nv = s.nl = s.nf = 0

    def add(s, verts, faces, attrs=None, uvs=None, mat=0):
        verts = np.asarray(verts, np.float32).reshape(-1, 3)
        if not isinstance(faces, (list, tuple)):
            faces = [faces]
        if uvs is not None and not isinstance(uvs, (list, tuple)):
            uvs = [uvs]
        for i, F in enumerate(faces):
            F = np.asarray(F)
            k = F.shape[-1]
            F = F.reshape(-1, k)
            s.I.append((F + s.nv).ravel().astype(np.int32))
            s.S.append(np.full(len(F), k, np.int32))
            s.M.append(np.full(len(F), mat, np.int32))
            if uvs is not None:
                s.UV.append((s.nl, np.asarray(uvs[i], np.float32).reshape(-1, 2)))
            s.nl += F.size
            s.nf += len(F)
        for k, a in (attrs or {}).items():
            a = np.asarray(a, np.float32)
            if a.ndim == 1:
                a = a[:, None]
            s.A.setdefault(k, []).append((s.nv, a))
        s.V.append(verts)
        s.nv += len(verts)

    def build(s, name, mats, smooth=False):
        me = bpy.data.meshes.new(name)
        V = np.concatenate(s.V)
        I = np.concatenate(s.I)
        S = np.concatenate(s.S)
        st = np.zeros(len(S), np.int32)
        st[1:] = np.cumsum(S)[:-1]
        me.vertices.add(len(V))
        me.loops.add(len(I))
        me.polygons.add(len(S))
        me.vertices.foreach_set('co', V.ravel())
        me.loops.foreach_set('vertex_index', I)
        me.polygons.foreach_set('loop_start', st)
        try:
            me.polygons.foreach_set('loop_total', S)
        except Exception:
            pass
        me.polygons.foreach_set('material_index', np.concatenate(s.M))
        me.polygons.foreach_set('use_smooth', np.full(len(S), bool(smooth)))
        for k, chunks in s.A.items():
            dim = chunks[0][1].shape[1]
            arr = np.zeros((len(V), dim), np.float32)
            for off, a in chunks:
                arr[off:off + len(a)] = a
            if dim == 1:
                me.attributes.new(k, 'FLOAT', 'POINT').data.foreach_set('value', arr.ravel())
            elif dim == 3:
                me.attributes.new(k, 'FLOAT_VECTOR', 'POINT').data.foreach_set('vector', arr.ravel())
            else:
                me.attributes.new(k, 'FLOAT_COLOR', 'POINT').data.foreach_set('color', arr.ravel())
        if s.UV:
            uv = np.zeros((len(I), 2), np.float32)
            for off, a in s.UV:
                uv[off:off + len(a)] = a
            me.uv_layers.new(name='UVMap').data.foreach_set('uv', uv.ravel())
        me.update(calc_edges=True)
        for m in mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        STATS[name] = (len(V), len(S))
        return ob


STATS = {}
_CORN = [(sx, sy, sz) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]


def _box_local(S, b):
    """S (N,3) ukuran penuh, b (N,) bevel -> (N,24,3) kotak dengan semua tepi di-chamfer."""
    N = len(S)
    out = np.zeros((N, 24, 3), np.float32)
    for ci, sg in enumerate(_CORN):
        sg = np.array(sg, np.float32)
        base = sg[None, :] * S / 2
        for a in range(3):
            p = base.copy()
            for o in range(3):
                if o != a:
                    p[:, o] -= sg[o] * b
            out[:, ci * 3 + a] = p
    return out


def _box_topology():
    quads, qax, tris = [], [], []
    for a in range(3):
        b, c = [x for x in range(3) if x != a]
        for s in (-1, 1):
            cs = [ci for ci, cc in enumerate(_CORN) if cc[a] == s]
            cs.sort(key=lambda ci: math.atan2(_CORN[ci][c], _CORN[ci][b]))
            quads.append([ci * 3 + a for ci in cs])
            qax.append(a)
    for i, ci in enumerate(_CORN):
        for j, cj in enumerate(_CORN):
            if j <= i:
                continue
            diff = [k for k in range(3) if ci[k] != cj[k]]
            if len(diff) == 1:
                a, b = [x for x in range(3) if x != diff[0]]
                quads.append([i * 3 + a, j * 3 + a, j * 3 + b, i * 3 + b])
                qax.append(a)
    for i in range(8):
        tris.append([i * 3, i * 3 + 1, i * 3 + 2])
    V = _box_local(np.ones((1, 3), np.float32), np.array([0.1], np.float32))[0]

    def fix(f):
        p = V[f]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        return f if np.dot(n, p.mean(0)) > 0 else f[::-1]
    return np.array([fix(q) for q in quads]), np.array(qax), np.array([fix(t) for t in tris])


BOX_Q, BOX_QAX, BOX_T = _box_topology()
_BC = np.array([[1, 2], [0, 2], [0, 1]])


def add_boxes(geo, C, S, bevel=0.004, yaw=None, rnd=None, uv=False, mat=0, extra=None):
    C = np.asarray(C, np.float32).reshape(-1, 3)
    S = np.asarray(S, np.float32).reshape(-1, 3)
    N = len(C)
    b = np.minimum(np.broadcast_to(np.asarray(bevel, np.float32), (N,)), S.min(1) * 0.45)
    loc = _box_local(S, b)
    W = loc.copy()
    if yaw is not None:
        ya = np.broadcast_to(np.asarray(yaw, np.float32), (N,))
        c, s = np.cos(ya)[:, None], np.sin(ya)[:, None]
        W[..., 0] = loc[..., 0] * c - loc[..., 1] * s
        W[..., 1] = loc[..., 0] * s + loc[..., 1] * c
    W += C[:, None, :]
    off = (np.arange(N) * 24)[:, None, None]
    FQ = BOX_Q[None] + off
    FT = BOX_T[None] + off
    if rnd is None:
        rnd = RNG.random(N)
    attrs = {'rnd': np.repeat(np.asarray(rnd, np.float32), 24)}
    for k, v in (extra or {}).items():
        attrs[k] = np.repeat(np.asarray(v, np.float32), 24, axis=0)
    uvs = None
    if uv:
        uvs = []
        ro = RNG.random((N, 1, 1, 2)).astype(np.float32) * 7.0
        for F, ax in ((BOX_Q, BOX_QAX), (BOX_T, np.zeros(len(BOX_T), int))):
            q = loc[:, F, :]                                    # N,nf,k,3
            nf, k = F.shape
            bi, ci = _BC[ax][:, 0], _BC[ax][:, 1]
            qb = np.take_along_axis(q, np.broadcast_to(bi[None, :, None, None], (N, nf, k, 1)), 3)[..., 0]
            qc = np.take_along_axis(q, np.broadcast_to(ci[None, :, None, None], (N, nf, k, 1)), 3)[..., 0]
            ub = (S[:, bi] >= S[:, ci])[..., None]
            u = np.where(ub, qb, qc)
            v = np.where(ub, qc, qb)
            uvs.append((np.stack([u, v], -1) + ro).reshape(-1, 2))
    geo.add(W.reshape(-1, 3), [FQ.reshape(-1, 4), FT.reshape(-1, 3)], attrs=attrs, uvs=uvs, mat=mat)


class Boxes:
    """Penampung kotak sebelum dijadikan mesh."""

    def __init__(s):
        s.C, s.S, s.B, s.R, s.Y = [], [], [], [], []

    def add(s, c, size, bevel=0.004, rnd=None, yaw=0.0):
        s.C.append(c)
        s.S.append(size)
        s.B.append(bevel)
        s.R.append(RNG.random() if rnd is None else rnd)
        s.Y.append(yaw)

    def span(s, x0, x1, y0, y1, z0, z1, **kw):
        s.add(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)), **kw)

    def to(s, geo, uv=False, mat=0):
        if s.C:
            add_boxes(geo, s.C, s.S, np.array(s.B), yaw=np.array(s.Y), rnd=np.array(s.R), uv=uv, mat=mat)


def ico(sub):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
    V = np.array([v.co[:] for v in bm.verts], np.float32)
    F = np.array([[v.index for v in f.verts] for f in bm.faces])
    bm.free()
    return V, F


def tube(pts, rad, sides):
    pts = np.asarray(pts, float)
    n = len(pts)
    T = np.zeros_like(pts)
    T[1:-1] = pts[2:] - pts[:-2]
    T[0] = pts[1] - pts[0]
    T[-1] = pts[-1] - pts[-2]
    T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-12
    a = np.array([0, 0, 1.0]) if abs(T[0, 2]) < 0.9 else np.array([1.0, 0, 0])
    nr = np.cross(T[0], a)
    nr /= np.linalg.norm(nr)
    Ns = [nr]
    for i in range(1, n):
        v = Ns[-1] - T[i] * np.dot(Ns[-1], T[i])
        Ns.append(v / (np.linalg.norm(v) + 1e-12))
    Ns = np.array(Ns)
    Bn = np.cross(T, Ns)
    ang = np.linspace(0, 2 * math.pi, sides, endpoint=False)
    V = pts[:, None, :] + rad[:, None, None] * (np.cos(ang)[None, :, None] * Ns[:, None, :] +
                                               np.sin(ang)[None, :, None] * Bn[:, None, :])
    idx = np.arange(n * sides).reshape(n, sides)
    nx = np.roll(idx, -1, axis=1)
    F = np.stack([idx[:-1], nx[:-1], nx[1:], idx[1:]], -1).reshape(-1, 4)
    seg = np.linalg.norm(pts[1:] - pts[:-1], axis=1)
    vv = np.concatenate([[0], np.cumsum(seg / (2 * math.pi * np.maximum((rad[:-1] + rad[1:]) / 2, 2e-3)))])
    u0 = np.arange(sides) / sides
    u1 = u0 + 1.0 / sides
    UV = np.zeros((n - 1, sides, 4, 2), np.float32)
    UV[:, :, 0, 0] = u0[None]
    UV[:, :, 1, 0] = u1[None]
    UV[:, :, 2, 0] = u1[None]
    UV[:, :, 3, 0] = u0[None]
    UV[:, :, 0, 1] = vv[:-1, None]
    UV[:, :, 1, 1] = vv[:-1, None]
    UV[:, :, 2, 1] = vv[1:, None]
    UV[:, :, 3, 1] = vv[1:, None]
    return V.reshape(-1, 3), F, UV.reshape(-1, 2)


def lathe(profile, sides=40):
    """profile: list (r, z) -> permukaan putar mengelilingi sumbu z."""
    pr = np.array(profile, float)
    ang = np.linspace(0, 2 * math.pi, sides, endpoint=False)
    V = np.stack([pr[:, 0:1] * np.cos(ang)[None], pr[:, 0:1] * np.sin(ang)[None],
                  np.repeat(pr[:, 1:2], sides, 1)], -1)
    n = len(pr)
    idx = np.arange(n * sides).reshape(n, sides)
    nx = np.roll(idx, -1, axis=1)
    F = np.stack([idx[:-1], nx[:-1], nx[1:], idx[1:]], -1).reshape(-1, 4)
    return V.reshape(-1, 3), F


LEAF_T = np.array([[0, 0, 0], [0, .5, -.04], [0, 1, -.10], [-.28, .28, .03], [-.25, .66, .02],
                   [.28, .28, .03], [.25, .66, .02]], np.float32)
LEAF_F = np.array([[0, 5, 1], [5, 6, 1], [6, 2, 1], [2, 4, 1], [4, 3, 1], [3, 0, 1]])


def add_leaves(geo, P, A, size, colors, flat=0.45, bias=(0, 0, 1.0), mat=0):
    P = np.asarray(P, np.float32)
    A = np.asarray(A, np.float32)
    N = len(P)
    if N == 0:
        return
    A = A / (np.linalg.norm(A, axis=1, keepdims=True) + 1e-9)
    up = np.asarray(bias, np.float32)[None] + RNG.normal(0, flat, (N, 3)).astype(np.float32)
    Nn = up - A * np.sum(up * A, 1, keepdims=True)
    Nn /= (np.linalg.norm(Nn, axis=1, keepdims=True) + 1e-9)
    S = np.cross(A, Nn)
    sz = np.asarray(size, np.float32)[:, None, None]
    V = P[:, None, :] + sz * (LEAF_T[None, :, 0:1] * S[:, None, :] + LEAF_T[None, :, 1:2] * A[:, None, :] +
                              LEAF_T[None, :, 2:3] * Nn[:, None, :])
    F = LEAF_F[None] + (np.arange(N) * 7)[:, None, None]
    geo.add(V.reshape(-1, 3), F.reshape(-1, 3), attrs={'col': np.repeat(colors, 7, axis=0)}, mat=mat)


def autumn_colors(n, bias=0.0, green=0.07):
    yellow = np.array([0.78, 0.47, 0.035])
    orange = np.array([0.78, 0.24, 0.02])
    red = np.array([0.50, 0.065, 0.015])
    t = np.clip(RNG.beta(2.2, 2.2, n) + bias, 0, 1)[:, None]
    c = np.where(t < 0.5, yellow + (orange - yellow) * (t * 2), orange + (red - orange) * ((t - 0.5) * 2))
    g = RNG.random(n) < green
    c[g] = np.array([0.30, 0.34, 0.04]) + RNG.normal(0, 0.03, (g.sum(), 3))
    b = RNG.random(n) < 0.05
    c[b] = np.array([0.24, 0.11, 0.03])
    c = np.clip(c * RNG.uniform(0.72, 1.18, (n, 1)), 0, 1)
    return np.concatenate([c, np.ones((n, 1))], 1).astype(np.float32)


def add_ribbons(geo, base, d0, L, droop, width, col0, col1, nseg=7, mat=0, wdir=None):
    """Bilah melengkung (rumput hias dsb). col0 pangkal, col1 ujung (N,3)."""
    base = np.asarray(base, np.float32)
    N = len(base)
    if N == 0:
        return
    d0 = np.asarray(d0, np.float32)
    d0 = d0 / (np.linalg.norm(d0, axis=1, keepdims=True) + 1e-9)
    s = np.linspace(0, 1, nseg + 1, dtype=np.float32)
    hor = d0.copy()
    hor[:, 2] = 0
    hn = np.linalg.norm(hor, axis=1, keepdims=True)
    rnd_dir = RNG.normal(0, 1, (N, 3)).astype(np.float32)
    rnd_dir[:, 2] = 0
    hor = np.where(hn > 1e-3, hor / (hn + 1e-9), rnd_dir / (np.linalg.norm(rnd_dir, axis=1, keepdims=True) + 1e-9))
    L = np.asarray(L, np.float32)[:, None, None]
    dr = np.asarray(droop, np.float32)[:, None, None]
    ss = s[None, :, None]
    cen = base[:, None, :] + L * ss * d0[:, None, :] + L * dr * ss ** 2.3 * (hor[:, None, :] * 0.75 -
                                                                         np.array([0, 0, 0.55], np.float32))
    if wdir is None:
        wdir = np.cross(hor, np.array([0, 0, 1.0], np.float32))
    wd = np.asarray(width, np.float32)[:, None] * (1 - s[None, :] ** 1.6) * (0.55 + 0.45 * np.minimum(s[None, :] * 6, 1))
    V = np.stack([cen - wdir[:, None, :] * wd[..., None] / 2, cen + wdir[:, None, :] * wd[..., None] / 2], 2)
    idx = np.arange(N * (nseg + 1) * 2).reshape(N, nseg + 1, 2)
    F = np.stack([idx[:, :-1, 0], idx[:, :-1, 1], idx[:, 1:, 1], idx[:, 1:, 0]], -1).reshape(-1, 4)
    col = col0[:, None, :] * (1 - ss ** 1.3) + col1[:, None, :] * ss ** 1.3
    col = np.concatenate([col, np.broadcast_to(ss, (N, nseg + 1, 1))], -1)
    col = np.repeat(col[:, :, None, :], 2, axis=2)
    geo.add(V.reshape(-1, 3), F, attrs={'col': col.reshape(-1, 4)}, mat=mat)


# --------------------------------------------------------------------------------------
# Node material
# --------------------------------------------------------------------------------------
Sock = bpy.types.NodeSocket


def c4(c):
    return (c[0], c[1], c[2], 1.0)


def new_mat(name):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    m.node_tree.nodes.clear()
    return m, m.node_tree


def _set(nt, sock, v):
    if isinstance(v, Sock):
        nt.links.new(v, sock)
    else:
        sock.default_value = v


def _in(node, key):
    if isinstance(key, int):
        return node.inputs[key]
    for s in node.inputs:
        if s.identifier == key:
            return s
    return node.inputs[key]


def node(nt, typ, ins=None, **props):
    n = nt.nodes.new(typ)
    for k, v in props.items():
        setattr(n, k, v)
    for k, v in (ins or {}).items():
        _set(nt, _in(n, k), v)
    return n


def fmath(nt, op, a, b=0.0, clamp=False):
    return node(nt, 'ShaderNodeMath', {0: a, 1: b}, operation=op, use_clamp=clamp).outputs[0]


def mixc(nt, fac, a, b, blend='MIX'):
    n = node(nt, 'ShaderNodeMix', data_type='RGBA', blend_type=blend)
    for key, v in (('Factor_Float', fac), ('A_Color', a), ('B_Color', b)):
        if not isinstance(v, Sock) and key != 'Factor_Float':
            v = c4(v)
        _set(nt, _in(n, key), v)
    return [o for o in n.outputs if o.identifier == 'Result_Color'][0]


def mulc(nt, col, val):
    """warna x skalar/warna"""
    if not isinstance(val, Sock) and not isinstance(val, (tuple, list)):
        val = (val, val, val)
    return mixc(nt, 1.0, col, val, 'MULTIPLY')


def mapr(nt, v, a, b, c, d):
    n = node(nt, 'ShaderNodeMapRange', {0: v, 1: a, 2: b, 3: c, 4: d})
    n.clamp = True
    return n.outputs[0]


def noise(nt, vec, scale, detail=3.0, rough=0.5):
    n = node(nt, 'ShaderNodeTexNoise', {'Scale': scale, 'Detail': detail, 'Roughness': rough})
    if vec is not None:
        nt.links.new(vec, n.inputs['Vector'])
    return n.outputs[0]


def mapping(nt, vec, scale=(1, 1, 1), rot=(0, 0, 0), loc=(0, 0, 0)):
    return node(nt, 'ShaderNodeMapping', {'Vector': vec, 'Location': loc, 'Rotation': rot, 'Scale': scale}).outputs[0]


def bump(nt, height, strength, dist, normal=None):
    ins = {'Strength': strength, 'Distance': dist, 'Height': height}
    if normal is not None:
        ins['Normal'] = normal
    return node(nt, 'ShaderNodeBump', ins).outputs[0]


def attr(nt, name):
    return node(nt, 'ShaderNodeAttribute', attribute_name=name)       # out: 0 Color, 1 Vector, 2 Fac, 3 Alpha


def objco(nt):
    return node(nt, 'ShaderNodeTexCoord').outputs['Object']


def geom(nt):
    return node(nt, 'ShaderNodeNewGeometry')


def posz(nt):
    return node(nt, 'ShaderNodeSeparateXYZ', {0: geom(nt).outputs['Position']}).outputs[2]


def principled(nt, **kw):
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    for k, v in kw.items():
        s = b.inputs.get(k.replace('_', ' '))
        if s is None:
            log('WARN input Principled tidak ada:', k)
            continue
        if not isinstance(v, Sock) and s.type == 'RGBA' and len(v) == 3:
            v = c4(v)
        _set(nt, s, v)
    return b.outputs[0]


def out(nt, shader):
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(shader, o.inputs['Surface'])


def mix_shader(nt, fac, a, b):
    return node(nt, 'ShaderNodeMixShader', {0: fac, 1: a, 2: b}).outputs[0]


def tex_set(nt, key, vec, box=True, blend=0.25):
    info = TEXFILES.get(key)
    if info is None:        # cadangan prosedural kalau unduhan gagal
        n1 = noise(nt, vec, 6.0, 6.0, 0.6)
        return {'color': mixc(nt, n1, (0.35, 0.34, 0.33), (0.6, 0.59, 0.57)), 'rough': mapr(nt, n1, 0, 1, 0.5, 0.9),
                'height': noise(nt, vec, 40.0, 5.0, 0.6)}

    def img(path, cs):
        im = bpy.data.images.load(path, check_existing=True)
        im.colorspace_settings.name = cs
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = im
        if box:
            n.projection = 'BOX'
            n.projection_blend = blend
        nt.links.new(vec, n.inputs['Vector'])
        return n.outputs[0]
    return {'color': img(info['diff'], 'sRGB'), 'rough': img(info['rough'], 'Non-Color'),
            'height': img(info['disp'], 'Non-Color')}


MATS = {}


def mat_paint():
    m, nt = new_mat('cat_putih')
    obj = objco(nt)
    T = tex_set(nt, 'plaster', mapping(nt, obj, scale=(0.75,) * 3))
    rnd = attr(nt, 'rnd').outputs[2]
    z = posz(nt)
    base = mixc(nt, 0.28, (0.77, 0.755, 0.715), T['color'])
    base = mulc(nt, base, mapr(nt, rnd, 0, 1, 0.90, 1.05))
    base = mulc(nt, base, mapr(nt, rnd, 0.0, 0.1, 0.80, 1.0))
    base = mulc(nt, base, mapr(nt, noise(nt, obj, 1.1, 4.0), 0.3, 0.7, 0.93, 1.02))
    dirt = fmath(nt, 'MULTIPLY', mapr(nt, z, FL, FL + 0.85, 1.0, 0.0),
                 mapr(nt, noise(nt, obj, 3.5, 5.0, 0.6), 0.40, 0.62, 0.0, 1.0))
    base = mixc(nt, fmath(nt, 'MULTIPLY', dirt, 0.55), base, (0.33, 0.29, 0.22))
    streak = noise(nt, mapping(nt, obj, scale=(11.0, 11.0, 0.45)), 1.0, 3.0, 0.5)
    topm = fmath(nt, 'MULTIPLY', mapr(nt, z, WTOP - 1.1, WTOP, 0.0, 1.0), mapr(nt, streak, 0.48, 0.64, 0.0, 1.0))
    base = mixc(nt, fmath(nt, 'MULTIPLY', topm, 0.38), base, (0.30, 0.285, 0.26))
    rough = fmath(nt, 'ADD', mapr(nt, T['rough'], 0, 1, 0.42, 0.72), fmath(nt, 'MULTIPLY', dirt, 0.15))
    h = fmath(nt, 'ADD', T['height'], fmath(nt, 'MULTIPLY', noise(nt, obj, 160.0, 2.0), 0.25))
    out(nt, principled(nt, Base_Color=base, Roughness=rough, Normal=bump(nt, h, 0.45, 0.004)))
    return m


def mat_concrete(name, key='concrete', tile=1.6, tint=(1, 1, 1), bump_s=0.6, grime=0.5, moss=None, lines=False):
    m, nt = new_mat(name)
    obj = objco(nt)
    rnd = attr(nt, 'rnd').outputs[2]
    off = node(nt, 'ShaderNodeCombineXYZ', {0: fmath(nt, 'MULTIPLY', rnd, 13.7), 1: fmath(nt, 'MULTIPLY', rnd, 7.3),
                                           2: fmath(nt, 'MULTIPLY', rnd, 3.1)}).outputs[0]
    vec = node(nt, 'ShaderNodeVectorMath', {0: mapping(nt, obj, scale=(1 / tile,) * 3), 1: off}).outputs[0]
    T = tex_set(nt, key, vec)
    g = geom(nt)
    col = mulc(nt, T['color'], tint)
    col = mulc(nt, col, mapr(nt, rnd, 0, 1, 0.80, 1.08))
    col = mulc(nt, col, mapr(nt, noise(nt, obj, 0.9, 5.0, 0.6), 0.38, 0.62, 1.0 - 0.5 * grime, 1.06))
    col = mulc(nt, col, mapr(nt, noise(nt, obj, 4.5, 6.0, 0.7), 0.36, 0.64, 1.0 - 0.38 * grime, 1.10))
    col = mixc(nt, mapr(nt, noise(nt, obj, 2.2, 7.0, 0.75), 0.54, 0.66, 0.0, 0.55 * grime), col, (0.16, 0.15, 0.13))
    nz = node(nt, 'ShaderNodeSeparateXYZ', {0: g.outputs['Normal']}).outputs[2]
    vert = mapr(nt, fmath(nt, 'ABSOLUTE', nz), 0.2, 0.6, 1.0, 0.0)
    streak = mapr(nt, noise(nt, mapping(nt, obj, scale=(7.0, 7.0, 0.5)), 1.0, 3.0), 0.46, 0.62, 0.0, 1.0)
    col = mixc(nt, fmath(nt, 'MULTIPLY', fmath(nt, 'MULTIPLY', vert, streak), 0.35 * grime), col, (0.13, 0.125, 0.115))
    wear = mapr(nt, g.outputs['Pointiness'], 0.52, 0.66, 0.0, 1.0)
    col = mixc(nt, fmath(nt, 'MULTIPLY', wear, 0.5), col, (0.62, 0.61, 0.58))
    h = T['height']
    if lines:   # bekas papan bekisting
        z = posz(nt)
        saw = fmath(nt, 'FRACT', fmath(nt, 'MULTIPLY', z, 1 / 0.15))
        groove = mapr(nt, fmath(nt, 'ABSOLUTE', fmath(nt, 'SUBTRACT', saw, 0.5)), 0.44, 0.5, 0.0, 1.0)
        h = fmath(nt, 'SUBTRACT', h, fmath(nt, 'MULTIPLY', groove, 0.6))
        col = mulc(nt, col, mapr(nt, groove, 0, 1, 1.0, 0.8))
    if moss is not None:
        z = posz(nt)
        mm = fmath(nt, 'MULTIPLY', mapr(nt, z, moss[0], moss[1], 1.0, 0.0),
                   mapr(nt, noise(nt, obj, 5.0, 5.0, 0.65), 0.4, 0.7, 0.0, 1.0))
        col = mixc(nt, fmath(nt, 'MULTIPLY', mm, 0.6), col, (0.10, 0.11, 0.05))
    rough = mapr(nt, T['rough'], 0, 1, 0.55, 0.92)
    h = fmath(nt, 'ADD', h, fmath(nt, 'MULTIPLY', noise(nt, obj, 220.0, 2.0), 0.15))
    out(nt, principled(nt, Base_Color=col, Roughness=rough, Normal=bump(nt, h, bump_s, 0.006)))
    return m


def mat_wood(name, tint=(1, 1, 1), tile=1.1, rough=(0.38, 0.7), weather=0.0, value=(0.78, 1.12), coat=0.0):
    m, nt = new_mat(name)
    uv = node(nt, 'ShaderNodeTexCoord').outputs['UV']
    rnd = attr(nt, 'rnd').outputs[2]
    r2 = fmath(nt, 'FRACT', fmath(nt, 'MULTIPLY', rnd, 7.31))
    off = node(nt, 'ShaderNodeCombineXYZ', {0: fmath(nt, 'MULTIPLY', rnd, 5.7), 1: fmath(nt, 'MULTIPLY', r2, 3.3)}).outputs[0]
    vec = mapping(nt, node(nt, 'ShaderNodeVectorMath', {0: uv, 1: off}).outputs[0],
                  scale=(1 / tile, 1 / tile, 1), rot=(0, 0, math.pi / 2))
    T = tex_set(nt, 'wood', vec, box=False)
    col = mulc(nt, T['color'], tint)
    col = mulc(nt, col, mapr(nt, r2, 0, 1, value[0], value[1]))
    obj = objco(nt)
    if weather > 0:
        w = mapr(nt, noise(nt, obj, 2.5, 5.0, 0.6), 0.3, 0.75, 0.0, 1.0)
        col = mixc(nt, fmath(nt, 'MULTIPLY', w, weather), col, (0.22, 0.20, 0.17))
    ro = mapr(nt, T['rough'], 0, 1, rough[0], rough[1])
    h = fmath(nt, 'ADD', T['height'], fmath(nt, 'MULTIPLY', noise(nt, mapping(nt, vec, scale=(60, 4, 1)), 8.0, 3.0), 0.35))
    kw = dict(Base_Color=col, Roughness=ro, Normal=bump(nt, h, 0.5, 0.0025))
    if coat > 0:
        kw['Coat_Weight'] = coat
        kw['Coat_Roughness'] = 0.25
    out(nt, principled(nt, **kw))
    return m


def mat_metal_dark(name, color=(0.018, 0.018, 0.02), rough=0.42, metallic=0.0):
    m, nt = new_mat(name)
    obj = objco(nt)
    g = geom(nt)
    nz = node(nt, 'ShaderNodeSeparateXYZ', {0: g.outputs['Normal']}).outputs[2]
    dust = fmath(nt, 'MULTIPLY', mapr(nt, nz, 0.5, 1.0, 0.0, 1.0), mapr(nt, noise(nt, obj, 6.0, 4.0), 0.3, 0.7, 0.2, 1.0))
    col = mixc(nt, fmath(nt, 'MULTIPLY', dust, 0.35), color, (0.25, 0.22, 0.18))
    wear = mapr(nt, g.outputs['Pointiness'], 0.55, 0.7, 0.0, 0.5)
    col = mixc(nt, wear, col, (0.16, 0.16, 0.165))
    ro = fmath(nt, 'ADD', mapr(nt, noise(nt, obj, 25.0, 4.0), 0.3, 0.7, rough - 0.08, rough + 0.12),
               fmath(nt, 'MULTIPLY', dust, 0.25))
    out(nt, principled(nt, Base_Color=col, Roughness=ro, Metallic=metallic,
                       Normal=bump(nt, noise(nt, obj, 300.0, 2.0), 0.08, 0.001)))
    return m


def mat_glass():
    m, nt = new_mat('kaca')
    obj = objco(nt)
    smudge = mapr(nt, noise(nt, obj, 3.0, 4.0, 0.6), 0.45, 0.8, 0.0, 0.035)
    gl = node(nt, 'ShaderNodeBsdfGlass', {'Color': (0.93, 0.975, 0.96, 1), 'Roughness': smudge, 'IOR': 1.52}).outputs[0]
    tr = node(nt, 'ShaderNodeBsdfTransparent', {'Color': (0.90, 0.95, 0.93, 1)}).outputs[0]
    lp = node(nt, 'ShaderNodeLightPath')
    out(nt, mix_shader(nt, lp.outputs['Is Shadow Ray'], gl, tr))
    return m


def mat_foliage(name, trans=0.42, rough=0.42, tip=None, var=0.18, bump_scale=0.0):
    m, nt = new_mat(name)
    a = attr(nt, 'col')
    obj = objco(nt)
    col = mulc(nt, a.outputs[0], mapr(nt, noise(nt, obj, 9.0, 3.0), 0.25, 0.75, 1.0 - var, 1.0 + var))
    if tip is not None:
        col = mixc(nt, fmath(nt, 'MULTIPLY', fmath(nt, 'POWER', a.outputs[3], 1.6), tip[1]), col, tip[0])
    kw = dict(Base_Color=col, Roughness=rough)
    if bump_scale:
        kw['Normal'] = bump(nt, noise(nt, obj, bump_scale, 2.0), 0.3, 0.002)
    d = principled(nt, **kw)
    t = node(nt, 'ShaderNodeBsdfTranslucent', {'Color': mixc(nt, 1.0, col, (1.25, 1.15, 0.8), 'MULTIPLY')}).outputs[0]
    out(nt, mix_shader(nt, trans, d, t))
    return m


def mat_bark():
    m, nt = new_mat('kulit_kayu')
    uv = node(nt, 'ShaderNodeTexCoord').outputs['UV']
    T = tex_set(nt, 'bark', mapping(nt, uv, scale=(2.0, 1.2, 1.0)), box=False)
    lvl = attr(nt, 'lvl').outputs[2]
    col = mulc(nt, T['color'], (0.72, 0.62, 0.55))
    col = mixc(nt, mapr(nt, lvl, 0.3, 1.0, 0.0, 0.85), col, (0.075, 0.05, 0.038))
    out(nt, principled(nt, Base_Color=col, Roughness=mapr(nt, T['rough'], 0, 1, 0.55, 0.9),
                       Normal=bump(nt, T['height'], 0.9, 0.012)))
    return m


def mat_rock():
    m, nt = new_mat('batu')
    obj = objco(nt)
    rnd = attr(nt, 'rnd').outputs[2]
    off = node(nt, 'ShaderNodeCombineXYZ', {0: fmath(nt, 'MULTIPLY', rnd, 9.1), 1: fmath(nt, 'MULTIPLY', rnd, 4.3),
                                           2: fmath(nt, 'MULTIPLY', rnd, 6.7)}).outputs[0]
    vec = node(nt, 'ShaderNodeVectorMath', {0: mapping(nt, obj, scale=(1.3,) * 3), 1: off}).outputs[0]
    T = tex_set(nt, 'rock', vec, blend=0.35)
    col = mixc(nt, 0.25, mulc(nt, T['color'], 2.4), (0.20, 0.20, 0.205))
    col = mulc(nt, col, mapr(nt, rnd, 0, 1, 0.8, 1.25))
    g = geom(nt)
    nz = node(nt, 'ShaderNodeSeparateXYZ', {0: g.outputs['Normal']}).outputs[2]
    dust = fmath(nt, 'MULTIPLY', mapr(nt, nz, 0.45, 0.95, 0.0, 1.0), mapr(nt, noise(nt, obj, 7.0, 5.0, 0.6), 0.35, 0.7, 0.0, 1.0))
    col = mixc(nt, fmath(nt, 'MULTIPLY', dust, 0.4), col, (0.22, 0.21, 0.185))
    lich = mapr(nt, noise(nt, obj, 14.0, 4.0, 0.7), 0.66, 0.74, 0.0, 0.5)
    col = mixc(nt, lich, col, (0.26, 0.27, 0.20))
    h = fmath(nt, 'ADD', T['height'], fmath(nt, 'MULTIPLY', noise(nt, obj, 90.0, 3.0), 0.12))
    out(nt, principled(nt, Base_Color=col, Roughness=mapr(nt, T['rough'], 0, 1, 0.78, 0.96),
                       Normal=bump(nt, h, 1.0, 0.06)))
    return m


def mat_ground():
    m, nt = new_mat('tanah')
    obj = objco(nt)
    gr = attr(nt, 'gravel').outputs[2]
    S = tex_set(nt, 'soil', mapping(nt, obj, scale=(0.55,) * 3), box=False)
    P = tex_set(nt, 'pebble', mapping(nt, obj, scale=(1.4,) * 3), box=False)
    soil = mulc(nt, S['color'], (0.42, 0.40, 0.34))
    peb = mixc(nt, 0.5, P['color'], (0.62, 0.60, 0.55))
    col = mixc(nt, gr, soil, peb)
    h = mixc(nt, gr, S['height'], P['height'])
    out(nt, principled(nt, Base_Color=col, Roughness=0.9, Normal=bump(nt, h, 0.8, 0.02)))
    return m


def mat_pebble():
    m, nt = new_mat('kerikil')
    a = attr(nt, 'col')
    obj = objco(nt)
    sp = mapr(nt, noise(nt, obj, 260.0, 3.0, 0.6), 0.3, 0.7, 0.86, 1.06)
    col = mulc(nt, a.outputs[0], sp)
    out(nt, principled(nt, Base_Color=col, Roughness=mapr(nt, noise(nt, obj, 60.0, 2.0), 0.3, 0.7, 0.5, 0.8),
                       Normal=bump(nt, noise(nt, obj, 420.0, 3.0), 0.25, 0.002)))
    return m


def mat_simple(name, color, rough=0.6, nscale=40.0, nstr=0.15, var=0.08, sheen=0.0, metallic=0.0):
    m, nt = new_mat(name)
    obj = objco(nt)
    col = mulc(nt, color if isinstance(color, Sock) else c4(color),
               mapr(nt, noise(nt, obj, 2.2, 4.0), 0.3, 0.7, 1.0 - var, 1.0 + var))
    kw = dict(Base_Color=col, Roughness=mapr(nt, noise(nt, obj, nscale * 0.3, 3.0), 0.3, 0.7, rough - 0.07, rough + 0.1),
              Normal=bump(nt, noise(nt, obj, nscale, 3.0), nstr, 0.002), Metallic=metallic)
    if sheen:
        kw['Sheen_Weight'] = sheen
    out(nt, principled(nt, **kw))
    return m


def mat_backdrop():
    m, nt = new_mat('backdrop')
    out(nt, principled(nt, Base_Color=(0.82, 0.70, 0.53), Roughness=0.92, Specular_IOR_Level=0.2))
    return m


def mat_roof():
    m, nt = new_mat('atap')
    obj = objco(nt)
    P = tex_set(nt, 'pebble', mapping(nt, obj, scale=(1.1,) * 3))
    col = mixc(nt, 0.45, P['color'], (0.27, 0.265, 0.25))
    col = mulc(nt, col, mapr(nt, noise(nt, obj, 0.45, 6.0, 0.65), 0.3, 0.7, 0.62, 1.12))
    col = mixc(nt, mapr(nt, noise(nt, obj, 1.6, 5.0, 0.7), 0.55, 0.75, 0.0, 0.45), col, (0.13, 0.12, 0.10))
    out(nt, principled(nt, Base_Color=col, Roughness=0.88, Normal=bump(nt, P['height'], 0.9, 0.015)))
    return m


def mat_floor():
    m, nt = new_mat('lantai_dalam')
    obj = objco(nt)
    T = tex_set(nt, 'floor', mapping(nt, obj, scale=(0.5,) * 3))
    out(nt, principled(nt, Base_Color=mulc(nt, T['color'], (0.9, 0.85, 0.8)),
                       Roughness=mapr(nt, T['rough'], 0, 1, 0.22, 0.5), Normal=bump(nt, T['height'], 0.3, 0.002)))
    return m


def mat_curtain():
    m, nt = new_mat('gorden')
    obj = objco(nt)
    weave = mapr(nt, noise(nt, mapping(nt, obj, scale=(1, 300, 300)), 1.0, 2.0), 0.3, 0.7, 0.85, 1.0)
    col = mulc(nt, c4((0.86, 0.83, 0.77)), weave)
    d = principled(nt, Base_Color=col, Roughness=0.8, Sheen_Weight=0.3)
    t = node(nt, 'ShaderNodeBsdfTranslucent', {'Color': col}).outputs[0]
    body = mix_shader(nt, 0.55, d, t)
    tr = node(nt, 'ShaderNodeBsdfTransparent').outputs[0]
    out(nt, mix_shader(nt, 0.45, body, tr))
    return m


def mat_emit(name, color, strength):
    m, nt = new_mat(name)
    e = node(nt, 'ShaderNodeEmission', {'Color': c4(color), 'Strength': strength}).outputs[0]
    out(nt, e)
    return m


def mat_bigleaf():
    m, nt = new_mat('daun_lebar')
    uv = node(nt, 'ShaderNodeTexCoord').outputs['UV']
    sx = node(nt, 'ShaderNodeSeparateXYZ', {0: uv})
    u, v = sx.outputs[0], sx.outputs[1]
    du = fmath(nt, 'ABSOLUTE', fmath(nt, 'SUBTRACT', u, 0.5))
    mid = mapr(nt, du, 0.0, 0.035, 1.0, 0.0)
    ph = fmath(nt, 'SUBTRACT', fmath(nt, 'MULTIPLY', v, 16.0), fmath(nt, 'MULTIPLY', du, 9.0))
    side = mapr(nt, fmath(nt, 'ABSOLUTE', fmath(nt, 'SUBTRACT', fmath(nt, 'FRACT', ph), 0.5)), 0.42, 0.5, 0.0, 1.0)
    vein = fmath(nt, 'MAXIMUM', mid, fmath(nt, 'MULTIPLY', side, 0.6))
    a = attr(nt, 'col')
    col = mixc(nt, fmath(nt, 'MULTIPLY', vein, 0.55), a.outputs[0], (0.16, 0.25, 0.06))
    obj = objco(nt)
    col = mulc(nt, col, mapr(nt, noise(nt, obj, 14.0, 4.0), 0.3, 0.7, 0.8, 1.12))
    d = principled(nt, Base_Color=col, Roughness=mapr(nt, noise(nt, obj, 30.0, 3.0), 0.3, 0.7, 0.22, 0.42),
                   Coat_Weight=0.4, Coat_Roughness=0.15, Normal=bump(nt, fmath(nt, 'MULTIPLY', vein, -1.0), 0.6, 0.004))
    t = node(nt, 'ShaderNodeBsdfTranslucent', {'Color': mulc(nt, col, (1.1, 1.5, 0.5))}).outputs[0]
    out(nt, mix_shader(nt, 0.22, d, t))
    return m


def build_materials():
    M = MATS
    M['paint'] = mat_paint()
    M['concrete'] = mat_concrete('beton', tint=(0.92, 0.91, 0.89), grime=0.6)
    M['slab'] = mat_concrete('beton_pijakan', tint=(1.22, 1.20, 1.15), grime=0.55, bump_s=0.6)
    M['bwall'] = mat_concrete('beton_pagar', tint=(0.64, 0.64, 0.645), grime=0.9, moss=(0.0, 0.3), lines=True, bump_s=0.8)
    M['base'] = mat_concrete('beton_alas', key='layers', tile=2.4, tint=(0.75, 0.74, 0.72), grime=0.6, bump_s=1.0)
    M['canopy'] = mat_concrete('beton_kanopi', tile=1.2, tint=(0.98, 0.97, 0.94), grime=1.1, bump_s=0.7)
    M['coping'] = mat_concrete('beton_coping', tint=(1.12, 1.11, 1.08), grime=0.7, bump_s=0.4)
    M['slat'] = mat_wood('kayu_bilah', tint=(0.80, 0.50, 0.30), weather=0.18, value=(0.7, 1.15))
    M['deck'] = mat_wood('kayu_dek', tint=(0.60, 0.42, 0.29), weather=0.4, rough=(0.5, 0.8), value=(0.75, 1.1))
    M['door'] = mat_wood('kayu_pintu', tint=(0.74, 0.44, 0.25), weather=0.08, rough=(0.3, 0.55), coat=0.25)
    M['planter'] = mat_wood('kayu_bak', tint=(0.66, 0.43, 0.27), weather=0.35, rough=(0.5, 0.8))
    M['furn'] = mat_wood('kayu_furnitur', tint=(0.55, 0.36, 0.22), rough=(0.3, 0.5))
    M['black'] = mat_metal_dark('logam_hitam')
    M['zinc'] = mat_metal_dark('seng', color=(0.12, 0.125, 0.13), rough=0.45, metallic=0.8)
    M['membrane'] = mat_simple('membran', (0.012, 0.012, 0.012), rough=0.85, nscale=80, nstr=0.3)
    M['glass'] = mat_glass()
    M['leaf'] = mat_foliage('daun_pohon', trans=0.45, rough=0.40, var=0.2)
    M['grass'] = mat_foliage('rumput', trans=0.35, rough=0.5, tip=((0.42, 0.37, 0.13, 1), 0.55), var=0.22)
    M['ogress'] = mat_foliage('rumput_hias', trans=0.30, rough=0.55, var=0.15)
    M['bark'] = mat_bark()
    M['rock'] = mat_rock()
    M['ground'] = mat_ground()
    M['pebble'] = mat_pebble()
    M['backdrop'] = mat_backdrop()
    M['roof'] = mat_roof()
    M['floor'] = mat_floor()
    M['intwall'] = mat_simple('dinding_dalam', (0.74, 0.70, 0.62), rough=0.6, nscale=120, nstr=0.1, var=0.04)
    M['sofa'] = mat_simple('kain_sofa', (0.17, 0.16, 0.15), rough=0.9, nscale=600, nstr=0.5, sheen=0.08)
    M['cushion'] = mat_simple('kain_bantal', (0.42, 0.17, 0.05), rough=0.9, nscale=600, nstr=0.5, sheen=0.08)
    M['rug'] = mat_simple('karpet', (0.24, 0.20, 0.16), rough=0.95, nscale=900, nstr=0.8, sheen=0.1, var=0.12)
    M['curtain'] = mat_curtain()
    M['shade'] = mat_emit('kap_lampu', (1.0, 0.60, 0.28), 14.0)
    M['bulb'] = mat_emit('lampu_dinding', (1.0, 0.66, 0.34), 40.0)
    M['pot'] = mat_simple('pot', (0.016, 0.016, 0.017), rough=0.5, nscale=90, nstr=0.25)
    M['soil'] = mat_simple('tanah_pot', (0.05, 0.036, 0.025), rough=0.95, nscale=150, nstr=1.0, var=0.3)
    M['bigleaf'] = mat_bigleaf()
    M['stem'] = mat_simple('tangkai', (0.10, 0.16, 0.05), rough=0.5, nscale=100)


# --------------------------------------------------------------------------------------
# Rumah
# --------------------------------------------------------------------------------------
class Wall:
    def __init__(s, p0, u, L, kind, r):
        s.p0 = np.array(p0, float)
        s.u = np.array(u, float)
        s.n = np.array([u[1], -u[0]], float)      # normal keluar
        s.L, s.kind, s.r, s.open = L, kind, r, []

    def box(s, u0, u1, d0, d1, z0, z1):
        """u sepanjang dinding, d kedalaman dari muka luar (negatif = keluar)."""
        cxy = s.p0 + s.u * (u0 + u1) / 2 - s.n * (d0 + d1) / 2
        su, sd = abs(u1 - u0), abs(d1 - d0)
        sx, sy = (su, sd) if abs(s.u[0]) > 0.5 else (sd, su)
        return (cxy[0], cxy[1], (z0 + z1) / 2), (sx, sy, z1 - z0)


def make_walls():
    W = [Wall((X0, Y0), (1, 0), NX - X0, 'brick', 0.009),      # 0 selatan (kiri-depan)
         Wall((NX, Y0), (0, 1), NY - Y0, 'wood', 0.0),          # 1 coakan, pintu
         Wall((NX, NY), (1, 0), X1 - NX, 'wood', 0.0),          # 2 coakan
         Wall((X1, NY), (0, 1), Y1 - NY, 'brick', 0.009),       # 3 timur (kanan-depan)
         Wall((X1, Y1), (-1, 0), X1 - X0, 'brick', 0.006),      # 4 utara
         Wall((X0, Y1), (0, -1), Y1 - Y0, 'brick', 0.006)]      # 5 barat
    W[0].open = [(1.10, 1.45, FL + 6 * COURSE, FL + 32 * COURSE), (2.45, 2.80, FL + 6 * COURSE, FL + 32 * COURSE)]
    W[3].open = [(0.55, 3.95, FL, FL + 33 * COURSE)]
    W[2].open = [(1.30, 2.25, FL, 2.45)]
    return W


CONCAVE_END = {1}          # dinding 1 berakhir di pojok dalam coakan


def run_range(W, i, d1):
    """Rentang u kotak menerus dinding i supaya pojok tidak tumpang tindih."""
    prev = W[(i - 1) % len(W)]
    a = -prev.r if ((i - 1) % len(W)) in CONCAVE_END else prev.r
    b = W[i].L + d1 if i in CONCAVE_END else W[i].L - d1
    return a, b


def wall_solid(B, w, a, b, d0, d1, z0, z1, bevel=0.002, rnd=0.0):
    cuts = sorted([o for o in w.open if o[0] < b and o[1] > a])
    x = a
    for (o0, o1, oz0, oz1) in cuts:
        if o0 > x:
            B.add(*w.box(x, o0, d0, d1, z0, z1), bevel=bevel, rnd=rnd)
        if oz0 > z0 + 1e-4:
            B.add(*w.box(o0, o1, d0, d1, z0, oz0), bevel=bevel, rnd=rnd)
        if oz1 < z1 - 1e-4:
            B.add(*w.box(o0, o1, d0, d1, oz1, z1), bevel=bevel, rnd=rnd)
        x = o1
    if b > x:
        B.add(*w.box(x, b, d0, d1, z0, z1), bevel=bevel, rnd=rnd)


def build_house():
    W = make_walls()
    paint, conc, wood, black, glass = Geo(), Geo(), Geo(), Geo(), Geo()

    # --- bata (tiap bata satu kotak ber-bevel) + dinding belakang sebagai nat
    Bb = Boxes()
    brick_alt = {0: (True, False), 3: (False, True), 4: (True, True), 5: (True, True)}
    nb = 0
    for i, w in enumerate(W):
        if w.kind != 'brick':
            continue
        sa, ea = brick_alt[i]
        for r in range(NROWS):
            z0 = FL + r * COURSE
            a = 0.0 if (not sa or r % 2 == 0) else BD + MJ
            b = w.L if (not ea or r % 2 == 1) else w.L - BD - MJ
            segs, x, first = [], a, True
            while x < b - 1e-6:
                ln = (BL - MJ) / 2 if (first and not sa and r % 2 == 1) else BL
                first = False
                e = min(x + ln, b)
                if b - e < 0.05:
                    e = b
                segs.append((x, e))
                x = e + MJ
            for (o0, o1, oz0, oz1) in w.open:
                if z0 + BH > oz0 + 1e-4 and z0 < oz1 - 1e-4:
                    new = []
                    for (s0, s1) in segs:
                        if s1 <= o0 or s0 >= o1:
                            new.append((s0, s1))
                        else:
                            if o0 - s0 > 0.03:
                                new.append((s0, o0))
                            if s1 - o1 > 0.03:
                                new.append((o1, s1))
                    segs = new
            for (s0, s1) in segs:
                dj = RNG.normal(0, 0.0013)
                zj = RNG.normal(0, 0.0006)
                Bb.add(*w.box(s0, s1, dj, BD, z0 + zj, z0 + BH + zj), bevel=0.0035, rnd=0.15 + 0.85 * RNG.random())
                nb += 1
    Bb.to(paint)
    log('bata:', nb)
    Bk = Boxes()
    for i, w in enumerate(W):
        a, b = run_range(W, i, WT)
        wall_solid(Bk, w, a, b, w.r, WT, 0.0, WTOP, rnd=0.0)
    Bk.to(paint)

    # --- coping, plinth, pelat teras, tangga, balok atap, kanopi (beton)
    Bc = Boxes()
    for i, w in enumerate(W):
        prev = (i - 1) % len(W)
        a = 0.025 if prev in CONCAVE_END else -0.025
        b = w.L + (WT + 0.02) if i in CONCAVE_END else w.L - (WT + 0.02)
        Bc.add(*w.box(a, b, -0.025, WT + 0.02, WTOP, WTOP + 0.06), bevel=0.008)
    cop = Geo()
    Bc.to(cop)
    cop.build('coping', [MATS['coping']])

    Bp = Boxes()
    for i, w in enumerate(W):
        if w.kind != 'brick':
            continue
        a = -0.025 if brick_alt[i][0] else 0.0
        b = w.L - 0.13 if brick_alt[i][1] else w.L
        Bp.add(*w.box(a, b, -0.025, 0.13, 0.0, FL), bevel=0.008)
    Bp.span(NX, X1 + 0.025, Y0 - 0.025, NY, 0.0, FL - 0.06, bevel=0.008)                # pelat bawah dek
    Bp.span(X1 + 0.025, X1 + 0.85, STEPS_Y[0], STEPS_Y[1], 0.0, 0.10, bevel=0.01)       # anak tangga bawah
    Bp.span(X1 + 0.025, X1 + 0.44, STEPS_Y[0], STEPS_Y[1], 0.10, 0.20, bevel=0.01)      # anak tangga atas
    Bp.span(X0 - 0.40, X1 + 0.40, 2.05, 2.33, WTOP + 0.06, WTOP + 0.50, bevel=0.012)    # balok melintang di atas atap
    Bp.span(POST[0] - 0.14, POST[0] + 0.14, POST[1] - 0.14, POST[1] + 0.14, 0.0, 0.05, bevel=0.01)
    Bp.to(conc)
    conc.build('beton_rumah', [MATS['concrete']])

    Bk2, Bg = Boxes(), Boxes()
    # --- atap + lantai dalam + plafon
    rf = Geo()
    Br = Boxes()
    sx0, sx1, sy0, sy1 = SKY
    Br.span(X0 + WT, sx0, Y0 + WT, Y1 - WT, CEIL, CEIL + 0.10, bevel=0.002)
    Br.span(sx1, NX - WT, Y0 + WT, Y1 - WT, CEIL, CEIL + 0.10, bevel=0.002)
    Br.span(sx0, sx1, Y0 + WT, sy0, CEIL, CEIL + 0.10, bevel=0.002)
    Br.span(sx0, sx1, sy1, Y1 - WT, CEIL, CEIL + 0.10, bevel=0.002)
    Br.span(NX - WT, X1 - WT, NY + WT, Y1 - WT, CEIL, CEIL + 0.10, bevel=0.002)
    Br.to(rf)
    rf.build('atap', [MATS['roof']])
    # skylight + pipa ventilasi
    zr = CEIL + 0.10
    for (a0, a1, b0, b1) in ((sx0 - 0.07, sx0, sy0 - 0.07, sy1 + 0.07), (sx1, sx1 + 0.07, sy0 - 0.07, sy1 + 0.07),
                             (sx0, sx1, sy0 - 0.07, sy0), (sx0, sx1, sy1, sy1 + 0.07)):
        Bk2.span(a0, a1, b0, b1, CEIL, zr + 0.17, bevel=0.004)
    Bg.span(sx0 - 0.03, sx1 + 0.03, sy0 - 0.03, sy1 + 0.03, zr + 0.17, zr + 0.182, bevel=0.001)
    vg = Geo()
    for (vx, vy, vh) in ((-4.35, 0.4, 0.34), (-1.55, 4.45, 0.28), (0.9, 4.5, 0.22)):
        V, F = lathe([(0.001, vh + 0.02), (0.075, vh), (0.075, vh - 0.03), (0.045, vh - 0.03), (0.045, 0.0), (0.09, 0.0)], 20)
        vg.add(V + np.array([vx, vy, zr]), F)
    vg.build('pipa_atap', [MATS['zinc']], smooth=True)
    fl = Geo()
    Bf = Boxes()
    Bf.span(X0 + WT, NX - WT, Y0 + WT, Y1 - WT, 0.0, FL, bevel=0.002)
    Bf.span(NX - WT, X1 - WT + 0.05, NY + WT, Y1 - WT, 0.0, FL, bevel=0.002)
    Bf.to(fl)
    fl.build('lantai', [MATS['floor']])

    # --- dek kayu teras
    Bd = Boxes()
    x = NX + 0.036
    while x < X1 + 0.02:
        e = min(x + 0.14, X1 + 0.03)
        Bd.span(x, e, Y0 - 0.03, NY - 0.036, FL - 0.06, FL + RNG.normal(0, 0.0008), bevel=0.004)
        x = e + 0.006
    Bd.span(NX + 0.036, X1 + 0.03, Y0 - 0.052, Y0 - 0.03, FL - 0.17, FL - 0.002, bevel=0.003)   # papan lis depan
    dk = Geo()
    Bd.to(dk, uv=True)
    dk.build('dek', [MATS['deck']])

    # --- bilah kayu horizontal di dua dinding coakan
    Bs = Boxes()
    Bm = Boxes()
    for i in (1, 2):
        w = W[i]
        ua, ub = (0.032, w.L - 0.034) if i == 1 else (0.0, w.L - 0.032)
        z = FL + 0.012
        while z + 0.065 < WTOP:
            segs = [(ua, ub)]
            for (o0, o1, oz0, oz1) in w.open:
                if z < oz1 + 0.05:
                    segs = [(ua, o0 - 0.055), (o1 + 0.055, ub)]
            for (s0, s1) in segs:
                Bs.add(*w.box(s0, s1, -0.034 + RNG.normal(0, 0.0008), -0.013, z, z + 0.065), bevel=0.0035)
            z += 0.078
        wall_solid(Bm, w, 0.0, w.L, -0.012, 0.0, FL, WTOP, bevel=0.001)
    Bs.add(*W[1].box(0.0, 0.03, -0.036, 0.0, FL, WTOP), bevel=0.003)                 # lis sudut
    Bs.add(*W[2].box(W[2].L - 0.03, W[2].L, -0.036, 0.0, FL, WTOP), bevel=0.003)
    Bs.to(wood, uv=True)
    wood.build('bilah_kayu', [MATS['slat']])
    mb = Geo()
    Bm.to(mb)
    mb.build('membran', [MATS['membrane']])

    # --- pintu
    w = W[2]
    o0, o1, oz0, oz1 = w.open[0]
    Bk2.add(*w.box(o0 - 0.05, o0, -0.045, 0.12, oz0, oz1 + 0.05), bevel=0.003)
    Bk2.add(*w.box(o1, o1 + 0.05, -0.045, 0.12, oz0, oz1 + 0.05), bevel=0.003)
    Bk2.add(*w.box(o0, o1, -0.045, 0.12, oz1, oz1 + 0.05), bevel=0.003)
    Bk2.add(*w.box(o0, o1, -0.045, 0.12, oz0 - 0.004, oz0 + 0.012), bevel=0.002)      # ambang
    Bk2.add(*w.box(o1 - 0.155, o1 - 0.13, -0.075, -0.05, 1.0, 1.75), bevel=0.004)     # gagang tarik
    Bk2.add(*w.box(o1 - 0.15, o1 - 0.135, -0.05, 0.0, 1.06, 1.08), bevel=0.002)
    Bk2.add(*w.box(o1 - 0.15, o1 - 0.135, -0.05, 0.0, 1.67, 1.69), bevel=0.002)
    Bk2.add(*w.box(2.32, 2.42, -0.11, -0.034, 1.98, 2.14), bevel=0.006)               # lampu dinding
    Bdoor = Boxes()
    x = o0 + 0.004
    while x < o1 - 0.01:
        e = min(x + 0.1, o1 - 0.004)
        Bdoor.add(*w.box(x, e, 0.0 + RNG.normal(0, 0.0006), 0.045, oz0 + 0.014, oz1 - 0.003), bevel=0.004)
        x = e + 0.003
    dg = Geo()
    Bdoor.to(dg, uv=True)
    dg.build('pintu', [MATS['door']])
    bl = Geo()
    c, s = w.box(2.335, 2.405, -0.10, -0.045, 1.972, 1.98)
    add_boxes(bl, [c], [s], 0.001)
    bl.build('lampu_dinding', [MATS['bulb']])

    # --- kanopi
    cz0, cz1 = 2.80, 2.94
    cx0, cx1, cy0, cy1 = NX - 0.01, X1 + 0.50, Y0 - 0.50, NY + 0.01
    zc = Geo()
    Bz = Boxes()
    Bz.span(cx0, cx1, cy0, cy1, cz0, cz1, bevel=0.004)
    Bz.span(cx0 - 0.0, cx1 + 0.012, cy0 - 0.012, cy1, cz1, cz1 + 0.012, bevel=0.003)     # flashing
    Bz.to(zc)
    zc.build('kanopi', [MATS['canopy']])
    Bfa = Boxes()
    fz0, fz1 = cz0 - 0.03, cz1 - 0.004
    Bfa.span(cx1, cx1 + 0.022, cy0 - 0.022, cy1, fz0, fz1, bevel=0.003)
    Bfa.span(cx0, cx1, cy0 - 0.022, cy0, fz0, fz1, bevel=0.003)
    Bfa.span(cx0 - 0.022, cx0, cy0 - 0.022, Y0 - 0.002, fz0, fz1, bevel=0.003)
    Bfa.span(X1 + 0.002, cx1, cy1, cy1 + 0.022, fz0, fz1, bevel=0.003)
    yy = cy0 + 0.004
    while yy < cy1 - 0.02:                                                           # plafon bilah kayu
        e = min(yy + 0.09, cy1)
        Bfa.span(cx0 + 0.004, cx1 - 0.002, yy, e, cz0 - 0.018, cz0, bevel=0.003)
        yy = e + 0.008
    fa = Geo()
    Bfa.to(fa, uv=True)
    fa.build('kanopi_kayu', [MATS['slat']])
    Bk2.span(POST[0] - 0.03, POST[0] + 0.03, POST[1] - 0.03, POST[1] + 0.03, 0.05, cz0 - 0.018, bevel=0.004)   # tiang

    # --- jendela celah (selatan) dan jendela besar (timur)
    w = W[0]
    for (o0, o1, oz0, oz1) in w.open:
        t = 0.032
        Bk2.add(*w.box(o0, o0 + t, 0.035, 0.115, oz0, oz1), bevel=0.003)
        Bk2.add(*w.box(o1 - t, o1, 0.035, 0.115, oz0, oz1), bevel=0.003)
        Bk2.add(*w.box(o0 + t, o1 - t, 0.035, 0.115, oz0, oz0 + t), bevel=0.003)
        Bk2.add(*w.box(o0 + t, o1 - t, 0.035, 0.115, oz1 - t, oz1), bevel=0.003)
        Bk2.add(*w.box(o0 - 0.012, o1 + 0.012, -0.022, 0.05, oz0 - 0.018, oz0), bevel=0.003)     # ambang logam
        Bk2.add(*w.box(o0, o1, 0.0, 0.05, oz1, oz1 + 0.012), bevel=0.002)
        Bk2.add(*w.box(o0 - 0.004, o0 + 0.009, -0.004, 0.04, oz0, oz1), bevel=0.002)
        Bk2.add(*w.box(o1 - 0.009, o1 + 0.004, -0.004, 0.04, oz0, oz1), bevel=0.002)
        Bk2.add(*w.box(o0, o1, -0.004, 0.04, oz1 - 0.009, oz1 + 0.004), bevel=0.002)
        Bg.add(*w.box(o0 + t - 0.008, o1 - t + 0.008, 0.066, 0.078, oz0 + t - 0.008, oz1 - t + 0.008), bevel=0.001)
    w = W[3]
    o0, o1, oz0, oz1 = w.open[0]
    t, d0, d1 = 0.042, 0.05, 0.135
    Bk2.add(*w.box(o0, o0 + t, d0, d1, oz0, oz1), bevel=0.003)
    Bk2.add(*w.box(o1 - t, o1, d0, d1, oz0, oz1), bevel=0.003)
    Bk2.add(*w.box(o0 + t, o1 - t, d0, d1, oz0, oz0 + 0.055), bevel=0.003)
    Bk2.add(*w.box(o0 + t, o1 - t, d0, d1, oz1 - t, oz1), bevel=0.003)
    Bk2.add(*w.box(o0 - 0.015, o1 + 0.015, -0.03, 0.05, oz0 - 0.022, oz0), bevel=0.003)
    Bk2.add(*w.box(o0, o1, 0.0, 0.05, oz1, oz1 + 0.014), bevel=0.002)
    Bk2.add(*w.box(o0 - 0.004, o0 + 0.010, -0.004, 0.055, oz0, oz1), bevel=0.002)
    Bk2.add(*w.box(o1 - 0.010, o1 + 0.004, -0.004, 0.055, oz0, oz1), bevel=0.002)
    Bk2.add(*w.box(o0, o1, -0.004, 0.055, oz1 - 0.010, oz1 + 0.004), bevel=0.002)
    wd = (o1 - o0 - 2 * t)
    mull = [o0 + t + wd / 3, o0 + t + 2 * wd / 3]
    for mu in mull:
        Bk2.add(*w.box(mu - 0.017, mu + 0.017, d0, d1, oz0 + 0.055, oz1 - t), bevel=0.003)
    edges = [o0 + t] + mull + [o1 - t]
    for k in range(3):
        Bg.add(*w.box(edges[k] + (0.017 if k else 0) - 0.008, edges[k + 1] - (0.017 if k < 2 else 0) + 0.008,
                      0.086, 0.098, oz0 + 0.047, oz1 - t + 0.008), bevel=0.001)
    Bk2.to(black)
    black.build('kusen_hitam', [MATS['black']])
    Bg.to(glass)
    glass.build('kaca', [MATS['glass']])
    paint.build('dinding_bata', [MATS['paint']])
    return W


def build_interior():
    g_w, g_f, g_s, g_c, g_r, g_k = Geo(), Geo(), Geo(), Geo(), Geo(), Geo()
    Bw = Boxes()
    Bw.span(-1.95, -1.83, NY + WT, Y1 - WT, FL, CEIL, bevel=0.002)                 # partisi belakang ruang tamu
    Bw.span(-1.83, -1.80, 2.2, 3.7, 1.25, 2.15, bevel=0.004)                        # panel/lukisan
    Bw.to(g_w)
    g_w.build('partisi', [MATS['intwall']])
    Bf = Boxes()
    Bf.span(-1.70, -0.80, 1.55, 3.85, FL + 0.10, FL + 0.42, bevel=0.04)             # dudukan sofa
    Bf.span(-1.78, -1.50, 1.55, 3.85, FL + 0.10, FL + 0.85, bevel=0.05)             # sandaran
    Bf.span(-1.70, -0.80, 1.47, 1.67, FL + 0.10, FL + 0.62, bevel=0.04)
    Bf.span(-1.70, -0.80, 3.73, 3.93, FL + 0.10, FL + 0.62, bevel=0.04)
    Bf.span(0.55, 1.25, 3.45, 4.15, FL + 0.16, FL + 0.44, bevel=0.05)               # kursi santai
    Bf.span(0.50, 1.30, 4.02, 4.20, FL + 0.16, FL + 0.82, bevel=0.05)
    Bf.to(g_s)
    g_s.build('sofa', [MATS['sofa']])
    Bc = Boxes()
    for (x, y, yaw) in ((-1.42, 1.95, 0.2), (-1.42, 3.45, -0.15), (0.9, 4.0, 0.1)):
        Bc.add((x, y, FL + 0.58), (0.14, 0.42, 0.40), bevel=0.05, yaw=yaw)
    Bc.to(g_c)
    g_c.build('bantal', [MATS['cushion']])
    Bt = Boxes()
    Bt.span(-0.35, 0.45, 2.15, 3.25, FL + 0.33, FL + 0.37, bevel=0.008)             # meja kopi
    for (x, y) in ((-0.30, 2.20), (0.40, 2.20), (-0.30, 3.20), (0.40, 3.20)):
        Bt.span(x - 0.02, x + 0.02, y - 0.02, y + 0.02, FL, FL + 0.33, bevel=0.004)
    Bt.span(-1.80, -1.45, 4.15, 4.85, FL, FL + 1.9, bevel=0.01)                      # rak
    Bt.span(0.3, 0.6, 1.35, 1.65, FL, FL + 0.5, bevel=0.01)                          # meja samping
    for (x, y) in ((0.57, 3.47), (1.23, 3.47), (0.57, 4.13), (1.23, 4.13)):
        Bt.span(x - 0.018, x + 0.018, y - 0.018, y + 0.018, FL, FL + 0.16, bevel=0.004)
    Bt.to(g_k, uv=True)
    g_k.build('furnitur_kayu', [MATS['furn']])
    Br = Boxes()
    Br.span(-0.75, 1.15, 1.75, 3.75, FL, FL + 0.012, bevel=0.004)
    Br.to(g_r)
    g_r.build('karpet', [MATS['rug']])
    # lampu lantai + lampu gantung
    lg = Geo()
    V, F = lathe([(0.11, 0.0), (0.17, 0.0), (0.17, 0.30), (0.11, 0.30)], 28)
    lg.add(V + np.array([0.45, 1.5, FL + 1.25]), F)
    V, F = lathe([(0.001, 0.02), (0.10, 0.0), (0.16, -0.10), (0.17, -0.20), (0.14, -0.26)], 28)
    lg.add(V + np.array([0.05, 2.7, 2.30]), F)
    lg.build('kap_lampu', [MATS['shade']], smooth=True)
    bk = Geo()
    Bb = Boxes()
    Bb.span(0.44, 0.46, 1.49, 1.51, FL + 0.5, FL + 1.25, bevel=0.002)
    Bb.span(0.045, 0.055, 2.695, 2.705, 2.32, CEIL, bevel=0.001)
    Bb.to(bk)
    bk.build('tiang_lampu', [MATS['black']])
    for (loc, pw, rad) in (((0.45, 1.5, FL + 1.40), 60.0, 0.07), ((0.05, 2.7, 2.12), 50.0, 0.08),
                           ((-1.2, 4.4, 2.3), 30.0, 0.1)):
        L = bpy.data.lights.new('lampu_dalam', 'POINT')
        L.energy = pw
        L.color = (1.0, 0.63, 0.32)
        L.shadow_soft_size = rad
        o = bpy.data.objects.new('lampu_dalam', L)
        o.location = loc
        bpy.context.scene.collection.objects.link(o)
    # lampu dinding teras (hangat)
    L = bpy.data.lights.new('lampu_teras', 'AREA')
    L.energy = 55.0
    L.color = (1.0, 0.62, 0.30)
    L.size = 0.08
    o = bpy.data.objects.new('lampu_teras', L)
    o.location = (NX + 2.37, NY - 0.075, 1.965)
    bpy.context.scene.collection.objects.link(o)
    # gorden tipis
    cg = Geo()
    for (y0, y1, ph) in ((1.28, 1.95, 0.3), (4.05, 4.68, 1.7)):
        ny, nz = 70, 24
        yy = np.linspace(y0, y1, ny)
        zz = np.linspace(FL + 0.015, CEIL - 0.04, nz)
        Y, Z = np.meshgrid(yy, zz, indexing='ij')
        fold = 0.035 * np.sin((Y - y0) / 0.105 * 2 * math.pi + ph + 0.6 * np.sin(Z * 1.3)) * (0.75 + 0.25 * (CEIL - Z) / 2.4)
        fold += 0.012 * np.sin(Y * 23.0 + Z * 0.7)
        X = X1 - 0.30 + fold
        V = np.stack([X, Y, Z], -1).reshape(-1, 3)
        idx = np.arange(ny * nz).reshape(ny, nz)
        F = np.stack([idx[:-1, :-1], idx[1:, :-1], idx[1:, 1:], idx[:-1, 1:]], -1).reshape(-1, 4)
        cg.add(V, F)
    cg.build('gorden', [MATS['curtain']], smooth=True)
    rl = Geo()
    Brl = Boxes()
    Brl.span(X1 - 0.315, X1 - 0.285, 1.2, 4.72, CEIL - 0.04, CEIL - 0.015, bevel=0.002)
    Brl.to(rl)
    rl.build('rel_gorden', [MATS['black']])


# --------------------------------------------------------------------------------------
# Tapak + taman
# --------------------------------------------------------------------------------------
def in_rot_rect(x, y, cx, cy, sx, sy, yaw_deg, margin=0.0):
    c, s = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
    dx, dy = x - cx, y - cy
    lx, ly = dx * c + dy * s, -dx * s + dy * c
    return (np.abs(lx) < sx / 2 + margin) & (np.abs(ly) < sy / 2 + margin)


def gravel_field(x, y):
    g = np.zeros(np.shape(x), bool)
    wob = 0.10 * np.sin(x * 3.1 + 1.0) + 0.06 * np.sin(x * 7.3)
    g |= (x > X0 - 0.2) & (x < NX + 0.1) & (y > Y0 - 0.62 - wob) & (y <= Y0)             # sepanjang dinding selatan
    wob2 = 0.10 * np.sin(y * 3.4 + 2.0) + 0.05 * np.sin(y * 8.1)
    g |= (x >= X1) & (x < X1 + 0.95 + wob2) & (y > NY + 0.05) & (y < Y1 + 0.2)           # sepanjang dinding timur
    g |= (x < X0) | (y > Y1)                                                             # belakang rumah
    for (cx, cy, r) in GRAVEL_BLOBS:
        th = np.arctan2(y - cy, x - cx)
        rr = r * (1 + 0.16 * np.sin(3 * th + cx) + 0.09 * np.sin(5 * th + cy * 2))
        g |= (x - cx) ** 2 + (y - cy) ** 2 < rr ** 2
    return g


def blocked(x, y, slab_margin=0.012):
    b = (np.abs(x) > SITE - 0.20) | (np.abs(y) > SITE - 0.20)
    b |= (x > X0 - 0.03) & (x < X1 + 0.03) & (y > Y0 - 0.03) & (y < Y1 + 0.03)
    b |= (x > X1) & (x < X1 + 0.86) & (y > STEPS_Y[0] - 0.01) & (y < STEPS_Y[1] + 0.01)
    b |= (x > PLANTER[0] - 0.01) & (x < PLANTER[1] + 0.01) & (y > PLANTER[2] - 0.01) & (y < PLANTER[3] + 0.01)
    b |= (np.abs(x - POST[0]) < 0.15) & (np.abs(y - POST[1]) < 0.15)
    for (cx, cy, sx, sy, yaw) in SLABS:
        b |= in_rot_rect(x, y, cx, cy, sx, sy, yaw, slab_margin)
    return b


def build_site():
    # alas + pagar beton
    g = Geo()
    add_boxes(g, [(0, 0, -0.25)], [(2 * SITE, 2 * SITE, 0.5)], 0.012)
    g.build('alas', [MATS['base']])
    Bw = Boxes()
    t, hb, hf = 0.18, 0.78, 0.40
    hm = (hb + hf) / 2
    Bw.span(-SITE, SITE - 1.8, SITE - t, SITE, 0.0, hb, bevel=0.012)           # belakang (y+)
    Bw.span(SITE - 1.8, SITE - t, SITE - t, SITE, 0.0, hm, bevel=0.012)        # undakan peralihan
    Bw.span(-SITE, -SITE + t, -SITE + 1.8, SITE - t, 0.0, hb, bevel=0.012)     # belakang (x-)
    Bw.span(-SITE, -SITE + t, -SITE + t, -SITE + 1.8, 0.0, hm, bevel=0.012)    # undakan peralihan
    Bw.span(SITE - t, SITE, -SITE, SITE, 0.0, hf, bevel=0.012)                 # depan (x+), satu tingkat lebih rendah
    Bw.span(-SITE, SITE - t, -SITE, -SITE + t, 0.0, hf, bevel=0.012)           # depan (y-)
    g = Geo()
    Bw.to(g)
    g.build('pagar_beton', [MATS['bwall']])
    # permukaan tanah
    n = 300
    xs = np.linspace(-SITE + 0.17, SITE - 0.17, n)
    X, Y = np.meshgrid(xs, xs, indexing='ij')
    Z = np.full_like(X, 0.004)
    V = np.stack([X, Y, Z], -1).reshape(-1, 3)
    idx = np.arange(n * n).reshape(n, n)
    F = np.stack([idx[:-1, :-1], idx[1:, :-1], idx[1:, 1:], idx[:-1, 1:]], -1).reshape(-1, 4)
    g = Geo()
    g.add(V, F, attrs={'gravel': gravel_field(X, Y).astype(np.float32).ravel()})
    g.build('tanah', [MATS['ground']], smooth=True)
    # backdrop krem
    g = Geo()
    R = 400.0
    g.add([(-R, -R, -0.5), (R, -R, -0.5), (R, R, -0.5), (-R, R, -0.5)], np.array([[0, 1, 2, 3]]))
    g.build('backdrop', [MATS['backdrop']])
    # pelat pijakan
    g = Geo()
    C = [(s[0], s[1], 0.03 + 0.004 * i % 0.01) for i, s in enumerate(SLABS)]
    S = [(s[2], s[3], 0.075) for s in SLABS]
    add_boxes(g, C, S, 0.009, yaw=np.radians([s[4] for s in SLABS]))
    g.build('pelat_pijakan', [MATS['slab']])


def build_pebbles():
    area = (2 * SITE) ** 2
    n = int(area * 2100 * max(DENS, 0.15))
    x = RNG.uniform(-SITE + 0.2, SITE - 0.2, n)
    y = RNG.uniform(-SITE + 0.2, SITE - 0.2, n)
    keep = gravel_field(x, y) & ~blocked(x, y, 0.0)
    x, y = x[keep], y[keep]
    N = len(x)
    V0, F0 = ico(2)
    sc = RNG.uniform(0.011, 0.026, N)[:, None] * np.stack([RNG.uniform(0.8, 1.3, N), RNG.uniform(0.7, 1.1, N),
                                                         RNG.uniform(0.45, 0.8, N)], 1)
    yaw = RNG.uniform(0, 6.28, N)
    L = V0[None] * sc[:, None, :]
    c, s = np.cos(yaw)[:, None], np.sin(yaw)[:, None]
    Wv = np.stack([L[..., 0] * c - L[..., 1] * s + x[:, None], L[..., 0] * s + L[..., 1] * c + y[:, None],
                   L[..., 2] + (sc[:, 2] * RNG.uniform(0.3, 0.9, N))[:, None] + 0.004], -1)
    F = F0[None] + (np.arange(N) * len(V0))[:, None, None]
    base = np.array([0.74, 0.72, 0.67])
    col = base[None] * RNG.uniform(0.72, 1.12, (N, 1)) + RNG.normal(0, 0.02, (N, 3))
    dark = RNG.random(N) < 0.08
    col[dark] *= 0.5
    warm = RNG.random(N) < 0.12
    col[warm] *= np.array([1.0, 0.9, 0.75])
    col = np.concatenate([np.clip(col, 0, 1), np.ones((N, 1))], 1)
    g = Geo()
    g.add(Wv.reshape(-1, 3), F.reshape(-1, 3), attrs={'col': np.repeat(col, len(V0), axis=0)})
    g.build('kerikil', [MATS['pebble']], smooth=True)
    log('kerikil:', N)


def build_lawn():
    area = (2 * SITE) ** 2
    n = int(area * 9500 * DENS)
    x = RNG.uniform(-SITE + 0.2, SITE - 0.2, n)
    y = RNG.uniform(-SITE + 0.2, SITE - 0.2, n)
    keep = ~gravel_field(x, y) & ~blocked(x, y)
    x, y = x[keep], y[keep]
    N = len(x)
    patch = np.sin(x * 1.7 + 0.3) * np.cos(y * 1.3 - 1.0) * 0.5 + np.sin(x * 4.1 + y * 3.3) * 0.25 + 0.5
    edge = np.zeros(N, bool)
    for (cx, cy, sx, sy, yaw) in SLABS:
        edge |= in_rot_rect(x, y, cx, cy, sx, sy, yaw, 0.07)
    h = (0.045 + 0.05 * RNG.random(N) + 0.03 * patch) * np.where(edge, 1.35, 1.0) * np.where(RNG.random(N) < 0.03, 1.8, 1.0)
    wd = RNG.uniform(0.004, 0.008, N)
    az = RNG.uniform(0, 6.28, N)
    lean = RNG.uniform(0.05, 0.6, N)
    lx, ly = np.cos(az) * lean + 0.12, np.sin(az) * lean + 0.05
    wa = az + 1.57 + RNG.normal(0, 0.5, N)
    wx, wy = np.cos(wa) * wd, np.sin(wa) * wd
    V = np.zeros((N, 5, 3), np.float32)
    V[:, 0] = np.stack([x - wx, y - wy, np.zeros(N)], 1)
    V[:, 1] = np.stack([x + wx, y + wy, np.zeros(N)], 1)
    mx, my, mz = x + lx * h * 0.35, y + ly * h * 0.35, h * 0.55
    V[:, 2] = np.stack([mx - wx * 0.75, my - wy * 0.75, mz], 1)
    V[:, 3] = np.stack([mx + wx * 0.75, my + wy * 0.75, mz], 1)
    V[:, 4] = np.stack([x + lx * h, y + ly * h, h * np.sqrt(np.maximum(1 - lean ** 2 * 0.6, 0.3))], 1)
    off = (np.arange(N) * 5)[:, None]
    FQ = np.array([[0, 1, 3, 2]]) + off
    FT = np.array([[2, 3, 4]]) + off
    fresh = np.array([0.060, 0.135, 0.018])
    yel = np.array([0.20, 0.23, 0.035])
    dry = np.array([0.40, 0.33, 0.13])
    t = np.clip(RNG.beta(2, 3, N) * 0.9 + (patch - 0.5) * 0.35, 0, 1)[:, None]
    col = fresh + (yel - fresh) * t
    d = RNG.random(N) < (0.05 + 0.08 * patch)
    col[d] = dry * RNG.uniform(0.7, 1.1, (d.sum(), 1))
    col *= RNG.uniform(0.75, 1.2, (N, 1))
    colv = np.repeat(np.concatenate([col, np.zeros((N, 1))], 1)[:, None, :], 5, 1)
    colv[:, 2:4, 3] = 0.55
    colv[:, 4, 3] = 1.0
    g = Geo()
    g.add(V.reshape(-1, 3), [FQ, FT], attrs={'col': colv.reshape(-1, 4)})
    g.build('rumput', [MATS['grass']])
    log('bilah rumput:', N)


def make_rock(size, seed):
    r = np.random.default_rng(seed)
    V, F = ICO5
    K = int(r.integers(7, 12))
    nr = r.normal(0, 1, (K, 3))
    nr /= np.linalg.norm(nr, axis=1, keepdims=True)
    dist = r.uniform(0.52, 0.95, K)
    dots = V @ nr.T
    rk = np.where(dots > 1e-3, dist[None] / np.maximum(dots, 1e-3), 50.0)
    k = 34.0
    rad = -np.log(np.exp(-k * rk).sum(1) + math.exp(-k * 1.0)) / k
    P = V * rad[:, None]
    off = r.uniform(0, 100, 3)
    nz = np.array([mnoise.noise(Vector((p[0] * 2.2 + off[0], p[1] * 2.2 + off[1], p[2] * 2.2 + off[2]))) +
                   0.4 * mnoise.noise(Vector((p[0] * 7 + off[2], p[1] * 7 + off[0], p[2] * 7 + off[1]))) for p in P])
    P = P * (1 + 0.11 * nz)[:, None]
    P = P * size * np.array([1.0, r.uniform(0.65, 0.95), r.uniform(0.6, 0.95)])
    ya = r.uniform(0, 6.28)
    c, s = math.cos(ya), math.sin(ya)
    P = np.stack([P[:, 0] * c - P[:, 1] * s, P[:, 0] * s + P[:, 1] * c, P[:, 2]], 1)
    return P, F


def build_rocks():
    g = Geo()
    for i, (cx, cy, sz) in enumerate(ROCKS):
        P, F = make_rock(sz * 1.35, 100 + i)
        zmin, zmax = P[:, 2].min(), P[:, 2].max()
        P = P + np.array([cx, cy, -zmin - 0.22 * (zmax - zmin)])
        g.add(P, F, attrs={'rnd': np.full(len(P), RNG.random())})
    g.build('batu', [MATS['rock']], smooth=False)


def grass_clump(g, c, h, dry, n, plume=True, radius=0.16):
    az = RNG.uniform(0, 6.28, n)
    rr = radius * np.sqrt(RNG.random(n))
    base = np.stack([c[0] + rr * np.cos(az), c[1] + rr * np.sin(az), np.full(n, c[2])], 1)
    lean = RNG.uniform(0.03, 0.55, n) * (0.4 + 0.6 * rr / radius)
    az2 = az + RNG.normal(0, 0.6, n)
    d0 = np.stack([np.cos(az2) * np.sin(lean), np.sin(az2) * np.sin(lean), np.cos(lean)], 1)
    L = h * RNG.uniform(0.5, 1.08, n)
    droop = RNG.uniform(0.15, 0.85, n)
    green0, green1 = np.array([0.07, 0.13, 0.025]), np.array([0.17, 0.22, 0.04])
    tan0, tan1 = np.array([0.30, 0.22, 0.09]), np.array([0.55, 0.43, 0.20])
    t = np.clip(RNG.normal(dry, 0.28, n), 0, 1)[:, None]
    c0 = (green0 + (tan0 - green0) * t) * RNG.uniform(0.8, 1.2, (n, 1))
    c1 = (green1 + (tan1 - green1) * np.clip(t + 0.25, 0, 1)) * RNG.uniform(0.8, 1.2, (n, 1))
    add_ribbons(g, base, d0, L, droop, RNG.uniform(0.006, 0.013, n), c0, c1, nseg=7)
    if plume:
        m = max(6, n // 14)
        az = RNG.uniform(0, 6.28, m)
        lean = RNG.uniform(0.02, 0.28, m)
        d0 = np.stack([np.cos(az) * np.sin(lean), np.sin(az) * np.sin(lean), np.cos(lean)], 1)
        L = h * RNG.uniform(1.15, 1.45, m)
        b = np.stack([c[0] + 0.05 * np.cos(az), c[1] + 0.05 * np.sin(az), np.full(m, c[2])], 1)
        dr = RNG.uniform(0.05, 0.25, m)
        st = np.tile(np.array([0.38, 0.30, 0.14]), (m, 1))
        add_ribbons(g, b, d0, L, dr, np.full(m, 0.004), st, st * 1.2, nseg=6)
        hor = d0.copy()
        hor[:, 2] = 0
        hor /= (np.linalg.norm(hor, axis=1, keepdims=True) + 1e-9)
        k = 26
        tt = RNG.uniform(0.80, 1.0, (m, k))
        P = (b[:, None, :] + (L[:, None] * tt)[..., None] * d0[:, None, :] +
             (L[:, None] * dr[:, None] * tt ** 2.3)[..., None] * (hor[:, None, :] * 0.75 - np.array([0, 0, 0.55])))
        P = P.reshape(-1, 3)
        dd = np.repeat(d0, k, axis=0) + RNG.normal(0, 0.45, (m * k, 3))
        pc = np.array([0.62, 0.53, 0.33]) * RNG.uniform(0.8, 1.2, (m * k, 1))
        add_ribbons(g, P, dd, RNG.uniform(0.05, 0.11, m * k), RNG.uniform(0.3, 0.9, m * k),
                    np.full(m * k, 0.006), pc, pc * 1.15, nseg=3)


def build_ornamental():
    g = Geo()
    for (cx, cy, h, dry) in CLUMPS:
        grass_clump(g, (cx, cy, 0.0), h, dry, int(900 * max(DENS, 0.3)), radius=0.2)
        for k in range(2):      # anakan kecil di sekitarnya
            a = RNG.uniform(0, 6.28)
            grass_clump(g, (cx + 0.38 * math.cos(a), cy + 0.38 * math.sin(a), 0.0), h * 0.5, min(1.0, dry + 0.15),
                        int(160 * max(DENS, 0.3)), plume=False, radius=0.09)
    # tanaman di bak kayu
    px = (PLANTER[0] + PLANTER[1]) / 2
    for i, y in enumerate(np.linspace(PLANTER[2] + 0.3, PLANTER[3] - 0.3, 6)):
        grass_clump(g, (px + RNG.normal(0, 0.04), y + RNG.normal(0, 0.05), PLANTER[4] - 0.05),
                    0.42 + 0.14 * RNG.random(), 0.15 + 0.3 * RNG.random(), int(300 * max(DENS, 0.3)),
                    plume=(i % 2 == 0), radius=0.11)
    g.build('rumput_hias', [MATS['ogress']])


def gen_tree(base, cfg, seed):
    r = np.random.default_rng(seed)
    B, LP, LA = [], [], []
    gold = 2.39996

    def basis(d):
        a = np.array([0, 0, 1.0]) if abs(d[2]) < 0.95 else np.array([1.0, 0, 0])
        e1 = np.cross(d, a)
        e1 /= np.linalg.norm(e1)
        return e1, np.cross(d, e1)

    def grow(p0, d0, length, r0, level, phase):
        c = cfg['lv'][level]
        nseg = c['nseg']
        seg = length / nseg
        pts, d, dirs = [np.array(p0, float)], np.array(d0, float), []
        for i in range(nseg):
            d = d + r.normal(0, c['jit'], 3) + np.array([0, 0, c['up']])
            d /= np.linalg.norm(d)
            dirs.append(d.copy())
            pts.append(pts[-1] + d * seg)
        pts = np.array(pts)
        t = np.linspace(0, 1, nseg + 1)
        rad = r0 * (1 - (1 - c['taper']) * t)
        if level == 0:
            rad[0] *= 1.55
            rad[1] *= 1.12
        B.append((pts, rad, level))
        if level < len(cfg['lv']) - 1:
            n = c['kids']
            for k in range(n):
                u = c['start'] + (1 - c['start']) * ((k + r.uniform(0.15, 0.85)) / n)
                f = u * nseg
                i = min(int(f), nseg - 1)
                fr = f - i
                p = pts[i] * (1 - fr) + pts[i + 1] * fr
                dp = dirs[i]
                e1, e2 = basis(dp)
                az = phase + gold * k + r.uniform(-0.5, 0.5)
                th = math.radians(r.uniform(*c['angle']))
                cd = math.cos(th) * dp + math.sin(th) * (math.cos(az) * e1 + math.sin(az) * e2)
                cl = length * c['ratio'] * (1 - 0.5 * u) * r.uniform(0.75, 1.3)
                cr = max(rad[i] * r.uniform(0.42, 0.62), cfg['rmin'])
                grow(p, cd, cl, cr, level + 1, r.uniform(0, 6.28))
        if level >= cfg['leaf_level']:
            nl = max(2, int(length / cfg['leaf_step'] * DENS))
            for j in range(nl):
                u = ((j + r.uniform(0, 1)) / nl) ** 0.85
                f = u * nseg
                i = min(int(f), nseg - 1)
                fr = f - i
                p = pts[i] * (1 - fr) + pts[i + 1] * fr
                dp = dirs[i]
                e1, e2 = basis(dp)
                for _ in range(cfg.get('leaf_per', 1)):
                    az = r.uniform(0, 6.28)
                    o = math.cos(az) * e1 + math.sin(az) * e2
                    LP.append(p + o * 0.004 + r.normal(0, 0.012, 3))
                    LA.append(o * 0.85 + dp * 0.45 + np.array([0, 0, -0.38]) + r.normal(0, 0.28, 3))
    for (off, lean_az, lean, h, r0) in cfg['trunks']:
        d0 = np.array([math.cos(lean_az) * math.sin(lean), math.sin(lean_az) * math.sin(lean), math.cos(lean)])
        grow(np.array(base) + np.array([off[0], off[1], -0.05]), d0, h, r0, 0, r.uniform(0, 6.28))
    return B, np.array(LP), np.array(LA)


TALL = {'lv': [dict(nseg=15, jit=0.030, up=0.050, taper=0.22, kids=14, start=0.34, angle=(38, 66), ratio=0.40),
               dict(nseg=8, jit=0.07, up=0.022, taper=0.35, kids=8, start=0.22, angle=(32, 65), ratio=0.44),
               dict(nseg=5, jit=0.10, up=0.015, taper=0.4, kids=6, start=0.15, angle=(30, 70), ratio=0.5),
               dict(nseg=4, jit=0.13, up=0.0, taper=0.45)],
        'rmin': 0.0022, 'leaf_level': 2, 'leaf_step': 0.011, 'leaf_per': 3,
        'trunks': [((0.00, 0.10), 1.2, 0.24, 6.7, 0.062), ((0.12, -0.06), -0.6, 0.32, 5.9, 0.052),
                   ((-0.11, -0.07), 3.5, 0.36, 5.3, 0.046)]}
SMALL = {'lv': [dict(nseg=11, jit=0.035, up=0.06, taper=0.25, kids=11, start=0.38, angle=(40, 68), ratio=0.44),
                dict(nseg=7, jit=0.07, up=0.025, taper=0.35, kids=7, start=0.22, angle=(32, 65), ratio=0.46),
                dict(nseg=5, jit=0.10, up=0.015, taper=0.4, kids=6, start=0.15, angle=(30, 70), ratio=0.5),
                dict(nseg=4, jit=0.13, up=0.0, taper=0.45)],
         'rmin': 0.002, 'leaf_level': 2, 'leaf_step': 0.007, 'leaf_per': 3,
         'trunks': [((0, 0), 0.6, 0.07, 3.3, 0.038)]}
SIDES = [14, 8, 5, 4]


def build_trees():
    bark, leaves = Geo(), Geo()
    fallen = []
    for (pos, cfg, seed, lsz, bias) in ((TREE_TALL, TALL, 5, (0.055, 0.085), 0.0), (TREE_SMALL, SMALL, 9, (0.040, 0.062), -0.06)):
        B, LP, LA = gen_tree((pos[0], pos[1], 0.0), cfg, seed)
        for (pts, rad, lvl) in B:
            V, F, UV = tube(pts, rad, SIDES[lvl])
            bark.add(V, F, attrs={'lvl': np.full(len(V), lvl / 3.0)}, uvs=UV)
        n = len(LP)
        add_leaves(leaves, LP, LA, RNG.uniform(lsz[0], lsz[1], n), autumn_colors(n, bias))
        log('pohon di', pos, 'cabang:', len(B), 'daun:', n)
        fallen.append((pos, 2.4 if cfg is TALL else 1.4, 2600 if cfg is TALL else 1100, lsz))
    bark.build('batang', [MATS['bark']], smooth=True)
    leaves.build('daun', [MATS['leaf']])
    # daun gugur di tanah
    fl = Geo()
    P, A, S = [], [], []
    for (pos, rad, cnt, lsz) in fallen:
        cnt = int(cnt * max(DENS, 0.3))
        x = pos[0] + RNG.normal(0, rad * 0.6, cnt) - 0.5
        y = pos[1] + RNG.normal(0, rad * 0.6, cnt) + 0.15
        P.append(np.stack([x, y], 1))
        S.append(RNG.uniform(lsz[0], lsz[1], cnt))
    cnt = int(900 * max(DENS, 0.3))
    P.append(RNG.uniform(-SITE + 0.3, SITE - 0.3, (cnt, 2)))
    S.append(RNG.uniform(0.04, 0.07, cnt))
    P = np.concatenate(P)
    S = np.concatenate(S)
    x, y = P[:, 0], P[:, 1]
    ok = (np.abs(x) < SITE - 0.25) & (np.abs(y) < SITE - 0.25)
    ok &= ~((x > X0 - 0.05) & (x < X1 + 0.05) & (y > Y0 - 0.05) & (y < Y1 + 0.05))
    ok &= ~((x > X1) & (x < X1 + 0.9) & (y > STEPS_Y[0]) & (y < STEPS_Y[1]))
    ok &= ~((x > PLANTER[0] - 0.03) & (x < PLANTER[1] + 0.03) & (y > PLANTER[2] - 0.03) & (y < PLANTER[3] + 0.03))
    x, y, S = x[ok], y[ok], S[ok]
    on_slab = np.zeros(len(x), bool)
    for (cx, cy, sx, sy, yaw) in SLABS:
        on_slab |= in_rot_rect(x, y, cx, cy, sx, sy, yaw, 0.0)
    gv = gravel_field(x, y)
    z = np.where(on_slab, 0.074, np.where(gv, 0.032, 0.062)) + RNG.uniform(0, 0.012, len(x))
    az = RNG.uniform(0, 6.28, len(x))
    A = np.stack([np.cos(az), np.sin(az), RNG.normal(0, 0.12, len(x))], 1)
    add_leaves(fl, np.stack([x, y, z], 1), A, S, autumn_colors(len(x), 0.05, green=0.0), flat=0.22)
    # satu-dua daun di dek dan tangga
    k = 26
    xx = RNG.uniform(NX + 0.2, X1 + 0.7, k)
    yy = RNG.uniform(Y0 + 0.05, NY - 0.2, k)
    zz = np.where(xx > X1 + 0.44, 0.105, np.where(xx > X1 + 0.03, 0.205, FL + 0.004))
    az = RNG.uniform(0, 6.28, k)
    add_leaves(fl, np.stack([xx, yy, zz], 1), np.stack([np.cos(az), np.sin(az), np.zeros(k)], 1),
               RNG.uniform(0.045, 0.07, k), autumn_colors(k, 0.05, green=0.0), flat=0.15)
    k = int(420 * max(DENS, 0.3))
    xx = np.concatenate([RNG.uniform(X0 + WT, NX - WT, k // 2), RNG.uniform(X0 + WT, X1 - WT, k - k // 2)])
    yy = np.concatenate([RNG.uniform(Y0 + WT, Y1 - WT, k // 2), RNG.uniform(NY + WT, Y1 - WT, k - k // 2)])
    drift = RNG.random(k) < 0.6                      # sebagian numpuk di kaki parapet barat/utara
    xx = np.where(drift & (RNG.random(k) < 0.5), X0 + WT + np.abs(RNG.normal(0, 0.18, k)), xx)
    yy = np.where(drift & (RNG.random(k) < 0.5), Y1 - WT - np.abs(RNG.normal(0, 0.18, k)), yy)
    okr = ~((xx > SKY[0] - 0.1) & (xx < SKY[1] + 0.1) & (yy > SKY[2] - 0.1) & (yy < SKY[3] + 0.1)) & ~((yy > 2.0) & (yy < 2.38))
    xx, yy = xx[okr], yy[okr]
    az = RNG.uniform(0, 6.28, len(xx))
    add_leaves(fl, np.stack([xx, yy, np.full(len(xx), CEIL + 0.108)], 1), np.stack([np.cos(az), np.sin(az), RNG.normal(0, 0.1, len(xx))], 1),
               RNG.uniform(0.045, 0.075, len(xx)), autumn_colors(len(xx), 0.1, green=0.0), flat=0.2)
    k = 34
    xx, yy = RNG.uniform(NX + 0.1, X1 + 0.45, k), RNG.uniform(Y0 - 0.45, NY - 0.1, k)
    az = RNG.uniform(0, 6.28, k)
    add_leaves(fl, np.stack([xx, yy, np.full(k, 2.958)], 1), np.stack([np.cos(az), np.sin(az), np.zeros(k)], 1),
               RNG.uniform(0.045, 0.07, k), autumn_colors(k, 0.05, green=0.0), flat=0.15)
    fl.build('daun_gugur', [MATS['leaf']])


def build_shrub():
    cx, cy, R = SHRUB
    cz = R * 0.92
    bark, leaves = Geo(), Geo()
    n = int(520 * max(DENS, 0.3))
    d = RNG.normal(0, 1, (n, 3))
    d[:, 2] = np.abs(d[:, 2]) * 0.9 + 0.05
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    lump = 1 + 0.16 * np.sin(d[:, 0] * 5 + 1) * np.cos(d[:, 1] * 4) + 0.09 * np.sin(d[:, 2] * 9 + d[:, 0] * 6) + 0.06 * np.cos(d[:, 1] * 11)
    tips = np.array([cx, cy, 0.0]) + d * (R * lump)[:, None] * np.array([1.0, 1.0, 1.85])
    root = np.array([cx, cy, 0.02]) + RNG.normal(0, 0.03, (n, 3)) * np.array([1, 1, 0])
    for i in range(n):
        mid = (root[i] + tips[i]) / 2 + RNG.normal(0, 0.03, 3) + np.array([0, 0, 0.05])
        pts = np.array([root[i], root[i] * 0.5 + mid * 0.5 + np.array([0, 0, 0.04]), mid, mid * 0.5 + tips[i] * 0.5, tips[i]])
        V, F, UV = tube(pts, np.array([0.006, 0.005, 0.004, 0.003, 0.0015]), 4)
        bark.add(V, F, attrs={'lvl': np.full(len(V), 1.0)}, uvs=UV)
    m = int(26000 * DENS)
    d = RNG.normal(0, 1, (m, 3))
    d[:, 2] = np.abs(d[:, 2]) * 0.95 - 0.12
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    lump = 1 + 0.16 * np.sin(d[:, 0] * 5 + 1) * np.cos(d[:, 1] * 4) + 0.09 * np.sin(d[:, 2] * 9 + d[:, 0] * 6) + 0.06 * np.cos(d[:, 1] * 11)
    rr = R * lump * (1 - 0.30 * RNG.random(m) ** 2.2)
    P = np.array([cx, cy, cz * 0.0]) + d * rr[:, None] * np.array([1.0, 1.0, 1.0]) + np.array([0, 0, cz])
    P[:, 2] = np.maximum(P[:, 2], 0.03 + 0.05 * RNG.random(m))
    A = d + RNG.normal(0, 0.7, (m, 3))
    add_leaves(leaves, P, A, RNG.uniform(0.022, 0.036, m), autumn_colors(m, -0.20, green=0.04), flat=0.6, bias=(0, 0, 0.6))
    bark.build('semak_ranting', [MATS['bark']], smooth=True)
    leaves.build('semak_daun', [MATS['leaf']])
    # gundukan kecil daun di bak kayu
    lg = Geo()
    px = (PLANTER[0] + PLANTER[1]) / 2
    for y in np.linspace(PLANTER[2] + 0.55, PLANTER[3] - 0.55, 5):
        m = int(2600 * DENS)
        d = RNG.normal(0, 1, (m, 3))
        d[:, 2] = np.abs(d[:, 2])
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        rr = 0.17 * (1 - 0.4 * RNG.random(m) ** 2)
        P = np.array([px + RNG.normal(0, 0.03), y + RNG.normal(0, 0.05), PLANTER[4] - 0.06]) + d * rr[:, None] * np.array([1.3, 1.4, 0.9])
        col = autumn_colors(m, 0.35, green=0.0)
        col[:, :3] = col[:, :3] * np.array([0.55, 0.45, 0.5]) if RNG.random() < 0.5 else np.array([0.07, 0.13, 0.03]) * RNG.uniform(0.6, 1.4, (m, 1))
        add_leaves(lg, P, d + RNG.normal(0, 0.7, (m, 3)), RNG.uniform(0.02, 0.032, m), col, flat=0.6)
    lg.build('bak_daun', [MATS['leaf']])


def build_planter():
    x0, x1, y0, y1, h = PLANTER
    B = Boxes()
    t = 0.024
    nb = 3
    bh = (h - 0.03) / nb
    for k in range(nb):
        z0, z1 = 0.012 + k * bh, 0.012 + (k + 1) * bh - 0.005
        B.span(x1 - t, x1, y0, y1, z0, z1, bevel=0.004)
        B.span(x0, x0 + t, y0, y1, z0, z1, bevel=0.004)
        B.span(x0 + t, x1 - t, y0, y0 + t, z0, z1, bevel=0.004)
        B.span(x0 + t, x1 - t, y1 - t, y1, z0, z1, bevel=0.004)
    for (px, py) in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
        B.span(px - 0.012 if px == x0 else px - 0.036, px + 0.036 if px == x0 else px + 0.012,
               py - 0.012 if py == y0 else py - 0.036, py + 0.036 if py == y0 else py + 0.012, 0.0, h - 0.014, bevel=0.004)
    B.span(x1 - 0.06, x1 + 0.012, y0 - 0.012, y1 + 0.012, h - 0.014, h + 0.008, bevel=0.004)       # papan penutup atas
    B.span(x0 - 0.012, x0 + 0.06, y0 - 0.012, y1 + 0.012, h - 0.014, h + 0.008, bevel=0.004)
    B.span(x0 + 0.06, x1 - 0.06, y0 - 0.012, y0 + 0.06, h - 0.014, h + 0.008, bevel=0.004)
    B.span(x0 + 0.06, x1 - 0.06, y1 - 0.06, y1 + 0.012, h - 0.014, h + 0.008, bevel=0.004)
    g = Geo()
    B.to(g, uv=True)
    g.build('bak_kayu', [MATS['planter']])
    s = Geo()
    add_boxes(s, [((x0 + x1) / 2, (y0 + y1) / 2, (h - 0.05) / 2)], [(x1 - x0 - 2 * t, y1 - y0 - 2 * t, h - 0.05)], 0.002)
    s.build('bak_tanah', [MATS['soil']])


def build_pot_plant():
    px, py = POT
    z0 = FL
    g = Geo()
    V, F = lathe([(0.001, 0.0), (0.165, 0.0), (0.175, 0.012), (0.215, 0.37), (0.225, 0.385), (0.222, 0.40),
                  (0.205, 0.40), (0.198, 0.385), (0.19, 0.34), (0.001, 0.34)], 48)
    g.add(V + np.array([px, py, z0]), F)
    g.build('pot', [MATS['pot']], smooth=True)
    s = Geo()
    V, F = lathe([(0.001, 0.345), (0.19, 0.345), (0.191, 0.34)], 32)
    s.add(V + np.array([px, py, z0]), F)
    s.build('pot_tanah', [MATS['soil']], smooth=True)
    lf, st = Geo(), Geo()
    nl = 11
    for i in range(nl):
        az = i * 2.39996 + RNG.uniform(-0.3, 0.3)
        tilt = RNG.uniform(0.25, 0.95) if i > 1 else RNG.uniform(0.05, 0.2)
        pl = RNG.uniform(0.32, 0.62)
        ll = RNG.uniform(0.30, 0.44)
        lw = ll * RNG.uniform(0.42, 0.52)
        out_d = np.array([math.cos(az), math.sin(az), 0.0])
        b0 = np.array([px, py, z0 + 0.345]) + out_d * 0.03
        d = out_d * math.sin(tilt) + np.array([0, 0, math.cos(tilt)])
        ts = np.linspace(0, 1, 7)
        pts = np.array([b0 + d * pl * t + out_d * pl * 0.22 * t ** 2 - np.array([0, 0, 0.05 * pl]) * t ** 2 for t in ts])
        V, F, UV = tube(pts, np.linspace(0.0085, 0.005, 7), 6)
        st.add(V, F)
        tip_d = pts[-1] - pts[-2]
        tip_d /= np.linalg.norm(tip_d)
        ld = tip_d * 0.55 + out_d * 0.6 + np.array([0, 0, -0.15])
        ld /= np.linalg.norm(ld)
        side = np.cross(ld, np.array([0, 0, 1.0]))
        side /= np.linalg.norm(side)
        nrm = np.cross(side, ld)
        nu, nv = 9, 15
        U, Vv = np.meshgrid(np.linspace(-1, 1, nu), np.linspace(0, 1, nv), indexing='ij')
        wprof = np.sin(np.pi * Vv ** 0.75) ** 0.8 * (1 - 0.15 * Vv)
        Pm = (pts[-1][None, None, :] + ld[None, None, :] * (Vv * ll)[..., None] +
              side[None, None, :] * (U * wprof * lw / 2)[..., None] +
              nrm[None, None, :] * (np.abs(U) * wprof * lw * 0.16 + 0.012 * np.sin(Vv * 20) * np.abs(U))[..., None] +
              np.array([0, 0, -1.0])[None, None, :] * (Vv ** 2 * ll * 0.38)[..., None])
        idx = np.arange(nu * nv).reshape(nu, nv)
        Fq = np.stack([idx[:-1, :-1], idx[1:, :-1], idx[1:, 1:], idx[:-1, 1:]], -1).reshape(-1, 4)
        uvg = np.stack([(U + 1) / 2, Vv], -1)
        UVq = np.stack([uvg[:-1, :-1], uvg[1:, :-1], uvg[1:, 1:], uvg[:-1, 1:]], 2).reshape(-1, 2)
        col = np.array([0.035, 0.085, 0.022]) * RNG.uniform(0.8, 1.25)
        lf.add(Pm.reshape(-1, 3), Fq, attrs={'col': np.tile(np.append(col, 1.0), (nu * nv, 1))}, uvs=UVq)
    lf.build('daun_lebar', [MATS['bigleaf']], smooth=True)
    st.build('tangkai', [MATS['stem']], smooth=True)


# --------------------------------------------------------------------------------------
# Cahaya, kamera, render
# --------------------------------------------------------------------------------------
def setup_world():
    sc = bpy.context.scene
    w = bpy.data.worlds.new('dunia')
    sc.world = w
    try:
        w.use_nodes = True
    except Exception:
        pass
    nt = w.node_tree
    nt.nodes.clear()
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = 0.85
    o = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(bg.outputs[0], o.inputs['Surface'])
    if 'hdri' in TEXFILES:
        a = (HDRI_SUN_U - 0.5) * 2 * math.pi
        phi_h = math.atan2(math.sin(a), -math.cos(a))
        tc = nt.nodes.new('ShaderNodeTexCoord')
        mp = mapping(nt, tc.outputs['Generated'], rot=(0, 0, phi_h - SUN_AZ))
        env = nt.nodes.new('ShaderNodeTexEnvironment')
        env.image = bpy.data.images.load(TEXFILES['hdri'], check_existing=True)
        nt.links.new(mp, env.inputs['Vector'])
        # matahari HDRI (elevasi 9 derajat) dipotong; matahari diganti lampu Sun elevasi 24 derajat
        cl = node(nt, 'ShaderNodeVectorMath', {0: env.outputs[0], 1: (6.0, 6.0, 6.0)}, operation='MINIMUM').outputs[0]
        hs = node(nt, 'ShaderNodeHueSaturation', {'Saturation': 0.6, 'Color': cl}).outputs[0]
        nt.links.new(hs, bg.inputs['Color'])
    else:
        sky = nt.nodes.new('ShaderNodeTexSky')
        try:
            sky.sky_type = 'MULTIPLE_SCATTERING'
            sky.sun_elevation = SUN_EL
            sky.sun_rotation = math.pi / 2 - SUN_AZ
            sky.sun_disc = False
        except Exception as e:
            log('sky fallback', repr(e))
        nt.links.new(sky.outputs[0], bg.inputs['Color'])
        bg.inputs['Strength'].default_value = 0.25
    L = bpy.data.lights.new('matahari', 'SUN')
    L.energy = 7.0
    L.color = (1.0, 0.75, 0.49)
    L.angle = math.radians(2.6)
    so = bpy.data.objects.new('matahari', L)
    d = Vector((math.cos(SUN_EL) * math.cos(SUN_AZ), math.cos(SUN_EL) * math.sin(SUN_AZ), math.sin(SUN_EL)))
    so.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(so)


def orbit_angle(f):
    t = (f - 1) / 119.0
    s = 0.5 - 0.5 * math.cos(math.pi * t)          # ease in / ease out
    return -ORBIT / 2 + ORBIT * s


def setup_camera():
    sc = bpy.context.scene
    cam = bpy.data.cameras.new('kamera')
    cam.type = 'ORTHO'
    cam.clip_start, cam.clip_end = 1.0, 400.0
    co = bpy.data.objects.new('kamera', cam)
    rig = bpy.data.objects.new('rig_orbit', None)
    sc.collection.objects.link(co)
    sc.collection.objects.link(rig)
    co.parent = rig
    D = 80.0
    d = Vector((math.cos(CAM_EL) * math.cos(CAM_AZ0), math.cos(CAM_EL) * math.sin(CAM_AZ0), math.sin(CAM_EL)))
    co.location = d * D
    co.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    # bingkai: diorama di tengah, ruang kosong lega atas-bawah
    up = Vector((-math.sin(CAM_EL) * math.cos(CAM_AZ0), -math.sin(CAM_EL) * math.sin(CAM_AZ0), math.cos(CAM_EL)))
    vs, hs = [], []
    upn = np.array(up[:], np.float32)
    for ob in sc.objects:
        if ob.type != 'MESH' or ob.name == 'backdrop':
            continue
        vc = np.empty(len(ob.data.vertices) * 3, np.float32)
        ob.data.vertices.foreach_get('co', vc)
        vc = vc.reshape(-1, 3)
        pv = vc @ upn
        vs += [float(pv.min()), float(pv.max())]
        for a in range(-20, 21, 4):
            ang = CAM_AZ0 + math.radians(a)
            hs.append(float(np.abs(vc @ np.array([-math.sin(ang), math.cos(ang), 0], np.float32)).max()))
    vmid = (min(vs) + max(vs)) / 2
    rig.location = (0, 0, vmid / math.cos(CAM_EL))
    width = 2 * max(hs) * 1.06
    height = (max(vs) - min(vs))
    cam.ortho_scale = max(width * 1920 / 1080, height * 1.9)
    log('kamera: lebar isi %.2f m, tinggi isi %.2f m, ortho_scale %.2f' % (2 * max(hs), height, cam.ortho_scale))
    sc.camera = co
    for f in range(1, 121):
        rig.rotation_euler = (0, 0, orbit_angle(f))
        rig.keyframe_insert('rotation_euler', index=2, frame=f)
    return rig


def setup_render():
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.render.resolution_x, sc.render.resolution_y = 1080, 1920
    sc.render.resolution_percentage = ARGS.scale
    sc.render.fps = 24
    sc.frame_start, sc.frame_end = 1, 120
    cy = sc.cycles
    dev = 'CPU'
    if ARGS.device in ('AUTO', 'GPU'):
        try:
            prefs = bpy.context.preferences.addons['cycles'].preferences
            for kind in ('OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI'):
                try:
                    prefs.compute_device_type = kind
                    prefs.get_devices()
                    gpus = [d for d in prefs.devices if d.type == kind]
                    if gpus:
                        for d in prefs.devices:
                            d.use = (d.type == kind)
                        dev = 'GPU'
                        log('GPU:', kind, [d.name for d in gpus])
                        break
                except Exception:
                    continue
        except Exception as e:
            log('cek GPU gagal', repr(e))
    cy.device = dev
    log('device render:', dev)
    cy.samples = ARGS.samples
    cy.use_adaptive_sampling = False
    cy.use_denoising = True
    try:
        cy.denoiser = 'OPENIMAGEDENOISE'
        cy.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
        cy.denoising_prefilter = 'ACCURATE'
        cy.denoising_quality = 'HIGH'
    except Exception as e:
        log('setel denoiser:', repr(e))
    cy.max_bounces = 16
    cy.diffuse_bounces = 8
    cy.glossy_bounces = 8
    cy.transmission_bounces = 16
    cy.transparent_max_bounces = 32
    cy.volume_bounces = 0
    cy.caustics_reflective = True
    cy.caustics_refractive = True
    cy.blur_glossy = 0.5
    cy.sample_clamp_indirect = 10.0
    cy.pixel_filter_type = 'BLACKMAN_HARRIS'
    cy.filter_width = 1.5
    sc.render.use_persistent_data = True
    if ARGS.threads:
        sc.render.threads_mode = 'FIXED'
        sc.render.threads = ARGS.threads
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGB'
    sc.render.image_settings.color_depth = '8'
    sc.render.image_settings.compression = 30
    sc.render.dither_intensity = 1.0
    vs = sc.view_settings
    vs.view_transform = 'AgX'
    for look in ('AgX - Medium High Contrast', 'Medium High Contrast'):
        try:
            vs.look = look
            break
        except Exception:
            continue
    vs.exposure = -0.28
    vs.gamma = 1.0
    if ARGS.crop:
        x0, x1, y0, y1 = [float(v) for v in ARGS.crop.split(',')]
        sc.render.use_border = True
        sc.render.use_crop_to_border = True
        sc.render.border_min_x, sc.render.border_max_x = x0, x1
        sc.render.border_min_y, sc.render.border_max_y = y0, y1


def ffmpeg_exe():
    exe = shutil.which('ffmpeg')
    if exe:
        return exe
    try:
        import imageio_ffmpeg
    except ImportError:
        subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'imageio-ffmpeg'], check=False)
        import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def encode(frames_dir, start):
    mp4 = os.path.join(ARGS.out, 'house_diorama.mp4')
    cmd = [ffmpeg_exe(), '-y', '-framerate', '24', '-start_number', str(start), '-i',
           os.path.join(frames_dir, 'frame_%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
           '-preset', 'slow', '-b:v', '30M', '-maxrate', '40M', '-bufsize', '60M', '-movflags', '+faststart', mp4]
    r = subprocess.run(cmd, capture_output=True, text=True)
    log('encode', 'OK' if r.returncode == 0 else 'GAGAL ' + r.stderr[-400:], mp4)
    return mp4


def main():
    frames_dir = os.path.join(ARGS.out, 'frames')
    os.makedirs(frames_dir, exist_ok=True)
    if ARGS.encode_only:
        encode(frames_dir, ARGS.start)
        return
    log('=== mulai; bpy', bpy.app.version_string, 'args', vars(ARGS))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ensure_assets()
    build_materials()
    global ICO5
    ICO5 = ico(5)
    build_site()
    build_house()
    build_interior()
    build_planter()
    build_pot_plant()
    build_rocks()
    build_pebbles()
    build_ornamental()
    build_shrub()
    build_trees()
    build_lawn()
    setup_world()
    rig = setup_camera()
    setup_render()
    tv = sum(v for v, f in STATS.values())
    tf = sum(f for v, f in STATS.values())
    log('scene jadi: %d objek mesh, %.2f juta vertex, %.2f juta face' % (len(STATS), tv / 1e6, tf / 1e6))
    sc = bpy.context.scene
    if ARGS.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(ARGS.save_blend))
    if ARGS.still is not None:
        sc.frame_set(ARGS.still)
        rig.rotation_euler = (0, 0, orbit_angle(ARGS.still))
        path = os.path.join(ARGS.out, 'still_%04d%s.png' % (ARGS.still, ARGS.tag))
        sc.render.filepath = path
        t = time.time()
        bpy.ops.render.render(write_still=True)
        log('STILL frame %d selesai dalam %.1f detik -> %s' % (ARGS.still, time.time() - t, path))
    if ARGS.anim:
        times = []
        order = range(ARGS.end, ARGS.start - 1, -1) if ARGS.reverse else range(ARGS.start, ARGS.end + 1)
        for f in order:
            path = os.path.join(frames_dir, 'frame_%04d.png' % f)
            if os.path.exists(path) and os.path.getsize(path) > 0:
                continue
            need = (max(times) if times else ARGS.frame_guess) * 1.12
            if ARGS.budget and (time.time() - T0) + need > ARGS.budget:
                log('BUDGET waktu habis sebelum frame %d, berhenti rapi' % f)
                break
            sc.frame_set(f)
            rig.rotation_euler = (0, 0, orbit_angle(f))
            tmp = os.path.join(frames_dir, 'tmp_%04d.png' % f)
            sc.render.filepath = tmp
            t = time.time()
            bpy.ops.render.render(write_still=True)
            os.replace(tmp, path)
            times.append(time.time() - t)
            left = sum(1 for k in range(ARGS.start, ARGS.end + 1)
                       if not os.path.exists(os.path.join(frames_dir, 'frame_%04d.png' % k)))
            log('FRAME %d/%d selesai %.1f dtk (rata-rata %.1f dtk), sisa %d frame, perkiraan %.1f menit' %
                (f, ARGS.end, times[-1], sum(times) / len(times), left, left * sum(times) / len(times) / 60))
        if all(os.path.exists(os.path.join(frames_dir, 'frame_%04d.png' % k)) for k in range(1, 121)):
            encode(frames_dir, 1)
        log('ANIMASI SELESAI')


if __name__ == '__main__':
    main()
