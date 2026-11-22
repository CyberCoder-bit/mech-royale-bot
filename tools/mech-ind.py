"""Mechanism indicators of a squad variant vs its base (same seeds): kills, damage dealt and taken,
survival, and death causes, to tell "kills faster" from "dodges bullets better".

  python3 -I tools/mech-ind.py NEW.json BASE.json
"""
import json, sys
from collections import Counter


def ind(path):
    rs = json.load(open(path))["results"]
    n = len(rs)
    t = [r["test"] for r in rs]
    c = Counter(x["cause"] for x in t)
    return dict(kills=sum(x["kills"] for x in t) / n, dealt=sum(x["damageDealt"] for x in t) / n, taken=sum(x["damageTaken"] for x in t) / n,
                surv=sum((x["deathT"] if x["deathT"] is not None else 0) for x in t) / n, gun=c.get("gun", 0), laser=c.get("laser", 0), other=n - c.get("gun", 0) - c.get("laser", 0))


a, b = ind(sys.argv[1]), ind(sys.argv[2])
print(f"kills {a['kills']:.2f} vs {b['kills']:.2f} | dealt {a['dealt']:.0f} vs {b['dealt']:.0f} | taken {a['taken']:.0f} vs {b['taken']:.0f} | "
      f"surv {a['surv']:.1f} vs {b['surv']:.1f} | deaths gun {a['gun']} vs {b['gun']}, laser {a['laser']} vs {b['laser']}, other {a['other']} vs {b['other']}")
