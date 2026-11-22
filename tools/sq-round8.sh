#!/usr/bin/env bash
# Round 8 (new world library 576eefa): baseline, then single changes vs that baseline.
out=runs/sim/V8.out
tools/sq-variants.sh squad 48 6 B2 '{}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 CG20b '{"cubeGrab":20}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 HEAL90b '{"healHp":0.9}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 XF13b '{"xfireR":13}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 HEAL60b '{"healHp":0.6}' >> $out 2>&1
echo DONE >> $out
