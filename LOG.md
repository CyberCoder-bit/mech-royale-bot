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
| 23:38 | sim recalibration (branch sim-cal-v1, ef6cc5f) | search-model hunters (config B) | ex 1.29, pac 0.00, v0 3.40, v1 3.79, sq 4.92 vs official 1.15/0.08/3.38/3.00/4.63 | – | lesson: sim over-rates defensive tactics by ~0.5–0.8; not adopted as default |
| 23:40 | ffa d42bbc4 (FFA brain on v0) | hide in low-exposure spots, cover vs threat lines, heal in cover, fight only with an edge, zone safety net, final duel | squad identical (0.00) | ffa 11.92 vs 10.56 (+1.35 ± 0.37, 96 seeds), top-3 72% vs 49%, win 40% vs 29% | not submitted (porting onto v2) |
| 23:57 | v2+ffa cc24133 | v2 + FFA brain + fast world lib (d1e337f) | squad +0.06 ± 0.09 vs v2 | ffa +0.95 ± 0.42 vs v2 (96 seeds) | pending |
| 00:00 | v2+ffa cc24133 | official result | – | – | **4.63** (= v2, squad unchanged). PICKED as final entry (BB-73B66656) because it has FFA mode. Re-pick manually if a better FFA-capable version scores higher. |
| 00:09 | roof fortress (branch worktree-agent-a4e7c3aeadebf310e) | climb a roof and fight from it | −1.29 ± 0.35 (default), −1.31 (HK0); refuge variant +0.17 ± 0.24 (noise) | – | rejected: survives 2× longer but kills fewer, no kill cubes |
| 00:11 | sq 1a98685 | v2+ffa merge + cubeGrab 30 | +0.28 ± 0.17 (96, default); HK0 +0.50 ± 0.16 | ffa 9.56 vs 9.25 (48) | pending |
| 00:14 | sq 1a98685 | official result | sim +0.28 / HK0 +0.50 | – | **5.04** NEW BEST; PICKED as final entry (BB-5F7D63F5, has FFA brain) |
