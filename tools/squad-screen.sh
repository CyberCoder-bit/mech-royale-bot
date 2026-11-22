#!/usr/bin/env bash
# Deterministic squad parameter screen on ONE bundle: base and each variant (MR_PARAMS JSON fields)
# under the default squad model and --house aim_mul=0.6, N paired seeds each (sequential, niced).
#   tools/squad-screen.sh <bundle.js> <tag> <N> '<json fields>' ['<json fields>' ...]
# e.g. tools/squad-screen.sh runs/bots/scr.js scr 480 '"huntHp":0.45' '"cubeGrab":0'
set -u
cd "$(dirname "$0")/.."
B="$1"; T="$2"; N="$3"; shift 3
BASEP='"initSkipMs":1e12,"planCapMs":1e6'
export MR_FFA="planMs=1e6"
run() { timeout 3000 nice -n 10 bun sim/run.ts --jobs 6 --quiet --mode squad --seeds "$N" --seed-start "${S0:-1}" --bot "inproc:$B" "$@"; }
[ -s runs/sim/${T}_base.json ] || MR_PARAMS="{$BASEP}" run --name ${T}_base --out runs/sim/${T}_base.json > runs/sim/${T}_base.txt 2>&1
[ -s runs/sim/${T}_baseh.json ] || MR_PARAMS="{$BASEP}" run --house aim_mul=0.6 --name ${T}_baseh --out runs/sim/${T}_baseh.json > runs/sim/${T}_baseh.txt 2>&1
i=0
for v in "$@"; do
  i=$((i + 1))
  name=$(echo "$v" | tr -cd 'a-zA-Z0-9.' )
  [ -s runs/sim/${T}_$name.json ] || MR_PARAMS="{$BASEP,$v}" run --name ${T}_$name --out runs/sim/${T}_$name.json > runs/sim/${T}_$name.txt 2>&1
  [ -s runs/sim/${T}_${name}_h.json ] || MR_PARAMS="{$BASEP,$v}" run --house aim_mul=0.6 --name ${T}_${name}_h --out runs/sim/${T}_${name}_h.json > runs/sim/${T}_${name}_h.txt 2>&1
  d=$(bun sim/run.ts --compare runs/sim/${T}_$name.json runs/sim/${T}_base.json | tail -1 | sed 's/^A - B: //')
  h=$(bun sim/run.ts --compare runs/sim/${T}_${name}_h.json runs/sim/${T}_baseh.json | tail -1 | sed 's/^A - B: //')
  echo "| $v | $d | $h |"
done
