#!/usr/bin/env bash
# Sequential sim validation of the FFA brain on a host bot vs the same host without it.
#   tools/ffa-v2-check.sh <base bundle.js> <with-brain bundle.js> [ffa seeds]
# Cold-start guard off in-process (MR_PARAMS initSkipMs): on a loaded machine sim workers are older than
# 6 s at the first hello, which would silently drop the map model (and the FFA brain) for whole workers.
set -u
cd "$(dirname "$0")/.."
BASE="$1"; NEW="$2"; N="${3:-96}"
export MR_PARAMS='{"initSkipMs":1e12}'
run() { timeout 3000 nice -n 10 bun sim/run.ts --jobs 6 --quiet "$@"; }
run --mode squad --seeds 48 --bot "inproc:$BASE" --name v2b_squad --out runs/sim/v2b_squad.json > runs/sim/v2b_squad.txt 2>&1
MR_FFA_TRACE=1 run --mode squad --seeds 48 --bot "inproc:$NEW" --name v2f_squad --out runs/sim/v2f_squad.json > runs/sim/v2f_squad.log 2>&1
run --mode ffa --seeds "$N" --bot "inproc:$BASE" --name v2b_ffa --out runs/sim/v2b_ffa.json > runs/sim/v2b_ffa.txt 2>&1
run --mode ffa --seeds "$N" --bot "inproc:$NEW" --name v2f_ffa --out runs/sim/v2f_ffa.json > runs/sim/v2f_ffa.txt 2>&1
echo "squad (with brain vs base):"; bun sim/run.ts --compare runs/sim/v2f_squad.json runs/sim/v2b_squad.json
echo "FFA brain activations in squad: $(grep -c '^\[ffa [0-9]* [0-9]*\] t=' runs/sim/v2f_squad.log)"
echo "map model limited lines: base $(grep -c 'map model limited' runs/sim/v2b_squad.txt runs/sim/v2b_ffa.txt | paste -sd' ') new $(grep -c 'map model limited' runs/sim/v2f_squad.log runs/sim/v2f_ffa.txt | paste -sd' ')"
echo "ffa:"; python3 -I tools/ffa-compare.py runs/sim/v2f_ffa.json runs/sim/v2b_ffa.json
