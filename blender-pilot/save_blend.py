#!/usr/bin/env python3
"""Build the scene, bake every object-level animation to keyframes and save pilot.blend.

Object transforms, visibility and the camera lens are keyed on all 450 frames.
The two per-vertex effects (soil rut under the wheels, gravel stones growing) are
driven by scene.apply_frame() and are NOT stored as keyframes; the .blend holds
them in the state of frame 290 (rut) with the gravel mesh fully grown.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402

import scene as S  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sc = S.build((1080, 1920))
S.setup_eevee(8)
names = (["Camera", "clouds", "gravel", "gravel_back", "arrow", "label8ton", "badge", "lumps"]
         + S.CHAR_PARTS + S.TRUCK_PARTS + [c["ob"].name for c in S.STATE["clods"]])
for n in names:
    S.OBJ[n].rotation_mode = "QUATERNION"
for f in range(S.NFRAMES):
    S.apply_frame(f)
    for n in names:
        ob = S.OBJ[n]
        for path in ("location", "rotation_quaternion", "scale", "hide_render", "hide_viewport"):
            ob.keyframe_insert(path, frame=f)
    S.OBJ["Camera"].data.keyframe_insert("lens", frame=f)
# leave the deforming meshes in a representative state
S.apply_frame(449)
S.apply_frame(290)
txt = bpy.data.texts.new("README")
txt.write("Pilot scene built by scene.py (see blender-pilot/). Object animation is baked to keyframes.\n"
          "Soil rut deformation and gravel growth are per-vertex effects driven by scene.apply_frame(f);\n"
          "re-run render.py to reproduce them. Shot cuts at frames 138 and 306.\n")
for name in ("scene.py", "render.py", "captions.py"):
    t = bpy.data.texts.new(name)
    t.write(open(os.path.join(HERE, name)).read())
sc.frame_set(290)
try:
    bpy.ops.file.pack_all()
except Exception as ex:
    print("pack_all:", ex)
out = os.path.join(HERE, "pilot.blend")
bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
print("saved", out, os.path.getsize(out) // 1024, "KB")
