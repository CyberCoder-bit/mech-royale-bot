#!/usr/bin/env bash
# Second replicate of the earlySafeT sweep on seeds 97-192 (sequential, niced, 6 jobs).
#   tools/early-safe-rep.sh <base.js> <new.js> "15 20 25"
set -u
cd "$(dirname "$0")/.."
BASE="$1"; NEW="$2"; VALS="$3"
run() { timeout 3000 nice -n 10 bun sim/run.ts --jobs 6 --quiet --seeds 96 --seed-start 97 "$@"; }
export MR_PARAMS='{"initSkipMs":1e12}'
[ -s runs/sim/esr_bsq.json ] || run --mode squad --bot "inproc:$BASE" --name esr_bsq --out runs/sim/esr_bsq.json > runs/sim/esr_bsq.txt 2>&1
[ -s runs/sim/esr_bhk.json ] || run --mode squad --squad hunters_know_position=0 --bot "inproc:$BASE" --name esr_bhk --out runs/sim/esr_bhk.json > runs/sim/esr_bhk.txt 2>&1
[ -s runs/sim/esr_bffa.json ] || run --mode ffa --bot "inproc:$BASE" --name esr_bffa --out runs/sim/esr_bffa.json > runs/sim/esr_bffa.txt 2>&1
for T in $VALS; do
  export MR_PARAMS="{\"initSkipMs\":1e12,\"earlySafeT\":$T}"
  run --mode squad --bot "inproc:$NEW" --name esr${T}_sq --out runs/sim/esr${T}_sq.json > runs/sim/esr${T}_sq.txt 2>&1
  run --mode squad --squad hunters_know_position=0 --bot "inproc:$NEW" --name esr${T}_hk --out runs/sim/esr${T}_hk.json > runs/sim/esr${T}_hk.txt 2>&1
  run --mode ffa --bot "inproc:$NEW" --name esr${T}_ffa --out runs/sim/esr${T}_ffa.json > runs/sim/esr${T}_ffa.txt 2>&1
  echo "=== earlySafeT $T, seeds 97-192"
  echo -n "squad default: "; bun sim/run.ts --compare runs/sim/esr${T}_sq.json runs/sim/esr_bsq.json | tail -1
  echo -n "squad HK0:     "; bun sim/run.ts --compare runs/sim/esr${T}_hk.json runs/sim/esr_bhk.json | tail -1
  echo "ffa:"; python3 -I tools/ffa-compare.py runs/sim/esr${T}_ffa.json runs/sim/esr_bffa.json
  python3 -I tools/ffa-prekill.py runs/sim/esr${T}_ffa.json runs/sim/esr_bffa.json
  echo "pooled 192 (seeds 1-192):"
  echo -n "  squad: "; python3 -I tools/ffa-compare.py runs/sim/es${T}_sq.json,runs/sim/esr${T}_sq.json runs/sim/es_bsq.json,runs/sim/esr_bsq.json | tail -1
  echo -n "  HK0:   "; python3 -I tools/ffa-compare.py runs/sim/es${T}_hk.json,runs/sim/esr${T}_hk.json runs/sim/es_bhk.json,runs/sim/esr_bhk.json | tail -1
  echo -n "  FFA:   "; python3 -I tools/ffa-compare.py runs/sim/es${T}_ffa.json,runs/sim/esr${T}_ffa.json runs/sim/es_bffa.json,runs/sim/esr_bffa.json | tail -1
done
