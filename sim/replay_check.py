#!/usr/bin/env python3
"""Compare a sim replay's structure with a reference mechreplay/1 file (header keys, frame arrays,
event names and their keys, result keys).

    python3 -I sim/replay_check.py runs/replays/x.jsonl.gz runs/data/mechanics-v2-16.jsonl.gz
"""
import gzip
import json
import sys


def load(p):
    with gzip.open(p, "rt") as f:
        return [json.loads(l) for l in f if l.strip()]


def shape(lines):
    h = lines[0]
    frames = [l for l in lines[1:] if "type" not in l]
    res = [l for l in lines if l.get("type") == "result"]
    ev = {}
    for f in frames:
        for e in f.get("ev", []):
            k = e["e"] + (":" + e["op"] if "op" in e else "")
            ev.setdefault(k, set()).update(e.keys())
    fk = set()
    for f in frames:
        fk.update(f.keys())
    rk = set(res[0].keys()) if res else set()
    rmk = set(res[0]["mechs"][0].keys()) if res and res[0].get("mechs") else set()
    m_len = {len(m) for f in frames for m in f.get("m", [])}
    n_len = {len(m) for f in frames for m in f.get("n", [])}
    p_len = {len(m) for f in frames for m in f.get("p", [])}
    steps = {frames[i + 1]["t"] - frames[i]["t"] for i in range(min(200, len(frames) - 1))}
    return dict(header=set(h.keys()), fields=h.get("fields"), frame_keys=fk, events=ev, result=rk, result_mech=rmk, m_len=m_len, n_len=n_len, p_len=p_len, steps=steps, n_frames=len(frames))


a, b = shape(load(sys.argv[1])), shape(load(sys.argv[2]))
ok = True
for k in ("header", "frame_keys", "result", "result_mech", "m_len", "n_len", "p_len", "steps"):
    if a[k] != b[k]:
        print(f"{k}: sim {sorted(a[k]) if isinstance(a[k], set) else a[k]}  ref {sorted(b[k]) if isinstance(b[k], set) else b[k]}")
        if k not in ("steps",):
            ok = ok and (a[k] >= b[k] if isinstance(a[k], set) else False)
print("fields equal:", a["fields"] == b["fields"])
for e in sorted(set(a["events"]) | set(b["events"])):
    sa, sb = a["events"].get(e), b["events"].get(e)
    if sa != sb:
        print(f"event {e}: sim {sorted(sa) if sa else None} ref {sorted(sb) if sb else None}")
print("frames sim/ref:", a["n_frames"], b["n_frames"])
