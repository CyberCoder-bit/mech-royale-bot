#!/usr/bin/env python3
"""Paired points diff per block of 96 seeds (variant - base), to see how much a 96-seed verdict depends on the block.
usage: python3 -I tools/sq2-blocks.py base.json var1.json [var2.json ...]"""
import json, math, sys


def load(p):
    return {r["seed"]: r["test"] for r in json.load(open(p))["results"]}


base = load(sys.argv[1])
for path in sys.argv[2:]:
    v = load(path)
    seeds = sorted(set(v) & set(base))
    out = []
    for i in range(0, len(seeds), 96):
        blk = seeds[i : i + 96]
        xs = [v[s]["points"] - base[s]["points"] for s in blk]
        m = sum(xs) / len(xs)
        sd = math.sqrt(sum((x - m) ** 2 for x in xs) / max(1, len(xs) - 1))
        out.append(f"{blk[0]}-{blk[-1]}: {m:+.2f}±{sd / math.sqrt(len(xs)):.2f}")
    print(f"{path.split('/')[-1]:26s} " + " | ".join(out))
