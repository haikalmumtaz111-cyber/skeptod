#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
warung_diorama.py
Diorama potongan jalan + warung tenda kaki lima, malam habis hujan. Blender 4.5 LTS, Cycles.

Jalan lewat dua cara:
    blender -b -P warung_diorama.py -- --device AUTO --frames 1-120 --out ./out
    python  warung_diorama.py --device CPU --frames 60 --out ./out      (modul bpy)

Semua aset luar (tekstur PBR + beberapa model) CC0 dari Poly Haven, diunduh sendiri oleh
script ke --assets. Semua simulasi (kain terpal, kain spanduk, uap, gerimis) dibake ulang
oleh script ke --cache kalau cache-nya belum ada.
"""
import bpy, bmesh, sys, os, math, json, time, random, struct, argparse, shutil, hashlib, subprocess
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from math import radians, sin, cos, pi, sqrt, atan2
from mathutils import Vector, Matrix, Euler

T0 = time.time()


def log(*a):
    print('[warung %7.1fs]' % (time.time() - T0), *a, flush=True)


# ----------------------------------------------------------------------------------------------
# Argumen
# ----------------------------------------------------------------------------------------------
def parse_args():
    if '--' in sys.argv:
        argv = sys.argv[sys.argv.index('--') + 1:]
    elif sys.argv and sys.argv[0].endswith('.py'):
        argv = sys.argv[1:]
    else:
        argv = []
    here = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else os.getcwd()
    p = argparse.ArgumentParser(prog='warung_diorama.py')
    p.add_argument('--device', default='AUTO', choices=['AUTO', 'OPTIX', 'CUDA', 'CPU'],
                   help='AUTO = OptiX, kalau gagal CUDA, kalau gagal CPU')
    p.add_argument('--res', default='1080x1920', help='LEBARxTINGGI')
    p.add_argument('--scale', type=int, default=100, help='persen resolusi')
    p.add_argument('--samples', type=int, default=512)
    p.add_argument('--frames', default='1-120', help='contoh: 60 | 1-120 | 1,60,120')
    p.add_argument('--out', default=os.path.join(here, 'out'))
    p.add_argument('--assets', default=os.path.join(here, 'assets_cache'))
    p.add_argument('--cache', default=None, help='folder cache simulasi (default: <out>/sim_cache)')
    p.add_argument('--overwrite', action='store_true', help='render ulang frame yang sudah ada')
    p.add_argument('--no-render', action='store_true')
    p.add_argument('--save-blend', default=None)
    p.add_argument('--skip-sim', action='store_true', help='(debug) lewati semua simulasi')
    p.add_argument('--rebake', action='store_true', help='buang cache simulasi lalu bake ulang')
    p.add_argument('--seed', type=int, default=7)
    p.add_argument('--blender-bin', default=None, help='binary Blender untuk bake uap kalau script jalan sebagai modul bpy')
    p.add_argument('--steam-only', action='store_true', help='(internal) bake cache uap saja lalu keluar')
    p.add_argument('--threads', type=int, default=0)
    p.add_argument('--no-denoise', action='store_true')
    p.add_argument('--no-bloom', action='store_true', help='(debug) matikan bloom kompositor')
    p.add_argument('--cam-el', type=float, default=None, help='(debug) elevasi kamera')
    p.add_argument('--crop', default=None, help='(debug) x0,x1,y0,y1 border 0..1; beberapa dipisah ;')
    a = p.parse_args(argv)
    a.w, a.h = [int(v) for v in a.res.lower().split('x')]
    fr = []
    for part in a.frames.split(','):
        if '-' in part.strip()[1:]:
            s, e = part.rsplit('-', 1)
            fr += list(range(int(s), int(e) + 1))
        else:
            fr.append(int(part))
    a.frame_list = fr
    a.cache = a.cache or os.path.join(a.out, 'sim_cache')
    for d in (a.out, a.assets, a.cache):
        os.makedirs(d, exist_ok=True)
    return a


ARGS = parse_args()
RND = random.Random(ARGS.seed)
FPS = 24
F_START, F_END = 1, 120

# ----------------------------------------------------------------------------------------------
# Aset Poly Haven (CC0)
# ----------------------------------------------------------------------------------------------
UA = {'User-Agent': 'warung-diorama-script/1.0'}
PH_API = 'https://api.polyhaven.com'
# kunci: (slug, ukuran ubin dalam meter, resolusi)
TEX = {
    'asphalt': ('asphalt_02', 3.0, '2k'),
    'conc_crack': ('cracked_concrete', 2.0, '2k'),
    'conc_dirty': ('dirty_concrete', 3.0, '2k'),
    'brick': ('red_brick_03', 1.0, '1k'),
    'plaster': ('worn_plaster_wall', 1.8, '2k'),
    'paint_peel': ('peeling_painted_wall', 1.8, '2k'),
    'wood_blue': ('blue_painted_planks', 1.0, '1k'),
    'wood_green': ('green_rough_planks', 1.5, '1k'),
    'wood_brown': ('weathered_brown_planks', 1.8, '2k'),
    'wood_worn': ('worn_planks', 1.4, '1k'),
    'plywood': ('plywood', 0.5, '1k'),
    'wood_rough': ('rough_wood', 0.5, '1k'),
    'metal_white': ('rusty_metal_02', 1.0, '1k'),
    'metal_dark': ('rusty_metal_04', 2.0, '2k'),
    'metal_red': ('rusty_painted_metal', 2.2, '2k'),
    'metal_green': ('green_metal_rust', 1.0, '1k'),
    'rust': ('rust_coarse_01', 2.2, '2k'),
    'seng': ('worn_corrugated_iron', 1.8, '2k'),
    'soil': ('excavated_soil_wall', 2.0, '2k'),
    'gravel': ('gravel_stones', 2.0, '2k'),
    'mudrock': ('brown_mud_rocks_01', 1.3, '1k'),
    'stonewall': ('rock_wall_08', 2.0, '2k'),
}
MODELS = ['exterior_aircon_unit', 'water_manhole_cover', 'potted_plant_01', 'potted_plant_02',
          'potted_plant_04', 'plastic_thermos', 'small_lpg_tank', 'plastic_crate_02', 'trashbag',
          'plastic_monobloc_chair_01', 'weed_plant_02', 'grass_medium_01', 'cardboard_box_01',
          'old_tyre']
TEX_PATH = {}    # kunci -> {'col','rough','h'}
MODEL_PATH = {}  # slug -> .blend


def _ssl_ctx():
    import ssl
    for cand in (os.environ.get('SSL_CERT_FILE'), os.environ.get('REQUESTS_CA_BUNDLE'),
                 '/etc/ssl/certs/ca-certificates.crt'):
        if cand and os.path.exists(cand):
            return ssl.create_default_context(cafile=cand)
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


_CTX = None


def http_get(url, dst, tries=5):
    global _CTX
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return dst
    if _CTX is None:
        _CTX = _ssl_ctx()
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    err = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            tmp = dst + '.part%d' % os.getpid()
            with urllib.request.urlopen(req, timeout=180, context=_CTX) as r, open(tmp, 'wb') as f:
                shutil.copyfileobj(r, f)
            os.replace(tmp, dst)
            return dst
        except Exception as e:  # noqa
            err = e
            time.sleep(2.0 * (i + 1))
    raise RuntimeError('Gagal mengunduh %s -> %s (%s). Cek koneksi lalu jalankan ulang; '
                       'file yang sudah terunduh tidak diulang.' % (url, dst, err))


def ph_files(slug):
    dst = os.path.join(ARGS.assets, 'api', slug + '.json')
    http_get('%s/files/%s' % (PH_API, slug), dst)
    with open(dst) as f:
        return json.load(f)


def ensure_assets():
    """Kumpulkan semua URL lalu unduh paralel. Aman dijalankan berulang."""
    jobs = []
    slugs = sorted(set([v[0] for v in TEX.values()] + MODELS))
    with ThreadPoolExecutor(8) as ex:
        info = dict(zip(slugs, ex.map(ph_files, slugs)))
    for key, (slug, _tile, res) in TEX.items():
        d = info[slug]
        out = {}
        for short, name in (('col', 'Diffuse'), ('rough', 'Rough'), ('h', 'Displacement')):
            url = d[name][res]['jpg']['url']
            dst = os.path.join(ARGS.assets, 'tex', slug, os.path.basename(url))
            jobs.append((url, dst))
            out[short] = dst
        TEX_PATH[key] = out
    for slug in MODELS:
        b = info[slug]['blend']['1k']['blend']
        root = os.path.join(ARGS.assets, 'models', slug)
        dst = os.path.join(root, os.path.basename(b['url']))
        jobs.append((b['url'], dst))
        for rel, inc in b.get('include', {}).items():
            jobs.append((inc['url'], os.path.join(root, rel)))
        MODEL_PATH[slug] = dst
    todo = [j for j in jobs if not (os.path.exists(j[1]) and os.path.getsize(j[1]) > 0)]
    log('aset: %d file, %d perlu diunduh' % (len(jobs), len(todo)))
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda j: http_get(*j), todo))
    log('aset siap')


# ----------------------------------------------------------------------------------------------
# Helper objek / mesh
# ----------------------------------------------------------------------------------------------
SCN = None
COL = None


def link(ob, parent=None):
    COL.objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


def grp(name, loc=(0, 0, 0), rot=(0, 0, 0), parent=None, scale=1.0):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.1
    e.location = loc
    e.rotation_euler = rot
    e.scale = (scale,) * 3 if not isinstance(scale, (tuple, list)) else scale
    return link(e, parent)


def set_smooth(me, sharp_angle=None):
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    if sharp_angle:
        me.set_sharp_from_angle(angle=radians(sharp_angle))
    me.update()


def add_bevel(ob, w, segs=2, angle=35):
    if w and w > 0:
        m = ob.modifiers.new('Bevel', 'BEVEL')
        m.width = w
        m.segments = segs
        m.limit_method = 'ANGLE'
        m.angle_limit = radians(angle)
        m.harden_normals = True
    return ob


def mk(name, bm, mat=None, loc=(0, 0, 0), rot=(0, 0, 0), parent=None, bevel=0.0, smooth=True,
       sharp=None, sub=0, bsegs=2):
    """bmesh -> objek. Semua tepi keras dibevel lewat modifier."""
    me = bpy.data.meshes.new(name)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        set_smooth(me, sharp if sharp else (None if bevel else 40))
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    ob.rotation_euler = rot
    if mat is not None:
        if isinstance(mat, (list, tuple)):
            for m in mat:
                me.materials.append(m)
        else:
            me.materials.append(mat)
    add_bevel(ob, bevel, bsegs)
    if sub:
        s = ob.modifiers.new('Sub', 'SUBSURF')
        s.levels = s.render_levels = sub
    return link(ob, parent)


def box(name, size, loc=(0, 0, 0), mat=None, bevel=0.003, rot=(0, 0, 0), parent=None, base=False,
        sub=0, bsegs=2):
    """Kotak ukuran nyata. base=True: loc = titik tengah alas."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]
        v.co.y *= size[1]
        v.co.z *= size[2]
        if base:
            v.co.z += size[2] / 2
    return mk(name, bm, mat, loc, rot, parent, min(bevel, min(size) * 0.45), sub=sub, bsegs=bsegs)


def box2(name, lo, hi, mat=None, bevel=0.003, parent=None, top_mat=None):
    """Kotak dari sudut min/max dalam koordinat dunia (origin objek tetap di 0 supaya
    koordinat tekstur Object = koordinat dunia). top_mat: material beda untuk sisi atas."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x = lo[0] if v.co.x < 0 else hi[0]
        v.co.y = lo[1] if v.co.y < 0 else hi[1]
        v.co.z = lo[2] if v.co.z < 0 else hi[2]
    mats = mat
    if top_mat is not None:
        mats = [mat, top_mat]
        bm.faces.ensure_lookup_table()
        for f in bm.faces:
            if f.normal.z > 0.9 or f.calc_center_median().z > hi[2] - 1e-6:
                f.material_index = 1
    ob = mk(name, bm, mats, parent=parent, bevel=bevel)
    return ob


def cyl(name, r, h, loc=(0, 0, 0), mat=None, n=24, bevel=0.003, rot=(0, 0, 0), parent=None, r2=None,
        base=True, cap=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=n, radius1=r,
                          radius2=r if r2 is None else r2, depth=h)
    if base:
        for v in bm.verts:
            v.co.z += h / 2
    return mk(name, bm, mat, loc, rot, parent, min(bevel, r * 0.45, h * 0.45), sharp=None if bevel else 40)


def lathe(name, prof, mat=None, n=32, loc=(0, 0, 0), rot=(0, 0, 0), parent=None, sub=0, solid=0.0,
          bevel=0.0012, sharp=50):
    """Putar profil [(r, z), ...] mengelilingi sumbu Z."""
    bm = bmesh.new()
    rings = []
    for (r, z) in prof:
        if r <= 1e-6:
            rings.append([bm.verts.new((0, 0, z))])
        else:
            rings.append([bm.verts.new((r * cos(2 * pi * i / n), r * sin(2 * pi * i / n), z)) for i in range(n)])
    for a, b in zip(rings[:-1], rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            if len(a) == 1 and len(b) == 1:
                continue
            if len(a) == 1:
                bm.faces.new((a[0], b[j], b[i]))
            elif len(b) == 1:
                bm.faces.new((a[i], a[j], b[0]))
            else:
                bm.faces.new((a[i], a[j], b[j], b[i]))
    span = max(max(p[0] for p in prof), max(p[1] for p in prof) - min(p[1] for p in prof))
    ob = mk(name, bm, mat, loc, rot, parent, 0.0 if (sub or solid) else min(bevel, span * 0.02), sharp=sharp, bsegs=1)
    if solid:
        s = ob.modifiers.new('Solid', 'SOLIDIFY')
        s.thickness = solid
        s.offset = 1.0
        s.use_rim = True
    if sub:
        s = ob.modifiers.new('Sub', 'SUBSURF')
        s.levels = s.render_levels = sub
    return ob


def loft(name, rings, mat=None, loc=(0, 0, 0), rot=(0, 0, 0), parent=None, closed=True, caps=True,
         sub=0, bevel=0.0, sharp=None, solid=0.0):
    """Jahit deretan cincin titik (jumlah titik sama) jadi permukaan."""
    bm = bmesh.new()
    vr = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(vr[0])
    for a, b in zip(vr[:-1], vr[1:]):
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if caps and closed:
        bm.faces.new(vr[0][::-1])
        bm.faces.new(vr[-1])
    ob = mk(name, bm, mat, loc, rot, parent, bevel, sharp=sharp)
    if solid:
        s = ob.modifiers.new('Solid', 'SOLIDIFY')
        s.thickness = solid
        s.offset = 0.0
    if sub:
        s = ob.modifiers.new('Sub', 'SUBSURF')
        s.levels = s.render_levels = sub
    return ob


def rrect(w, d, r, n=4, z=0.0, cx=0.0, cy=0.0):
    """Cincin persegi panjang bersudut bulat (untuk loft)."""
    pts = []
    r = min(r, w / 2 - 1e-4, d / 2 - 1e-4)
    for (sx, sy, a0) in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        for k in range(n + 1):
            a = radians(a0 + 90.0 * k / n)
            pts.append((cx + sx * (w / 2 - r) + r * cos(a), cy + sy * (d / 2 - r) + r * sin(a), z))
    return pts


def fillet(pts, r, n=5):
    """Bulatkan sudut polyline."""
    pts = [Vector(p) for p in pts]
    if r <= 0 or len(pts) < 3:
        return pts
    out = [pts[0]]
    for a, b, c in zip(pts[:-2], pts[1:-1], pts[2:]):
        d1, d2 = (a - b), (c - b)
        l1, l2 = d1.length, d2.length
        if l1 < 1e-6 or l2 < 1e-6:
            out.append(b)
            continue
        rr = min(r, l1 * 0.45, l2 * 0.45)
        p1 = b + d1.normalized() * rr
        p2 = b + d2.normalized() * rr
        for k in range(n + 1):
            t = k / n
            out.append((1 - t) ** 2 * p1 + 2 * t * (1 - t) * b + t ** 2 * p2)
    out.append(pts[-1])
    return out


def tube(name, pts, r, mat=None, parent=None, loc=(0, 0, 0), rot=(0, 0, 0), res=3, cyclic=False,
         fil=0.0, caps=True, taper=None):
    """Pipa/kabel: kurva POLY dengan bevel bulat."""
    if fil:
        pts = fillet(pts, fil)
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        sp.points[i].co = (p[0], p[1], p[2], 1.0)
        if taper:
            sp.points[i].radius = taper(i / max(1, len(pts) - 1))
    sp.use_cyclic_u = cyclic
    cu.bevel_depth = r
    cu.bevel_resolution = res
    cu.use_fill_caps = caps
    ob = bpy.data.objects.new(name, cu)
    ob.location = loc
    ob.rotation_euler = rot
    if mat:
        cu.materials.append(mat)
    return link(ob, parent)


def sag_pts(a, b, sag, n=24, wob=0.0, rnd=None):
    """Titik kabel menggantung (parabola) dari a ke b."""
    a, b = Vector(a), Vector(b)
    pts = []
    ph = (rnd or RND).uniform(0, 6.28)
    side = (b - a).cross(Vector((0, 0, 1)))
    side = side.normalized() if side.length > 1e-6 else Vector((1, 0, 0))
    for i in range(n + 1):
        t = i / n
        p = a.lerp(b, t)
        p.z -= sag * 4 * t * (1 - t)
        if wob:
            p += side * (wob * sin(t * 9.0 + ph) * sin(pi * t))
            p.z += wob * 0.6 * sin(t * 15.0 + ph * 2) * sin(pi * t)
        pts.append(p)
    return pts


def grid(name, x0, x1, y0, y1, nx, ny, mat=None, z=0.0, parent=None, zf=None):
    """Grid dengan UV 0..1. zf(x, y) -> z opsional."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    vs = [[bm.verts.new((x0 + (x1 - x0) * i / nx, y0 + (y1 - y0) * j / ny,
                         zf(x0 + (x1 - x0) * i / nx, y0 + (y1 - y0) * j / ny) if zf else z))
           for i in range(nx + 1)] for j in range(ny + 1)]
    for j in range(ny):
        for i in range(nx):
            f = bm.faces.new((vs[j][i], vs[j][i + 1], vs[j + 1][i + 1], vs[j + 1][i]))
            for lp, (a, b) in zip(f.loops, ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))):
                lp[uv].uv = (a / nx, b / ny)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_smooth(me)
    ob = bpy.data.objects.new(name, me)
    if mat:
        me.materials.append(mat)
    return link(ob, parent)


def text(name, body, size, mat=None, loc=(0, 0, 0), rot=(0, 0, 0), parent=None, extrude=0.0004,
         ax='CENTER', ay='CENTER', bold=0.0, shear=0.0, spacing=1.0):
    cu = bpy.data.curves.new(name, 'FONT')
    cu.body = body
    cu.size = size
    cu.align_x = ax
    cu.align_y = ay
    cu.extrude = extrude
    cu.bevel_depth = extrude * 0.5
    cu.bevel_resolution = 1
    cu.offset = bold * size
    cu.shear = shear
    cu.space_character = spacing
    cu.resolution_u = 4
    ob = bpy.data.objects.new(name, cu)
    ob.location = loc
    ob.rotation_euler = rot
    if mat:
        cu.materials.append(mat)
    return link(ob, parent)


def dup(ob, loc=None, rot=None, parent=None, scale=None, _top=True):
    """Duplikat objek berikut anak-anaknya (data mesh dibagi)."""
    c = ob.copy()
    link(c)
    if _top:
        c.parent = parent if parent is not None else ob.parent
        if loc is not None:
            c.location = loc
        if rot is not None:
            c.rotation_euler = rot
        if scale is not None:
            c.scale = (scale,) * 3 if not isinstance(scale, (tuple, list)) else scale
    for ch in ob.children:
        cc = dup(ch, _top=False)
        cc.parent = c
        cc.matrix_parent_inverse = ch.matrix_parent_inverse.copy()
    return c


# ----------------------------------------------------------------------------------------------
# Pembangun node shader
# ----------------------------------------------------------------------------------------------
def _c4(v):
    if isinstance(v, (int, float)):
        return (v, v, v, 1.0)
    v = tuple(v)
    return v if len(v) == 4 else v + (1.0,)


class NB:
    def __init__(self, name):
        self.mat = bpy.data.materials.new(name)
        self.mat.use_nodes = True
        self.nt = self.mat.node_tree
        self.nt.nodes.clear()
        self.out = self.nt.nodes.new('ShaderNodeOutputMaterial')
        self._tc = None
        self._geo = None
        self._time = None
        self._oi = None

    def node(self, typ, **kw):
        n = self.nt.nodes.new(typ)
        for k, v in kw.items():
            setattr(n, k, v)
        return n

    def set(self, sock, v):
        if v is None:
            return
        if isinstance(v, bpy.types.NodeSocket):
            self.nt.links.new(v, sock)
        elif sock.type == 'RGBA':
            sock.default_value = _c4(v)
        elif sock.type == 'VECTOR':
            sock.default_value = (v, v, v) if isinstance(v, (int, float)) else tuple(v)[:3]
        else:
            sock.default_value = v

    # --- koordinat
    def obj(self):
        if self._tc is None:
            self._tc = self.node('ShaderNodeTexCoord')
        return self._tc.outputs['Object']

    def uv(self):
        self.obj()
        return self._tc.outputs['UV']

    def geo(self, name='Normal'):
        if self._geo is None:
            self._geo = self.node('ShaderNodeNewGeometry')
        return self._geo.outputs[name]

    def objrand(self):
        if self._oi is None:
            self._oi = self.node('ShaderNodeObjectInfo')
        return self._oi.outputs['Random']

    def time(self):
        """Detik, lewat driver frame/24 (ekspresi sederhana, tanpa Python)."""
        if self._time is None:
            self._time = self.node('ShaderNodeValue')
            fc = self._time.outputs[0].driver_add('default_value')
            fc.driver.expression = 'frame/%d' % FPS
        return self._time.outputs[0]

    def mapping(self, vec, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
        n = self.node('ShaderNodeMapping')
        self.set(n.inputs['Vector'], vec)
        self.set(n.inputs['Location'], loc)
        self.set(n.inputs['Rotation'], rot)
        self.set(n.inputs['Scale'], (scale,) * 3 if isinstance(scale, (int, float)) else scale)
        return n.outputs[0]

    # --- matematika
    def math(self, op, a, b=None, c=None, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.set(n.inputs[0], a)
        self.set(n.inputs[1], b)
        self.set(n.inputs[2], c)
        return n.outputs[0]

    def add(self, a, b): return self.math('ADD', a, b)
    def sub(self, a, b): return self.math('SUBTRACT', a, b)
    def mul(self, a, b): return self.math('MULTIPLY', a, b)
    def mx(self, a, b): return self.math('MAXIMUM', a, b)
    def mn(self, a, b): return self.math('MINIMUM', a, b)
    def inv(self, a): return self.math('SUBTRACT', 1.0, a, clamp=True)

    def vmath(self, op, a, b=None, scale=None):
        n = self.node('ShaderNodeVectorMath', operation=op)
        self.set(n.inputs[0], a)
        if b is not None:
            self.set(n.inputs[1], b)
        if scale is not None:
            self.set(n.inputs['Scale'], scale)
        return n.outputs['Value'] if op in ('LENGTH', 'DOT_PRODUCT', 'DISTANCE') else n.outputs[0]

    def sep(self, v):
        n = self.node('ShaderNodeSeparateXYZ')
        self.set(n.inputs[0], v)
        return n.outputs[0], n.outputs[1], n.outputs[2]

    def comb(self, x=0.0, y=0.0, z=0.0):
        n = self.node('ShaderNodeCombineXYZ')
        self.set(n.inputs[0], x)
        self.set(n.inputs[1], y)
        self.set(n.inputs[2], z)
        return n.outputs[0]

    def mix(self, f, a, b, blend='MIX', clamp=True):
        """Campur warna."""
        n = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_result=clamp)
        self.set(n.inputs[0], f)
        self.set(n.inputs[6], a)
        self.set(n.inputs[7], b)
        return n.outputs[2]

    def lerp(self, f, a, b):
        n = self.node('ShaderNodeMix', data_type='FLOAT')
        self.set(n.inputs[0], f)
        self.set(n.inputs[2], a)
        self.set(n.inputs[3], b)
        return n.outputs[0]

    def mr(self, v, a, b, c=0.0, d=1.0, smooth=False, clamp=True):
        n = self.node('ShaderNodeMapRange', clamp=clamp,
                      interpolation_type='SMOOTHSTEP' if smooth else 'LINEAR')
        for i, x in enumerate((v, a, b, c, d)):
            self.set(n.inputs[i], x)
        return n.outputs[0]

    def ramp(self, f, stops, interp='LINEAR'):
        n = self.node('ShaderNodeValToRGB')
        cr = n.color_ramp
        cr.interpolation = interp
        while len(cr.elements) < len(stops):
            cr.elements.new(0.5)
        for e, (pos, colr) in zip(cr.elements, stops):
            e.position = pos
            e.color = _c4(colr)
        self.set(n.inputs[0], f)
        return n.outputs[0]

    def hsv(self, col, h=0.5, s=1.0, v=1.0):
        n = self.node('ShaderNodeHueSaturation')
        self.set(n.inputs['Hue'], h)
        self.set(n.inputs['Saturation'], s)
        self.set(n.inputs['Value'], v)
        self.set(n.inputs['Color'], col)
        return n.outputs[0]

    # --- tekstur
    def noise(self, vec, scale, detail=4.0, rough=0.55, dist=0.0, col=False, lac=2.0):
        n = self.node('ShaderNodeTexNoise')
        self.set(n.inputs['Vector'], vec)
        self.set(n.inputs['Scale'], scale)
        self.set(n.inputs['Detail'], detail)
        self.set(n.inputs['Roughness'], rough)
        self.set(n.inputs['Lacunarity'], lac)
        self.set(n.inputs['Distortion'], dist)
        return n.outputs['Color' if col else 'Fac']

    def voro(self, vec, scale, feature='F1', rand=1.0, smooth=None):
        n = self.node('ShaderNodeTexVoronoi', feature=feature)
        self.set(n.inputs['Vector'], vec)
        self.set(n.inputs['Scale'], scale)
        self.set(n.inputs['Randomness'], rand)
        return n

    def img(self, path, vec, non_color=False, proj='BOX', blend=0.25):
        n = self.node('ShaderNodeTexImage')
        im = bpy.data.images.load(path, check_existing=True)
        if non_color:
            im.colorspace_settings.name = 'Non-Color'
        n.image = im
        n.projection = proj
        if proj == 'BOX':
            n.projection_blend = blend
        self.set(n.inputs[0], vec)
        return n

    def pbr(self, key, vec=None, scale=1.0, rot=(0, 0, 0), off=(0, 0, 0), rnd=False, proj='BOX'):
        """Tekstur PBR Poly Haven dengan proyeksi kotak di ruang objek (skala meter)."""
        slug, tile, _res = TEX[key]
        v = vec if vec is not None else self.obj()
        if rnd:
            v = self.vmath('ADD', v, self.vmath('SCALE', (13.7, 7.3, 3.1), scale=self.objrand()))
        s = 1.0 / (tile * scale)
        v = self.mapping(v, off, rot, (s, s, s))
        p = TEX_PATH[key]
        return {'col': self.img(p['col'], v, proj=proj).outputs[0],
                'rough': self.img(p['rough'], v, True, proj=proj).outputs[0],
                'h': self.img(p['h'], v, True, proj=proj).outputs[0]}

    def bump(self, h, strength=0.5, dist=0.01, normal=None):
        n = self.node('ShaderNodeBump')
        self.set(n.inputs['Strength'], strength)
        self.set(n.inputs['Distance'], dist)
        self.set(n.inputs['Height'], h)
        self.set(n.inputs['Normal'], normal)
        return n.outputs[0]

    def principled(self, **kw):
        n = self.node('ShaderNodeBsdfPrincipled')
        for k, v in kw.items():
            self.set(n.inputs[k], v)
        return n

    def finish(self, shader, disp=None, vol=None):
        self.nt.links.new(shader, self.out.inputs['Surface'])
        if disp is not None:
            self.nt.links.new(disp, self.out.inputs['Displacement'])
        if vol is not None:
            self.nt.links.new(vol, self.out.inputs['Volume'])
        return self.mat

    # --- pola hujan
    def drops(self, vec, scale=95.0, density=0.45):
        """Butir air diam: tinggi 0..1 per sel Voronoi."""
        v = self.voro(vec, scale)
        d = v.outputs['Distance']
        cs = self.node('ShaderNodeSeparateColor')
        self.set(cs.inputs[0], v.outputs['Color'])
        rad = self.mr(cs.outputs[0], 0, 1, 0.16, 0.42)
        h = self.mr(d, rad, self.mul(rad, 0.25), 0.0, 1.0, smooth=True)
        on = self.math('LESS_THAN', cs.outputs[1], density)
        return self.mul(h, on)

    def ripples(self, vec, scale, rate=1.1, active=0.6, seed=0.0):
        """Riak tetes hujan: cincin yang melebar dari titik acak tiap sel Voronoi."""
        v = self.voro(self.vmath('ADD', vec, (seed * 3.17, seed * 1.31, 0.0)), scale)
        d = v.outputs['Distance']
        cs = self.node('ShaderNodeSeparateColor')
        self.set(cs.inputs[0], v.outputs['Color'])
        t = self.math('FRACT', self.add(self.mul(self.time(), rate), self.mul(cs.outputs[0], 7.0)))
        rad = self.mul(t, 0.46)
        x = self.sub(d, rad)
        win = self.mr(self.math('ABSOLUTE', x), 0.0, 0.085, 1.0, 0.0, smooth=True)
        wave = self.math('SINE', self.mul(x, 95.0))
        fade = self.math('POWER', self.inv(t), 1.6)
        edge = self.mr(d, 0.38, 0.5, 1.0, 0.0)
        on = self.math('LESS_THAN', cs.outputs[1], active)
        return self.mul(self.mul(self.mul(wave, win), self.mul(fade, edge)), on)


# ----------------------------------------------------------------------------------------------
# Material
# ----------------------------------------------------------------------------------------------
MATS = {}


def memo(fn):
    def w(*a, **k):
        key = fn.__name__ + repr(a) + repr(sorted(k.items()))
        if key not in MATS:
            MATS[key] = fn(*a, **k)
        return MATS[key]
    return w


def band(nb, v, a, b, s=0.05):
    return nb.mul(nb.mr(v, a - s, a + s, 0.0, 1.0, smooth=True), nb.mr(v, b - s, b + s, 1.0, 0.0, smooth=True))


# zona kering di bawah tenda dan gerobak (x0, x1, y0, y1)
TENT_BOX = (-2.75, 0.25, -1.15, 0.95)
CART_BOX = (0.35, 2.15, -1.1, -0.2)


def shelter_mask(nb):
    P = nb.obj()
    w = nb.vmath('ADD', P, nb.vmath('SCALE', nb.noise(P, 1.6, 3.0, col=True), scale=0.5))
    x, y, _z = nb.sep(w)
    a = nb.mul(band(nb, x, TENT_BOX[0] + 0.25, TENT_BOX[1] + 0.25, 0.25), band(nb, y, TENT_BOX[2] + 0.25, TENT_BOX[3] + 0.25, 0.25))
    b = nb.mul(band(nb, x, CART_BOX[0] + 0.25, CART_BOX[1] + 0.25, 0.15), band(nb, y, CART_BOX[2] + 0.25, CART_BOX[3] + 0.25, 0.15))
    return nb.mx(a, b)


def wet_surface(nb, col, rough, h=None, metallic=0.0, wet=0.7, streak=0.5, drops=0.0, bump=0.5,
                bdist=0.01, coat=0.6, shelter=None, normal=None, wetdark=0.5, **extra):
    """Lapisan akhir bersama: permukaan yang menghadap ke atas lebih basah (lebih gelap, lebih
    kilap, ada lapisan coat IOR air), bidang tegak dapat aliran air, plus butir air."""
    P = nb.obj()
    nz = nb.sep(nb.geo('Normal'))[2]
    up = nb.mr(nz, -0.15, 0.75, 0.22, 1.0, smooth=True)
    var = nb.mr(nb.noise(P, 1.3, 3.0), 0.3, 0.7, 0.5, 1.0)
    wm = nb.mul(nb.mul(up, var), wet)
    if streak:
        sv = nb.mapping(P, scale=(22, 22, 0.9))
        sn = nb.mr(nb.noise(sv, 1.0, 3.0, 0.6), 0.5, 0.7, 0.0, 1.0, smooth=True)
        vert = nb.mr(nb.math('ABSOLUTE', nz), 0.0, 0.6, 1.0, 0.0)
        wm = nb.mx(wm, nb.mul(nb.mul(sn, vert), min(1.0, streak * wet * 1.6)))
    if shelter is not None:
        wm = nb.mul(wm, nb.inv(shelter))
    colw = nb.mix(wm, col, nb.hsv(col, s=1.15, v=wetdark))
    rw = nb.lerp(wm, rough, nb.add(nb.mul(rough, 0.22), 0.04))
    nrm = normal
    cn = None
    if h is not None:
        nrm = nb.bump(h, bump, bdist, nrm)
        cn = nb.bump(h, bump * 0.3, bdist)
    cw = nb.mul(wm, coat)
    if drops:
        dh = nb.drops(P, density=drops)
        if shelter is not None:
            dh = nb.mul(dh, nb.inv(shelter))
        nrm = nb.bump(dh, 0.6, 0.003, nrm)
        cn = nb.bump(dh, 0.6, 0.003, cn)
        rw = nb.lerp(dh, rw, 0.02)
        cw = nb.mx(cw, dh)
    kw = {'Base Color': colw, 'Roughness': rw, 'Metallic': metallic, 'Normal': nrm,
          'Coat Weight': cw, 'Coat Roughness': 0.05, 'Coat IOR': 1.33, 'Coat Normal': cn}
    kw.update(extra)
    return nb.principled(**kw)


@memo
def m_asphalt():
    nb = NB('AspalBasah')
    P = nb.obj()
    t = nb.pbr('asphalt')
    sh = shelter_mask(nb)
    x, y, _z = nb.sep(P)
    # medan tinggi: cekungan = genangan
    H = nb.add(nb.noise(P, 0.45, 3.0, 0.5), nb.mul(nb.noise(nb.vmath('ADD', P, (5.3, 3.1, 0)), 1.9, 2.0), 0.16))
    H = nb.add(H, nb.mul(nb.sub(t['h'], 0.5), 0.05))
    H = nb.add(H, nb.mul(sh, 0.10))                                  # di bawah tenda lebih sedikit air
    H = nb.sub(H, nb.mr(y, 0.2, 0.9, 0.0, 0.07))                     # air ngumpul ke arah selokan
    L = 0.562
    pud = nb.mr(H, L - 0.012, L + 0.012, 1.0, 0.0, smooth=True)
    deep = nb.mr(H, L - 0.16, L, 1.0, 0.0)
    damp = nb.mul(nb.mr(H, L, L + 0.26, 1.0, 0.45, smooth=True), nb.mr(sh, 0, 1, 1.0, 0.3))
    # warna: variasi besar, tambalan, garis cat pudar
    base = nb.mix(nb.mr(nb.noise(P, 0.9, 4.0), 0.3, 0.7, 0.0, 1.0), nb.hsv(t['col'], v=0.27), nb.hsv(t['col'], v=0.40))
    patch = nb.mul(band(nb, x, -3.3, -1.9, 0.02), band(nb, y, -3.4, -2.3, 0.02))
    base = nb.mix(nb.mul(patch, 0.55), base, (0.02, 0.02, 0.022))
    wear = nb.mr(nb.add(nb.noise(P, 5.0, 5.0, 0.7), nb.mul(t['h'], 0.6)), 0.72, 0.88, 0.0, 1.0)
    line = nb.mul(band(nb, y, 0.60, 0.72, 0.006), wear)
    base = nb.mix(nb.mul(line, 0.8), base, (0.5, 0.49, 0.45))
    wetc = nb.hsv(base, s=1.1, v=0.4)
    col = nb.mix(damp, base, wetc)
    col = nb.mix(nb.mul(pud, nb.mr(deep, 0, 1, 0.3, 0.8)), col, (0.016, 0.014, 0.011))
    rough = nb.lerp(damp, t['rough'], nb.add(nb.mul(t['rough'], 0.62), 0.12))
    rough = nb.lerp(pud, rough, 0.95)
    hb = nb.mul(t['h'], nb.mr(pud, 0, 1, 1.0, 0.12))
    nrm = nb.bump(hb, 1.0, 0.014)
    # riak hujan + kerut angin di genangan (tidak di bawah tenda)
    rp = nb.add(nb.ripples(P, 1.9, 0.95, 0.55, 0.0),
                nb.add(nb.mul(nb.ripples(P, 3.1, 1.3, 0.5, 1.0), 0.7), nb.mul(nb.ripples(P, 4.9, 1.7, 0.45, 2.0), 0.5)))
    rp = nb.mul(rp, nb.mul(pud, nb.mr(sh, 0.0, 0.5, 1.0, 0.0)))
    wv = nb.noise(nb.vmath('ADD', P, nb.comb(nb.mul(nb.time(), 0.06), nb.mul(nb.time(), 0.03), 0.0)), 16.0, 2.0)
    cn = nb.bump(nb.mul(hb, nb.inv(pud)), 0.9, 0.014)
    cn = nb.bump(nb.add(rp, nb.mul(nb.mul(wv, pud), 0.12)), 0.22, 0.004, cn)
    cw = nb.mx(pud, nb.mul(damp, 0.07))
    cr = nb.lerp(pud, 0.35, 0.004)
    b = nb.principled(**{'Base Color': col, 'Roughness': rough, 'Normal': nrm, 'Coat Weight': cw,
                         'Coat Roughness': cr, 'Coat IOR': 1.33, 'Coat Normal': cn,
                         'Specular IOR Level': nb.lerp(pud, 0.5, 0.0)})
    return nb.finish(b.outputs[0])


@memo
def m_sidewalk():
    nb = NB('Trotoar')
    P = nb.obj()
    x, y, _z = nb.sep(P)
    t = nb.pbr('conc_crack', scale=1.1)
    gx = nb.math('ABSOLUTE', nb.sub(nb.math('FRACT', nb.math('DIVIDE', nb.add(x, 0.37), 1.25)), 0.5))
    g = nb.mx(nb.mr(gx, 0.0, 0.006, 1.0, 0.0), nb.mr(nb.math('ABSOLUTE', nb.sub(y, 2.33)), 0.0, 0.007, 1.0, 0.0))
    slab = nb.noise(nb.comb(nb.math('FLOOR', nb.math('DIVIDE', nb.add(x, 0.37), 1.25)), nb.math('GREATER_THAN', y, 2.33), 0.0), 7.3, 0.0)
    col = nb.hsv(t['col'], s=0.75, v=nb.mr(slab, 0.2, 0.8, 0.6, 0.95))
    moss = nb.mul(nb.mx(nb.mr(y, 2.75, 3.1, 0.0, 1.0), nb.mr(y, 1.85, 1.6, 0.0, 0.7)), nb.mr(nb.noise(P, 4.0, 5.0, 0.7), 0.42, 0.62, 0.0, 1.0))
    col = nb.mix(nb.mul(moss, 0.75), col, (0.035, 0.05, 0.02))
    col = nb.mix(nb.mul(g, 0.85), col, (0.015, 0.014, 0.012))
    h = nb.sub(t['h'], nb.mul(g, 0.6))
    H = nb.add(nb.noise(P, 0.8, 3.0), nb.mul(nb.sub(t['h'], 0.5), 0.2))
    pud = nb.mr(H, 0.40, 0.43, 1.0, 0.0, smooth=True)
    col = nb.mix(nb.mul(pud, 0.5), col, (0.03, 0.028, 0.022))
    b = wet_surface(nb, col, nb.lerp(pud, t['rough'], 0.95), h, wet=0.85, streak=0, bump=0.9, bdist=0.012, coat=0.3)
    nb.set(b.inputs['Specular IOR Level'], nb.lerp(pud, 0.5, 0.0))
    rp = nb.mul(nb.add(nb.ripples(P, 2.6, 1.1, 0.5, 4.0), nb.mul(nb.ripples(P, 4.4, 1.5, 0.5, 5.0), 0.6)), pud)
    cn = nb.bump(rp, 0.2, 0.004, nb.bump(nb.mul(h, nb.inv(pud)), 0.3, 0.012))
    cw = nb.mx(pud, b.inputs['Coat Weight'].links[0].from_socket)
    nb.set(b.inputs['Coat Weight'], cw)
    nb.set(b.inputs['Coat Normal'], cn)
    nb.set(b.inputs['Coat Roughness'], nb.lerp(pud, 0.12, 0.005))
    return nb.finish(b.outputs[0])


@memo
def m_curb():
    nb = NB('Kanstin')
    P = nb.obj()
    x, _y, _z = nb.sep(P)
    t = nb.pbr('conc_dirty', scale=0.5)
    stripe = nb.math('GREATER_THAN', nb.math('FRACT', nb.math('DIVIDE', nb.add(x, 0.1), 1.2)), 0.5)
    paint = nb.mix(stripe, (0.62, 0.61, 0.56), (0.025, 0.025, 0.028))
    keep = nb.mr(nb.add(nb.noise(P, 7.0, 5.0, 0.7), nb.mul(t['h'], 0.5)), 0.62, 0.74, 1.0, 0.0)
    col = nb.mix(nb.mul(keep, 0.92), nb.hsv(t['col'], v=0.8), paint)
    b = wet_surface(nb, col, nb.lerp(keep, t['rough'], 0.45), t['h'], wet=0.85, streak=0.6, bump=0.7, bdist=0.01)
    return nb.finish(b.outputs[0])


@memo
def m_tex(name, key, scale=1.0, rot=(0, 0, 0), tint=None, val=1.0, sat=1.0, wet=0.6, streak=0.4, drops=0.0,
          bump=0.6, bdist=0.008, metallic=0.0, rnd=True, coat=0.6, grime=0.3, shelter=False, rmul=1.0):
    """Material generik dari tekstur PBR Poly Haven + kotoran + basah."""
    nb = NB(name)
    P = nb.obj()
    t = nb.pbr(key, scale=scale, rot=rot, rnd=rnd)
    col = nb.hsv(t['col'], s=sat, v=val)
    if tint is not None:
        col = nb.mix(1.0, col, tint, blend='MULTIPLY')
    if grime:
        g = nb.mr(nb.noise(P, 2.3, 5.0, 0.65), 0.45, 0.75, 0.0, grime)
        col = nb.mix(g, col, (0.03, 0.027, 0.02))
    rough = t['rough'] if rmul == 1.0 else nb.math('MULTIPLY', t['rough'], rmul, clamp=True)
    b = wet_surface(nb, col, rough, t['h'], metallic=metallic, wet=wet, streak=streak, drops=drops, bump=bump,
                    bdist=bdist, coat=coat, shelter=shelter_mask(nb) if shelter else None)
    return nb.finish(b.outputs[0])


@memo
def m_paint(name, color, rust=0.35, rough=0.4, wet=0.6, drops=0.3, streak=0.4, chip_scale=3.0, metallic=0.0,
            fade=0.25):
    """Logam bercat: cat pudar tidak rata, mengelupas ke karat di tepi/bercak."""
    nb = NB(name)
    P = nb.vmath('ADD', nb.obj(), nb.vmath('SCALE', (11.1, 5.7, 3.3), scale=nb.objrand()))
    r = nb.pbr('rust', rnd=True, scale=0.5)
    m = nb.add(nb.noise(P, chip_scale, 6.0, 0.72), nb.mul(nb.sub(r['h'], 0.5), 0.45))
    thr = 0.72 - rust * 0.3
    mask = nb.mr(m, thr, thr + 0.05, 0.0, 1.0, smooth=True)
    halo = nb.mr(m, thr - 0.12, thr, 0.0, 1.0)
    f = nb.noise(P, 1.7, 4.0, 0.6)
    pc = nb.mix(nb.mr(f, 0.3, 0.75, 0.0, fade), color, tuple(min(1.0, c * 1.3 + 0.08) for c in color[:3]))
    pc = nb.mix(nb.mul(halo, 0.45), pc, (0.16, 0.07, 0.03))
    col = nb.mix(mask, pc, nb.hsv(r['col'], v=0.8))
    rg = nb.lerp(mask, nb.add(rough, nb.mul(nb.sub(nb.noise(P, 30.0, 2.0), 0.5), 0.2)), 0.85)
    h = nb.add(nb.mul(mask, -0.6), nb.mul(nb.mul(r['h'], mask), 0.5))
    met = nb.mul(nb.inv(mask), metallic) if metallic else 0.0
    b = wet_surface(nb, col, rg, h, metallic=met, wet=wet, drops=drops, streak=streak, bump=0.5, bdist=0.004)
    return nb.finish(b.outputs[0])


@memo
def m_metal(name, color=(0.75, 0.76, 0.78), rough=0.3, rust=0.15, wet=0.6, drops=0.3, brushed=0.0, dirt=0.25):
    """Logam telanjang (galvanis, aluminium, krom) dengan bercak karat dan kusam."""
    nb = NB(name)
    P = nb.vmath('ADD', nb.obj(), nb.vmath('SCALE', (9.1, 4.7, 6.3), scale=nb.objrand()))
    r = nb.pbr('rust', rnd=True, scale=0.4)
    m = nb.add(nb.noise(P, 5.0, 6.0, 0.75), nb.mul(nb.sub(r['h'], 0.5), 0.4))
    thr = 0.75 - rust * 0.35
    mask = nb.mr(m, thr, thr + 0.06, 0.0, 1.0, smooth=True)
    dull = nb.mr(nb.noise(P, 2.0, 5.0, 0.7), 0.35, 0.75, 0.0, dirt)
    col = nb.mix(dull, color, tuple(c * 0.35 for c in color[:3]))
    col = nb.mix(mask, col, nb.hsv(r['col'], v=0.75))
    rg = nb.add(rough, nb.mul(dull, 0.35))
    if brushed:
        rg = nb.add(rg, nb.mul(nb.sub(nb.noise(nb.mapping(P, scale=(1, 1, 60)), 40.0, 2.0), 0.5), brushed))
    rg = nb.lerp(mask, rg, 0.85)
    h = nb.mul(mask, nb.sub(r['h'], 1.0))
    b = wet_surface(nb, col, rg, h, metallic=nb.inv(mask), wet=wet * 0.5, drops=drops, streak=0.3, bump=0.4, bdist=0.003)
    return nb.finish(b.outputs[0])


@memo
def m_plastic(name, color, rough=0.38, wet=0.6, drops=0.35, dirt=0.3, sss=0.0, scratch=0.25, streak=0.3, spec=0.5,
              shelter=False):
    """Plastik/karet/keramik/vinil: gores halus di roughness, debu di cekungan, butir air."""
    nb = NB(name)
    P = nb.vmath('ADD', nb.obj(), nb.vmath('SCALE', (7.1, 3.7, 5.3), scale=nb.objrand()))
    d = nb.mr(nb.noise(P, 6.0, 5.0, 0.7), 0.4, 0.8, 0.0, dirt)
    col = nb.mix(d, color, (0.09, 0.08, 0.065))
    sc = nb.noise(nb.mapping(P, rot=(0.3, 0.5, 0.2), scale=(4, 90, 4)), 9.0, 3.0, 0.7)
    rg = nb.add(nb.add(rough, nb.mul(d, 0.3)), nb.mul(nb.sub(sc, 0.5), scratch))
    h = nb.mul(nb.noise(P, 60.0, 2.0), 0.15)
    kw = {}
    if sss:
        kw = {'Subsurface Weight': sss, 'Subsurface Radius': (0.01, 0.006, 0.004), 'Subsurface Scale': 1.0}
    b = wet_surface(nb, col, rg, h, wet=wet, drops=drops, streak=streak, bump=0.15, bdist=0.001,
                    shelter=shelter_mask(nb) if shelter else None, **kw)
    return nb.finish(b.outputs[0])


@memo
def m_emit(name, color, strength):
    nb = NB(name)
    e = nb.node('ShaderNodeEmission')
    nb.set(e.inputs[0], color)
    nb.set(e.inputs[1], strength)
    return nb.finish(e.outputs[0])


@memo
def m_glass(name, tint=(0.93, 0.98, 0.95), dust=0.5, smudge=0.6, drops=0.3, rough=0.0, ior=1.5):
    """Kaca tebal (geometri solid): debu menumpuk ke bawah, bekas lap dan sidik jari di
    roughness, butir air. Bayangan dibuat tembus supaya cahaya di balik kaca tetap bersih."""
    nb = NB(name)
    P = nb.obj()
    _x, _y, z = nb.sep(P)
    dn = nb.noise(P, 4.0, 5.0, 0.7)
    dm = nb.mr(nb.add(dn, nb.mr(z, 0.0, 0.5, 0.18, 0.0)), 0.5, 0.8, 0.0, dust, smooth=True)
    sm = nb.mr(nb.noise(nb.mapping(P, rot=(0.2, 0.1, 0.6), scale=(3, 3, 14)), 4.0, 3.0, 0.6, dist=2.0), 0.5, 0.75, 0.0, smudge)
    fv = nb.voro(P, 9.0)
    fcs = nb.node('ShaderNodeSeparateColor')
    nb.set(fcs.inputs[0], fv.outputs['Color'])
    blob = nb.mul(nb.mr(fv.outputs['Distance'], 0.18, 0.3, 1.0, 0.0), nb.math('LESS_THAN', fcs.outputs[0], 0.3))
    ridge = nb.mr(nb.math('SINE', nb.mul(nb.noise(P, 14.0, 1.0, dist=0.5), 420.0)), -1, 1, 0.3, 1.0)
    fp = nb.mul(nb.mul(blob, ridge), smudge)
    rg = nb.math('ADD', nb.add(rough, nb.mul(sm, 0.28)), nb.mul(fp, 0.45), clamp=True)
    nrm = None
    if drops:
        dh = nb.drops(P, 80.0, drops)
        nrm = nb.bump(dh, 0.7, 0.003)
        rg = nb.lerp(dh, rg, 0.0)
    g = nb.principled(**{'Base Color': tint, 'Roughness': rg, 'IOR': ior, 'Transmission Weight': 1.0, 'Normal': nrm})
    dd = nb.node('ShaderNodeBsdfDiffuse')
    nb.set(dd.inputs[0], (0.30, 0.28, 0.24))
    m1 = nb.node('ShaderNodeMixShader')
    nb.set(m1.inputs[0], nb.math('ADD', dm, nb.mul(fp, 0.15), clamp=True))
    nb.nt.links.new(g.outputs[0], m1.inputs[1])
    nb.nt.links.new(dd.outputs[0], m1.inputs[2])
    tr = nb.node('ShaderNodeBsdfTransparent')
    nb.set(tr.inputs[0], nb.mix(dm, tint, (0.25, 0.25, 0.25)))
    lp = nb.node('ShaderNodeLightPath')
    m2 = nb.node('ShaderNodeMixShader')
    nb.nt.links.new(lp.outputs['Is Shadow Ray'], m2.inputs[0])
    nb.nt.links.new(m1.outputs[0], m2.inputs[1])
    nb.nt.links.new(tr.outputs[0], m2.inputs[2])
    return nb.finish(m2.outputs[0])


@memo
def m_wall():
    """Tembok bata: plester bercat dua warna yang ngelupas sampai bata kelihatan, lembap naik
    dari bawah, lumut, aliran kotor dari atas."""
    nb = NB('TembokBata')
    P = nb.obj()
    _x, _y, z = nb.sep(P)
    br = nb.pbr('brick', scale=1.0)
    pl = nb.pbr('plaster', scale=1.3)
    pl['col'] = nb.mix(0.4, pl['col'], (0.46, 0.44, 0.40))
    big = nb.noise(P, 0.6, 6.0, 0.62, dist=0.5)
    low = nb.add(nb.mr(z, 0.15, 1.7, 0.2, 0.0), nb.mr(z, 5.6, 6.4, 0.0, 0.12))
    m = nb.add(nb.add(big, low), nb.mul(nb.sub(pl['h'], 0.5), 0.3))
    xx = nb.sep(P)[0]
    warp = nb.noise(P, 1.7, 4.0, 0.6)
    for (cx, cz, rad) in ((1.35, 2.35, 0.75), (-3.1, 3.9, 0.7), (3.3, 5.3, 0.8), (-1.6, 5.7, 0.55), (3.1, 0.75, 0.6), (-2.4, 1.0, 0.5)):
        dd = nb.add(nb.vmath('LENGTH', nb.comb(nb.sub(xx, cx), 0.0, nb.mul(nb.sub(z, cz), 1.25))), nb.mul(nb.sub(warp, 0.5), 0.9))
        m = nb.add(m, nb.mr(dd, 0.0, rad, 0.3, 0.0, smooth=True))
    plaster = nb.mr(m, 0.6, 0.62, 1.0, 0.0)
    rim = nb.mul(nb.mr(m, 0.49, 0.615, 0.0, 1.0), plaster)
    dado = nb.mr(nb.add(z, nb.mul(nb.sub(nb.noise(P, 3.0, 2.0), 0.5), 0.02)), 1.38, 1.40, 1.0, 0.0)
    tintc = nb.mix(dado, (0.80, 0.70, 0.50), (0.16, 0.36, 0.34))
    painted = nb.hsv(nb.mix(1.0, pl['col'], tintc, blend='MULTIPLY'), v=1.9)
    keep = nb.mr(nb.add(nb.noise(P, 1.3, 6.0, 0.7), nb.mul(nb.sub(pl['h'], 0.5), 0.4)), 0.34, 0.38, 0.0, 1.0)
    pc = nb.mix(keep, nb.hsv(pl['col'], v=0.85), painted)
    pc = nb.mix(nb.mul(rim, 0.55), pc, (0.07, 0.06, 0.05))
    col = nb.mix(plaster, nb.hsv(br['col'], s=1.15, v=1.7), pc)
    damp = nb.mul(nb.mr(z, 0.15, 1.0, 1.0, 0.0), nb.mr(nb.noise(P, 1.5, 4.0, 0.6), 0.25, 0.7, 0.3, 1.0))
    col = nb.mix(nb.mul(damp, 0.6), col, (0.035, 0.045, 0.022))
    gs = nb.mr(nb.noise(nb.mapping(P, scale=(7, 7, 0.3)), 1.0, 4.0, 0.65), 0.45, 0.75, 0.0, 1.0, smooth=True)
    top = nb.mx(nb.mr(z, 4.2, 6.4, 0.15, 0.9), nb.mul(nb.mr(z, 2.2, 3.25, 0.0, 0.9), nb.math('LESS_THAN', z, 3.26)))
    col = nb.mix(nb.mul(nb.mul(gs, top), 0.7), col, (0.04, 0.035, 0.028))
    h = nb.lerp(plaster, nb.mul(br['h'], 0.8), nb.add(1.4, nb.mul(pl['h'], 0.35)))
    rough = nb.lerp(plaster, br['rough'], pl['rough'])
    b = wet_surface(nb, col, rough, h, wet=0.45, streak=0.9, bump=1.0, bdist=0.025, coat=0.4, wetdark=0.62)
    return nb.finish(b.outputs[0])


@memo
def m_strata():
    """Sisi potongan alas: lapis batu pecah di bawah aspal, lalu tanah galian dengan batu.
    Displacement beneran (mesh sisi dibuat rapat)."""
    nb = NB('LapisanTanah')
    P = nb.obj()
    x, y, z = nb.sep(P)
    so = nb.pbr('soil', scale=0.6, rnd=False)
    gr = nb.pbr('gravel', scale=0.4, rnd=False)
    mr_ = nb.pbr('mudrock', scale=0.7, rnd=False)
    wob = nb.mul(nb.sub(nb.noise(nb.mapping(P, scale=(1, 1, 0.1)), 1.3, 3.0), 0.5), 0.14)
    zz = nb.add(z, wob)
    road = nb.mr(y, 0.86, 0.92, 1.0, 0.0)
    g = nb.mul(nb.mr(zz, -0.36, -0.33, 0.0, 1.0), road)
    sand = nb.mul(nb.mr(zz, -0.2, -0.16, 0.0, 1.0), nb.inv(road))
    rk = nb.mr(nb.add(nb.noise(P, 1.2, 3.0, 0.6), nb.mr(z, -1.0, -0.4, 0.12, 0.0)), 0.52, 0.6, 0.0, 1.0, smooth=True)
    col = nb.mix(rk, nb.hsv(so['col'], s=0.9, v=1.25), nb.hsv(mr_['col'], s=0.6, v=2.2))
    col = nb.mix(nb.mr(z, -1.0, -0.35, 0.4, 0.0), col, (0.04, 0.028, 0.018))
    col = nb.mix(sand, col, nb.hsv(so['col'], s=0.55, v=1.15))
    col = nb.mix(g, col, nb.hsv(gr['col'], s=0.5, v=1.5))
    h = nb.lerp(g, nb.lerp(rk, so['h'], mr_['h']), gr['h'])
    rough = nb.lerp(g, so['rough'], gr['rough'])
    b = wet_surface(nb, col, rough, h, wet=0.5, streak=0.8, bump=1.0, bdist=0.03, coat=0.3)
    corner = nb.inv(nb.mul(nb.mr(nb.math('ABSOLUTE', x), 3.88, 3.995, 0.0, 1.0), nb.mr(nb.math('ABSOLUTE', y), 3.88, 3.995, 0.0, 1.0)))
    side = nb.mr(nb.math('ABSOLUTE', nb.sep(nb.geo('Normal'))[2]), 0.3, 0.6, 1.0, 0.0)
    dn = nb.node('ShaderNodeDisplacement')
    nb.set(dn.inputs['Height'], h)
    nb.set(dn.inputs['Midlevel'], 0.45)
    nb.set(dn.inputs['Scale'], nb.mul(nb.mul(corner, side), nb.lerp(g, 0.055, 0.03)))
    nb.mat.displacement_method = 'BOTH'
    return nb.finish(b.outputs[0], disp=dn.outputs[0])


@memo
def m_backdrop():
    nb = NB('Backdrop')
    P = nb.obj()
    n = nb.noise(P, 0.3, 3.0)
    b = nb.principled(**{'Base Color': (0.012, 0.013, 0.016), 'Roughness': nb.mr(n, 0.3, 0.7, 0.42, 0.6)})
    return nb.finish(b.outputs[0])


@memo
def m_water(name='AirSelokan'):
    nb = NB(name)
    P = nb.obj()
    wv = nb.noise(nb.vmath('ADD', P, nb.comb(nb.mul(nb.time(), 0.25), 0.0, 0.0)), 9.0, 3.0)
    nrm = nb.bump(wv, 0.15, 0.01)
    b = nb.principled(**{'Base Color': (0.02, 0.022, 0.014), 'Roughness': 0.03, 'Normal': nrm, 'IOR': 1.33,
                         'Coat Weight': 1.0, 'Coat Roughness': 0.0})
    return nb.finish(b.outputs[0])


# material yang sering dipakai
def M(name):
    f = {
        'conc': lambda: m_tex('Beton', 'conc_dirty', scale=0.6, wet=0.8, streak=0.8, bump=0.6, val=0.85),
        'conc_cut': lambda: m_tex('BetonPotong', 'conc_dirty', scale=0.35, wet=0.3, streak=0.5, val=1.1, sat=0.6, grime=0.15),
        'asph_cut': lambda: m_tex('AspalPotong', 'gravel', scale=0.3, wet=0.5, streak=0.8, val=0.2, sat=0.3, bump=0.8, bdist=0.01),
        'brick_cut': lambda: m_tex('BataPotong', 'brick', scale=1.0, wet=0.3, streak=0.4, val=0.8, rnd=False),
        'stone': lambda: m_tex('BatuKali', 'stonewall', scale=0.55, wet=0.5, streak=0.6, val=0.8, bump=1.0, bdist=0.03, rnd=False),
        'grate': lambda: m_tex('BesiKisi', 'rust', scale=0.5, wet=0.8, drops=0.3, val=0.55, sat=0.8, bump=0.8, metallic=0.4),
        'rust': lambda: m_tex('Karat', 'rust', scale=0.5, wet=0.6, drops=0.2, val=0.8, bump=0.8),
        'pole_conc': lambda: m_tex('TiangBeton', 'conc_dirty', scale=0.45, wet=0.7, streak=1.0, val=0.75, bump=0.5),
        'metal_dark': lambda: m_tex('BesiTua', 'metal_dark', scale=0.6, wet=0.7, drops=0.3, streak=0.7, metallic=0.5, val=0.8),
        'metal_white': lambda: m_tex('SengPutih', 'metal_white', scale=0.8, wet=0.7, drops=0.35, streak=0.7, val=0.85),
        'wood_blue': lambda: m_tex('KayuCatBiru', 'wood_blue', scale=0.9, wet=0.55, drops=0.25, streak=0.6, bump=0.8, val=0.95),
        'wood_green': lambda: m_tex('KayuCatHijau', 'wood_green', scale=0.7, wet=0.55, drops=0.25, streak=0.6, bump=0.8),
        'wood_brown': lambda: m_tex('KayuCoklat', 'wood_brown', scale=0.55, rot=(0, 0, pi / 2), wet=0.2, drops=0.0, bump=0.7, val=0.8),
        'wood_worn': lambda: m_tex('KayuAus', 'wood_worn', scale=0.6, wet=0.45, drops=0.15, bump=0.7, val=0.85),
        'wood_rough': lambda: m_tex('KayuKasar', 'wood_rough', scale=1.0, rot=(pi / 2, 0, 0), wet=0.5, drops=0.1, bump=0.8, val=0.7),
        'plywood': lambda: m_tex('Tripleks', 'plywood', scale=1.0, wet=0.2, bump=0.4, val=0.8, grime=0.45),
        'galv': lambda: m_metal('Galvanis', (0.62, 0.64, 0.66), 0.38, rust=0.25),
        'alu': lambda: m_metal('Aluminium', (0.80, 0.81, 0.82), 0.28, rust=0.0, brushed=0.15, dirt=0.35),
        'alu_dull': lambda: m_metal('AluminiumKusam', (0.66, 0.66, 0.65), 0.42, rust=0.0, brushed=0.1, dirt=0.5),
        'chrome': lambda: m_metal('Krom', (0.86, 0.87, 0.88), 0.07, rust=0.3, dirt=0.2),
        'steel': lambda: m_metal('Baja', (0.33, 0.33, 0.34), 0.42, rust=0.4),
        'rubber': lambda: m_plastic('Karet', (0.016, 0.016, 0.017), 0.62, drops=0.25, dirt=0.5),
        'cable': lambda: m_plastic('Kabel', (0.012, 0.012, 0.013), 0.42, drops=0.0, dirt=0.3, streak=0.0),
        'black_plastic': lambda: m_plastic('PlastikHitam', (0.02, 0.02, 0.022), 0.4, drops=0.3),
        'white_plastic': lambda: m_plastic('PlastikPutih', (0.72, 0.71, 0.66), 0.38, drops=0.3, dirt=0.4),
        'ceramic': lambda: m_plastic('Keramik', (0.82, 0.81, 0.76), 0.12, wet=0.2, drops=0.0, dirt=0.15, scratch=0.05),
        'pvc': lambda: m_plastic('PVC', (0.50, 0.50, 0.47), 0.45, drops=0.2, dirt=0.55, streak=0.8),
        'pvc_orange': lambda: m_plastic('PVCOranye', (0.62, 0.20, 0.04), 0.45, drops=0.1, dirt=0.5),
        'rope': lambda: m_plastic('Tali', (0.42, 0.33, 0.18), 0.8, drops=0.0, dirt=0.4, scratch=0.0),
        'raffia': lambda: m_plastic('Rafia', (0.55, 0.08, 0.06), 0.55, drops=0.0, dirt=0.3),
    }[name]
    key = 'M_' + name
    if key not in MATS:
        MATS[key] = f()
    return MATS[key]


# ----------------------------------------------------------------------------------------------
# Alas diorama: blok tanah, jalan, selokan, trotoar
# ----------------------------------------------------------------------------------------------
def grid_box(name, lo, hi, mat, cell=0.025):
    """Kotak dengan sisi tegak dibagi rapat (untuk displacement asli)."""
    bm = bmesh.new()

    def side(o, u, v, nu, nv):
        vs = [[bm.verts.new(o + u * (i / nu) + v * (j / nv)) for i in range(nu + 1)] for j in range(nv + 1)]
        for j in range(nv):
            for i in range(nu):
                bm.faces.new((vs[j][i], vs[j][i + 1], vs[j + 1][i + 1], vs[j + 1][i]))
    dx, dy, dz = hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]
    nx, ny, nz = max(1, int(dx / cell)), max(1, int(dy / cell)), max(1, int(dz / cell))
    X, Y, Z = Vector((dx, 0, 0)), Vector((0, dy, 0)), Vector((0, 0, dz))
    side(Vector(lo), X, Z, nx, nz)                              # y = lo
    side(Vector((hi[0], hi[1], lo[2])), -X, Z, nx, nz)          # y = hi
    side(Vector((hi[0], lo[1], lo[2])), Y, Z, ny, nz)           # x = hi
    side(Vector((lo[0], hi[1], lo[2])), -Y, Z, ny, nz)          # x = lo
    side(Vector((lo[0], lo[1], hi[2])), X, Y, 1, 1)             # atas
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    set_smooth(me)
    me.materials.append(mat)
    return link(bpy.data.objects.new(name, me))


def pipe_stub(name, axis, a0, a1, c, r_out, r_in, mat, n=32):
    """Pipa berongga sepanjang sumbu X atau Y, dari a0 ke a1; c = dua koordinat lainnya."""
    L = a1 - a0
    ob = lathe(name, [(r_in, 0), (r_out, 0), (r_out, L), (r_in, L), (r_in, 0)], mat, n=n, bevel=min(0.004, (r_out - r_in) * 0.3))
    if axis == 'X':
        ob.rotation_euler = (0, pi / 2, 0)
        ob.location = (a0, c[0], c[1])
    else:
        ob.rotation_euler = (-pi / 2, 0, 0)
        ob.location = (c[0], a0, c[1])
    return ob


def grate(name, x0, x1, y0, y1, z, mat, parent=None):
    """Kisi besi selokan: rangka plat + jeruji."""
    bm = bmesh.new()

    def bar(lo, hi):
        g = bmesh.ops.create_cube(bm, size=1.0)
        for v in g['verts']:
            v.co.x = lo[0] if v.co.x < 0 else hi[0]
            v.co.y = lo[1] if v.co.y < 0 else hi[1]
            v.co.z = lo[2] if v.co.z < 0 else hi[2]
    t, hgt = 0.007, 0.04
    bar((x0, y0, z - hgt), (x1, y0 + t, z))
    bar((x0, y1 - t, z - hgt), (x1, y1, z))
    bar((x0, y0, z - hgt), (x0 + t, y1, z))
    bar((x1 - t, y0, z - hgt), (x1, y1, z))
    n = int((x1 - x0) / 0.045)
    for i in range(1, n):
        x = x0 + (x1 - x0) * i / n
        bar((x - 0.004, y0, z - 0.032), (x + 0.004, y1, z - 0.002))
    for yy in (y0 + (y1 - y0) / 3, y0 + 2 * (y1 - y0) / 3):
        bar((x0, yy - 0.004, z - hgt), (x1, yy + 0.004, z - 0.012))
    return mk(name, bm, mat, parent=parent, bevel=0.0015, bsegs=1)


def build_base():
    st = m_strata()
    grid_box('TanahJalan', (-4, -4, -1.0), (4, 0.93, -0.08), st)
    grid_box('TanahSelokan', (-4, 0.93, -1.0), (4, 1.58, -0.5), st)
    grid_box('TanahTrotoar', (-4, 1.58, -1.0), (4, 4.0, 0.03), st)
    box2('Plinth', (-4.16, -4.16, -1.13), (4.16, 4.16, -1.0), m_plastic('Plinth', (0.012, 0.012, 0.013), 0.3, wet=0.3, drops=0.15, dirt=0.2), bevel=0.012)
    box2('JalanAspal', (-4, -4, -0.08), (4, 0.93, 0.0), M('asph_cut'), bevel=0.004, top_mat=m_asphalt())
    # saluran U beton + kanstin
    prof = [(0.93, -0.5), (0.93, 0.0), (1.00, 0.0), (1.00, -0.05), (1.04, -0.05), (1.04, -0.42), (1.36, -0.42),
            (1.36, -0.05), (1.58, -0.05), (1.58, -0.5)]
    e = 0.014
    loft('SaluranU', [[(x, y, z) for (y, z) in prof] for x in (-4 - e, 4 + e)], M('conc'), bevel=0.004)
    box2('Kanstin', (-4 - e, 1.40, -0.05), (4 + e, 1.58, 0.15), m_curb(), bevel=0.015)
    box2('Trotoar', (-4, 1.58, 0.03), (4, 3.1, 0.15), M('conc_cut'), bevel=0.004, top_mat=m_sidewalk())
    box2('AirSelokan', (-4 - e, 1.04, -0.42), (4 + e, 1.36, -0.335), m_water(), bevel=0.0)
    # tutup selokan: plat beton, dua ruas kisi besi, satu ruas kebuka
    x = -4.0
    i = 0
    while x < 3.99:
        x1 = min(4.0, x + 0.6)
        if -3.45 < x < -2.3:
            grate('Kisi%d' % i, x + 0.01, x1 - 0.01, 1.005, 1.395, -0.002, M('grate'))
        elif -0.75 < x < -0.2:
            o = box('TutupLepas', (0.57, 0.39, 0.05), (x + 0.42, 1.52, 0.012), M('conc'), bevel=0.006, rot=(radians(-9), radians(4), radians(17)))
        else:
            o = box('Tutup%d' % i, (x1 - x - 0.018, 0.39, 0.05), ((x + x1) / 2, 1.2, -0.025 + RND.uniform(-0.004, 0.003)), M('conc'), bevel=0.006,
                    rot=(RND.uniform(-0.01, 0.01), RND.uniform(-0.01, 0.01), RND.uniform(-0.012, 0.012)))
            for sx in (-0.12, 0.12):
                box('Lubang%d' % i, (0.07, 0.022, 0.03), (sx, 0, 0.012), m_plastic('LubangGelap', (0.004, 0.004, 0.004), 0.9, wet=0, drops=0), bevel=0.004, parent=o)
        x = x1
        i += 1
    # pondasi batu kali di bawah tembok
    fp = [(2.95, -0.7), (3.02, 0.03), (3.55, 0.03), (3.8, -0.7)]
    loft('Pondasi', [[(xx, y, z) for (y, z) in fp] for xx in (-4 - e, 4 + e)], M('stone'), bevel=0.008)
    # pipa yang kepotong
    pipe_stub('Gorong', 'Y', -4.0 - 0.03, -3.0, (-0.95, -0.60), 0.27, 0.22, M('conc'))
    cyl('GorongGelap', 0.22, 0.02, (-0.95, -3.4, -0.60), m_plastic('LubangGelap', (0.004, 0.004, 0.004), 0.9, wet=0, drops=0), rot=(pi / 2, 0, 0), bevel=0)
    box2('GorongAir', (-0.95 - 0.12, -4.0, -0.83), (-0.95 + 0.12, -3.4, -0.775), m_water(), bevel=0)
    pipe_stub('PipaBesi', 'X', -4.0 - 0.05, 4.0 + 0.05, (-2.55, -0.52), 0.065, 0.052, M('rust'))
    pipe_stub('PipaPVC', 'X', -4.0 - 0.04, 4.0 + 0.04, (2.45, -0.45), 0.085, 0.076, M('pvc'))
    for k, dx in enumerate((0.0, 0.085, 0.043)):
        pipe_stub('Konduit%d' % k, 'Y', -4.0 - 0.035 - 0.01 * k, -3.2, (2.35 + dx, -0.40 + (0.07 if k == 2 else 0)), 0.038, 0.032, M('pvc_orange'))
    pipe_stub('PipaBesi2', 'Y', -4.0 - 0.06, -3.2, (-2.9, -0.75), 0.05, 0.04, M('rust'))


# ----------------------------------------------------------------------------------------------
# Bangunan: tembok bata, jendela menyala, kanopi seng, talang
# ----------------------------------------------------------------------------------------------
WIN = (-0.35, 0.95, 4.05, 5.25)     # x0, x1, z0, z1 bukaan jendela
WALL_Y0, WALL_Y1 = 3.1, 3.36


def wall_with_holes(name, x0, x1, z0, z1, holes, y0, y1, mat):
    xs = sorted(set([x0, x1] + [h[0] for h in holes] + [h[1] for h in holes]))
    zs = sorted(set([z0, z1] + [h[2] for h in holes] + [h[3] for h in holes]))
    bm = bmesh.new()
    vg = {(i, j): bm.verts.new((x, y0, z)) for i, x in enumerate(xs) for j, z in enumerate(zs)}
    faces = []
    for i in range(len(xs) - 1):
        for j in range(len(zs) - 1):
            cx, cz = (xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2
            if any(h[0] < cx < h[1] and h[2] < cz < h[3] for h in holes):
                continue
            faces.append(bm.faces.new((vg[i, j], vg[i + 1, j], vg[i + 1, j + 1], vg[i, j + 1])))
    r = bmesh.ops.extrude_face_region(bm, geom=faces)
    bmesh.ops.translate(bm, vec=(0, y1 - y0, 0), verts=[g for g in r['geom'] if isinstance(g, bmesh.types.BMVert)])
    return mk(name, bm, mat, bevel=0.006)


def corrugated(name, w, d, mat, wave=0.076, amp=0.009, parent=None, loc=(0, 0, 0), rot=(0, 0, 0)):
    nx = int(w / wave * 8)
    ob = grid(name, -w / 2, w / 2, -d / 2, d / 2, nx, 4, mat, parent=parent, zf=lambda x, y: amp * sin(2 * pi * x / wave))
    ob.location = loc
    ob.rotation_euler = rot
    s = ob.modifiers.new('Solid', 'SOLIDIFY')
    s.thickness = 0.0012
    return ob


def build_building():
    wall_with_holes('TembokDepan', -4, 4, 0.03, 6.4, [WIN], WALL_Y0, WALL_Y1, m_wall())
    bc = M('brick_cut')
    x0, x1, z0, z1 = WIN
    rx0, rx1, rz0, rz1 = x0 - 0.5, x1 + 0.5, z0 - 0.45, z1 + 0.35
    wall_with_holes('BadanBangunan', -4, 4, 0.03, 6.4, [(rx0, rx1, rz0, rz1)], WALL_Y1, 3.93, bc)
    box2('BangunanBelakang', (-4, 3.93, 0.03), (4, 4.0, 6.4), bc, bevel=0.006)
    # lapisan dalam kamar
    room = m_tex('DindingKamar', 'plaster', scale=1.0, tint=(0.95, 0.85, 0.62), val=1.6, wet=0.0, streak=0.0, grime=0.25, rnd=False)
    e = 0.004
    box2('Kamar_blk', (rx0, 3.93 - e, rz0), (rx1, 3.93, rz1), room, bevel=0)
    box2('Kamar_ki', (rx0, WALL_Y1, rz0), (rx0 + e, 3.93, rz1), room, bevel=0)
    box2('Kamar_ka', (rx1 - e, WALL_Y1, rz0), (rx1, 3.93, rz1), room, bevel=0)
    box2('Kamar_lt', (rx0, WALL_Y1, rz0), (rx1, 3.93, rz0 + e), M('wood_worn'), bevel=0)
    box2('Kamar_plf', (rx0, WALL_Y1, rz1 - e), (rx1, 3.93, rz1), room, bevel=0)
    box2('Kamar_dpn', (rx0, WALL_Y1, rz0), (rx1, WALL_Y1 + e, z0), room, bevel=0)
    box('Lemari', (0.5, 0.3, 1.0), (rx1 - 0.35, 3.7, rz0), M('wood_brown'), base=True, bevel=0.005)
    # lampu kamar (neon TL agak kehijauan-hangat)
    cyl('LampuKamar', 0.016, 0.7, (x0 + 0.3, 3.8, rz1 - 0.06), m_emit('EmitKamar', (1.0, 0.78, 0.48), 2200.0), rot=(0, pi / 2, 0), bevel=0, base=False)
    # kusen + daun jendela + kaca + teralis
    fr = m_tex('Kusen', 'wood_green', scale=0.6, rot=(0, pi / 2, 0), wet=0.5, streak=0.7, drops=0.2, bump=0.7, val=0.9)
    yk = WALL_Y0 + 0.05
    for nm, lo, hi in (('ki', (x0, yk, z0), (x0 + 0.06, yk + 0.1, z1)), ('ka', (x1 - 0.06, yk, z0), (x1, yk + 0.1, z1)),
                       ('bw', (x0, yk, z0), (x1, yk + 0.1, z0 + 0.06)), ('at', (x0, yk, z1 - 0.06), (x1, yk + 0.1, z1)),
                       ('tg', ((x0 + x1) / 2 - 0.025, yk + 0.01, z0), ((x0 + x1) / 2 + 0.025, yk + 0.09, z1)),
                       ('ln', (x0, yk + 0.01, z1 - 0.4), (x1, yk + 0.09, z1 - 0.36))):
        box2('Kusen_' + nm, lo, hi, fr, bevel=0.004)
    box2('KacaJendela', (x0 + 0.05, yk + 0.045, z0 + 0.05), (x1 - 0.05, yk + 0.05, z1 - 0.05), m_glass('KacaJendela', dust=0.4, smudge=0.8, drops=0.5), bevel=0.0)
    tm = m_paint('Teralis', (0.05, 0.05, 0.055), rust=0.6, rough=0.45, drops=0.2)
    n = 9
    for i in range(1, n):
        x = x0 + (x1 - x0) * i / n
        tube('Teralis%d' % i, [(x, WALL_Y0 + 0.02, z0 + 0.02), (x, WALL_Y0 + 0.02, z1 - 0.02)], 0.006, tm)
    for zz in (z0 + 0.25, z1 - 0.25):
        box2('TeralisH', (x0 + 0.01, WALL_Y0 + 0.012, zz - 0.012), (x1 - 0.01, WALL_Y0 + 0.017, zz + 0.012), tm, bevel=0.001)
    box2('Ambang', (x0 - 0.08, WALL_Y0 - 0.07, z0 - 0.07), (x1 + 0.08, WALL_Y0 + 0.02, z0), M('conc'), bevel=0.008)
    # gorden tipis, kebuka sebagian
    cm = NB('Gorden')
    P = cm.obj()
    ccol = cm.mix(cm.mr(cm.noise(P, 5.0, 3.0), 0.3, 0.7, 0.0, 0.35), (0.75, 0.52, 0.30), (0.5, 0.3, 0.2))
    pb = cm.principled(**{'Base Color': ccol, 'Roughness': 0.85})
    tb = cm.node('ShaderNodeBsdfTranslucent')
    cm.set(tb.inputs[0], ccol)
    ms = cm.node('ShaderNodeMixShader')
    ms.inputs[0].default_value = 0.55
    cm.nt.links.new(pb.outputs[0], ms.inputs[1])
    cm.nt.links.new(tb.outputs[0], ms.inputs[2])
    gm = cm.finish(ms.outputs[0])
    for (a, b, ph) in ((x0 + 0.03, x0 + 0.5, 0.0), (x1 - 0.28, x1 - 0.03, 1.3)):
        g = grid('Gorden', a, b, z0 + 0.06, z1 - 0.07, 40, 6, gm, zf=lambda x, y, ph=ph: 0.022 * sin(x * 55 + ph) + 0.01 * sin(x * 131 + ph * 2))
        g.rotation_euler = (pi / 2, 0, 0)
        g.location = (0, yk + 0.16, 0)
    # lis lantai, lis atap, kanopi seng
    box2('LisLantai', (-4, WALL_Y0 - 0.09, 3.26), (4, WALL_Y0 + 0.01, 3.38), M('conc'), bevel=0.01)
    box2('LisAtap', (-4, WALL_Y0 - 0.07, 6.4), (4, 4.0, 6.5), M('conc'), bevel=0.012)
    seng = m_tex('SengKanopi', 'seng', scale=0.5, wet=0.8, drops=0.3, streak=0.3, metallic=0.1, val=1.3, rnd=False)
    kx = (x0 + x1) / 2
    corrugated('Kanopi', (x1 - x0) + 0.5, 0.6, seng, loc=(kx, WALL_Y0 - 0.26, z1 + 0.28), rot=(radians(28), 0, 0))
    for sx in (-0.6, 0.6):
        tube('KanopiSiku', [(kx + sx, WALL_Y0, z1 + 0.1), (kx + sx, WALL_Y0 - 0.5, z1 + 0.15), (kx + sx, WALL_Y0, z1 + 0.4)], 0.008, M('steel'))
    # talang PVC + klem
    tx = -2.15
    tube('Talang', [(tx, WALL_Y0 - 0.02, 6.5), (tx, WALL_Y0 - 0.075, 6.3), (tx, WALL_Y0 - 0.075, 0.42), (tx, WALL_Y0 - 0.2, 0.26)], 0.045, M('pvc'), fil=0.08, res=5)
    for zz in (1.2, 2.9, 4.6, 5.9):
        cyl('Klem', 0.052, 0.025, (tx, WALL_Y0 - 0.075, zz), M('galv'), bevel=0.003)
    # kabel nempel tembok
    for k in range(3):
        zz = 2.95 + 0.05 * k
        pts = []
        for s in range(8):
            pts += sag_pts((-4 + s, WALL_Y0 - 0.02, zz + RND.uniform(-0.01, 0.01)), (-3 + s, WALL_Y0 - 0.02, zz + RND.uniform(-0.01, 0.01)), RND.uniform(0.02, 0.07), 8)
        tube('KabelTembok%d' % k, pts, 0.006 + 0.002 * k, M('cable'))


# ----------------------------------------------------------------------------------------------
# Backdrop studio, kabut, lampu, kamera
# ----------------------------------------------------------------------------------------------
CAM_T = Vector((0.0, -0.3, 2.95))
CAM_D = 50.0
CAM_EL = 17.0
ORBIT = 40.0
FOCUS_P = Vector((1.25, -0.7, 1.35))    # gerobak


def build_backdrop():
    bm = bmesh.new()
    s = 220.0
    bm.faces.new([bm.verts.new(p) for p in ((-s, -s, -1.13), (s, -s, -1.13), (s, s, -1.13), (-s, s, -1.13))])
    mk('LantaiStudio', bm, m_backdrop(), smooth=False)
    w = SCN.world or bpy.data.worlds.new('World')
    SCN.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.010, 0.014, 0.028, 1.0)
    bg.inputs[1].default_value = 0.12


def build_fog():
    """Kabut tipis: volume homogen beneran dalam kotak besar (bukan plane)."""
    nb = NB('Kabut')
    vs = nb.node('ShaderNodeVolumeScatter')
    vs.inputs['Color'].default_value = (0.85, 0.9, 1.0, 1.0)
    vs.inputs['Density'].default_value = 0.022
    vs.inputs['Anisotropy'].default_value = 0.35
    nb.nt.links.new(vs.outputs[0], nb.out.inputs['Volume'])
    ob = box2('KotakKabut', (-14, -9, -1.12), (14, 12, 18), nb.mat, bevel=0)
    ob.visible_shadow = False
    return ob


def aim(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def spot(name, loc, target, energy, color, size=45, blend=0.5, radius=0.2):
    li = bpy.data.lights.new(name, 'SPOT')
    li.energy = energy
    li.color = color
    li.spot_size = radians(size)
    li.spot_blend = blend
    li.shadow_soft_size = radius
    ob = link(bpy.data.objects.new(name, li))
    ob.location = loc
    aim(ob, target)
    return ob


def build_rim():
    """Rim biru dingin dari belakang. Rim tidak ikut menerangi kabut (visible_volume_scatter
    mati) supaya kabut cuma kebaca dari lampu yang ada di dalam scene."""
    blue = (0.30, 0.50, 1.0)
    rims = [spot('RimKiri', (-11.0, 7.0, 9.5), (0.5, -0.8, 1.2), 19000, blue, 46, 0.6, 0.6),
            spot('RimKanan', (10.5, 6.5, 8.5), (0.0, -1.0, 1.0), 15000, blue, 46, 0.6, 0.6),
            spot('RimAtas', (0.5, 10.5, 17.0), (0.0, -1.2, 0.5), 24000, (0.36, 0.55, 1.0), 40, 0.7, 0.8)]
    for o in rims:
        o.visible_volume_scatter = False
    # fill sangat lemah dari depan-bawah: tanpa ini sisi potongan tanah hitam total
    li = bpy.data.lights.new('FillDepan', 'AREA')
    li.shape = 'RECTANGLE'
    li.size, li.size_y = 14.0, 5.0
    li.energy = 1500.0
    li.color = (0.55, 0.68, 1.0)
    ob = link(bpy.data.objects.new('FillDepan', li))
    ob.location = (-2.0, -16.0, 1.5)
    aim(ob, (0, -4, -0.3))
    ob.visible_volume_scatter = False
    ob.visible_glossy = False       # jangan ada pantulan lampu studio di aspal basah


def build_camera():
    piv = grp('PivotKamera', CAM_T)
    cam = bpy.data.cameras.new('Kamera')
    cam.lens = 85.0
    cam.sensor_width = 36.0
    cam.clip_start = 1.0
    cam.clip_end = 600.0
    ob = link(bpy.data.objects.new('Kamera', cam), piv)
    el = radians(ARGS.cam_el if ARGS.cam_el is not None else CAM_EL)
    ob.location = (0, -CAM_D * cos(el), CAM_D * sin(el))
    ob.rotation_euler = (pi / 2 - el, 0, 0)
    SCN.camera = ob
    fo = grp('Fokus', FOCUS_P)
    cam.dof.use_dof = True
    cam.dof.focus_object = fo
    cam.dof.aperture_fstop = 0.125
    cam.dof.aperture_blades = 7
    # orbit 40 derajat, ease in / ease out (bezier dengan handle datar)
    for f, a in ((F_START, -ORBIT / 2), (F_END, ORBIT / 2)):
        piv.rotation_euler = (0, 0, radians(a))
        piv.keyframe_insert('rotation_euler', index=2, frame=f)
    for fc in _fcurves(piv):
        for kp in fc.keyframe_points:
            kp.interpolation = 'BEZIER'
            kp.easing = 'AUTO'
            kp.handle_left_type = kp.handle_right_type = 'AUTO_CLAMPED'
        fc.update()
    return ob


def _fcurves(idblock):
    ad = idblock.animation_data
    if not ad or not ad.action:
        return []
    act = ad.action
    try:
        return list(act.fcurves)
    except Exception:
        out = []
        for layer in act.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    out += list(bag.fcurves)
        return out


# ----------------------------------------------------------------------------------------------
# Render
# ----------------------------------------------------------------------------------------------
def setup_render():
    r = SCN.render
    r.engine = 'CYCLES'
    r.resolution_x, r.resolution_y = ARGS.w, ARGS.h
    r.resolution_percentage = ARGS.scale
    r.fps = FPS
    SCN.frame_start, SCN.frame_end = F_START, F_END
    r.image_settings.file_format = 'PNG'
    r.image_settings.color_mode = 'RGB'
    r.image_settings.color_depth = '8'
    r.image_settings.compression = 30
    r.use_motion_blur = True
    r.motion_blur_shutter = 0.5
    r.use_persistent_data = True
    r.film_transparent = False
    if ARGS.threads:
        r.threads_mode = 'FIXED'
        r.threads = ARGS.threads
    c = SCN.cycles
    c.samples = ARGS.samples
    c.use_adaptive_sampling = False            # sample tetap, tidak dipotong adaptif
    c.use_denoising = not ARGS.no_denoise
    c.denoiser = 'OPENIMAGEDENOISE'
    c.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
    c.denoising_prefilter = 'ACCURATE'
    # bounce: semua di atas atau sama dengan default Cycles
    c.max_bounces = 12
    c.diffuse_bounces = 4
    c.glossy_bounces = 6
    c.transmission_bounces = 12
    c.volume_bounces = 2
    c.transparent_max_bounces = 16
    c.caustics_reflective = True
    c.caustics_refractive = True
    c.use_light_tree = True
    c.volume_step_rate = 1.0
    c.volume_max_steps = 1024
    c.motion_blur_position = 'CENTER'
    c.seed = ARGS.seed
    c.use_animated_seed = True
    c.texture_limit_render = 'OFF'
    vs = SCN.view_settings
    vs.view_transform = 'AgX'
    vs.look = 'AgX - Medium High Contrast'
    vs.exposure = 0.45
    vs.gamma = 1.0


def _try_device(kind):
    prefs = bpy.context.preferences.addons['cycles'].preferences
    if kind == 'CPU':
        SCN.cycles.device = 'CPU'
        return ['CPU']
    try:
        prefs.compute_device_type = kind
    except Exception as e:  # build tanpa backend ini
        log('  %s tidak tersedia di build ini: %s' % (kind, e))
        return None
    try:
        prefs.refresh_devices()
    except Exception:
        prefs.get_devices()
    devs = [d for d in prefs.devices if d.type == kind]
    if not devs:
        log('  %s: tidak ada perangkat' % kind)
        return None
    for d in prefs.devices:
        d.use = (d.type == kind)
    SCN.cycles.device = 'GPU'
    try:
        SCN.cycles.denoising_use_gpu = True
    except Exception:
        pass
    return [d.name for d in devs]


def _probe_render():
    """Render kecil 1 sample dengan scene asli: kernel, BVH dan tekstur beneran dimuat.
    Kalau device gagal (driver, VRAM), ketahuan di sini, bukan di frame 37."""
    r, c = SCN.render, SCN.cycles
    keep = (r.resolution_percentage, c.samples, c.use_denoising, r.filepath, r.use_motion_blur)
    tmp = os.path.join(ARGS.cache, 'probe_%d' % os.getpid())
    ok = False
    try:
        r.resolution_percentage = 10
        c.samples = 4
        c.use_denoising = False
        r.filepath = tmp
        SCN.frame_set(60)
        bpy.ops.render.render(write_still=True)
        f = tmp + '.png'
        if os.path.exists(f):
            im = bpy.data.images.load(f)
            px = list(im.pixels)
            ok = max(px[0::4] + px[1::4] + px[2::4]) > 0.004
            bpy.data.images.remove(im)
            os.remove(f)
            if not ok:
                log('  probe: gambar hitam')
        else:
            log('  probe: file tidak tertulis')
    except Exception as e:
        log('  probe gagal: %s' % str(e).strip().splitlines()[-1])
    r.resolution_percentage, c.samples, c.use_denoising, r.filepath, r.use_motion_blur = keep
    return ok


DEVICE_LEFT = []


def pick_device():
    """OptiX dulu, kalau gagal CUDA, kalau gagal CPU. Tiap calon dites dengan probe render."""
    global DEVICE_LEFT
    order = DEVICE_LEFT or (['OPTIX', 'CUDA', 'CPU'] if ARGS.device == 'AUTO' else [ARGS.device])
    for i, kind in enumerate(order):
        log('coba device %s ...' % kind)
        names = _try_device(kind)
        if not names:
            continue
        t = time.time()
        if _probe_render():
            DEVICE_LEFT = order[i + 1:]
            log('DEVICE TERPAKAI: %s  %s  (probe %.0f dtk)' % (kind, names, time.time() - t))
            return kind
        log('  %s gagal waktu probe render, lanjut ke pilihan berikutnya' % kind)
    raise RuntimeError('Tidak ada device yang bisa merender (dicoba: %s)' % order)


def fmt_t(s):
    s = int(s)
    return '%dj %02dm %02dd' % (s // 3600, s % 3600 // 60, s % 60)


def render_frames():
    frames = ARGS.frame_list
    path = lambda f: os.path.join(ARGS.out, 'frame_%04d.png' % f)
    todo = [f for f in frames if ARGS.overwrite or not (os.path.exists(path(f)) and os.path.getsize(path(f)) > 1000)]
    log('frame diminta: %d, sudah ada: %d, akan dirender: %d' % (len(frames), len(frames) - len(todo), len(todo)))
    if not todo:
        log('tidak ada frame yang perlu dirender')
        return
    device = pick_device()
    logf = os.path.join(ARGS.out, 'render_log.csv')
    if not os.path.exists(logf):
        with open(logf, 'w') as f:
            f.write('frame,detik,device,samples,lebar,tinggi,waktu\n')
    times = []
    rw, rh = ARGS.w * ARGS.scale // 100, ARGS.h * ARGS.scale // 100
    crops = ARGS.crop.split(';') if ARGS.crop else [None]
    for i, f in enumerate(todo):
        t = time.time()
        SCN.frame_set(f)
        tmp = os.path.join(ARGS.out, '.tmp_%04d' % f)
        SCN.render.filepath = tmp
        for ci, cr in enumerate(crops):
            if cr:      # (debug) render potongan gambar saja
                r = SCN.render
                r.use_border = r.use_crop_to_border = True
                r.border_min_x, r.border_max_x, r.border_min_y, r.border_max_y = [float(v) for v in cr.split(',')]
            try:
                bpy.ops.render.render(write_still=True)
            except RuntimeError as e:
                if not DEVICE_LEFT:
                    raise
                log('render frame %d gagal di %s (%s), pindah device' % (f, device, str(e).strip().splitlines()[-1]))
                device = pick_device()
                SCN.frame_set(f)
                SCN.render.filepath = tmp
                bpy.ops.render.render(write_still=True)
            os.replace(tmp + '.png', path(f) if not cr else path(f).replace('.png', '_c%d.png' % ci))
        dt = time.time() - t
        times.append(dt)
        # frame pertama ikut biaya muat scene, jadi ETA pakai rata-rata frame sesudahnya kalau ada
        avg = sum(times[1:]) / len(times[1:]) if len(times) > 1 else dt
        left = (len(todo) - i - 1) * avg
        with open(logf, 'a') as fh:
            fh.write('%d,%.1f,%s,%d,%d,%d,%s\n' % (f, dt, device, ARGS.samples, rw, rh, time.strftime('%Y-%m-%d %H:%M:%S')))
        log('FRAME %d selesai dalam %s | %d/%d | sisa kira-kira %s | ETA 120 frame dengan laju ini: %s'
            % (f, fmt_t(dt), i + 1, len(todo), fmt_t(left), fmt_t(avg * 120)))
    log('render selesai, hasil di %s' % ARGS.out)



# ----------------------------------------------------------------------------------------------
# Properti kecil
# ----------------------------------------------------------------------------------------------
def torus_prof(R, r, n=10):
    return [(R + r * cos(2 * pi * i / n), r * sin(2 * pi * i / n)) for i in range(n + 1)]


def blob(bm, c, rad, amp=0.15, sub=2, rnd=None):
    """Bola tak beraturan (bakso, kerupuk, batu kecil)."""
    rnd = rnd or RND
    rot = Euler((rnd.uniform(0, 6.3), rnd.uniform(0, 6.3), rnd.uniform(0, 6.3))).to_matrix().to_4x4()
    g = bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
    ph = [rnd.uniform(0, 6.3) for _ in range(3)]
    for v in g['verts']:
        d = 1.0 + amp * (sin(v.co.x * 3.1 + ph[0]) * sin(v.co.y * 2.7 + ph[1]) + 0.5 * sin(v.co.z * 5.3 + ph[2]))
        v.co = Vector(c) + rot @ Vector((v.co.x * rad[0] * d, v.co.y * rad[1] * d, v.co.z * rad[2] * d))


@memo
def m_bowl():
    nb = NB('Mangkok')
    z = nb.sep(nb.obj())[2]
    col = nb.mix(band(nb, z, 0.049, 0.056, 0.001), (0.80, 0.79, 0.74), (0.06, 0.12, 0.42))
    b = wet_surface(nb, col, 0.12, None, wet=0.15, streak=0, drops=0.0)
    return nb.finish(b.outputs[0])


@memo
def m_liquid(name, color, rough=0.02):
    nb = NB(name)
    b = nb.principled(**{'Base Color': color, 'Roughness': rough, 'Coat Weight': 1.0, 'Coat Roughness': 0.0,
                         'Subsurface Weight': 0.4, 'Subsurface Radius': (0.02, 0.01, 0.004), 'Subsurface Scale': 1.0})
    return nb.finish(b.outputs[0])


BOWL_PROF = [(0, 0.0), (0.032, 0), (0.034, 0.008), (0.05, 0.03), (0.072, 0.062), (0.069, 0.062), (0.048, 0.032), (0.03, 0.012), (0, 0.012)]
GLASS_PROF = [(0, 0), (0.03, 0), (0.036, 0.115), (0.0335, 0.115), (0.0275, 0.008), (0, 0.008)]
_PROTO = {}


def proto(key, fn):
    """Objek prototipe dibuat sekali, sisanya duplikat berbagi mesh."""
    if key not in _PROTO:
        o = fn()
        o.location = (0, 0, -50)
        o.hide_render = True
        for c in o.children_recursive:
            c.hide_render = True
        _PROTO[key] = o
    return _PROTO[key]


def place(key, fn, loc, rot=(0, 0, 0), parent=None, scale=None):
    o = dup(proto(key, fn), loc, rot, parent, scale)
    o.hide_render = False
    for c in o.children_recursive:
        c.hide_render = False
    return o


def mk_bowl():
    return lathe('Mangkok', BOWL_PROF, m_bowl(), n=28)


def mk_glass():
    return lathe('Gelas', GLASS_PROF, m_glass('KacaGelas', dust=0.12, smudge=0.5, drops=0.0), n=24)


def mk_glass_tea():
    g = lathe('GelasTeh', GLASS_PROF, m_glass('KacaGelas', dust=0.12, smudge=0.5, drops=0.0), n=24)
    lathe('Teh', [(0, 0.0085), (0.0272, 0.0085), (0.0318, 0.085), (0, 0.085)], m_liquid('Teh', (0.32, 0.10, 0.012)), n=24, parent=g)
    return g


def mk_bottle(kind):
    def f():
        if kind == 'kecap':
            body, cap = m_plastic('BotolKecap', (0.012, 0.008, 0.005), 0.08, wet=0.2, drops=0, dirt=0.15), m_plastic('TutupMerah', (0.5, 0.03, 0.02), 0.4, drops=0)
            prof = [(0, 0), (0.03, 0), (0.031, 0.01), (0.031, 0.13), (0.026, 0.155), (0.013, 0.185), (0.012, 0.225), (0, 0.225)]
            lab = (0.75, 0.6, 0.12)
        elif kind == 'saus':
            body, cap = m_plastic('BotolSaus', (0.55, 0.035, 0.015), 0.3, wet=0.2, drops=0, dirt=0.25), m_plastic('TutupMerah', (0.5, 0.03, 0.02), 0.4, drops=0)
            prof = [(0, 0), (0.027, 0), (0.029, 0.01), (0.029, 0.12), (0.024, 0.145), (0.014, 0.165), (0.013, 0.175), (0, 0.175)]
            lab = (0.8, 0.75, 0.6)
        else:
            body, cap = m_plastic('BotolSambal', (0.45, 0.16, 0.02), 0.3, wet=0.2, drops=0, dirt=0.25), m_plastic('TutupHijau', (0.05, 0.3, 0.08), 0.4, drops=0)
            prof = [(0, 0), (0.027, 0), (0.029, 0.01), (0.029, 0.12), (0.024, 0.145), (0.014, 0.165), (0.013, 0.175), (0, 0.175)]
            lab = (0.85, 0.8, 0.2)
        b = lathe('Botol_' + kind, prof, body, n=20)
        top = prof[-1][1]
        if kind == 'kecap':
            cyl('Tutup', 0.014, 0.022, (0, 0, top - 0.004), cap, n=16, bevel=0.002, parent=b)
        else:
            lathe('Tutup', [(0, 0), (0.016, 0), (0.016, 0.018), (0.006, 0.03), (0.004, 0.055), (0, 0.055)], cap, n=16, parent=b, loc=(0, 0, top - 0.004))
        cyl('Label', prof[2][0] + 0.0006, 0.06, (0, 0, 0.04), m_plastic('Label_' + kind, lab, 0.6, wet=0.1, drops=0, dirt=0.4), n=20, bevel=0, parent=b, cap=False)
        return b
    return f


def mk_toples():
    j = lathe('Toples', [(0, 0), (0.1, 0), (0.112, 0.02), (0.112, 0.24), (0.095, 0.27), (0.095, 0.29), (0.091, 0.29), (0.091, 0.268),
                         (0.108, 0.238), (0.108, 0.022), (0.097, 0.004), (0, 0.004)],
              m_glass('PlastikToples', tint=(0.96, 0.96, 0.93), dust=0.3, smudge=0.9, drops=0.25, rough=0.06, ior=1.46), n=32)
    lathe('TutupToples', [(0, 0.035), (0.09, 0.035), (0.1, 0.03), (0.1, 0.0), (0.097, 0.0)], m_plastic('TutupToples', (0.55, 0.03, 0.02), 0.35, drops=0.3), n=32, parent=j, loc=(0, 0, 0.275))
    bm = bmesh.new()
    r = random.Random(3)
    for i in range(34):
        a, rr = r.uniform(0, 6.3), r.uniform(0, 0.068)
        blob(bm, (rr * cos(a), rr * sin(a), 0.02 + 0.2 * i / 34), (0.036, 0.03, 0.011), 0.25, rnd=r)
    mk('Kerupuk', bm, m_plastic('Kerupuk', (0.80, 0.70, 0.50), 0.75, wet=0, drops=0, dirt=0.1, sss=0.3, streak=0), parent=j)
    return j


def mk_stool(color, nm):
    def f():
        m = m_plastic('BangkuPlastik_' + nm, color, 0.34, wet=0.45, drops=0.3, dirt=0.4, sss=0.1)
        s = grp('Bangku_' + nm)
        loft('Dudukan', [rrect(0.275, 0.275, 0.05, 4, 0.385), rrect(0.285, 0.285, 0.05, 4, 0.40), rrect(0.28, 0.28, 0.05, 4, 0.445), rrect(0.262, 0.262, 0.05, 4, 0.458)], m, parent=s, bevel=0.003)
        cyl('LubangDudukan', 0.022, 0.004, (0, 0, 0.456), m_plastic('LubangGelap', (0.004, 0.004, 0.004), 0.9, wet=0, drops=0), n=16, bevel=0, parent=s)
        for sx in (-1, 1):
            for sy in (-1, 1):
                loft('Kaki', [rrect(0.05, 0.05, 0.014, 2, 0.0, sx * 0.158, sy * 0.158), rrect(0.062, 0.062, 0.016, 2, 0.39, sx * 0.105, sy * 0.105)], m, parent=s, bevel=0.002)
        for k in range(4):
            a = k * pi / 2
            box('Palang', (0.24, 0.012, 0.035), (0.128 * cos(a), 0.128 * sin(a), 0.27), m, bevel=0.003, rot=(0, 0, a + pi / 2), parent=s)
        return s
    return f


def mk_bulb():
    s = grp('Bohlam')
    cyl('Fitting', 0.017, 0.045, (0, 0, -0.045), M('black_plastic'), n=14, bevel=0.003, parent=s)
    lathe('KacaBohlam', [(0.012, -0.045), (0.014, -0.06), (0.027, -0.088), (0.031, -0.105), (0.027, -0.125), (0.014, -0.138), (0, -0.141)],
          m_emit('EmitBohlam', (1.0, 0.56, 0.20), 1500.0), n=18, parent=s)
    return s


def bulb(loc, drop=0.25, parent=None):
    b = place('bulb', mk_bulb, loc, parent=parent)
    tube('KabelBohlam', [(loc[0], loc[1], loc[2]), (loc[0] + 0.004, loc[1], loc[2] + drop * 0.5), (loc[0], loc[1], loc[2] + drop)], 0.0035, M('cable'), parent=parent)
    return b


def wheel(name, r, parent, loc, tire=0.022, spokes=20, hub=0.035, rim_m=None):
    w = grp(name, loc, (pi / 2, 0, 0), parent)
    lathe('Ban', torus_prof(r - tire, tire, 10), M('rubber'), n=40, parent=w)
    lathe('Velg', torus_prof(r - 2 * tire - 0.006, 0.009, 6), rim_m or M('steel'), n=40, parent=w)
    cyl('As', 0.02, 2 * hub, (0, 0, -hub), M('steel'), n=12, bevel=0.003, parent=w)
    rr = r - 2 * tire - 0.008
    for i in range(spokes):
        a = 2 * pi * i / spokes
        a2 = a + (0.35 if i % 2 else -0.35)
        z = hub * 0.8 * (1 if i % 2 else -1)
        tube('Jari', [(0.02 * cos(a2), 0.02 * sin(a2), z), (rr * cos(a), rr * sin(a), 0)], 0.0017, M('galv'), parent=w, res=1)
    return w


# ----------------------------------------------------------------------------------------------
# Gerobak
# ----------------------------------------------------------------------------------------------
G_LOC = (1.25, -0.62, 0.0)
NEON_NODES = []
POT_TOP = None      # posisi dunia mulut panci (untuk simulasi uap)

LET = {
    'W': [[(0, 1), (0.18, 0), (0.36, 0.62), (0.54, 0), (0.72, 1)]],
    'A': [[(0, 0), (0.3, 1), (0.6, 0)], [(0.13, 0.36), (0.47, 0.36)]],
    'R': [[(0, 0), (0, 1), (0.36, 1), (0.52, 0.87), (0.52, 0.63), (0.36, 0.5), (0, 0.5)], [(0.24, 0.5), (0.54, 0)]],
    'U': [[(0, 1), (0, 0.26), (0.1, 0.05), (0.27, 0), (0.44, 0.05), (0.54, 0.26), (0.54, 1)]],
    'N': [[(0, 0), (0, 1), (0.54, 0), (0.54, 1)]],
    'G': [[(0.56, 0.8), (0.42, 0.97), (0.22, 1), (0.07, 0.88), (0, 0.62), (0, 0.38), (0.07, 0.12), (0.22, 0), (0.42, 0.03), (0.56, 0.2), (0.56, 0.46), (0.3, 0.46)]],
}


def neon_sign(parent, loc, word='WARUNG', hgt=0.26):
    """Papan neon: tabung kaca huruf satu garis, dudukan, kabel, trafo."""
    s = grp('PapanNeon', loc, parent=parent)
    widths = [max(p[0] for st in LET[c] for p in st) for c in word]
    gap = 0.15
    total = (sum(widths) + gap * (len(word) - 1)) * hgt
    bw, bh = total + 0.24, hgt + 0.2
    pm = m_paint('PapanNeonCat', (0.012, 0.016, 0.03), rust=0.5, rough=0.35, drops=0.4)
    box('Papan', (bw, 0.035, bh), (0, 0, bh / 2), pm, bevel=0.004, parent=s)
    for nm, sz, lc in (('a', (bw + 0.02, 0.05, 0.02), (0, 0, bh)), ('b', (bw + 0.02, 0.05, 0.02), (0, 0, 0)),
                       ('l', (0.02, 0.05, bh), (-bw / 2, 0, bh / 2)), ('r', (0.02, 0.05, bh), (bw / 2, 0, bh / 2))):
        box('Bingkai' + nm, sz, lc, M('galv'), bevel=0.003, parent=s)
    nb = NB('EmitNeon')
    e = nb.node('ShaderNodeEmission')
    e.inputs[0].default_value = (1.0, 0.07, 0.24, 1.0)
    e.inputs[1].default_value = 16.0
    nm_ = nb.finish(e.outputs[0])
    NEON_NODES.append(e)
    x = -total / 2
    yn = -0.05
    for c, w in zip(word, widths):
        for st in LET[c]:
            pts = [(x + p[0] * hgt, yn, 0.1 + p[1] * hgt) for p in st]
            tube('Neon_' + c, pts, 0.0075, nm_, parent=s, fil=0.05 * hgt / 0.26 + 0.008, res=3)
            for p in (pts[0], pts[-1], pts[len(pts) // 2]):
                cyl('DudukanNeon', 0.006, 0.035, (p[0], yn + 0.032, p[2]), M('black_plastic'), n=8, bevel=0, rot=(pi / 2, 0, 0), parent=s)
        x += (w + gap) * hgt
    box('Trafo', (0.16, 0.06, 0.08), (bw / 2 - 0.14, 0.05, 0.06), M('black_plastic'), bevel=0.005, parent=s)
    tube('KabelNeon', [(bw / 2 - 0.14, 0.05, 0.02), (bw / 2 - 0.1, 0.1, -0.05), (bw / 2 - 0.3, 0.16, -0.06)], 0.004, M('cable'), parent=s, fil=0.03)
    for sx in (-bw / 2 + 0.12, bw / 2 - 0.12):
        tube('KakiNeon', [(sx, 0.0, 0.05), (sx, 0.22, -0.04)], 0.008, M('steel'), parent=s)
        box('TelapakNeon', (0.03, 0.03, 0.05), (sx, 0, -0.02), M('steel'), bevel=0.003, parent=s)
    return s


def build_gerobak():
    global POT_TOP
    g = grp('Gerobak', G_LOC, (0, 0, radians(-5)))
    wb, wg, ww = M('wood_blue'), M('wood_green'), M('wood_worn')
    # roda, as, rangka bawah + pegangan, kaki
    for sy in (-1, 1):
        wheel('Roda', 0.29, g, (0.3, sy * 0.44, 0.29))
        box('Balok', (2.25, 0.05, 0.07), (-0.27, sy * 0.31, 0.395), ww, bevel=0.006, parent=g)
        box('Kaki', (0.05, 0.05, 0.37), (-0.74, sy * 0.31, 0.0), ww, bevel=0.005, parent=g, base=True)
        box('Siku', (0.035, 0.03, 0.36), (-0.62, sy * 0.31, 0.19), ww, bevel=0.004, parent=g, rot=(0, radians(38), 0))
        cyl('Gagang', 0.021, 0.2, (-1.4, sy * 0.31, 0.395), M('rubber'), n=14, bevel=0.004, rot=(0, pi / 2, 0), parent=g)
    tube('AsRoda', [(0.3, -0.47, 0.29), (0.3, 0.47, 0.29)], 0.012, M('steel'), parent=g)
    tube('PalangGagang', [(-1.34, -0.31, 0.395), (-1.34, 0.31, 0.395)], 0.014, M('steel'), parent=g)
    # badan papan bercat + lis
    box('Badan', (1.7, 0.72, 0.49), (0, 0, 0.43), wb, bevel=0.004, parent=g, base=True)
    for sx in (-0.83, -0.2, 0.83):
        box('LisTegak', (0.055, 0.015, 0.49), (sx, -0.366, 0.43), wg, bevel=0.003, parent=g, base=True)
    for zz in (0.455, 0.895):
        box('LisDatar', (1.7, 0.015, 0.05), (0, -0.366, zz), wg, bevel=0.003, parent=g)
    cyl('Gembok', 0.012, 0.02, (0.3, -0.376, 0.72), M('steel'), n=10, bevel=0.002, rot=(pi / 2, 0, 0), parent=g)
    text('TulisanBadan', 'ES TEH  KOPI', 0.085, m_plastic('CatTulisan', (0.72, 0.68, 0.5), 0.6, wet=0.3, drops=0, dirt=0.6), (-0.52, -0.3745, 0.66), (pi / 2, 0, 0), g, extrude=0.0003, bold=0.012)
    # meja atas berlapis seng + papan saji depan
    box('MejaAtas', (1.78, 0.80, 0.03), (0, -0.01, 0.92), M('alu_dull'), bevel=0.005, parent=g, base=True)
    box('PapanSaji', (1.72, 0.23, 0.024), (0, -0.515, 0.882), ww, bevel=0.004, parent=g, base=True)
    for sx in (-0.75, 0.0, 0.75):
        tube('SikuSaji', [(sx, -0.37, 0.72), (sx, -0.6, 0.88)], 0.008, M('steel'), parent=g)
    # tiang + atap
    for sx in (-0.85, 0.85):
        for sy in (-0.36, 0.34):
            box('Tiang', (0.036, 0.036, 0.9), (sx, sy, 0.95), wb, bevel=0.004, parent=g, base=True)
    box('AtapRangka', (1.86, 0.92, 0.04), (0, -0.03, 1.85), M('plywood'), bevel=0.004, parent=g, base=True)
    box('AtapSeng', (1.96, 1.02, 0.012), (0, -0.03, 1.89), M('metal_white'), bevel=0.003, parent=g, base=True)
    for nm, sz, lc in (('d', (1.94, 0.014, 0.075), (0, -0.535, 1.845)), ('b', (1.94, 0.014, 0.075), (0, 0.475, 1.845)),
                       ('l', (0.014, 1.0, 0.075), (-0.972, -0.03, 1.845)), ('r', (0.014, 1.0, 0.075), (0.972, -0.03, 1.845))):
        box('Lisplang' + nm, sz, lc, wg, bevel=0.003, parent=g)
    # etalase kaca: rangka aluminium, kaca 5 mm, rak
    ex0, ex1, ey0, ey1, ez0, ez1 = -0.84, 0.12, -0.352, 0.31, 0.95, 1.62
    al = M('alu')
    f = 0.018
    for x in (ex0, ex1 - f):
        for y in (ey0, ey1 - f):
            box2('RangkaEt', (x, y, ez0), (x + f, y + f, ez1), al, bevel=0.002, parent=g)
    for z in (ez0, ez1 - f):
        for y in (ey0, ey1 - f):
            box2('RangkaEt', (ex0, y, z), (ex1, y + f, z + f), al, bevel=0.002, parent=g)
        for x in (ex0, ex1 - f):
            box2('RangkaEt', (x, ey0, z), (x + f, ey1, z + f), al, bevel=0.002, parent=g)
    gl = m_glass('KacaEtalase', dust=0.45, smudge=0.7, drops=0.3)
    t = 0.005
    box2('KacaDepan', (ex0 + f, ey0 + 0.004, ez0 + f), (ex1 - f, ey0 + 0.004 + t, ez1 - f), gl, bevel=0.001, parent=g)
    box2('KacaKiri', (ex0 + 0.004, ey0 + f, ez0 + f), (ex0 + 0.004 + t, ey1 - f, ez1 - f), gl, bevel=0.001, parent=g)
    box2('KacaKanan', (ex1 - 0.004 - t, ey0 + f, ez0 + f), (ex1 - 0.004, ey1 - f, ez1 - f), gl, bevel=0.001, parent=g)
    box2('KacaAtas', (ex0 + f, ey0 + f, ez1 - 0.004 - t), (ex1 - f, ey1 - f, ez1 - 0.004), gl, bevel=0.001, parent=g)
    gs = m_glass('KacaRak', dust=0.3, smudge=0.4, drops=0.0)
    for z in (1.17, 1.40):
        box2('Rak', (ex0 + f, ey0 + 0.02, z), (ex1 - f, ey1 - 0.04, z + t), gs, bevel=0.001, parent=g)
    red = m_plastic('StikerMerah', (0.62, 0.03, 0.02), 0.35, wet=0.3, drops=0.2, dirt=0.35)
    yel = m_plastic('StikerKuning', (0.85, 0.62, 0.04), 0.35, wet=0.3, drops=0.2, dirt=0.35)
    text('StikerBakso', 'BAKSO', 0.125, red, (-0.36, ey0 + 0.0032, 1.475), (pi / 2, 0, 0), g, extrude=0.0003, bold=0.02)
    text('StikerMie', 'MIE AYAM', 0.085, yel, (-0.36, ey0 + 0.0032, 1.335), (pi / 2, 0, 0), g, extrude=0.0003, bold=0.02)
    cyl('LampuEtalase', 0.008, 0.8, (-0.36, ey0 + 0.035, ez1 - 0.035), m_emit('EmitLED', (1.0, 0.86, 0.66), 34.0), n=10, bevel=0, rot=(0, pi / 2, 0), parent=g, base=False)
    # isi etalase
    for k, x in enumerate((-0.72, -0.56)):
        for i in range(6 - k):
            place('bowl', mk_bowl, (x, 0.12, 0.955 + i * 0.02), (pi, 0, RND.uniform(0, 3)), g).location.z += 0.062
    tray = M('alu_dull')
    box('Nampan', (0.3, 0.22, 0.012), (-0.25, -0.2, 0.955), tray, bevel=0.004, parent=g, base=True)
    bm = bmesh.new()
    r = random.Random(11)
    for i in range(60):
        lay = 0 if i < 34 else (1 if i < 52 else 2)
        sp = 0.12 - lay * 0.035
        blob(bm, (-0.25 + r.uniform(-sp, sp), -0.2 + r.uniform(-sp * 0.7, sp * 0.7), 0.985 + lay * 0.03), (0.02, 0.02, 0.019), 0.06, rnd=r)
    mk('Bakso', bm, m_plastic('Bakso', (0.33, 0.25, 0.19), 0.45, wet=0.5, drops=0, dirt=0.2, sss=0.25, streak=0), parent=g)
    mie = m_plastic('Mie', (0.80, 0.56, 0.12), 0.5, wet=0.1, drops=0, dirt=0.1, sss=0.2, streak=0)
    for i in range(7):
        cx, cy = -0.66 + (i % 4) * 0.105, -0.22 + (i // 4) * 0.11
        pts = []
        ph = [r.uniform(0, 6.3) for _ in range(4)]
        for k in range(180):
            a = k * 0.33
            rad = 0.022 + 0.017 * sin(a * 0.37 + ph[0]) + 0.006 * sin(a * 1.9 + ph[1])
            pts.append((cx + rad * cos(a + ph[2]), cy + rad * sin(a + ph[2]), 1.182 + 0.012 + 0.009 * sin(a * 0.61 + ph[3])))
        tube('MieMentah', pts, 0.0022, mie, parent=g, res=1)
    bm = bmesh.new()
    for i in range(9):
        blob(bm, (-0.2 + (i % 3) * 0.05 + r.uniform(-0.005, 0.005), -0.2 + (i // 3) * 0.05, 1.20), (0.021, 0.021, 0.027), 0.02, rnd=r)
    mk('Telur', bm, m_plastic('Telur', (0.62, 0.42, 0.28), 0.4, wet=0, drops=0, dirt=0.1, sss=0.2, streak=0), parent=g)
    bm = bmesh.new()
    for i in range(10):
        g_ = bmesh.ops.create_cube(bm, size=1.0)
        rot = Euler((r.uniform(-0.3, 0.3), r.uniform(-0.3, 0.3), r.uniform(0, 3))).to_matrix()
        for v in g_['verts']:
            v.co = Vector((-0.02 + (i % 4) * 0.045, 0.05 + (i // 4) * 0.045, 1.193 + (0.03 if i > 7 else 0))) + rot @ Vector((v.co.x * 0.036, v.co.y * 0.036, v.co.z * 0.026))
    mk('Tahu', bm, m_plastic('Tahu', (0.52, 0.33, 0.12), 0.6, wet=0, drops=0, dirt=0.2, sss=0.15, streak=0), parent=g, bevel=0.004)
    for i in range(8):
        place('glass', mk_glass, (-0.74 + (i % 4) * 0.085, -0.05 + (i // 4) * 0.09, 1.405 + 0.115), (pi, 0, 0), g)
    bm = bmesh.new()
    for i in range(16):
        blob(bm, (-0.25 + r.uniform(-0.1, 0.1), 0.0 + r.uniform(-0.07, 0.07), 1.43 + r.uniform(0, 0.03)), (0.05, 0.022, 0.012), 0.5, rnd=r)
    mk('Sawi', bm, m_plastic('Sawi', (0.03, 0.10, 0.015), 0.45, wet=0.4, drops=0, dirt=0.3, sss=0.1, streak=0), parent=g)
    # kompor + panci ngepul
    px, py = 0.52, -0.03
    st = m_paint('KomporCat', (0.10, 0.22, 0.42), rust=0.5, rough=0.4, drops=0)
    box('Kompor', (0.36, 0.32, 0.075), (px, py, 0.95), st, bevel=0.006, parent=g, base=True)
    lathe('Tungku', [(0.04, 0), (0.07, 0), (0.075, 0.018), (0.05, 0.022), (0.04, 0.012)], M('steel'), n=24, loc=(px, py, 1.025), parent=g)
    lathe('Api', torus_prof(0.06, 0.009, 6), m_emit('EmitApi', (0.12, 0.3, 1.0), 30.0), n=24, loc=(px, py, 1.052), parent=g)
    for k in range(4):
        a = k * pi / 2 + pi / 4
        box('Tatakan', (0.12, 0.012, 0.03), (px + 0.11 * cos(a), py + 0.11 * sin(a), 1.04), M('steel'), bevel=0.003, rot=(0, 0, a), parent=g)
    cyl('Knop', 0.02, 0.02, (px - 0.08, py - 0.17, 0.985), M('black_plastic'), n=12, bevel=0.003, rot=(pi / 2, 0, 0), parent=g)
    pz = 1.058
    pnb = NB('PanciAlu')
    Pp = pnb.obj()
    zz = pnb.sep(Pp)[2]
    soot = pnb.mr(pnb.add(zz, pnb.mul(pnb.noise(Pp, 9.0, 4.0), 0.08)), 0.03, 0.2, 1.0, 0.0, smooth=True)
    pc = pnb.mix(soot, (0.72, 0.72, 0.71), (0.02, 0.018, 0.015))
    dents = pnb.noise(Pp, 14.0, 2.0)
    brush = pnb.noise(pnb.mapping(Pp, scale=(1, 1, 80)), 30.0, 2.0)
    pb = pnb.principled(**{'Base Color': pc, 'Metallic': pnb.inv(pnb.mul(soot, 0.8)), 'Roughness': pnb.add(pnb.lerp(soot, 0.3, 0.75), pnb.mul(pnb.sub(brush, 0.5), 0.2)),
                           'Normal': pnb.bump(dents, 0.25, 0.006)})
    pm = pnb.finish(pb.outputs[0])
    R, Hh = 0.17, 0.3
    pot = lathe('Panci', [(0, 0), (R - 0.015, 0), (R, 0.015), (R, Hh - 0.008), (R + 0.008, Hh), (R + 0.004, Hh + 0.003), (R - 0.003, Hh - 0.006), (R - 0.003, 0.017), (R - 0.016, 0.003), (0, 0.003)],
                pm, n=40, loc=(px, py, pz), parent=g)
    for sy in (-1, 1):
        tube('KupingPanci', [(-0.04, sy * R, Hh - 0.05), (-0.04, sy * (R + 0.035), Hh - 0.045), (0.04, sy * (R + 0.035), Hh - 0.045), (0.04, sy * R, Hh - 0.05)], 0.005, M('alu_dull'), parent=pot, fil=0.015)
    lathe('Kuah', [(0, 0), (R - 0.004, 0)], m_liquid('Kuah', (0.20, 0.12, 0.04), 0.05), n=40, loc=(0, 0, Hh - 0.07), parent=pot)
    bm = bmesh.new()
    for i in range(14):
        a, rr = r.uniform(0, 6.3), r.uniform(0, R - 0.04)
        blob(bm, (rr * cos(a), rr * sin(a), Hh - 0.072), (0.02, 0.02, 0.019), 0.06, rnd=r)
    mk('BaksoKuah', bm, MATS[[k for k in MATS if k.startswith("m_plastic('Bakso'")][0]], parent=pot)
    lid = lathe('TutupPanci', [(R + 0.01, 0), (R + 0.012, 0.004), (R * 0.6, 0.03), (0.02, 0.042), (0.016, 0.06), (0.024, 0.07), (0, 0.072)], pm, n=40, loc=(0.075, 0.03, Hh + 0.02), rot=(radians(-9), radians(13), 0), parent=pot)
    tube('Irus', [(-0.05, -0.04, Hh - 0.08), (-0.2, -0.16, Hh + 0.13)], 0.005, M('alu_dull'), parent=pot)
    POT_TOP = (g.matrix_basis @ Vector((px, py, pz + Hh)))
    # barang di papan saji
    sz = 0.906
    for k, x in enumerate((-0.72, -0.58)):
        for i in range(5 - k):
            place('bowl', mk_bowl, (x, -0.52, sz + i * 0.02), (0, 0, RND.uniform(0, 3)), g)
    for k, (kind, x) in enumerate((('kecap', -0.40), ('saus', -0.32), ('sambal', -0.25))):
        place('bottle_' + kind, mk_bottle(kind), (x, -0.5 + 0.02 * (k % 2), sz), (0, 0, RND.uniform(0, 3)), g)
    lathe('MangkokSambal', BOWL_PROF, m_bowl(), n=24, loc=(-0.12, -0.52, sz), parent=g)
    lathe('Sambal', [(0, 0.04), (0.056, 0.04)], m_liquid('Sambal', (0.35, 0.03, 0.01), 0.25), n=24, loc=(-0.12, -0.52, sz), parent=g)
    for i in range(6):
        place('glass', mk_glass, (0.02 + (i % 3) * 0.08, -0.555 + (i // 3) * 0.08, sz + 0.115), (pi, 0, 0), g)
    cyl('TempatSendok', 0.04, 0.11, (0.31, -0.5, sz), m_plastic('TempatSendok', (0.1, 0.35, 0.5), 0.35, wet=0.3, drops=0.2), n=20, bevel=0.004, parent=g)
    for i in range(9):
        a = i * 0.7
        tube('Sendok', [(0.31 + 0.02 * cos(a), -0.5 + 0.02 * sin(a), sz + 0.02), (0.31 + 0.045 * cos(a), -0.5 + 0.045 * sin(a), sz + 0.19)], 0.003, M('alu'), parent=g, res=1)
    place('toples', mk_toples, (0.60, -0.50, sz), (0, 0, 0.4), g)
    box('Tisu', (0.12, 0.07, 0.05), (0.42, -0.57, sz), m_plastic('KotakTisu', (0.75, 0.3, 0.4), 0.5, wet=0.2, drops=0.1, dirt=0.4), bevel=0.006, parent=g, base=True)
    # ember + lap + lampu
    lathe('Ember', [(0, 0), (0.11, 0), (0.14, 0.24), (0.146, 0.245), (0.136, 0.245), (0.108, 0.006), (0, 0.006)], m_plastic('Ember', (0.05, 0.16, 0.5), 0.35, drops=0.4, dirt=0.5), n=28, loc=(-0.95, 0.5, 0), parent=g)
    lathe('AirEmber', [(0, 0.17), (0.127, 0.17)], m_water('AirEmber'), n=28, loc=(-0.95, 0.5, 0), parent=g)
    bulb((0.3, -0.25, 1.80), 0.05, g)
    neon_sign(g, (0, -0.47, 1.93))
    return g



# ----------------------------------------------------------------------------------------------
# Atlas tulisan (spanduk + poster): teks dirender sekali jadi tekstur, lalu dilunturkan di shader
# ----------------------------------------------------------------------------------------------
ATLAS = {'banner': (0.0, 0.54, 1.0, 1.0), 'p1': (0.0, 0.0, 0.25, 0.36), 'p2': (0.25, 0.0, 0.5, 0.36),
         'p3': (0.5, 0.0, 0.75, 0.36), 'p4': (0.75, 0.0, 1.0, 0.36), 's1': (0.0, 0.37, 0.33, 0.53),
         's2': (0.335, 0.37, 0.665, 0.53), 's3': (0.67, 0.37, 1.0, 0.53)}
ATLAS_PATH = None


def make_atlas():
    global COL, ATLAS_PATH
    ATLAS_PATH = os.path.join(ARGS.cache, 'atlas_tulisan.png')
    sc = bpy.data.scenes.new('Atlas')
    keep = COL
    COL = sc.collection
    made = []
    z = [0.0]

    def E(c):
        return m_emit('AtlasEmit_%.3f_%.3f_%.3f' % tuple(c), c, 1.0)

    def R(x0, y0, x1, y1, c):
        z[0] += 0.001
        o = grid('AR', x0, x1, y0, y1, 1, 1, E(c), z=z[0])
        made.append(o)

    def T(body, x, y, size, c, bold=0.02, ax='CENTER', shear=0.0, sp=1.0):
        z[0] += 0.001
        o = text('AT', body, size, E(c), (x, y, z[0]), extrude=0, ax=ax, bold=min(bold, 0.03) * 0.3, shear=shear, spacing=sp)
        made.append(o)

    def region(key):
        x0, y0, x1, y1 = ATLAS[key]
        return x0, y0, x1 - x0, y1 - y0

    # spanduk kain ala warung tenda
    x, y, w, h = region('banner')
    R(x, y, x + w, y + h, (0.86, 0.84, 0.78))
    for k in range(7):
        R(x + 0.012 + k * 0.012, y, x + 0.018 + k * 0.012, y + h, (0.75, 0.05, 0.04) if k % 2 else (0.05, 0.12, 0.5))
        R(x + w - 0.018 - k * 0.012, y, x + w - 0.012 - k * 0.012, y + h, (0.75, 0.05, 0.04) if k % 2 else (0.05, 0.12, 0.5))
    T('BAKSO', x + w * 0.335, y + h * 0.655, h * 0.40, (0.04, 0.08, 0.36), 0.03, shear=0.15)
    T('BAKSO', x + w * 0.33, y + h * 0.665, h * 0.40, (0.78, 0.04, 0.03), 0.03, shear=0.15)
    T('& MIE AYAM', x + w * 0.705, y + h * 0.64, h * 0.185, (0.04, 0.2, 0.08), 0.03, shear=0.15)
    R(x + 0.12, y + h * 0.385, x + w - 0.12, y + h * 0.40, (0.75, 0.05, 0.04))
    T('SEDIA:  BAKSO URAT - BAKSO TELUR - MIE AYAM CEKER', x + w * 0.5, y + h * 0.27, h * 0.078, (0.04, 0.08, 0.36), 0.02)
    T('ES TEH  -  ES JERUK  -  KOPI  -  KERUPUK', x + w * 0.5, y + h * 0.11, h * 0.085, (0.7, 0.05, 0.04), 0.02)
    # poster
    x, y, w, h = region('p1')
    R(x, y, x + w, y + h, (0.42, 0.05, 0.38))
    for k in range(9):
        R(x, y + h * (0.02 + k * 0.012), x + w, y + h * (0.026 + k * 0.012), (0.9, 0.7, 0.05))
    T('KONSER', x + w / 2, y + h * 0.86, w * 0.18, (0.95, 0.8, 0.1), 0.03)
    T('DANGDUT', x + w / 2, y + h * 0.72, w * 0.16, (0.95, 0.95, 0.9), 0.03)
    R(x + w * 0.2, y + h * 0.36, x + w * 0.8, y + h * 0.62, (0.9, 0.45, 0.1))
    T('MALAM', x + w / 2, y + h * 0.53, w * 0.13, (0.25, 0.03, 0.2), 0.03)
    T('MINGGU', x + w / 2, y + h * 0.43, w * 0.13, (0.25, 0.03, 0.2), 0.03)
    T('LAPANGAN DESA', x + w / 2, y + h * 0.27, w * 0.085, (0.95, 0.95, 0.9))
    T('GRATIS', x + w / 2, y + h * 0.18, w * 0.12, (0.95, 0.8, 0.1), 0.03)
    x, y, w, h = region('p2')
    R(x, y, x + w, y + h, (0.84, 0.82, 0.74))
    R(x + w * 0.06, y + h * 0.7, x + w * 0.94, y + h * 0.93, (0.72, 0.05, 0.04))
    T('DIJUAL', x + w / 2, y + h * 0.815, w * 0.2, (0.9, 0.88, 0.8), 0.03)
    T('TANAH', x + w / 2, y + h * 0.58, w * 0.2, (0.05, 0.05, 0.06), 0.03)
    T('200 M2', x + w / 2, y + h * 0.44, w * 0.17, (0.05, 0.05, 0.06), 0.03)
    T('TANPA PERANTARA', x + w / 2, y + h * 0.31, w * 0.075, (0.72, 0.05, 0.04))
    T('HUB. 08XX-XXXX-XXXX', x + w / 2, y + h * 0.18, w * 0.07, (0.05, 0.05, 0.06))
    x, y, w, h = region('p3')
    R(x, y, x + w, y + h, (0.06, 0.2, 0.5))
    R(x + w * 0.05, y + h * 0.05, x + w * 0.95, y + h * 0.62, (0.85, 0.83, 0.76))
    T('LES', x + w / 2, y + h * 0.87, w * 0.2, (0.95, 0.85, 0.15), 0.03)
    T('PRIVAT', x + w / 2, y + h * 0.73, w * 0.2, (0.95, 0.95, 0.9), 0.03)
    T('SD - SMP - SMA', x + w / 2, y + h * 0.53, w * 0.1, (0.06, 0.2, 0.5), 0.02)
    T('MATEMATIKA', x + w / 2, y + h * 0.42, w * 0.105, (0.7, 0.05, 0.04), 0.02)
    T('BAHASA INGGRIS', x + w / 2, y + h * 0.32, w * 0.085, (0.7, 0.05, 0.04), 0.02)
    T('GURU DATANG', x + w / 2, y + h * 0.2, w * 0.085, (0.05, 0.05, 0.06))
    T('KE RUMAH', x + w / 2, y + h * 0.12, w * 0.085, (0.05, 0.05, 0.06))
    x, y, w, h = region('p4')
    R(x, y, x + w, y + h, (0.85, 0.72, 0.12))
    T('LOWONGAN', x + w / 2, y + h * 0.84, w * 0.135, (0.05, 0.05, 0.06), 0.03)
    R(x + w * 0.08, y + h * 0.745, x + w * 0.92, y + h * 0.76, (0.05, 0.05, 0.06))
    T('DICARI', x + w / 2, y + h * 0.63, w * 0.17, (0.7, 0.05, 0.04), 0.03)
    T('PELAYAN', x + w / 2, y + h * 0.5, w * 0.15, (0.05, 0.05, 0.06), 0.03)
    T('WARUNG', x + w / 2, y + h * 0.38, w * 0.15, (0.05, 0.05, 0.06), 0.03)
    T('RAJIN  JUJUR', x + w / 2, y + h * 0.24, w * 0.09, (0.05, 0.05, 0.06))
    T('TANYA DI DALAM', x + w / 2, y + h * 0.12, w * 0.08, (0.7, 0.05, 0.04))
    for key, bgc, fg, l1, l2 in (('s1', (0.9, 0.78, 0.1), (0.04, 0.04, 0.05), 'SEDOT WC', '08XX XXXX XXX'),
                                 ('s2', (0.85, 0.84, 0.8), (0.05, 0.15, 0.55), 'SERVIS AC', 'KULKAS  POMPA AIR'),
                                 ('s3', (0.7, 0.08, 0.05), (0.92, 0.9, 0.85), 'GALI SUMUR', 'TERIMA BORONGAN')):
        x, y, w, h = region(key)
        R(x, y, x + w, y + h, bgc)
        T(l1, x + w / 2, y + h * 0.62, h * 0.30, fg, 0.03)
        T(l2, x + w / 2, y + h * 0.2, h * 0.15, fg, 0.01)
    cam = bpy.data.cameras.new('AtlasCam')
    cam.type = 'ORTHO'
    cam.ortho_scale = 1.0
    co = bpy.data.objects.new('AtlasCam', cam)
    co.location = (0.5, 0.5, 5.0)
    sc.collection.objects.link(co)
    sc.camera = co
    sc.world = bpy.data.worlds.new('AtlasWorld')
    sc.world.color = (0, 0, 0)
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 16
    sc.cycles.use_denoising = False
    sc.cycles.max_bounces = 0
    sc.render.resolution_x = sc.render.resolution_y = 2048
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.view_settings.view_transform = 'Standard'
    sc.render.filepath = ATLAS_PATH[:-4]
    bpy.ops.render.render(write_still=True, scene=sc.name)
    COL = keep
    for o in made + [co]:
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.scenes.remove(sc)
    log('atlas tulisan dirender -> %s' % ATLAS_PATH)


def set_uv_region(ob, key):
    x0, y0, x1, y1 = ATLAS[key]
    for l in ob.data.uv_layers[0].data:
        l.uv = (x0 + l.uv[0] * (x1 - x0), y0 + l.uv[1] * (y1 - y0))


@memo
def m_poster(w=0.42, h=0.6):
    """Poster kertas luntur: warna pudar tidak rata, tinta meleleh ke bawah, noda air, tepi
    sobek (alpha), kerut. Objek poster dibuat di bidang XY lokal (y = atas)."""
    nb = NB('PosterLuntur_%d' % int(w * 100))
    P0 = nb.obj()
    P = nb.vmath('ADD', P0, nb.vmath('SCALE', (3.1, 1.7, 2.3), scale=nb.objrand()))
    uv = nb.uv()
    run = nb.mul(nb.sub(nb.noise(nb.mapping(P, scale=(70, 2, 1)), 1.0, 2.0), 0.5), 0.014)
    im = nb.img(ATLAS_PATH, nb.vmath('ADD', uv, nb.comb(0.0, run, 0.0)), proj='FLAT')
    fade = nb.mr(nb.noise(nb.mapping(P, scale=(9, 1.2, 1)), 1.0, 4.0, 0.65), 0.3, 0.75, 0.2, 0.8, smooth=True)
    col = nb.mix(fade, im.outputs[0], nb.mix(0.5, nb.hsv(im.outputs[0], s=0.25, v=1.3), (0.62, 0.58, 0.48)))
    col = nb.mix(nb.mr(nb.noise(P, 5.0, 5.0, 0.7), 0.5, 0.72, 0.0, 0.7), col, (0.16, 0.12, 0.07))
    streak = nb.mr(nb.noise(nb.mapping(P, scale=(26, 0.8, 1)), 1.0, 3.0, 0.6), 0.52, 0.7, 0.0, 0.6, smooth=True)
    col = nb.mix(streak, col, nb.hsv(col, v=0.45))
    x, y, _z = nb.sep(P0)
    ed = nb.mn(nb.sub(w / 2, nb.math('ABSOLUTE', x)), nb.sub(h / 2, nb.math('ABSOLUTE', y)))
    tear = nb.add(nb.add(nb.mul(nb.noise(P, 16.0, 4.0, 0.7), 0.5), nb.mul(nb.noise(P, 4.0, 3.0), 0.5)), nb.mul(ed, 7.0))
    big = nb.math('LESS_THAN', nb.noise(nb.vmath('ADD', P, (1.3, 2.9, 0)), 3.2, 3.0), 0.69)
    wr = nb.noise(P, 11.0, 3.0, 0.6, dist=1.5)
    b = wet_surface(nb, col, nb.lerp(streak, 0.72, 0.3), wr, wet=0.5, streak=0, bump=0.35, bdist=0.004, coat=0.25)
    nb.set(b.inputs['Alpha'], nb.mul(nb.math('GREATER_THAN', tear, 0.47), big))
    return nb.finish(b.outputs[0])


@memo
def m_banner():
    """Spanduk kain kusam: tenun halus, noda, sedikit tembus cahaya."""
    nb = NB('SpandukKain')
    P = nb.obj()
    uv = nb.uv()
    im = nb.img(ATLAS_PATH, uv, proj='FLAT')
    fade = nb.mr(nb.noise(P, 1.6, 4.0, 0.6), 0.3, 0.7, 0.05, 0.4)
    col = nb.mix(fade, nb.hsv(im.outputs[0], s=1.1, v=0.8), nb.mix(0.6, nb.hsv(im.outputs[0], s=0.4, v=0.9), (0.5, 0.45, 0.38)))
    _x, _y, z = nb.sep(P)
    grime = nb.math('ADD', nb.mr(nb.noise(P, 3.5, 5.0, 0.7), 0.45, 0.75, 0.0, 0.5), nb.mr(z, 1.2, 1.45, 0.4, 0.0), clamp=True)
    col = nb.mix(grime, col, (0.12, 0.09, 0.06))
    weave = nb.mul(nb.math('SINE', nb.mul(nb.sep(uv)[0], 5200.0)), nb.math('SINE', nb.mul(nb.sep(uv)[1], 2400.0)))
    wr = nb.add(nb.mul(nb.noise(nb.mapping(P, scale=(1, 1, 5)), 6.0, 3.0), 0.8), nb.mul(weave, 0.1))
    pb = wet_surface(nb, col, 0.82, wr, wet=0.35, streak=0.6, bump=0.3, bdist=0.004, coat=0.0, **{'Sheen Weight': 0.3})
    tb = nb.node('ShaderNodeBsdfTranslucent')
    nb.set(tb.inputs[0], col)
    ms = nb.node('ShaderNodeMixShader')
    ms.inputs[0].default_value = 0.2
    nb.nt.links.new(pb.outputs[0], ms.inputs[1])
    nb.nt.links.new(tb.outputs[0], ms.inputs[2])
    return nb.finish(ms.outputs[0])


@memo
def m_tarp():
    """Terpal PE biru/oranye: lipatan bekas simpan, kerut, kotor, genangan dan butir air di sisi
    atas, cahaya tembus (translucent)."""
    nb = NB('Terpal')
    uv = nb.uv()
    U = nb.mapping(uv, scale=(3.6, 2.6, 1.0))
    ux, uy, _ = nb.sep(U)
    back = nb.geo('Backfacing')

    def crease(v, per):
        return nb.mr(nb.math('ABSOLUTE', nb.sub(nb.math('FRACT', nb.math('DIVIDE', v, per)), 0.5)), 0.0, 0.03, 1.0, 0.0, smooth=True)
    cr = nb.mx(crease(ux, 0.6), crease(uy, 0.52))
    n1 = nb.noise(U, 2.2, 5.0, 0.65)
    topc = nb.mix(nb.mr(n1, 0.3, 0.7, 0.0, 1.0), (0.025, 0.10, 0.40), (0.04, 0.17, 0.52))
    botc = nb.mix(nb.mr(n1, 0.3, 0.7, 0.0, 1.0), (0.72, 0.22, 0.03), (0.80, 0.30, 0.05))
    col = nb.mix(back, topc, botc)
    col = nb.mix(nb.mul(cr, 0.45), col, (0.6, 0.62, 0.66))
    dirt = nb.mr(nb.noise(U, 5.0, 5.0, 0.7), 0.4, 0.72, 0.0, 0.8)
    col = nb.mix(dirt, col, (0.07, 0.06, 0.045))
    mud = nb.mr(nb.noise(nb.mapping(U, scale=(1.0, 0.25, 1.0)), 3.0, 4.0, 0.65), 0.52, 0.7, 0.0, 0.6, smooth=True)
    col = nb.mix(mud, col, (0.10, 0.085, 0.06))
    patch = nb.mx(nb.mul(band(nb, ux, 0.95, 1.4, 0.004), band(nb, uy, 1.25, 1.62, 0.004)), nb.mul(band(nb, ux, 2.55, 2.85, 0.004), band(nb, uy, 0.55, 1.0, 0.004)))
    seam = nb.sub(patch, nb.mx(nb.mul(band(nb, ux, 0.97, 1.38, 0.004), band(nb, uy, 1.27, 1.6, 0.004)), nb.mul(band(nb, ux, 2.57, 2.83, 0.004), band(nb, uy, 0.57, 0.98, 0.004))))
    col = nb.mix(nb.mul(patch, 0.85), col, nb.mix(back, (0.30, 0.34, 0.40), (0.42, 0.40, 0.36)))
    col = nb.mix(nb.math('MULTIPLY', seam, 0.8, clamp=True), col, (0.02, 0.02, 0.025))
    weave = nb.mul(nb.math('SINE', nb.mul(ux, 3000.0)), nb.math('SINE', nb.mul(uy, 3000.0)))
    wr = nb.noise(nb.mapping(U, rot=(0, 0, 0.5), scale=(1.0, 4.0, 1.0)), 7.0, 3.0, 0.6, dist=0.8)
    h = nb.add(nb.add(nb.add(nb.mul(cr, 0.8), nb.mul(wr, 0.6)), nb.mul(weave, 0.06)), nb.mul(patch, 0.5))
    nrm = nb.bump(h, 0.6, 0.008)
    front = nb.inv(back)
    dh = nb.mul(nb.drops(U, 70.0, 0.55), front)
    nrm2 = nb.bump(dh, 0.6, 0.003, nrm)
    wetm = nb.mul(front, nb.mr(nb.noise(U, 1.5, 3.0), 0.3, 0.7, 0.45, 0.95))
    colw = nb.mix(nb.mul(wetm, 0.5), col, nb.hsv(col, s=1.1, v=0.6))
    pb = nb.principled(**{'Base Color': colw, 'Roughness': nb.lerp(nb.mx(wetm, dh), 0.5, 0.12), 'Normal': nrm2,
                          'Coat Weight': nb.mx(nb.mul(wetm, 0.6), dh), 'Coat Roughness': 0.06, 'Coat IOR': 1.33})
    tb = nb.node('ShaderNodeBsdfTranslucent')
    nb.set(tb.inputs[0], nb.mix(0.35, col, (0.5, 0.6, 0.9)))
    nb.set(tb.inputs['Normal'], nrm)
    ms = nb.node('ShaderNodeMixShader')
    ms.inputs[0].default_value = 0.30
    nb.nt.links.new(pb.outputs[0], ms.inputs[1])
    nb.nt.links.new(tb.outputs[0], ms.inputs[2])
    return nb.finish(ms.outputs[0])


@memo
def m_bamboo():
    nb = NB('Bambu')
    P = nb.vmath('ADD', nb.obj(), nb.vmath('SCALE', (3.3, 1.1, 0.19), scale=nb.objrand()))
    z = nb.sep(P)[2]
    ring = nb.mr(nb.math('ABSOLUTE', nb.sub(nb.math('FRACT', nb.math('DIVIDE', z, 0.36)), 0.5)), 0.0, 0.035, 1.0, 0.0, smooth=True)
    fib = nb.noise(nb.mapping(P, scale=(70, 70, 1.5)), 1.0, 3.0, 0.6)
    col = nb.mix(nb.mr(nb.noise(P, 2.5, 4.0), 0.3, 0.7, 0.0, 1.0), (0.50, 0.36, 0.13), (0.30, 0.25, 0.10))
    col = nb.mix(nb.mul(fib, 0.3), col, (0.2, 0.15, 0.06))
    col = nb.mix(nb.mul(ring, 0.7), col, (0.10, 0.07, 0.035))
    col = nb.mix(nb.mr(nb.noise(P, 5.0, 5.0, 0.7), 0.5, 0.75, 0.0, 0.5), col, (0.06, 0.06, 0.04))
    h = nb.add(nb.mul(ring, 1.0), nb.mul(fib, 0.2))
    b = wet_surface(nb, col, 0.38, h, wet=0.5, streak=0.5, drops=0.15, bump=0.6, bdist=0.004)
    return nb.finish(b.outputs[0])


# ----------------------------------------------------------------------------------------------
# Tenda, meja, bangku, spanduk
# ----------------------------------------------------------------------------------------------
# atap miring turun ke arah jalan: sisi atas terpal kelihatan dari depan
TX0, TX1, TXM, TYF, TYB, TZF, TZB = -2.7, 0.25, -0.95, -1.1, 0.9, 2.2, 2.78
TARP = None
BANNER = None
SIM_PINS = {}


def tent_z(y):
    return TZF + (TZB - TZF) * (y - TYF) / (TYB - TYF)


def pole(name, a, b, r, mat, n=14):
    a, b = Vector(a), Vector(b)
    d = b - a
    g = grp(name, a)
    g.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    cyl(name + '_b', r, d.length, (0, 0, 0), mat, n=n, bevel=0.004, parent=g, r2=r * 0.9)
    return g


def lash(p, r, axis='Z'):
    """Ikatan tali rafia di sambungan bambu."""
    for k in range(5):
        pts = [(r * cos(2 * pi * i / 12), r * sin(2 * pi * i / 12), (k - 2) * 0.008 + 0.006 * sin(i * 1.1 + k)) for i in range(12)]
        o = tube('Ikat', pts, 0.0035, M('raffia'), cyclic=True, res=1)
        o.location = p
        if axis == 'X':
            o.rotation_euler = (0, pi / 2, 0)
        elif axis == 'Y':
            o.rotation_euler = (pi / 2, 0, 0)


def build_tent():
    global TARP, BANNER
    bam = m_bamboo()
    cols = [(0.45, 0.07, 0.05), (0.06, 0.2, 0.4), (0.55, 0.5, 0.42), (0.1, 0.3, 0.12)]
    k = 0
    for x in (TX0, TXM, TX1):
        for y in (TYF, TYB):
            top = tent_z(y)
            pole('TiangTenda', (x, y, 0.02), (x + RND.uniform(-0.02, 0.02), y, top + 0.09), 0.036, bam)
            cyl('KalengSemen', 0.115, 0.24, (x, y, 0), m_paint('KalengCat%d' % (k % 4), cols[k % 4], rust=0.7, rough=0.4, drops=0.3), n=24, bevel=0.005)
            cyl('SemenKaleng', 0.108, 0.012, (x, y, 0.232), M('conc'), n=24, bevel=0.002)
            lash((x, y - 0.0, top - 0.04), 0.045, 'Z')
            k += 1
        pole('Kaso', (x - 0.035, TYF - 0.18, tent_z(TYF - 0.18)), (x - 0.035, TYB + 0.16, tent_z(TYB + 0.16)), 0.03, bam)
    for y in (TYF, TYB):
        pole('Balok', (TX0 - 0.2, y + 0.04, tent_z(y) - 0.035), (TX1 + 0.2, y + 0.04, tent_z(y) - 0.035), 0.033, bam)
        for x in (TX0, TXM, TX1):
            lash((x, y + 0.04, tent_z(y) - 0.035), 0.042, 'X')
    # tali penahan ke kaleng semen
    for x, sx in ((TX0, -1), (TX1, 1)):
        tube('TaliTenda', sag_pts((x, TYF, TZF), (x + sx * 0.02, TYF - 0.55, 0.3), 0.03, 10), 0.004, M('rope'))
    # terpal: grid ber-UV; posisi awal = bidang miring, simulasi kain mengganti bentuknya
    ox, oyf, oyb = 0.3, 0.32, 0.26
    x0, x1, y0, y1 = TX0 - ox, TX1 + ox, TYF - oyf, TYB + oyb
    nx, ny = 76, 56

    def zf(x, y):
        z = tent_z(max(TYF, min(TYB, y))) + 0.04
        if ARGS.skip_sim:   # bentuk statis kira-kira kalau simulasi dilewati
            bay = (x - TX0) / (TXM - TX0) if x < TXM else (x - TXM) / (TX1 - TXM)
            if 0 < bay < 1 and TYF < y < TYB:
                z -= 0.09 * sin(pi * bay) * sin(pi * (y - TYF) / (TYB - TYF)) ** 0.5
            for edge, v in ((TYF, TYF - y), (TYB, y - TYB)):
                if v > 0:
                    z -= v * 0.8
            for v in (TX0 - x, x - TX1):
                if v > 0:
                    z -= v * 0.8
        return z
    TARP = grid('Terpal', x0, x1, y0, y1, nx, ny, m_tarp(), zf=zf)
    pins = []
    for v in TARP.data.vertices:
        x, y = v.co.x, v.co.y
        on_raf = min(abs(x - (TX0 - 0.035)), abs(x - (TXM - 0.035)), abs(x - (TX1 - 0.035))) < (x1 - x0) / nx * 0.55 and TYF - 0.02 <= y <= TYB + 0.02
        on_beam = min(abs(y - TYF), abs(y - TYB)) < (y1 - y0) / ny * 0.55 and TX0 - 0.05 <= x <= TX1 + 0.05
        if on_raf or on_beam:
            pins.append(v.index)
    SIM_PINS['Terpal'] = pins
    # spanduk kain di sisi depan (bentang kiri), disinari bohlam dari belakang
    bx0, bx1 = TX0 + 0.07, TXM - 0.1
    bz0 = 1.2
    bz1 = bz0 + (bx1 - bx0) / 2.15
    by = TYF - 0.06
    BANNER = grid('Spanduk', bx0, bx1, bz0, bz1, 62, 28, m_banner(),
                  zf=(lambda x, y: 0.03 * sin(x * 7.0) * sin((y - bz0) * 3.0) + 0.012 * sin(x * 23.0)) if ARGS.skip_sim else None)
    set_uv_region(BANNER, 'banner')
    for v in BANNER.data.vertices:      # grid dibuat di bidang XY: putar jadi tegak menghadap -Y
        x, zz, d = v.co.x, v.co.y, v.co.z
        v.co = (x, by - d, zz)
    pins = []
    dx = (bx1 - bx0) / 62
    eyelets = [bx0 + (bx1 - bx0) * i / 5 for i in range(6)]
    for v in BANNER.data.vertices:
        x, zz = v.co.x, v.co.z
        if zz > bz1 - 0.01 and min(abs(x - e) for e in eyelets) < dx * 0.6:
            pins.append(v.index)
        if zz < bz0 + 0.01 and (x < bx0 + dx * 0.6 or x > bx1 - dx * 0.6):
            pins.append(v.index)
    SIM_PINS['Spanduk'] = pins
    for e in eyelets:
        tube('TaliSpanduk', [(e, by, bz1), (e + RND.uniform(-0.03, 0.03), TYF + 0.04, tent_z(TYF) - 0.035)], 0.0025, M('raffia'), res=1)
    tube('TaliSpandukBawah', [(bx0, by, bz0), (TX0, TYF, bz0 - 0.2)], 0.0025, M('raffia'), res=1)
    tube('TaliSpandukBawah', [(bx1, by, bz0), (TXM, TYF, bz0 - 0.15)], 0.0025, M('raffia'), res=1)
    # rangkaian bohlam: kabel sepanjang balok depan + kaso tengah
    zc = TZF - 0.09
    cable = []
    bx = [TX0 + 0.55, TXM - 0.55, (TXM + TX1) / 2]
    anchors = [TX0] + bx + [TX1]
    for a, b in zip(anchors[:-1], anchors[1:]):
        cable += sag_pts((a, TYF + 0.05, zc), (b, TYF + 0.05, zc), 0.07, 8)
    tube('KabelLampu', cable, 0.004, M('cable'))
    for x in bx:
        bulb((x, TYF + 0.05, zc - 0.07 - 0.22), 0.22)
    bulb((TXM + 0.35, -0.1, tent_z(-0.1) - 0.5), 0.44)
    bulb((TX0 + 0.8, 0.3, tent_z(0.3) - 0.62), 0.56)
    tube('KabelListrikTenda', sag_pts((TX1, TYF + 0.05, zc), (1.25 + 0.9, -0.62 + 0.3, 1.92), 0.25, 14), 0.004, M('cable'))


def build_table():
    t = grp('Meja', (-1.25, -0.15, 0.0), (0, 0, radians(2)))
    wd, wr = M('wood_brown'), M('wood_worn')
    for i in range(4):
        box('PapanMeja', (2.1, 0.146, 0.03), (RND.uniform(-0.01, 0.01), -0.225 + i * 0.15, 0.745 + RND.uniform(-0.002, 0.002)), wd, bevel=0.004, parent=t, base=True)
    for sx in (-0.95, 0.95):
        for sy in (-0.24, 0.24):
            box('KakiMeja', (0.055, 0.055, 0.745), (sx, sy, 0), wr, bevel=0.005, parent=t, base=True)
        box('Palang', (0.04, 0.5, 0.06), (sx, 0, 0.66), wr, bevel=0.004, parent=t, base=True)
        box('PalangBawah', (0.035, 0.5, 0.04), (sx, 0, 0.14), wr, bevel=0.004, parent=t, base=True)
    for sy in (-0.24, 0.24):
        box('Sabuk', (1.9, 0.025, 0.08), (0, sy, 0.655), wr, bevel=0.004, parent=t, base=True)
    box('PalangTengah', (1.9, 0.035, 0.04), (0, 0, 0.14), wr, bevel=0.004, parent=t, base=True)
    z = 0.776
    # barang di meja
    place('toples', mk_toples, (0.78, 0.08, z), (0, 0, 1.0), t)
    for kind, x, y in (('kecap', -0.1, 0.06), ('saus', -0.02, 0.1), ('sambal', 0.06, 0.03)):
        place('bottle_' + kind, mk_bottle(kind), (x, y, z), (0, 0, RND.uniform(0, 3)), t)
    for x, y, tea in ((-0.72, -0.12, True), (-0.3, 0.14, True), (0.33, -0.16, False), (0.45, 0.12, True), (-0.55, 0.16, False)):
        place('glass_tea' if tea else 'glass', mk_glass_tea if tea else mk_glass, (x, y, z), (0, 0, 0), t)
    for x, y in ((-0.6, -0.1), (0.25, -0.05)):
        b = place('bowl', mk_bowl, (x, y, z), (0, 0, RND.uniform(0, 3)), t)
        lathe('SisaKuah', [(0, 0.022), (0.04, 0.022)], m_liquid('Kuah', (0.20, 0.12, 0.04), 0.05), n=20, loc=(x, y, z), parent=t)
        tube('SendokMeja', [(x + 0.02, y, z + 0.022), (x + 0.11, y + 0.05, z + 0.07)], 0.003, M('alu'), parent=t, res=1)
    cyl('TempatSendok', 0.04, 0.11, (0.62, -0.15, z), m_plastic('TempatSendok', (0.1, 0.35, 0.5), 0.35, wet=0.3, drops=0.2), n=20, bevel=0.004, parent=t)
    for i in range(8):
        a = i * 0.8
        tube('Sendok', [(0.62 + 0.02 * cos(a), -0.15 + 0.02 * sin(a), z + 0.02), (0.62 + 0.045 * cos(a), -0.15 + 0.045 * sin(a), z + 0.19)], 0.003, M('alu'), parent=t, res=1)
    box('Tisu', (0.12, 0.07, 0.05), (-0.9, 0.05, z), m_plastic('KotakTisu', (0.75, 0.3, 0.4), 0.5, wet=0.2, drops=0.1, dirt=0.4), bevel=0.006, parent=t, base=True, rot=(0, 0, 0.3))
    lathe('Asbak', [(0, 0), (0.05, 0), (0.055, 0.025), (0.048, 0.025), (0.044, 0.006), (0, 0.006)], m_glass('KacaGelas', dust=0.12, smudge=0.5, drops=0.0), n=20, loc=(0.9, -0.17, z), parent=t)
    # bangku plastik
    sc = {'merah': (0.55, 0.035, 0.03), 'biru': (0.04, 0.13, 0.5), 'hijau': (0.05, 0.33, 0.12)}
    spots = [(-2.05, -0.72, 'merah'), (-1.4, -0.78, 'biru'), (-0.72, -0.7, 'merah'), (-0.25, -0.82, 'hijau'),
             (-1.85, 0.42, 'biru'), (-1.05, 0.46, 'merah'), (-0.3, 0.42, 'hijau')]
    for x, y, c in spots:
        place('stool_' + c, mk_stool(sc[c], c), (x + RND.uniform(-0.04, 0.04), y + RND.uniform(-0.04, 0.04), 0), (0, 0, RND.uniform(0, 1.5)))
    for i in range(3):   # tumpukan bangku nganggur
        place('stool_biru' if i % 2 else 'stool_merah', mk_stool(sc['biru' if i % 2 else 'merah'], 'biru' if i % 2 else 'merah'), (-3.15, -0.35, i * 0.085), (0, 0, 0.3 + i * 0.05))
    return t



# ----------------------------------------------------------------------------------------------
# Model CC0 Poly Haven (pot tanaman, AC, tutup got, dll)
# ----------------------------------------------------------------------------------------------
def _wetify(mat, k=0.55, coat=0.35):
    """Bikin material bawaan model ikut basah: roughness turun, ada lapisan coat air."""
    if not mat or not mat.use_nodes or mat.get('_wet'):
        return
    mat['_wet'] = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type != 'BSDF_PRINCIPLED':
            continue
        r = n.inputs['Roughness']
        if r.is_linked:
            src = r.links[0].from_socket
            m = nt.nodes.new('ShaderNodeMath')
            m.operation = 'MULTIPLY'
            m.inputs[1].default_value = k
            nt.links.new(src, m.inputs[0])
            nt.links.new(m.outputs[0], r)
        else:
            r.default_value *= k
        n.inputs['Coat Weight'].default_value = coat
        n.inputs['Coat Roughness'].default_value = 0.08
        n.inputs['Coat IOR'].default_value = 1.33


def ph_model(slug, loc=(0, 0, 0), rot=(0, 0, 0), scale=None, parent=None, pick=None, tag='', wet=0.55):
    key = 'ph_%s_%s' % (slug, tag)

    def load():
        with bpy.data.libraries.load(MODEL_PATH[slug], link=False) as (src, dst):
            dst.objects = [n for n in src.objects if (pick is None or pick(n))]
        objs = [o for o in dst.objects if o is not None and o.type == 'MESH']
        if not objs:
            raise RuntimeError('model %s: objek tidak ketemu' % slug)
        lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
        for o in objs:
            for c in o.bound_box:
                w = o.matrix_basis @ Vector(c)
                lo = Vector(map(min, lo, w))
                hi = Vector(map(max, hi, w))
        root = grp('PH_' + slug + tag)
        off = Matrix.Translation((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))
        for o in objs:
            mb = o.matrix_basis.copy()
            COL.objects.link(o)
            o.parent = root
            o.matrix_parent_inverse = Matrix.Identity(4)
            o.matrix_basis = off @ mb
            if wet:
                for m in o.data.materials:
                    _wetify(m, wet)
        return root
    return place(key, load, loc, rot, parent, scale)


def build_ph_props(table):
    ph_model('exterior_aircon_unit', (1.95, WALL_Y0 - 0.19, 3.42), pick=lambda n: n == 'exterior_aircon_unit_rusted')
    ph_model('water_manhole_cover', (-1.55, -2.75, -0.066), (0, 0, 0.7), wet=0.4)
    ph_model('potted_plant_01', (2.35, 2.82, 0.15), (0, 0, 1.0), scale=0.95)
    ph_model('potted_plant_02', (3.05, 2.72, 0.15), (0, 0, 2.2))
    ph_model('potted_plant_02', (-2.75, 2.8, 0.15), (0, 0, 0.4), scale=0.85)
    ph_model('potted_plant_04', (1.55, 2.86, 0.15), (0, 0, 0.3), scale=1.6)
    ph_model('potted_plant_04', (WIN[0] + 0.2, WALL_Y0 - 0.03, WIN[2]), (0, 0, 1.3), scale=1.2)
    ph_model('plastic_thermos', (-0.38, -0.02, 0.776), (0, 0, 2.2), parent=table, wet=0.8)
    ph_model('small_lpg_tank', (2.38, -0.2, 0.0), (0, 0, 0.6), scale=0.8)
    tube('SelangGas', [(2.38, -0.2, 0.5), (2.3, -0.3, 0.75), (2.05, -0.55, 0.7), (1.85, -0.62, 1.0)], 0.007, M('pvc_orange'), fil=0.1)
    ph_model('plastic_crate_02', (-3.3, 0.35, 0.0), (0, 0, 0.25))
    ph_model('plastic_crate_02', (-3.28, 0.37, 0.255), (0, 0, 0.1))
    ph_model('trashbag', (-3.62, 0.72, 0.0), (0, 0, 0.5), scale=0.9)
    ph_model('trashbag', (-3.15, 0.78, 0.0), (0, 0, 2.5), scale=0.75)
    ph_model('plastic_monobloc_chair_01', (-2.5, -0.15, 0.0), (0, 0, radians(-80)))
    ph_model('cardboard_box_01', (0.05, 0.55, 0.0), (0, 0, 0.4), wet=0.8)
    ph_model('old_tyre', (-3.7, 2.05, 0.15), (radians(14), 0, radians(20)), scale=0.95)
    r = random.Random(5)
    weeds = [n for n in ('a', 'b', 'c', 'd')]
    for i in range(16):
        w = r.choice(weeds)
        if i < 7:
            x, y, z = r.uniform(-3.9, 3.9), 1.60 + r.uniform(0.0, 0.03), 0.15
        elif i < 12:
            x, y, z = r.uniform(-3.9, 3.9), 3.07 + r.uniform(-0.03, 0.0), 0.15
        else:
            x, y, z = r.uniform(-3.8, 3.8), 0.92 + r.uniform(-0.03, 0.0), 0.0
        ph_model('weed_plant_02', (x, y, z), (0, 0, r.uniform(0, 6)), scale=r.uniform(0.7, 1.3), pick=lambda n, w=w: n == 'weed_plant_02_%s_LOD0' % w, tag=w)
    for i in range(12):
        g = r.choice(['small_a', 'mid_b', 'tall_a', 'tall_b', 'small_b'])
        x = r.choice([r.uniform(-3.9, -2.3), r.uniform(1.4, 3.9)])
        ph_model('grass_medium_01', (x, 3.06 + r.uniform(-0.04, 0.0), 0.15), (0, 0, r.uniform(0, 6)), scale=r.uniform(0.7, 1.2), pick=lambda n, g=g: n == 'grass_medium_01_%s_LOD0' % g, tag=g)


def poster(key, x, z, w=0.42, h=0.6, tilt=0.0, y=None, curl=0.02):
    """Poster nempel tembok (grid ber-UV, sedikit kerut, sudut terkelupas)."""
    r = random.Random(hash(key + str(x)) & 0xffff)
    ph = [r.uniform(0, 6.3) for _ in range(3)]

    def zf(u, v):
        d = 0.002 * sin(u * 31 + ph[0]) * sin(v * 23 + ph[1])
        cx, cy = (w / 2 - abs(u)), (h / 2 - abs(v))
        c = max(0.0, 0.07 - sqrt((u - w / 2 * (1 if ph[2] > 3 else -1)) ** 2 + (v - h / 2) ** 2))
        return d + curl * 60 * c * c
    o = grid('Poster_' + key, -w / 2, w / 2, -h / 2, h / 2, 14, 18, m_poster(w, h), zf=zf)
    set_uv_region(o, key)
    o.rotation_euler = (pi / 2, tilt, 0)
    o.location = (x, (WALL_Y0 - 0.003) if y is None else y, z)
    return o


def build_posters():
    poster('p1', 2.45, 1.85, tilt=0.03)
    poster('p3', 2.93, 1.80, tilt=-0.04)
    poster('p4', 3.42, 1.9, tilt=0.02)
    poster('p2', 3.28, 1.32, tilt=0.07)
    poster('p2', 2.62, 1.22, tilt=-0.05, y=WALL_Y0 - 0.0045)
    poster('p1', -3.05, 1.8, tilt=-0.03)
    poster('p4', -2.55, 1.7, tilt=0.05)
    poster('s1', 2.0, 2.45, w=0.5, h=0.24, tilt=0.02)
    poster('s3', -3.3, 2.5, w=0.5, h=0.24, tilt=-0.02)


# ----------------------------------------------------------------------------------------------
# Tiang listrik + kabel semrawut, lampu jalan
# ----------------------------------------------------------------------------------------------
POLE = (-3.38, 2.3)
LAMP = (3.45, 2.35)


def build_pole():
    px, py = POLE
    H = 7.35
    cyl('TiangListrik', 0.135, H, (px, py, 0.15), M('pole_conc'), n=28, bevel=0.006, r2=0.085)
    for z in (0.5, 4.4, 5.2, 6.05, 6.85):
        r = 0.135 - (0.05 * (z - 0.15) / H) + 0.004
        cyl('SabukTiang', r, 0.045, (px, py, z), M('galv'), n=28, bevel=0.003)
    # lengan atas + isolator (jalur searah jalan = sumbu X)
    box('Travers', (0.07, 1.5, 0.07), (px, py, 7.05), M('galv'), bevel=0.004)
    tube('SikuTravers', [(px, py - 0.55, 7.05), (px, py, 6.55), (px, py + 0.55, 7.05)], 0.012, M('galv'))
    ins = m_plastic('Isolator', (0.33, 0.16, 0.08), 0.15, drops=0.3, dirt=0.4)
    tops = []
    for dy in (-0.68, -0.3, 0.3, 0.68):
        lathe('Isolator', [(0.012, 0), (0.03, 0.01), (0.045, 0.03), (0.02, 0.045), (0.05, 0.06), (0.022, 0.075), (0.04, 0.09), (0.02, 0.11), (0, 0.115)], ins, n=16, loc=(px, py + dy, 7.085))
        tops.append((px, py + dy, 7.19))
    for (x, y, z) in tops:
        tube('KabelTM', sag_pts((-4.0, y, z - 0.05), (x, y, z), 0.01, 4) + sag_pts((x, y, z), (4.0, y + RND.uniform(-0.03, 0.03), z - 0.12), RND.uniform(0.32, 0.42), 30)[1:], 0.006, M('cable'))
    # jalur tegangan rendah (kabel pilin tebal) + rak isolator
    box('RakTR', (0.05, 0.05, 0.5), (px + 0.1, py - 0.12, 5.9), M('galv'), bevel=0.004)
    for k in range(3):
        z = 6.1 - k * 0.16
        cyl('IsolatorTR', 0.03, 0.05, (px + 0.1, py - 0.16, z - 0.025), ins, n=14, bevel=0.006)
        tube('KabelTR', sag_pts((-4.0, py - 0.19, z - 0.03), (px + 0.1, py - 0.19, z), 0.012, 4) + sag_pts((px + 0.1, py - 0.19, z), (4.0, py - 0.19 + RND.uniform(-0.05, 0.05), z - 0.25), RND.uniform(0.45, 0.6), 30, 0.01)[1:], 0.009, M('cable'))
    # kabel telekomunikasi semrawut
    r = random.Random(21)
    for k in range(11):
        z = 4.75 + r.uniform(0, 0.55)
        y = py - 0.14 - r.uniform(0, 0.06)
        end = (4.0, py - 0.2 + r.uniform(-0.25, 0.2), z - r.uniform(-0.1, 0.5))
        pts = sag_pts((-4.0, y + r.uniform(-0.05, 0.05), z + r.uniform(-0.2, 0.1)), (px, y, z), r.uniform(0.01, 0.05), 5, rnd=r)
        pts += sag_pts((px, y, z), end, r.uniform(0.5, 1.15), 40, r.uniform(0.0, 0.04), rnd=r)[1:]
        tube('KabelTelkom%d' % k, pts, r.choice([0.004, 0.005, 0.006, 0.008]), M('cable'))
    # kabel turun ke bangunan, lampu jalan, tenda
    drops = [((px, py - 0.14, 5.05), (-1.2, WALL_Y0 - 0.02, 4.55), 0.35), ((px, py - 0.14, 4.95), (WIN[1] + 0.3, WALL_Y0 - 0.02, 5.55), 0.6),
             ((px, py - 0.14, 5.3), (2.6, WALL_Y0 - 0.02, 3.6), 0.9), ((px, py - 0.14, 5.85), (LAMP[0], LAMP[1] - 0.06, 5.2), 0.7),
             ((px, py - 0.14, 4.8), (TX0, TYF + 0.05, TZF - 0.09), 0.45), ((px + 0.1, py - 0.19, 5.78), (-3.0, WALL_Y0 - 0.02, 5.2), 0.12)]
    for a, b, sg in drops:
        tube('KabelTurun', sag_pts(a, b, sg, 28, 0.015, rnd=r), 0.005, M('cable'))
    for (x, z) in ((-1.2, 4.55), (2.6, 3.6), (-3.0, 5.2)):
        tube('KabelMasuk', [(x, WALL_Y0 - 0.02, z), (x + 0.02, WALL_Y0 - 0.03, z - 0.5), (x, WALL_Y0 - 0.02, z - 1.1)], 0.005, M('cable'), fil=0.05)
        box('KlemTembok', (0.04, 0.03, 0.04), (x, WALL_Y0 - 0.012, z), M('galv'), bevel=0.004)
    # gulungan kabel sisa + kotak sambungan
    for k, (z, rr) in enumerate(((4.55, 0.2), (4.35, 0.16), (5.45, 0.14))):
        pts = []
        for i in range(140):
            a = i * 0.27
            rad = rr + 0.02 * sin(i * 0.11 + k) + r.uniform(-0.004, 0.004)
            pts.append((px + 0.02 * sin(i * 0.07), py - 0.16 - 0.012 * (i % 7) / 7.0, z - rad + rad * cos(a)) if False else (px + rad * sin(a), py - 0.15 - 0.03 * (i / 140.0), z - rr + rad * cos(a)))
        tube('GulunganKabel%d' % k, pts, 0.006, M('cable'))
    box('KotakSambung', (0.26, 0.14, 0.36), (px, py - 0.2, 3.9), M('white_plastic'), bevel=0.012)
    box('KotakSambung2', (0.16, 0.1, 0.2), (px - 0.02, py - 0.18, 5.6), M('black_plastic'), bevel=0.01)
    for k in range(4):
        tube('KabelKotak', sag_pts((px - 0.09 + k * 0.06, py - 0.2, 4.08), (px, py - 0.15, 4.75 + k * 0.03), -0.05, 10, rnd=r), 0.004, M('cable'))
    tube('KabelTanah', [(px + 0.11, py - 0.08, 6.5), (px + 0.125, py - 0.08, 3.0), (px + 0.145, py - 0.08, 0.2)], 0.004, M('galv'))
    # stiker di tiang (melengkung ngikutin tiang)
    for key, z, a0 in (('s1', 1.55, -1.9), ('s2', 1.9, -1.2), ('s3', 1.25, -1.3), ('s1', 2.2, -2.3)):
        R = 0.135 - 0.05 * (z - 0.15) / H + 0.002
        w, h = 0.26, 0.125
        o = grid('StikerTiang', -w / 2, w / 2, -h / 2, h / 2, 12, 4, m_poster(0.26, 0.125))
        set_uv_region(o, key)
        for v in o.data.vertices:
            a = a0 + v.co.x / R
            v.co = (R * cos(a), R * sin(a), v.co.y)
        for pl in o.data.polygons:
            pass
        o.location = (px, py, z)


def build_streetlamp():
    lx, ly = LAMP
    pm = m_paint('CatLampuJalan', (0.10, 0.16, 0.13), rust=0.55, rough=0.4, drops=0.35, streak=0.9)
    cyl('TiangLampu', 0.085, 5.7, (lx, ly, 0.15), pm, n=8, bevel=0.004, r2=0.05)
    box('TapakLampu', (0.3, 0.3, 0.025), (lx, ly, 0.15), M('steel'), bevel=0.004, base=True)
    for sx in (-0.11, 0.11):
        for sy in (-0.11, 0.11):
            cyl('BautTapak', 0.012, 0.03, (lx + sx, ly + sy, 0.175), M('rust'), n=6, bevel=0.002)
    box('PintuTiang', (0.09, 0.012, 0.22), (lx, ly - 0.082, 0.75), pm, bevel=0.004)
    arm = [(lx, ly, 5.75), (lx, ly, 5.95), (lx, ly - 0.5, 6.15), (lx, ly - 1.45, 6.2)]
    tube('LenganLampu', arm, 0.03, pm, fil=0.35, res=4)
    hx, hy, hz = lx, ly - 1.72, 6.17
    loft('KepalaLampu', [rrect(0.1, 0.08, 0.03, 3, 0.0, 0, 0), rrect(0.24, 0.1, 0.04, 3, 0.2, 0, -0.01), rrect(0.26, 0.11, 0.045, 3, 0.48, 0, -0.012), rrect(0.16, 0.06, 0.025, 3, 0.62, 0, 0.0)],
         M('alu_dull'), loc=(hx, hy + 0.33, hz), rot=(pi / 2, 0, 0), sub=1)
    box('LensaLampu', (0.2, 0.34, 0.02), (hx, hy + 0.02, hz - 0.062), m_emit('EmitLampuJalan', (0.72, 0.92, 1.0), 26.0), bevel=0.006)
    sp = spot('SpotLampuJalan', (hx, hy + 0.02, hz - 0.09), (hx, hy - 0.2, 0.0), 2600, (0.72, 0.92, 1.0), 132, 0.85, 0.12)
    return sp


# ----------------------------------------------------------------------------------------------
# Motor bebek tua
# ----------------------------------------------------------------------------------------------
def ring_yz(x, zc, w, h, r, n=3):
    return [(x, p[0], zc + p[1]) for p in rrect(w, h, r, n)]


def build_motor():
    root = grp('MotorBebek', (2.95, -2.35, 0.0), (radians(-11), 0, radians(118)))
    red = m_paint('CatMotor', (0.20, 0.022, 0.02), rust=0.42, rough=0.3, wet=0.7, drops=0.55, chip_scale=5.0, fade=0.5)
    blk, chrome, alu, rub = M('black_plastic'), M('chrome'), M('alu_dull'), M('rubber')
    seatm = m_plastic('JokMotor', (0.014, 0.013, 0.012), 0.5, wet=0.8, drops=0.65, dirt=0.3)
    # --- bagian tetap
    wheel('RodaBlk', 0.29, root, (-0.6, 0, 0.29), tire=0.036, spokes=28, hub=0.055, rim_m=chrome)
    cyl('TromolBlk', 0.065, 0.09, (-0.6, 0.045, 0.29), alu, n=20, bevel=0.006, rot=(pi / 2, 0, 0), parent=root)
    tube('Rangka', [(0.36, 0, 0.8), (0.14, 0, 0.44), (-0.2, 0, 0.42), (-0.45, 0, 0.64), (-0.88, 0, 0.74)], 0.022, blk, parent=root, fil=0.08)
    loft('BodiSamping', [ring_yz(0.14, 0.50, 0.13, 0.2, 0.04), ring_yz(-0.02, 0.54, 0.2, 0.3, 0.07), ring_yz(-0.3, 0.6, 0.26, 0.26, 0.08), ring_yz(-0.6, 0.66, 0.22, 0.16, 0.06), ring_yz(-0.9, 0.72, 0.12, 0.08, 0.03)],
         red, parent=root, sub=2)
    loft('Jok', [ring_yz(0.08, 0.72, 0.16, 0.06, 0.025), ring_yz(-0.1, 0.745, 0.24, 0.08, 0.035), ring_yz(-0.45, 0.775, 0.27, 0.09, 0.04), ring_yz(-0.74, 0.79, 0.2, 0.07, 0.03)],
         seatm, parent=root, sub=2)
    # tameng kaki khas bebek
    st = [(0.35, 0.86, 0.07, 0.03), (0.37, 0.72, 0.17, 0.05), (0.36, 0.56, 0.215, 0.06), (0.31, 0.4, 0.2, 0.05), (0.24, 0.29, 0.14, 0.03)]
    rings = []
    for (xc, z, w, b) in st:
        rings.append([(xc + b * (1 - t * t) - 0.1 * abs(t) ** 3, w * t, z) for t in [i / 5.0 - 1.0 for i in range(11)]])
    loft('TamengKaki', rings, red, parent=root, closed=False, sub=2, solid=0.007)
    # mesin tidur + knalpot
    box('BlokMesin', (0.26, 0.2, 0.19), (0.0, 0, 0.36), alu, bevel=0.02, parent=root, sub=0)
    cyl('Silinder', 0.062, 0.2, (0.1, 0, 0.36), alu, n=20, bevel=0.006, rot=(0, pi / 2, 0), parent=root)
    for k in range(6):
        cyl('Sirip', 0.08, 0.006, (0.15 + k * 0.022, 0, 0.36), alu, n=20, bevel=0.001, rot=(0, pi / 2, 0), parent=root)
    for sy in (-1, 1):
        cyl('BakMesin', 0.105, 0.035, (-0.02, sy * 0.1 + (0.0 if sy > 0 else -0.035), 0.345), alu, n=24, bevel=0.012, rot=(-pi / 2, 0, 0), parent=root)
        tube('LenganAyun', [(-0.16, sy * 0.09, 0.33), (-0.6, sy * 0.1, 0.29)], 0.017, blk, parent=root)
        tube('Footstep', [(0.03, sy * 0.1, 0.27), (0.03, sy * 0.27, 0.27)], 0.012, rub, parent=root)
        # shock belakang dengan per
        a, b = Vector((-0.6, sy * 0.125, 0.33)), Vector((-0.47, sy * 0.125, 0.66))
        tube('BatangShock', [a, b], 0.011, chrome, parent=root)
        d = b - a
        u = d.cross(Vector((0, 1, 0))).normalized()
        v = d.cross(u).normalized()
        pts = [a + d * (0.12 + 0.78 * i / 120.0) + (u * cos(i * 0.52) + v * sin(i * 0.52)) * 0.022 for i in range(121)]
        tube('PerShock', pts, 0.0042, chrome, parent=root, res=1)
    tube('LeherKnalpot', [(0.2, -0.04, 0.33), (0.2, -0.1, 0.24), (-0.1, -0.15, 0.22), (-0.22, -0.16, 0.26)], 0.017, M('rust'), parent=root, fil=0.06)
    pole('Knalpot', (-0.2, -0.16, 0.255), (-0.78, -0.17, 0.37), 0.052, m_metal('KnalpotKrom', (0.8, 0.8, 0.82), 0.12, rust=0.75, dirt=0.4), n=20).parent = root
    box('TutupRantai', (0.44, 0.018, 0.085), (-0.38, 0.115, 0.32), blk, bevel=0.012, rot=(0, radians(-5), 0), parent=root)
    # spakbor belakang + lampu + plat nomor + behel
    rr = []
    for i in range(13):
        a = radians(25 + i * 12)
        rr.append([(-0.6 - rad * cos(a), y, 0.29 + rad * sin(a)) for (y, rad) in ((-0.06, 0.305), (-0.055, 0.332), (0, 0.342), (0.055, 0.332), (0.06, 0.305))])
    loft('SpakborBlk', rr, blk, parent=root, closed=False, sub=1, solid=0.004)
    box('LampuBlk', (0.05, 0.12, 0.06), (-0.92, 0, 0.71), m_plastic('MikaMerah', (0.4, 0.01, 0.01), 0.15, drops=0.4, dirt=0.3), bevel=0.012, parent=root)
    box('PlatNomor', (0.006, 0.26, 0.105), (-0.955, 0, 0.56), m_plastic('PlatHitam', (0.012, 0.012, 0.012), 0.35, drops=0.4, dirt=0.5), bevel=0.002, rot=(0, radians(-12), 0), parent=root)
    text('NomorPlat', 'B 1234 XX', 0.052, m_plastic('PlatPutih', (0.7, 0.7, 0.68), 0.4, drops=0.3, dirt=0.4), (-0.9595, 0, 0.56), (pi / 2 - radians(12), 0, -pi / 2), root, extrude=0.0003, bold=0.006)
    tube('Behel', [(-0.6, -0.11, 0.8), (-0.93, -0.11, 0.83), (-0.97, 0, 0.84), (-0.93, 0.11, 0.83), (-0.6, 0.11, 0.8)], 0.009, chrome, parent=root, fil=0.04)
    tube('Standar', [(-0.06, 0.1, 0.3), (-0.02, 0.27, 0.05)], 0.011, blk, parent=root)
    hm = lathe('Helm', [(0.0, 0.132), (0.07, 0.12), (0.118, 0.072), (0.134, 0.0), (0.13, -0.07), (0.122, -0.07), (0.126, 0.0), (0.112, 0.066), (0.066, 0.112), (0, 0.123)],
               m_plastic('HelmCat', (0.55, 0.53, 0.47), 0.2, wet=0.8, drops=0.65, dirt=0.45), n=28, loc=(-0.33, 0.01, 0.9), rot=(radians(8), radians(-12), 0.5), parent=root)
    lathe('BusaHelm', [(0.0, 0.118), (0.062, 0.108), (0.108, 0.062), (0.12, 0.0), (0.118, -0.066)], m_plastic('BusaHelm', (0.03, 0.03, 0.035), 0.9, wet=0.2, drops=0), n=28, parent=hm)
    box('PetHelm', (0.2, 0.09, 0.006), (0.0, -0.15, -0.01), blk, bevel=0.002, rot=(radians(-12), 0, 0), parent=hm)
    # --- bagian setir (ikut sumbu kemudi, dibelokkan dikit)
    tilt = grp('SumbuSetir', (0.36, 0, 0.8), (0, radians(-27), 0), root)
    fa = grp('Setir', (0, 0, 0), (0, 0, radians(22)), tilt)
    wheel('RodaDpn', 0.29, fa, (0.01, 0, -0.577), tire=0.034, spokes=28, hub=0.05, rim_m=chrome)
    for sy in (-1, 1):
        tube('GarpuAtas', [(0.03, sy * 0.08, 0.02), (0.02, sy * 0.08, -0.3)], 0.015, chrome, parent=fa)
        tube('GarpuBawah', [(0.02, sy * 0.08, -0.28), (0.01, sy * 0.08, -0.577)], 0.021, blk, parent=fa)
        tube('Spion', [(-0.02, sy * 0.2, 0.3), (-0.04, sy * 0.24, 0.44), (-0.03, sy * 0.3, 0.5)], 0.005, chrome, parent=fa, fil=0.03)
        cyl('KacaSpion', 0.05, 0.012, (-0.03, sy * 0.31, 0.5), chrome, n=16, bevel=0.004, rot=(0, pi / 2 + 0.3, 0), parent=fa)
        cyl('Grip', 0.017, 0.12, (-0.03, sy * 0.3 - (0.12 if sy > 0 else 0), 0.3), rub, n=12, bevel=0.004, rot=(-pi / 2, 0, 0), parent=fa)
        lathe('Sein', [(0, -0.03), (0.02, -0.022), (0.027, 0), (0.02, 0.022), (0, 0.03)], m_plastic('MikaOranye', (0.75, 0.25, 0.02), 0.15, drops=0.4), n=12, loc=(0.1, sy * 0.15, 0.2), rot=(0, pi / 2, 0), parent=fa)
    tube('Stang', [(-0.03, -0.3, 0.3), (-0.03, 0.3, 0.3)], 0.011, chrome, parent=fa)
    loft('Batok', [ring_yz(-0.12, 0.25, 0.2, 0.1, 0.04), ring_yz(-0.02, 0.26, 0.34, 0.17, 0.07), ring_yz(0.08, 0.25, 0.26, 0.19, 0.08), ring_yz(0.13, 0.24, 0.16, 0.15, 0.06)], red, parent=fa, sub=2)
    cyl('ReflektorLampu', 0.072, 0.02, (0.128, 0, 0.24), chrome, n=24, bevel=0.004, rot=(0, pi / 2, 0), parent=fa)
    lathe('KacaLampu', [(0, 0.022), (0.04, 0.018), (0.07, 0.004), (0.075, 0)], m_glass('KacaLampuMotor', dust=0.35, smudge=0.3, drops=0.5), n=24, loc=(0.147, 0, 0.24), rot=(0, pi / 2, 0), parent=fa, solid=0.003)
    rr = []
    for i in range(13):
        a = radians(-25 + i * 13)
        rr.append([(0.01 + rad * cos(a), y, -0.577 + rad * sin(a)) for (y, rad) in ((-0.058, 0.3), (-0.052, 0.328), (0, 0.338), (0.052, 0.328), (0.058, 0.3))])
    loft('SpakborDpn', rr, red, parent=fa, closed=False, sub=1, solid=0.004)
    return root



# ----------------------------------------------------------------------------------------------
# Simulasi. Semuanya dibake ulang oleh script ke --cache kalau belum ada:
#   kain terpal + spanduk  -> cloth Blender, hasilnya ditulis ke .pc2 (Mesh Cache)
#   uap panci              -> Mantaflow gas, hasilnya deret OpenVDB (objek Volume)
#   gerimis                -> particle system, dibake di memori tiap kali script jalan
# ----------------------------------------------------------------------------------------------
PRE_CLOTH = 50          # frame pemanasan supaya kain sudah tenang di frame 1
PRE_STEAM = 110
STEAM_P = dict(res=104, noise=True, beta=1.6, alpha=-0.05, vort=0.2, tscale=1.25, dissolve=42, dens=0.9, temp=1.6,
               vel=0.25, wind=0.35, shade=6.0)
STEAM_P.update(json.loads(os.environ.get('WARUNG_STEAM', '{}')))     # (debug) override parameter uap
IS_MODULE = bool(getattr(bpy.app, 'module', False)) or not bpy.app.binary_path
SIM_PROXIES = []


def _ctx(ob=None):
    kw = {'scene': SCN, 'view_layer': SCN.view_layers[0]}
    if ob is not None:
        kw.update({'active_object': ob, 'object': ob, 'selected_objects': [ob]})
    return bpy.context.temp_override(**kw)


def write_pc2(path, frames, nverts, start=0.0):
    with open(path + '.part', 'wb') as f:
        f.write(struct.pack('<12siiffi', b'POINTCACHE2\0', 1, nverts, start, 1.0, len(frames)))
        for fr in frames:
            f.write(struct.pack('<%df' % len(fr), *fr))
    os.replace(path + '.part', path)


def attach_cache(ob, path):
    m = ob.modifiers.new('MeshCache', 'MESH_CACHE')
    m.cache_format = 'PC2'
    m.filepath = path
    m.frame_start = 0.0
    m.time_mode = 'FRAME'
    m.play_mode = 'SCENE'
    m.interpolation = 'LINEAR'
    m.deform_mode = 'OVERWRITE'
    s = ob.modifiers.new('Sub', 'SUBSURF')
    s.levels = s.render_levels = 1


def bake_cloth():
    obs = [TARP, BANNER]
    sig = hashlib.md5(repr([(o.name, len(o.data.vertices), [round(c, 3) for v in o.data.vertices[:400] for c in v.co], SIM_PINS[o.name][:50]) for o in obs]).encode()).hexdigest()[:8]
    paths = [os.path.join(ARGS.cache, 'kain_%s_%s.pc2' % (o.name.lower(), sig)) for o in obs]
    if all(os.path.exists(p) for p in paths) and not ARGS.rebake:
        log('cache kain sudah ada, dipakai ulang')
    else:
        t = time.time()
        params = {'Terpal': dict(mass=0.22, tens=45.0, bend=3.5, shrink=-0.035, damp=2.5),
                  'Spanduk': dict(mass=0.12, tens=22.0, bend=0.35, shrink=-0.02, damp=1.5)}
        for o in obs:
            vg = o.vertex_groups.new(name='Pin')
            vg.add(SIM_PINS[o.name], 1.0, 'REPLACE')
            m = o.modifiers.new('Cloth', 'CLOTH')
            c, pr = m.settings, params[o.name]
            c.quality = 9
            c.mass = pr['mass']
            c.tension_stiffness = c.compression_stiffness = pr['tens']
            c.shear_stiffness = pr['tens'] * 0.4
            c.bending_stiffness = pr['bend']
            c.tension_damping = c.compression_damping = c.shear_damping = 6.0
            c.bending_damping = 0.6
            c.air_damping = pr['damp']
            c.shrink_min = pr['shrink']
            c.vertex_group_mass = 'Pin'
            c.pin_stiffness = 1.0
            m.collision_settings.use_collision = False
            m.collision_settings.use_self_collision = False
            m.point_cache.frame_start = -PRE_CLOTH
            m.point_cache.frame_end = F_END + 2
        wind = grp('Angin', (-6, -5, 2.5), (radians(78), 0, radians(-58)))
        turb = grp('Turbulen', (-1.2, 0.0, 2.2))
        for e in (wind, turb):          # objek kosong baru punya field setelah di-toggle
            if e.field is None:
                with _ctx(e):
                    bpy.ops.object.forcefield_toggle()
        wind.field.type = 'WIND'
        wind.field.flow = 0.6
        wind.field.noise = 1.2
        for f in range(-PRE_CLOTH, F_END + 3, 4):
            tt = f / FPS
            wind.field.strength = 0.0 if f < -PRE_CLOTH + 14 else 38.0 * (0.45 + 0.35 * sin(tt * 1.9) + 0.2 * sin(tt * 4.3 + 1.0))
            wind.keyframe_insert('field.strength', frame=f)
        turb.field.type = 'TURBULENCE'
        turb.field.strength = 5.0
        turb.field.size = 0.9
        turb.field.flow = 0.5
        rec = {o.name: [] for o in obs}
        for f in range(-PRE_CLOTH, F_END + 2):
            SCN.frame_set(f)
            if f < 0:
                continue
            dg = bpy.context.evaluated_depsgraph_get()
            for o in obs:
                me = o.evaluated_get(dg).data
                buf = [0.0] * (len(me.vertices) * 3)
                me.vertices.foreach_get('co', buf)
                rec[o.name].append(buf)
        for o, pth in zip(obs, paths):
            o.modifiers.remove(o.modifiers['Cloth'])
            write_pc2(pth, rec[o.name], len(o.data.vertices))
        bpy.data.objects.remove(wind, do_unlink=True)
        bpy.data.objects.remove(turb, do_unlink=True)
        log('kain dibake: %d frame, %.0f dtk' % (len(rec['Terpal']), time.time() - t))
    for o, pth in zip(obs, paths):
        attach_cache(o, pth)


def _fluid(ob, kind):
    m = ob.modifiers.new('Fluid', 'FLUID')
    m.fluid_type = kind
    return m


def bake_steam(gerobak):
    """Uap panci: gas Mantaflow dengan atap gerobak, papan neon, etalase dan tutup panci
    sebagai penghalang. Hasil = deret OpenVDB, dirender sebagai volume asli."""
    d = os.path.join(ARGS.cache, 'uap_%s' % hashlib.md5(repr([round(c, 3) for c in POT_TOP] + [PRE_STEAM, F_END, 'v4', sorted((k, v) for k, v in STEAM_P.items() if k != 'shade')]).encode()).hexdigest()[:8])
    n_sim = PRE_STEAM + F_END + 2
    ok = os.path.join(d, 'SELESAI')
    px, py, pz = POT_TOP
    lo = Vector((px - 0.85, py - 1.15, pz - 0.12))
    hi = Vector((px + 0.85, py + 0.75, pz + 1.9))
    if ARGS.rebake and os.path.isdir(d):
        shutil.rmtree(d)
    if not os.path.exists(ok) and IS_MODULE:
        # Mantaflow tidak bisa jalan di build modul bpy (binding Python-nya tidak terdaftar, proses
        # langsung abort). Bake dilempar ke binary Blender versi sama; hasilnya dipakai dari --cache.
        exe = ARGS.blender_bin or os.environ.get('BLENDER_BIN') or shutil.which('blender')
        if not exe:
            raise RuntimeError('Cache uap belum ada dan bake Mantaflow tidak jalan di modul bpy. Kasih binary Blender %s '
                               'lewat --blender-bin atau env BLENDER_BIN, atau jalankan sekali: blender -b -P warung_diorama.py -- '
                               '--steam-only --cache %s' % (bpy.app.version_string.split()[0], ARGS.cache))
        log('modul bpy: bake uap dijalankan lewat %s' % exe)
        subprocess.run([exe, '-b', '--factory-startup', '--python-exit-code', '1', '-P', os.path.abspath(__file__), '--',
                        '--steam-only', '--assets', ARGS.assets, '--cache', ARGS.cache, '--out', ARGS.out], check=True)
    if not os.path.exists(ok):
        t = time.time()
        if os.path.isdir(d):
            shutil.rmtree(d)
        import tempfile
        final_d, d = d, tempfile.mkdtemp(prefix='uap_bake_')     # --cache bisa di Drive: jangan nulis file sampah ke sana
        dom = box('DomainUap', tuple(hi - lo), tuple((lo + hi) / 2), None, bevel=0)
        ds = _fluid(dom, 'DOMAIN').domain_settings
        ds.domain_type = 'GAS'
        ds.resolution_max = STEAM_P['res']
        ds.use_adaptive_domain = False
        ds.use_collision_border_front = ds.use_collision_border_back = False
        ds.use_collision_border_left = ds.use_collision_border_right = False
        ds.use_collision_border_top = ds.use_collision_border_bottom = False
        ds.alpha = STEAM_P['alpha']
        ds.beta = STEAM_P['beta']
        ds.vorticity = STEAM_P['vort']
        ds.time_scale = STEAM_P['tscale']
        ds.use_dissolve_smoke = True
        ds.dissolve_speed = STEAM_P['dissolve']
        ds.use_dissolve_smoke_log = True
        ds.cfl_condition = 3.0
        ds.use_noise = STEAM_P['noise']
        ds.noise_scale = 2
        ds.noise_strength = 0.7
        ds.noise_pos_scale = 2.5
        ds.cache_type = 'ALL'
        ds.cache_data_format = 'OPENVDB'
        ds.cache_noise_format = 'OPENVDB'
        ds.openvdb_cache_compress_type = 'BLOSC'
        ds.cache_directory = d
        ds.cache_frame_start = 1
        ds.cache_frame_end = n_sim
        src = cyl('SumberUap', 0.085, 0.02, (px - 0.055, py - 0.035, pz + 0.01), None, n=16, bevel=0)
        fs = _fluid(src, 'FLOW').flow_settings
        fs.flow_type = 'SMOKE'
        fs.flow_behavior = 'INFLOW'
        fs.density = STEAM_P['dens']
        fs.temperature = STEAM_P['temp']
        fs.surface_distance = 0.6
        fs.use_initial_velocity = True
        fs.velocity_normal = STEAM_P['vel']
        fs.subframes = 1
        prox = [box('PxAtap', (1.98, 1.04, 0.07), (0, -0.03, 1.87), None, bevel=0, parent=gerobak),
                box('PxNeon', (1.4, 0.06, 0.5), (0, -0.47, 2.17), None, bevel=0, parent=gerobak),
                box('PxEtalase', (0.97, 0.67, 0.68), (-0.36, -0.02, 1.29), None, bevel=0, parent=gerobak),
                box('PxMeja', (1.8, 0.82, 0.06), (0, -0.01, 0.93), None, bevel=0, parent=gerobak),
                cyl('PxTutup', 0.185, 0.03, (0.52 + 0.075, -0.03 + 0.03, 1.058 + 0.32), None, n=16, bevel=0, parent=gerobak, rot=(radians(-9), radians(13), 0))]
        for o in prox:
            es = _fluid(o, 'EFFECTOR').effector_settings
            es.effector_type = 'COLLISION'
            es.surface_distance = 0.2
        wnd = grp('AnginUap', (px, py + 2.0, pz + 0.3), (radians(72), 0, radians(-25)))    # dorong pelan ke depan-kanan
        with _ctx(wnd):
            bpy.ops.object.forcefield_toggle()
        wnd.field.type = 'WIND'
        wnd.field.strength = STEAM_P['wind']
        wnd.field.flow = 0.0
        wnd.field.noise = 0.3
        prox.append(wnd)
        bpy.context.view_layer.update()
        SCN.frame_start, SCN.frame_end = 1, n_sim
        SCN.frame_set(1)
        with _ctx(dom):
            bpy.ops.fluid.bake_all()
        SCN.frame_start, SCN.frame_end = F_START, F_END
        for o in prox + [src, dom]:
            bpy.data.objects.remove(o, do_unlink=True)
        sub = 'noise' if STEAM_P['noise'] else 'data'
        nfiles = len([f for f in os.listdir(os.path.join(d, sub)) if f.endswith('.vdb')]) if os.path.isdir(os.path.join(d, sub)) else 0
        if nfiles < n_sim - 1:
            raise RuntimeError('bake uap gagal: cuma %d file VDB dari %d' % (nfiles, n_sim))
        os.makedirs(os.path.join(final_d, sub))
        for f in sorted(os.listdir(os.path.join(d, sub))):
            if f.endswith('.vdb'):
                shutil.copy(os.path.join(d, sub, f), os.path.join(final_d, sub, f))
        shutil.rmtree(d, ignore_errors=True)
        d = final_d
        open(ok, 'w').write('ok')
        log('uap dibake: %d frame, %.0f dtk' % (n_sim, time.time() - t))
    else:
        log('cache uap sudah ada, dipakai ulang')
    sub = 'noise' if STEAM_P['noise'] else 'data'
    files = sorted(f for f in os.listdir(os.path.join(d, sub)) if f.endswith('.vdb'))
    vol = bpy.data.volumes.new('Uap')
    vol.filepath = os.path.join(d, sub, files[0])
    vol.is_sequence = True
    vol.frame_duration = len(files)
    vol.frame_start = 1 - PRE_STEAM
    vol.frame_offset = 0
    vol.sequence_mode = 'CLIP'
    ob = link(bpy.data.objects.new('Uap', vol))
    ob.location = lo            # grid VDB Mantaflow berawal di sudut minimum domain
    nb = NB('UapPanci')
    ai = nb.node('ShaderNodeAttribute', attribute_name='density_noise' if STEAM_P['noise'] else 'density')
    dens = nb.math('MULTIPLY', ai.outputs['Fac'], STEAM_P['shade'])
    vs = nb.node('ShaderNodeVolumeScatter')
    vs.inputs['Color'].default_value = (0.93, 0.94, 0.95, 1.0)
    vs.inputs['Anisotropy'].default_value = 0.45
    nb.set(vs.inputs['Density'], dens)
    nb.nt.links.new(vs.outputs[0], nb.out.inputs['Volume'])
    vol.materials.append(nb.mat)
    ob.visible_shadow = False
    return ob, (lo, hi)


def build_rain():
    """Gerimis tipis: partikel jatuh kecepatan tetap, mati kalau kena tanah, terpal, atap
    gerobak atau bangunan. Tiap butir = bola air kecil; garisnya datang dari motion blur."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
    for v in bm.verts:
        v.co = (v.co.x * 0.0035, v.co.y * 0.0035, v.co.z * 0.008)
    nb = NB('ButirHujan')
    b = nb.principled(**{'Base Color': (1, 1, 1), 'Roughness': 0.0, 'IOR': 1.33, 'Transmission Weight': 1.0})
    tb = nb.node('ShaderNodeBsdfTranslucent')       # hamburan maju butir air, biar kena cahaya langsung
    tb.inputs[0].default_value = (1, 1, 1, 1)
    ms = nb.node('ShaderNodeMixShader')
    ms.inputs[0].default_value = 0.35
    nb.nt.links.new(b.outputs[0], ms.inputs[1])
    nb.nt.links.new(tb.outputs[0], ms.inputs[2])
    drop = mk('ButirHujan', bm, nb.finish(ms.outputs[0]), loc=(0, 0, -40))
    drop.visible_shadow = False
    em = grid('PemancarHujan', -4.3, 3.9, -4.1, 3.9, 1, 1, None, z=9.6)     # hujan cuma di atas alas diorama
    em.show_instancer_for_render = False     # emitter tidak dirender, butirnya iya
    md = em.modifiers.new('Hujan', 'PARTICLE_SYSTEM')
    ps = md.particle_system
    st = ps.settings
    fall = 6.0
    life = int(9.8 / fall * FPS) + 4
    st.count = 11000
    st.frame_start = -life - 4
    st.frame_end = F_END + 2
    st.lifetime = life
    st.emit_from = 'FACE'
    st.distribution = 'RAND'
    st.use_emit_random = True
    st.normal_factor = 0.0
    st.factor_random = 0.25
    st.object_align_factor = (0.22, 0.06, -fall)
    st.physics_type = 'NEWTON'
    st.effector_weights.gravity = 0.0
    st.drag_factor = 0.0
    st.use_die_on_collision = True
    st.render_type = 'OBJECT'
    st.instance_object = drop
    st.particle_size = 1.0
    st.size_random = 0.45
    st.use_rotation_instance = False
    st.use_rotations = False
    ps.seed = ARGS.seed
    ps.point_cache.frame_start = int(st.frame_start)
    ps.point_cache.frame_end = F_END + 2
    # penghalang (tak dirender): tanah, terpal, atap gerobak, bangunan
    prox = [box2('PxTanah', (-6, -6, -0.2), (6, 6, 0.0), None, bevel=0),
            box2('PxTrotoar', (-4, 1.4, 0.0), (4, 3.1, 0.15), None, bevel=0),
            box2('PxBangunan', (-4, WALL_Y0 - 0.1, 0.0), (4, 4.0, 6.5), None, bevel=0),
            box('PxAtapGerobak', (1.98, 1.04, 0.08), (G_LOC[0], G_LOC[1] - 0.03, 1.87), None, bevel=0, rot=(0, 0, radians(-5))),
            box('PxMotor', (1.9, 0.5, 0.9), (2.95, -2.35, 0.45), None, bevel=0, rot=(0, 0, radians(118)))]
    tp = grid('PxTerpal', TX0 - 0.3, TX1 + 0.3, TYF - 0.32, TYB + 0.26, 1, 1, None, zf=lambda x, y: tent_z(y) + 0.06)
    prox.append(tp)
    for o in prox:
        o.hide_render = True
        o.display_type = 'WIRE'
        o.modifiers.new('Col', 'COLLISION')
        o.collision.use_particle_kill = True
    SIM_PROXIES.extend(prox)
    # tetesan air dari tepi depan dan samping terpal (jatuh dipercepat gravitasi)
    zt = tent_z(TYF) - 0.2
    bm = bmesh.new()
    for (a, b) in (((TX0 - 0.3, TYF - 0.33), (TX1 + 0.3, TYF - 0.33)), ((TX0 - 0.31, TYF - 0.3), (TX0 - 0.31, TYB)), ((TX1 + 0.31, TYF - 0.3), (TX1 + 0.31, TYB))):
        d = Vector((b[0] - a[0], b[1] - a[1], 0)).normalized() * 0.0
        vs = [bm.verts.new((a[0], a[1], zt + (0 if a[1] < TYF else tent_z(a[1]) - tent_z(TYF)))), bm.verts.new((b[0], b[1], zt + (0 if b[1] <= TYF else tent_z(b[1]) - tent_z(TYF)))),
              bm.verts.new((b[0], b[1], zt + 0.02 + (0 if b[1] <= TYF else tent_z(b[1]) - tent_z(TYF)))), bm.verts.new((a[0], a[1], zt + 0.02 + (0 if a[1] < TYF else tent_z(a[1]) - tent_z(TYF))))]
        bm.faces.new(vs)
    dr = mk('PemancarTetes', bm, None, smooth=False)
    dr.show_instancer_for_render = False
    ps2 = dr.modifiers.new('Tetes', 'PARTICLE_SYSTEM').particle_system
    s2 = ps2.settings
    s2.count = 520
    s2.frame_start = -30
    s2.frame_end = F_END + 2
    s2.lifetime = 30
    s2.emit_from = 'FACE'
    s2.distribution = 'RAND'
    s2.use_emit_random = True
    s2.normal_factor = 0.0
    s2.physics_type = 'NEWTON'
    s2.effector_weights.gravity = 1.0
    s2.use_die_on_collision = True
    s2.render_type = 'OBJECT'
    s2.instance_object = drop
    s2.particle_size = 1.5
    s2.size_random = 0.4
    s2.use_rotations = False
    ps2.seed = ARGS.seed + 11
    ps2.point_cache.frame_start = -30
    ps2.point_cache.frame_end = F_END + 2
    t = time.time()
    SCN.frame_start, SCN.frame_end = int(st.frame_start), F_END + 2     # bake ikut frame pemanasan
    with _ctx(em):
        bpy.ops.ptcache.bake_all(bake=True)
    SCN.frame_start, SCN.frame_end = F_START, F_END
    log('gerimis dibake di memori: %.0f dtk' % (time.time() - t))
    return em


def animate_neon():
    """Neon kedip dikit: redup acak kecil + satu kali gagap sekitar frame 70-an."""
    r = random.Random(ARGS.seed + 3)
    base = NEON_NODES[0].inputs[1].default_value
    for e in NEON_NODES:
        for f in range(F_START - 1, F_END + 2):
            v = 1.0 - 0.07 * r.random()
            if r.random() < 0.05:
                v *= r.uniform(0.6, 0.85)
            if f in (71, 72, 75):
                v *= 0.22
            if f in (73, 74, 76):
                v *= 0.75
            e.inputs[1].default_value = base * v
            e.inputs[1].keyframe_insert('default_value', frame=f)
        e.inputs[1].default_value = base
    for nt in set(e.id_data for e in NEON_NODES):
        for fc in _fcurves(nt):
            for kp in fc.keyframe_points:
                kp.interpolation = 'LINEAR'


def setup_compositor():
    """Bloom lensa tipis di atas hasil denoise (halo utama tetap dari kabut volumetrik)."""
    SCN.use_nodes = True
    nt = SCN.node_tree
    nt.nodes.clear()
    rl = nt.nodes.new('CompositorNodeRLayers')
    gl = nt.nodes.new('CompositorNodeGlare')
    co = nt.nodes.new('CompositorNodeComposite')
    try:
        gl.glare_type = 'BLOOM'
    except Exception:
        gl.glare_type = 'FOG_GLOW'
    for name, val in (('Threshold', 1.2), ('Smoothness', 0.3), ('Strength', 0.22), ('Saturation', 1.0), ('Size', 0.45), ('Maximum', 60.0)):
        if name in gl.inputs and gl.inputs[name].type == 'VALUE':
            try:
                gl.inputs[name].default_value = val
            except Exception:
                pass
    for prop, val in (('threshold', 1.2), ('mix', -0.75), ('size', 7), ('quality', 'HIGH')):
        try:
            setattr(gl, prop, val)
        except Exception:
            pass
    nt.links.new(rl.outputs['Image'], gl.inputs['Image'])
    nt.links.new(gl.outputs['Image'], co.inputs['Image'])
    SCN.render.use_compositing = True


def fit_camera():
    """Cari jarak kamera terkecil yang masih memuat seluruh diorama di semua sudut orbit,
    lalu tengahkan arah vertikal."""
    global CAM_D, CAM_T
    el = radians(ARGS.cam_el if ARGS.cam_el is not None else CAM_EL)
    pts = [Vector((x, y, z)) for x in (-4.16, 4.16) for y in (-4.16, 4.16) for z in (-1.13,)]
    pts += [Vector((x, y, 6.5)) for x in (-4, 4) for y in (3.0, 4.0)] + [Vector((POLE[0], POLE[1], 7.6)), Vector((-4, POLE[1], 7.3)), Vector((4, POLE[1], 7.2))]
    ar = ARGS.w / ARGS.h
    hx, hy = (18.0 * ar, 18.0) if ar < 1 else (18.0, 18.0 / ar)

    def ext(D, T):
        mx, lo, hi = 0.0, 9.0, -9.0
        for k in range(9):
            az = radians(-ORBIT / 2 + ORBIT * k / 8)
            R = Matrix.Rotation(az, 3, 'Z')
            cam = T + R @ Vector((0, -D * cos(el), D * sin(el)))
            fwd = (T - cam).normalized()
            right = fwd.cross(Vector((0, 0, 1))).normalized()
            up = right.cross(fwd)
            for p in pts:
                d = p - cam
                z = d.dot(fwd)
                nx, ny = d.dot(right) / z * 85.0 / hx, d.dot(up) / z * 85.0 / hy
                mx, lo, hi = max(mx, abs(nx)), min(lo, ny), max(hi, ny)
        return mx, lo, hi
    D, T = 60.0, CAM_T.copy()
    for _ in range(3):
        D = 60.0
        while D > 30 and ext(D - 0.5, T)[0] < 0.955:
            D -= 0.5
        mx, lo, hi = ext(D, T)
        T.z += (lo + hi) / 2 * (hy / 85.0) * D / cos(el)
    CAM_D, CAM_T = D, T
    log('kamera: jarak %.1f m, target z %.2f, lebar terpakai %.0f%%' % (D, T.z, mx * 100))


# ====== MAIN ======
def main():
    global SCN, COL
    log('Blender %s | argumen: %s' % (bpy.app.version_string, vars(ARGS)))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    SCN = bpy.context.scene
    COL = SCN.collection
    ensure_assets()
    setup_render()
    if ARGS.steam_only:
        g = build_gerobak()
        bpy.context.view_layer.update()
        bake_steam(g)
        return
    make_atlas()
    build_base()
    build_building()
    gerobak = build_gerobak()
    build_tent()
    tbl = build_table()
    build_ph_props(tbl)
    build_posters()
    build_pole()
    build_streetlamp()
    build_motor()
    build_backdrop()
    build_fog()
    build_rim()
    fit_camera()
    build_camera()
    animate_neon()
    if not ARGS.no_bloom:
        setup_compositor()
    bpy.context.view_layer.update()
    if not ARGS.skip_sim:
        bake_cloth()
        bake_steam(gerobak)
        build_rain()
    SCN.frame_set(F_START)
    log('scene jadi: %d objek' % len(SCN.objects))
    if ARGS.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(ARGS.save_blend))
    if ARGS.no_render:
        return
    render_frames()


if __name__ == '__main__':
    main()
