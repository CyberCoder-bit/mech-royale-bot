"""Summarize how the test bot died in a traced FFA sim run.

  MR_FFA_TRACE=1 bun sim/run.ts --mode ffa ... --out runs/sim/X.json > runs/sim/X.log 2>&1
  python3 -I tools/ffa-deaths.py runs/sim/X.json runs/sim/X.log [min_place] [lines]

Trace lines are "[ffa <slot> <brain id>] t=...". Each result is matched to the brain instance of
its slot whose last line is closest to the death time.
"""
import json, re, sys
from collections import defaultdict

res = json.load(open(sys.argv[1]))
logp = sys.argv[2]
minplace = int(sys.argv[3]) if len(sys.argv) > 3 else 9
nlines = int(sys.argv[4]) if len(sys.argv) > 4 else 14
groups = defaultdict(list)
pat = re.compile(r"^\[ffa (\d+) (\d+)\] t=([\d.]+) (\w+) (.*)$")
for l in open(logp, errors="replace"):
    m = pat.match(l.strip())
    if m:
        groups[(int(m.group(1)), int(m.group(2)))].append((float(m.group(3)), m.group(4), m.group(5)))
used = set()
modes = defaultdict(float)
for r in sorted(res["results"], key=lambda r: r["seed"]):
    t = r["test"]
    slot = t["slot"]
    dt = t["deathT"] if t["deathT"] is not None else r["t"]
    best, bd = None, 1e9
    for k, v in groups.items():
        if k[0] != slot or k in used or not v:
            continue
        d = abs(v[-1][0] - dt)
        if d < bd:
            best, bd = k, d
    if best is None or bd > 3:
        if t["place"] >= minplace:
            print(f"seed {r['seed']} place {t['place']} died {dt:.1f}s by {t['cause']}: no FFA trace (died before the flag?)")
        continue
    used.add(best)
    v = groups[best]
    if t["place"] < minplace:
        continue
    print(f"seed {r['seed']} place {t['place']} died {dt:.1f}s by {t['cause']} ({t['killedBy']}) kills {t['kills']}  ffa from {v[0][0]:.1f}s")
    for x in v[-nlines:]:
        print(f"   t={x[0]:.1f} {x[1]:6s} {x[2][:240]}")
