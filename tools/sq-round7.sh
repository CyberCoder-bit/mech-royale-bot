#!/usr/bin/env bash
# Round 7 (after round 3): regen windows (pause optional fights below healHp), crossfire step, laser duck.
out=runs/sim/V7.out
while pgrep -f "bash tools/sq-round3.sh" > /dev/null; do sleep 5; done
tools/sq-variants.sh squad 48 6 HEAL60 '{"healHp":0.6}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 HEAL90 '{"healHp":0.9}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 XF13 '{"xfireR":13}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 D13 '{"duckR":13}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 HEAL75 '{"healHp":0.75}' >> $out 2>&1
echo DONE >> $out
