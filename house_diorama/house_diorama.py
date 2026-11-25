#!/usr/bin/env python3
"""
house_diorama.py
Photoreal isometric diorama of a modern single-storey house on an autumn
afternoon. Pure bpy (headless), Cycles CPU.

    python3 house_diorama.py --still 60              # one frame, final settings
    python3 house_diorama.py --anim                  # frames 1-120, resumable
    python3 house_diorama.py --encode                # PNG sequence -> MP4

Geometry is generated procedurally (numpy + bmesh). Surface textures are CC0
PBR scans from Poly Haven, downloaded on first run into ./assets.
"""
import argparse
import json
import math
import os
import ssl
import subprocess
import sys
import time
import urllib.request
import warnings

import numpy as np

warnings.simplefilter("ignore")
import bpy  # noqa: E402
import bmesh  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(ROOT, "assets")
FRAMES = os.path.join(ROOT, "frames")
OUT = os.path.join(ROOT, "output")

T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:7.1f}s]", *a, flush=True)


# ----------------------------------------------------------------------------
# Scene constants (metres, Z up). The camera looks at the (-x,-y) corner.
# ----------------------------------------------------------------------------
SITE = 6.0                     # half size of the 12 x 12 m plot
BASE_T = 0.5                   # plot thickness
FLOOR_Z = 0.45                 # finished floor / deck level
X0, X1, Y0, Y1 = -1.6, 5.4, -1.6, 5.4      # house outline (7 x 7 m)
NX, NY = 0.9, 0.9              # notch (2.5 x 2.5 m) at the front corner
CEIL_Z = 2.80
ROOF_Z = 2.98
NCOURSE = 37
PAR_Z = 0.45 + NCOURSE * 0.075  # parapet top = 3.225 (37 brick courses above the floor)
WALL_T = 0.30
BRICK_L, BRICK_H, BRICK_D, JOINT = 0.215, 0.065, 0.1025, 0.010
MOD = BRICK_L + JOINT          # 0.225
COURSE = BRICK_H + JOINT       # 0.075

FPS = 24
FRAME_START, FRAME_END = 1, 120
ORBIT_DEG = 40.0
CAM_AZ_MID = 225.0             # camera sits at azimuth 225 deg -> faces the front corner
CAM_EL = 35.0
CAM_TARGET = (0.0, 0.0, 1.15)
ORTHO_SCALE = 36.5

SUN_AZ = 303.0                 # direction *to* the sun, deg CCW from +x  (screen right)
SUN_EL = 22.0

# ----------------------------------------------------------------------------
# Poly Haven assets (CC0)
# ----------------------------------------------------------------------------
TEXTURES = [
    "painted_plaster_wall", "white_stucco", "concrete_wall_008",
    "concrete_floor_worn_001", "wood_textured_concrete", "concrete_wall_006",
    "walnut_veneer", "teak_veneer", "oak_veneer_01", "oak_wood_planks",
    "sakura_bark", "lichen_rock", "rock_boulder_dry", "forrest_ground_01",
    "farm_soil", "gravel_floor_02", "clean_pebbles", "poly_wool_herringbone",
    "rough_linen", "hessian_230",
]
TEX_MAPS = {"Diffuse": "jpg", "Rough": "jpg", "nor_gl": "png", "Displacement": "png"}
TEX_RES = "2k"


def _fetch(url, dst):
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "house-diorama/1.0"})
    tmp = dst + ".part"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180, context=ctx) as r, open(tmp, "wb") as f:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    f.write(b)
            os.replace(tmp, dst)
            return
        except Exception as e:  # noqa: BLE001
            log(f"  download failed ({e}); retry {attempt + 1}")
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f"cannot download {url}")


def ensure_assets():
    """Download the CC0 texture set from Poly Haven if it is not on disk yet."""
    os.makedirs(ASSETS, exist_ok=True)
    for tid in TEXTURES:
        d = os.path.join(ASSETS, tid)
        os.makedirs(d, exist_ok=True)
        need = [m for m, ext in TEX_MAPS.items()
                if not os.path.exists(os.path.join(d, f"{m}.{ext}"))]
        if not need:
            continue
        meta = os.path.join(d, "files.json")
        if not os.path.exists(meta):
            _fetch(f"https://api.polyhaven.com/files/{tid}", meta)
        files = json.load(open(meta))
        for m in need:
            ext = TEX_MAPS[m]
            try:
                url = files[m][TEX_RES][ext]["url"]
            except KeyError:
                alt = "png" if ext == "jpg" else "jpg"
                url = files[m][TEX_RES][alt]["url"]
            log(f"download {tid}/{m}")
            _fetch(url, os.path.join(d, f"{m}.{ext}"))


def tex_file(tid, m):
    return os.path.join(ASSETS, tid, f"{m}.{TEX_MAPS[m]}")


# ----------------------------------------------------------------------------
# numpy noise
# ----------------------------------------------------------------------------
def _h3(ix, iy, iz, seed):
    n = (ix.astype(np.uint32) * np.uint32(73856093)) ^ (iy.astype(np.uint32) * np.uint32(19349663)) \
        ^ (iz.astype(np.uint32) * np.uint32(83492791)) ^ np.uint32((seed * 2654435761) & 0xFFFFFFFF)
    n = (n ^ (n >> np.uint32(13))) * np.uint32(1274126177)
    n = n ^ (n >> np.uint32(16))
    return n.astype(np.float64) / 4294967295.0


def vnoise(p, seed=0):
    """Value noise in [0,1]; p is (...,3) or (...,2)."""
    p = np.asarray(p, dtype=np.float64)
    if p.shape[-1] == 2:
        p = np.concatenate([p, np.zeros(p.shape[:-1] + (1,))], axis=-1)
    i = np.floor(p).astype(np.int64)
    f = p - i
    u = f * f * f * (f * (f * 6 - 15) + 10)
    x, y, z = i[..., 0], i[..., 1], i[..., 2]
    ux, uy, uz = u[..., 0], u[..., 1], u[..., 2]

    def lerp(a, b, t):
        return a + (b - a) * t
    c00 = lerp(_h3(x, y, z, seed), _h3(x + 1, y, z, seed), ux)
    c10 = lerp(_h3(x, y + 1, z, seed), _h3(x + 1, y + 1, z, seed), ux)
    c01 = lerp(_h3(x, y, z + 1, seed), _h3(x + 1, y, z + 1, seed), ux)
    c11 = lerp(_h3(x, y + 1, z + 1, seed), _h3(x + 1, y + 1, z + 1, seed), ux)
    return lerp(lerp(c00, c10, uy), lerp(c01, c11, uy), uz)


def fbm(p, octaves=4, lac=2.0, gain=0.5, seed=0):
    p = np.asarray(p, dtype=np.float64)
    a, s, tot, f = 1.0, 0.0, 0.0, 1.0
    for o in range(octaves):
        s = s + a * vnoise(p * f, seed + o * 17)
        tot += a
        a *= gain
        f *= lac
    return s / tot


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0 + 1e-12), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-12)


# ----------------------------------------------------------------------------
# Mesh helpers
# ----------------------------------------------------------------------------
COLL = {}


def collection(name):
    if name not in COLL:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
        COLL[name] = c
    return COLL[name]


def link(obj, coll="Scene"):
    collection(coll).objects.link(obj)
    return obj


def mesh_obj(name, verts, tris=None, quads=None, mat=None, smooth=False, coll="Scene",
             attrs=None, uv=None, loop_uv=None, normals=None, do_link=True):
    """Build a mesh object from numpy arrays. tris (T,3) / quads (Q,4) are index arrays.
    attrs: {name: per-vertex array (N,) or (N,3)}; uv: per-vertex (N,2);
    loop_uv: per-corner (L,2) in the order tris-then-quads; normals: per-vertex custom normals."""
    verts = np.ascontiguousarray(verts, dtype=np.float32).reshape(-1, 3)
    tris = np.zeros((0, 3), np.int32) if tris is None else np.asarray(tris, np.int32).reshape(-1, 3)
    quads = np.zeros((0, 4), np.int32) if quads is None else np.asarray(quads, np.int32).reshape(-1, 4)
    nt, nq = len(tris), len(quads)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts))
    me.vertices.foreach_set("co", verts.ravel())
    loops = np.concatenate([tris.ravel(), quads.ravel()]).astype(np.int32)
    me.loops.add(len(loops))
    me.loops.foreach_set("vertex_index", loops)
    totals = np.concatenate([np.full(nt, 3, np.int32), np.full(nq, 4, np.int32)])
    starts = np.concatenate([[0], np.cumsum(totals)[:-1]]).astype(np.int32) if len(totals) else totals
    me.polygons.add(nt + nq)
    me.polygons.foreach_set("loop_start", starts)
    me.polygons.foreach_set("loop_total", totals)
    me.update(calc_edges=True)
    if smooth or normals is not None:
        me.shade_smooth()
    if attrs:
        for k, v in attrs.items():
            v = np.asarray(v, dtype=np.float32)
            if v.ndim == 1:
                a = me.attributes.new(k, "FLOAT", "POINT")
                a.data.foreach_set("value", v)
            else:
                a = me.attributes.new(k, "FLOAT_VECTOR", "POINT")
                a.data.foreach_set("vector", v.ravel())
    if uv is not None:
        uv = np.asarray(uv, dtype=np.float32)
        layer = me.uv_layers.new(name="UVMap")
        layer.data.foreach_set("uv", uv[loops].ravel())
    if loop_uv is not None:
        layer = me.uv_layers.new(name="UVMap")
        layer.data.foreach_set("uv", np.asarray(loop_uv, np.float32).ravel())
    if normals is not None:
        me.normals_split_custom_set_from_vertices(np.asarray(normals, np.float32).reshape(-1, 3))
    if mat is not None:
        me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    if do_link:
        link(ob, coll)
    return ob


_RBOX = {}


def _rbox_template(segments=2):
    """Bevelled unit cube, stored so any box size can be built with a constant bevel radius."""
    if segments in _RBOX:
        return _RBOX[segments]
    W = 0.25
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=W, offset_type="OFFSET", segments=segments,
                    profile=0.5, affect="EDGES", clamp_overlap=False)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bm.verts.ensure_lookup_table()
    v = np.array([vv.co[:] for vv in bm.verts], dtype=np.float64)
    s = np.sign(v)
    o = (v - s * (1 - W)) / W
    tris = np.array([[vv.index for vv in f.verts] for f in bm.faces if len(f.verts) == 3], np.int32).reshape(-1, 3)
    quads = np.array([[vv.index for vv in f.verts] for f in bm.faces if len(f.verts) == 4], np.int32).reshape(-1, 4)
    # dominant axis per face (for box UVs), in the order tris then quads
    fn = [np.array(f.normal[:]) for f in bm.faces if len(f.verts) == 3] + \
         [np.array(f.normal[:]) for f in bm.faces if len(f.verts) == 4]
    dom = np.array([int(np.argmax(np.abs(n))) for n in fn], np.int32)
    bm.free()
    nrm = unit(o)
    _RBOX[segments] = (s, o, nrm, tris, quads, dom)
    return _RBOX[segments]


def rounded_boxes(name, centers, half, r=0.004, rot=None, mat=None, segments=2, rnd=None,
                  uv_grain=None, coll="Scene", seed=0, extra_attrs=None):
    """Many bevelled boxes merged into one mesh.
    centers (N,3), half (N,3) half extents, r bevel radius (scalar or (N,)),
    rot (N,3,3) optional rotation matrices, rnd (N,) per-box random stored as attribute 'rnd'.
    uv_grain: None or axis index (0/1/2) of the grain direction -> box-projected UVs in metres
    with U along the grain and a random offset per box."""
    s, o, nrm, tris, quads, dom = _rbox_template(segments)
    centers = np.asarray(centers, np.float64).reshape(-1, 3)
    half = np.broadcast_to(np.asarray(half, np.float64), centers.shape)
    N, K = len(centers), len(s)
    rr = np.broadcast_to(np.asarray(r, np.float64), (N,))[:, None, None]
    rr = np.minimum(rr, half.min(axis=1)[:, None, None] * 0.95)
    local = s[None] * (half[:, None, :] - rr) + o[None] * rr            # (N,K,3)
    nl = np.broadcast_to(nrm[None], (N, K, 3))
    if rot is not None:
        rot = np.asarray(rot, np.float64)
        world = np.einsum("nij,nkj->nki", rot, local)
        nw = np.einsum("nij,nkj->nki", rot, nl)
    else:
        world, nw = local, nl
    world = world + centers[:, None, :]
    off = (np.arange(N) * K)[:, None, None]
    T = (tris[None] + off).reshape(-1, 3)
    Q = (quads[None] + off).reshape(-1, 4)
    rng = np.random.default_rng(seed + 991)
    if rnd is None:
        rnd = rng.random(N)
    attrs = {"rnd": np.repeat(rnd, K)}
    if extra_attrs:
        for k, v in extra_attrs.items():
            attrs[k] = np.repeat(np.asarray(v), K, axis=0)
    loop_uv = None
    if uv_grain is not None:
        g = uv_grain
        others = [a for a in range(3) if a != g]

        def face_uv(idx, d):                    # idx (F,k) template indices, d (F,) dominant axis
            p = local[:, idx, :]                # (N,F,k,3)
            u = np.where((d == g)[None, :, None], p[..., others[0]], p[..., g])
            vax = np.where(d == g, others[1], np.where(d == others[0], others[1], others[0]))
            v = np.take_along_axis(p, np.broadcast_to(vax[None, :, None, None], p.shape[:3] + (1,)), axis=3)[..., 0]
            return np.stack([u, v], axis=-1)    # (N,F,k,2)
        uo = rng.random((N, 1, 1, 2)) * np.array([7.0, 3.0])
        uv_t = face_uv(tris, dom[:len(tris)]) + uo
        uv_q = face_uv(quads, dom[len(tris):]) + uo
        # loop order in mesh_obj is all tris of all boxes, then all quads of all boxes
        loop_uv = np.concatenate([uv_t.reshape(-1, 2), uv_q.reshape(-1, 2)])
    return mesh_obj(name, world.reshape(-1, 3), T, Q, mat=mat, attrs=attrs, loop_uv=loop_uv,
                    normals=nw.reshape(-1, 3), coll=coll)


def box(name, lo, hi, mat=None, r=0.004, coll="Scene", segments=2, uv_grain=None, seed=0):
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    return rounded_boxes(name, [(lo + hi) / 2], [(hi - lo) / 2], r=r, mat=mat, coll=coll,
                         segments=segments, uv_grain=uv_grain, seed=seed)


def boxes(name, lohi, mat=None, r=0.004, coll="Scene", segments=2, uv_grain=None, seed=0, rnd=None):
    a = np.asarray(lohi, float).reshape(-1, 2, 3)
    return rounded_boxes(name, (a[:, 0] + a[:, 1]) / 2, (a[:, 1] - a[:, 0]) / 2, r=r, mat=mat, coll=coll,
                         segments=segments, uv_grain=uv_grain, seed=seed, rnd=rnd)


def rot_z(a):
    c, s = np.cos(a), np.sin(a)
    z, o = np.zeros_like(c), np.ones_like(c)
    return np.stack([np.stack([c, -s, z], -1), np.stack([s, c, z], -1), np.stack([z, z, o], -1)], -2)


# ----------------------------------------------------------------------------
# Shader helpers
# ----------------------------------------------------------------------------
class M:
    """Thin wrapper around a material node tree so graphs can be written as expressions."""

    def __init__(self, name):
        self.mat = bpy.data.materials.new(name)
        self.mat.use_nodes = True
        self.nt = self.mat.node_tree
        self.nt.nodes.clear()
        self.out = self.nt.nodes.new("ShaderNodeOutputMaterial")
        self._geo = self._tc = self._oi = None

    # -- generic -----------------------------------------------------------
    def n(self, kind, _in=None, **props):
        nd = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(nd, k, v)
        for k, v in (_in or {}).items():
            self.n_set(nd.inputs[k], v)
        return nd

    def link(self, a, b):
        self.nt.links.new(a, b)

    # -- inputs ------------------------------------------------------------
    @property
    def geo(self):
        self._geo = self._geo or self.nt.nodes.new("ShaderNodeNewGeometry")
        return self._geo

    @property
    def tc(self):
        self._tc = self._tc or self.nt.nodes.new("ShaderNodeTexCoord")
        return self._tc

    @property
    def oi(self):
        self._oi = self._oi or self.nt.nodes.new("ShaderNodeObjectInfo")
        return self._oi

    @property
    def P(self):
        return self.geo.outputs["Position"]

    def attr(self, name, out="Factor"):
        return self.n("ShaderNodeAttribute", attribute_name=name).outputs[out]

    # -- math --------------------------------------------------------------
    def math(self, op, a, b=None, c=None, clamp=False):
        return self.n("ShaderNodeMath", {0: a, 1: b, 2: c}, operation=op, use_clamp=clamp).outputs[0]

    def mul(self, a, b): return self.math("MULTIPLY", a, b)
    def add(self, a, b): return self.math("ADD", a, b)
    def sub(self, a, b): return self.math("SUBTRACT", a, b)
    def sat(self, a): return self.n("ShaderNodeClamp", {"Value": a}).outputs[0]

    def vmath(self, op, a, b=None, scale=None):
        nd = self.n("ShaderNodeVectorMath", {0: a, 1: b}, operation=op)
        if scale is not None:
            self.n_set(nd.inputs["Scale"], scale)
        return nd.outputs["Value"] if op in ("DOT_PRODUCT", "LENGTH", "DISTANCE") else nd.outputs[0]

    def n_set(self, sock, v):
        if v is None:
            return
        if isinstance(v, bpy.types.NodeSocket):
            self.nt.links.new(v, sock)
            return
        try:
            k = len(sock.default_value)
        except TypeError:
            sock.default_value = v
            return
        v = (v,) * 3 if np.isscalar(v) else tuple(v)
        if k == 4 and len(v) == 3:
            v = v + (1.0,)
        sock.default_value = v[:k]

    def xyz(self, v):
        return self.n("ShaderNodeSeparateXYZ", {0: v}).outputs

    def combine(self, x=0.0, y=0.0, z=0.0):
        return self.n("ShaderNodeCombineXYZ", {0: x, 1: y, 2: z}).outputs[0]

    def maprange(self, v, a, b, c=0.0, d=1.0, smooth=False):
        return self.n("ShaderNodeMapRange", {0: v, 1: a, 2: b, 3: c, 4: d},
                      interpolation_type="SMOOTHSTEP" if smooth else "LINEAR", clamp=True).outputs[0]

    def mix(self, fac, a, b, blend="MIX", clamp=True):
        nd = self.n("ShaderNodeMix", {0: fac, 6: a, 7: b}, data_type="RGBA", blend_type=blend,
                    clamp_result=clamp, clamp_factor=True)
        return nd.outputs[2]

    def mixf(self, fac, a, b):
        return self.n("ShaderNodeMix", {0: fac, 2: a, 3: b}, data_type="FLOAT").outputs[0]

    def ramp(self, fac, stops, interp="LINEAR"):
        nd = self.n("ShaderNodeValToRGB", {0: fac})
        cr = nd.color_ramp
        cr.interpolation = interp
        while len(cr.elements) < len(stops):
            cr.elements.new(0.5)
        for e, (pos, col) in zip(cr.elements, stops):
            e.position = pos
            e.color = col if len(col) == 4 else (*col, 1.0)
        return nd.outputs[0]

    def hsv(self, col, h=0.5, s=1.0, v=1.0):
        return self.n("ShaderNodeHueSaturation", {"Hue": h, "Saturation": s, "Value": v, "Color": col}).outputs[0]

    def rgb(self, c):
        nd = self.nt.nodes.new("ShaderNodeRGB")
        nd.outputs[0].default_value = (*c[:3], 1.0)
        return nd.outputs[0]

    # -- textures ----------------------------------------------------------
    def mapping(self, vec, scale=1.0, rot=(0, 0, 0), loc=(0, 0, 0)):
        sc = (scale,) * 3 if np.isscalar(scale) else scale
        return self.n("ShaderNodeMapping", {"Vector": vec, "Scale": sc, "Rotation": rot, "Location": loc}).outputs[0]

    def noise(self, vec, scale, detail=4.0, rough=0.55, dist=0.0, out="Factor"):
        return self.n("ShaderNodeTexNoise", {"Vector": vec, "Scale": scale, "Detail": detail,
                                             "Roughness": rough, "Distortion": dist},
                      noise_dimensions="3D").outputs[out]

    def voronoi(self, vec, scale, feature="F1", out="Distance", rnd=1.0):
        return self.n("ShaderNodeTexVoronoi", {"Vector": vec, "Scale": scale, "Randomness": rnd},
                      feature=feature).outputs[out]

    def image(self, path, vec, non_color=False, box=False, blend=0.25):
        img = bpy.data.images.load(path, check_existing=True)
        if non_color:
            img.colorspace_settings.name = "Non-Color"
        nd = self.n("ShaderNodeTexImage", {"Vector": vec}, image=img)
        if box:
            nd.projection = "BOX"
            nd.projection_blend = blend
        return nd.outputs["Color"]

    def bump(self, height, strength=0.5, dist=0.01, normal=None):
        return self.n("ShaderNodeBump", {"Strength": strength, "Distance": dist, "Height": height,
                                         "Normal": normal}).outputs[0]

    # -- PBR texture set ---------------------------------------------------
    def pbr(self, tid, size, coord="WORLD", rot=0.0, jitter=None, uv=False, blend=0.25, loc=(0, 0, 0)):
        """Returns dict(color, rough, height, normal(optional, UV mode only))."""
        if uv:
            base = self.tc.outputs["UV"]
        elif coord == "WORLD":
            base = self.P
        else:
            base = self.tc.outputs["Object"]
        if jitter is not None:
            base = self.vmath("ADD", base, jitter)
        vec = self.mapping(base, 1.0 / size, rot=(0, 0, rot), loc=loc)
        box = not uv
        d = {
            "vec": vec,
            "color": self.image(tex_file(tid, "Diffuse"), vec, box=box, blend=blend),
            "rough": self.image(tex_file(tid, "Rough"), vec, True, box=box, blend=blend),
            "height": self.image(tex_file(tid, "Displacement"), vec, True, box=box, blend=blend),
        }
        if uv:
            nm = self.image(tex_file(tid, "nor_gl"), vec, True)
            d["normal_tex"] = nm
        return d

    def normal_map(self, col, strength=1.0):
        return self.n("ShaderNodeNormalMap", {"Strength": strength, "Color": col}).outputs[0]

    def principled(self, **inputs):
        nd = self.n("ShaderNodeBsdfPrincipled", inputs)
        return nd

    def finish(self, shader, displacement=None):
        self.link(shader, self.out.inputs["Surface"])
        if displacement is not None:
            self.link(displacement, self.out.inputs["Displacement"])
        return self.mat

    # -- reusable weathering masks ----------------------------------------
    def edge_mask(self, radius=0.012, samples=4):
        """~1 near convex/concave edges, 0 on flat areas (Bevel node vs true normal)."""
        if os.environ.get("HD_NO_MASKS"):
            return self.n("ShaderNodeValue").outputs[0]
        bv = self.n("ShaderNodeBevel", {"Radius": radius}, samples=samples).outputs[0]
        d = self.vmath("DOT_PRODUCT", bv, self.geo.outputs["Normal"])
        return self.maprange(d, 0.995, 0.90, 0.0, 1.0)

    def ao_mask(self, dist=0.05, samples=6):
        """~1 in crevices, 0 on exposed surfaces."""
        if os.environ.get("HD_NO_MASKS"):
            return self.n("ShaderNodeValue").outputs[0]
        ao = self.n("ShaderNodeAmbientOcclusion", {"Distance": dist}, samples=samples).outputs["AO"]
        return self.maprange(ao, 0.85, 0.35, 0.0, 1.0)

    def height_mask(self, z0, z1):
        """1 at world height z0 fading to 0 at z1."""
        return self.maprange(self.xyz(self.P)[2], z0, z1, 1.0, 0.0, smooth=True)

    def streaks(self, scale=6.0, stretch=0.06, seed=0.0):
        """Vertical rain-streak pattern in world space, 0..1."""
        v = self.mapping(self.P, (scale, scale, scale * stretch), loc=(seed, seed * 1.7, 0))
        return self.noise(v, 1.0, 5.0, 0.6)


# ----------------------------------------------------------------------------
# Materials
# ----------------------------------------------------------------------------
MAT = {}
GRAIN_VERTICAL = {"walnut_veneer", "oak_veneer_01", "wood_textured_concrete"}
_STATS = {}


def srgb(*c):
    c = np.array(c, float)
    if c.max() > 1.0:
        c = c / 255.0
    return tuple(float(x) for x in np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4))


def tex_mean(tid):
    """Mean linear albedo and mean roughness of a scan, used to normalise it to a target tone."""
    if tid not in _STATS:
        out = []
        for mname, enc in (("Diffuse", True), ("Rough", False)):
            img = bpy.data.images.load(tex_file(tid, mname), check_existing=False)
            img.scale(32, 32)
            px = np.empty(32 * 32 * 4, np.float32)
            img.pixels.foreach_get(px)
            bpy.data.images.remove(img)
            px = px.reshape(-1, 4)[:, :3].astype(np.float64)
            if enc:
                px = np.where(px <= 0.04045, px / 12.92, ((px + 0.055) / 1.055) ** 2.4)
            out.append(px.mean(axis=0))
        _STATS[tid] = (out[0], float(out[1].mean()))
    return _STATS[tid]


def surf(name, tid, size, target, rough=0.6, rcon=1.0, contrast=1.0, coord="WORLD", jitter=None,
         uv=False, rot=None, bump=0.4, bdist=0.005, nstr=0.8, loc=(0, 0, 0), m=None):
    """Scan-based surface, re-toned so its mean albedo is `target` and mean roughness is `rough`."""
    m = m or M(name)
    if rot is None:
        rot = math.pi / 2 if (uv and tid in GRAIN_VERTICAL) else 0.0
    t = m.pbr(tid, size, coord=coord, rot=rot, jitter=jitter, uv=uv, loc=loc)
    mean, rmean = tex_mean(tid)
    gain = tuple(float(target[i] / max(mean[i], 1e-3)) for i in range(3))
    col = m.mix(1.0, t["color"], m.rgb(gain), "MULTIPLY", clamp=False)
    if contrast != 1.0:
        col = m.mix(contrast, m.rgb(target), col, clamp=False)
    r = m.math("MULTIPLY_ADD", m.sub(t["rough"], rmean), rcon, rough)
    nrm = m.normal_map(t["normal_tex"], nstr) if uv else None
    if bump:
        nrm = m.bump(t["height"], bump, bdist, normal=nrm)
    return m, {"col": col, "rough": r, "normal": nrm, "height": t["height"], "vec": t["vec"]}


def done(m, s, spec=0.5, disp=None, **kw):
    ins = {"Base Color": s["col"], "Roughness": m.sat(s["rough"]), "Specular IOR Level": spec}
    if s.get("normal") is not None:
        ins["Normal"] = s["normal"]
    ins.update(kw)
    b = m.n("ShaderNodeBsdfPrincipled", ins)
    return m.finish(b.outputs[0], disp)


def tone(m, col, f):
    return m.mix(1.0, col, f, "MULTIPLY", clamp=False)


def obj_jitter(m, k=1.0):
    return m.vmath("SCALE", m.rgb((3.1 * k, 7.7 * k, 1.3 * k)), scale=m.oi.outputs["Random"])


def attr_jitter(m, name="rnd", k=1.0):
    return m.vmath("SCALE", m.rgb((3.1 * k, 7.7 * k, 1.3 * k)), scale=m.attr(name))


def mat_concrete(name, tid, size, target, rough=0.78, jitter=None, var=0.0, edge=0.35, moss=None,
                 streak=None, stain=0.0, bump=0.6, dirt_edge=0.0, rcon=1.0, bdist=0.006, form=None, canopy=False):
    m = M(name)
    jit = obj_jitter(m) if jitter == "obj" else attr_jitter(m) if jitter == "attr" else jitter
    m, s = surf(name, tid, size, target, rough=rough, jitter=jit, bump=bump, rcon=rcon, bdist=bdist, m=m)
    P = m.P
    z = m.xyz(P)[2]
    col, r = s["col"], s["rough"]
    col = tone(m, col, m.maprange(m.noise(P, 0.9, 4.0), 0.3, 0.7, 0.9, 1.08))
    if var:
        col = tone(m, col, m.maprange(m.attr("rnd") if var == "attr" else m.oi.outputs["Random"], 0, 1, 0.86, 1.1))
    if stain:
        st = m.maprange(m.noise(P, 1.7, 5.0, 0.65, dist=0.6), 0.52, 0.68)
        col = m.mix(m.mul(st, stain), col, tone(m, col, 0.62))
        r = m.sub(r, m.mul(st, 0.22 * stain))
    if streak:
        ztop, length, k = streak
        st = m.mul(m.maprange(m.streaks(5.0, 0.045), 0.42, 0.72), m.maprange(z, ztop, ztop - length, 1.0, 0.0))
        col = m.mix(m.mul(st, k), col, m.rgb((0.10, 0.095, 0.085)))
        st2 = m.mul(m.maprange(m.streaks(9.0, 0.03, 3.3), 0.55, 0.8), m.maprange(z, ztop, ztop - length * 0.6, 1.0, 0.0))
        col = m.mix(m.mul(st2, k * 0.6), col, m.rgb((0.62, 0.61, 0.58)))
    if moss:
        z0, z1, k = moss
        mm = m.mul(m.height_mask(z0, z1), m.maprange(m.noise(P, 5.0, 5.0, 0.6), 0.3, 0.7, 0.15, 1.0))
        col = m.mix(m.mul(mm, k), col, m.rgb((0.075, 0.085, 0.045)))
        r = m.add(r, m.mul(mm, 0.1))
    if edge or dirt_edge:
        e = m.edge_mask(0.014)
        en = m.mul(e, m.maprange(m.noise(P, 30.0, 3.0), 0.3, 0.7))
        if edge:
            col = m.mix(m.mul(en, edge), col, m.rgb(tuple(min(1.0, c * 1.5) for c in target)))
            r = m.add(r, m.mul(en, 0.08))
        if dirt_edge:
            e2 = m.mul(m.edge_mask(0.05), m.maprange(m.noise(P, 9.0, 4.0), 0.25, 0.75))
            col = m.mix(m.mul(e2, dirt_edge), col, m.rgb((0.07, 0.06, 0.04)))
    if canopy:
        # dirt washed toward the free edges, drier and paler against the wall
        px, py, _ = m.xyz(P)
        dedge = m.math("MINIMUM", m.sub(px, X0 - CAN_OUT), m.sub(py, Y0 - CAN_OUT))
        wash = m.mul(m.maprange(dedge, 0.0, 0.9, 1.0, 0.0, smooth=True), m.maprange(m.noise(P, 3.5, 5.0, 0.65), 0.3, 0.7, 0.2, 1.0))
        col = m.mix(m.mul(wash, 0.38), col, m.rgb((0.085, 0.075, 0.06)))
        run = m.maprange(m.noise(m.mapping(P, (14.0, 14.0, 1.0), rot=(0, 0, 0.785)), 1.0, 3.0), 0.5, 0.7)
        col = m.mix(m.mul(m.mul(run, wash), 0.35), col, m.rgb((0.5, 0.49, 0.46)))
        r = m.sub(r, m.mul(wash, 0.12))
    if form:
        # shuttering panel joints and tie-bolt holes on vertical faces (world x+y runs along either wall)
        pw, ph, zo = form
        px, py, pz = m.xyz(P)
        fx = m.math("FRACT", m.math("DIVIDE", m.add(m.add(px, py), 40.0), pw))
        fz = m.math("FRACT", m.math("DIVIDE", m.add(pz, 20.0 + zo), ph))
        dx = m.mul(m.math("MINIMUM", fx, m.sub(1.0, fx)), pw)
        dz = m.mul(m.math("MINIMUM", fz, m.sub(1.0, fz)), ph)
        joint = m.maprange(m.math("MINIMUM", dx, dz), 0.0015, 0.005, 1.0, 0.0)
        hx = m.mul(m.sub(m.math("ABSOLUTE", m.sub(fx, 0.5)), 0.25), pw)
        hz = m.mul(m.sub(fz, 0.5), ph)
        hole = m.maprange(m.math("SQRT", m.add(m.mul(hx, hx), m.mul(hz, hz))), 0.009, 0.014, 1.0, 0.0)
        vert = m.maprange(m.math("ABSOLUTE", m.xyz(m.geo.outputs["Normal"])[2]), 0.3, 0.6, 1.0, 0.0)
        fm = m.mul(m.math("MAXIMUM", joint, hole), vert)
        col = m.mix(m.mul(fm, 0.7), col, m.rgb((0.06, 0.058, 0.055)))
        # panels differ slightly in tone
        cell = m.voronoi(m.combine(m.math("DIVIDE", m.add(m.add(px, py), 40.0), pw),
                                   m.math("DIVIDE", m.add(pz, 20.0 + zo), ph), 0.0), 1.0, out="Color", rnd=0.0)
        col = tone(m, col, m.mixf(vert, 1.0, m.maprange(m.xyz(cell)[0], 0, 1, 0.9, 1.08)))
        s["normal"] = m.bump(m.sub(1.0, fm), 0.7, 0.006, normal=s["normal"])
    s["col"], s["rough"] = col, r
    return done(m, s, spec=0.4)


def mat_wood(name, tid, size, target, rough=0.5, var=0.14, grey=0.0, bump=0.25, coat=0.0, dark_gap=0.0, contrast=1.0):
    m, s = surf(name, tid, size, target, rough=rough, uv=True, bump=bump, bdist=0.002, nstr=0.7, contrast=contrast)
    rnd = m.attr("rnd")
    col = tone(m, s["col"], m.maprange(rnd, 0, 1, 1 - var, 1 + var))
    col = m.hsv(col, m.maprange(rnd, 0, 1, 0.488, 0.512), m.maprange(m.noise(m.P, 2.0, 2.0), 0.3, 0.7, 0.9, 1.08), 1.0)
    r = s["rough"]
    if grey:
        g = m.mul(m.maprange(m.noise(m.P, 3.0, 5.0, 0.6), 0.3, 0.75), grey)
        col = m.mix(g, col, m.rgb((0.36, 0.33, 0.29)))
        r = m.add(r, m.mul(g, 0.2))
    if dark_gap:
        ao = m.ao_mask(0.03, 4)
        col = m.mix(m.mul(ao, dark_gap), col, m.rgb((0.02, 0.014, 0.01)))
    fine = m.noise(m.mapping(s["vec"], (900.0, 12.0, 1.0) if tid in GRAIN_VERTICAL else (12.0, 900.0, 1.0)), 1.0, 2.0)
    s["normal"] = m.bump(fine, 0.06, 0.001, normal=s["normal"])
    s["col"], s["rough"] = col, r
    kw = {"Coat Weight": coat, "Coat Roughness": 0.12} if coat else {}
    return done(m, s, spec=0.45, **kw)


def build_materials():
    # ---- backdrop (plain cream by brief)
    m = M("backdrop")
    b = m.n("ShaderNodeBsdfPrincipled", {"Base Color": srgb(238, 224, 198), "Roughness": 0.93,
                                         "Specular IOR Level": 0.15})
    MAT["backdrop"] = m.finish(b.outputs[0])

    # ---- white painted brick
    white = (0.80, 0.785, 0.75)
    m = M("brick_paint")
    rnd = m.attr("rnd")
    m, s = surf("", "painted_plaster_wall", 0.8, white, rough=0.56, jitter=attr_jitter(m), bump=0.45,
                bdist=0.004, m=m)
    P = m.P
    z = m.xyz(P)[2]
    col = tone(m, s["col"], m.maprange(rnd, 0, 1, 0.93, 1.05))
    col = tone(m, col, m.maprange(m.noise(P, 1.1, 3.0), 0.3, 0.7, 0.95, 1.04))
    ao = m.ao_mask(0.028, 6)
    col = m.mix(m.mul(ao, 0.5), col, m.rgb((0.36, 0.33, 0.28)))
    splash = m.mul(m.height_mask(FLOOR_Z, FLOOR_Z + 0.85), m.maprange(m.noise(P, 2.8, 5.0, 0.6), 0.3, 0.72, 0.2, 1.0))
    col = m.mix(m.mul(splash, 0.42), col, m.rgb((0.33, 0.29, 0.22)))
    st = m.mul(m.maprange(m.streaks(6.0, 0.045), 0.46, 0.74), m.maprange(z, PAR_Z, PAR_Z - 1.5, 1.0, 0.0))
    col = m.mix(m.mul(st, 0.34), col, m.rgb((0.27, 0.26, 0.24)))
    chips = m.mul(m.mul(m.edge_mask(0.007), m.maprange(m.noise(P, 85.0, 2.0), 0.57, 0.66)),
                  m.maprange(m.attr("rnd2"), 0.45, 0.55))
    col = m.mix(m.mul(chips, 0.9), col, m.rgb((0.34, 0.14, 0.075)))
    s["col"] = col
    s["rough"] = m.add(m.add(s["rough"], m.mul(ao, 0.15)), m.mul(chips, 0.25))
    s["normal"] = m.bump(m.noise(P, 420.0, 2.0, 0.7), 0.10, 0.002,
                         normal=m.bump(m.noise(P, 38.0, 3.0), 0.25, 0.004, normal=s["normal"]))
    MAT["brick"] = done(m, s, spec=0.45)

    # ---- painted masonry behind the bricks (mortar joints, parapet inner faces, rear walls)
    m, s = surf("wall_paint", "painted_plaster_wall", 1.7, (0.66, 0.645, 0.61), rough=0.74, bump=0.6, bdist=0.004)
    P = m.P
    z = m.xyz(P)[2]
    col = tone(m, s["col"], m.maprange(m.noise(P, 1.3, 4.0), 0.3, 0.7, 0.93, 1.05))
    st = m.mul(m.maprange(m.streaks(6.0, 0.045, 5.0), 0.46, 0.74), m.maprange(z, PAR_Z, PAR_Z - 0.9, 1.0, 0.0))
    col = m.mix(m.mul(st, 0.35), col, m.rgb((0.2, 0.19, 0.17)))
    s["col"] = col
    s["normal"] = m.bump(m.noise(P, 600.0, 2.0, 0.8), 0.25, 0.002, normal=s["normal"])
    MAT["wall_paint"] = done(m, s, spec=0.35)

    # ---- concretes
    MAT["conc_wall"] = mat_concrete("conc_wall", "concrete_wall_008", 2.71, (0.33, 0.325, 0.31), rough=0.8,
                                    streak=(1.0, 0.8, 0.45), edge=0.4, form=(1.2, 0.5, 0.0), moss=(0.0, 0.22, 0.35))
    MAT["conc_wall_low"] = mat_concrete("conc_wall_low", "concrete_wall_008", 2.71, (0.33, 0.325, 0.31), rough=0.8,
                                        streak=(0.5, 0.5, 0.45), edge=0.4, form=(1.2, 0.5, 0.0), moss=(0.0, 0.22, 0.35))
    MAT["conc_base"] = mat_concrete("conc_base", "concrete_wall_006", 2.0, (0.21, 0.205, 0.195), rough=0.82,
                                    streak=(0.0, 0.5, 0.3), edge=0.3, form=(2.4, 0.5, 0.0))
    MAT["conc_slab"] = mat_concrete("conc_slab", "concrete_floor_worn_001", 3.0, (0.37, 0.362, 0.34), rough=0.72,
                                    jitter="attr", var="attr", edge=0.3, dirt_edge=0.55, stain=0.5)
    MAT["conc_step"] = mat_concrete("conc_step", "concrete_floor_worn_001", 3.0, (0.345, 0.338, 0.32), rough=0.74,
                                    edge=0.45, stain=0.35, moss=(0.0, 0.12, 0.5))
    MAT["conc_plinth"] = mat_concrete("conc_plinth", "concrete_wall_006", 2.0, (0.30, 0.295, 0.28), rough=0.8,
                                      moss=(0.0, 0.3, 0.55), edge=0.25)
    MAT["conc_beam"] = mat_concrete("conc_beam", "wood_textured_concrete", 1.8, (0.36, 0.355, 0.335), rough=0.78,
                                    streak=(PAR_Z + 0.30, 0.5, 0.35), edge=0.45, stain=0.25, bump=0.9, bdist=0.01)
    MAT["conc_canopy"] = mat_concrete("conc_canopy", "concrete_wall_006", 2.0, (0.30, 0.295, 0.28), rough=0.72,
                                      edge=0.3, stain=0.3, canopy=True)

    # ---- timber
    warm = (0.255, 0.125, 0.058)
    MAT["wood_slat"] = mat_wood("wood_slat", "walnut_veneer", 1.8, warm, rough=0.52, var=0.18, dark_gap=0.6, contrast=1.3)
    MAT["wood_door"] = mat_wood("wood_door", "walnut_veneer", 1.8, (0.21, 0.10, 0.045), rough=0.4, var=0.08, coat=0.25)
    MAT["wood_deck"] = mat_wood("wood_deck", "teak_veneer", 1.0, (0.215, 0.118, 0.058), rough=0.6, var=0.2,
                                grey=0.3, dark_gap=0.6, bump=0.45, contrast=1.5)
    MAT["wood_fascia"] = mat_wood("wood_fascia", "walnut_veneer", 1.8, (0.27, 0.135, 0.062), rough=0.5, var=0.1,
                                  grey=0.25)
    MAT["wood_planter"] = mat_wood("wood_planter", "teak_veneer", 1.0, (0.20, 0.108, 0.052), rough=0.6, var=0.2,
                                   grey=0.4, dark_gap=0.5, bump=0.45, contrast=1.5)
    MAT["wood_furn"] = mat_wood("wood_furn", "oak_veneer_01", 1.83, (0.36, 0.23, 0.12), rough=0.42, var=0.05)

    # ---- powder-coated black metal
    m = M("black_metal")
    Po = m.P
    n1 = m.noise(Po, 2.5, 4.0)
    up = m.maprange(m.xyz(m.geo.outputs["Normal"])[2], 0.55, 1.0)
    dust = m.mul(up, m.maprange(m.noise(Po, 7.0, 4.0), 0.25, 0.8, 0.25, 1.0))
    col = m.mix(m.mul(dust, 0.22), m.rgb((0.013, 0.013, 0.014)), m.rgb((0.30, 0.27, 0.22)))
    r = m.add(m.maprange(n1, 0.2, 0.8, 0.30, 0.46), m.mul(dust, 0.3))
    nb = m.bump(m.noise(Po, 900.0, 2.0, 0.6), 0.04, 0.001)
    MAT["black_metal"] = done(m, {"col": col, "rough": r, "normal": nb}, spec=0.5)

    m = M("black_matte")
    b = m.n("ShaderNodeBsdfPrincipled", {"Base Color": (0.006, 0.006, 0.006, 1), "Roughness": 0.9})
    MAT["black_matte"] = m.finish(b.outputs[0])

    # ---- architectural glass: refractive for camera/indirect, straight-through for shadow rays
    m = M("glass")
    g = m.n("ShaderNodeBsdfGlass", {"Color": (0.985, 0.995, 0.99, 1), "Roughness": 0.0, "IOR": 1.52})
    t = m.n("ShaderNodeBsdfTransparent", {"Color": (0.90, 0.93, 0.915, 1)})
    lp = m.n("ShaderNodeLightPath")
    # Camera and glossy rays see real refractive glass (reflections, double refraction through the pane).
    # Shadow rays and diffuse-bounce rays go straight through with the pane's transmittance: light direction
    # is unchanged by a flat pane, and it keeps "diffuse -> refraction -> sun" out of the noisy caustic bucket.
    fac = lp.outputs["Is Shadow Ray"] if os.environ.get("HD_OLD_GLASS") else \
        m.math("MAXIMUM", lp.outputs["Is Shadow Ray"], lp.outputs["Is Diffuse Ray"])
    mx = m.n("ShaderNodeMixShader", {0: fac, 1: g.outputs[0], 2: t.outputs[0]})
    MAT["glass"] = m.finish(mx.outputs[0])

    # ---- roof ballast
    m, s = surf("roof_gravel", "clean_pebbles", 2.2, (0.40, 0.375, 0.335), rough=0.82, bump=1.0, bdist=0.03, contrast=1.5)
    P = m.P
    col = tone(m, s["col"], m.maprange(m.noise(P, 0.7, 5.0, 0.6), 0.3, 0.7, 0.78, 1.14))
    # ballast is never one stone colour: warm and cool pebbles, a little moss dust in the wet zones
    col = m.mix(m.maprange(m.noise(P, 55.0, 2.0, 0.5), 0.55, 0.7, 0.0, 0.35), col, m.rgb((0.52, 0.42, 0.30)))
    col = m.mix(m.maprange(m.noise(P, 70.0, 2.0, 0.5), 0.6, 0.72, 0.0, 0.4), col, m.rgb((0.16, 0.165, 0.17)))
    damp = m.maprange(m.noise(P, 0.35, 4.0, 0.6, dist=0.8), 0.55, 0.7)
    for dx_, dy_ in ROOF_DRAINS:        # darker, damp halo that drains toward each outlet
        dd = m.vmath("DISTANCE", P, m.rgb((dx_, dy_, ROOF_Z + 0.03)))
        ring = m.mul(m.maprange(dd, 0.25, 1.5, 1.0, 0.0, smooth=True), m.maprange(m.noise(P, 2.0, 4.0), 0.3, 0.7, 0.4, 1.0))
        damp = m.math("MAXIMUM", damp, ring)
    edge = m.maprange(m.noise(m.mapping(P, (3.0, 3.0, 3.0)), 1.0, 3.0), 0.35, 0.65)
    col = m.mix(m.mul(damp, 0.5), col, tone(m, col, 0.45))
    col = m.mix(m.mul(m.mul(damp, m.maprange(m.noise(P, 6.0, 4.0), 0.45, 0.7)), 0.35), col, m.rgb((0.10, 0.12, 0.05)))
    s["col"] = tone(m, col, m.maprange(edge, 0, 1, 0.9, 1.08))
    s["rough"] = m.sub(s["rough"], m.mul(damp, 0.15))
    MAT["roof_gravel"] = done(m, s, spec=0.35)
    m = M("zinc")
    zn = m.noise(m.P, 14.0, 4.0, 0.6)
    b = m.n("ShaderNodeBsdfPrincipled", {"Base Color": tone(m, m.rgb((0.42, 0.43, 0.44)), m.maprange(zn, 0.3, 0.7, 0.7, 1.1)),
                                         "Metallic": 0.9, "Roughness": m.maprange(zn, 0.3, 0.7, 0.35, 0.6)})
    MAT["zinc"] = m.finish(b.outputs[0])


# ----------------------------------------------------------------------------
# Architecture
# ----------------------------------------------------------------------------
SL1 = (NY + 4.5 * MOD, NY + 6 * MOD)            # slit windows on the left-front wall (along y)
SL2 = (NY + 12 * MOD, NY + 13.5 * MOD)
SLZ = (FLOOR_Z + 5 * COURSE, FLOOR_Z + 32 * COURSE)
BW = (NX + 2 * MOD, NX + 18.5 * MOD)            # big window on the right-front wall (along x)
BWZ = (FLOOR_Z, FLOOR_Z + 32 * COURSE)
CAN_OUT = 0.50                                  # canopy overhang
CAN_Z = 2.86                                    # canopy soffit level
STEP_T = 0.36                                   # tread depth
DOOR = (X0 + 0.46, X0 + 1.44)                   # door on the notch wall that faces -y
DOOR_H = 2.14
BEAM_TOP = PAR_Z + 0.30
ROOF_DRAINS = [(X1 - WALL_T - 0.3, Y0 + WALL_T + 0.3), (X0 + WALL_T + 0.3, Y1 - WALL_T - 0.3)]


def wall_boxes(axis, p0, p1, a0, a1, z0, z1, openings=()):
    """Axis aligned wall with rectangular holes -> list of (lo, hi) boxes."""
    out = []

    def mk(al, ah, zl, zh):
        lo, hi = [0, 0, zl], [0, 0, zh]
        lo[axis], hi[axis] = al, ah
        lo[1 - axis], hi[1 - axis] = min(p0, p1), max(p0, p1)
        out.append((lo, hi))
    cur = a0
    for o0, o1, oz0, oz1 in sorted(openings):
        if o0 > cur:
            mk(cur, o0, z0, z1)
        if oz0 > z0:
            mk(o0, o1, z0, oz0)
        if oz1 < z1:
            mk(o0, o1, oz1, z1)
        cur = o1
    if cur < a1:
        mk(cur, a1, z0, z1)
    return out


def _cut(segs, c0, c1):
    out = []
    for lo, hi in segs:
        if hi <= c0 or lo >= c1:
            out.append((lo, hi))
        else:
            if lo < c0:
                out.append((lo, c0))
            if hi > c1:
                out.append((c1, hi))
    return out


def brick_wall(name, axis, face, a0, a1, z0, courses, openings=(), soldiers=(), phase=0,
               corner_start=False, corner_end=False, seed=0):
    """Running-bond brick leaf, every brick a bevelled box. `axis` is the run direction (0=x, 1=y);
    `face` is the outer face coordinate on the other axis (outside is toward negative)."""
    rng = np.random.default_rng(seed)
    C, H = [], []
    oth = 1 - axis

    def emit(lo, hi, zb, zt):
        d = rng.normal(0, 0.0012)
        c, h = [0, 0, (zb + zt) / 2], [0, 0, (zt - zb) / 2]
        c[axis], h[axis] = (lo + hi) / 2, (hi - lo) / 2
        c[oth], h[oth] = face + BRICK_D / 2 + d, BRICK_D / 2
        C.append(c)
        H.append(h)
    for k in range(courses):
        zb, zt = z0 + k * COURSE + JOINT, z0 + (k + 1) * COURSE
        off = 0.0 if (k + phase) % 2 == 0 else MOD / 2
        segs = []
        n = int((a1 - a0) / MOD) + 3
        for j in range(n):
            lo = a0 - off + j * MOD + JOINT / 2
            hi = lo + BRICK_L
            if hi <= a0 or lo >= a1:
                continue
            if lo < a0 + JOINT:
                lo = a0
                if off and corner_start:
                    continue
            if hi > a1 - JOINT:
                hi = a1
                if corner_end and hi - lo < BRICK_L - 0.02:
                    continue
            segs.append((lo, hi))
        for o0, o1, oz0, oz1 in openings:
            if zb < oz1 - 1e-6 and zt > oz0 + 1e-6:
                segs = _cut(segs, o0, o1)
        for s0, s1, sz in soldiers:
            if zb < sz + MOD - 1e-6 and zt > sz + 1e-6:
                segs = _cut(segs, s0, s1)
        edges = [(o0, o1) for o0, o1, oz0, oz1 in openings if zb < oz1 - 1e-6 and zt > oz0 + 1e-6] + \
                [(s0, s1) for s0, s1, sz in soldiers if zb < sz + MOD - 1e-6 and zt > sz + 1e-6]
        for lo, hi in segs:
            for e0, e1 in edges:                 # a brick that stops a joint-width short of a jamb is cut flush
                if 0 < e0 - hi <= JOINT * 1.2:
                    hi = e0
                if 0 < lo - e1 <= JOINT * 1.2:
                    lo = e1
            if hi - lo > 0.03:
                emit(lo, hi, zb, zt)
    for s0, s1, sz in soldiers:
        n = int(round((s1 - s0) / COURSE))
        pitch = (s1 - s0) / n
        for i in range(n):
            lo = s0 + i * pitch + JOINT / 2
            emit(lo, lo + pitch - JOINT, sz + JOINT, sz + MOD)
    C, H = np.array(C), np.array(H)
    rnd = rng.random(len(C))
    return rounded_boxes(name, C, H, r=0.0032, mat=MAT["brick"], rnd=rnd, seed=seed,
                         extra_attrs={"rnd2": rng.random(len(C))}, coll="House")


def slat_wall(name, axis, face, a0, a1, z0, z1, mat, slat=0.068, gap=0.012, t=0.02, openings=(), seed=0):
    """Horizontal timber slats with shadow gaps; boards are butt-jointed at random lengths."""
    rng = np.random.default_rng(seed)
    lohi = []
    z = z0 + gap * 0.5
    oth = 1 - axis
    while z + slat <= z1 + 1e-6:
        segs = [(a0, a1)]
        for o0, o1, oz0, oz1 in openings:
            if z < oz1 and z + slat > oz0:
                segs = _cut(segs, o0, o1)
        for lo, hi in segs:
            cuts = [lo]
            while hi - cuts[-1] > 2.2:
                cuts.append(cuts[-1] + rng.uniform(0.9, 2.0))
            cuts.append(hi)
            for c0, c1 in zip(cuts[:-1], cuts[1:]):
                if c1 - c0 < 0.05:
                    continue
                l, h = [0, 0, z], [0, 0, z + slat]
                l[axis], h[axis] = c0 + 0.001, c1 - 0.001
                d = rng.normal(0, 0.0006)
                l[oth], h[oth] = face + d, face + t + d
                lohi.append((l, h))
        z += slat + gap
    return boxes(name, lohi, mat=mat, r=0.003, uv_grain=axis, seed=seed, coll="House")


def plank_field(name, x0, x1, y0, y1, ztop, t, mat, along=0, width=0.118, gap=0.006, seed=0, maxlen=2.4,
                coll="House", r=0.003):
    """Deck boards / planter cladding laid flat: boards run along `along`, rows stack on the other axis."""
    rng = np.random.default_rng(seed)
    lohi = []
    a0, a1 = (x0, x1) if along == 0 else (y0, y1)
    b0, b1 = (y0, y1) if along == 0 else (x0, x1)
    n = max(1, int(round((b1 - b0 + gap) / (width + gap))))
    w = (b1 - b0 - gap * (n - 1)) / n
    for i in range(n):
        bl = b0 + i * (w + gap)
        cuts = [a0]
        if a1 - a0 > maxlen:
            cuts.append(a0 + rng.uniform(0.3, 0.7) * (a1 - a0))
        cuts.append(a1)
        for c0, c1 in zip(cuts[:-1], cuts[1:]):
            dz = rng.normal(0, 0.0006)
            l, h = [0, 0, ztop - t + dz], [0, 0, ztop + dz]
            l[along], h[along] = c0 + 0.0015, c1 - 0.0015
            l[1 - along], h[1 - along] = bl, bl + w
            lohi.append((l, h))
    return boxes(name, lohi, mat=mat, r=r, uv_grain=along, seed=seed, coll=coll)


def flat_poly(name, pts, z, mat, coll="House"):
    v = np.array([(x, y, z) for x, y in pts], np.float32)
    me = bpy.data.meshes.new(name)
    me.from_pydata(v.tolist(), [], [list(range(len(v)))])
    me.update()
    me.materials.append(mat)
    return link(bpy.data.objects.new(name, me), coll)


def window(name, axis, face, a0, a1, z0, z1, setback=0.105, fw=0.045, fd=0.07, mullions=(), glass_t=0.012):
    """Black aluminium frame with solid glass panes. Outside is toward negative on the other axis."""
    oth = 1 - axis
    d0, d1 = face + setback, face + setback + fd

    def bx(al, ah, zl, zh, dl=d0, dh=d1):
        lo, hi = [0, 0, zl], [0, 0, zh]
        lo[axis], hi[axis] = al, ah
        lo[oth], hi[oth] = dl, dh
        return (lo, hi)
    fr = [bx(a0, a0 + fw, z0, z1), bx(a1 - fw, a1, z0, z1), bx(a0 + fw, a1 - fw, z0, z0 + fw),
          bx(a0 + fw, a1 - fw, z1 - fw, z1)]
    edges = [a0 + fw]
    for mpos in mullions:
        fr.append(bx(mpos - fw / 2, mpos + fw / 2, z0 + fw, z1 - fw))
        edges += [mpos - fw / 2, mpos + fw / 2]
    edges.append(a1 - fw)
    boxes(name + "_frame", fr, mat=MAT["black_metal"], r=0.003, coll="House")
    gc = (d0 + d1) / 2
    gl = [bx(edges[i] - 0.006, edges[i + 1] + 0.006, z0 + fw - 0.006, z1 - fw + 0.006,
             gc - glass_t / 2, gc + glass_t / 2) for i in range(0, len(edges), 2)]
    boxes(name + "_glass", gl, mat=MAT["glass"], r=0.0008, segments=1, coll="House")
    # sill plate and steel lintel
    boxes(name + "_trim", [bx(a0 - 0.01, a1 + 0.01, z0 - 0.014, z0 + 0.004, face - 0.022, d0 + 0.01),
                           bx(a0 - 0.09, a1 + 0.09, z1 - 0.004, z1 + 0.006, face - 0.004, d0 + 0.01)],
          mat=MAT["black_metal"], r=0.0015, coll="House")


def build_site():
    S = SITE
    box("base", (-S - 0.04, -S - 0.04, -BASE_T), (S + 0.04, S + 0.04, -0.012), MAT["conc_base"], r=0.012, coll="Site")
    T, HI, LO, BRK = 0.2, 1.0, 0.5, 4.6
    hi = [((S - T, -S, -0.012), (S, S, HI)), ((-S, S - T, -0.012), (S - T, S, HI)),
          ((-S, BRK, -0.012), (-S + T, S - T, HI)), ((BRK, -S, -0.012), (S - T, -S + T, HI))]
    lo = [((-S, -S, -0.012), (-S + T, BRK, LO)), ((-S + T, -S, -0.012), (BRK, -S + T, LO))]
    boxes("wall_high", hi, MAT["conc_wall"], r=0.008, coll="Site")
    boxes("wall_low", lo, MAT["conc_wall_low"], r=0.008, coll="Site")
    # backdrop
    B = 260.0
    v = np.array([(-B, -B, -BASE_T), (B, -B, -BASE_T), (B, B, -BASE_T), (-B, B, -BASE_T)], np.float32)
    mesh_obj("backdrop", v, quads=[[0, 1, 2, 3]], mat=MAT["backdrop"], coll="Site")


def build_house():
    Z0 = FLOOR_Z
    slits = [(*SL1, *SLZ), (*SL2, *SLZ)]
    big = [(*BW, *BWZ)]
    # --- brick leaves (left-front wall A runs along y, right-front wall B runs along x)
    brick_wall("bricks_A", 1, X0, NY, Y1, Z0, NCOURSE, openings=slits, corner_start=True, seed=1)
    brick_wall("bricks_B", 0, Y0, NX, X1, Z0, NCOURSE, openings=big, soldiers=[(BW[0] - MOD / 2, BW[1] + MOD / 2, BWZ[1])],
               corner_start=True, seed=2)
    # returns into the notch so the wall ends read as solid 300 mm brick piers
    brick_wall("bricks_Ar", 0, NY, X0, X0 + WALL_T, Z0, NCOURSE, phase=1, corner_start=True, seed=3)
    brick_wall("bricks_Br", 1, NX, Y0, Y0 + WALL_T, Z0, NCOURSE, phase=1, corner_start=True, seed=4)
    # --- masonry core
    e = 0.006
    core = []
    core += wall_boxes(1, X0 + e, X0 + WALL_T, NY + e, Y1, Z0, PAR_Z, slits)
    core += wall_boxes(0, Y0 + e, Y0 + WALL_T, NX + e, X1, Z0, PAR_Z, big)
    core += wall_boxes(1, X1 - WALL_T, X1, Y0 + 0.02, Y1, 0.0, PAR_Z)
    core += wall_boxes(0, Y1 - WALL_T, Y1, X0 + 0.02, X1, 0.0, PAR_Z)
    core += wall_boxes(1, NX + 0.05, NX + 0.05 + WALL_T, Y0 + 0.02, NY + 0.05 + WALL_T, Z0, PAR_Z)
    core += wall_boxes(0, NY + 0.05, NY + 0.05 + WALL_T, X0 + 0.02, NX + 0.05 + WALL_T, Z0, PAR_Z)
    boxes("masonry_core", core, MAT["wall_paint"], r=0.003, segments=2, coll="House")
    # --- plinth / floor slab
    box("plinth", (X0 + 0.014, Y0 + 0.014, 0.0), (X1 - 0.004, Y1 - 0.004, Z0 - 0.01), MAT["conc_plinth"], r=0.006,
        coll="House")
    # --- roof slab, ballast, parapet copings
    boxes("roof_slab", [((NX + 0.3, Y0 + 0.29, CEIL_Z), (X1 - 0.29, Y1 - 0.29, ROOF_Z)),
                        ((X0 + 0.29, NY + 0.3, CEIL_Z), (NX + 0.31, Y1 - 0.29, ROOF_Z))],
          MAT["wall_paint"], r=0.0, segments=1, coll="House")
    xi0, xi1, yi0, yi1 = X0 + WALL_T, X1 - WALL_T, Y0 + WALL_T, Y1 - WALL_T
    nx, ny = NX + 0.05 + WALL_T, NY + 0.05 + WALL_T
    flat_poly("roof_ballast", [(nx, yi0), (xi1, yi0), (xi1, yi1), (xi0, yi1), (xi0, ny), (nx, ny)], ROOF_Z + 0.03,
              MAT["roof_gravel"])
    cz0, cz1, o = PAR_Z, PAR_Z + 0.035, 0.022
    cop = [((X0 - o, NY - o, cz0), (X0 + WALL_T + o, Y1 + o, cz1)),
           ((NX - o, Y0 - o, cz0), (X1 + o, Y0 + WALL_T + o, cz1)),
           ((X1 - WALL_T - o, Y0 + WALL_T + o + 0.002, cz0), (X1 + o, Y1 + o, cz1)),
           ((X0 + WALL_T + o + 0.002, Y1 - WALL_T - o, cz0), (X1 - WALL_T - o - 0.002, Y1 + o, cz1)),
           ((NX + 0.03 - o, Y0 + WALL_T + o + 0.002, cz0), (nx + o, ny + o, cz1)),
           ((X0 + WALL_T + o + 0.002, NY + 0.03 - o, cz0), (NX + 0.03 - o - 0.002, ny + o, cz1))]
    boxes("coping", cop, MAT["black_metal"], r=0.004, coll="House")
    for i, (dx_, dy_) in enumerate(ROOF_DRAINS):
        lathe(f"roof_drain{i}", [(0.0, 0.05), (0.03, 0.05), (0.075, 0.035), (0.085, 0.02), (0.11, 0.012), (0.115, 0.0)],
              32, (dx_, dy_, ROOF_Z + 0.028), MAT["black_metal"], coll="House")
    lathe("roof_vent", [(0.085, 0.0), (0.085, 0.02), (0.055, 0.03), (0.055, 0.34), (0.085, 0.345), (0.09, 0.36),
                        (0.085, 0.40), (0.0, 0.41)], 32, (4.35, 4.3, ROOF_Z + 0.03), MAT["zinc"], coll="House")
    # --- the concrete beam that crosses over the roof
    box("beam", (X0 - 0.6, 2.80, 3.03), (X1 + 0.03, 3.11, BEAM_TOP), MAT["conc_beam"], r=0.012, coll="House")
    # --- windows
    for i, sl in enumerate((SL1, SL2)):
        window(f"slit{i}", 1, X0, sl[0], sl[1], SLZ[0], SLZ[1], fw=0.032, fd=0.06)
    w = BW[1] - BW[0]
    window("bigwin", 0, Y0, BW[0], BW[1], BWZ[0], BWZ[1], fw=0.05, fd=0.075,
           mullions=(BW[0] + w * 0.36, BW[0] + w * 0.68), glass_t=0.014)
    # --- notch: timber slats, door, deck, canopy
    sx, sy = NX + 0.03, NY + 0.03                    # outer faces of the two slat planes
    door = (DOOR[0], DOOR[1], Z0, Z0 + DOOR_H)
    slat_wall("slats_W", 1, sx, Y0 + WALL_T + 0.012, sy, Z0 + 0.012, PAR_Z, MAT["wood_slat"], seed=5)
    slat_wall("slats_S", 0, sy, X0 + WALL_T + 0.012, sx - 0.002, Z0 + 0.012, PAR_Z, MAT["wood_slat"],
              openings=[door], seed=6)
    boxes("slat_backing", [((sx + 0.018, Y0 + WALL_T, Z0), (sx + 0.021, sy + 0.02, PAR_Z)),
                           ((X0 + WALL_T, sy + 0.018, Z0), (sx + 0.02, sy + 0.021, PAR_Z))],
          MAT["black_matte"], r=0.0, segments=1, coll="House")
    d0, d1 = DOOR
    boxes("door_frame", [((d0, sy - 0.006, Z0), (d0 + 0.035, sy + 0.05, Z0 + DOOR_H)),
                         ((d1 - 0.035, sy - 0.006, Z0), (d1, sy + 0.05, Z0 + DOOR_H)),
                         ((d0 + 0.035, sy - 0.006, Z0 + DOOR_H - 0.035), (d1 - 0.035, sy + 0.05, Z0 + DOOR_H)),
                         ((d0 - 0.02, sy - 0.03, Z0 - 0.002), (d1 + 0.02, sy + 0.05, Z0 + 0.016)),
                         # handle: pull bar on two stand-offs
                         ((d1 - 0.16, sy - 0.062, Z0 + 0.75), (d1 - 0.135, sy - 0.04, Z0 + 1.55)),
                         ((d1 - 0.155, sy - 0.045, Z0 + 0.85), (d1 - 0.14, sy + 0.012, Z0 + 0.865)),
                         ((d1 - 0.155, sy - 0.045, Z0 + 1.43), (d1 - 0.14, sy + 0.012, Z0 + 1.445))],
          MAT["black_metal"], r=0.003, coll="House")
    # door leaf made of vertical boards
    lohi, n = [], 7
    bw = (d1 - d0 - 0.07 - 0.003 * (n - 1)) / n
    for i in range(n):
        xl = d0 + 0.035 + i * (bw + 0.003)
        lohi.append(((xl, sy + 0.008, Z0 + 0.018), (xl + bw, sy + 0.048, Z0 + DOOR_H - 0.037)))
    boxes("door_leaf", lohi, MAT["wood_door"], r=0.002, uv_grain=2, seed=7, coll="House")
    # terrace podium + two wrap-around steps + deck boards
    boxes("steps", [((X0 - 0.0, Y0 - 0.0, 0.0), (NX + 0.02, NY + 0.02, Z0 - 0.03)),
                    ((X0 - STEP_T, Y0 - STEP_T, -0.02), (NX, NY, 0.30)),
                    ((X0 - 2 * STEP_T, Y0 - 2 * STEP_T, -0.02), (NX, NY, 0.15))],
          MAT["conc_step"], r=0.008, coll="House")
    plank_field("deck", X0 + 0.004, sx - 0.004, Y0 + 0.004, sy - 0.004, Z0, 0.03, MAT["wood_deck"], along=0, seed=8)
    cz, ct = CAN_Z, 0.16
    cx0, cy0 = X0 - CAN_OUT, Y0 - CAN_OUT
    boxes("canopy", [((cx0, cy0, cz), (NX, NY, cz + ct)),
                     ((X0 + WALL_T, NY - 0.01, cz), (sx + 0.03, sy + 0.03, cz + ct)),
                     ((NX - 0.01, Y0 + WALL_T, cz), (sx + 0.03, sy + 0.03, cz + ct))],
          MAT["conc_canopy"], r=0.004, coll="House")
    f, fz0, fz1 = 0.024, cz - 0.035, cz + ct + 0.012
    for i, (lo, hi, ax) in enumerate([
            ((cx0 - f, cy0 - f, fz0), (cx0, NY + f, fz1), 1),
            ((cx0, cy0 - f, fz0), (NX + f, cy0, fz1), 0),
            ((cx0, NY, fz0), (X0 - 0.002, NY + f, fz1), 0),
            ((NX, cy0, fz0), (NX + f, Y0 - 0.002, fz1), 1)]):
        box(f"fascia{i}", lo, hi, MAT["wood_fascia"], r=0.003, uv_grain=ax, seed=20 + i, coll="House")
    plank_field("soffit", cx0 + 0.002, NX - 0.002, cy0 + 0.002, NY - 0.002, cz, 0.018, MAT["wood_fascia"], along=0,
                width=0.11, gap=0.004, seed=9)
    tz0, tz1, tw = fz1, fz1 + 0.006, 0.05
    boxes("canopy_trim", [((cx0 - f - 0.006, cy0 - f - 0.006, tz0), (cx0 + tw, NY + f + 0.004, tz1)),
                          ((cx0 + tw, cy0 - f - 0.006, tz0), (NX + f + 0.004, cy0 + tw, tz1)),
                          ((cx0 + tw, NY - tw, tz0), (X0 - 0.004, NY + f + 0.004, tz1)),
                          ((NX - tw, cy0 + tw, tz0), (NX + f + 0.004, Y0 - 0.004, tz1)),
                          # upstand flashing where the slab meets the timber walls
                          ((X0 + WALL_T, NY - 0.012, cz + ct), (sx, NY + 0.03, cz + ct + 0.07)),
                          ((NX - 0.012, Y0 + WALL_T, cz + ct), (NX + 0.03, sy, cz + ct + 0.07))],
          MAT["black_metal"], r=0.002, coll="House")


# ----------------------------------------------------------------------------
# Garden layout
# ----------------------------------------------------------------------------
SLABS = [  # cx, cy, size x, size y, rotation (deg)
    (-0.55, -2.80, 1.75, 0.74, 1.5), (-0.05, -3.62, 1.55, 0.74, -2.0),
    (-0.78, -4.44, 1.80, 0.72, 1.2), (-0.15, -5.24, 1.50, 0.70, -1.4),
    (-2.80, -0.45, 0.74, 1.70, -1.5), (-3.62, 0.02, 0.74, 1.50, 2.2), (-4.44, -0.62, 0.72, 1.75, -1.0),
]
SLAB_TOP = 0.045
TREE_BIG = (-4.15, 2.95)
TREE_SMALL = (4.2, -4.25)
SHRUB = (-2.72, 1.62, 0.50)                     # x, y, radius
PLANTER = (BW[0] + 0.06, BW[1] - 0.06, Y0 - 0.64, Y0 - 0.12, 0.50)   # x0, x1, y0, y1, height
POT = (0.36, -1.10, 0.23, 0.52)                 # x, y, radius, height (stands on the deck)
ROCKS = [  # x, y, half extents (x, y, z), seed
    (-5.05, 1.55, (0.50, 0.38, 0.36), 11), (-4.4, 1.0, (0.30, 0.25, 0.21), 12), (-5.25, 2.4, (0.22, 0.18, 0.15), 13),
    (-2.75, -4.55, (0.55, 0.42, 0.38), 14), (-1.95, -5.05, (0.32, 0.26, 0.22), 15), (-3.4, -5.15, (0.22, 0.24, 0.16), 16),
    (3.15, -4.75, (0.44, 0.36, 0.31), 17), (5.0, -3.45, (0.32, 0.26, 0.23), 18), (2.55, -5.2, (0.21, 0.18, 0.14), 19),
    (-4.75, 4.15, (0.28, 0.23, 0.19), 20),
]
BEDS = [  # pebble beds: cx, cy, r
    (-4.15, 2.95, 0.95), (-4.8, 1.75, 0.95), (-4.7, 3.95, 0.75), (-4.6, 1.0, 0.5),
    (-2.6, -4.75, 1.0), (-1.85, -5.2, 0.6), (-3.35, -5.2, 0.55),
    (4.2, -4.25, 0.9), (3.15, -4.7, 0.8), (4.9, -3.4, 0.65), (2.6, -5.2, 0.45),
]
OGRASS = [  # ornamental grass clumps: x, y, height, seed
    (-5.2, 3.3, 1.05, 31), (-3.35, 3.75, 0.8, 32), (-4.95, 0.55, 0.9, 33), (-5.3, 4.75, 0.7, 34),
    (-3.5, -4.3, 1.0, 35), (-1.55, -4.6, 0.75, 36), (-2.9, -5.5, 0.85, 37), (-1.2, -5.45, 0.6, 43),
    (3.7, -5.3, 1.0, 38), (5.1, -4.5, 0.85, 39), (2.35, -4.3, 0.75, 40), (5.2, -2.6, 0.9, 41), (4.55, -5.35, 0.65, 42),
]


def _rect_sdf(x, y, cx, cy, hx, hy, rot=0.0):
    c, s = math.cos(-rot), math.sin(-rot)
    lx = (x - cx) * c - (y - cy) * s
    ly = (x - cx) * s + (y - cy) * c
    qx, qy = np.abs(lx) - hx, np.abs(ly) - hy
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0)


def bed_sdf(x, y):
    """Signed distance to the white-pebble beds (negative inside)."""
    d = np.full(np.shape(x), 1e9)
    for cx, cy, r in BEDS:
        d = np.minimum(d, np.hypot(x - cx, y - cy) - r)
    d = d + 0.22 * (fbm(np.stack([x * 1.3, y * 1.3], -1), 3, seed=5) - 0.5) * 2
    # drip strips along the two brick walls, and the hidden strips behind the house
    d = np.minimum(d, _rect_sdf(x, y, X0 - 0.21, (NY + SITE) / 2, 0.21, (SITE - NY) / 2))
    d = np.minimum(d, _rect_sdf(x, y, (NX + SITE) / 2, Y0 - 0.44, (SITE - NX) / 2, 0.44))
    d = np.minimum(d, _rect_sdf(x, y, (X1 + SITE) / 2, 0, (SITE - X1) / 2, SITE))
    d = np.minimum(d, _rect_sdf(x, y, 0, (Y1 + SITE) / 2, SITE, (SITE - Y1) / 2))
    return d


def hard_sdf(x, y):
    """Signed distance to everything solid that grass cannot grow through."""
    e = 2 * STEP_T
    d = _rect_sdf(x, y, (X0 + X1) / 2, (Y0 + Y1) / 2, (X1 - X0) / 2, (Y1 - Y0) / 2)
    d = np.minimum(d, _rect_sdf(x, y, (X0 - e + NX) / 2, (Y0 - e + NY) / 2, (NX - X0 + e) / 2, (NY - Y0 + e) / 2))
    for cx, cy, sx, sy, r in SLABS:
        d = np.minimum(d, _rect_sdf(x, y, cx, cy, sx / 2, sy / 2, math.radians(r)))
    px0, px1, py0, py1, _ = PLANTER
    d = np.minimum(d, _rect_sdf(x, y, (px0 + px1) / 2, (py0 + py1) / 2, (px1 - px0) / 2, (py1 - py0) / 2))
    d = np.minimum(d, (SITE - 0.2) - np.maximum(np.abs(x), np.abs(y)))        # boundary wall
    for rx, ry, h, _ in ROCKS:
        d = np.minimum(d, np.hypot((x - rx) / h[0], (y - ry) / h[1]) * min(h[0], h[1]) - min(h[0], h[1]) * 0.86)
    for tx, ty in (TREE_BIG, TREE_SMALL):
        d = np.minimum(d, np.hypot(x - tx, y - ty) - 0.1)
    return d


def ground_z(x, y):
    p = np.stack([x, y], -1)
    z = 0.022 * (fbm(p * 0.55, 3, seed=2) - 0.5) * 2 + 0.006 * (fbm(p * 3.0, 2, seed=3) - 0.5) * 2
    return z - 0.012 * smoothstep(0.06, -0.06, bed_sdf(x, y))


def build_ground():
    n = 460
    g = np.linspace(-SITE + 0.19, SITE - 0.19, n)
    X, Y = np.meshgrid(g, g, indexing="ij")
    Z = ground_z(X, Y)
    v = np.stack([X, Y, Z], -1).reshape(-1, 3)
    i = np.arange(n * n).reshape(n, n)
    q = np.stack([i[:-1, :-1], i[1:, :-1], i[1:, 1:], i[:-1, 1:]], -1).reshape(-1, 4)
    bed = smoothstep(0.05, -0.03, bed_sdf(X, Y)).ravel()
    mesh_obj("ground", v, quads=q, mat=MAT["ground"], smooth=True, attrs={"bed": bed}, coll="Garden")
    c = np.array([(cx, cy, SLAB_TOP - 0.04) for cx, cy, *_ in SLABS])
    h = np.array([(sx / 2, sy / 2, 0.04) for _, _, sx, sy, _ in SLABS])
    R = rot_z(np.radians([r for *_, r in SLABS]))
    rounded_boxes("slabs", c, h, r=0.007, rot=R, mat=MAT["conc_slab"], seed=3, coll="Garden")


# ----------------------------------------------------------------------------
# Instancing through geometry nodes (points with rot / scl / vi attributes)
# ----------------------------------------------------------------------------
def gn_instances(name, pts, rot, scl, vi, variants, coll="Garden"):
    vc = bpy.data.collections.new(name + "_variants")
    for k, o in enumerate(variants):
        o.name = f"{name}_v{k:03d}"
        vc.objects.link(o)
    ob = mesh_obj(name, pts, coll=coll, attrs={"rot": rot, "scl": scl})
    a = ob.data.attributes.new("vi", "INT", "POINT")
    a.data.foreach_set("value", np.asarray(vi, np.int32))
    ng = bpy.data.node_groups.new(name + "_gn", "GeometryNodeTree")
    ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    N = ng.nodes
    gi, go = N.new("NodeGroupInput"), N.new("NodeGroupOutput")
    ci = N.new("GeometryNodeCollectionInfo")
    ci.inputs["Collection"].default_value = vc
    ci.inputs["Separate Children"].default_value = True
    ci.inputs["Reset Children"].default_value = True
    iop = N.new("GeometryNodeInstanceOnPoints")
    iop.inputs["Pick Instance"].default_value = True

    def named(nm, typ):
        nd = N.new("GeometryNodeInputNamedAttribute")
        nd.data_type = typ
        nd.inputs["Name"].default_value = nm
        return nd.outputs[0]
    e2r = N.new("FunctionNodeEulerToRotation")
    L = ng.links
    L.new(named("rot", "FLOAT_VECTOR"), e2r.inputs[0])
    L.new(gi.outputs[0], iop.inputs["Points"])
    L.new(ci.outputs[0], iop.inputs["Instance"])
    L.new(named("vi", "INT"), iop.inputs["Instance Index"])
    L.new(e2r.outputs[0], iop.inputs["Rotation"])
    L.new(named("scl", "FLOAT_VECTOR"), iop.inputs["Scale"])
    L.new(iop.outputs[0], go.inputs[0])
    md = ob.modifiers.new("inst", "NODES")
    md.node_group = ng
    return ob


def icosphere(sub, radius=1.0):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=radius)
    v = np.array([vv.co[:] for vv in bm.verts], np.float64)
    f = np.array([[vv.index for vv in ff.verts] for ff in bm.faces], np.int32)
    bm.free()
    return v, f


def build_pebbles(seed=7):
    rng = np.random.default_rng(seed)
    v0, f0 = icosphere(3)
    variants = []
    for k in range(20):
        sc = np.array([1.0, rng.uniform(0.62, 0.95), rng.uniform(0.36, 0.7)])
        d = 0.75 + 0.5 * fbm(v0 * rng.uniform(0.7, 1.3) + rng.uniform(0, 50, 3), 3, seed=k)
        variants.append(mesh_obj(f"peb{k}", v0 * d[:, None] * sc, tris=f0, mat=MAT["pebble"], smooth=True,
                                 do_link=False))
    sp = 0.027
    g = np.arange(-SITE + 0.22, SITE - 0.22, sp)
    X, Y = np.meshgrid(g, g, indexing="ij")
    X = (X + rng.uniform(-0.5, 0.5, X.shape) * sp).ravel()
    Y = (Y + rng.uniform(-0.5, 0.5, Y.shape) * sp).ravel()
    sd, hd = bed_sdf(X, Y), hard_sdf(X, Y)
    # skip the strips behind the house: never seen by the camera
    front = ~(((X > X1 - 0.3) & (Y > Y0 - 1.0)) | ((Y > Y1 - 0.3) & (X > X0 - 1.0)))
    keep = (hd > 0.0) & front & ((sd < 0.0) | ((sd < 0.09) & (rng.random(len(X)) < 0.10)))
    X, Y, sd = X[keep], Y[keep], sd[keep]
    # second, sparser layer on top
    top = rng.random(len(X)) < 0.45
    X2, Y2 = X[top] + rng.normal(0, 0.01, top.sum()), Y[top] + rng.normal(0, 0.01, top.sum())
    ok = (bed_sdf(X2, Y2) < -0.03) & (hard_sdf(X2, Y2) > 0.01)
    X2, Y2 = X2[ok], Y2[ok]
    n1, n2 = len(X), len(X2)
    r = np.clip(rng.lognormal(math.log(0.0165), 0.28, n1 + n2), 0.008, 0.034)
    xs, ys = np.concatenate([X, X2]), np.concatenate([Y, Y2])
    z = ground_z(xs, ys) + r * 0.28
    z[n1:] += 0.014
    pts = np.stack([xs, ys, z], -1)
    rot = np.stack([rng.normal(0, 0.28, n1 + n2), rng.normal(0, 0.28, n1 + n2), rng.uniform(0, 6.283, n1 + n2)], -1)
    scl = np.repeat(r[:, None], 3, 1)
    gn_instances("pebbles", pts, rot, scl, rng.integers(0, len(variants), n1 + n2), variants)
    log(f"  pebbles: {n1 + n2}")


def build_rocks():
    sc = bpy.context.scene
    for k, (rx, ry, h, seed) in enumerate(ROCKS):
        rng = np.random.default_rng(seed)
        npts = 13
        d = unit(rng.normal(size=(npts, 3)))
        d[:, 2] = np.abs(d[:, 2]) * 0.95 - 0.3                 # flatter underside
        pts = d * rng.uniform(0.8, 1.0, (npts, 1)) * np.array(h)
        bm = bmesh.new()
        for p_ in pts:
            bm.verts.new(p_)
        res = bmesh.ops.convex_hull(bm, input=bm.verts)
        junk = list({e for e in res.get("geom_interior", []) + res.get("geom_unused", [])
                     if isinstance(e, bmesh.types.BMVert)})
        if junk:
            bmesh.ops.delete(bm, geom=junk, context="VERTS")
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(h) * 0.07, segments=2, affect="EDGES", profile=0.6)
        me = bpy.data.meshes.new("rock_tmp")
        bm.to_mesh(me)
        bm.free()
        tmp = bpy.data.objects.new("rock_tmp", me)
        sc.collection.objects.link(tmp)
        md = tmp.modifiers.new("r", "REMESH")
        md.mode = "VOXEL"
        md.voxel_size = max(0.006, min(h) / 30.0)
        md.use_smooth_shade = True
        dg = bpy.context.evaluated_depsgraph_get()
        em = tmp.evaluated_get(dg).to_mesh()
        nv = len(em.vertices)
        v = np.empty(nv * 3, np.float32)
        em.vertices.foreach_get("co", v)
        nrm = np.empty(nv * 3, np.float32)
        em.vertices.foreach_get("normal", nrm)
        tot = np.empty(len(em.polygons), np.int32)
        em.polygons.foreach_get("loop_total", tot)
        lv = np.empty(len(em.loops), np.int32)
        em.loops.foreach_get("vertex_index", lv)
        st = np.concatenate([[0], np.cumsum(tot)[:-1]])
        q = np.stack([lv[st[tot == 4] + i] for i in range(4)], -1)
        t3 = np.stack([lv[st[tot == 3] + i] for i in range(3)], -1) if np.any(tot == 3) else None
        v = v.reshape(-1, 3).astype(np.float64)
        nrm = nrm.reshape(-1, 3).astype(np.float64)
        tmp.evaluated_get(dg).to_mesh_clear()
        bpy.data.objects.remove(tmp)
        bpy.data.meshes.remove(me)
        s_ = float(np.mean(h))
        off = rng.uniform(0, 100, 3)
        tilt = unit(np.array([rng.normal(0, 0.35), rng.normal(0, 0.35), 1.0]))
        n1 = fbm(v / s_ * 1.3 + off, 3, seed=seed) - 0.5                              # broad swell
        lay = fbm(np.stack([v[:, 0], v[:, 1], (v @ tilt) * 5.0], -1) / s_ * 1.2 + off, 4, seed=seed + 3)
        terr = np.floor(lay * 9.0) / 9.0 - lay                                        # stepped bedding planes
        chip = fbm(v / s_ * 4.5 + off, 3, seed=seed + 5)
        chipd = np.floor(chip * 5.0) / 5.0 - chip                                     # conchoidal chips
        n3 = fbm(v / s_ * 14.0 + off, 3, seed=seed + 7) - 0.5
        v = v + nrm * (s_ * 0.16 * n1 + s_ * 0.55 * terr + s_ * 0.28 * chipd + s_ * 0.03 * n3)[:, None]
        a_ = rng.uniform(0, 6.283)
        v = v @ rot_z(np.array(a_)).T
        v = v + np.array([rx, ry, h[2] * 0.36 + float(ground_z(np.array(rx), np.array(ry)))])
        mesh_obj(f"rock{k}", v, tris=t3, quads=q, mat=MAT["rock"], smooth=True, coll="Garden")


# ----------------------------------------------------------------------------
# Lawn: every blade is its own tapered, bent strip
# ----------------------------------------------------------------------------
def blades_mesh(name, base, height, width, lean_dir, bend, twist, mat, attrs, levels=(0.0, 0.36, 0.7, 1.0),
                wprof=(1.0, 0.86, 0.56), coll="Garden"):
    """base (N,3), height/width/bend/twist (N,), lean_dir (N,2) unit. Returns the mesh object."""
    N = len(base)
    L = len(levels)
    t = np.array(levels)[None, :]                                              # (1,L)
    zz = height[:, None] * t * (1.0 - 0.32 * bend[:, None] * t)
    rr = height[:, None] * bend[:, None] * t ** 1.8
    spine = np.stack([base[:, 0:1] + lean_dir[:, 0:1] * rr, base[:, 1:2] + lean_dir[:, 1:2] * rr,
                      base[:, 2:3] + zz], -1)                                  # (N,L,3)
    ca, sa = np.cos(twist), np.sin(twist)
    cx = -lean_dir[:, 1] * ca - lean_dir[:, 0] * sa
    cy = lean_dir[:, 0] * ca - lean_dir[:, 1] * sa
    cross = np.stack([cx, cy, np.zeros(N)], -1)[:, None, :]                    # (N,1,3)
    w = (width[:, None] * np.array(wprof)[None, :] * 0.5)[..., None]           # (N,L-1,1)
    left = spine[:, :L - 1] - cross * w
    right = spine[:, :L - 1] + cross * w
    K = 2 * (L - 1) + 1
    verts = np.empty((N, K, 3), np.float32)
    verts[:, 0:2 * (L - 1):2] = left
    verts[:, 1:2 * (L - 1):2] = right
    verts[:, K - 1] = spine[:, L - 1]
    off = (np.arange(N, dtype=np.int64) * K)[:, None]
    quads = []
    for i in range(L - 2):
        a = 2 * i
        quads.append(np.stack([off[:, 0] + a, off[:, 0] + a + 1, off[:, 0] + a + 3, off[:, 0] + a + 2], -1))
    quads = np.stack(quads, 1).reshape(-1, 4)
    a = 2 * (L - 2)
    tris = np.stack([off[:, 0] + a, off[:, 0] + a + 1, off[:, 0] + K - 1], -1)
    tv = np.empty(K, np.float32)
    tv[0:2 * (L - 1):2] = levels[:-1]
    tv[1:2 * (L - 1):2] = levels[:-1]
    tv[K - 1] = 1.0
    at = {"t": np.tile(tv, N)}
    for k, val in attrs.items():
        at[k] = np.repeat(np.asarray(val, np.float32), K)
    return mesh_obj(name, verts.reshape(-1, 3), tris=tris, quads=quads, mat=mat, attrs=at, coll=coll)


def build_lawn(spacing=0.0165, seed=21):
    rng = np.random.default_rng(seed)
    g = np.arange(-SITE + 0.2, SITE - 0.2, spacing)
    X, Y = np.meshgrid(g, g, indexing="ij")
    X = (X + rng.uniform(-0.5, 0.5, X.shape) * spacing).ravel()
    Y = (Y + rng.uniform(-0.5, 0.5, Y.shape) * spacing).ravel()
    hd, bd = hard_sdf(X, Y), bed_sdf(X, Y)
    thin = smoothstep(-0.02, 0.07, bd)                    # lawn thins out into the pebbles
    keep = (hd > 0.004) & (rng.random(len(X)) < thin)
    X, Y, hd = X[keep], Y[keep], hd[keep]
    nt = len(X)
    P2 = np.stack([X, Y], -1)
    patch = fbm(P2 * 0.45, 3, seed=11)                    # metre-scale vigour
    patch2 = fbm(P2 * 2.2, 3, seed=12)
    fringe = smoothstep(0.075, 0.0, hd)                   # unmown edge next to anything solid
    th = 0.052 * (0.6 + 0.85 * patch) * (0.8 + 0.4 * patch2) * (1 + 0.85 * fringe) * rng.lognormal(0, 0.16, nt)
    th = th * np.where(rng.random(nt) < 0.006, rng.uniform(1.8, 2.8, nt), 1.0)   # stray tufts the mower missed
    cnt = rng.poisson(5.2, nt) + 1
    idx = np.repeat(np.arange(nt), cnt)
    N = len(idx)
    ang = rng.uniform(0, 6.283, N)
    rad = np.abs(rng.normal(0, 0.006, N))
    bx, by = X[idx] + np.cos(ang) * rad, Y[idx] + np.sin(ang) * rad
    base = np.stack([bx, by, ground_z(bx, by) - 0.003], -1)
    h = th[idx] * rng.uniform(0.55, 1.18, N)
    w = rng.uniform(0.0034, 0.0058, N) * (0.8 + 0.4 * patch[idx])
    la = ang + rng.normal(0, 0.9, N)                      # lean roughly outward from the tuft
    wind = np.array([0.55, 0.3])
    ld = unit(np.stack([np.cos(la), np.sin(la)], -1) + wind * 0.45)
    bend = np.clip(rng.normal(0.42, 0.2, N) + 0.25 * fringe[idx], 0.06, 1.1)
    tw = rng.normal(0, 0.6, N)
    dry = np.clip(0.55 * (fbm(P2 * 0.8, 3, seed=14)[idx] - 0.42) * 2 + rng.normal(0, 0.22, N), 0, 1)
    dry = np.where(rng.random(N) < 0.07, 1.0, dry * 0.75)
    blades_mesh("lawn", base, h, w, ld, bend, tw, MAT["grass"],
                {"rnd": rng.random(N), "dry": dry, "vig": patch[idx]})
    log(f"  lawn: {nt} tufts, {N} blades")


def build_ornamental_grass():
    Vs, Qs, Ts, A = [], [], [], {"t": [], "rnd": [], "dry": [], "plume": []}
    nv = 0
    K = 11
    for (gx, gy, H, seed) in OGRASS:
        rng = np.random.default_rng(seed)
        gz = float(ground_z(np.array(gx), np.array(gy)))
        nb = int(1500 * H)
        npl = int(rng.integers(16, 30))
        kinds = [("blade", nb), ("stem", npl)]
        for kind, n in kinds:
            r0 = np.abs(rng.normal(0, 0.055 * H, n))
            az = rng.uniform(0, 6.283, n)
            base = np.stack([gx + np.cos(az) * r0, gy + np.sin(az) * r0, np.full(n, gz - 0.01)], -1)
            az = az + rng.normal(0, 0.5, n)
            if kind == "blade":
                Lb = H * rng.uniform(0.45, 1.12, n) * (1 - 0.25 * rng.random(n) ** 3)
                th0 = np.abs(rng.normal(0, 0.20, n)) + r0 / (0.055 * H + 1e-6) * 0.16
                droop = np.clip(rng.normal(1.05, 0.5, n), 0.15, 2.4)
                w0 = rng.uniform(0.0045, 0.0085, n)
            else:
                Lb = H * rng.uniform(1.15, 1.5, n)
                th0 = np.abs(rng.normal(0, 0.10, n)) + 0.03
                droop = np.clip(rng.normal(0.35, 0.15, n), 0.05, 0.8)
                w0 = np.full(n, 0.0028)
            s = np.linspace(0, 1, K)[None, :]
            th = th0[:, None] + droop[:, None] * s ** 1.7
            ds = (Lb / (K - 1))[:, None]
            dxy = np.sin(th) * ds
            dz = np.cos(th) * ds
            rr = np.concatenate([np.zeros((n, 1)), np.cumsum(dxy[:, :-1], 1)], 1)
            zz = np.concatenate([np.zeros((n, 1)), np.cumsum(dz[:, :-1], 1)], 1)
            dirx, diry = np.cos(az)[:, None], np.sin(az)[:, None]
            spine = np.stack([base[:, 0:1] + dirx * rr, base[:, 1:2] + diry * rr, base[:, 2:3] + zz], -1)
            tw = rng.normal(0, 0.5, n)[:, None] + s * rng.normal(0, 0.9, n)[:, None]
            cx = -diry * np.cos(tw) - dirx * np.sin(tw) * 0.0
            cy = dirx * np.cos(tw)
            cz = np.sin(tw) * 0.6
            cross = unit(np.stack([cx, cy, cz], -1))
            if kind == "blade":
                prof = (0.5 + 0.5 * np.minimum(1.0, s * 5)) * (1 - s) ** 0.55
            else:
                prof = np.ones_like(s) * (1 - 0.5 * s)
            wv = (w0[:, None] * prof * 0.5)[..., None]
            Lf = spine - cross * wv
            Rt = spine + cross * wv
            vv = np.empty((n, 2 * K, 3))
            vv[:, 0::2] = Lf
            vv[:, 1::2] = Rt
            off = nv + (np.arange(n) * 2 * K)[:, None]
            a = (np.arange(K - 1) * 2)[None, :]
            Qs.append(np.stack([off + a, off + a + 1, off + a + 3, off + a + 2], -1).reshape(-1, 4))
            Vs.append(vv.reshape(-1, 3))
            nv += n * 2 * K
            A["t"].append(np.repeat(s, 2, axis=1).repeat(n, 0).ravel())
            rnd = rng.random(n)
            if kind == "blade":
                dry = np.where(rng.random(n) < 0.36, rng.uniform(0.7, 1.0, n), rng.uniform(0.0, 0.35, n))
            else:
                dry = np.full(n, 0.9)
            A["rnd"].append(np.repeat(rnd, 2 * K))
            A["dry"].append(np.repeat(dry, 2 * K))
            A["plume"].append(np.zeros(n * 2 * K))
            if kind == "stem":
                # feathery plume: short fine spikelets along the top fifth of every stem
                per = 150
                si = rng.integers(0, n, n * per)
                u = rng.uniform(0.76, 1.0, n * per) ** 0.9
                fi = u * (K - 1)
                i0 = np.minimum(fi.astype(int), K - 2)
                fr = (fi - i0)[:, None]
                p0 = spine[si, i0] * (1 - fr) + spine[si, i0 + 1] * fr
                tg = unit(spine[si, i0 + 1] - spine[si, i0])
                rv = unit(rng.normal(size=(n * per, 3)))
                side = unit(rv - tg * np.sum(rv * tg, -1, keepdims=True))
                spread = rng.uniform(0.25, 0.6, n * per)[:, None] * (1.15 - u)[:, None] * 2.2
                dvec = unit(tg + side * spread + np.array([0, 0, -0.12]))
                ln = rng.uniform(0.018, 0.045, n * per)[:, None] * (1.25 - u)[:, None] * 1.6
                cr = unit(np.cross(dvec, rv)) * 0.0011
                p1 = p0 + dvec * ln * 0.55 + np.array([0, 0, -0.002])
                p2 = p0 + dvec * ln + np.array([0, 0, -0.006])
                m_ = n * per
                vq = np.stack([p0 - cr, p0 + cr, p1 + cr * 1.2, p1 - cr * 1.2, p2], 1)
                o2 = nv + (np.arange(m_) * 5)[:, None]
                Qs.append(np.concatenate([o2 + 0, o2 + 1, o2 + 2, o2 + 3], 1))
                Ts.append(np.concatenate([o2 + 3, o2 + 2, o2 + 4], 1))
                Vs.append(vq.reshape(-1, 3))
                nv += m_ * 5
                A["t"].append(np.tile(np.array([0, 0, 0.5, 0.5, 1.0]), m_))
                A["rnd"].append(np.repeat(rng.random(m_), 5))
                A["dry"].append(np.ones(m_ * 5))
                A["plume"].append(np.ones(m_ * 5))
    mesh_obj("ornamental_grass", np.concatenate(Vs), tris=np.concatenate(Ts), quads=np.concatenate(Qs),
             mat=MAT["ograss"], attrs={k: np.concatenate(v) for k, v in A.items()}, coll="Garden")


def build_garden_materials():
    # ---- soil under the lawn blended into the pale gravel under the pebbles
    m = M("ground")
    bed = m.attr("bed")
    m, a = surf("", "forrest_ground_01", 2.0, (0.045, 0.05, 0.022), rough=0.9, bump=0.8, bdist=0.02, m=m)
    m, b = surf("", "gravel_floor_02", 1.2, (0.52, 0.50, 0.46), rough=0.75, bump=1.0, bdist=0.02, m=m)
    col = m.mix(bed, a["col"], b["col"])
    r = m.mixf(bed, a["rough"], b["rough"])
    nrm = m.n("ShaderNodeMix", {0: bed, 4: a["normal"], 5: b["normal"]}, data_type="VECTOR").outputs[1]
    MAT["ground"] = done(m, {"col": col, "rough": r, "normal": nrm}, spec=0.3)

    # ---- white pebbles (instances -> Object Info random)
    m = M("pebble")
    rnd = m.oi.outputs["Random"]
    obj = m.tc.outputs["Object"]
    base = m.ramp(rnd, [(0.0, (0.78, 0.77, 0.73)), (0.45, (0.72, 0.70, 0.65)), (0.7, (0.62, 0.59, 0.52)),
                        (0.86, (0.47, 0.46, 0.44)), (0.95, (0.74, 0.66, 0.54)), (1.0, (0.2, 0.2, 0.2))])
    mot = m.noise(m.vmath("ADD", obj, m.vmath("SCALE", m.rgb((9, 5, 3)), scale=rnd)), 2.2, 4.0, 0.6)
    col = tone(m, base, m.maprange(mot, 0.25, 0.75, 0.82, 1.1))
    vein = m.maprange(m.noise(m.vmath("ADD", obj, m.vmath("SCALE", m.rgb((4, 8, 2)), scale=rnd)), 5.0, 2.0, 0.5, dist=2.5),
                      0.47, 0.5)
    col = m.mix(m.mul(vein, 0.0), col, m.rgb((0.9, 0.9, 0.88)))
    ao = m.ao_mask(0.03, 4)
    col = m.mix(m.mul(ao, 0.45), col, m.rgb((0.20, 0.17, 0.13)))
    rr = m.maprange(mot, 0.2, 0.8, 0.5, 0.78)
    nb = m.bump(m.noise(obj, 14.0, 3.0, 0.6), 0.25, 0.05)
    MAT["pebble"] = done(m, {"col": col, "rough": rr, "normal": nb}, spec=0.45)

    # ---- dark grey rock
    m, s = surf("rock", "rock_boulder_dry", 1.1, (0.225, 0.22, 0.21), rough=0.8, bump=1.0, bdist=0.03, contrast=1.3)
    P = m.P
    z = m.xyz(P)[2]
    pt = m.geo.outputs["Pointiness"]
    col = s["col"]
    col = tone(m, col, m.maprange(pt, 0.42, 0.58, 0.55, 1.6))
    lich = m.mul(m.maprange(m.noise(P, 9.0, 5.0, 0.7), 0.6, 0.72), m.maprange(m.xyz(m.geo.outputs["Normal"])[2], 0.1, 0.8))
    col = m.mix(m.mul(lich, 0.55), col, m.rgb((0.32, 0.34, 0.27)))
    damp = m.mul(m.maprange(z, 0.14, 0.0, 0.0, 1.0), m.maprange(m.noise(P, 6.0, 4.0), 0.25, 0.7, 0.3, 1.0))
    col = m.mix(m.mul(damp, 0.55), col, m.rgb((0.05, 0.048, 0.03)))
    s["col"] = col
    s["rough"] = m.sub(s["rough"], m.mul(m.maprange(pt, 0.5, 0.58), 0.18))
    disp = m.n("ShaderNodeDisplacement", {"Height": s["height"], "Midlevel": 0.5, "Scale": 0.02}).outputs[0]
    MAT["rock"] = done(m, s, spec=0.4, disp=disp)
    MAT["rock"].displacement_method = "BOTH"

    # ---- lawn blades
    def blade_mat(name, greens, straws, tip_dry, trans, rough):
        m = M(name)
        t, rnd, dry = m.attr("t"), m.attr("rnd"), m.attr("dry")
        green = m.ramp(rnd, greens)
        col = tone(m, green, m.maprange(t, 0.0, 1.0, 0.42, 1.28))
        straw = tone(m, m.ramp(rnd, straws), m.maprange(t, 0.0, 1.0, 0.7, 1.1))
        tipd = m.mul(m.math("POWER", t, 3.0), tip_dry)
        dm = m.sat(m.add(m.maprange(dry, 0.45, 0.8), m.mul(tipd, m.maprange(dry, 0.0, 0.5, 0.3, 1.0))))
        col = m.mix(dm, col, straw)
        return m, col, dm
    m, col, dm = blade_mat("grass", [(0.0, (0.040, 0.098, 0.014)), (0.5, (0.068, 0.142, 0.022)), (1.0, (0.118, 0.180, 0.030))],
                           [(0.0, (0.30, 0.23, 0.10)), (1.0, (0.44, 0.35, 0.16))], 0.5, 0.36, 0.42)
    vig = m.attr("vig")
    col = tone(m, col, m.maprange(vig, 0.25, 0.75, 1.32, 0.72))
    col = m.mix(m.maprange(vig, 0.3, 0.7, 0.42, 0.0), col, tone(m, col, m.rgb((1.3, 1.12, 0.55))))
    bs = m.n("ShaderNodeBsdfPrincipled", {"Base Color": col, "Roughness": 0.42, "Specular IOR Level": 0.35})
    tr = m.n("ShaderNodeBsdfTranslucent", {"Color": tone(m, col, m.rgb((1.5, 1.45, 0.75)))})
    mx = m.n("ShaderNodeMixShader", {0: m.mixf(dm, 0.38, 0.22), 1: bs.outputs[0], 2: tr.outputs[0]})
    MAT["grass"] = m.finish(mx.outputs[0])

    m, col, dm = blade_mat("ograss", [(0.0, (0.05, 0.10, 0.02)), (0.5, (0.085, 0.14, 0.028)), (1.0, (0.16, 0.19, 0.04))],
                           [(0.0, (0.40, 0.30, 0.13)), (1.0, (0.58, 0.47, 0.24))], 0.9, 0.4, 0.45)
    pl = m.attr("plume")
    col = m.mix(pl, col, m.ramp(m.attr("rnd"), [(0.0, (0.52, 0.40, 0.24)), (1.0, (0.70, 0.60, 0.42))]))
    bs = m.n("ShaderNodeBsdfPrincipled", {"Base Color": col, "Roughness": 0.45, "Specular IOR Level": 0.4})
    tr = m.n("ShaderNodeBsdfTranslucent", {"Color": tone(m, col, m.rgb((1.4, 1.3, 0.85)))})
    mx = m.n("ShaderNodeMixShader", {0: m.mixf(pl, 0.36, 0.55), 1: bs.outputs[0], 2: tr.outputs[0]})
    MAT["ograss"] = m.finish(mx.outputs[0])


# ----------------------------------------------------------------------------
# Trees and shrubs: recursive branching skeleton -> bark tubes + one mesh leaf per leaf
# ----------------------------------------------------------------------------
BARK_TILE = 0.42          # metres of circumference covered by one bark texture tile


class Tree:
    def __init__(self, seed, P, env=None):
        self.rng = np.random.default_rng(seed)
        self.P = P
        self.env = env
        self.V, self.Q, self.T, self.UVq, self.UVt = [], [], [], [], []
        self.nv = 0
        self.lp, self.la, self.ln, self.ls, self.lc = [], [], [], [], []
        self.nbranch = 0

    # -- geometry ----------------------------------------------------------
    def tube(self, pts, rad, sides):
        n = len(pts)
        tang = unit(np.gradient(pts, axis=0))
        a = np.array([0.0, 0.0, 1.0]) if abs(tang[0][2]) < 0.9 else np.array([1.0, 0.0, 0.0])
        U = np.empty((n, 3))
        U[0] = unit(np.cross(tang[0], a))
        for i in range(1, n):
            U[i] = unit(U[i - 1] - tang[i] * np.dot(U[i - 1], tang[i]))
        W = np.cross(tang, U)
        ang = np.linspace(0, 2 * math.pi, sides, endpoint=False)
        ring = (np.cos(ang)[None, :, None] * U[:, None, :] + np.sin(ang)[None, :, None] * W[:, None, :]) \
            * rad[:, None, None] + pts[:, None, :]
        idx = self.nv + np.arange(n * sides).reshape(n, sides)
        a_, b_ = idx[:-1], np.roll(idx[:-1], -1, axis=1)
        c_, d_ = np.roll(idx[1:], -1, axis=1), idx[1:]
        self.Q.append(np.stack([a_, b_, c_, d_], -1).reshape(-1, 4))
        seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        arc = np.concatenate([[0.0], np.cumsum(seg)])
        circ = 2 * math.pi * rad[0]
        nrep = max(1, int(round(circ / BARK_TILE)))
        vv = arc * nrep / circ + self.rng.uniform(0, 5)
        u0 = np.arange(sides) / sides * nrep
        u1 = (np.arange(sides) + 1) / sides * nrep
        uv = np.empty((n - 1, sides, 4, 2))
        uv[:, :, 0, 0], uv[:, :, 1, 0], uv[:, :, 2, 0], uv[:, :, 3, 0] = u0, u1, u1, u0
        uv[:, :, 0, 1] = uv[:, :, 1, 1] = vv[:-1, None]
        uv[:, :, 2, 1] = uv[:, :, 3, 1] = vv[1:, None]
        self.UVq.append(uv.reshape(-1, 2))
        tip = pts[-1] + tang[-1] * rad[-1] * 1.5
        ti = self.nv + n * sides
        last = idx[-1]
        self.T.append(np.stack([last, np.roll(last, -1), np.full(sides, ti)], -1))
        tuv = np.empty((sides, 3, 2))
        tuv[:, 0, 0], tuv[:, 1, 0], tuv[:, 2, 0] = u0, u1, (u0 + u1) / 2
        tuv[:, 0, 1] = tuv[:, 1, 1] = vv[-1]
        tuv[:, 2, 1] = vv[-1] + 0.05
        self.UVt.append(tuv.reshape(-1, 2))
        self.V.append(np.concatenate([ring.reshape(-1, 3), tip[None]]))
        self.nv += n * sides + 1

    def grow(self, start, d, length, r0, level, cval=0.5):
        P, rng = self.P, self.rng
        n = max(2, int(math.ceil(length / P["seg"][level])))
        step = length / n
        pts = [np.asarray(start, float)]
        d = unit(d)
        up = np.array([0.0, 0.0, 1.0])
        for i in range(n):
            d = unit(d + rng.normal(0, P["wander"][level], 3) + up * P["trop"][level] * step)
            p = pts[-1] + d * step
            if self.env is not None and i > 0 and not self.env(p):
                break
            pts.append(p)
        pts = np.array(pts)
        n = len(pts) - 1
        if n < 1:
            return
        length = step * n
        tt = np.linspace(0, 1, n + 1)
        rtip = max(P["rtip"], r0 * P["taper"][level])
        rad = rtip + (r0 - rtip) * (1 - tt) ** P.get("tpow", 0.85)
        if level == 0:
            rad = rad * (1 + P.get("flare", 0.6) * np.exp(-tt * length / 0.07))
        self.tube(pts, rad, P["sides"][level])
        self.nbranch += 1
        if level < P["levels"] - 1:
            nx = level + 1
            st = P["start"][nx]
            cnt = int(round(P["dens"][nx] * length * (1 - st) * rng.uniform(0.85, 1.15)))
            cnt = max(cnt, P.get("minchild", 1))
            phi = rng.uniform(0, 2 * math.pi)
            for j in range(cnt):
                tc = st + (1 - st) * ((j + rng.uniform(0.15, 0.85)) / cnt)
                fi = tc * n
                i = min(n - 1, int(fi))
                f = fi - i
                pos = pts[i] * (1 - f) + pts[i + 1] * f
                tg = unit(pts[i + 1] - pts[i])
                rr = rad[i] * (1 - f) + rad[i + 1] * f
                phi += 2.39996 + rng.normal(0, 0.4)
                ang = math.radians(P["angle"][nx] + rng.normal(0, P["avar"][nx]))
                a = up if abs(tg[2]) < 0.95 else np.array([1.0, 0.0, 0.0])
                e1 = unit(np.cross(tg, a))
                e2 = np.cross(tg, e1)
                side = math.cos(phi) * e1 + math.sin(phi) * e2
                cd = math.cos(ang) * tg + math.sin(ang) * side
                tprime = (tc - st) / (1 - st + 1e-9)
                clen = length * P["ratio"][nx] * P["shape"][nx](tprime) * rng.uniform(0.75, 1.2)
                clen = max(clen, P["minlen"][nx])
                cr = max(P["rtip"] * 1.15, min(rr * 0.9, rr * P["rratio"][nx]))
                cv = rng.random() if nx == P.get("clevel", 1) else float(np.clip(cval + rng.normal(0, 0.07), 0, 1))
                self.grow(pos, cd, clen, cr, nx, cv)
        if level >= P["leaf_level"]:
            self.add_leaves(pts, level, cval)

    def add_leaves(self, pts, level, cval):
        P, rng = self.P, self.rng
        seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        arc = np.concatenate([[0.0], np.cumsum(seg)])
        L = arc[-1]
        s0 = L * P["leaf_from"]
        m = max(1, int((L - s0) / P["leaf_step"]))
        ss = s0 + (np.arange(m) + rng.uniform(0.1, 0.9, m)) * (L - s0) / m
        ss = np.concatenate([ss, [L]])                                   # terminal leaf
        i = np.clip(np.searchsorted(arc, ss) - 1, 0, len(pts) - 2)
        f = ((ss - arc[i]) / (seg[i] + 1e-9))[:, None]
        pos = pts[i] * (1 - f) + pts[i + 1] * f
        tg = unit(pts[i + 1] - pts[i])
        k = len(ss)
        phi = rng.uniform(0, 6.283) + np.arange(k) * 2.4 + rng.normal(0, 0.5, k)
        a = np.where(np.abs(tg[:, 2:3]) < 0.95, np.array([[0.0, 0.0, 1.0]]), np.array([[1.0, 0.0, 0.0]]))
        e1 = unit(np.cross(tg, a))
        e2 = np.cross(tg, e1)
        side = np.cos(phi)[:, None] * e1 + np.sin(phi)[:, None] * e2
        droop = rng.uniform(P["droop"][0], P["droop"][1], k)[:, None]
        axis = unit(side * 0.9 + tg * 0.45 + np.array([[0.0, 0.0, -1.0]]) * droop)
        axis[-1] = unit(tg[-1] + np.array([0, 0, -0.3]))
        nrm = np.array([[0.0, 0.0, 1.0]]) + rng.normal(0, 0.45, (k, 3))
        size = P["leaf_size"] * rng.uniform(0.7, 1.2, k)
        self.lp.append(pos + axis * 0.006)
        self.la.append(axis)
        self.ln.append(nrm)
        self.ls.append(size)
        self.lc.append(np.clip(cval + rng.normal(0, 0.08, k), 0, 1))

    # -- output ------------------------------------------------------------
    def bark(self, name, mat, coll="Garden"):
        return mesh_obj(name, np.concatenate(self.V), tris=np.concatenate(self.T), quads=np.concatenate(self.Q),
                        mat=mat, smooth=True, coll=coll,
                        loop_uv=np.concatenate([np.concatenate(self.UVt), np.concatenate(self.UVq)]))

    def leaf_data(self):
        return (np.concatenate(self.lp), np.concatenate(self.la), np.concatenate(self.ln),
                np.concatenate(self.ls), np.concatenate(self.lc))


_LV = np.array([0.0, 0.22, 0.5, 0.8, 1.0, 0.22, 0.5, 0.8, 0.22, 0.5, 0.8])
_LU = np.array([0.0, 0.0, 0.0, 0.0, 0.0, -0.80, -1.0, -0.64, 0.80, 1.0, 0.64])
_LT = np.array([[0, 1, 8], [3, 4, 10], [0, 5, 1], [3, 7, 4]], np.int32)
_LQ = np.array([[1, 2, 9, 8], [2, 3, 10, 9], [1, 5, 6, 2], [2, 6, 7, 3]], np.int32)


def leaves_mesh(name, pos, axis, nrm, size, cval, mat, aspect=0.56, fold=0.28, curl=0.25, seed=0, coll="Garden"):
    """One 11-vertex folded, curled leaf per entry."""
    rng = np.random.default_rng(seed)
    N = len(pos)
    axis = unit(axis)
    nrm = unit(nrm - axis * np.sum(nrm * axis, -1, keepdims=True))
    b = np.cross(nrm, axis)
    L = size[:, None]
    hw = (size * aspect * 0.5 * rng.uniform(0.85, 1.15, N))[:, None]
    v = _LV[None, :] * L
    u = _LU[None, :] * hw
    cu = (curl * rng.uniform(0.2, 1.6, N))[:, None]
    fo = (fold * rng.uniform(0.3, 1.5, N))[:, None]
    w = fo * np.abs(u) - cu * L * _LV[None, :] ** 2 + (rng.normal(0, 0.03, (N, 11)) * L)
    verts = pos[:, None, :] + axis[:, None, :] * v[..., None] + b[:, None, :] * u[..., None] + nrm[:, None, :] * w[..., None]
    off = (np.arange(N) * 11)[:, None, None]
    rnd = rng.random(N)
    luv = np.stack([np.broadcast_to(_LU[None, :], (N, 11)), np.broadcast_to(_LV[None, :], (N, 11)),
                    np.broadcast_to(rnd[:, None], (N, 11))], -1)
    return mesh_obj(name, verts.reshape(-1, 3), tris=(_LT[None] + off).reshape(-1, 3),
                    quads=(_LQ[None] + off).reshape(-1, 4), mat=mat, smooth=True, coll=coll,
                    attrs={"luv": luv.reshape(-1, 3), "lc": np.repeat(cval, 11)})


def _crown(t):
    return 0.14 + 0.86 * math.sin(math.pi * (0.22 + 0.78 * t)) ** 0.75


def _lin(t):
    return 1.0 - 0.55 * t


TREE_P = dict(
    levels=5, leaf_level=3, clevel=1, rtip=0.0013, tpow=0.85, flare=0.7,
    seg=[0.2, 0.11, 0.065, 0.04, 0.03], wander=[0.03, 0.055, 0.075, 0.085, 0.09],
    trop=[0.10, 0.5, 0.28, 0.05, -0.3], taper=[0.08, 0.2, 0.3, 0.4, 0.55], sides=[14, 9, 6, 4, 3],
    dens=[0, 3.0, 7.5, 14.0, 21.0], start=[0, 0.33, 0.18, 0.15, 0.2], angle=[0, 46, 52, 48, 46],
    avar=[0, 9, 12, 13, 15], ratio=[0, 0.31, 0.50, 0.46, 0.44], rratio=[0, 0.42, 0.55, 0.6, 0.7],
    minlen=[0, 0.25, 0.14, 0.07, 0.04], shape=[None, _crown, _lin, _lin, _lin],
    leaf_from=0.15, leaf_step=0.018, leaf_size=0.058, droop=(0.25, 1.1),
)


def autumn_thin(pos, ax, nr, sz, cv, base, height, loss, seed):
    """Autumn leaf drop (more at the exposed top and outer tips) and a hue drift:
    sun-facing, outer leaves turn first; shaded inner ones stay yellow."""
    rng = np.random.default_rng(seed)
    hn = np.clip(pos[:, 2] / height, 0, 1)
    rad = np.hypot(pos[:, 0] - base[0], pos[:, 1] - base[1])
    rn = np.clip(rad / (rad.max() + 1e-6), 0, 1)
    patch = fbm(pos * 1.6 + seed, 3, seed=seed)                     # whole twigs that are already bare
    drop = loss * (0.5 + 1.2 * hn ** 2 + 0.6 * rn) + 0.4 * smoothstep(0.66, 0.8, patch)
    keep = rng.random(len(pos)) > drop
    sunward = np.clip((pos[:, :2] - np.array(base)) @ np.array(sun_dir()[:2]) / (rad.max() + 1e-6), -1, 1)
    cv = np.clip(cv * 0.8 + 0.16 * hn + 0.12 * sunward + 0.1 * rn - 0.08 + 0.25 * (fbm(pos * 0.9, 2, seed=seed + 1) - 0.5), 0, 1)
    return pos[keep], ax[keep], nr[keep], sz[keep], cv[keep]


def build_trees():
    """Returns leaf positions of both trees (used to scatter fallen leaves)."""
    out = []
    # --- tall multi-stem tree left of the house
    gz = float(ground_z(np.array(TREE_BIG[0]), np.array(TREE_BIG[1])))
    T = Tree(101, TREE_P)
    stems = [(0.3, 8.0, 6.35, 0.060), (2.5, 11.0, 5.8, 0.052), (4.5, 10.0, 5.2, 0.045)]
    for az, lean, ln, r0 in stems:
        l = math.radians(lean)
        d = (math.sin(l) * math.cos(az), math.sin(l) * math.sin(az), math.cos(l))
        st = (TREE_BIG[0] + 0.07 * math.cos(az), TREE_BIG[1] + 0.07 * math.sin(az), gz - 0.05)
        T.grow(st, d, ln, r0, 0)
    T.bark("tree_big_bark", MAT["bark"])
    pos, ax, nr, sz, cv = autumn_thin(*T.leaf_data(), TREE_BIG, 6.2, 0.14, 11)
    leaves_mesh("tree_big_leaves", pos, ax, nr, sz, cv, MAT["leaf"], seed=1)
    log(f"  big tree: {T.nbranch} branches, {len(pos)} leaves")
    out.append(pos)
    # --- small single-stem tree in the front-right corner
    P2 = dict(TREE_P)
    P2.update(dens=[0, 8.0, 10.0, 17.0, 24.0], start=[0, 0.33, 0.16, 0.15, 0.2], ratio=[0, 0.42, 0.5, 0.46, 0.44],
              sides=[12, 8, 6, 4, 3], leaf_size=0.054)
    gz = float(ground_z(np.array(TREE_SMALL[0]), np.array(TREE_SMALL[1])))
    T = Tree(202, P2)
    T.grow((TREE_SMALL[0], TREE_SMALL[1], gz - 0.05), (0.05, 0.03, 1.0), 3.1, 0.036, 0)
    T.bark("tree_small_bark", MAT["bark"])
    pos, ax, nr, sz, cv = autumn_thin(*T.leaf_data(), TREE_SMALL, 3.2, 0.10, 12)
    leaves_mesh("tree_small_leaves", pos, ax, nr, sz, cv, MAT["leaf"], seed=2)
    log(f"  small tree: {T.nbranch} branches, {len(pos)} leaves")
    out.append(pos)
    return out


def shrub(name, seed, center, radii, mat, stems=30, leaf_size=0.03, leaf_step=0.009, hollow=0.5, cshift=0.0,
          coll="Garden"):
    """Dense round shrub: stems fan out from the base and are clipped by an ellipsoid."""
    c, R = np.array(center, float), np.array(radii, float)

    lump = np.random.default_rng(seed + 9).uniform(0, 6.283, 4)

    def env(p):
        q = (p - c) / R
        az_, el_ = math.atan2(q[1], q[0]), q[2]
        k = 1.0 + 0.07 * math.sin(3 * az_ + lump[0]) + 0.05 * math.sin(5 * az_ + lump[1] + 3 * el_) \
            + 0.05 * math.sin(4 * el_ + lump[2])
        return np.sum(q ** 2) < k * k
    P = dict(levels=3, leaf_level=1, clevel=1, rtip=0.0011, tpow=0.8, flare=0.3,
             seg=[0.05, 0.03, 0.02], wander=[0.06, 0.09, 0.1], trop=[0.5, 0.2, 0.0], taper=[0.3, 0.45, 0.6],
             sides=[6, 4, 3], dens=[0, 24.0, 30.0], start=[0, 0.22, 0.15], angle=[0, 42, 46], avar=[0, 14, 16],
             ratio=[0, 0.5, 0.5], rratio=[0, 0.55, 0.65], minlen=[0, 0.07, 0.04], shape=[None, _lin, _lin],
             leaf_from=0.1, leaf_step=leaf_step, leaf_size=leaf_size, droop=(0.0, 0.5))
    T = Tree(seed, P, env)
    rng = np.random.default_rng(seed + 5)
    base = np.array([c[0], c[1], c[2] - R[2] + 0.02])
    for i in range(stems):
        az = i * 2.39996 + rng.normal(0, 0.3)
        pol = math.radians(4 + 78 * ((i + 0.5) / stems) ** 0.65)
        d = (math.sin(pol) * math.cos(az), math.sin(pol) * math.sin(az), math.cos(pol))
        T.grow(base + np.array([math.cos(az), math.sin(az), 0]) * 0.03, d, float(R.max()) * 1.6, 0.007, 0)
    T.bark(name + "_twigs", MAT["bark"], coll=coll)
    pos, ax, nr, sz, cv = T.leaf_data()
    rel = (pos - c) / R
    rr = np.linalg.norm(rel, axis=1)
    keep = rr > hollow                                   # the inside of a clipped shrub is bare wood
    pos, ax, nr, sz, cv, rel = pos[keep], ax[keep], nr[keep], sz[keep], cv[keep], rel[keep]
    out = unit(rel * R)
    nr = out * 1.2 + np.random.default_rng(seed).normal(0, 0.5, out.shape)   # faces look outward
    cv = np.clip(cv * 0.6 + 0.25 * rel[:, 2] + 0.25 + cshift, 0, 1)
    leaves_mesh(name + "_leaves", pos, ax, nr, sz, cv, mat, aspect=0.6, curl=0.15, seed=seed, coll=coll)
    log(f"  {name}: {len(pos)} leaves")
    return pos


def lathe(name, profile, n, center, mat, coll="Garden"):
    prof = np.array(profile, float)
    ang = np.linspace(0, 2 * math.pi, n, endpoint=False)
    v = np.stack([prof[:, None, 0] * np.cos(ang)[None, :] + center[0],
                  prof[:, None, 0] * np.sin(ang)[None, :] + center[1],
                  prof[:, None, 1] + center[2] + 0 * ang[None, :]], -1)
    k = len(prof)
    idx = np.arange(k * n).reshape(k, n)
    q = np.stack([idx[:-1], np.roll(idx[:-1], -1, 1), np.roll(idx[1:], -1, 1), idx[1:]], -1).reshape(-1, 4)
    return mesh_obj(name, v.reshape(-1, 3), quads=q, mat=mat, smooth=True, coll=coll)


def disc(name, center, radius, mat, n=48, coll="Garden"):
    ang = np.linspace(0, 2 * math.pi, n, endpoint=False)
    v = np.stack([center[0] + radius * np.cos(ang), center[1] + radius * np.sin(ang), np.full(n, center[2])], -1)
    v = np.concatenate([v, [center]])
    t = np.stack([np.arange(n), (np.arange(n) + 1) % n, np.full(n, n)], -1)
    return mesh_obj(name, v, tris=t, mat=mat, coll=coll)


def build_pot_plant(seed=77):
    """Black pot on the deck with a broad-leaf plant (bird-of-paradise habit)."""
    rng = np.random.default_rng(seed)
    x, y, R, H = POT
    z0 = FLOOR_Z
    prof = [(R * 0.70, 0.0), (R * 0.74, 0.004), (R * 0.76, 0.012), (R * 0.985, H - 0.03), (R, H - 0.012), (R, H - 0.004),
            (R * 0.992, H), (R * 0.93, H), (R * 0.92, H - 0.006), (R * 0.9, H - 0.06)]
    lathe("pot", prof, 64, (x, y, z0), MAT["pot"])
    disc("pot_soil", (x, y, z0 + H - 0.05), R * 0.91, MAT["soil"])
    Vs, Qs, A = [], [], []
    nv = 0
    T = Tree(seed, dict(levels=1, leaf_level=9, rtip=0.003, tpow=0.6, flare=0.0, seg=[0.05], wander=[0.0], trop=[0.0],
                        taper=[0.5], sides=[7]))
    NU, NV = 9, 18
    nleaf = 15
    for i in range(nleaf):
        k = i / (nleaf - 1)
        az = i * 2.39996 + rng.normal(0, 0.25)
        lean = math.radians(6 + 34 * k + rng.normal(0, 4))
        Lp = (0.72 - 0.28 * k) * rng.uniform(0.9, 1.1) * (0.55 if i < 2 else 1.0)
        dh = np.array([math.cos(az), math.sin(az), 0.0])
        up = np.array([0.0, 0.0, 1.0])
        p0 = np.array([x, y, z0 + H - 0.06]) + dh * 0.03
        tt = np.linspace(0, 1, 10)[:, None]
        p2 = p0 + (dh * math.sin(lean) + up * math.cos(lean)) * Lp
        p1 = p0 + up * Lp * 0.55
        pet = (1 - tt) ** 2 * p0 + 2 * (1 - tt) * tt * p1 + tt ** 2 * p2
        T.tube(pet, np.linspace(0.0085, 0.0045, 10), 7)
        tg = unit(pet[-1] - pet[-2])
        Lb = (0.42 + 0.22 * k) * rng.uniform(0.9, 1.12) * (0.6 if i < 2 else 1.0)
        Wb = Lb * rng.uniform(0.42, 0.5)
        phi0 = math.atan2(tg[2], np.hypot(tg[0], tg[1])) - math.radians(rng.uniform(10, 30))
        droop = math.radians(rng.uniform(35, 85)) * (0.4 + 0.6 * k)
        s = np.linspace(0, 1, NV)
        phi = phi0 - droop * s ** 1.3
        ds = Lb / (NV - 1)
        mid = pet[-1] + np.concatenate([[np.zeros(3)], np.cumsum(
            (dh[None, :] * np.cos(phi)[:-1, None] + up[None, :] * np.sin(phi)[:-1, None]) * ds, axis=0)])
        tang = dh[None, :] * np.cos(phi)[:, None] + up[None, :] * np.sin(phi)[:, None]
        side = np.array([-math.sin(az), math.cos(az), 0.0])
        nrm = np.cross(side[None, :], tang) * -1.0
        nrm = np.where(nrm[:, 2:3] < 0, -nrm, nrm)
        w = (Wb / 2) * np.clip(1 - (2 * s ** 0.85 - 1) ** 2, 0, 1) ** 0.6
        u = np.linspace(-1, 1, NU)
        fold = rng.uniform(0.12, 0.3)
        rip = 0.012 * np.sin(s[:, None] * rng.uniform(14, 22) + rng.uniform(0, 6)) * (u[None, :] ** 2)
        lift = fold * np.abs(u)[None, :] * w[:, None] + rip
        twist = rng.normal(0, 0.12)
        g = mid[:, None, :] + side[None, None, :] * (u[None, :] * w[:, None])[..., None] \
            + nrm[:, None, :] * (lift + twist * u[None, :] * w[:, None])[..., None]
        idx = nv + np.arange(NV * NU).reshape(NV, NU)
        Qs.append(np.stack([idx[:-1, :-1], idx[:-1, 1:], idx[1:, 1:], idx[1:, :-1]], -1).reshape(-1, 4))
        Vs.append(g.reshape(-1, 3))
        A.append(np.stack([np.broadcast_to(u[None, :], (NV, NU)), np.broadcast_to(s[:, None], (NV, NU)),
                           np.full((NV, NU), rng.random())], -1).reshape(-1, 3))
        nv += NV * NU
    T.bark("pot_plant_stems", MAT["stem_green"])
    mesh_obj("pot_plant_leaves", np.concatenate(Vs), quads=np.concatenate(Qs), mat=MAT["leaf_broad"], smooth=True,
             attrs={"luv": np.concatenate(A)}, coll="Garden")


def build_planter():
    x0, x1, y0, y1, H = PLANTER
    t = 0.022
    # horizontal cladding boards on the four sides, corner posts, mitred cap
    rows = 4
    bh = (H - 0.035 - 0.006 * (rows - 1)) / rows
    lohi_x, lohi_y = [], []
    for i in range(rows):
        zl = 0.012 + i * (bh + 0.006)
        lohi_x += [((x0 + 0.03, y0, zl), (x1 - 0.03, y0 + t, zl + bh)), ((x0 + 0.03, y1 - t, zl), (x1 - 0.03, y1, zl + bh))]
        lohi_y += [((x0, y0 + 0.03, zl), (x0 + t, y1 - 0.03, zl + bh)), ((x1 - t, y0 + 0.03, zl), (x1, y1 - 0.03, zl + bh))]
    boxes("planter_x", lohi_x, MAT["wood_planter"], r=0.003, uv_grain=0, seed=31, coll="Garden")
    boxes("planter_y", lohi_y, MAT["wood_planter"], r=0.003, uv_grain=1, seed=32, coll="Garden")
    posts = [((px - 0.002, py - 0.002, 0.0), (px + 0.045, py + 0.045, H - 0.02))
             for px in (x0, x1 - 0.043) for py in (y0, y1 - 0.043)]
    boxes("planter_posts", posts, MAT["wood_planter"], r=0.003, uv_grain=2, seed=33, coll="Garden")
    c = 0.065
    boxes("planter_cap_x", [((x0 - 0.012, y0 - 0.012, H - 0.024), (x1 + 0.012, y0 + c, H)),
                            ((x0 - 0.012, y1 - c, H - 0.024), (x1 + 0.012, y1 + 0.012, H))],
          MAT["wood_planter"], r=0.004, uv_grain=0, seed=34, coll="Garden")
    boxes("planter_cap_y", [((x0 - 0.012, y0 + c + 0.002, H - 0.024), (x0 + c, y1 - c - 0.002, H)),
                            ((x1 - c, y0 + c + 0.002, H - 0.024), (x1 + 0.012, y1 - c - 0.002, H))],
          MAT["wood_planter"], r=0.004, uv_grain=1, seed=35, coll="Garden")
    box("planter_soil", (x0 + t, y0 + t, 0.02), (x1 - t, y1 - t, H - 0.07), MAT["soil"], r=0.0, segments=1, coll="Garden")
    # evergreen clipped mounds
    rng = np.random.default_rng(55)
    n = 6
    xs = np.linspace(x0 + 0.32, x1 - 0.32, n) + rng.normal(0, 0.04, n)
    for i, px in enumerate(xs):
        r = rng.uniform(0.25, 0.33)
        shrub(f"planter_shrub{i}", 300 + i, (px, (y0 + y1) / 2 + rng.normal(0, 0.02), H - 0.09 + r * 0.82),
              (r, r * 0.86, r * 0.9), MAT["leaf_green"], stems=30, leaf_size=0.03, leaf_step=0.007, hollow=0.5)


def surface_z(x, y, rng):
    """Height of the top-most walkable/visible surface at (x, y), or nan where a leaf cannot rest."""
    z = np.full(x.shape, np.nan)
    e = 2 * STEP_T
    inside = (np.abs(x) < SITE - 0.22) & (np.abs(y) < SITE - 0.22)
    lawn = inside & (hard_sdf(x, y) > 0.0)
    bed = bed_sdf(x, y) < 0
    z = np.where(lawn, ground_z(x, y) + np.where(bed, 0.034, 0.03 + 0.03 * rng.random(x.shape)), z)
    for cx, cy, sx, sy, r in SLABS:
        z = np.where(_rect_sdf(x, y, cx, cy, sx / 2, sy / 2, math.radians(r)) < -0.02, SLAB_TOP + 0.003, z)
    s2 = _rect_sdf(x, y, (X0 - e + NX) / 2, (Y0 - e + NY) / 2, (NX - X0 + e) / 2, (NY - Y0 + e) / 2) < -0.02
    s1 = _rect_sdf(x, y, (X0 - STEP_T + NX) / 2, (Y0 - STEP_T + NY) / 2, (NX - X0 + STEP_T) / 2, (NY - Y0 + STEP_T) / 2) < -0.02
    dk = (x > X0 + 0.03) & (x < NX) & (y > Y0 + 0.03) & (y < NY)
    z = np.where(s2, 0.153, z)
    z = np.where(s1, 0.303, z)
    z = np.where(dk, FLOOR_Z + 0.003, z)
    can = (x > X0 - CAN_OUT + 0.04) & (x < NX - 0.03) & (y > Y0 - CAN_OUT + 0.04) & (y < NY - 0.03)
    z = np.where(can, CAN_Z + 0.163, z)
    roof = (x > X0 + WALL_T + 0.05) & (x < X1 - WALL_T - 0.05) & (y > Y0 + WALL_T + 0.05) & (y < Y1 - WALL_T - 0.05) \
        & ~((x < NX + 0.45) & (y < NY + 0.45)) & ~((y > 2.74) & (y < 3.17))
    z = np.where(roof, ROOF_Z + 0.036, z)
    return z


def build_fallen_leaves(tree_leaf_pos, n=4300, seed=404):
    rng = np.random.default_rng(seed)
    xs, ys = [], []
    for pos, share, drift in zip(tree_leaf_pos, (0.66, 0.27), ((0.5, -0.1), (-0.25, 0.3))):
        k = int(n * share)
        pick = rng.integers(0, len(pos), k)
        spread = rng.normal(0, 1.0, (k, 2)) * rng.choice([0.3, 0.8, 2.0], k, p=[0.55, 0.35, 0.10])[:, None]
        xs.append(pos[pick, 0] + spread[:, 0] + drift[0])
        ys.append(pos[pick, 1] + spread[:, 1] + drift[1])
    k = n - sum(len(a) for a in xs)
    xs.append(rng.uniform(-SITE, SITE, k))
    ys.append(rng.uniform(-SITE, SITE, k))
    # wind-blown drifts against the parapets and in the roof corners
    kk = 420
    side = rng.integers(0, 4, kk)
    dd = np.abs(rng.normal(0, 0.3, kk)) + 0.06
    along = rng.uniform(0, 1, kk)
    xa, xb, ya, yb = X0 + WALL_T, X1 - WALL_T, Y0 + WALL_T, Y1 - WALL_T
    xs.append(np.select([side == 0, side == 1, side == 2], [xa + dd, xb - dd, xa + along * (xb - xa)], xa + along * (xb - xa)))
    ys.append(np.select([side == 0, side == 1, side == 2], [ya + along * (yb - ya), ya + along * (yb - ya), ya + dd], yb - dd))
    x, y = np.concatenate(xs), np.concatenate(ys)
    z = surface_z(x, y, rng)
    ok = ~np.isnan(z)
    x, y, z = x[ok], y[ok], z[ok]
    N = len(x)
    az = rng.uniform(0, 6.283, N)
    axis = np.stack([np.cos(az), np.sin(az), rng.normal(0, 0.08, N)], -1)
    nrm = np.array([[0.0, 0.0, 1.0]]) + rng.normal(0, 0.22, (N, 3))
    nrm[:, 2] *= rng.choice([1.0, -1.0], N, p=[0.6, 0.4])            # some lie face down
    size = 0.056 * rng.uniform(0.6, 1.2, N)
    cv = np.clip(rng.beta(1.3, 1.3, N) * 1.1, 0, 1)
    leaves_mesh("fallen_leaves", np.stack([x, y, z + 0.004], -1), axis, nrm, size, cv, MAT["leaf_fallen"],
                curl=0.5, fold=0.2, seed=seed)
    log(f"  fallen leaves: {N}")


def build_vegetation_materials():
    def leaf_mat(name, stops, trans=0.45, rough=0.42, spec=0.4, green=0.0, dry=0.0):
        m = M(name)
        luv = m.attr("luv", "Vector")
        u, v, rnd = m.xyz(luv)
        c = m.attr("lc")
        k = m.sat(m.add(m.mul(c, 0.8), m.mul(m.sub(rnd, 0.5), 0.36)))
        col = m.ramp(k, stops)
        col = tone(m, col, m.maprange(m.math("FRACT", m.mul(rnd, 7.31)), 0, 1, 0.78, 1.18))
        au = m.math("ABSOLUTE", u)
        # paler midrib and side veins, darker margin and tip
        vein = m.maprange(au, 0.0, 0.14, 1.0, 0.0)
        sv = m.maprange(m.math("SINE", m.mul(m.sub(m.mul(v, 9.0), m.mul(au, 2.2)), 6.283)), 0.82, 1.0)
        col = m.mix(m.mul(m.add(vein, m.mul(sv, 0.5)), 0.28), col, tone(m, col, m.rgb((1.45, 1.4, 1.0))))
        col = tone(m, col, m.maprange(m.mul(au, v), 0.25, 0.9, 1.0, 0.72))
        spot = m.maprange(m.noise(m.vmath("SCALE", m.P, scale=230.0), 1.0, 3.0, 0.6), 0.62, 0.72)
        col = m.mix(m.mul(spot, 0.55 + dry), col, m.rgb((0.14, 0.055, 0.018)))
        if green:
            gm = m.maprange(rnd, 1.0 - green, 1.0)
            col = m.mix(m.mul(gm, 0.8), col, m.rgb((0.16, 0.2, 0.03)))
        if dry:
            col = m.mix(m.mul(m.maprange(rnd, 0.0, 0.6, 1.0, 0.0), dry), col, m.rgb((0.20, 0.10, 0.04)))
        back = m.geo.outputs["Backfacing"]
        colb = m.mix(m.mul(back, 0.35), col, m.hsv(col, 0.5, 0.7, 1.25))
        nb = m.bump(m.add(m.mul(vein, 0.6), m.mul(sv, 0.3)), 0.25, 0.0008)
        bs = m.n("ShaderNodeBsdfPrincipled", {"Base Color": colb, "Roughness": rough, "Specular IOR Level": spec,
                                              "Normal": nb})
        tr = m.n("ShaderNodeBsdfTranslucent", {"Color": tone(m, col, m.rgb((1.25, 1.05, 0.7)))})
        mx = m.n("ShaderNodeMixShader", {0: trans, 1: bs.outputs[0], 2: tr.outputs[0]})
        return m.finish(mx.outputs[0])
    autumn = [(0.0, (0.70, 0.46, 0.035)), (0.3, (0.78, 0.34, 0.022)), (0.55, (0.72, 0.21, 0.015)),
              (0.8, (0.52, 0.10, 0.012)), (1.0, (0.30, 0.05, 0.012))]
    MAT["leaf"] = leaf_mat("leaf_autumn", autumn, green=0.06)
    MAT["leaf_fallen"] = leaf_mat("leaf_fallen", autumn, trans=0.25, rough=0.55, dry=0.5)
    MAT["leaf_shrub"] = leaf_mat("leaf_shrub", [(0.0, (0.62, 0.50, 0.04)), (0.35, (0.80, 0.50, 0.03)),
                                                (0.7, (0.82, 0.33, 0.02)), (1.0, (0.62, 0.17, 0.015))], green=0.08)
    MAT["leaf_green"] = leaf_mat("leaf_green", [(0.0, (0.02, 0.055, 0.012)), (0.5, (0.035, 0.085, 0.016)),
                                                (1.0, (0.07, 0.13, 0.02))], trans=0.3, rough=0.3, spec=0.5)
    # ---- bark
    m, s = surf("bark", "sakura_bark", 1.0, (0.085, 0.066, 0.052), rough=0.72, uv=True, rot=0.0, bump=0.6,
                bdist=0.004, nstr=1.0)
    s["col"] = tone(m, s["col"], m.maprange(m.noise(m.P, 3.0, 4.0), 0.3, 0.7, 0.8, 1.2))
    MAT["bark"] = done(m, s, spec=0.35)
    # ---- broad pot-plant leaf
    m = M("leaf_broad")
    luv = m.attr("luv", "Vector")
    u, v, rnd = m.xyz(luv)
    au = m.math("ABSOLUTE", u)
    col = m.ramp(rnd, [(0.0, (0.010, 0.036, 0.010)), (1.0, (0.024, 0.07, 0.016))])
    mid = m.maprange(au, 0.0, 0.07, 1.0, 0.0)
    lat = m.maprange(m.math("SINE", m.mul(m.sub(m.mul(v, 22.0), m.mul(au, 5.0)), 6.283)), 0.55, 1.0)
    col = m.mix(m.mul(mid, 0.6), col, m.rgb((0.07, 0.13, 0.035)))
    col = tone(m, col, m.maprange(lat, 0, 1, 0.9, 1.12))
    nb = m.bump(m.add(m.mul(lat, 0.5), mid), 0.35, 0.002)
    bs = m.n("ShaderNodeBsdfPrincipled", {"Base Color": col, "Roughness": m.maprange(lat, 0, 1, 0.3, 0.22),
                                          "Specular IOR Level": 0.55, "Normal": nb, "Coat Weight": 0.25,
                                          "Coat Roughness": 0.15})
    tr = m.n("ShaderNodeBsdfTranslucent", {"Color": tone(m, col, m.rgb((1.3, 1.6, 0.7)))})
    mx = m.n("ShaderNodeMixShader", {0: 0.2, 1: bs.outputs[0], 2: tr.outputs[0]})
    MAT["leaf_broad"] = m.finish(mx.outputs[0])
    m = M("stem_green")
    b = m.n("ShaderNodeBsdfPrincipled", {"Base Color": tone(m, m.rgb((0.035, 0.085, 0.02)),
                                                               m.maprange(m.noise(m.P, 40.0, 3.0), 0.3, 0.7, 0.8, 1.2)),
                                         "Roughness": 0.4})
    MAT["stem_green"] = m.finish(b.outputs[0])
    # ---- soil, glazed black pot
    m, s = surf("soil", "farm_soil", 0.9, (0.035, 0.026, 0.018), rough=0.9, bump=1.0, bdist=0.02)
    MAT["soil"] = done(m, s, spec=0.25)
    m = M("pot")
    Pp = m.P
    spk = m.maprange(m.noise(Pp, 160.0, 2.0, 0.7), 0.62, 0.75)
    col = m.mix(m.mul(spk, 0.5), m.rgb((0.012, 0.012, 0.013)), m.rgb((0.07, 0.065, 0.06)))
    up = m.maprange(m.xyz(m.geo.outputs["Normal"])[2], 0.5, 1.0)
    col = m.mix(m.mul(up, 0.3), col, m.rgb((0.2, 0.17, 0.13)))
    rr = m.maprange(m.noise(Pp, 9.0, 4.0), 0.25, 0.75, 0.42, 0.68)
    nb = m.bump(m.noise(Pp, 55.0, 4.0, 0.6), 0.12, 0.004)
    MAT["pot"] = done(m, {"col": col, "rough": rr, "normal": nb}, spec=0.5)


# ----------------------------------------------------------------------------
# Interior (seen through the glazing): floor, furniture, sheer curtains, warm lamps
# ----------------------------------------------------------------------------
WARM = (1.0, 0.56, 0.26)


def point_light(name, loc, watts, radius=0.03, color=WARM):
    ld = bpy.data.lights.new(name, "POINT")
    ld.energy, ld.shadow_soft_size, ld.color = watts, radius, color
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    return link(ob, "Light")


def area_light(name, loc, watts, size, color=WARM, rot=(0, 0, 0), spread=None):
    ld = bpy.data.lights.new(name, "AREA")
    ld.energy, ld.color = watts, color
    ld.shape = "RECTANGLE"
    ld.size, ld.size_y = size
    if spread is not None:
        ld.spread = spread
    ob = bpy.data.objects.new(name, ld)
    ob.location, ob.rotation_euler = loc, rot
    return link(ob, "Light")


def curtain(name, x0, x1, y, z0, z1, amp, lam, seed, mat):
    rng = np.random.default_rng(seed)
    nx_, nz_ = max(8, int((x1 - x0) / 0.006)), 14
    xs = np.linspace(x0, x1, nx_)
    zs = np.linspace(z1, z0, nz_)
    ph = np.cumsum(rng.normal(1.0, 0.22, nx_)) * (2 * math.pi * (xs[1] - xs[0]) / lam)
    k = ((z1 - zs) / (z1 - z0))[:, None]                         # 0 at the track, 1 at the hem
    fold = np.sin(ph)[None, :] * amp * (0.75 + 0.45 * k) + np.sin(ph * 0.37 + 1.3)[None, :] * amp * 0.5 * k
    sway = 0.012 * np.sin(xs * 2.1 + seed)[None, :] * k ** 2
    v = np.stack([np.broadcast_to(xs[None, :] + 0.004 * np.cos(ph)[None, :] * k, (nz_, nx_)), y + fold + sway,
                  np.broadcast_to(zs[:, None], (nz_, nx_))], -1)
    idx = np.arange(nz_ * nx_).reshape(nz_, nx_)
    q = np.stack([idx[:-1, :-1], idx[1:, :-1], idx[1:, 1:], idx[:-1, 1:]], -1).reshape(-1, 4)
    return mesh_obj(name, v.reshape(-1, 3), quads=q, mat=mat, smooth=True, coll="Interior")


def build_interior():
    Z = FLOOR_Z
    xi0, xi1, yi0, yi1 = X0 + WALL_T, X1 - WALL_T, Y0 + WALL_T, Y1 - WALL_T
    nx, ny = NX + 0.05 + WALL_T, NY + 0.05 + WALL_T
    I = "Interior"
    boxes("floor", [((nx, yi0 - 0.2, Z - 0.02), (xi1, yi1, Z)), ((xi0, ny, Z - 0.02), (nx, yi1, Z))], MAT["floor_wood"],
          r=0.0, segments=1, coll=I)
    box("rug", (2.05, -0.95, Z), (4.25, 0.8, Z + 0.014), MAT["rug"], r=0.005, coll=I)
    # sofa along the right wall, facing the room
    sx0, sx1, sy0, sy1 = 4.12, 5.04, -1.0, 1.08
    fab = [((sx0, sy0, Z + 0.11), (sx1, sy1, Z + 0.29)),                         # base
           ((sx0, sy0, Z + 0.11), (sx1, sy0 + 0.17, Z + 0.60)), ((sx0, sy1 - 0.17, Z + 0.11), (sx1, sy1, Z + 0.60)),
           ((sx1 - 0.16, sy0, Z + 0.11), (sx1, sy1, Z + 0.74))]
    boxes("sofa_frame", fab, MAT["fabric"], r=0.035, segments=3, coll=I)
    ym = (sy0 + sy1) / 2
    cush = [((sx0 - 0.015, sy0 + 0.18, Z + 0.28), (sx1 - 0.2, ym - 0.004, Z + 0.45)),
            ((sx0 - 0.015, ym + 0.004, Z + 0.28), (sx1 - 0.2, sy1 - 0.18, Z + 0.45)),
            ((sx1 - 0.36, sy0 + 0.19, Z + 0.43), (sx1 - 0.15, ym - 0.008, Z + 0.86)),
            ((sx1 - 0.36, ym + 0.008, Z + 0.43), (sx1 - 0.15, sy1 - 0.19, Z + 0.86))]
    boxes("sofa_cushions", cush, MAT["fabric"], r=0.055, segments=4, coll=I)
    R = rot_z(np.radians([18.0, -25.0]))
    Rx = np.array([[[1, 0, 0], [0, math.cos(0.5), -math.sin(0.5)], [0, math.sin(0.5), math.cos(0.5)]]] * 2)
    rounded_boxes("sofa_pillows", [(sx1 - 0.42, sy0 + 0.42, Z + 0.58), (sx1 - 0.45, sy1 - 0.4, Z + 0.57)],
                  [(0.07, 0.2, 0.2), (0.065, 0.19, 0.19)], r=0.055, rot=R @ Rx, mat=MAT["fabric_tan"], segments=4, coll=I)
    legs = [((x_, y_, Z), (x_ + 0.035, y_ + 0.035, Z + 0.12)) for x_ in (sx0 + 0.04, sx1 - 0.08) for y_ in (sy0 + 0.04, sy1 - 0.08)]
    # lounge chair opposite
    ax0, ax1, ay0, ay1 = 1.55, 2.33, -0.35, 0.45
    chair = [((ax0, ay0, Z + 0.16), (ax1, ay1, Z + 0.30)), ((ax0, ay0, Z + 0.16), (ax0 + 0.14, ay1, Z + 0.80)),
             ((ax0, ay0, Z + 0.16), (ax1, ay0 + 0.1, Z + 0.56)), ((ax0, ay1 - 0.1, Z + 0.16), (ax1, ay1, Z + 0.56))]
    boxes("chair_frame", chair, MAT["fabric_tan"], r=0.035, segments=3, coll=I)
    boxes("chair_cushions", [((ax0 + 0.14, ay0 + 0.11, Z + 0.29), (ax1 + 0.01, ay1 - 0.11, Z + 0.44)),
                             ((ax0 + 0.13, ay0 + 0.12, Z + 0.42), (ax0 + 0.3, ay1 - 0.12, Z + 0.84))],
          MAT["fabric_tan"], r=0.05, segments=4, coll=I)
    legs += [((x_, y_, Z), (x_ + 0.03, y_ + 0.03, Z + 0.17)) for x_ in (ax0 + 0.04, ax1 - 0.07) for y_ in (ay0 + 0.04, ay1 - 0.07)]
    # round coffee table, floor lamp, pendant
    tx, ty = 3.2, -0.12
    lathe("table_top", [(0.0, 0.33), (0.435, 0.33), (0.45, 0.335), (0.455, 0.345), (0.455, 0.36), (0.45, 0.368),
                        (0.44, 0.372), (0.0, 0.372)], 64, (tx, ty, Z), MAT["wood_furn_plain"], coll=I)
    legs += [((tx + 0.3 * math.cos(a) - 0.012, ty + 0.3 * math.sin(a) - 0.012, Z),
              (tx + 0.3 * math.cos(a) + 0.012, ty + 0.3 * math.sin(a) + 0.012, Z + 0.335)) for a in (0.5, 2.6, 4.7)]
    lx, ly = 4.72, -1.02
    lathe("lamp_base", [(0.0, 0.0), (0.14, 0.0), (0.145, 0.006), (0.14, 0.014), (0.012, 0.02), (0.011, 1.36), (0.0, 1.36)],
          32, (lx, ly, Z), MAT["black_metal"], coll=I)
    lathe("lamp_shade", [(0.20, 1.24), (0.165, 1.56)], 48, (lx, ly, Z), MAT["lamp_shade"], coll=I)
    point_light("lamp_floor", (lx, ly, Z + 1.40), 6.0, 0.035)
    px, py = -0.45, 2.95
    lathe("pendant_cord", [(0.0035, 1.95), (0.0035, CEIL_Z - Z)], 6, (px, py, Z), MAT["black_metal"], coll=I)
    v0, f0 = icosphere(3, 0.13)
    mesh_obj("pendant_globe", v0 + np.array([px, py, Z + 1.82]), tris=f0, mat=MAT["lamp_shade"], smooth=True, coll=I)
    point_light("lamp_pendant", (px, py, Z + 1.82), 9.0, 0.05)
    # a low sideboard under the slit windows, books on the table
    boxes("sideboard", [((xi0 + 0.02, 1.7, Z + 0.1), (xi0 + 0.42, 4.1, Z + 0.62))], MAT["wood_furn"], r=0.004,
          uv_grain=1, coll=I)
    boxes("books", [((tx - 0.2, ty - 0.1, Z + 0.372), (tx + 0.02, ty + 0.2, Z + 0.395)),
                    ((tx - 0.18, ty - 0.08, Z + 0.395), (tx + 0.0, ty + 0.17, Z + 0.412))], MAT["fabric_tan"], r=0.003, coll=I)
    boxes("legs", legs, MAT["black_metal"], r=0.004, coll=I)
    box("doormat", (DOOR[0] + 0.08, NY - 0.62, Z), (DOOR[1] - 0.08, NY - 0.10, Z + 0.016), MAT["doormat"], r=0.006, coll=I)
    # sheer curtains: one drawn across the left third, one gathered at the right jamb
    cy = yi0 + 0.09 + (50.0 if os.environ.get("HD_NO_CURTAIN") else 0.0)
    curtain("curtain_l", BW[0] - 0.08, BW[0] + 1.62, cy, Z + 0.015, CEIL_Z - 0.02, 0.034, 0.105, 1, MAT["sheer"])
    curtain("curtain_r", BW[1] - 0.36, BW[1] + 0.08, cy, Z + 0.015, CEIL_Z - 0.02, 0.045, 0.05, 2, MAT["sheer"])
    box("curtain_track", (BW[0] - 0.12, cy - 0.02, CEIL_Z - 0.025), (BW[1] + 0.12, cy + 0.02, CEIL_Z), MAT["black_metal"],
        r=0.003, coll=I)
    # practical lights
    area_light("ceil_living", (3.3, 0.1, CEIL_Z - 0.03), 24.0, (1.6, 1.6))
    area_light("ceil_back", (3.2, 3.4, CEIL_Z - 0.03), 40.0, (1.4, 1.4))
    area_light("ceil_left", (0.0, 3.4, CEIL_Z - 0.03), 22.0, (1.0, 1.0))
    # warm downlights under the canopy
    for i, (lx_, ly_) in enumerate(((-0.75, 0.35), (0.25, -0.75))):
        area_light(f"porch{i}", (lx_, ly_, CAN_Z - 0.03), 13.0, (0.12, 0.12), spread=math.radians(120))


def build_interior_materials():
    m, s = surf("floor_wood", "oak_wood_planks", 1.2, (0.34, 0.225, 0.125), rough=0.36, bump=0.25, bdist=0.002)
    MAT["floor_wood"] = done(m, s, spec=0.5)
    m, s = surf("fabric", "poly_wool_herringbone", 0.27, (0.17, 0.165, 0.155), rough=0.92, bump=0.6, bdist=0.002)
    MAT["fabric"] = done(m, s, spec=0.3, **{"Sheen Weight": 0.08, "Sheen Roughness": 0.5})
    m, s = surf("fabric_tan", "rough_linen", 0.27, (0.40, 0.29, 0.17), rough=0.9, bump=0.6, bdist=0.002)
    MAT["fabric_tan"] = done(m, s, spec=0.3, **{"Sheen Weight": 0.08, "Sheen Roughness": 0.5})
    m, s = surf("rug", "hessian_230", 0.27, (0.50, 0.44, 0.35), rough=0.95, bump=0.8, bdist=0.004)
    s["col"] = tone(m, s["col"], m.maprange(m.noise(m.P, 1.5, 3.0), 0.3, 0.7, 0.9, 1.08))
    MAT["rug"] = done(m, s, spec=0.2, **{"Sheen Weight": 0.1})
    m, s = surf("wood_furn_plain", "oak_veneer_01", 1.83, (0.33, 0.20, 0.10), rough=0.4, coord="OBJECT", bump=0.2,
                bdist=0.001)
    MAT["wood_furn_plain"] = done(m, s, spec=0.5)
    m, s = surf("doormat", "hessian_230", 0.2, (0.11, 0.085, 0.055), rough=0.97, bump=1.0, bdist=0.006)
    MAT["doormat"] = done(m, s, spec=0.15)
    # sheer voile: more opaque at grazing angles
    m = M("sheer")
    facing = m.n("ShaderNodeLayerWeight", {"Blend": 0.35}).outputs["Facing"]
    wv = m.maprange(m.noise(m.P, 900.0, 1.0), 0.3, 0.7, 0.9, 1.1)
    tfac = m.mul(m.maprange(facing, 0.0, 1.0, 0.56, 0.12), wv)
    white = (0.86, 0.85, 0.82, 1)
    df = m.n("ShaderNodeBsdfDiffuse", {"Color": white})
    tl = m.n("ShaderNodeBsdfTranslucent", {"Color": white})
    body = m.n("ShaderNodeMixShader", {0: 0.5, 1: df.outputs[0], 2: tl.outputs[0]})
    tp = m.n("ShaderNodeBsdfTransparent", {"Color": (1, 1, 1, 1)})
    mx = m.n("ShaderNodeMixShader", {0: tfac, 1: body.outputs[0], 2: tp.outputs[0]})
    MAT["sheer"] = m.finish(mx.outputs[0])
    # lamp shade: linen that glows from the bulb inside
    m, s = surf("lamp_shade", "rough_linen", 0.27, (0.78, 0.70, 0.58), rough=0.85, coord="OBJECT", bump=0.3, bdist=0.001)
    df = m.n("ShaderNodeBsdfDiffuse", {"Color": s["col"], "Normal": s["normal"]})
    tl = m.n("ShaderNodeBsdfTranslucent", {"Color": s["col"], "Normal": s["normal"]})
    mx = m.n("ShaderNodeMixShader", {0: 0.6, 1: df.outputs[0], 2: tl.outputs[0]})
    if os.environ.get("HD_OLD_SHADE"):
        MAT["lamp_shade"] = m.finish(mx.outputs[0])
    else:
        # a bulb sealed inside a translucent shade can only light the room through indirect paths (very noisy).
        # Shadow rays therefore pass straight through the shade, tinted by the cloth's transmittance.
        tp = m.n("ShaderNodeBsdfTransparent", {"Color": (0.22, 0.19, 0.14, 1)})
        lp = m.n("ShaderNodeLightPath")
        mx2 = m.n("ShaderNodeMixShader", {0: lp.outputs["Is Shadow Ray"], 1: mx.outputs[0], 2: tp.outputs[0]})
        MAT["lamp_shade"] = m.finish(mx2.outputs[0])


# ----------------------------------------------------------------------------
# Light, camera, render
# ----------------------------------------------------------------------------
SKY_DISC_DEBUG = "--skydisc" in sys.argv


def sun_dir():
    a, e = math.radians(SUN_AZ), math.radians(SUN_EL)
    return Vector((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)))


def build_light(sun_strength=6.2, sky_strength=0.011, sun_angle=1.6):
    sc = bpy.context.scene
    w = bpy.data.worlds.new("sky")
    w.use_nodes = True
    sc.world = w
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "MULTIPLE_SCATTERING"
    sky.sun_disc = SKY_DISC_DEBUG
    sky.sun_elevation = math.radians(SUN_EL)
    sky.air_density = 1.0
    sky.aerosol_density = 1.6
    sky.ozone_density = 1.0
    # the sky model puts its sun at azimuth 90 deg (+y) for rotation 0 and turns clockwise seen from above
    sky.sun_rotation = math.radians(90.0 - SUN_AZ)
    nt.links.new(sky.outputs[0], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = sky_strength
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    ld = bpy.data.lights.new("sun", "SUN")
    ld.energy = 0.0 if SKY_DISC_DEBUG else sun_strength
    ld.angle = math.radians(sun_angle)
    ld.color = (1.0, 0.72, 0.46)
    sun = bpy.data.objects.new("sun", ld)
    sun.rotation_euler = sun_dir().to_track_quat("Z", "Y").to_euler()
    link(sun, "Light")
    return sky, bg, ld


def ease(t):
    return t * t * (3 - 2 * t)


def cam_pose(az_deg, el_deg=CAM_EL, target=CAM_TARGET, dist=90.0):
    a, e = math.radians(az_deg), math.radians(el_deg)
    d = Vector((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)))
    loc = Vector(target) + d * dist
    rot = (-d).to_track_quat("-Z", "Y").to_euler()
    return loc, rot


def build_camera(args):
    sc = bpy.context.scene
    cd = bpy.data.cameras.new("cam")
    cd.type = "ORTHO"
    cd.ortho_scale = ORTHO_SCALE
    cd.clip_start, cd.clip_end = 1.0, 400.0
    cam = bpy.data.objects.new("cam", cd)
    link(cam, "Light")
    sc.camera = cam
    sc.frame_start, sc.frame_end = FRAME_START, FRAME_END
    sc.render.fps = FPS
    for f in range(FRAME_START, FRAME_END + 1):
        t = (f - FRAME_START) / (FRAME_END - FRAME_START)
        az = CAM_AZ_MID + ORBIT_DEG * (ease(t) - 0.5)
        cam.location, cam.rotation_euler = cam_pose(az)
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_euler", frame=f)
    if args.cam:                                   # debug view: az,el,scale,tx,ty,tz
        az, el, scale, tx, ty, tz = args.cam
        if cam.animation_data:
            cam.animation_data_clear()
        cam.location, cam.rotation_euler = cam_pose(az, el, (tx, ty, tz))
        cd.ortho_scale = scale
    return cam


def setup_render(args):
    sc = bpy.context.scene
    r = sc.render
    r.engine = "CYCLES"
    c = sc.cycles
    c.device = "CPU"
    r.resolution_x, r.resolution_y = 1080, 1920
    r.resolution_percentage = args.res
    c.samples = args.samples
    # adaptive sampling only ever ADDS samples above the floor: every pixel gets at least --min-samples,
    # noisy pixels (interior behind glass, foliage in shade) keep going up to --samples
    c.use_adaptive_sampling = args.adaptive > 0
    if args.adaptive > 0:
        c.adaptive_threshold = args.adaptive
        c.adaptive_min_samples = args.min_samples
    c.use_denoising = not os.environ.get("HD_NO_DENOISE")
    c.denoiser = "OPENIMAGEDENOISE"
    c.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    c.denoising_prefilter = "ACCURATE"
    try:
        c.denoising_quality = "HIGH"
    except Exception:  # noqa: BLE001
        pass
    # light paths: nothing trimmed (Cycles defaults are 12/4/4/12/8; these are higher)
    c.max_bounces = 16
    c.diffuse_bounces = 8
    c.glossy_bounces = 8
    c.transmission_bounces = 16
    c.volume_bounces = 2
    c.transparent_max_bounces = 32
    c.caustics_reflective = not os.environ.get("HD_NO_CAUSTICS")
    c.caustics_refractive = not os.environ.get("HD_NO_CAUSTICS")
    c.sample_clamp_direct = 0.0
    c.sample_clamp_indirect = 10.0
    c.blur_glossy = 1.0
    c.pixel_filter_type = "BLACKMAN_HARRIS"
    c.filter_width = 1.5
    r.use_persistent_data = True
    r.threads_mode = "AUTO"
    r.film_transparent = False
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGB"
    r.image_settings.color_depth = "8"
    r.image_settings.compression = 30
    r.use_file_extension = True
    vs = sc.view_settings
    vs.view_transform = "AgX"
    vs.look = args.look
    vs.exposure = args.exposure
    vs.gamma = 1.0
    if args.crop:
        r.use_border = True
        r.use_crop_to_border = True
        r.border_min_x, r.border_min_y, r.border_max_x, r.border_max_y = args.crop


SEED_OFFSET = 0


def build_compositor(strength):
    """A restrained bloom on the brightest highlights (lamp shade, sun glints), as a real lens would give."""
    sc = bpy.context.scene
    if strength <= 0:
        return
    try:
        ng = bpy.data.node_groups.new("post", "CompositorNodeTree")
        ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        rl = ng.nodes.new("CompositorNodeRLayers")
        gl = ng.nodes.new("CompositorNodeGlare")
        out = ng.nodes.new("NodeGroupOutput")
        gl.inputs["Type"].default_value = "Bloom"
        gl.inputs["Quality"].default_value = "High"
        gl.inputs["Threshold"].default_value = 1.6
        gl.inputs["Smoothness"].default_value = 0.4
        gl.inputs["Strength"].default_value = strength
        gl.inputs["Saturation"].default_value = 0.9
        gl.inputs["Size"].default_value = 0.35
        ng.links.new(rl.outputs["Image"], gl.inputs["Image"])
        ng.links.new(gl.outputs["Image"], out.inputs[0])
        sc.render.compositor_device = "CPU"
        sc.render.compositor_precision = "FULL"
        sc.compositing_node_group = ng
        sc.render.use_compositing = True
    except Exception as e:  # noqa: BLE001
        log("compositor unavailable, rendering without bloom:", e)


def render_frame(frame, path):
    sc = bpy.context.scene
    sc.frame_set(frame)
    sc.cycles.seed = frame + SEED_OFFSET        # new noise pattern every frame: no static grain in the video
    sc.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    return time.time() - t


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def build_scene(args):
    sc = bpy.context.scene
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    ensure_assets()
    log("materials")
    build_materials()
    log("site + house")
    build_garden_materials()
    build_vegetation_materials()
    build_interior_materials()
    build_site()
    build_house()
    build_interior()
    skip = set(args.skip.split(","))
    log("ground, slabs, rocks, pebbles")
    build_ground()
    build_rocks()
    if "pebbles" not in skip:
        build_pebbles()
    if "lawn" not in skip:
        log("lawn")
        build_lawn()
    if "ograss" not in skip:
        build_ornamental_grass()
    if "trees" not in skip:
        log("trees, shrubs, plants")
        tl = build_trees()
        shrub("shrub", 500, (SHRUB[0], SHRUB[1], SHRUB[2] * 0.86), (SHRUB[2], SHRUB[2], SHRUB[2] * 0.9),
              MAT["leaf_shrub"], stems=34, leaf_size=0.032, leaf_step=0.008)
        build_planter()
        build_pot_plant()
        build_fallen_leaves(tl)
    build_light()
    build_camera(args)
    setup_render(args)
    build_compositor(args.bloom)
    log("scene built:", len(bpy.data.objects), "objects,",
        sum(len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH"), "polys")


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--still", type=int, default=None, help="render one frame")
    ap.add_argument("--anim", action="store_true", help="render frames 1-120 (skips finished ones)")
    ap.add_argument("--encode", action="store_true", help="encode the PNG sequence to MP4")
    ap.add_argument("--assets-only", action="store_true")
    ap.add_argument("--samples", type=int, default=2048, help="samples per pixel (maximum when adaptive)")
    ap.add_argument("--adaptive", type=float, default=0.015, help="adaptive noise threshold, 0 = fixed sample count")
    ap.add_argument("--min-samples", type=int, default=256, help="sample floor per pixel when adaptive")
    ap.add_argument("--res", type=int, default=100, help="resolution percentage")
    ap.add_argument("--exposure", type=float, default=1.05)
    ap.add_argument("--out", default=None)
    ap.add_argument("--crop", type=float, nargs=4, default=None, help="border x0 y0 x1 y1 (0-1)")
    ap.add_argument("--cam", type=float, nargs=6, default=None, help="debug camera az el scale tx ty tz")
    ap.add_argument("--skip", default="", help="comma list of build stages to skip (debug)")
    ap.add_argument("--save-blend", default=None)
    ap.add_argument("--bloom", type=float, default=0.5, help="compositor bloom strength (0 = off)")
    ap.add_argument("--seed", type=int, default=0, help="offset added to the per-frame noise seed")
    ap.add_argument("--exr", action="store_true", help="also save a scene-linear EXR next to the still")
    ap.add_argument("--look", default="AgX - High Contrast")
    ap.add_argument("--grade", nargs=2, default=None, metavar=("EXR", "PNG"),
                    help="re-apply view transform / look / exposure to a saved EXR")
    ap.add_argument("--skydisc", action="store_true", help="debug: light with the sky model's own sun disc")
    return ap.parse_args()


def main():
    global SEED_OFFSET
    args = parse_args()
    SEED_OFFSET = args.seed
    if args.assets_only:
        ensure_assets()
        return
    if args.encode and args.still is None and not args.anim:
        encode()
        return
    if args.grade:
        sc = bpy.context.scene
        sc.view_settings.view_transform = "AgX"
        sc.view_settings.look = args.look
        sc.view_settings.exposure = args.exposure
        img = bpy.data.images.load(os.path.abspath(args.grade[0]))
        st = sc.render.image_settings
        st.file_format, st.color_mode, st.color_depth = "PNG", "RGB", "8"
        img.save_render(os.path.abspath(args.grade[1]), scene=sc)
        return
    build_scene(args)
    if args.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save_blend))
    if args.still is not None:
        os.makedirs(OUT, exist_ok=True)
        path = args.out or os.path.join(OUT, f"still_f{args.still:03d}.png")
        dt = render_frame(args.still, os.path.abspath(path))
        log(f"frame {args.still} rendered in {dt:.1f}s -> {path}")
        if args.exr:                               # scene-linear copy, for trying grades without re-rendering
            st = bpy.context.scene.render.image_settings
            st.file_format, st.color_depth, st.exr_codec = "OPEN_EXR", "16", "ZIP"
            bpy.data.images["Render Result"].save_render(os.path.splitext(os.path.abspath(path))[0] + ".exr")
    if args.anim:
        render_anim(args)
        if args.encode:
            encode()


def frame_path(f):
    return os.path.join(FRAMES, f"frame_{f:04d}.png")


def frame_ok(f):
    p = frame_path(f)
    return os.path.exists(p) and os.path.getsize(p) > 200_000


def render_anim(args):
    """Frames 1-120, one PNG each. Finished frames are skipped, so a killed run resumes where it stopped.
    Every frame is written to a temp name first and renamed, so a crash never leaves a half-written PNG."""
    os.makedirs(FRAMES, exist_ok=True)
    logf = os.path.join(ROOT, "render.log")

    def plog(msg):
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
        print(line, flush=True)
        with open(logf, "a") as fh:
            fh.write(line + "\n")
    todo = [f for f in range(FRAME_START, FRAME_END + 1) if not frame_ok(f)]
    total = FRAME_END - FRAME_START + 1
    plog(f"START pid={os.getpid()} samples={args.samples} res={args.res}% | {total - len(todo)}/{total} frames "
         f"already on disk, {len(todo)} to render")
    times = []
    for f in todo:
        tmp = os.path.join(FRAMES, f"frame_{f:04d}.tmp")
        dt = render_frame(f, tmp)
        os.replace(tmp + ".png", frame_path(f))
        times.append(dt)
        left = sum(1 for g in range(FRAME_START, FRAME_END + 1) if not frame_ok(g))
        avg = sum(times) / len(times)
        plog(f"frame {f:3d} done in {dt:6.1f}s | {total - left}/{total} | avg {avg:.1f}s | ETA {left * avg / 3600:.2f} h")
    plog("ALL FRAMES DONE")


def find_ffmpeg():
    from shutil import which
    exe = which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "imageio-ffmpeg"])
        import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def encode():
    missing = [f for f in range(FRAME_START, FRAME_END + 1) if not frame_ok(f)]
    if missing:
        raise SystemExit(f"cannot encode: {len(missing)} frames missing (first: {missing[0]})")
    os.makedirs(OUT, exist_ok=True)
    dst = os.path.join(OUT, "house_diorama.mp4")
    cmd = [find_ffmpeg(), "-y", "-framerate", str(FPS), "-start_number", str(FRAME_START),
           "-i", os.path.join(FRAMES, "frame_%04d.png"),
           "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p",
           "-b:v", "35M", "-maxrate", "50M", "-bufsize", "70M",
           "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
           "-movflags", "+faststart", "-r", str(FPS), dst]
    log(" ".join(cmd))
    subprocess.check_call(cmd)
    log("encoded ->", dst)


if __name__ == "__main__":
    main()
