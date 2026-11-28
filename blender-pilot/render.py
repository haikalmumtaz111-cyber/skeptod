#!/usr/bin/env python3
"""Render frames of the pilot. Resumable: frames already on disk are skipped.

  python3 render.py --frames 0-449 --res 1080x1920 --samples 24 --out frames
  python3 render.py --frames 30,200,400 --res 360x640 --samples 8 --out preview
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402

import scene as S  # noqa: E402


def parse_frames(s):
    out = []
    for part in s.split(","):
        if "-" in part:
            a, b = part.split("-")
            step = 1
            if ":" in b:
                b, step = b.split(":")
            out += list(range(int(a), int(b) + 1, int(step)))
        else:
            out.append(int(part))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", default="0-449")
    ap.add_argument("--res", default="1080x1920")
    ap.add_argument("--samples", type=int, default=24)
    ap.add_argument("--out", default="frames")
    ap.add_argument("--engine", default="CYCLES")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--log", default=None)
    ap.add_argument("--max", type=int, default=0, help="stop after this many rendered frames (0 = no limit)")
    a = ap.parse_args()
    w, h = [int(x) for x in a.res.split("x")]
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, a.out)
    os.makedirs(out, exist_ok=True)
    t0 = time.time()
    sc = S.build((w, h))
    if a.engine == "CYCLES":
        S.setup_cycles(a.samples)
    elif a.engine == "BLENDER_EEVEE":
        S.setup_eevee(a.samples)
    else:
        S.setup_cycles(a.samples)
        sc.render.engine = a.engine
    print("build %.1fs  tufts=%d stones=%d" % (time.time() - t0, S.STATE["n_tufts"], S.STATE["n_stones"]), flush=True)
    times = []
    for f in parse_frames(a.frames):
        path = os.path.join(out, "f_%04d.png" % f)
        if os.path.exists(path) and not a.force:
            continue
        t1 = time.time()
        sc.frame_set(f)
        S.apply_frame(f)
        sc.render.filepath = path
        # silence Blender's per-sample chatter
        fd = os.dup(1)
        dn = os.open(os.devnull, os.O_WRONLY)
        os.dup2(dn, 1)
        try:
            bpy.ops.render.render(write_still=True)
        finally:
            os.dup2(fd, 1)
            os.close(dn)
            os.close(fd)
        dt = time.time() - t1
        times.append((f, dt))
        rss = 0
        try:
            for line in open("/proc/self/status"):
                if line.startswith("VmRSS"):
                    rss = int(line.split()[1]) // 1024
        except Exception:
            pass
        print("frame %d  %.2fs  rss=%dMB" % (f, dt, rss), flush=True)
        if a.log:
            with open(os.path.join(here, a.log), "a") as fh:
                fh.write(json.dumps({"frame": f, "sec": round(dt, 3), "res": a.res, "samples": a.samples,
                                     "engine": a.engine, "rss_mb": rss}) + "\n")
        if a.max and len(times) >= a.max:
            break
    if times:
        tot = sum(d for _, d in times)
        print("rendered %d frames in %.1fs (avg %.2fs/frame)" % (len(times), tot, tot / len(times)), flush=True)


if __name__ == "__main__":
    main()
