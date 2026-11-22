#!/usr/bin/env bash
# 96-seed sweep against an existing baseline JSON (waits while a run with that name is in progress).
# usage: tools/sq-sweep2.sh BASE_NAME OUT_TAG name1 'json1' [name2 'json2' ...]
base=$1; tag=$2; shift 2
out=runs/sim/SW-$tag.out
while pgrep -f "bash tools/sq-(hkcg|mrgcheck).sh" > /dev/null; do sleep 3; done
echo "$base $(grep 'points (16' runs/sim/$base.log | tr -s ' ')" >> $out
while [ $# -ge 2 ]; do
  name="SW-$tag-$1"; params=$2; shift 2
  SQ_SNAP=runs/snap/234837-138372 tools/sq-variants-snap.sh squad 96 6 "$name" "$params" > /dev/null 2>&1
  diff=$(bun sim/run.ts --compare "runs/sim/$base.json" "runs/sim/$name.json" | tail -1)
  echo "$name $params $(grep 'points (16' runs/sim/$name.log | tr -s ' ') | base-var: $diff" >> $out
done
echo DONE >> $out
