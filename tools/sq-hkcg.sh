#!/usr/bin/env bash
# After the merge check: cube grab under HK0 (48) vs HK-B3.
out=runs/sim/MRG.out
while pgrep -f "bash tools/sq-mrgcheck.sh" > /dev/null; do sleep 3; done
SQ_EXTRA='--squad hunters_know_position=0' tools/sq-variants.sh squad 48 6 HK-cg20 '{"cubeGrab":20}' > /dev/null 2>&1
echo "HK-cg20 $(grep 'points (16' runs/sim/HK-cg20.log | tr -s ' ') | HKbase-var: $(bun sim/run.ts --compare runs/sim/HK-B3.json runs/sim/HK-cg20.json | tail -1)" >> $out
echo DONE2 >> $out
