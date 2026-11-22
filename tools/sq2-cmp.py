#!/usr/bin/env python3
"""Paired comparison of two sim result files: points, survival, kills, damage taken per minute alive, rear hits.
usage: python3 -I tools/sq2-cmp.py base.json var.json"""
import json, sys, math


def load(p):
    d = json.load(open(p))
    return {r["seed"]: r["test"] for r in d["results"]}


a, b = load(sys.argv[1]), load(sys.argv[2])
seeds = sorted(set(a) & set(b))


def paired(f):
    xs = [f(b[s]) - f(a[s]) for s in seeds]
    n = len(xs)
    m = sum(xs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / max(1, n - 1))
    return m, sd / math.sqrt(n)


def mean(d, f):
    return sum(f(d[s]) for s in seeds) / len(seeds)


pts = lambda r: r["points"]
dm, dse = paired(pts)
better = sum(1 for s in seeds if b[s]["points"] > a[s]["points"])
worse = sum(1 for s in seeds if b[s]["points"] < a[s]["points"])
surv = lambda r: r["deathT"] or 420
dpm = lambda r: r["damageTaken"] / max(1e-6, surv(r)) * 60
kpm = lambda r: r["kills"] / max(1e-6, surv(r)) * 60
print(
    f"n={len(seeds)} pts {mean(a,pts):.2f}->{mean(b,pts):.2f} diff {dm:+.2f} ± {dse:.2f} (+{better}/-{worse}) | surv {mean(a,surv):.1f}->{mean(b,surv):.1f} | "
    f"dmgTaken/min {mean(a,dpm):.0f}->{mean(b,dpm):.0f} | kills/min {mean(a,kpm):.2f}->{mean(b,kpm):.2f} | "
    f"rear {mean(a,lambda r:r['rearHits']):.1f}->{mean(b,lambda r:r['rearHits']):.1f} | cubes {mean(a,lambda r:r['cubesMax']):.1f}->{mean(b,lambda r:r['cubesMax']):.1f}"
)
