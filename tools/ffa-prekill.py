"""Test deaths before the FFA brain's takeover (2nd death we didn't cause), from sim results alone.

  python3 -I tools/ffa-prekill.py A.json [B.json ...]
"""
import json, sys

for path in sys.argv[1:]:
    res = json.load(open(path))["results"]
    pre, early = 0, 0
    for r in res:
        t = r["test"]
        deaths = sorted(f["deathT"] for f in r["field"] if f["deathT"] is not None and f["killedBy"] != t["spec"])
        flag = deaths[1] if len(deaths) >= 2 else None
        if t["deathT"] is not None and (flag is None or t["deathT"] < flag):
            pre += 1
        if t["place"] > 8:
            early += 1
    print(f"{path}: deaths before takeover {pre}/{len(res)}, places 9-16: {early}")
