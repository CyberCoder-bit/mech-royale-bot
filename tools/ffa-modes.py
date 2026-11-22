"""Mode-time totals and spot re-pick reasons from a traced FFA sim log.

  python3 -I tools/ffa-modes.py runs/sim/X.log
"""
import json, re, sys
from collections import defaultdict

last = {}
reasons = defaultdict(int)
spot_d = defaultdict(list)
for l in open(sys.argv[1], errors="replace"):
    m = re.match(r"^\[ffa (\d+) (\d+)\] timing .* modes (\{.*\})$", l.strip())
    if m:
        last[(m.group(1), m.group(2))] = json.loads(m.group(3))
        continue
    m = re.match(r"^\[ffa (\d+) (\d+)\] t=[\d.]+ SPOT (\w+) d=(\d+)", l.strip())
    if m:
        reasons[m.group(3)] += 1
        spot_d[m.group(3)].append(int(m.group(4)))
tot = defaultdict(float)
for v in last.values():
    for k, x in v.items():
        tot[k] += x
s = sum(tot.values()) or 1
print(f"brains with timing lines: {len(last)}")
print("mode share: " + "  ".join(f"{k} {v / s * 100:.0f}%" for k, v in sorted(tot.items(), key=lambda kv: -kv[1])))
for k, v in sorted(reasons.items(), key=lambda kv: -kv[1]):
    d = sorted(spot_d[k])
    print(f"spot re-picks '{k}': {v}  (median distance {d[len(d) // 2]} m)")
