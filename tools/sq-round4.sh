#!/usr/bin/env bash
# Round 4 (after round 3): laser duck to cover, low-exposure hold spot when idle.
out=runs/sim/V4.out
while pgrep -f "tools/sq-round3.sh" > /dev/null; do sleep 5; done
tools/sq-variants.sh squad 48 6 D13 '{"duckR":13}' >> $out 2>&1
tools/sq-variants.sh squad 48 6 HOLD40 '{"holdR":40}' >> $out 2>&1
echo DONE >> $out
