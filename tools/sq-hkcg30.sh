#!/usr/bin/env bash
# After sweep c: cube grab 30 m under HK0 (48) vs HK-B3, and the pessimistic model vs P-B2.
out=runs/sim/MRG.out
while pgrep -f "bash tools/sq-sweep4.sh" > /dev/null; do sleep 3; done
SQ_EXTRA='--squad hunters_know_position=0' tools/sq-variants.sh squad 48 6 HK-cg30 '{"cubeGrab":30}' > /dev/null 2>&1
echo "HK-cg30 $(grep 'points (16' runs/sim/HK-cg30.log | tr -s ' ') | HKbase-var: $(bun sim/run.ts --compare runs/sim/HK-B3.json runs/sim/HK-cg30.json | tail -1)" >> $out
SQ_EXTRA='--squad nonhunter_engage_m=60,retaliate_s=6' tools/sq-variants.sh squad 48 6 P-cg30 '{"cubeGrab":30}' > /dev/null 2>&1
echo "P-cg30 $(grep 'points (16' runs/sim/P-cg30.log | tr -s ' ') | Pbase-var: $(bun sim/run.ts --compare runs/sim/P-B2.json runs/sim/P-cg30.json | tail -1)" >> $out
echo DONE3 >> $out
