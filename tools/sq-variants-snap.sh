#!/usr/bin/env bash
# usage: tools/sq-variants.sh MODE SEEDS JOBS name1 'json1' [name2 'json2' ...]   (extra sim args via SQ_EXTRA)
# Snapshots src/ first, so editing the bot while a batch runs does not change it.
# Adds planCapMs=1000 (A* bounded by expansions only) so sim runs are reproducible.
mode=$1; seeds=$2; jobs=$3; shift 3
snap="${SQ_SNAP:-runs/snap/$(date +%H%M%S)-$$}"
[ -n "$SQ_SNAP" ] || { mkdir -p "$snap" && cp -r src "$snap/"; }
while [ $# -ge 2 ]; do
  name=$1; params=$2; shift 2
  if [ "$params" = "{}" ]; then full='{"planCapMs":1000,"initSkipMs":1e12}'; else full="{\"planCapMs\":1000,\"initSkipMs\":1e12,${params#\{}"; fi
  MR_PARAMS="$full" nice -n 10 bun sim/run.ts --mode "$mode" --seeds "$seeds" --jobs "$jobs" --bot "inproc:$snap/src/bot.ts" --name "$name" --out "runs/sim/$name.json" --quiet $SQ_EXTRA > "runs/sim/$name.log" 2>&1
  echo "$name $params $(grep 'points (16' runs/sim/$name.log) $(grep 'survival s' runs/sim/$name.log | tr -s ' ')"
done
