"""Pilot scene: "kenapa jalan butuh lapisan batu pecah".

Everything is built procedurally. build() creates the scene, apply_frame(f)
poses every animated thing (camera, character, truck, soil deformation,
gravel growth, load arrow) for frame f in [0, 449].

World axes: X = along the road, Y = away from the viewer, Z = up.
The diorama cut face is the plane y = 0; the road surface is z = 0.
"""
import math
import os
import random

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_BOLD = os.path.join(HERE, "fonts", "PlusJakartaSans-Bold.ttf")

FPS = 30
NFRAMES = 450
CUT1 = 138  # 4.6 s  shot 1 -> shot 2
CUT2 = 306  # 10.2 s shot 2 -> shot 3
T_ARROW = 8.9

ROAD_W = 3.6
TRUCK_Y = 1.06          # truck centre line; near tyre face sits at y = 0.06
WB = 3.2                # wheelbase
RW = 0.48               # wheel radius
CHAR_POS = Vector((0.0, 1.9, 0.0))

# shot 3 truck pass
T3_0 = 12.0
X3_0 = -6.3
V3 = 2.6

# gravel layer
GR_TOP, GR_BOT = -0.08, -0.58
GR_X0, GR_X1 = -7.0, 7.0
GR_T0 = 10.40
GR_SWEEP_X0 = -2.9
GR_SWEEP_V = 3.6

OBJ = {}
STATE = {}


# ----------------------------------------------------------------- helpers
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def smooth(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)


def lerp(a, b, t):
    return a + (b - a) * t


def back(x):
    x = clamp(x)
    c1 = 1.70158
    c3 = c1 + 1
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2


def srgb(h):
    h = h.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (out[0], out[1], out[2], 1.0)


HAZE = "#b9d6f2"


def mat(name, col, rough=0.9, emit=0.0, noise=None, haze=0.0, vcol=False, spec=0.12, shadeless=False):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs[0], out.inputs[0])
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = spec
    c = srgb(col)
    src = None
    if vcol:
        a = nt.nodes.new("ShaderNodeAttribute")
        a.attribute_name = "Col"
        src = a.outputs[0]
    elif noise:
        col2, scale = noise
        tc = nt.nodes.new("ShaderNodeTexCoord")
        nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = scale
        nz.inputs["Detail"].default_value = 2.0
        nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
        rp = nt.nodes.new("ShaderNodeValToRGB")
        e = rp.color_ramp.elements
        e[0].position = 0.38
        e[0].color = c
        e[1].position = 0.62
        e[1].color = srgb(col2)
        nt.links.new(nz.outputs[0], rp.inputs[0])
        src = rp.outputs[0]
    if haze > 0:
        cd = nt.nodes.new("ShaderNodeCameraData")
        mr = nt.nodes.new("ShaderNodeMapRange")
        mr.inputs["From Min"].default_value = 30.0
        mr.inputs["From Max"].default_value = 700.0
        mr.inputs["To Min"].default_value = 0.0
        mr.inputs["To Max"].default_value = haze
        nt.links.new(cd.outputs["View Distance"], mr.inputs["Value"])
        mx = nt.nodes.new("ShaderNodeMix")
        mx.data_type = "RGBA"
        nt.links.new(mr.outputs[0], mx.inputs[0])
        if src is None:
            mx.inputs[6].default_value = c
        else:
            nt.links.new(src, mx.inputs[6])
        mx.inputs[7].default_value = srgb(HAZE)
        src = mx.outputs[2]
    if shadeless:
        em = nt.nodes.new("ShaderNodeEmission")
        if src is None:
            em.inputs[0].default_value = c
        else:
            nt.links.new(src, em.inputs[0])
        nt.links.new(em.outputs[0], out.inputs[0])
        return m
    if src is None:
        b.inputs["Base Color"].default_value = c
    else:
        nt.links.new(src, b.inputs["Base Color"])
    if emit > 0:
        b.inputs["Emission Color"].default_value = c
        b.inputs["Emission Strength"].default_value = emit
    return m


class MB:
    """Tiny mesh builder: accumulates verts/faces with a material index."""

    def __init__(self):
        self.v = []
        self.f = []
        self.m = []

    def add(self, verts, faces, mi=0, M=None):
        o = len(self.v)
        for p in verts:
            p = Vector(p)
            if M is not None:
                p = M @ p
            self.v.append((p.x, p.y, p.z))
        for fc in faces:
            self.f.append(tuple(i + o for i in fc))
            self.m.append(mi)

    def box(self, lo, hi, mi=0, M=None):
        x0, y0, z0 = lo
        x1, y1, z1 = hi
        v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
             (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        self.add(v, f, mi, M)

    def prism(self, n, rings, mi=0, M=None, cap0=True, cap1=True, rot=0.0):
        """rings: list of (z, rx, ry); n-gon cross-section in XY."""
        v = []
        for (z, rx, ry) in rings:
            for i in range(n):
                a = rot + 2 * math.pi * i / n
                v.append((rx * math.cos(a), ry * math.sin(a), z))
        f = []
        for r in range(len(rings) - 1):
            for i in range(n):
                a = r * n + i
                bq = r * n + (i + 1) % n
                f.append((a, bq, bq + n, a + n))
        if cap0:
            f.append(tuple(reversed(range(n))))
        if cap1:
            f.append(tuple(range((len(rings) - 1) * n, len(rings) * n)))
        self.add(v, f, mi, M)

    def ico(self, sub, radius, mi=0, M=None, jitter=0.0, rnd=None):
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=radius)
        v = []
        for vt in bm.verts:
            p = vt.co.copy()
            if jitter and rnd:
                p *= 1 + rnd.uniform(-jitter, jitter)
            v.append(p)
        f = [tuple(vt.index for vt in fc.verts) for fc in bm.faces]
        bm.free()
        self.add(v, f, mi, M)

    def build(self, name, mats, smooth_shade=False, recalc=True):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.v, [], self.f)
        for m in mats:
            me.materials.append(m)
        me.polygons.foreach_set("material_index", self.m)
        if recalc:
            bm = bmesh.new()
            bm.from_mesh(me)
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            bm.to_mesh(me)
            bm.free()
        if smooth_shade:
            me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
        me.update()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        ob.rotation_mode = "QUATERNION"
        OBJ[name] = ob
        return ob


def T(x, y, z):
    return Matrix.Translation((x, y, z))


def RY(a):
    return Matrix.Rotation(a, 4, "Y")


def RZ(a):
    return Matrix.Rotation(a, 4, "Z")


def RX(a):
    return Matrix.Rotation(a, 4, "X")


def S3(x, y, z):
    return Matrix.Diagonal((x, y, z, 1.0))


# ------------------------------------------------------------ world / light
def build_world():
    scene = bpy.context.scene
    w = bpy.data.worlds.new("Sky")
    scene.world = w
    try:
        w.use_nodes = True
    except Exception:
        pass
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    mr = nt.nodes.new("ShaderNodeMapRange")
    rp = nt.nodes.new("ShaderNodeValToRGB")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs[2], mr.inputs["Value"])
    mr.inputs["From Min"].default_value = -1.0
    mr.inputs["From Max"].default_value = 1.0
    nt.links.new(mr.outputs[0], rp.inputs[0])
    e = rp.color_ramp.elements
    e[0].position = 0.5
    e[0].color = srgb(HAZE)
    e[1].position = 1.0
    e[1].color = srgb("#0f47b0")
    for pos, col in ((0.56, "#6fb0ee"), (0.68, "#2f7fdc"), (0.80, "#1a5fc6")):
        el = e.new(pos)
        el.color = srgb(col)
    nt.links.new(rp.outputs[0], bg.inputs[0])
    bg.inputs[1].default_value = 1.0
    nt.links.new(bg.outputs[0], out.inputs[0])

    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 4.2
    sun.angle = math.radians(0.6)
    sun.color = (1.0, 0.96, 0.88)
    so = bpy.data.objects.new("Sun", sun)
    scene.collection.objects.link(so)
    d = Vector((-0.42, 0.72, -0.62)).normalized()
    so.rotation_mode = "QUATERNION"
    so.rotation_quaternion = d.to_track_quat("-Z", "Y")
    OBJ["Sun"] = so


# ------------------------------------------------------------------ ground
def wy_profile(y):
    """Cross-road rut profile: depth weight W(y) and side-heave weight WB(y)."""
    W = np.zeros_like(y)
    B = np.zeros_like(y)
    # near track: tyres y 0.06..0.62 (cut face slices right beside it)
    W = np.where(y <= 0.66, 1.0, W)
    m = (y > 0.66) & (y < 0.90)
    W = np.where(m, 0.5 + 0.5 * np.cos((y - 0.66) / 0.24 * np.pi), W)
    m = (y > 0.80) & (y < 1.30)
    B = np.where(m, np.sin((y - 0.80) / 0.50 * np.pi) ** 2, B)
    # far track: tyres y 1.50..2.06
    c0, c1 = 1.46, 2.10
    W = np.where((y >= c0) & (y <= c1), 1.0, W)
    m = (y > c0 - 0.24) & (y < c0)
    W = np.where(m, np.maximum(W, 0.5 + 0.5 * np.cos((c0 - y) / 0.24 * np.pi)), W)
    m = (y > c1) & (y < c1 + 0.24)
    W = np.where(m, 0.5 + 0.5 * np.cos((y - c1) / 0.24 * np.pi), W)
    m = (y > c1 + 0.10) & (y < c1 + 0.60)
    B = np.where(m, np.sin((y - c1 - 0.10) / 0.50 * np.pi) ** 2, B)
    return W, B


def build_ground():
    XF = np.arange(-9.0, 9.0 + 1e-6, 0.04)
    XS = np.concatenate([[-320.0], XF, [320.0]])
    YR = np.arange(0.0, ROAD_W + 1e-6, 0.06)
    nx, ny = len(XS), len(YR)
    STATE["XS"] = XS

    # ---- top surface
    gx, gy = np.meshgrid(XS, YR, indexing="ij")
    top = np.stack([gx.ravel(), gy.ravel(), np.zeros(nx * ny)], axis=1)
    ii, jj = np.meshgrid(np.arange(nx - 1), np.arange(ny - 1), indexing="ij")
    a = (ii * ny + jj).ravel()
    faces = np.stack([a, a + ny, a + ny + 1, a + 1], axis=1)
    me = bpy.data.meshes.new("road_top")
    me.from_pydata(top.tolist(), [], faces.tolist())
    me.materials.append(mat("soil_top", "#a8492c", noise=("#96401f", 2.2)))
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.update()
    ob = bpy.data.objects.new("road_top", me)
    bpy.context.scene.collection.objects.link(ob)
    OBJ["road_top"] = ob
    STATE["top_base"] = top
    W, B = wy_profile(YR)
    STATE["top_ix"] = np.repeat(np.arange(nx), ny)
    STATE["top_W"] = np.tile(W, nx)
    STATE["top_B"] = np.tile(B, nx)

    # ---- cut face (y = 0), layered
    ZR = np.concatenate([np.arange(0.0, -1.80 - 1e-6, -0.05), [-2.0, -2.3, -2.8, -3.6, -5.0, -9.0]])
    nz = len(ZR)
    gx, gz = np.meshgrid(XS, ZR, indexing="ij")
    z0 = gz.ravel().copy()
    x0 = gx.ravel()
    taper = np.clip((9.0 - np.abs(x0)) / 2.0, 0, 1)
    g = np.clip(-z0 / 0.5, 0, 1) * np.clip((5.0 + z0) / 2.0, 0, 1)
    wav = 0.05 * np.sin(0.7 * x0 + 0.3) + 0.03 * np.sin(1.9 * x0 + 2.0 + z0)
    zw = z0 + wav * g * taper
    front = np.stack([x0, np.zeros_like(x0), zw], axis=1)
    ii, kk = np.meshgrid(np.arange(nx - 1), np.arange(nz - 1), indexing="ij")
    a = (ii * nz + kk).ravel()
    faces = np.stack([a, a + 1, a + nz + 1, a + nz], axis=1)
    kflat = kk.ravel()
    zc = (ZR[kflat] + ZR[kflat + 1]) / 2
    mi = np.where(zc > -0.80, 0, np.where(zc > -1.70, 2, 4))
    band = (kflat % 4 == 2) & (zc > -1.70) & (zc < -0.08)
    mi = np.where(band, mi + 1, mi)
    me = bpy.data.meshes.new("cut_face")
    me.from_pydata(front.tolist(), [], faces.tolist())
    for m in (mat("soilA", "#9c4226", noise=("#8a391f", 3.0)),
              mat("soilA_band", "#7f3219"),
              mat("soilB", "#4b2a1b", noise=("#3d2216", 3.0)),
              mat("soilB_band", "#38200f"),
              mat("soilC", "#a5591d", noise=("#8f4a15", 2.0))):
        me.materials.append(m)
    me.polygons.foreach_set("material_index", mi.astype(np.int32))
    me.update()
    ob = bpy.data.objects.new("cut_face", me)
    bpy.context.scene.collection.objects.link(ob)
    OBJ["cut_face"] = ob
    STATE["front_base"] = front
    STATE["front_ix"] = np.repeat(np.arange(nx), nz)
    STATE["front_fall"] = np.exp(z0 / 0.9)


def update_ground(P, R):
    top = STATE["top_base"].copy()
    ix = STATE["top_ix"]
    top[:, 2] = P[ix] * STATE["top_W"] + 0.20 * R[ix] * STATE["top_B"]
    me = OBJ["road_top"].data
    me.vertices.foreach_set("co", top.ravel())
    me.update()
    fr = STATE["front_base"].copy()
    fr[:, 2] += P[STATE["front_ix"]] * STATE["front_fall"]
    me = OBJ["cut_face"].data
    me.vertices.foreach_set("co", fr.ravel())
    me.update()


# ------------------------------------------------------------- environment
def build_environment():
    rnd = random.Random(7)
    M = {
        "verge": mat("verge", "#5f9a2e", haze=0.5),
        "bund": mat("bund", "#7b6a35", haze=0.5),
        "padi_base": mat("padi_base", "#3f7d22", haze=0.6),
        "far": mat("far_ground", "#58a530", noise=("#6dba3a", 0.02), haze=0.75),
        "wall": mat("wall", "#f2ead8", haze=0.4),
        "wall2": mat("wall2", "#e9d6a4", haze=0.4),
        "roof": mat("roof", "#c2512f", haze=0.4),
        "wood": mat("wood", "#6b4a2b", haze=0.4),
        "leaf": mat("leaf", "#2f7d32", haze=0.45),
        "leaf2": mat("leaf2", "#4c9a2a", haze=0.45),
        "thatch": mat("thatch", "#b89a56", haze=0.3),
        "mount": mat("mountain", "#8fb0d6", haze=0.9, shadeless=True),
        "dark": mat("dark_door", "#3a2c22", haze=0.4),
    }
    mats = list(M.values())
    idx = {k: i for i, k in enumerate(M)}
    mb = MB()
    # verge behind the road, sloping down to the paddy level
    v = [(-320, ROAD_W, 0), (320, ROAD_W, 0), (320, ROAD_W + 0.7, -0.12), (-320, ROAD_W + 0.7, -0.12)]
    mb.add(v, [(0, 1, 2, 3)], idx["verge"])
    # paddy base near, far green plain
    mb.add([(-60, 4.3, -0.12), (60, 4.3, -0.12), (60, 46, -0.12), (-60, 46, -0.12)], [(0, 1, 2, 3)], idx["padi_base"])
    mb.add([(-2500, 4.3, -0.16), (2500, 4.3, -0.16), (2500, 3000, -0.16), (-2500, 3000, -0.16)], [(0, 1, 2, 3)], idx["far"])
    # far paddies as raised green slabs with slightly different height (patchwork)
    for i in range(-4, 5):
        for j in range(0, 6):
            x0, y0 = i * 34.0, 46.0 + j * 26.0
            h = 0.22 + 0.10 * rnd.random()
            mb.box((x0 + 0.5, y0 + 0.5, -0.16), (x0 + 33.5, y0 + 25.5, h), idx["padi_base"] if (i + j) % 2 else idx["far"])
    # bunds (pematang)
    for yb in (4.5, 18.0, 32.0, 46.0):
        mb.box((-60, yb - 0.35, -0.14), (60, yb + 0.35, 0.10), idx["bund"])
    for xb in (-52, -30, -8, 14, 36, 58):
        mb.box((xb - 0.35, 4.5, -0.14), (xb + 0.35, 46, 0.10), idx["bund"])

    def house(x, y, w, d, h, rot, wall):
        Mx = T(x, y, 0.1) @ RZ(rot)
        mb.box((-w / 2, -d / 2, -0.3), (w / 2, d / 2, h), idx[wall], Mx)
        rh = 0.55 * d / 2 + 0.7
        ov = 0.45
        v = [(-w / 2 - ov, -d / 2 - ov, h), (w / 2 + ov, -d / 2 - ov, h), (w / 2 + ov, d / 2 + ov, h),
             (-w / 2 - ov, d / 2 + ov, h), (-w / 2 - ov, 0, h + rh), (w / 2 + ov, 0, h + rh)]
        f = [(0, 1, 5, 4), (2, 3, 4, 5), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)]
        mb.add(v, f, idx["roof"], Mx)
        mb.box((-0.5, -d / 2 - 0.04, -0.1), (0.5, -d / 2, 2.0), idx["dark"], Mx)
        mb.box((w / 4, -d / 2 - 0.04, 1.1), (w / 4 + 1.0, -d / 2, 2.0), idx["dark"], Mx)

    def tree(x, y, s):
        Mx = T(x, y, 0.0) @ S3(s, s, s)
        mb.prism(6, [(-0.3, 0.22, 0.22), (2.6, 0.14, 0.14)], idx["wood"], Mx)
        for k in range(3):
            c = (rnd.uniform(-0.9, 0.9), rnd.uniform(-0.9, 0.9), 3.1 + rnd.uniform(-0.3, 0.9))
            r = rnd.uniform(1.1, 1.7)
            mb.ico(1, r, idx["leaf"] if k % 2 else idx["leaf2"], Mx @ T(*c) @ S3(1, 1, 0.8), jitter=0.12, rnd=rnd)

    def palm(x, y, s):
        Mx = T(x, y, 0.0) @ S3(s, s, s) @ RZ(rnd.uniform(0, 6.28))
        segs = 5
        px = 0.0
        for k in range(segs):
            z0, z1 = k * 1.5, (k + 1) * 1.5
            x0, x1 = px, px + 0.12 * (k + 1) * 0.5
            Mseg = Mx @ T(x0, 0, z0)
            v = []
            for (xx, zz, r) in ((0, 0, 0.16 - 0.015 * k), (x1 - x0, 1.5, 0.145 - 0.015 * k)):
                for q in range(5):
                    a = 2 * math.pi * q / 5
                    v.append((xx + r * math.cos(a), r * math.sin(a), zz))
            f = [(q, (q + 1) % 5, (q + 1) % 5 + 5, q + 5) for q in range(5)]
            mb.add(v, f, idx["wood"], Mseg)
            px = x1
        top = Mx @ T(px, 0, segs * 1.5)
        for q in range(7):
            a = 2 * math.pi * q / 7 + rnd.uniform(-0.2, 0.2)
            L = rnd.uniform(2.4, 3.0)
            v = [(0, -0.12, 0), (0, 0.12, 0), (L * 0.5, 0.42, 0.35), (L * 0.5, -0.42, 0.35), (L, 0, -0.75)]
            mb.add(v, [(0, 1, 2, 3), (3, 2, 4)], idx["leaf2"] if q % 2 else idx["leaf"], top @ RZ(a))

    # village on the horizon, clustered where the shot cameras look
    houses = [(-34, 58, 0.2), (-24, 66, -0.3), (-12, 60, 0.1), (4, 70, 0.4), (17, 61, -0.2),
              (33, 68, 0.15), (-52, 74, 0.5), (48, 80, -0.4), (-70, 64, 0.0), (-6, 88, 0.3),
              (62, 62, 0.2), (-90, 80, -0.2)]
    for k, (x, y, r) in enumerate(houses):
        house(x, y, rnd.uniform(6, 9), rnd.uniform(5, 6.5), rnd.uniform(2.7, 3.3), r, "wall" if k % 3 else "wall2")
        for _ in range(rnd.randint(1, 3)):
            tree(x + rnd.uniform(-9, 9), y + rnd.uniform(3, 9), rnd.uniform(0.9, 1.5))
        if k % 2 == 0:
            palm(x + rnd.uniform(-7, 7), y + rnd.uniform(-4, 3), rnd.uniform(0.9, 1.2))
    for (x, y, s) in ((-17, 24, 0.9), (9, 33, 1.0), (27, 20, 0.8), (-41, 37, 1.1), (44, 40, 1.0),
                      (-3, 47, 1.2), (-60, 30, 1.0), (20, 46, 1.1), (-28, 46, 0.9)):
        tree(x, y, s)
    for (x, y, s) in ((-3.5, 23, 0.8), (13, 47, 1.0), (-38, 48, 1.0), (31, 33, 0.85)):
        palm(x, y, s)
    # saung (field hut)
    Mx = T(-13.0, 16.0, 0.1) @ RZ(0.3)
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((sx * 1.1 - 0.06, sy * 0.9 - 0.06, -0.2), (sx * 1.1 + 0.06, sy * 0.9 + 0.06, 2.0), idx["wood"], Mx)
    mb.box((-1.25, -1.05, 0.55), (1.25, 1.05, 0.65), idx["wood"], Mx)
    v = [(-1.6, -1.4, 1.9), (1.6, -1.4, 1.9), (1.6, 1.4, 1.9), (-1.6, 1.4, 1.9), (-0.7, 0, 2.9), (0.7, 0, 2.9)]
    mb.add(v, [(0, 1, 5, 4), (2, 3, 4, 5), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)], idx["thatch"], Mx)
    # distant volcano-ish mountain
    Mx = T(-260, 1500, -5)
    mb.prism(9, [(0, 620, 520), (150, 300, 250), (255, 80, 70)], idx["mount"], Mx, rot=0.3)
    Mx = T(520, 1700, -5)
    mb.prism(8, [(0, 500, 420), (120, 200, 170), (165, 50, 45)], idx["mount"], Mx, rot=0.7)
    mb.build("environment", mats, recalc=False)

    # ---- padi tufts (near fields), one mesh, vertex-coloured
    rs = np.random.RandomState(3)
    xs = np.arange(-58.0, 58.0, 0.36)
    ys = np.arange(4.95, 45.7, 0.36)
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    px = gx.ravel() + rs.uniform(-0.07, 0.07, gx.size)
    py = gy.ravel() + rs.uniform(-0.07, 0.07, gx.size)
    keep = np.ones(px.size, bool)
    for yb in (18.0, 32.0):
        keep &= np.abs(py - yb) > 0.5
    for xb in (-52, -30, -8, 14, 36):
        keep &= np.abs(px - xb) > 0.5
    keep &= ~((np.abs(px + 13.0) < 2.2) & (np.abs(py - 16.0) < 2.0))
    # thin out far tufts (cheap LOD)
    far = py > 26
    keep &= ~(far & (rs.rand(px.size) < 0.45))
    px, py = px[keep], py[keep]
    n = px.size
    NB = 4
    ang = rs.uniform(0, 2 * np.pi, (n, NB))
    hgt = rs.uniform(0.40, 0.62, (n, NB))
    lean_ = rs.uniform(0.10, 0.26, (n, NB))
    wid = 0.05
    ca, sa = np.cos(ang), np.sin(ang)
    bx = px[:, None] + np.zeros((n, NB))
    by = py[:, None] + np.zeros((n, NB))
    v0 = np.stack([bx - sa * wid, by + ca * wid, np.full((n, NB), -0.12)], axis=-1)
    v1 = np.stack([bx + sa * wid, by - ca * wid, np.full((n, NB), -0.12)], axis=-1)
    v2 = np.stack([bx + ca * lean_, by + sa * lean_, hgt - 0.12], axis=-1)
    verts = np.stack([v0, v1, v2], axis=2).reshape(-1, 3)
    nt_ = n * NB
    me = bpy.data.meshes.new("padi")
    me.vertices.add(nt_ * 3)
    me.vertices.foreach_set("co", verts.ravel())
    me.loops.add(nt_ * 3)
    me.loops.foreach_set("vertex_index", np.arange(nt_ * 3, dtype=np.int32))
    me.polygons.add(nt_)
    me.polygons.foreach_set("loop_start", np.arange(0, nt_ * 3, 3, dtype=np.int32))
    me.polygons.foreach_set("loop_total", np.full(nt_, 3, dtype=np.int32))
    ca_ = me.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="CORNER")
    g0 = np.array(srgb("#4fa628")[:3])
    g1 = np.array(srgb("#9ccf3a")[:3])
    tmix = rs.uniform(0, 1, nt_)
    base = g0[None, :] * (1 - tmix[:, None]) + g1[None, :] * tmix[:, None]
    col = np.ones((nt_, 3, 4))
    col[:, 0, :3] = base * 0.55
    col[:, 1, :3] = base * 0.55
    col[:, 2, :3] = base * 1.15
    ca_.data.foreach_set("color", col.ravel())
    me.materials.append(mat("padi", "#5cab2c", vcol=True, haze=0.5))
    me.update()
    me.validate()
    ob = bpy.data.objects.new("padi", me)
    bpy.context.scene.collection.objects.link(ob)
    OBJ["padi"] = ob
    STATE["n_tufts"] = n


def build_clouds():
    rnd = random.Random(21)
    mb = MB()
    specs = []
    n = 15
    for k in range(n):
        az = math.radians(-78 + 136 * (k + rnd.uniform(-0.45, 0.45)) / (n - 1))
        el = math.radians(rnd.choice((8, 12, 17, 23, 29, 35)) + rnd.uniform(-2.5, 2.5))
        d = rnd.uniform(650, 1100)
        specs.append((az, el, d, rnd.choice((0.55, 0.7, 0.9, 1.2, 1.6, 2.1))))
    for (az, el, d, s) in specs:
        cx, cy, cz = d * math.sin(az), d * math.cos(az), d * math.tan(el)
        Mx = T(cx, cy, cz) @ RZ(-az) @ S3(s, s, s)
        nb = rnd.randint(4, 9)
        span = rnd.uniform(60, 130)
        for b in range(nb):
            u = (b + 0.5) / nb - 0.5
            r = rnd.uniform(24, 46) * (1.0 - 0.9 * abs(u))
            c = (u * span, rnd.uniform(-14, 14), r * 0.42 + rnd.uniform(-3, 6))
            mb.ico(2, r, 0, Mx @ T(*c) @ S3(1.15, 1.0, 0.72), jitter=0.06, rnd=rnd)
        mb.box((-span * 0.45, -16, -5), (span * 0.45, 16, 6), 0, Mx)
    ob = mb.build("clouds", [mat("cloud", "#ffffff", emit=0.35, rough=1.0, spec=0.0)], recalc=False)
    ob.visible_shadow = False


# --------------------------------------------------------------- character
ARM1, ARM2 = 0.30, 0.33
LEG1, LEG2 = 0.40, 0.40


def build_character():
    skin = mat("skin", "#8d5a3a", rough=0.8)
    shirt = mat("shirt", "#f2b21b", rough=0.85)
    pants = mat("pants", "#27364f", rough=0.9)
    straw = mat("caping", "#d8b469", rough=0.9)
    straw2 = mat("caping_dark", "#a8843f", rough=0.9)
    sandal = mat("sandal", "#2b2522")
    wood = mat("rake_wood", "#b98a52")
    metal = mat("rake_metal", "#3c4046", rough=0.6, spec=0.4)
    mats = [skin, shirt, pants, straw, straw2, sandal]

    mb = MB()  # torso: X fwd, Y left, Z up, origin = pelvis centre
    mb.prism(8, [(-0.15, 0.105, 0.165), (0.05, 0.11, 0.17)], 2, rot=math.pi / 8)
    mb.prism(8, [(0.04, 0.105, 0.165), (0.30, 0.115, 0.19), (0.47, 0.12, 0.225), (0.53, 0.07, 0.12)], 1, rot=math.pi / 8)
    mb.prism(6, [(0.50, 0.05, 0.05), (0.60, 0.045, 0.045)], 0)
    mb.build("c_torso", mats)

    mb = MB()  # head: origin at head base (top of the neck)
    mb.ico(1, 1.0, 0, T(0.0, 0, 0.115) @ S3(0.125, 0.118, 0.14))
    mb.prism(12, [(0.175, 0.34, 0.34), (0.26, 0.15, 0.15), (0.335, 0.0, 0.0)], 3, cap1=False)
    mb.prism(12, [(0.165, 0.34, 0.34), (0.176, 0.345, 0.345)], 4)
    mb.build("c_head", mats)

    for side in ("L", "R"):
        mb = MB()
        mb.prism(6, [(0.03, 0.068, 0.068), (-0.17, 0.060, 0.060)], 1)
        mb.prism(6, [(-0.16, 0.046, 0.046), (-ARM1 - 0.01, 0.041, 0.041)], 0)
        mb.build("c_uarm" + side, mats)
        mb = MB()
        mb.prism(6, [(0.01, 0.042, 0.042), (-0.28, 0.034, 0.034)], 0)
        mb.box((-0.045, -0.030, -0.39), (0.045, 0.030, -0.27), 0)
        mb.build("c_farm" + side, mats)
        mb = MB()
        mb.prism(6, [(0.04, 0.095, 0.092), (-LEG1 - 0.02, 0.070, 0.068)], 2)
        mb.build("c_thigh" + side, mats)
        mb = MB()
        mb.prism(6, [(0.01, 0.056, 0.056), (-LEG2 - 0.02, 0.040, 0.040)], 0)
        mb.build("c_shin" + side, mats)
        mb = MB()
        mb.box((-0.075, -0.052, -0.045), (0.175, 0.052, 0.0), 0)
        mb.box((-0.085, -0.058, -0.07), (0.185, 0.058, -0.045), 5)
        mb.build("c_foot" + side, mats)

    # rake: origin = head bar centre, +Z along the handle, bar along Y, teeth along -X
    mb = MB()
    mb.prism(6, [(0.0, 0.017, 0.017), (1.75, 0.017, 0.017)], 0)
    mb.box((-0.022, -0.26, -0.022), (0.022, 0.26, 0.022), 1)
    for k in range(8):
        y = -0.24 + k * 0.48 / 7
        mb.box((-0.105, y - 0.012, -0.012), (0.0, y + 0.012, 0.012), 1)
    mb.build("rake", [wood, metal])

    # clods on the path
    rnd = random.Random(5)
    soil = mat("clod", "#8c3b1f", noise=("#a54a2a", 6.0))
    cl = []
    for k in range(9):
        x = CHAR_POS.x + 1.12 + 0.68 * (k + rnd.uniform(-0.3, 0.3)) / 8
        y = CHAR_POS.y - 0.06 + rnd.uniform(-0.21, 0.21)
        r = rnd.uniform(0.07, 0.11)
        mb = MB()
        mb.ico(1, r, 0, S3(1.0, 1.0, 0.75), jitter=0.25, rnd=rnd)
        ob = mb.build("clod%d" % k, [soil])
        cl.append({"ob": ob, "x": x, "y": y, "rot": rnd.uniform(0, 6.28), "events": []})
    # static lumps on the not-yet-raked part (behind the character)
    mb = MB()
    for k in range(60):
        x = rnd.uniform(-11.0, -0.75)
        y = rnd.uniform(0.25, ROAD_W - 0.2)
        r = rnd.uniform(0.05, 0.12)
        mb.ico(1, r, 0, T(x, y, r * 0.05) @ RZ(rnd.uniform(0, 6)) @ S3(1, 1, 0.7), jitter=0.25, rnd=rnd)
    mb.build("lumps", [soil])
    STATE["clods"] = cl
    # which clods get hit by each pull stroke
    hit_stroke = {}
    t = -0.6
    while t < 3.2:
        info = rake_solve(t)
        if info["pull"] and info["wr"] < 0.02:
            for k, c in enumerate(cl):
                key = (k, info["stroke"])
                if key not in hit_stroke and info["H"].x <= c["x"] + 0.03:
                    hit_stroke[key] = t
                    c["events"].append(t)
        t += 1 / 240.0


def rake_solve(t):
    """Body + rake kinematics of the raking cycle at time t (shot 1)."""
    f = Vector((1, 0, 0))
    l = Vector((0, 1, 0))
    u = Vector((0, 0, 1))
    Tc = 1.15
    ph = (t + 0.55) / Tc
    stroke = math.floor(ph)
    uu = ph - stroke
    if uu < 0.58:
        s = 1 - smooth(uu / 0.58)
        lift = 0.0
        pull = True
    else:
        v = (uu - 0.58) / 0.42
        s = smooth(v)
        lift = math.sin(math.pi * v)
        pull = False
    w = smooth((t - 2.35) / 0.85)
    wr = smooth((t - 2.45) / 0.75)
    px = lerp(-0.20 + 0.25 * s, 0.06, w)
    pz = lerp(0.80 - 0.03 * s, 0.895 + 0.004 * math.sin(2.1 * t), w)
    lean = lerp(0.42 + 0.30 * s, 0.11 - 0.10 * smooth((t - 3.4) / 0.5) + 0.012 * math.sin(1.7 * t), w)
    sway = 0.014 * math.sin(1.3 * t) * w
    Pc = CHAR_POS + f * px + l * sway + u * pz
    tdir = u * math.cos(lean) + f * math.sin(lean)
    ft = f * math.cos(lean) - u * math.sin(lean)
    Sc = Pc + tdir * 0.46
    Gtop = Sc + f * (-0.10 + 0.22 * s) + u * (-0.22 + 0.02 * s) + l * (-0.06)
    hz = 0.088 + 0.16 * lift
    D = 1.55
    dz = Gtop.z - hz
    ca = math.sqrt(max(D * D - dz * dz, 0.01))
    H_r = Vector((Gtop.x + ca, Gtop.y, hz))
    dir_r = (Gtop - H_r).normalized()
    H_s = CHAR_POS + f * 0.40 + l * (-0.24) + u * 0.03
    dir_s = Vector((0.02, -0.07, 1.0)).normalized()
    H = H_r.lerp(H_s, wr) + u * 0.20 * math.sin(math.pi * wr)
    dirv = dir_r.lerp(dir_s, wr).normalized()
    return dict(f=f, l=l, u=u, s=s, w=w, wr=wr, Pc=Pc, tdir=tdir, ft=ft, lean=lean,
                H=H, dir=dirv, pull=pull, stroke=stroke, t=t)


def ik2(A, Tg, l1, l2, pole):
    d = Tg - A
    dist = d.length
    maxd = (l1 + l2) * 0.999
    if dist > maxd:
        Tg = A + d * (maxd / dist)
        d = Tg - A
        dist = maxd
    dirv = d / dist
    a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    pp = pole - dirv * pole.dot(dirv)
    if pp.length < 1e-6:
        pp = Vector((0, 0, 1))
    pp.normalize()
    return A + dirv * a + pp * h, Tg


def seg_matrix(A, B, fwd):
    """Object whose -Z runs from A to B, X roughly toward fwd."""
    z = (A - B).normalized()
    x = fwd - z * fwd.dot(z)
    if x.length < 1e-6:
        x = Vector((1, 0, 0)) - z * z.x
    x.normalize()
    y = z.cross(x)
    M = Matrix((x, y, z)).transposed().to_4x4()
    M.translation = A
    return M


def basis(x, y, z, o):
    M = Matrix((x, y, z)).transposed().to_4x4()
    M.translation = o
    return M


def pose_character(t):
    k = rake_solve(t)
    f, l, u = k["f"], k["l"], k["u"]
    w, wr, Pc, tdir, ft = k["w"], k["wr"], k["Pc"], k["tdir"], k["ft"]
    tw = lerp(-0.22, 0.0, w) - 0.20 * smooth((t - 3.5) / 0.6)  # torso twist
    ftw = ft * math.cos(tw) + l * math.sin(tw)
    ltw = tdir.cross(ftw)
    OBJ["c_torso"].matrix_world = basis(ftw, ltw, tdir, Pc)

    # head
    hp = lerp(0.55, 0.40, w) - 0.46 * smooth((t - 3.4) / 0.5) + 0.15 * math.exp(-((t - 4.25) / 0.10) ** 2)
    hy = -0.25 * smooth((t - 3.5) / 0.6)
    hf = f * math.cos(hy) + l * math.sin(hy)
    left = u.cross(hf).normalized()
    hf2 = hf * math.cos(hp) - u * math.sin(hp)
    hu2 = hf2.cross(left)
    head_o = Pc + tdir * 0.585
    OBJ["c_head"].matrix_world = basis(hf2, left, hu2, head_o)

    # rake
    H, dirv = k["H"], k["dir"]
    teeth = dirv.cross(l).normalized()
    ry = dirv.cross(-teeth).normalized()
    OBJ["rake"].matrix_world = basis(-teeth, ry, dirv, H)

    # hands
    handR = H + dirv * lerp(1.23, 1.08, wr)
    hand_top = H + dirv * 1.55
    hipL = Pc + ltw * 0.215 + f * 0.04 + tdir * 0.03
    wl = smooth((t - 2.6) / 0.6)
    handL = hand_top.lerp(hipL, wl) + u * 0.10 * math.sin(math.pi * wl)
    wb = smooth((t - 3.45) / 0.45)   # hand up to the hat brim, shading the eyes
    brow = head_o + hf2 * 0.17 + left * 0.09 + hu2 * 0.135
    handL = handL.lerp(brow, wb) + (f * 0.10 + l * 0.08) * math.sin(math.pi * wb)
    shL = Pc + tdir * 0.46 + ltw * 0.215
    shR = Pc + tdir * 0.46 - ltw * 0.215
    poleL = (-u * 0.5 - f * 0.5 + l * 0.6).lerp(l * 1.0 - f * 0.7, wl).lerp(l * 1.0 + f * 0.2 - u * 0.5, wb)
    poleR = -u * 0.6 - f * 0.5 - l * 0.6
    for side, sh, hand, pole in (("L", shL, handL, poleL), ("R", shR, handR, poleR)):
        J, E = ik2(sh, hand, ARM1, ARM2, pole)
        OBJ["c_uarm" + side].matrix_world = seg_matrix(sh, J, f)
        OBJ["c_farm" + side].matrix_world = seg_matrix(J, E, f)

    # legs
    step = smooth((t - 2.62) / 0.42)
    ankL = CHAR_POS + f * 0.12 + l * 0.11 + u * 0.07
    ankR = CHAR_POS + f * lerp(-0.26, -0.03, step) - l * 0.11 + u * (0.07 + 0.08 * math.sin(math.pi * step))
    hipJL = Pc + ltw * 0.09 - tdir * 0.04
    hipJR = Pc - ltw * 0.09 - tdir * 0.04
    for side, hip, ank, sgn in (("L", hipJL, ankL, 1), ("R", hipJR, ankR, -1)):
        J, E = ik2(hip, ank, LEG1, LEG2, f + l * 0.22 * sgn)
        OBJ["c_thigh" + side].matrix_world = seg_matrix(hip, J, f)
        OBJ["c_shin" + side].matrix_world = seg_matrix(J, E, f)
        yaw = 0.16 * sgn
        OBJ["c_foot" + side].matrix_world = T(*E) @ RZ(yaw)

    # clods flatten as the rake drags over them
    for c in STATE["clods"]:
        sc = 1.0
        spread = 1.0
        for te in c["events"]:
            a = smooth((t - te) / 0.14)
            sc *= lerp(1.0, 0.33, a)
            spread *= lerp(1.0, 1.18, a)
        c["ob"].matrix_world = T(c["x"], c["y"], 0.0) @ RZ(c["rot"]) @ S3(spread, spread, sc)


CHAR_PARTS = ["c_torso", "c_head", "rake"] + [p + s for p in ("c_uarm", "c_farm", "c_thigh", "c_shin", "c_foot") for s in "LR"]


# ------------------------------------------------------------------- truck
def wheel(mb, y0, y1, face_sign):
    """Tyre between y0..y1 around the Y axis at the origin; rim detail on the face_sign side."""
    n = 16
    yc = (y0 + y1) / 2
    hw = abs(y1 - y0) / 2
    M = T(0, yc, 0) @ RX(-math.pi / 2)  # prism axis Z -> world Y
    mb.prism(n, [(-hw, RW - 0.06, RW - 0.06), (-hw + 0.05, RW, RW), (hw - 0.05, RW, RW), (hw, RW - 0.06, RW - 0.06)], 0, M)
    for sgn in (-1, 1):
        fy = yc + sgn * (hw + 0.004)
        Mf = T(0, fy, 0) @ RX(-math.pi / 2)
        mb.prism(n, [(-0.006, 0.29, 0.29), (0.006, 0.29, 0.29)], 1, Mf)
        mb.prism(8, [(-0.03, 0.10, 0.10), (0.03, 0.10, 0.10)], 2, Mf)
        for q in range(5):
            a = 2 * math.pi * q / 5
            mb.box((-0.035, -0.012, -0.035), (0.035, 0.012, 0.035), 3,
                   T(0.195 * math.cos(a), fy, 0.195 * math.sin(a)))
        # one painted spoke so the rotation reads clearly
        mb.box((0.10, -0.011, -0.03), (0.285, 0.011, 0.03), 2, T(0, fy, 0))


def build_truck():
    cab = mat("truck_cab", "#f5c21a", rough=0.6, spec=0.3)
    bed = mat("truck_bed", "#1f8f8a", rough=0.75)
    rib = mat("truck_rib", "#146661", rough=0.75)
    dark = mat("truck_dark", "#2a2d33", rough=0.7)
    glass = mat("truck_glass", "#1b2a3d", rough=0.25, spec=0.5)
    lamp = mat("truck_lamp", "#fff3c4", emit=0.6)
    sand = mat("truck_sand", "#c9a56a", noise=("#b8935a", 5.0))
    red = mat("truck_red", "#c7362b")
    mats = [cab, bed, rib, dark, glass, lamp, sand, red]
    mb = MB()
    hw = 1.0
    # chassis
    mb.box((-1.45, -0.40, 0.70), (4.30, 0.40, 0.90), 3)
    mb.box((-0.12, -0.80, 0.40), (0.12, 0.80, 0.56), 3)       # rear axle beam
    mb.box((WB - 0.10, -0.85, 0.40), (WB + 0.10, 0.85, 0.54), 3)
    mb.box((0.95, -0.98, 0.42), (1.85, -0.52, 0.80), 3)       # fuel tank (near side)
    mb.box((0.95, 0.52, 0.42), (1.60, 0.98, 0.80), 3)
    # bed
    bx0, bx1 = -1.55, 2.30
    mb.box((bx0, -hw, 1.02), (bx1, hw, 1.12), 2)
    for sy in (-1, 1):
        y0, y1 = (sy * hw, sy * (hw - 0.05)) if sy > 0 else (sy * hw, sy * (hw - 0.05))
        mb.box((bx0, min(y0, y1), 1.12), (bx1, max(y0, y1), 1.64), 1)
        nr = 7
        for q in range(nr):
            x = bx0 + 0.04 + q * (bx1 - bx0 - 0.08) / (nr - 1)
            mb.box((x - 0.04, sy * hw - (0.03 if sy < 0 else 0.0), 1.02), (x + 0.04, sy * hw + (0.03 if sy > 0 else 0.0), 1.68), 2)
        mb.box((bx0, sy * hw - (0.012 if sy < 0 else 0), 1.365), (bx1, sy * hw + (0.012 if sy > 0 else 0), 1.39), 2)
    mb.box((bx0 - 0.05, -hw, 1.12), (bx0, hw, 1.64), 1)       # tailgate
    mb.box((bx1 - 0.06, -hw, 1.12), (bx1, hw, 1.95), 1)       # headboard
    mb.box((bx1 - 0.07, -hw - 0.02, 1.90), (bx1 + 0.01, hw + 0.02, 1.98), 2)
    # cargo
    mb.ico(2, 1.0, 6, T(0.35, 0, 1.52) @ S3(1.75, 0.90, 0.50), jitter=0.05, rnd=random.Random(2))
    # mudflaps + tail lamps
    for sy in (-1, 1):
        mb.box((-0.66, sy * 0.72 - 0.27, 0.22), (-0.63, sy * 0.72 + 0.27, 0.80), 3)
        mb.box((bx0 - 0.07, sy * 0.80 - 0.10, 0.86), (bx0 - 0.03, sy * 0.80 + 0.10, 0.98), 7)
    # cab: side profile extruded across Y
    prof = [(2.45, 1.00), (4.36, 1.00), (4.40, 1.55), (4.22, 2.24), (4.05, 2.32), (2.45, 2.32)]
    n = len(prof)
    v = [(x, -0.97, z) for (x, z) in prof] + [(x, 0.97, z) for (x, z) in prof]
    f = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    for q in range(n):
        f.append((q, (q + 1) % n, (q + 1) % n + n, q + n))
    mb.add(v, f, 0)
    # windscreen on the slanted front
    dx, dz = 4.22 - 4.40, 2.24 - 1.55
    ln = math.hypot(dx, dz)
    nx_, nz_ = dz / ln, -dx / ln
    p0 = (4.40 + dx * 0.10 + nx_ * 0.012, 1.55 + dz * 0.10 + nz_ * 0.012)
    p1 = (4.40 + dx * 0.93 + nx_ * 0.012, 1.55 + dz * 0.93 + nz_ * 0.012)
    mb.add([(p0[0], -0.86, p0[1]), (p0[0], 0.86, p0[1]), (p1[0], 0.86, p1[1]), (p1[0], -0.86, p1[1])], [(0, 1, 2, 3)], 4)
    for sy in (-1, 1):
        yy = sy * 0.982
        mb.add([(3.02, yy, 1.62), (4.20, yy, 1.62), (4.06, yy, 2.18), (3.02, yy, 2.18)], [(0, 1, 2, 3)], 4)
        mb.box((2.93, yy - 0.006, 1.04), (2.955, yy + 0.006, 2.25), 3)   # door seam
        mb.box((3.45, yy - 0.02, 1.42), (3.62, yy + 0.02, 1.46), 3)      # handle
        mb.box((4.30, sy * 1.02 - 0.03, 1.75), (4.36, sy * 1.02 + 0.10 * sy + 0.03, 2.05), 3)  # mirror
        mb.box((4.39, sy * 0.70 - 0.16, 1.10), (4.43, sy * 0.70 + 0.16, 1.26), 5)   # headlamp
        mb.box((3.80, sy * 0.97 - 0.02, 0.62), (4.36, sy * 0.97 + 0.02, 1.00), 0)   # front fender skirt
        mb.box((2.45, sy * 0.97 - 0.02, 0.72), (2.62, sy * 0.97 + 0.02, 1.00), 0)
    mb.box((4.39, -0.42, 1.08), (4.425, 0.42, 1.40), 3)                  # grille
    mb.box((4.28, -1.00, 0.46), (4.46, 1.00, 0.72), 3)                   # bumper
    mb.box((2.50, -0.30, 2.32), (3.30, 0.30, 2.40), 3)                   # roof vent
    mb.build("truck_body", mats)

    wmats = [mat("tyre", "#1d1e21", rough=0.95), mat("rim", "#c9ccd1", rough=0.5, spec=0.4),
             mat("hub", "#c7362b", rough=0.6), mat("nut", "#3a3d42")]
    specs = {
        "w_rear_near": (0.0, [(-1.00, -0.74), (-0.70, -0.44)]),
        "w_rear_far": (0.0, [(0.44, 0.70), (0.74, 1.00)]),
        "w_front_near": (WB, [(-1.00, -0.72)]),
        "w_front_far": (WB, [(0.72, 1.00)]),
    }
    STATE["wheels"] = {}
    for name, (xl, tyres) in specs.items():
        mb = MB()
        for (y0, y1) in tyres:
            wheel(mb, y0, y1, -1)
        mb.build(name, wmats)
        STATE["wheels"][name] = xl


def truck_state(t):
    """Continuous truck kinematics. Returns None when the truck is off-stage."""
    if CUT1 / FPS <= t < CUT2 / FPS:
        tau = t - CUT1 / FPS
        u = clamp(tau / 2.9)
        xr = -8.0 * (1 - u) ** 2
        S = 0.25 * smooth((tau - 1.3) / 1.6) + 0.05 * smooth((t - T_ARROW) / 0.45)
        moving = 1 - smooth((tau - 2.5) / 0.5)
        Sr, Sf = S, 0.55 * S
    elif t >= CUT2 / FPS:
        xr = X3_0 + V3 * (t - T3_0)
        Sr = Sf = 0.0
        moving = 1.0
    else:
        return None
    th = math.asin((Sr - Sf) / WB)
    root = T(xr, TRUCK_Y, -Sr) @ RY(-th)
    bob = moving * (0.012 * math.sin(2 * math.pi * 2.3 * t) + 0.006 * math.sin(2 * math.pi * 5.1 * t + 1.0))
    bob += (1 - moving) * 0.004 * math.sin(2 * math.pi * 3.7 * t)
    pj = moving * 0.004 * math.sin(2 * math.pi * 1.7 * t + 0.5)
    body = root @ T(0, 0, bob) @ RY(pj)
    return dict(xr=xr, Sr=Sr, Sf=Sf, root=root, body=body, angle=xr / RW)


def precompute_rut():
    XS = STATE["XS"]
    R = np.zeros_like(XS)
    RUT = {}
    SUB = 8
    for fr in range(CUT1, CUT2):
        st = None
        for sub in range(SUB):
            t = (fr - 1 + (sub + 1) / SUB) / FPS
            if t < CUT1 / FPS:
                continue
            st = truck_state(t)
            for xl in (0.0, WB):
                c = st["root"] @ Vector((xl, 0, RW))
                dx = XS - c.x
                inside = np.abs(dx) < RW
                depth = np.sqrt(np.maximum(RW * RW - dx * dx, 0)) - c.z
                R = np.maximum(R, np.where(inside, depth, 0.0))
        P = -R.copy()
        if st is not None:
            for xl, S in ((0.0, st["Sr"]), (WB, st["Sf"])):
                if S > 0:
                    c = st["root"] @ Vector((xl, 0, RW))
                    for off, amp in ((0.66, 0.24), (-0.62, 0.10)):
                        hv = amp * S * np.exp(-((XS - (c.x + off)) / 0.17) ** 2)
                        P = np.where(np.abs(XS - c.x) > RW, P + hv, P)
        P[0] = P[-1] = 0.0
        RUT[fr] = (P, R.copy())
    STATE["rut"] = RUT
    STATE["flat"] = (np.zeros_like(XS), np.zeros_like(XS))


TRUCK_PARTS = ["truck_body", "w_rear_near", "w_rear_far", "w_front_near", "w_front_far"]


def pose_truck(t):
    st = truck_state(t)
    vis = st is not None
    for n in TRUCK_PARTS:
        OBJ[n].hide_render = not vis
        OBJ[n].hide_viewport = not vis
    if not vis:
        for n in TRUCK_PARTS:
            OBJ[n].matrix_world = T(-200, TRUCK_Y, 0)
        return None
    OBJ["truck_body"].matrix_world = st["body"]
    for n, xl in STATE["wheels"].items():
        OBJ[n].matrix_world = st["root"] @ T(xl, 0, RW) @ RY(st["angle"])
    return st


# ------------------------------------------------------------------ gravel
def build_gravel():
    rnd = random.Random(11)
    shapes = []
    for _ in range(14):
        bm = bmesh.new()
        for _ in range(9):
            p = Vector((rnd.gauss(0, 1), rnd.gauss(0, 1), rnd.gauss(0, 1))).normalized()
            p *= rnd.uniform(0.72, 1.0)
            bmesh.ops.create_vert(bm, co=p)
        bmesh.ops.convex_hull(bm, input=bm.verts)
        bm.verts.ensure_lookup_table()
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        used = [v for v in bm.verts if v.link_faces]
        remap = {v.index: i for i, v in enumerate(used)}
        vs = [v.co.copy() for v in used]
        fs = [tuple(remap[v.index] for v in fc.verts) for fc in bm.faces]
        bm.free()
        shapes.append((vs, fs))
    cw, chh = 0.088, 0.082
    verts, faces, sid, cen, delay, cols, fcount = [], [], [], [], [], [], []
    k = 0
    for layer, (yc, xo, zo) in enumerate(((0.012, 0.5, 0.5), (-0.022, 0.25, 0.0), (-0.052, 0.0, 0.35))):
        x = GR_X0 + xo * cw
        while x < GR_X1:
            z = GR_BOT + chh * 0.5 + zo * chh * 0.5
            while z < GR_TOP - 0.035:
                c = Vector((x + rnd.uniform(-0.03, 0.03), yc + rnd.uniform(-0.008, 0.008), z + rnd.uniform(-0.02, 0.02)))
                vs, fs = shapes[rnd.randrange(len(shapes))]
                sc = Vector((rnd.uniform(0.062, 0.088), rnd.uniform(0.050, 0.070), rnd.uniform(0.056, 0.078)))
                Mr = (RZ(rnd.uniform(0, 6.28)) @ RX(rnd.uniform(0, 6.28)) @ RY(rnd.uniform(0, 6.28))).to_3x3()
                o = len(verts)
                for p in vs:
                    q = Mr @ Vector((p.x * sc.x, p.y * sc.y, p.z * sc.z))
                    q.y *= 0.75
                    verts.append(c + q)
                    sid.append(k)
                for fc in fs:
                    faces.append(tuple(i + o for i in fc))
                g = rnd.uniform(0.0, 1.0)
                base = np.array(srgb("#74787d")[:3]) * (1 - g) + np.array(srgb("#c9cbcc")[:3]) * g
                if rnd.random() < 0.12:
                    base = np.array(srgb("#565a60")[:3])
                tint = np.array([rnd.uniform(0.96, 1.05), 1.0, rnd.uniform(0.95, 1.05)])
                cols.append(base * tint)
                fcount.append(len(fs))
                cen.append(c)
                d = (c.x - GR_SWEEP_X0) / GR_SWEEP_V + (z - GR_BOT) * 0.5 + rnd.uniform(0, 0.12) + (0.0 if layer else 0.0)
                delay.append(max(d, 0.0) if c.x > GR_SWEEP_X0 - 0.5 else rnd.uniform(0, 0.25))
                k += 1
                z += chh
            x += cw
    me = bpy.data.meshes.new("gravel")
    me.from_pydata([tuple(v) for v in verts], [], faces)
    ca_ = me.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="CORNER")
    col = np.ones((len(me.loops), 4))
    li = 0
    fi = 0
    for s_i, nf in enumerate(fcount):
        for _ in range(nf):
            nloop = me.polygons[fi].loop_total
            col[li:li + nloop, :3] = cols[s_i]
            li += nloop
            fi += 1
    ca_.data.foreach_set("color", col.ravel())
    me.materials.append(mat("gravel", "#9a9da1", vcol=True, rough=0.85))
    me.update()
    ob = bpy.data.objects.new("gravel", me)
    bpy.context.scene.collection.objects.link(ob)
    OBJ["gravel"] = ob
    STATE["gr_base"] = np.array([tuple(v) for v in verts])
    STATE["gr_sid"] = np.array(sid)
    STATE["gr_cen"] = np.array([tuple(c) for c in cen])
    STATE["gr_delay"] = np.array(delay)
    STATE["n_stones"] = k
    # dark backing strip so no soil shows through the gaps
    mb = MB()
    mb.add([(0, 0, GR_BOT - 0.015), (1, 0, GR_BOT - 0.015), (1, 0, GR_TOP + 0.01), (0, 0, GR_TOP + 0.01)], [(0, 3, 2, 1)], 0)
    mb.build("gravel_back", [mat("gravel_back", "#34373c")], recalc=False)


def pose_gravel(t):
    g = OBJ["gravel"]
    bk = OBJ["gravel_back"]
    vis = t >= CUT2 / FPS
    g.hide_render = bk.hide_render = not vis
    g.hide_viewport = bk.hide_viewport = not vis
    if not vis:
        return
    tt = t - GR_T0
    x = (tt - STATE["gr_delay"]) / 0.30
    x = np.clip(x, 0, 1)
    c1 = 1.70158
    c3 = c1 + 1
    s = 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2
    s = np.where(x <= 0, 0.0, s)
    sv = s[STATE["gr_sid"]][:, None]
    cen = STATE["gr_cen"][STATE["gr_sid"]]
    co = cen + (STATE["gr_base"] - cen) * sv
    g.data.vertices.foreach_set("co", co.ravel())
    g.data.update()
    xf = GR_SWEEP_X0 + GR_SWEEP_V * (tt - 0.62)
    xf = min(xf, GR_X1 + 0.05)
    if xf <= GR_X0:
        bk.hide_render = True
        return
    x0 = GR_X0 - 0.05
    bk.matrix_world = T(x0, -0.004, 0) @ S3(max(xf - x0, 0.001), 1, 1)


# ------------------------------------------------------- load arrow + label
def build_arrow():
    red = mat("arrow", "#ff3b1f", emit=1.6, rough=0.6)
    white = mat("arrow_edge", "#ffffff", emit=1.3)
    navy = mat("badge", "#12203a", emit=0.25)

    def arrow(mb, e, y0, y1, mi):
        sw, hw_, hl, L = 0.075 + e, 0.21 + e * 1.6, 0.36, 1.22
        pts = [(0, -e * 1.8), (hw_, hl), (sw, hl), (sw, L + e), (-sw, L + e), (-sw, hl), (-hw_, hl)]
        n = len(pts)
        v = [(x, y0, z) for (x, z) in pts] + [(x, y1, z) for (x, z) in pts]
        f = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
        for q in range(n):
            f.append((q, (q + 1) % n, (q + 1) % n + n, q + n))
        mb.add(v, f, mi)

    mb = MB()
    arrow(mb, 0.0, -0.05, 0.0, 0)
    arrow(mb, 0.028, -0.03, 0.01, 1)
    mb.build("arrow", [red, white], recalc=False)

    cu = bpy.data.curves.new("label8ton", "FONT")
    cu.body = "8 ton"
    try:
        cu.font = bpy.data.fonts.load(FONT_BOLD)
    except Exception as ex:  # pragma: no cover
        print("font load failed", ex)
    cu.size = 0.30
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.extrude = 0.004
    cu.materials.append(white)
    ob = bpy.data.objects.new("label8ton", cu)
    bpy.context.scene.collection.objects.link(ob)
    ob.rotation_mode = "QUATERNION"
    OBJ["label8ton"] = ob
    # badge: rounded rectangle in the local XY plane of the text
    w, h, r = 0.56, 0.21, 0.13
    pts = []
    for (cx, cy, a0) in ((w - r, h - r, 0), (-(w - r), h - r, 90), (-(w - r), -(h - r), 180), (w - r, -(h - r), 270)):
        for q in range(7):
            a = math.radians(a0 + 90 * q / 6)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a), -0.02))
    mb = MB()
    mb.add(pts, [tuple(range(len(pts)))], 0)
    mb.build("badge", [navy], recalc=False)


def pose_arrow(t, st, cam_pos):
    vis = st is not None and T_ARROW <= t < CUT2 / FPS
    for n in ("arrow", "label8ton", "badge"):
        OBJ[n].hide_render = not vis
        OBJ[n].hide_viewport = not vis
    if not vis:
        return
    a = t - T_ARROW
    hub = st["root"] @ Vector((0.0, -1.0, RW))
    pop = back(a / 0.30)
    press = 0.26 * (1 - smooth(a / 0.40)) + 0.035 * (0.5 - 0.5 * math.cos(2 * math.pi * max(a - 0.45, 0) / 0.75)) * (a > 0.45)
    tip = Vector((hub.x, -0.10, hub.z + press))
    yaw = math.atan2(cam_pos.x - tip.x, -(cam_pos.y - tip.y)) * 0.6
    OBJ["arrow"].matrix_world = T(*tip) @ RZ(yaw) @ S3(pop, 1, pop)
    lp = tip + Vector((0, -0.02, 1.22 * pop + 0.30))
    Ml = T(*lp) @ RZ(yaw) @ RX(math.pi / 2) @ S3(pop, pop, 1)
    OBJ["label8ton"].matrix_world = Ml
    OBJ["badge"].matrix_world = Ml


# ------------------------------------------------------------------ camera
def cam_state(f):
    t = f / FPS
    if f < CUT1:
        u = t / (CUT1 / FPS)
        pos = Vector((3.1, -2.7, 0.62)).lerp(Vector((1.9, -1.9, 0.32)), u)
        tgt = Vector((0.50, 1.9, 0.60)).lerp(Vector((0.30, 1.9, 0.50)), u)
        lens = lerp(29, 32, u)
    elif f < CUT2:
        tau = t - CUT1 / FPS
        g = 1 - (1 - clamp(tau / 3.7)) ** 2.2
        d = tau / 5.6
        pos = Vector((3.6, -6.4, 1.30)).lerp(Vector((1.55, -4.35, 0.62)), g) + Vector((-0.45, 0.25, -0.05)) * d
        tgt = Vector((-1.8, 0.4, 0.70)).lerp(Vector((0.02, 0.30, 0.27)), g) + Vector((0.0, 0.0, 0.0)) * d
        lens = lerp(28, 34, g)
        # the ease-in above runs out at tau 3.7 s and the remaining drift is a pure orbit around
        # the wheel, which reads as a locked-off shot. Add a real push-in for the last 2.2 s.
        e = clamp((tau - 3.4) / 2.2) ** 1.7
        pos = pos + (tgt - pos) * (0.13 * e) + Vector((-0.30, 0.0, 0.06)) * e
    else:
        u = (t - CUT2 / FPS) / ((NFRAMES - CUT2) / FPS)
        pos = Vector((-1.25, -6.7, 1.15)).lerp(Vector((0.85, -6.0, 0.92)), u)
        tgt = Vector((0.05, 0.0, -0.04)).lerp(Vector((0.45, 0.0, 0.0)), u)
        lens = lerp(39, 41, u)
    return pos, tgt, lens


def pose_camera(f):
    pos, tgt, lens = cam_state(f)
    cam = OBJ["Camera"]
    q = (tgt - pos).to_track_quat("-Z", "Y")
    M = q.to_matrix().to_4x4()
    M.translation = pos
    cam.matrix_world = M
    cam.data.lens = lens
    return pos


# ------------------------------------------------------------------- frame
def apply_frame(f):
    t = f / FPS
    pos = pose_camera(f)
    shot1 = f < CUT1
    for n in CHAR_PARTS + [c["ob"].name for c in STATE["clods"]] + ["lumps"]:
        OBJ[n].hide_render = not shot1
        OBJ[n].hide_viewport = not shot1
    if shot1:
        pose_character(t)
    st = pose_truck(t)
    P, R = STATE["rut"].get(f, STATE["flat"])
    key = f if f in STATE["rut"] else -1
    if STATE.get("ground_key") != key:
        update_ground(P, R)
        STATE["ground_key"] = key
    pose_gravel(t)
    pose_arrow(t, st, pos)
    OBJ["clouds"].matrix_world = T(4.0 * t, 0, 0)
    bpy.context.view_layer.update()


def build(res=(1080, 1920)):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    OBJ.clear()
    STATE.clear()
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start = 0
    scene.frame_end = NFRAMES - 1
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "Standard"
    try:
        scene.view_settings.look = "None"
    except Exception:
        pass
    build_world()
    build_ground()
    build_environment()
    build_clouds()
    build_character()
    build_truck()
    build_gravel()
    build_arrow()
    precompute_rut()
    cd = bpy.data.cameras.new("Camera")
    cd.sensor_fit = "VERTICAL"
    cd.sensor_height = 36.0
    cd.clip_start = 0.05
    cd.clip_end = 6000
    cam = bpy.data.objects.new("Camera", cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    OBJ["Camera"] = cam
    apply_frame(0)
    return scene


def setup_cycles(samples=32, denoise=True):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    c = scene.cycles
    c.device = "CPU"
    c.samples = samples
    c.use_adaptive_sampling = True
    c.adaptive_threshold = 0.03
    c.use_denoising = denoise
    try:
        c.denoiser = "OPENIMAGEDENOISE"
    except Exception as ex:
        print("OIDN unavailable:", ex)
    c.max_bounces = 3
    c.diffuse_bounces = 2
    c.glossy_bounces = 1
    c.transmission_bounces = 0
    c.transparent_max_bounces = 2
    c.caustics_reflective = False
    c.caustics_refractive = False
    c.sample_clamp_indirect = 4.0
    scene.render.use_persistent_data = True
    scene.render.threads_mode = "AUTO"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.compression = 15
    scene.render.film_transparent = False


def setup_eevee(samples=8):
    """EEVEE on software GL (Mesa llvmpipe). Needs libEGL + mesa drivers installed."""
    setup_cycles(8)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    e = scene.eevee
    e.taa_render_samples = samples
    for attr, val in (("use_raytracing", False), ("use_volumetric_shadows", False), ("use_gtao", False),
                      ("use_shadows", True), ("shadow_ray_count", 1), ("shadow_step_count", 3),
                      ("use_taa_reprojection", False)):
        try:
            setattr(e, attr, val)
        except Exception as ex:
            print("eevee setting skipped:", attr, ex)
