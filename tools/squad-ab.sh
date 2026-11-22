#!/usr/bin/env bash
# Deterministic squad A/B of two bundles (wall-time caps off), with stuck logging via stuck-wrap:
# default squad and an extra --house setting, N seeds each (sequential, niced, 6 jobs).
# Base runs are reused when runs/sim/<tag>_b.json / <tag>_bh.json exist.
#   tools/squad-ab.sh <base.js> <new.js> <tag> [seeds] [house knobs]
set -u
cd "$(dirname "$0")/.."
BASE="$1"; NEW="$2"; T="$3"; N="${4:-480}"; HOUSE="${5:-aim_mul=0.6}"
export MR_PARAMS='{"initSkipMs":1e12,"planCapMs":1e6}'
export MR_FFA="planMs=1e6"
run() { timeout 3000 nice -n 10 bun sim/run.ts --jobs 6 --quiet --mode squad --seeds "$N" --bot inproc:tools/stuck-wrap.ts "$@"; }
[ -s runs/sim/${T}_b.json ] || MR_WRAP_BOT="$BASE" run --name ${T}_b --out runs/sim/${T}_b.json > runs/sim/${T}_b.log 2>&1
MR_WRAP_BOT="$NEW" run --name ${T}_n --out runs/sim/${T}_n.json > runs/sim/${T}_n.log 2>&1
[ -s runs/sim/${T}_bh.json ] || MR_WRAP_BOT="$BASE" run --house "$HOUSE" --name ${T}_bh --out runs/sim/${T}_bh.json > runs/sim/${T}_bh.log 2>&1
MR_WRAP_BOT="$NEW" run --house "$HOUSE" --name ${T}_nh --out runs/sim/${T}_nh.json > runs/sim/${T}_nh.log 2>&1
for x in b n bh nh; do echo -n "${T}_$x: "; python3 -I tools/stuck-report.py runs/sim/${T}_$x.log | head -1; done
echo -n "squad default ($N): "; bun sim/run.ts --compare runs/sim/${T}_n.json runs/sim/${T}_b.json | tail -2 | tr '\n' ' '; echo
echo -n "squad $HOUSE ($N): "; bun sim/run.ts --compare runs/sim/${T}_nh.json runs/sim/${T}_bh.json | tail -2 | tr '\n' ' '; echo
