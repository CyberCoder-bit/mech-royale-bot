#!/usr/bin/env bash
# Round 6 (after round 5): faster hunting trips, wider torso scan while travelling.
out=runs/sim/V6.out
while pgrep -f "tools/sq-round5.sh" > /dev/null; do sleep 5; done
tools/sq-variants.sh squad 48 6 TB60 '{"travelBoostE":60}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 SCAN14 '{"scanAmp":1.4}' >> $out 2>&1
echo DONE >> $out
