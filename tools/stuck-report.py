"""Summarize [stuck] lines from tools/stuck-wrap.ts: stuck seconds near low ceilings (where our height
exceeds the clearance) vs elsewhere, and the top stuck locations (10 m cells).

  python3 -I tools/stuck-report.py runs/sim/X.log
"""
import re, sys
from collections import Counter, defaultdict

pat = re.compile(r"^\[stuck (\d+)\] t=([\d.]+) x=(-?\d+) y=(-?\d+) z=(-?[\d.]+) cubes=(\d+) H=([\d.]+) inzone=(\d) hp=(\d+) lowd=([\d.]+|inf|Infinity) lowceil=([\d.]+)")
ev = []
for l in open(sys.argv[1], errors="replace"):
    m = pat.match(l.strip())
    if m:
        lowd = float(m.group(10)) if m.group(10) not in ("inf", "Infinity") else 1e9
        ev.append(dict(bot=m.group(1), t=float(m.group(2)), x=int(m.group(3)), y=int(m.group(4)), cubes=int(m.group(6)), H=float(m.group(7)), inzone=int(m.group(8)), lowd=lowd, lowceil=float(m.group(11))))
near = [e for e in ev if e["lowd"] < 8]
tall = [e for e in near if e["H"] + 0.5 > e["lowceil"]]
print(f"stuck seconds: {len(ev)} in {len({e['bot'] for e in ev})} matches; within 8 m of a low-ceiling node: {len(near)} (our height above its clearance: {len(tall)}); outside the zone: {sum(1 for e in ev if not e['inzone'])}")
cells = Counter((e["x"] // 10 * 10, e["y"] // 10 * 10) for e in ev)
by_cell = defaultdict(list)
for e in ev:
    by_cell[(e["x"] // 10 * 10, e["y"] // 10 * 10)].append(e)
print("top stuck cells (x, y): seconds, matches, mean cubes, min low-ceiling distance")
for c, n in cells.most_common(12):
    es = by_cell[c]
    print(f"  {c}: {n} s, {len({e['bot'] for e in es})} matches, cubes {sum(e['cubes'] for e in es) / len(es):.1f}, lowd {min(e['lowd'] for e in es):.1f}")
