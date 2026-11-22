#!/usr/bin/env bash
# Squad-tactics round 2 sweep: each variant (MR_PARAMS json) vs a baseline result file on the same seeds, paired.
# usage: tools/sq2-sweep.sh TAG SEEDS BASE_JSON name1 'json1' [name2 'json2' ...]   (extra sim args via SQ_EXTRA)
# Snapshots src/ once, so editing the bot while a batch runs does not change it.
tag=$1; seeds=$2; base=$3; shift 3
out=runs/sim/SQ2-$tag.out
snap="${SQ_SNAP:-runs/snap/$(date +%H%M%S)-$$}"
[ -n "$SQ_SNAP" ] || { mkdir -p "$snap" && cp -r src "$snap/"; }
echo "# $(date +%H:%M) snap $snap seeds $seeds base $base extra '$SQ_EXTRA'" >> "$out"
while [ $# -ge 2 ]; do
  name="$tag-$1"; params=$2; shift 2
  if [ "$params" = "{}" ]; then full='{"planCapMs":1000,"initSkipMs":1e12}'; else full="{\"planCapMs\":1000,\"initSkipMs\":1e12,${params#\{}"; fi
  MR_PARAMS="$full" nice -n 10 bun sim/run.ts --mode squad --seeds "$seeds" --jobs 6 --bot "inproc:$snap/src/bot.ts" --name "$name" --out "runs/sim/$name.json" --quiet $SQ_EXTRA > "runs/sim/$name.log" 2>&1
  echo "$name $params | $(python3 -I tools/sq2-cmp.py "$base" "runs/sim/$name.json")" >> "$out"
done
echo "DONE $(date +%H:%M)" >> "$out"
