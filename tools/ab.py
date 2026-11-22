#!/usr/bin/env python3
"""Paired A/B summary of two sim result files (same seeds): python3 -I tools/ab.py A.json B.json"""
import json
import statistics as S
import sys


def load(p):
    d = json.load(open(p))
    res = d.get('results') if isinstance(d, dict) else d
    return {r['seed']: r['test'] for r in res}


a, b = load(sys.argv[1]), load(sys.argv[2])
seeds = sorted(set(a) & set(b))


def stat(xs):
    return S.mean(xs), (S.stdev(xs) / len(xs) ** 0.5 if len(xs) > 1 else 0)


for name, key in [('points', 'points'), ('kills', 'kills'), ('dmg dealt', 'damageDealt'), ('dmg taken', 'damageTaken'), ('rear hits', 'rearHits')]:
    xa = [a[s][key] for s in seeds]
    xb = [b[s][key] for s in seeds]
    d = [y - x for x, y in zip(xa, xb)]
    ma, _ = stat(xa)
    mb, _ = stat(xb)
    md, sd = stat(d)
    print(f'{name:10s} A {ma:8.2f}  B {mb:8.2f}  B-A {md:+.2f} ± {sd:.2f}  (n={len(seeds)})')
sa = [a[s]['deathT'] or 480 for s in seeds]
sb = [b[s]['deathT'] or 480 for s in seeds]
print(f'survival   A {S.mean(sa):8.1f}  B {S.mean(sb):8.1f}')
