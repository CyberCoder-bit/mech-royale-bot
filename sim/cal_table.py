#!/usr/bin/env python3
"""Table of squad calibration runs in runs/cal/*.json (written by sim/calibrate.sh).

    python3 -I sim/cal_table.py
Targets (official practice, 48 fixed seeds): example 1.15, fighter 3.38, pacifist 0.08.
"""
import glob
import json
import os

rows = {}
for p in sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runs", "cal", "*.json"))):
    d = json.load(open(p))
    s = d["summary"]
    name = os.path.basename(p)[:-5]
    tag, bot = name.rsplit("__", 1)
    rows.setdefault(tag, {})[bot] = (s["mean_points"], s["se_points"], s["n"], s["mean_survival_s"])
print(f"{'config':80s} {'example':>14s} {'fighter':>14s} {'pacifist':>14s}")
print(f"{'targets':80s} {'1.15':>14s} {'3.38':>14s} {'0.08':>14s}")
for tag, r in rows.items():
    cells = []
    for b in ("example", "fighter", "pacifist"):
        if b in r:
            m, se, n, sv = r[b]
            cells.append(f"{m:5.2f} ± {se:4.2f}")
        else:
            cells.append("-")
    print(f"{tag:80s} {cells[0]:>14s} {cells[1]:>14s} {cells[2]:>14s}")
