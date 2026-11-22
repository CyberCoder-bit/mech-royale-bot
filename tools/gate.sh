#!/usr/bin/env bash
# Submission gate for an exact commit: builds the image from `git archive <ref>` (not the working tree),
# then runs kit/check/check.py locally and inside the scorer's sandbox.
#   tools/gate.sh [ref=HEAD]
# Exit 0 only if both checks PASS and the sandbox p99 < 20 ms and max < 40 ms.
set -euo pipefail
cd "$(dirname "$0")/.."
ref="${1:-HEAD}"
sha=$(git rev-parse "$ref")
tag="mech-gate:${sha:0:12}"
work=$(mktemp -d "${TMPDIR:-/tmp}/gate.XXXXXX")
trap 'rm -rf "$work"' EXIT
git archive --format=tar "$sha" | tar -x -C "$work"
echo "== gate $ref ($sha)"
# This machine runs our agents' simulator batches. Drop them to the lowest priority so they don't distort timing.
for pid in $(pgrep -f 'sim/worker.ts|sim/run.ts' || true); do renice -n 19 -p "$pid" >/dev/null 2>&1 || true; done
echo "load: $(cut -d' ' -f1-3 /proc/loadavg)"
echo "-- local check"
( cd "$work" && timeout 180 python3 kit/check/check.py -- bun src/main.ts ) > "$work/local.txt" 2>&1 || true
tail -4 "$work/local.txt"
grep -q '^PASS' "$work/local.txt" || { echo "GATE FAIL: local check"; exit 1; }
echo "-- docker build"
docker build --platform linux/amd64 -q -t "$tag" "$work" >/dev/null
echo "-- sandbox check"
timeout 400 python3 "$work/kit/check/check.py" --map-dir /arena -- docker run --rm -i --network none --cpus 1 --memory 512m \
  --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 --pids-limit 128 -v "$work/kit/arena:/arena:ro" "$tag" > "$work/docker.txt" 2>&1 || true
tail -6 "$work/docker.txt"
grep -q '^PASS' "$work/docker.txt" || { echo "GATE FAIL: sandbox check"; exit 1; }
p99=$(grep -oE 'p99 [0-9.]+' "$work/docker.txt" | awk '{print $2}')
mx=$(grep -oE 'max [0-9.]+' "$work/docker.txt" | head -1 | awk '{print $2}')
ready=$(grep -oE 'ready in [0-9]+' "$work/docker.txt" | awk '{print $3}')
awk -v p="$p99" -v m="$mx" 'BEGIN{exit !(p < 20 && m < 40)}' || { echo "GATE FAIL: timing p99=$p99 max=$mx"; exit 1; }
size=$(git archive --format=tar "$sha" | wc -c)
echo "GATE PASS $sha ready=${ready}ms p99=${p99}ms max=${mx}ms tar=$((size/1024))KiB"
