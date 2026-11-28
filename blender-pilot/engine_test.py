#!/usr/bin/env python3
"""Render one test frame at final resolution with every engine that will start,
and log seconds per frame to engine_test.json."""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402

import scene as S  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "engine_test")
os.makedirs(OUT, exist_ok=True)
FRAMES = [int(x) for x in (sys.argv[1] if len(sys.argv) > 1 else "285,60,400").split(",")]
RES = (1080, 1920)
results = []


def run(label, engine, samples=None):
    sc = bpy.context.scene
    try:
        if engine == "CYCLES":
            S.setup_cycles(samples)
        else:
            sc.render.engine = engine
    except Exception as ex:
        results.append({"label": label, "engine": engine, "ok": False, "error": str(ex)[:300]})
        print(label, "FAILED to select:", ex, flush=True)
        return
    for f in FRAMES:
        S.apply_frame(f)
        path = os.path.join(OUT, "%s_f%04d.png" % (label, f))
        if os.path.exists(path):
            os.remove(path)
        sc.render.filepath = path
        t = time.time()
        err = None
        try:
            bpy.ops.render.render(write_still=True)
        except Exception as ex:
            err = str(ex)[:300]
        dt = time.time() - t
        ok = err is None and os.path.exists(path)
        results.append({"label": label, "engine": engine, "samples": samples, "frame": f, "sec": round(dt, 2),
                        "ok": ok, "error": err})
        print("RESULT", label, f, "%.2fs" % dt, "ok" if ok else "FAIL %s" % err, flush=True)
        if not ok:
            break


sc = S.build(RES)
enum = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
print("engines enum:", enum, "version", bpy.app.version_string, flush=True)
for smp in (16, 32, 64):
    run("cycles%d" % smp, "CYCLES", smp)
for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"):
    run(eng.lower(), eng)
json.dump({"blender": bpy.app.version_string, "res": RES, "results": results},
          open(os.path.join(HERE, "engine_test.json"), "w"), indent=1)
