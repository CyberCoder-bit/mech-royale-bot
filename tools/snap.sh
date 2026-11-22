#!/usr/bin/env bash
# Freeze the current bot (src + data) under runs/snap/<name> so long sim batches are not affected
# by later edits. Prints the in-process bot spec for sim/run.ts.
#   tools/snap.sh v1x   ->   inproc:/abs/path/runs/snap/v1x/src/bot.ts
set -euo pipefail
cd "$(dirname "$0")/.."
name="${1:?name}"
dst="runs/snap/$name"
rm -rf "$dst"
mkdir -p "$dst"
cp -r src data "$dst/"
echo "inproc:$PWD/$dst/src/bot.ts"
