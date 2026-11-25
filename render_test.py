"""Headless Blender (bpy) render pipeline test: spinning gold Suzanne -> PNG sequence -> MP4.

Usage (bpy installed via `pip install bpy`):
    python3 render_test.py --out DIR --test-only          # render 1 frame, print time + estimate
    python3 render_test.py --out DIR                      # auto-pick settings, render all, encode
    python3 render_test.py --out DIR --res 960x540 --samples 16   # force settings

Frames already present in DIR/frames are skipped, so an interrupted run can be resumed.
Settings are pinned in DIR/settings.json on the first full run so a resume never mixes resolutions.
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

FPS = 24
FRAME_START = 1
FRAME_END = 120
BUDGET_SEC = 10 * 60
# Fallback ladder used when the estimate for 120 frames exceeds BUDGET_SEC.
LADDER = [(1280, 720, 32), (960, 540, 32), (960, 540, 16)]


# ---------------------------------------------------------------- scene setup

def make_material(name, base, metallic, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*base, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def aim(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def add_area_light(name, loc, energy, color, size, target):
    data = bpy.data.lights.new(name, type="AREA")
    data.energy = energy
    data.color = color
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = loc
    aim(obj, target)
    return obj


def build_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    # Every keyframe created from here on is LINEAR (works on old and new Action APIs).
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"

    target = (0.0, 0.0, 1.0)

    # Suzanne: gold, subdiv 2, smooth, full Z turn from frame 1 to 121 (frame 121 == frame 1).
    bpy.ops.mesh.primitive_monkey_add(size=2.0, location=target)
    suz = bpy.context.active_object
    suz.name = "Suzanne"
    sub = suz.modifiers.new("Subdivision", "SUBSURF")
    sub.levels = 2
    sub.render_levels = 2
    bpy.ops.object.shade_smooth()
    suz.data.materials.append(make_material("Gold", (1.0, 0.766, 0.336), 1.0, 0.22))
    suz.rotation_euler = (0.0, 0.0, 0.0)
    suz.keyframe_insert("rotation_euler", index=2, frame=1)
    suz.rotation_euler[2] = 2.0 * math.pi
    suz.keyframe_insert("rotation_euler", index=2, frame=121)

    # Floor: dark, slightly glossy. Large so its edge sits on the horizon instead of mid-frame.
    bpy.ops.mesh.primitive_plane_add(size=400.0, location=(0.0, 0.0, 0.0))
    floor = bpy.context.active_object
    floor.name = "Floor"
    floor.data.materials.append(make_material("FloorDark", (0.018, 0.018, 0.022), 0.0, 0.28))

    # World: camera rays see a screen-space dark-blue gradient (deeper toward the top of
    # the frame); every other ray (reflections, lighting) sees one flat dark blue.
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes["Background"]
    bg.inputs["Strength"].default_value = 1.0
    tex = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.70
    ramp.color_ramp.elements[0].color = (0.020, 0.045, 0.120, 1.0)  # near horizon
    ramp.color_ramp.elements[1].position = 1.00
    ramp.color_ramp.elements[1].color = (0.002, 0.005, 0.022, 1.0)  # top edge
    path = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (0.012, 0.025, 0.070, 1.0)
    nt.links.new(tex.outputs["Window"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Y"], ramp.inputs["Fac"])
    nt.links.new(path.outputs["Is Camera Ray"], mix.inputs["Factor"])
    nt.links.new(ramp.outputs["Color"], mix.inputs["B"])
    nt.links.new(mix.outputs["Result"], bg.inputs["Color"])

    # Three-point lighting.
    add_area_light("Key", (4.5, -4.0, 5.0), 900.0, (1.0, 0.82, 0.62), 3.0, target)
    add_area_light("Fill", (-5.0, -3.0, 2.5), 300.0, (0.62, 0.75, 1.0), 4.0, target)
    add_area_light("Rim", (0.5, 5.5, 4.0), 800.0, (0.9, 0.95, 1.0), 2.0, target)

    # Camera: child of a pivot that orbits 30 deg (-15..+15) while the camera dollies in.
    pivot = bpy.data.objects.new("CamPivot", None)
    bpy.context.collection.objects.link(pivot)
    cam_data = bpy.data.cameras.new("Camera")
    cam_data.lens = 50.0
    cam = bpy.data.objects.new("Camera", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.parent = pivot
    scene.camera = cam
    track = cam.constraints.new("TRACK_TO")
    track.target = suz
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"

    pivot.rotation_euler = (0.0, 0.0, math.radians(-15.0))
    pivot.keyframe_insert("rotation_euler", index=2, frame=FRAME_START)
    pivot.rotation_euler[2] = math.radians(15.0)
    pivot.keyframe_insert("rotation_euler", index=2, frame=FRAME_END)
    # Low enough that the horizon (and the sky gradient above it) stays in frame.
    cam.location = (0.0, -10.0, 2.3)
    cam.keyframe_insert("location", frame=FRAME_START)
    cam.location = (0.0, -8.5, 2.1)
    cam.keyframe_insert("location", frame=FRAME_END)

    scene.render.fps = FPS
    scene.render.fps_base = 1.0
    scene.frame_start = FRAME_START
    scene.frame_end = FRAME_END
    return scene, suz


def configure_render(scene, width, height, samples):
    r = scene.render
    r.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    denoise = False
    try:
        import _cycles
        if getattr(_cycles, "with_openimagedenoise", False):
            scene.cycles.use_denoising = True
            scene.cycles.denoiser = "OPENIMAGEDENOISE"
            denoise = True
    except Exception as exc:  # denoiser missing -> render noisy rather than fail
        print(f"[warn] denoiser unavailable: {exc}")
    if not denoise:
        scene.cycles.use_denoising = False
    r.resolution_x = width
    r.resolution_y = height
    r.resolution_percentage = 100
    r.use_persistent_data = True  # keep BVH between frames
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGB"
    r.image_settings.color_depth = "8"
    r.use_file_extension = False
    return denoise


# ---------------------------------------------------------------- checks

def framing_report(scene, suz):
    """Project every evaluated Suzanne vertex for every frame; return worst-case margins (0..1 NDC)."""
    cam = scene.camera
    worst = {"min_x": 1.0, "max_x": 0.0, "min_y": 1.0, "max_y": 0.0}
    for f in range(FRAME_START, FRAME_END + 1):
        scene.frame_set(f)
        dg = bpy.context.evaluated_depsgraph_get()
        ev = suz.evaluated_get(dg)
        mesh = ev.to_mesh()
        mw = ev.matrix_world
        for v in mesh.vertices:
            p = world_to_camera_view(scene, cam, mw @ v.co)
            worst["min_x"] = min(worst["min_x"], p.x)
            worst["max_x"] = max(worst["max_x"], p.x)
            worst["min_y"] = min(worst["min_y"], p.y)
            worst["max_y"] = max(worst["max_y"], p.y)
        ev.to_mesh_clear()
    inside = worst["min_x"] > 0 and worst["min_y"] > 0 and worst["max_x"] < 1 and worst["max_y"] < 1
    return inside, worst


# ---------------------------------------------------------------- rendering

def render_frame(scene, frame, path):
    scene.frame_set(frame)
    tmp = path + ".partial"
    scene.render.filepath = tmp
    t0 = time.perf_counter()
    bpy.ops.render.render(write_still=True)
    dt = time.perf_counter() - t0
    os.replace(tmp, path)  # atomic: a killed render never leaves a "finished" frame behind
    return dt


def test_render(scene, out_dir, width, height, samples):
    configure_render(scene, width, height, samples)
    path = os.path.join(out_dir, f"test_{width}x{height}_{samples}spp.png")
    dt = render_frame(scene, FRAME_START, path)
    est = dt * (FRAME_END - FRAME_START + 1)
    print(f"[test] {width}x{height} {samples}spp: {dt:.2f}s/frame -> est {est:.0f}s ({est/60:.1f} min) for 120 frames")
    return dt, est


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "imageio-ffmpeg"])
        import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def encode(frames_dir, mp4_path):
    cmd = [
        find_ffmpeg(), "-y", "-loglevel", "error",
        "-framerate", str(FPS), "-start_number", str(FRAME_START),
        "-i", os.path.join(frames_dir, "frame_%04d.png"),
        "-frames:v", str(FRAME_END - FRAME_START + 1),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium",
        "-r", str(FPS), "-movflags", "+faststart", mp4_path,
    ]
    print("[encode]", " ".join(cmd))
    subprocess.check_call(cmd)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="render_out")
    ap.add_argument("--test-only", action="store_true")
    ap.add_argument("--res", help="WxH, e.g. 960x540 (skips auto ladder)")
    ap.add_argument("--samples", type=int)
    args = ap.parse_args()

    out_dir = os.path.abspath(args.out)
    frames_dir = os.path.join(out_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    settings_path = os.path.join(out_dir, "settings.json")
    times_path = os.path.join(out_dir, "frame_times.json")

    scene, suz = build_scene()

    inside, worst = framing_report(scene, suz)
    print(f"[framing] all 120 frames inside view: {inside}  worst NDC: "
          + ", ".join(f"{k}={v:.3f}" for k, v in worst.items()))
    if not inside:
        sys.exit("[framing] Suzanne leaves the frame - fix camera before rendering")

    if args.test_only:
        w, h, s = LADDER[0]
        if args.res:
            w, h = map(int, args.res.lower().split("x"))
        s = args.samples or s
        test_render(scene, out_dir, w, h, s)
        return

    # Pick settings: pinned (resume) > forced via CLI > auto ladder.
    if os.path.exists(settings_path):
        cfg = json.load(open(settings_path))
        print(f"[settings] resuming with pinned settings {cfg}")
    elif args.res or args.samples:
        w, h = map(int, (args.res or "1280x720").lower().split("x"))
        cfg = {"width": w, "height": h, "samples": args.samples or 32, "estimate_sec": None}
    else:
        cfg = None
        for w, h, s in LADDER:
            dt, est = test_render(scene, out_dir, w, h, s)
            cfg = {"width": w, "height": h, "samples": s, "test_sec": round(dt, 2), "estimate_sec": round(est)}
            if est <= BUDGET_SEC:
                break
        else:
            print("[settings] even the lowest rung is over budget - rendering with it anyway")
    json.dump(cfg, open(settings_path, "w"), indent=2)

    denoise = configure_render(scene, cfg["width"], cfg["height"], cfg["samples"])
    print(f"[settings] {cfg['width']}x{cfg['height']} {cfg['samples']}spp denoise={denoise}")

    times = json.load(open(times_path)) if os.path.exists(times_path) else {}
    for f in range(FRAME_START, FRAME_END + 1):
        path = os.path.join(frames_dir, f"frame_{f:04d}.png")
        if os.path.exists(path) and os.path.getsize(path) > 0:
            continue
        dt = render_frame(scene, f, path)
        times[str(f)] = round(dt, 3)
        json.dump(times, open(times_path, "w"), indent=1)
        print(f"[render] frame {f:3d}/{FRAME_END}  {dt:.2f}s")

    if times:
        vals = list(times.values())
        print(f"[render] timed frames={len(vals)} total={sum(vals):.1f}s "
              f"avg={sum(vals)/len(vals):.2f}s min={min(vals):.2f}s max={max(vals):.2f}s")

    encode(frames_dir, os.path.join(out_dir, "render_test.mp4"))
    print("[done]", os.path.join(out_dir, "render_test.mp4"))


if __name__ == "__main__":
    main()
