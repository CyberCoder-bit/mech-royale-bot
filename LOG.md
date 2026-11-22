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
| 23:15 | sq 4f97c93 (squad tactics on v0+world) | loot memory, focus fire + close-in, hunting, mortar dodge, reveal, LOS gating | 4.71 vs 3.21 (+1.50 ± 0.43); HK0 4.60 vs 3.29; pess 1.75 vs 1.27 | ffa 8.56 vs 10.19 (regression, gated later) | pending |
| 23:18 | sq 4f97c93 | official result | sim predicted 4.71 / HK0 4.60 | – | **4.63** NEW BEST (entered in final) |
| 23:28 | sim: v2 upgrade order | damage-first / mixed (gun_rate early) vs survival-first | base 4.42 ± 0.31; dmg +0.08 ± 0.36; mix +0.15 ± 0.34 | – | not submitted (noise) |
| 23:30 | sim: v2 death analysis | mean death 80 s, none past 3:00; killed by easy 30/48; 3.6 kills/min alive | → lever = survival per kill | – | – |
| 23:31 | core world perf d1e337f | allocation-free LOS, nav.bin.gz precompute, A* cap 8000, warm-up | v2+new world 4.60 vs 4.44 (+0.17 ± 0.16) | – | not submitted (folded into next sq candidate) |
