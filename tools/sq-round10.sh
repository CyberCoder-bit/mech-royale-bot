#!/usr/bin/env bash
# Round 10 (after round 9): shoot back at drones.
out=runs/sim/V8.out
while pgrep -f "bash tools/sq-round9.sh" > /dev/null; do sleep 5; done
tools/sq-variants.sh squad 48 6 NPCD '{"npcDefend":true}' >> $out 2>&1
echo DONE10 >> $out
