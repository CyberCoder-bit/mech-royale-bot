#!/usr/bin/env bash
# Sweep P.earlySafeT (sequential, niced, 6 jobs): squad default, squad HK0 (hunters don't know our
# position) and FFA, 96 seeds each, against a v3 base bundle.
#   tools/early-safe-sweep.sh <base.js> <new.js> "15 25 35 45" [extra MR_PARAMS json fields]
# Base runs are reused when runs/sim/es_b*.json exist.
set -u
cd "$(dirname "$0")/.."
BASE="$1"; NEW="$2"; VALS="$3"; EXTRA="${4:-}"
N=96
run() { timeout 3000 nice -n 10 bun sim/run.ts --jobs 6 --quiet --seeds $N "$@"; }
export MR_PARAMS='{"initSkipMs":1e12}'
[ -s runs/sim/es_bsq.json ] || cp runs/sim/dc_bsq.json runs/sim/es_bsq.json
[ -s runs/sim/es_bffa.json ] || cp runs/sim/dc_bffa.json runs/sim/es_bffa.json
[ -s runs/sim/es_bhk.json ] || run --mode squad --squad hunters_know_position=0 --bot "inproc:$BASE" --name es_bhk --out runs/sim/es_bhk.json > runs/sim/es_bhk.txt 2>&1
for T in $VALS; do
  export MR_PARAMS="{\"initSkipMs\":1e12,\"earlySafeT\":$T$EXTRA}"
  run --mode squad --bot "inproc:$NEW" --name es${T}_sq --out runs/sim/es${T}_sq.json > runs/sim/es${T}_sq.txt 2>&1
  run --mode squad --squad hunters_know_position=0 --bot "inproc:$NEW" --name es${T}_hk --out runs/sim/es${T}_hk.json > runs/sim/es${T}_hk.txt 2>&1
  run --mode ffa --bot "inproc:$NEW" --name es${T}_ffa --out runs/sim/es${T}_ffa.json > runs/sim/es${T}_ffa.txt 2>&1
  echo "=== earlySafeT $T ($MR_PARAMS)"
  echo -n "squad default: "; bun sim/run.ts --compare runs/sim/es${T}_sq.json runs/sim/es_bsq.json | tail -1
  echo -n "squad HK0:     "; bun sim/run.ts --compare runs/sim/es${T}_hk.json runs/sim/es_bhk.json | tail -1
  echo "ffa:"; python3 -I tools/ffa-compare.py runs/sim/es${T}_ffa.json runs/sim/es_bffa.json
  python3 -I tools/ffa-prekill.py runs/sim/es${T}_ffa.json runs/sim/es_bffa.json
done
