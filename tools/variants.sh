#!/usr/bin/env bash
# Run MR_PARAMS variants of a frozen bot snapshot on the calibrated sim (sim/run.ts). MODE=ffa for FFA; BASE=<json> baseline.
#   tools/variants.sh <snapshot> <seeds> 'name|{"json":1}' ...
# Results: runs/var-<snapshot>-<name>.json; summary vs runs/var-<snapshot>-base.json (or the first).
set -uo pipefail
cd "$(dirname "$0")/.."
SIM="$PWD/sim/run.ts"
snap="$1"; seeds="$2"; shift 2
bot="inproc:$PWD/runs/snap/$snap/src/bot.ts"
for v in "$@"; do
  n="${v%%|*}"; j="${v#*|}"
  MR_PARAMS="$j" timeout 1800 bun "$SIM" --mode "${MODE:-squad}" --seeds "$seeds" --jobs 10 --bot "$bot" --name "var-$snap-$n" --out "$PWD/runs/var${MODE:+-$MODE}-$snap-$n.json" --quiet > /dev/null 2>&1
  echo "$n: $(python3 -I tools/ab.py "${BASE:-runs/v0-96.json}" "runs/var${MODE:+-$MODE}-$snap-$n.json" 2>/dev/null | head -1)"
done
