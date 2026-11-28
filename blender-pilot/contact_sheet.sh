#!/bin/sh
# 1 fps contact sheet (15 tiles) from the final mp4
cd "$(dirname "$0")"
ffmpeg -v error -y -i out/pilot.mp4 -vf "fps=1,scale=360:-1,tile=5x3:padding=6:margin=6:color=white" -frames:v 1 -q:v 2 out/contact_sheet.jpg
