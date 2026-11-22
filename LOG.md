# Experiment and submission log

| time (EST) | tag/commit | change | sim squad (mean ± se, n) | sim ffa | practice score |
| --- | --- | --- | --- | --- | --- |
| 20:43 | v0 | example++: lead aim, fire gating on actual aim, laser charge/release, lightning ≤45 m, mortar arcs, face target, jink, retreat <35% HP, unstuck jets, loot/farm, upgrade priority, FFA detector | – | – | pending |
| 20:47 | v0.1 (0c10ac3) | (same bot as v0) | – | – | **3.38** |
| 20:51 | probe-pacifist (755d842) | never fires, avoids enemies | – | – | **0.08** → house bots ~never die without us: practice score ≈ our kills |
| 21:55 | sim: v0 base | calibrated squad sim, 48 seeds | 3.21 ± 0.27 | – | (official 3.38) |
| 21:55 | sim: v0 lightning-first | weaponPref lightning > laser | 3.02 ± 0.25 (paired −0.19 ± 0.09) | – | not submitted |
| 21:55 | sim: v0 retreat 50% | retreatHp 0.5 | 3.10 ± 0.29 (−0.10 ± 0.13) | – | not submitted |
| 21:55 | sim: v0 gun 45 m | prefRange.gun 45 | 3.02 ± 0.27 (−0.19 ± 0.28) | – | not submitted |
| 21:55 | sim: v0 lightning + retreat 50% | both | 2.90 ± 0.25 (−0.31 ± 0.16) | – | not submitted |
| 22:00 | sim: core WIP 35365e5 | world lib + cover/peek v1 WIP | 2.79 ± 0.24 (−0.42 ± 0.29) | – | not submitted |
| 22:58 | v1 core (eb67cdd) | world lib, cover/peek, low-exposure holds, mortar dodge, heal/hide off in squad | 3.93 vs v0 3.11 (96 paired, +0.81 ± 0.28); pessimistic 1.88 vs 1.27 | – | pending |
| 23:03 | v1 core (eb67cdd) | official result | sim said +0.8 | – | **3.00** (worse than v0 3.38: sim over-predicts hiding/holding) |
