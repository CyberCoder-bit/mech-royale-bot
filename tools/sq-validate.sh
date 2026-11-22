#!/usr/bin/env bash
# Robustness validation chain (one batch at a time, 6 jobs, nice 10). Waits for a running VQ batch first.
# Results: runs/sim/V2.out (one line per run).
out=runs/sim/V2.out
while pgrep -f "name VQ " > /dev/null; do sleep 5; done
echo "VQ $(grep 'points (16' runs/sim/VQ.log)" >> $out
HK='--squad hunters_know_position=0'
PE='--squad nonhunter_engage_m=60,retaliate_s=6'
v0() { # name, extra args...
  local name=$1; shift
  nice -n 10 bun sim/run.ts --seeds 48 --jobs 6 --bot inproc:runs/v0img/src/bot.ts --name "$name" --out "runs/sim/$name.json" --quiet "$@" > "runs/sim/$name.log" 2>&1
  echo "$name $(grep 'points (16' runs/sim/$name.log) $(grep 'survival s' runs/sim/$name.log | tr -s ' ')" >> $out
}
SQ_EXTRA="$HK" tools/sq-variants.sh squad 48 6 HK-B2 '{}' >> $out 2>&1
v0 HK-v0 --mode squad $HK
SQ_EXTRA="$PE" tools/sq-variants.sh squad 48 6 P-B2 '{}' >> $out 2>&1
tools/sq-variants.sh ffa 48 6 F-B2 '{}' >> $out 2>&1
NH='{"huntHp":2,"passiveRangeL":0,"passiveRangeG":0}'
SQ_EXTRA="$HK" tools/sq-variants.sh squad 48 6 HK-NH "$NH" >> $out 2>&1
SQ_EXTRA="$PE" tools/sq-variants.sh squad 48 6 P-NH "$NH" >> $out 2>&1
tools/sq-variants.sh squad 48 6 NH "$NH" >> $out 2>&1
echo DONE >> $out
