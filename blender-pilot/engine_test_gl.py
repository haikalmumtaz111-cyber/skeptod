#!/usr/bin/env python3
"""EEVEE / Workbench test on software GL (needs Mesa). One engine per process: python3 engine_test_gl.py BLENDER_EEVEE"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
import scene as S
HERE = os.path.dirname(os.path.abspath(__file__))
eng = sys.argv[1]
sc = S.build((1080, 1920))
S.setup_cycles(16)
sc.render.engine = eng
if eng == "BLENDER_EEVEE":
    try:
        sc.eevee.taa_render_samples = 16
    except Exception as ex:
        print("taa", ex)
res = []
for f in (285, 60, 400):
    S.apply_frame(f)
    p = os.path.join(HERE, "engine_test", "%s_f%04d.png" % (eng.lower(), f))
    if os.path.exists(p): os.remove(p)
    sc.render.filepath = p
    t = time.time()
    bpy.ops.render.render(write_still=True)
    dt = time.time() - t
    print("RESULT", eng, f, "%.2fs" % dt, os.path.exists(p), flush=True)
    res.append({"engine": eng, "frame": f, "sec": round(dt, 2), "ok": os.path.exists(p)})
json.dump(res, open(os.path.join(HERE, "engine_test", eng.lower() + ".json"), "w"))
