#!/usr/bin/env bash
# Round 3: after HK-NH finishes: NH ablation (default model), then single-change candidates.
out=runs/sim/V3.out
while pgrep -f "name HK-NH " > /dev/null; do sleep 5; done
echo "HK-NH $(grep 'points (16' runs/sim/HK-NH.log)" >> $out
NH='{"huntHp":2,"passiveRangeL":0,"passiveRangeG":0}'
tools/sq-variants.sh squad 48 6 NH "$NH" >> $out 2>&1
tools/sq-variants.sh squad 48 6 GDC '{"gunDuringCharge":true}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 CG20 '{"cubeGrab":20}' >> $out 2>&1
echo DONE >> $out
