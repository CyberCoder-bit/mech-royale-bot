#!/usr/bin/env bash
# 96-seed sweep: baseline (current defaults) then each variant; prints paired diff vs baseline.
# usage: tools/sq-sweep.sh TAG name1 'json1' [name2 'json2' ...]   (SQ_EXTRA for squad model args)
tag=$1; shift
out=runs/sim/SW-$tag.out
base="SW-$tag-base"
tools/sq-variants.sh squad 96 6 "$base" '{}' >> $out 2>&1
while [ $# -ge 2 ]; do
  name="SW-$tag-$1"; params=$2; shift 2
  tools/sq-variants.sh squad 96 6 "$name" "$params" > /dev/null 2>&1
  diff=$(bun sim/run.ts --compare "runs/sim/$base.json" "runs/sim/$name.json" | tail -1)
  echo "$name $params $(grep 'points (16' runs/sim/$name.log | tr -s ' ') | base-var: $diff" >> $out
done
echo DONE >> $out
