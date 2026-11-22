#!/usr/bin/env bash
# Round 5 (after round 4): gravity lead for airborne targets, with house bots hopping (real ones are airborne ~27%).
out=runs/sim/V5.out
while pgrep -f "tools/sq-round4.sh" > /dev/null; do sleep 5; done
SQ_EXTRA='--house hop_rate=0.4' tools/sq-variants.sh squad 48 6 HOP-B1 '{}' >> $out 2>&1
SQ_EXTRA='--house hop_rate=0.4' tools/sq-variants.sh squad 48 6 HOP-GL '{"gravityLead":true}' >> $out 2>&1
echo DONE >> $out
