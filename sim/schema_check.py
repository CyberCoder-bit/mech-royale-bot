#!/usr/bin/env python3
"""Validate sim observations (JSONL) against kit/mechfight.schema.json using kit/check/check.py's validator.

    python3 sim/schema_check.py runs/obs_dump.jsonl
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.join(os.path.dirname(HERE), "kit")
spec = importlib.util.spec_from_file_location("kitcheck", os.path.join(KIT, "check", "check.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
schema = mod.Schema(os.path.join(KIT, "mechfight.schema.json"))

bad = 0
n = 0
seen_errors = {}
with open(sys.argv[1]) as f:
    for line in f:
        if not line.strip():
            continue
        o = json.loads(line)
        n += 1
        errs = schema.errors(o, "Observation")
        if len(line) > 65536:
            errs.append("line over 64 KiB")
        if errs:
            bad += 1
            for e in errs:
                k = e.split(":")[0]
                if k not in seen_errors:
                    seen_errors[k] = e
print(f"checked {n} observations, {bad} invalid")
for k, e in list(seen_errors.items())[:20]:
    print("  ", e)
sys.exit(1 if bad else 0)
