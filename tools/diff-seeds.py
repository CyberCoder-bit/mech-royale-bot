"""List the seeds where two runs differ (place, death time, cause, cubes, kills).

  python3 -I tools/diff-seeds.py NEW.json BASE.json
"""
import json, sys

a = {r["seed"]: r["test"] for r in json.load(open(sys.argv[1]))["results"]}
b = {r["seed"]: r["test"] for r in json.load(open(sys.argv[2]))["results"]}
for s in sorted(set(a) & set(b)):
    x, y = a[s], b[s]
    if x["place"] != y["place"] or x["deathT"] != y["deathT"]:
        print(f"seed {s}: new place {x['place']} t={x['deathT']} {x['cause']} cubes {x['cubesMax']} kills {x['kills']} | base place {y['place']} t={y['deathT']} {y['cause']} cubes {y['cubesMax']} kills {y['kills']}")
