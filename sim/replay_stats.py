#!/usr/bin/env python3
"""Behaviour stats from a mechreplay/1 file (real or sim), for calibrating house bots:
gun shots per second by nearest-enemy distance band, laser/mortar/lightning use, airborne share,
mean speed, deaths over time.

    python3 -I sim/replay_stats.py <replay.jsonl.gz> [more replays...]
"""
import gzip
import json
import math
import sys
from collections import defaultdict

bands = [(0, 30), (30, 60), (60, 100), (100, 150), (150, 230), (230, 9999)]


def band(d):
    for i, (a, b) in enumerate(bands):
        if a <= d < b:
            return i
    return len(bands) - 1


tot_time = defaultdict(float)
tot_shots = defaultdict(int)
weap = defaultdict(int)
air = 0
frames_n = 0
speed_sum = 0.0
speed_n = 0
deaths = []
for path in sys.argv[1:]:
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt") as f:
        lines = []
        for l in f:
            if l.strip():
                try:
                    lines.append(json.loads(l))
                except ValueError:
                    pass
    h = lines[0]
    fe = h.get("frame_every", 2)
    hz = h.get("tick_hz", 20)
    frames = [l for l in lines[1:] if "type" not in l]
    prev = None
    for fr in frames:
        ms = {m[0]: m for m in fr["m"]}
        fires = defaultdict(int)
        for e in fr.get("ev", []):
            if e["e"] == "fire":
                fires[(e["id"], e["w"])] += 1
                weap[e["w"]] += 1
            elif e["e"] == "laser":
                weap["laser"] += 1
            elif e["e"] == "zap":
                weap["lightning"] += 1
            elif e["e"] == "death" and e["id"] < 100:
                deaths.append(round(e["t"] / hz))
        dt = fe / hz
        for i, m in ms.items():
            best = 1e9
            for j, o in ms.items():
                if j == i:
                    continue
                d = math.hypot(o[1] - m[1], o[2] - m[2])
                best = min(best, d)
            b = band(best)
            tot_time[b] += dt
            tot_shots[b] += fires.get((i, "gun"), 0)
            frames_n += 1
            if not (m[8] & 1):
                air += 1
            if prev and i in prev:
                p = prev[i]
                speed_sum += math.hypot(m[1] - p[1], m[2] - p[2]) / dt
                speed_n += 1
        prev = ms
print("gun shots per bot-second by nearest-enemy distance:")
for i, (a, b) in enumerate(bands):
    if tot_time[i] > 0:
        print(f"  {a:>4}-{b:<5} m: {tot_shots[i] / tot_time[i]:.2f}/s  (bot-seconds {tot_time[i]:.0f})")
print("weapon use counts:", dict(weap))
print(f"airborne share {air / max(1, frames_n):.2f}, mean speed {speed_sum / max(1, speed_n):.1f} m/s")
deaths.sort()
print("mech deaths (s):", deaths)
