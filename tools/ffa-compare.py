"""Pooled paired comparison of sim runs (several seed ranges per version).

  python3 -I tools/ffa-compare.py A1.json,A2.json B1.json,B2.json

Prints, per version: mean points +- se, win rate, top-3 rate, mean survival, kills; and the paired
difference A - B over the seeds both have.
"""
import json, sys, statistics as st


def load(arg):
    out = {}
    for p in arg.split(","):
        for r in json.load(open(p))["results"]:
            out[r["seed"]] = r
    return out


def summary(name, rs):
    pts = [r["test"]["points"] for r in rs]
    n = len(pts)
    se = st.stdev(pts) / n ** 0.5 if n > 1 else 0
    pl = [r["test"]["place"] for r in rs]
    surv = [r["test"]["deathT"] if r["test"]["deathT"] is not None else r["t"] for r in rs]
    print(f"{name}: n={n} pts {st.mean(pts):.2f} +- {se:.2f}  win {sum(p == 1 for p in pl) / n * 100:.0f}%  top3 {sum(p <= 3 for p in pl) / n * 100:.0f}%  "
          f"surv {st.mean(surv):.0f}s  kills {st.mean(r['test']['kills'] for r in rs):.2f}  cubes {st.mean(r['test']['cubesMax'] for r in rs):.1f}")


A, B = load(sys.argv[1]), load(sys.argv[2])
common = sorted(set(A) & set(B))
summary("A", [A[s] for s in common])
summary("B", [B[s] for s in common])
d = [A[s]["test"]["points"] - B[s]["test"]["points"] for s in common]
se = st.stdev(d) / len(d) ** 0.5
print(f"A - B: {st.mean(d):+.2f} +- {se:.2f} (n={len(d)}); A better on {sum(x > 0 for x in d)}, worse on {sum(x < 0 for x in d)}")
