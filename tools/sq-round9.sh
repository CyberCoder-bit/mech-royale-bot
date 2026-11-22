#!/usr/bin/env bash
# Round 9 (new world library): after B2, single changes vs B2. Face the shooter first (early deaths had 10-19 rear hits).
out=runs/sim/V8.out
while ps -p 128242 > /dev/null 2>&1; do sleep 5; done
tools/sq-variants.sh squad 48 6 FACE '{"tgtRecentAtk":3,"rearReveal":true}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 CG20b '{"cubeGrab":20}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 HEAL90b '{"healHp":0.9}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 XF13b '{"xfireR":13}' >> $out 2>&1
echo DONE >> $out
