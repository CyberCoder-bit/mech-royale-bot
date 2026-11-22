#!/usr/bin/env bash
# Squad-mode calibration against the three official practice scores (same 48 fixed seeds there):
#   kit example 1.15, v0 fighter 3.38, pacifist 0.08.
# usage: sim/calibrate.sh "<squad params>" "<house params>" [seeds] [jobs per bot]
# The three reference bots run in parallel (3 x jobs processes).
set -uo pipefail
cd "$(dirname "$0")/.."
SQ="${1:-}"
HO="${2:-}"
N="${3:-48}"
J="${4:-8}"
tag=$(echo "sq_${SQ}_ho_${HO}" | tr -c 'a-zA-Z0-9_.' '_')
mkdir -p runs/cal
pids=()
names=()
for b in "inproc:src/bot.ts" "inproc:runs/bots/main/src/bot.ts@fighter" "inproc:runs/bots/main/src/bot.ts@pacifist"; do
  name=$(echo "$b" | sed 's/.*@//; s/inproc:src\/bot.ts/example/')
  out="runs/cal/${tag}_${name}.json"
  bun sim/run.ts --mode squad --seeds "$N" --jobs "$J" --bot "$b" --squad "$SQ" --house "$HO" --quiet --out "$out" > /dev/null 2>&1 &
  pids+=($!)
  names+=("$name:$out")
done
wait "${pids[@]}"
for nm in "${names[@]}"; do
  name="${nm%%:*}"
  out="${nm#*:}"
  python3 -I -c "
import json
d=json.load(open('$out'))
s=d['summary']
print(f\"{'$name':9s} pts {s['mean_points']:.2f} ± {s['se_points']:.2f}  surv {s['mean_survival_s']:.0f}s  kills {s['mean_kills']:.2f}  [$SQ | $HO]\")
"
done
