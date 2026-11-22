#!/usr/bin/env bash
# usage: tools/sq-variants.sh MODE SEEDS JOBS name1 'json1' [name2 'json2' ...]   (extra sim args via SQ_EXTRA)
# Snapshots src/ first, so editing the bot while a batch runs does not change it.
mode=$1; seeds=$2; jobs=$3; shift 3
snap="runs/snap/$(date +%H%M%S)-$$"
mkdir -p "$snap" && cp -r src "$snap/"
while [ $# -ge 2 ]; do
  name=$1; params=$2; shift 2
  MR_PARAMS="$params" bun sim/run.ts --mode "$mode" --seeds "$seeds" --jobs "$jobs" --bot "inproc:$snap/src/bot.ts" --name "$name" --out "runs/sim/$name.json" --quiet $SQ_EXTRA > "runs/sim/$name.log" 2>&1
  echo "$name $params $(grep 'points (16' runs/sim/$name.log) $(grep 'survival s' runs/sim/$name.log | tr -s ' ')"
done
