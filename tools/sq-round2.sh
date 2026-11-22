#!/usr/bin/env bash
# Second round (after sq-validate.sh): FFA loot range in FFA mode, kill-cube grab in squad (default + HK0).
out=runs/sim/V3.out
while pgrep -f "tools/sq-validate.sh" > /dev/null; do sleep 5; done
tools/sq-variants.sh ffa 48 6 F-FL120 '{"ffaLootRange":120}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 CG20 '{"cubeGrab":20}' >> $out 2>&1
SQ_EXTRA='--squad hunters_know_position=0' tools/sq-variants.sh squad 48 6 HK-CG20 '{"cubeGrab":20}' >> $out 2>&1
echo DONE >> $out
