#!/usr/bin/env bash
# After the pinned sweep: squad identity check of the merged (FFA) code vs the pre-merge baseline, plus FFA mode.
out=runs/sim/MRG.out
while pgrep -f "bash tools/sq-sweep3.sh" > /dev/null; do sleep 3; done
tools/sq-variants.sh squad 96 6 MRG96 '{}' > /dev/null 2>&1
echo "MRG96 $(grep 'points (16' runs/sim/MRG96.log | tr -s ' ') | base-merged: $(bun sim/run.ts --compare runs/sim/SW-a-base.json runs/sim/MRG96.json | tail -1)" >> $out
tools/sq-variants.sh ffa 48 6 MRG-FFA '{}' > /dev/null 2>&1
echo "MRG-FFA $(grep 'points (16' runs/sim/MRG-FFA.log | tr -s ' ') | v0ffa-merged: $(bun sim/run.ts --compare runs/sim/v0ffa.json runs/sim/MRG-FFA.json | tail -1)" >> $out
echo DONE >> $out
