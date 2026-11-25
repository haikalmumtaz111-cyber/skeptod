#!/usr/bin/env bash
# Keeps the animation render alive: if the Python process dies, start it again.
# house_diorama.py skips frames that are already on disk, so each restart resumes.
cd "$(dirname "$0")"
PY=${PYTHON:-python3}
tries=0
while true; do
  n=$(ls frames/frame_????.png 2>/dev/null | wc -l)
  if [ "$n" -ge 120 ]; then break; fi
  tries=$((tries + 1))
  echo "$(date '+%F %T') watchdog: launch #$tries ($n/120 frames on disk)" >> render.log
  "$PY" house_diorama.py --anim "$@" >> render_stdout.log 2>&1
  echo "$(date '+%F %T') watchdog: python exited with code $?" >> render.log
  [ "$tries" -ge 40 ] && { echo "$(date '+%F %T') watchdog: giving up after $tries launches" >> render.log; exit 1; }
  sleep 5
done
echo "$(date '+%F %T') watchdog: all frames present, encoding" >> render.log
"$PY" house_diorama.py --encode >> render_stdout.log 2>&1 && echo "$(date '+%F %T') watchdog: MP4 written" >> render.log
