"""
Minimalist House Cinematic Test
================================

Builds a modern single-storey minimalist house scene entirely from Python (bpy),
animates a 5 second cinematic camera move (24 fps, 120 frames) and renders it
headless on the CPU. No external assets, textures or GUI are used.

Tested with the `bpy` 5.3.0 Python module (pip install bpy) on a CPU-only Linux box.

Usage
-----
    python minimalist_house_animation.py [--mode all|preview|anim|encode|build]
                                         [--engine cycles|eevee] [--samples N]
                                         [--out DIR] [--frames-dir DIR]
                                         [--res-pct 100] [--preview-frame 120]

or with a Blender binary:

    blender -b -P minimalist_house_animation.py -- --mode all

Modes
-----
    preview : render one frame to <out>/preview.png
    anim    : render frames 1..120 to a PNG sequence (existing frames are skipped,
              so an interrupted render can simply be resumed)
    encode  : encode the PNG sequence to <out>/minimalist_house_test.mp4 (H.264)
              with the ffmpeg executable, or with Blender's own FFmpeg (VSE) if no
              ffmpeg executable is found, then verify it with ffprobe
    all     : preview -> anim -> encode
    build   : only build the scene (use with --save-blend to inspect it)

Engine choice
-------------
Default is Cycles on the CPU. Eevee needs an OpenGL/Vulkan context. On a machine
without a GPU it only runs through Mesa's software rasteriser (llvmpipe), which in
the test environment was several times slower than Cycles CPU for this scene, so
Cycles + OpenImageDenoise is used. `--engine eevee` is kept for machines with a GPU.
"""

import argparse
import json
import math
import os
import random
import shutil
import subprocess
import sys
import time
import warnings

import bpy
import bmesh
from mathutils import Vector, noise

warnings.filterwarnings("ignore", category=DeprecationWarning)

FPS = 24
FRAMES = 120  # 120 / 24 = exactly 5.0 s
RES_X, RES_Y = 1280, 720
MP4_NAME = "minimalist_house_test.mp4"
PREVIEW_NAME = "preview.png"


# --------------------------------------------------------------------------------------
# Arguments
# --------------------------------------------------------------------------------------
def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Minimalist house cinematic test")
    ap.add_argument("--mode", choices=["all", "preview", "anim", "encode", "build"], default="all")
    ap.add_argument("--engine", choices=["cycles", "eevee"], default="cycles")
    ap.add_argument("--samples", type=int, default=None, help="render samples (default 28 Cycles / 16 Eevee)")
    ap.add_argument("--out", default=here, help="output folder for mp4/preview/report")
    ap.add_argument("--frames-dir", default=None, help="PNG sequence folder (default <out>/_frames)")
    ap.add_argument("--preview-frame", type=int, default=FRAMES)
    ap.add_argument("--preview-path", default=None, help="override preview output path")
    ap.add_argument("--res-pct", type=int, default=100)
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--end", type=int, default=FRAMES)
    ap.add_argument("--save-blend", default=None)
    args = ap.parse_args(argv)
    args.out = os.path.abspath(args.out)
    args.frames_dir = os.path.abspath(args.frames_dir or os.path.join(args.out, "_frames"))
    if args.samples is None:
        args.samples = 28 if args.engine == "cycles" else 16
    return args


# --------------------------------------------------------------------------------------
# Generic helpers
# --------------------------------------------------------------------------------------
def scene():
    return bpy.context.scene


def link(ob):
    scene().collection.objects.link(ob)
    return ob


def mesh_obj(name, bm, mats=(), smooth=False, loc=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    return link(ob)


def bm_box(bm, mn, mx):
    res = bmesh.ops.create_cube(bm, size=1.0)
    c = [(a + b) * 0.5 for a, b in zip(mn, mx)]
    d = [b - a for a, b in zip(mn, mx)]
    for v in res["verts"]:
        v.co = Vector((c[0] + v.co.x * d[0], c[1] + v.co.y * d[1], c[2] + v.co.z * d[2]))


def bm_cyl(bm, base, r, h, seg=20, r_top=None):
    res = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                                radius1=r, radius2=r if r_top is None else r_top, depth=h)
    off = Vector((base[0], base[1], base[2] + h * 0.5))
    for v in res["verts"]:
        v.co += off


def add_bevel(ob, width=0.012, segments=2):
    m = ob.modifiers.new("Bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    m.angle_limit = math.radians(40)
    return m


def boxes(name, specs, mat, bevel=0.0):
    bm = bmesh.new()
    for mn, mx in specs:
        bm_box(bm, mn, mx)
    ob = mesh_obj(name, bm, [mat])
    if bevel:
        add_bevel(ob, bevel)
    return ob


def box(name, mn, mx, mat, bevel=0.0):
    return boxes(name, [(mn, mx)], mat, bevel)


def cylinders(name, specs, mat, seg=20, smooth=True):
    bm = bmesh.new()
    for base, r, h in specs:
        bm_cyl(bm, base, r, h, seg)
    ob = mesh_obj(name, bm, [mat])
    if smooth:
        # smooth only the side faces, keep caps flat
        for p in ob.data.polygons:
            p.use_smooth = abs(p.normal.z) < 0.5
    return ob


def add_blob(bm, center, radius, seed, sub=3, squash=0.85, amp=0.26, freq=1.5):
    """Displaced icosphere used for foliage clumps (static noise, no modifiers)."""
    res = bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=radius)
    off = Vector((seed * 13.17, seed * 7.31, seed * 3.73))
    for v in res["verts"]:
        n = v.co.normalized()
        p = n * freq + off
        d = noise.fractal(p, 0.7, 2.1, 3) * amp + noise.noise(n * 5.0 + off) * 0.07
        v.co = n * radius * (1.0 + d)
        v.co.z *= squash
        v.co += Vector(center)


def apply_cutters(ob, cutters):
    """Boolean-difference cutters into ob; cut faces take the cutter's material."""
    for i, c in enumerate(cutters):
        m = ob.modifiers.new(f"Cut{i}", "BOOLEAN")
        m.operation = "DIFFERENCE"
        m.solver = "EXACT"
        m.object = c
        m.material_mode = "TRANSFER"
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)
    for c in cutters:
        bpy.data.objects.remove(c, do_unlink=True)


# --------------------------------------------------------------------------------------
# Materials (all procedural)
# --------------------------------------------------------------------------------------
def new_mat(name):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    return m, m.node_tree.nodes, m.node_tree.links


def principled(name, color, rough=0.6, metal=0.0, spec=0.5, emit=None, estr=0.0):
    m, N, L = new_mat(name)
    p = N["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    p.inputs["Specular IOR Level"].default_value = spec
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1.0)
        p.inputs["Emission Strength"].default_value = estr
    return m


def math_node(N, L, op, a, b=None, c=None):
    n = N.new("ShaderNodeMath")
    n.operation = op
    for i, v in enumerate((a, b, c)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            L.new(v, n.inputs[i])
    return n.outputs[0]


def ramp(N, colors):
    r = N.new("ShaderNodeValToRGB")
    els = r.color_ramp.elements
    while len(els) < len(colors):
        els.new(0.5)
    for el, (pos, col) in zip(els, colors):
        el.position = pos
        el.color = (*col, 1.0)
    return r


def add_bump(N, L, p, height_socket, strength=0.2, distance=0.01):
    b = N.new("ShaderNodeBump")
    b.inputs["Strength"].default_value = strength
    b.inputs["Distance"].default_value = distance
    L.new(height_socket, b.inputs["Height"])
    L.new(b.outputs["Normal"], p.inputs["Normal"])
    return b


def mat_plaster(name, color, rough=0.85):
    m, N, L = new_mat(name)
    p = N["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Specular IOR Level"].default_value = 0.35
    tc = N.new("ShaderNodeTexCoord")
    nz = N.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 28.0
    nz.inputs["Detail"].default_value = 4.0
    L.new(tc.outputs["Object"], nz.inputs["Vector"])
    add_bump(N, L, p, nz.outputs["Fac"], 0.06, 0.01)
    return m


def mat_concrete(name, c1, c2, scale=1.5, rough=0.85):
    m, N, L = new_mat(name)
    p = N["Principled BSDF"]
    p.inputs["Roughness"].default_value = rough
    p.inputs["Specular IOR Level"].default_value = 0.3
    tc = N.new("ShaderNodeTexCoord")
    nz = N.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = scale
    nz.inputs["Detail"].default_value = 6.0
    L.new(tc.outputs["Object"], nz.inputs["Vector"])
    r = ramp(N, [(0.35, c1), (0.65, c2)])
    L.new(nz.outputs["Fac"], r.inputs["Fac"])
    L.new(r.outputs["Color"], p.inputs["Base Color"])
    fine = N.new("ShaderNodeTexNoise")
    fine.inputs["Scale"].default_value = 60.0
    L.new(tc.outputs["Object"], fine.inputs["Vector"])
    add_bump(N, L, p, fine.outputs["Fac"], 0.08, 0.01)
    return m


def mat_wood(name, axis="X", slat=0.12, dark=(0.10, 0.045, 0.018), light=(0.34, 0.17, 0.07),
             groove=True, rough=0.5):
    """Procedural wood: wave-texture grain, per-board colour variation, board grooves."""
    m, N, L = new_mat(name)
    p = N["Principled BSDF"]
    p.inputs["Roughness"].default_value = rough
    p.inputs["Specular IOR Level"].default_value = 0.45
    tc = N.new("ShaderNodeTexCoord")
    sep = N.new("ShaderNodeSeparateXYZ")
    L.new(tc.outputs["Object"], sep.inputs[0])
    coord = sep.outputs[axis]

    board = math_node(N, L, "DIVIDE", coord, slat)
    board_id = math_node(N, L, "FLOOR", board)
    wn = N.new("ShaderNodeTexWhiteNoise")
    wn.noise_dimensions = "1D"
    L.new(board_id, wn.inputs["W"])

    wave = N.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.bands_direction = axis
    wave.inputs["Scale"].default_value = 3.5
    wave.inputs["Distortion"].default_value = 7.0
    wave.inputs["Detail"].default_value = 3.0
    wave.inputs["Detail Scale"].default_value = 1.8
    L.new(tc.outputs["Object"], wave.inputs["Vector"])
    r = ramp(N, [(0.15, dark), (0.85, light)])
    L.new(wave.outputs["Fac"], r.inputs["Fac"])

    # brightness per board 0.78..1.22, darker inside the grooves
    var = math_node(N, L, "MULTIPLY_ADD", wn.outputs["Value"], 0.44, 0.78)
    if groove:
        frac = math_node(N, L, "FRACT", board)
        g = math_node(N, L, "LESS_THAN", frac, 0.05)
        dark_mul = math_node(N, L, "MULTIPLY_ADD", g, -0.6, 1.0)
        var = math_node(N, L, "MULTIPLY", var, dark_mul)
        h = math_node(N, L, "SUBTRACT", 1.0, g)
        add_bump(N, L, p, h, 0.5, 0.004)
    hsv = N.new("ShaderNodeHueSaturation")
    L.new(r.outputs["Color"], hsv.inputs["Color"])
    L.new(var, hsv.inputs["Value"])
    L.new(hsv.outputs["Color"], p.inputs["Base Color"])
    return m


def mat_grass(name):
    m, N, L = new_mat(name)
    p = N["Principled BSDF"]
    p.inputs["Roughness"].default_value = 0.95
    p.inputs["Specular IOR Level"].default_value = 0.25
    p.inputs["Sheen Weight"].default_value = 0.4
    p.inputs["Sheen Tint"].default_value = (0.6, 0.9, 0.4, 1.0)
    tc = N.new("ShaderNodeTexCoord")
    big = N.new("ShaderNodeTexNoise")
    big.inputs["Scale"].default_value = 0.18
    big.inputs["Detail"].default_value = 5.0
    L.new(tc.outputs["Object"], big.inputs["Vector"])
    mid = N.new("ShaderNodeTexNoise")
    mid.inputs["Scale"].default_value = 4.0
    L.new(tc.outputs["Object"], mid.inputs["Vector"])
    mix = math_node(N, L, "MULTIPLY_ADD", big.outputs["Fac"], 0.7, 0.0)
    mix = math_node(N, L, "MULTIPLY_ADD", mid.outputs["Fac"], 0.3, mix)
    r = ramp(N, [(0.30, (0.030, 0.085, 0.012)), (0.52, (0.060, 0.150, 0.020)), (0.72, (0.120, 0.200, 0.035))])
    L.new(mix, r.inputs["Fac"])
    L.new(r.outputs["Color"], p.inputs["Base Color"])
    fine = N.new("ShaderNodeTexNoise")
    fine.inputs["Scale"].default_value = 140.0
    fine.inputs["Detail"].default_value = 2.0
    L.new(tc.outputs["Object"], fine.inputs["Vector"])
    add_bump(N, L, p, fine.outputs["Fac"], 0.45, 0.02)
    return m


def mat_foliage(name, c1, c2, seed=0.0):
    m, N, L = new_mat(name)
    p = N["Principled BSDF"]
    p.inputs["Roughness"].default_value = 0.75
    p.inputs["Specular IOR Level"].default_value = 0.35
    p.inputs["Sheen Weight"].default_value = 0.5
    p.inputs["Sheen Tint"].default_value = (0.7, 1.0, 0.5, 1.0)
    tc = N.new("ShaderNodeTexCoord")
    nz = N.new("ShaderNodeTexNoise")
    nz.noise_dimensions = "4D"   # must be set before the "W" socket is available
    nz.inputs["Scale"].default_value = 2.5
    nz.inputs["W"].default_value = seed
    L.new(tc.outputs["Object"], nz.inputs["Vector"])
    r = ramp(N, [(0.35, c1), (0.68, c2)])
    L.new(nz.outputs["Fac"], r.inputs["Fac"])
    vor = N.new("ShaderNodeTexVoronoi")
    vor.inputs["Scale"].default_value = 24.0
    L.new(tc.outputs["Object"], vor.inputs["Vector"])
    # darken cell borders a bit -> leafy clumps
    ao = math_node(N, L, "MULTIPLY_ADD", vor.outputs["Distance"], 0.9, 0.55)
    hsv = N.new("ShaderNodeHueSaturation")
    L.new(r.outputs["Color"], hsv.inputs["Color"])
    L.new(ao, hsv.inputs["Value"])
    L.new(hsv.outputs["Color"], p.inputs["Base Color"])
    add_bump(N, L, p, vor.outputs["Distance"], 0.45, 0.03)
    return m


def mat_glass(name):
    """Light reflective architectural glass: transparent + fresnel-weighted gloss."""
    m, N, L = new_mat(name)
    for n in list(N):
        N.remove(n)
    out = N.new("ShaderNodeOutputMaterial")
    mix = N.new("ShaderNodeMixShader")
    tr = N.new("ShaderNodeBsdfTransparent")
    tr.inputs["Color"].default_value = (0.80, 0.88, 0.88, 1.0)
    gl = N.new("ShaderNodeBsdfGlossy")
    gl.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    gl.inputs["Roughness"].default_value = 0.02
    lw = N.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.35
    mr = N.new("ShaderNodeMapRange")
    mr.inputs["To Min"].default_value = 0.2
    mr.inputs["To Max"].default_value = 0.85
    L.new(lw.outputs["Fresnel"], mr.inputs["Value"])
    L.new(mr.outputs["Result"], mix.inputs["Fac"])
    L.new(tr.outputs[0], mix.inputs[1])
    L.new(gl.outputs[0], mix.inputs[2])
    L.new(mix.outputs[0], out.inputs["Surface"])
    return m


def build_materials():
    M = {}
    M["white"] = mat_plaster("WhitePlaster", (0.80, 0.79, 0.76))
    M["gray"] = mat_plaster("CharcoalGray", (0.105, 0.105, 0.11), rough=0.7)
    M["roof_gray"] = principled("RoofGray", (0.07, 0.07, 0.075), rough=0.6)
    M["concrete"] = mat_concrete("Concrete", (0.30, 0.29, 0.27), (0.42, 0.41, 0.38))
    M["paver"] = mat_concrete("Paver", (0.40, 0.38, 0.35), (0.55, 0.53, 0.50), scale=3.0)
    M["wood_v"] = mat_wood("WoodSlatsVertical", axis="X", slat=0.085)
    M["wood_deck"] = mat_wood("WoodDeck", axis="Y", slat=0.145, rough=0.6)
    M["wood_soffit"] = mat_wood("WoodSoffit", axis="Y", slat=0.11,
                                dark=(0.16, 0.075, 0.03), light=(0.42, 0.22, 0.09))
    M["wood_fascia"] = mat_wood("WoodFascia", axis="Z", slat=0.15, rough=0.6)
    M["wood_door"] = mat_wood("WoodDoor", axis="X", slat=10.0, groove=False,
                              dark=(0.09, 0.04, 0.016), light=(0.30, 0.15, 0.06), rough=0.4)
    M["frame"] = principled("AnthraciteMetal", (0.022, 0.022, 0.024), rough=0.35, metal=0.6)
    M["glass"] = mat_glass("Glass")
    M["interior"] = principled("InteriorWall", (0.62, 0.55, 0.46), rough=0.9, spec=0.3)
    M["sofa"] = principled("Fabric", (0.30, 0.28, 0.25), rough=1.0, spec=0.2)
    M["grass"] = mat_grass("Grass")
    M["leaf"] = mat_foliage("Foliage", (0.030, 0.090, 0.015), (0.095, 0.190, 0.030), 0.3)
    M["leaf_dark"] = mat_foliage("FoliageDark", (0.018, 0.060, 0.012), (0.055, 0.130, 0.022), 1.7)
    M["leaf_bg"] = mat_foliage("FoliageBg", (0.030, 0.075, 0.020), (0.080, 0.150, 0.035), 2.9)
    M["leaf_far"] = mat_foliage("FoliageFar", (0.035, 0.065, 0.035), (0.075, 0.115, 0.060), 4.1)
    M["bark"] = principled("Bark", (0.07, 0.05, 0.035), rough=0.9, spec=0.2)
    M["lamp"] = principled("LampEmission", (0.0, 0.0, 0.0), rough=0.5,
                           emit=(1.0, 0.72, 0.42), estr=18.0)
    return M


# --------------------------------------------------------------------------------------
# Architecture
# --------------------------------------------------------------------------------------
def build_house(M):
    # Ground slab / plinth (leaves room for the terrace deck in front)
    boxes("Plinth", [
        ((-5.3, -3.0, 0.0), (7.3, 3.4, 0.3)),
        ((1.2, -3.25, 0.0), (7.3, -3.0, 0.3)),
        ((-5.3, -3.25, 0.0), (-4.9, -3.0, 0.3)),
    ], M["concrete"], bevel=0.01)

    # Main white volume with living room cut out behind the big window
    main = box("MainVolume", (-5.0, -3.0, 0.3), (2.6, 3.0, 3.5), M["white"])
    cut_specs = [
        ("room_living", (-4.75, -2.85, 0.3), (-1.2, -0.6, 3.2), M["interior"]),
        ("win_front", (-4.5, -3.2, 0.3), (-1.4, -2.8, 3.2), M["frame"]),
        ("win_side", (-5.2, -1.9, 0.6), (-4.7, -0.8, 3.0), M["frame"]),
        ("door_recess", (-0.4, -3.2, 0.3), (0.8, -2.9, 2.9), M["frame"]),
    ]
    cutters = []
    for name, mn, mx, mat in cut_specs:
        c = box("cut_" + name, mn, mx, mat)
        c.hide_render = True
        cutters.append(c)
    apply_cutters(main, cutters)
    add_bevel(main, 0.012)

    # Charcoal side volume (set back), with a ribbon window into a lit room
    side = box("SideVolume", (2.55, -2.2, 0.3), (7.0, 3.0, 3.0), M["gray"])
    cutters = []
    for name, mn, mx, mat in [
        ("room_side", (2.8, -1.95, 0.3), (6.75, 1.5, 2.75), M["interior"]),
        ("win_ribbon", (3.2, -2.4, 1.15), (6.4, -1.9, 2.45), M["frame"]),
    ]:
        c = box("cut_" + name, mn, mx, mat)
        c.hide_render = True
        cutters.append(c)
    apply_cutters(side, cutters)
    add_bevel(side, 0.012)

    # Roofs: cantilevered flat roof over the terrace + lower roof on the side volume
    box("MainRoof", (-5.2, -4.8, 3.5), (2.8, 3.2, 3.78), M["white"], bevel=0.01)
    box("RoofCoping", (-5.22, -4.82, 3.78), (2.82, 3.22, 3.80), M["roof_gray"])
    box("SideRoof", (2.45, -2.35, 3.0), (7.15, 3.15, 3.18), M["roof_gray"], bevel=0.008)
    box("Soffit", (-5.18, -4.78, 3.47), (2.78, -3.0, 3.5), M["wood_soffit"])

    # Wood accent cladding right of the door
    box("WoodCladding", (1.2, -3.05, 0.3), (2.6, -2.99, 3.47), M["wood_v"])

    # Terrace deck, entry step
    box("TerraceDeck", (-4.9, -4.7, 0.0), (1.2, -3.0, 0.3), M["wood_deck"], bevel=0.008)
    # horizontal fascia boards so the deck edges show board faces, not cross-cut grain
    boxes("DeckFascia", [((-4.92, -4.72, 0.0), (1.22, -4.7, 0.29)),
                         ((-4.92, -4.7, 0.0), (-4.9, -3.0, 0.29)),
                         ((1.2, -4.7, 0.0), (1.22, -3.25, 0.29))], M["wood_fascia"])
    box("EntryStep", (-0.6, -5.1, 0.0), (1.0, -4.7, 0.15), M["concrete"], bevel=0.008)

    # Glass panes
    boxes("GlassPanes", [
        ((-4.5, -2.95, 0.3), (-1.4, -2.93, 3.2)),
        ((3.2, -2.13, 1.15), (6.4, -2.11, 2.45)),
        ((-4.91, -1.9, 0.6), (-4.89, -0.8, 3.0)),
    ], M["glass"])

    # Window frames + mullions (one mesh)
    t, d = 0.06, 0.09
    fr = []
    # front picture window (y ~ -2.94)
    x0, x1, z0, z1, yc = -4.5, -1.4, 0.3, 3.2, -2.94
    fr += [((x0, yc - d / 2, z0), (x0 + t, yc + d / 2, z1)), ((x1 - t, yc - d / 2, z0), (x1, yc + d / 2, z1)),
           ((x0, yc - d / 2, z1 - t), (x1, yc + d / 2, z1)), ((x0, yc - d / 2, z0), (x1, yc + d / 2, z0 + t)),
           ((-2.98, yc - d / 2, z0), (-2.92, yc + d / 2, z1))]
    # ribbon window (y ~ -2.12)
    x0, x1, z0, z1, yc = 3.2, 6.4, 1.15, 2.45, -2.12
    fr += [((x0, yc - d / 2, z0), (x0 + t, yc + d / 2, z1)), ((x1 - t, yc - d / 2, z0), (x1, yc + d / 2, z1)),
           ((x0, yc - d / 2, z1 - t), (x1, yc + d / 2, z1)), ((x0, yc - d / 2, z0), (x1, yc + d / 2, z0 + t)),
           ((4.24, yc - d / 2, z0), (4.30, yc + d / 2, z1)), ((5.30, yc - d / 2, z0), (5.36, yc + d / 2, z1))]
    # side window (x ~ -4.9)
    y0, y1, z0, z1, xc = -1.9, -0.8, 0.6, 3.0, -4.9
    fr += [((xc - d / 2, y0, z0), (xc + d / 2, y0 + t, z1)), ((xc - d / 2, y1 - t, z0), (xc + d / 2, y1, z1)),
           ((xc - d / 2, y0, z1 - t), (xc + d / 2, y1, z1)), ((xc - d / 2, y0, z0), (xc + d / 2, y1, z0 + t))]
    boxes("WindowFrames", fr, M["frame"])

    # Door + handle
    box("FrontDoor", (-0.38, -2.95, 0.3), (0.78, -2.9, 2.88), M["wood_door"], bevel=0.006)
    boxes("DoorHandle", [
        ((0.56, -3.03, 0.85), (0.60, -2.99, 2.25)),
        ((0.565, -2.99, 0.95), (0.595, -2.95, 0.99)),
        ((0.565, -2.99, 2.11), (0.595, -2.95, 2.15)),
    ], M["frame"])

    # Interior props seen through the glass
    boxes("Sofa", [((-4.2, -1.45, 0.3), (-2.3, -0.85, 0.72)),
                   ((-4.2, -0.85, 0.3), (-2.3, -0.62, 1.05))], M["sofa"], bevel=0.04)
    box("CoffeeTable", (-3.6, -2.15, 0.3), (-2.8, -1.75, 0.62), M["wood_door"], bevel=0.01)
    boxes("SideRoomShelf", [((3.3, 1.2, 0.3), (6.3, 1.5, 2.1))], M["wood_door"], bevel=0.01)
    pend = bmesh.new()
    bmesh.ops.create_uvsphere(pend, u_segments=16, v_segments=10, radius=0.17)
    mesh_obj("PendantLamp", pend, [M["lamp"]], smooth=True, loc=(-3.2, -1.9, 2.55))
    cylinders("PendantCord", [((-3.2, -1.9, 2.7), 0.006, 0.5)], M["frame"], seg=6)

    # Wall sconces beside the door, downlights in the soffit, garden bollards
    boxes("Sconces", [((-0.96, -3.10, 1.95), (-0.84, -3.0, 2.30)),
                      ((0.94, -3.10, 1.95), (1.06, -3.0, 2.30))], M["frame"], bevel=0.005)
    boxes("SconceGlow", [((-0.94, -3.105, 1.94), (-0.86, -3.03, 1.955)),
                         ((-0.94, -3.105, 2.295), (-0.86, -3.03, 2.31)),
                         ((0.96, -3.105, 1.94), (1.04, -3.03, 1.955)),
                         ((0.96, -3.105, 2.295), (1.04, -3.03, 2.31))], M["lamp"])
    cylinders("Downlights", [((x, -3.9, 3.462), 0.065, 0.01) for x in (-3.6, -1.6, 0.2)], M["lamp"])

    bollards = [(-1.0, -6.6), (1.4, -8.3), (-1.0, -10.0), (1.4, -11.7)]
    cylinders("BollardPosts", [((x, y, 0.0), 0.06, 0.62) for x, y in bollards], M["frame"])
    cylinders("BollardGlow", [((x, y, 0.47), 0.0615, 0.08) for x, y in bollards], M["lamp"])

    # Planters
    box("PlanterBed", (3.0, -3.18, 0.3), (6.85, -2.45, 0.72), M["concrete"], bevel=0.01)
    box("PlanterCube", (-4.6, -4.55, 0.3), (-4.05, -4.0, 0.85), M["concrete"], bevel=0.01)
    cylinders("PlanterPot", [((0.98, -3.42, 0.3), 0.24, 0.5)], M["concrete"], seg=24)

    # Stepping-stone path
    pav = []
    for i in range(11):
        y_top = -5.35 - i * 0.85
        pav.append(((-0.45, y_top - 0.55, 0.0), (0.85, y_top, 0.035)))
    boxes("PathPavers", pav, M["paver"], bevel=0.006)

    return bollards


# --------------------------------------------------------------------------------------
# Landscape / vegetation
# --------------------------------------------------------------------------------------
SWAY = []  # (object, amplitude_deg, frequency_hz, phase)


def canopy_blobs(bm, r, seed, n=11, sub=3):
    """Cluster of small leaf clumps inside an ellipsoid -> reads as a tree crown."""
    rng = random.Random(seed)
    add_blob(bm, (0, 0, r * 0.8), r * 0.68, seed * 31, sub=sub, squash=0.85, amp=0.15, freq=2.2)
    for i in range(n):
        while True:
            p = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
            if p.length <= 1.0:
                break
        c = (p.x * r * 0.62, p.y * r * 0.62, r * 0.8 + p.z * r * 0.5)
        add_blob(bm, c, r * rng.uniform(0.34, 0.5), seed * 31 + i + 1, sub=sub,
                 squash=0.85, amp=0.17, freq=2.4)


def tree(name, base, height, canopy_r, mat, seed, trunk_r=0.11, sway=1.4):
    bm = bmesh.new()
    bm_cyl(bm, (0, 0, 0), trunk_r, height * 0.62, seg=10, r_top=trunk_r * 0.6)
    trunk = mesh_obj(name + "_Trunk", bm, [mat_bark()], loc=base)
    for p in trunk.data.polygons:
        p.use_smooth = True
    # canopy pivots at the top of the trunk, so swaying it bends from there
    pivot_z = height * 0.55
    bm = bmesh.new()
    canopy_blobs(bm, canopy_r, seed)
    canopy = mesh_obj(name + "_Canopy", bm, [mat], smooth=True,
                      loc=(base[0], base[1], base[2] + pivot_z))
    SWAY.append((canopy, sway, 0.42 + 0.05 * (seed % 3), seed * 1.3))
    return trunk, canopy


_BARK = None


def mat_bark():
    global _BARK
    if _BARK is None:
        _BARK = bpy.data.materials["Bark"]
    return _BARK


def bush(name, center, radius, mat, seed, squash=0.8, sway=0.0):
    bm = bmesh.new()
    add_blob(bm, (0, 0, radius * squash * 0.85), radius, seed, sub=3, squash=squash, amp=0.22, freq=1.8)
    ob = mesh_obj(name, bm, [mat], smooth=True, loc=center)
    if sway:
        SWAY.append((ob, sway, 0.55, seed * 0.9))
    return ob


def build_treeline(M):
    """Distant ring of tree clumps that hides the edge of the lawn at the horizon."""
    rng = random.Random(7)
    bm = bmesh.new()
    n = 46
    for i in range(n):
        a = math.radians(-40 + 260 * i / (n - 1) + rng.uniform(-2, 2))
        R = rng.uniform(40, 52)
        cx, cy = R * math.cos(a), 6 + R * math.sin(a)
        for k in range(3):
            rr = rng.uniform(2.6, 4.4)
            add_blob(bm, (cx + rng.uniform(-2.5, 2.5), cy + rng.uniform(-2, 2), rng.uniform(1.5, 4.5)),
                     rr, 500 + i * 3 + k, sub=2, squash=0.95, amp=0.2, freq=2.0)
    ob = mesh_obj("DistantTreeline", bm, [M["leaf_far"]], smooth=True)
    # pure backdrop: it must not block the low golden-hour sun or tint the GI
    ob.visible_shadow = False
    ob.visible_diffuse = False
    ob.visible_glossy = False


def build_landscape(M):
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=400.0)
    mesh_obj("Lawn", bm, [M["grass"]])
    build_treeline(M)

    # Feature trees in front, background trees behind the house
    tree("TreeFrontLeft", (-10.4, -4.4, 0.0), 4.6, 1.6, M["leaf"], seed=1, sway=1.6)
    tree("TreeFrontRight", (9.6, -5.2, 0.0), 3.7, 1.25, M["leaf"], seed=2, sway=1.8)
    tree("TreeBack1", (-11.0, 6.5, 0.0), 6.8, 2.5, M["leaf_bg"], seed=3, trunk_r=0.16, sway=0.8)
    tree("TreeBack2", (-3.2, 10.0, 0.0), 7.6, 2.8, M["leaf_bg"], seed=4, trunk_r=0.18, sway=0.7)
    tree("TreeBack3", (5.5, 9.0, 0.0), 6.4, 2.4, M["leaf_bg"], seed=5, trunk_r=0.16, sway=0.8)
    tree("TreeBack4", (12.5, 4.5, 0.0), 5.6, 2.1, M["leaf_bg"], seed=6, trunk_r=0.15, sway=0.9)

    # Shrubs
    bush("BushLeftA", (-6.1, -3.5, 0.0), 0.62, M["leaf_dark"], 11, sway=1.2)
    bush("BushLeftB", (-6.8, -2.3, 0.0), 0.5, M["leaf"], 12, sway=1.2)
    bush("BushLeftC", (-5.9, -1.2, 0.0), 0.42, M["leaf_dark"], 13)
    for i, x in enumerate((3.55, 4.55, 5.5, 6.35)):
        bush(f"PlanterBush{i}", (x, -2.82, 0.72), 0.36 + 0.05 * (i % 2), M["leaf"], 20 + i, squash=0.75, sway=1.5)
    bush("TerraceShrub", (-4.33, -4.28, 0.85), 0.34, M["leaf_dark"], 31, squash=0.9, sway=1.5)
    bush("PotPlant", (0.98, -3.42, 0.8), 0.3, M["leaf"], 32, squash=1.7, sway=2.0)
    bush("PathBushL", (-1.7, -5.7, 0.0), 0.4, M["leaf_dark"], 41, sway=1.2)
    bush("PathBushR", (2.2, -5.5, 0.0), 0.34, M["leaf"], 42, sway=1.2)
    bush("IndoorPlant", (-1.75, -1.1, 0.3), 0.32, M["leaf"], 51, squash=1.5)


def animate_sway():
    """Gentle wind: small sinusoidal rotations, keyed every 3 frames (bezier = smooth)."""
    for ob, amp, freq, phase in SWAY:
        for f in list(range(1, FRAMES + 1, 3)) + [FRAMES]:
            t = (f - 1) / FPS
            a = math.radians(amp)
            ob.rotation_euler = (
                a * math.sin(2 * math.pi * freq * t + phase),
                a * 0.65 * math.sin(2 * math.pi * freq * 0.77 * t + phase * 1.9),
                a * 0.3 * math.sin(2 * math.pi * freq * 0.5 * t + phase * 0.7),
            )
            ob.keyframe_insert("rotation_euler", frame=f)


# --------------------------------------------------------------------------------------
# Lighting & world
# --------------------------------------------------------------------------------------
def look_rot(direction):
    return Vector(direction).normalized().to_track_quat("-Z", "Y").to_euler()


def add_light(name, kind, loc, energy, color, direction=(0, 0, -1), **kw):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = energy
    ld.color = color
    for k, v in kw.items():
        setattr(ld, k, v)
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    ob.rotation_euler = look_rot(direction)
    return link(ob)


def build_lighting(bollards):
    warm = (1.0, 0.70, 0.42)
    # Golden-hour sun from the front-right, low elevation -> long soft shadows
    el, az = math.radians(13), math.radians(58)
    to_sun = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    add_light("Sun", "SUN", (0, 0, 20), 9.0, (1.0, 0.72, 0.46), direction=-to_sun,
              angle=math.radians(1.5))

    # Interior glow
    add_light("LivingRoomLight", "AREA", (-2.95, -1.75, 3.12), 220, warm, shape="RECTANGLE",
              size=2.6, size_y=1.4)
    add_light("SideRoomLight", "AREA", (4.8, -0.4, 2.68), 140, warm, shape="RECTANGLE",
              size=3.0, size_y=1.6)
    add_light("PendantLight", "POINT", (-3.2, -1.9, 2.55), 25, warm, shadow_soft_size=0.17)

    # Exterior lights: sconce up/down wash, soffit downlights, bollards
    for x in (-0.9, 1.0):
        add_light(f"SconceDown{x}", "SPOT", (x, -3.13, 1.93), 30, warm, direction=(0, -0.08, -1),
                  spot_size=math.radians(55), spot_blend=0.5, shadow_soft_size=0.03)
        add_light(f"SconceUp{x}", "SPOT", (x, -3.13, 2.32), 30, warm, direction=(0, -0.08, 1),
                  spot_size=math.radians(55), spot_blend=0.5, shadow_soft_size=0.03)
    for x in (-3.6, -1.6, 0.2):
        add_light(f"Downlight{x}", "SPOT", (x, -3.9, 3.44), 35, warm, direction=(0, 0, -1),
                  spot_size=math.radians(80), spot_blend=0.6, shadow_soft_size=0.05)
    for i, (x, y) in enumerate(bollards):
        add_light(f"BollardLight{i}", "POINT", (x, y, 0.51), 10, warm, shadow_soft_size=0.05)


def build_world():
    w = bpy.data.worlds.new("GoldenHourSky")
    scene().world = w
    if w.node_tree is None:
        w.use_nodes = True
    N, L = w.node_tree.nodes, w.node_tree.links
    for n in list(N):
        N.remove(n)
    out = N.new("ShaderNodeOutputWorld")
    bg = N.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 0.45
    tc = N.new("ShaderNodeTexCoord")
    sep = N.new("ShaderNodeSeparateXYZ")
    L.new(tc.outputs["Generated"], sep.inputs[0])
    mr = N.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = -0.02
    mr.inputs["From Max"].default_value = 0.75
    L.new(sep.outputs["Z"], mr.inputs["Value"])
    r = ramp(N, [
        (0.00, (1.00, 0.50, 0.24)),   # warm horizon
        (0.08, (1.00, 0.70, 0.45)),
        (0.30, (0.50, 0.62, 0.86)),
        (1.00, (0.14, 0.28, 0.66)),   # zenith blue
    ])
    L.new(mr.outputs["Result"], r.inputs["Fac"])
    L.new(r.outputs["Color"], bg.inputs["Color"])
    L.new(bg.outputs[0], out.inputs["Surface"])


# --------------------------------------------------------------------------------------
# Camera
# --------------------------------------------------------------------------------------
def smoothstep(u):
    u = min(max(u, 0.0), 1.0)
    return u * u * (3.0 - 2.0 * u)


def lerp(a, b, t):
    return a + (b - a) * t


def lerp_v(a, b, t):
    return Vector(a).lerp(Vector(b), t)


def build_camera():
    cd = bpy.data.cameras.new("CinematicCam")
    cd.lens = 30.0
    cd.sensor_width = 36.0
    cd.clip_end = 400.0
    cam = link(bpy.data.objects.new("CinematicCam", cd))
    scene().camera = cam
    target = link(bpy.data.objects.new("CamTarget", None))
    con = cam.constraints.new("TRACK_TO")
    con.target = target
    con.track_axis = "TRACK_NEGATIVE_Z"
    con.up_axis = "UP_Y"

    # Arc dolly: start wide & slightly right of centre, orbit left while pushing in,
    # land on a front-left three-quarter view. One smoothstep over the full 5 s:
    #   0-1 s  ~10 % of the move (establishing, near static)
    #   1-3 s  ~55 % (approach + orbit)
    #   3-5 s  remaining 35 %, easing out into the final hero framing.
    for f in range(1, FRAMES + 1):
        u = (f - 1) / (FRAMES - 1)
        e = smoothstep(u)
        phi = math.radians(lerp(-14.0, 38.0, e))      # azimuth from front, + = towards left side
        radius = lerp(25.0, 14.2, e)
        height = lerp(3.3, 1.85, e)
        tgt = lerp_v((1.0, -1.2, 2.35), (-0.7, -1.0, 1.6), e)
        cam.location = (tgt.x - radius * math.sin(phi), tgt.y - radius * math.cos(phi), height)
        target.location = tgt
        cam.keyframe_insert("location", frame=f)
        target.keyframe_insert("location", frame=f)
    return cam


# --------------------------------------------------------------------------------------
# Render settings
# --------------------------------------------------------------------------------------
def set_look(s):
    s.view_settings.view_transform = "AgX"
    for look in ("AgX - Medium High Contrast", "Medium High Contrast"):
        try:
            s.view_settings.look = look
            break
        except TypeError:
            continue
    s.view_settings.exposure = 0.0


def configure_render(args):
    s = scene()
    s.render.fps = FPS
    s.render.fps_base = 1.0
    s.frame_start = 1
    s.frame_end = FRAMES
    s.render.resolution_x = RES_X
    s.render.resolution_y = RES_Y
    s.render.resolution_percentage = args.res_pct
    s.render.use_motion_blur = False
    s.render.image_settings.file_format = "PNG"
    s.render.image_settings.color_mode = "RGB"
    s.render.image_settings.color_depth = "8"
    s.render.image_settings.compression = 15
    set_look(s)

    if args.engine == "cycles":
        s.render.engine = "CYCLES"
        c = s.cycles
        c.device = "CPU"
        c.samples = args.samples
        c.use_adaptive_sampling = True
        c.adaptive_threshold = 0.05
        c.use_denoising = True
        c.denoiser = "OPENIMAGEDENOISE"
        c.denoising_input_passes = "RGB_ALBEDO_NORMAL"
        c.denoising_prefilter = "ACCURATE"
        c.max_bounces = 4
        c.diffuse_bounces = 2
        c.glossy_bounces = 2
        c.transmission_bounces = 2
        c.transparent_max_bounces = 8
        c.volume_bounces = 0
        c.caustics_reflective = False
        c.caustics_refractive = False
        c.blur_glossy = 1.0
        c.sample_clamp_indirect = 8.0
        s.render.use_persistent_data = True
    else:
        prefs = bpy.context.preferences.system
        prefs.gpu_backend = "OPENGL"
        s.render.engine = "BLENDER_EEVEE"
        e = s.eevee
        e.taa_render_samples = args.samples
        e.use_shadows = True
        e.use_raytracing = True
        e.use_fast_gi = True


# --------------------------------------------------------------------------------------
# Rendering / encoding / verification
# --------------------------------------------------------------------------------------
FRAME_TIMES = {}


def _pre(sc, *_):
    FRAME_TIMES["_t"] = time.time()


def _post(sc, *_):
    dt = time.time() - FRAME_TIMES.get("_t", time.time())
    FRAME_TIMES[sc.frame_current] = dt
    print(f"[render] frame {sc.frame_current:3d}/{FRAMES}  {dt:6.2f} s", flush=True)


def frame_path(frames_dir, f):
    return os.path.join(frames_dir, f"frame_{f:04d}.png")


def render_preview(args):
    s = scene()
    path = args.preview_path or os.path.join(args.out, PREVIEW_NAME)
    s.frame_set(args.preview_frame)
    s.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    dt = time.time() - t
    print(f"[preview] frame {args.preview_frame} -> {path} in {dt:.1f} s", flush=True)
    # The preview frame is identical to that frame of the sequence: reuse it.
    if args.res_pct == 100 and args.preview_path is None:
        os.makedirs(args.frames_dir, exist_ok=True)
        dst = frame_path(args.frames_dir, args.preview_frame)
        if not os.path.exists(dst):
            shutil.copyfile(path, dst)
    return dt


def render_animation(args):
    s = scene()
    os.makedirs(args.frames_dir, exist_ok=True)
    s.frame_start, s.frame_end = args.start, args.end
    s.render.filepath = os.path.join(args.frames_dir, "frame_####")
    s.render.use_file_extension = True
    s.render.use_overwrite = False      # resume: skip frames already on disk
    s.render.use_placeholder = False
    bpy.app.handlers.render_pre.append(_pre)
    bpy.app.handlers.render_post.append(_post)
    t = time.time()
    bpy.ops.render.render(animation=True)
    dt = time.time() - t
    s.frame_start, s.frame_end = 1, FRAMES
    print(f"[anim] frames {args.start}-{args.end} done in {dt:.1f} s", flush=True)
    return dt


def encode_with_blender(frames, mp4):
    """Fallback: Blender's own FFmpeg via the video sequencer (no 3D re-render)."""
    enc = bpy.data.scenes.new("Encode")
    enc.render.resolution_x, enc.render.resolution_y = RES_X, RES_Y
    enc.render.resolution_percentage = 100
    enc.render.fps, enc.render.fps_base = FPS, 1.0
    enc.view_settings.view_transform = "Standard"   # frames are already display-referred
    se = enc.sequence_editor_create()
    strip = se.strips.new_image(name="frames", filepath=frames[0], channel=1, frame_start=1)
    for f in frames[1:]:
        strip.elements.append(os.path.basename(f))
    enc.frame_start, enc.frame_end = 1, len(frames)
    img = enc.render.image_settings
    if hasattr(img, "media_type"):
        img.media_type = "VIDEO"
    img.file_format = "FFMPEG"
    ff = enc.render.ffmpeg
    ff.format = "MPEG4"
    ff.codec = "H264"
    ff.constant_rate_factor = "HIGH"
    ff.ffmpeg_preset = "GOOD"
    tmp_dir = os.path.join(os.path.dirname(mp4), "_vse_tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    enc.render.filepath = os.path.join(tmp_dir, "video_")
    enc.render.use_file_extension = True
    bpy.ops.render.render(animation=True, scene=enc.name)
    produced = [os.path.join(tmp_dir, f) for f in os.listdir(tmp_dir) if f.endswith(".mp4")]
    if not produced:
        raise RuntimeError("Blender FFmpeg fallback produced no mp4")
    shutil.move(produced[0], mp4)
    shutil.rmtree(tmp_dir, ignore_errors=True)


def encode(args):
    frames = [frame_path(args.frames_dir, f) for f in range(1, FRAMES + 1)]
    missing = [p for p in frames if not os.path.exists(p)]
    if missing:
        raise RuntimeError(f"{len(missing)} frame(s) missing, e.g. {missing[0]}: render first")
    mp4 = os.path.join(args.out, MP4_NAME)
    ffmpeg = shutil.which("ffmpeg")
    t = time.time()
    if ffmpeg:
        cmd = [ffmpeg, "-y", "-loglevel", "error", "-framerate", str(FPS), "-start_number", "1",
               "-i", os.path.join(args.frames_dir, "frame_%04d.png"), "-frames:v", str(FRAMES),
               "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
               "-r", str(FPS), "-movflags", "+faststart", mp4]
        print("[encode]", " ".join(cmd), flush=True)
        subprocess.run(cmd, check=True)
        method = "ffmpeg executable (libx264)"
    else:
        print("[encode] no ffmpeg executable, using Blender FFmpeg (VSE)", flush=True)
        encode_with_blender(frames, mp4)
        method = "Blender internal FFmpeg (H.264)"
    dt = time.time() - t
    return mp4, method, dt


def probe(mp4):
    info = {"path": mp4, "exists": os.path.exists(mp4)}
    if not info["exists"]:
        return info
    info["size_bytes"] = os.path.getsize(mp4)
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        out = subprocess.run([ffprobe, "-v", "error", "-count_frames", "-select_streams", "v:0",
                              "-show_entries",
                              "stream=codec_name,width,height,r_frame_rate,nb_read_frames,duration,pix_fmt"
                              ":format=duration",
                              "-of", "json", mp4], capture_output=True, text=True, check=True)
        j = json.loads(out.stdout)
        st = j["streams"][0]
        info.update(codec=st.get("codec_name"), width=st.get("width"), height=st.get("height"),
                    fps=st.get("r_frame_rate"), frames=int(st.get("nb_read_frames", 0)),
                    pix_fmt=st.get("pix_fmt"), stream_duration=float(st.get("duration", 0)),
                    container_duration=float(j["format"]["duration"]))
    return info


# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------
def build_scene(args):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M = build_materials()
    bollards = build_house(M)
    build_landscape(M)
    animate_sway()
    build_lighting(bollards)
    build_world()
    build_camera()
    configure_render(args)
    n_obj = len(bpy.data.objects)
    n_tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons)
                 for o in bpy.data.objects if o.type == "MESH")
    print(f"[scene] {n_obj} objects, ~{n_tris} triangles (before bevel), engine={scene().render.engine}",
          flush=True)
    return n_obj, n_tris


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    t0 = time.time()
    n_obj, n_tris = build_scene(args)
    t_build = time.time() - t0
    if args.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save_blend))

    report_path = os.path.join(args.out, "render_report.json")
    report = {}
    if os.path.exists(report_path):
        try:
            with open(report_path) as fh:
                report = json.load(fh)
        except (OSError, ValueError):
            report = {}
    report.update(blender_version=bpy.app.version_string, engine=scene().render.engine,
                  device="CPU", samples=args.samples, resolution=f"{RES_X}x{RES_Y}",
                  resolution_percentage=args.res_pct, fps=FPS, frames=FRAMES,
                  objects=n_obj, triangles_before_bevel=n_tris, scene_build_s=round(t_build, 2))

    if args.mode in ("preview", "all"):
        report["preview_render_s"] = round(render_preview(args), 2)
    if args.mode in ("anim", "all"):
        dt = render_animation(args)
        times = [v for k, v in FRAME_TIMES.items() if isinstance(k, int)]
        report["animation_render_s"] = round(dt, 2)
        if times:
            report["frames_rendered_this_run"] = len(times)
            report["avg_frame_s"] = round(sum(times) / len(times), 2)
    if args.mode in ("encode", "all"):
        mp4, method, dt = encode(args)
        report["encode_method"] = method
        report["encode_s"] = round(dt, 2)
        report["video"] = probe(mp4)
        v = report["video"]
        print(f"[verify] {json.dumps(v)}", flush=True)
        ok = (v.get("exists") and v.get("frames") == FRAMES and v.get("width") == RES_X
              and v.get("height") == RES_Y and abs(v.get("stream_duration", 0) - 5.0) < 1e-3)
        report["video_ok"] = bool(ok)
        if not ok:
            raise SystemExit("[verify] video does NOT match spec (120 frames, 1280x720, 5.000 s)")

    if args.mode != "build":
        with open(report_path, "w") as fh:
            json.dump(report, fh, indent=2)
        print(f"[report] {report_path}", flush=True)


if __name__ == "__main__":
    main()
