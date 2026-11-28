#!/bin/sh
# Full render in resumable chunks. EEVEE on software GL segfaulted once after 44 frames in a single
# process, so each process renders at most 30 frames and the loop restarts until all 450 exist.
cd "$(dirname "$0")"
i=0
while [ "$(ls frames 2>/dev/null | grep -c '^f_.*png$')" -lt 450 ] && [ $i -lt 40 ]; do
  i=$((i+1))
  python3 render.py --engine BLENDER_EEVEE --res 1080x1920 --samples 8 --frames 0-449 --out frames \
      --log render_log.jsonl --max 30 >> render_stdout.log 2>&1
  echo "chunk $i exit=$? frames=$(ls frames | wc -l) $(date +%s)" >> render_chunks.log
done
date +%s > render_end.txt
