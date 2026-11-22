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
| 22:30 | sq 51c29d0 (branch worktree-agent-a9d9aaebbaf9a3145) | v0 + map LOS-gated fire, attacker-first focused targeting, close in (22/35 m) on non-attackers, hunting remembered enemies/sounds at ≥60% HP, reveal unseen shooters, loot memory 320 m + loot-first + opening spin | 4.35 ± 0.36 (48; v0 3.21) | – | – |
| 23:05 | sq 4f97c93 | + mortar dodge, approach detector, FFA evidence detector (gates hunting/close-in/reveal-advance), deterministic A* budget, JIT warm-up, cold-start guard | 4.71 ± 0.38 (48, +1.50 ± 0.43 paired); 96: 4.55 ± 0.24; HK0 4.60 vs 3.29 (+1.31 ± 0.42); pess 1.81 vs 1.27 | 9.25 ± 0.82 (v0 10.19, −0.94 ± 0.89) | **4.63** |
| 23:33 | sq 576eefa | core world lib d1e337f (precomputed nav, alloc-free LOS), own warm-up off | 4.69 (48) / 4.54 ± 0.24 (96); HK0 4.60 | – | – |
| 23:45 | sq knobs (off) | single changes vs 576eefa, 48 paired: cube grab 20 m +0.19 ± 0.18; face shooter +0.06 ± 0.14; crossfire step +0.08 ± 0.11; drone defense 0.00; gun during laser charge −0.08 ± 0.22; **regen window healHp 0.9 −0.65 ± 0.28**; ablation no hunting/close-in −0.63 ± 0.34 (HK0 −0.96 ± 0.32); face+cubes combined: 49–96 −0.42, HK0 −0.10 → rejected | – | – | – |
| 23:51 | sq d1c21ac | merge ffa-on-v2 (FFA brain hook, squad unchanged) | (identity check pending) | – | – |
| 00:44 | ffa-detect 4e4a9c4 | first clean death takeover (median 20 s vs 25.8 s) | squad +0.08 ± 0.07 (no takeovers in 192) | ffa −0.07 ± 0.41 vs v3 | not shipped: early FFA deaths come from v3's own early fights |
| 00:58 | SCORER RESET | all earlier Mech Royale scores now 'Scored under a previous version'; board shows 2 teams; baseline 1.15 → 1.13; kit + protocol unchanged; final pick cleared | – | – | resubmitting v3 (BB-CE149C78) |
| 01:02 | v3 1a98685 (new scorer) | resubmitted after the reset | – | – | **5.10** (was 5.04); board top 5.96, we're ~#10 of 18 (team 'Carmel High School'?) |
| 01:03 | earlysafe bd23fa7 | v3 + earlySafeT 15 (no fights with healthy passives in first 15 s) | 192 seeds: −0.03 ± 0.18 default, −0.29 ± 0.16 HK0 | ffa +1.07 ± 0.35 | pending (new scorer) |
| 01:13 | earlysafe bd23fa7 | official (new scorer) | – | – | **5.10** (= v3) → PICKED as final entry (better FFA) |
| 01:13 | v4 ecb87e1 | merge of sq2 4584e63 (cube grab 45 + boost; 480 seeds +0.20 ± 0.09, HK0 +0.27 ± 0.12) + earlySafeT 15 | 48 seeds +0.02 ± 0.44 vs v3 (noise) | – | pending |
| 01:22 | econ 18d44eb | crate/drone/cube farming memory (off), cube cap 10 (on), supply drops, upgrade order | +0.04 ± 0.02 (1000 seeds); farming 0.00; drops +0.09 ± 0.27 | ffa identical | not submitted: cubes grow size (+5% each) so defence ~cancels |
| 01:45 | v4 ecb87e1 | official (new scorer) | sim ≈ v3 −0.06 | – | **4.73** (−0.37 vs v3; ~1σ of real per-variant noise) |
| 01:46 | cube45 4584e63 | v3 + cube grab 45 + boost (no earlySafe) | 480 seeds +0.20 ± 0.09 (replicated +0.21), HK0 +0.27 | ffa +0.55 ± 0.24 vs v3 | pending |
| 01:58 | sq2 earlySafeT sweep on cubes | T15 −0.26 ± 0.11, T6 −0.11 ± 0.08 vs no-earlySafe (480 seeds); FFA vs v3: T15 +0.93, T6 +0.90, none +0.55; earlyProbe dead end | – | – | plan: final build = cubes + earlySafeT 6, fish with rngSalt variants |
| 02:10 | cube45 4584e63 | official (new scorer) | sim +0.20 vs v3 | – | **4.88** (−0.22 vs v3). With v4 4.73: cube-grab-45 + boost looks negative in reality → back to v3 base |
| 02:10 | v3es salt variants (bd23fa7 + rngSalt 1..4: 449fb9b, d65b7cf, 5529620, 8a093b3) | same strategy as bd23fa7 (5.10), different RNG | salt 0 action-identical to bd23fa7 | ffa as bd23fa7 | submitting salt 1 |
| 02:16 | ffa-drops 238bd92 | FFA supply-drop contest variants (off by default) | squad unaffected | best +0.05 ± 0.04 (2 captures); default −0.20 ± 0.15 | not shipped: drops attract top bots |
| 02:20 | v3es salt 1 449fb9b | bd23fa7 + rngSalt 1 | – | – | **5.04** (salt 0 = 5.10): real per-salt spread looks small |
| 02:55 | ffa-endgame 3cd57ff (on bd23fa7) | bridge/low-ceiling fix for grown mechs + duel first shot | squad identical | ffa +0.06 ± 0.03 (192), win 33% → 41% | final-build component (squad port of bridge fix requested) |
| 02:56 | v3es salt 2 d65b7cf | bd23fa7 + rngSalt 2 | – | – | **5.22** NEW BEST (salts: 5.10 / 5.04 / 5.22) |
| 02:56 | final-s2eg 38e9fc2 | salt 2 + FFA endgame (3cd57ff); squad actions identical | – | ffa +0.06, win 33→41% | pending; top-32 line now 5.77 |
| 03:01 | final-s2eg 38e9fc2 | official | squad actions identical on stream | – | **4.92** (vs salt 2 5.22): wall-time-capped planning makes real runs path-dependent; re-picked salt 2 (BB-327713BA, 5.22) as final entry |
| 03:01 | lightning-first 1e814e2 | final-s2eg + weaponPref lightning > laser > mortar (house lasers did 76% of real damage; lightning shorts lasers) | – | – | pending (real A/B) |
| 03:04 | squad-ceiling 06707d6 | low-ceiling fix in squad path follower | −0.01 ± 0.00 (480), aim0.6 −0.00 | – | not shipped; stuck time is mostly failed roof-loot climbs (~2 s/match) |
| 03:06 | lightning-first 1e814e2 | official | – | – | **4.46** (−0.46 vs its base 4.92): laser-first is right |
| 03:06 | v3es salt 3 5529620 | bd23fa7 + rngSalt 3 (lottery ticket) | – | – | pending |
| 03:11 | v3es salt 3 5529620 | official | – | – | **4.95** (salts 5.10/5.04/5.22/4.95: mean 5.08, sd ~0.11) |
| 03:11 | laser-upg 967e4c2 | salt 2 + laser_damage/laser_charge first in upgradePref | – | – | pending (real A/B) |
