#!/usr/bin/env bash
# Final validation of a candidate param set vs the current defaults (B2) on 96 seeds (default) and 48 (HK0).
# usage: tools/sq-final.sh 'json'
cand=$1
out=runs/sim/VF.out
tools/sq-variants.sh squad 48 6 CANDa "$cand" >> $out 2>&1
SQ_EXTRA='--seed-start 49' tools/sq-variants.sh squad 48 6 B2b '{}' >> $out 2>&1
SQ_EXTRA='--seed-start 49' tools/sq-variants.sh squad 48 6 CANDb "$cand" >> $out 2>&1
SQ_EXTRA='--squad hunters_know_position=0' tools/sq-variants.sh squad 48 6 HK-CAND "$cand" >> $out 2>&1
SQ_EXTRA='--squad hunters_know_position=0' tools/sq-variants.sh squad 48 6 HK-B3 '{}' >> $out 2>&1
echo DONE >> $out
