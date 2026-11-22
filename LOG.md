# Experiment and submission log

| time (EST) | tag/commit | change | sim squad (mean ± se, n) | sim ffa | practice score |
| --- | --- | --- | --- | --- | --- |
| 20:43 | v0 | example++: lead aim, fire gating on actual aim, laser charge/release, lightning ≤45 m, mortar arcs, face target, jink, retreat <35% HP, unstuck jets, loot/farm, upgrade priority, FFA detector | – | – | pending |
| 20:47 | v0.1 (0c10ac3) | (same bot as v0) | – | – | **3.38** |
| 20:51 | probe-pacifist (755d842) | never fires, avoids enemies | – | – | **0.08** → house bots ~never die without us: practice score ≈ our kills |
| 22:30 | sq 51c29d0 (branch worktree-agent-a9d9aaebbaf9a3145) | v0 + map LOS-gated fire, attacker-first focused targeting, close in (22/35 m) on non-attackers, hunting remembered enemies/sounds at ≥60% HP, reveal unseen shooters, loot memory 320 m + loot-first + opening spin | 4.35 ± 0.36 (48; v0 3.21) | – | – |
| 23:05 | sq 4f97c93 | + mortar dodge, approach detector, FFA evidence detector (gates hunting/close-in/reveal-advance), deterministic A* budget, JIT warm-up, cold-start guard | 4.71 ± 0.38 (48, +1.50 ± 0.43 paired); 96: 4.55 ± 0.24; HK0 4.60 vs 3.29 (+1.31 ± 0.42); pess 1.81 vs 1.27 | 9.25 ± 0.82 (v0 10.19, −0.94 ± 0.89) | **4.63** |
