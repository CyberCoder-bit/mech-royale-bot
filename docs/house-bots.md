# House-bot profile (public replay `mechanics-v2-16`)

Source: one 16-house-bot FFA replay, seed 16, ruleset "mechanics-v2" (older than ours). 2 or 3 bots per archetype, so
every per-archetype number below has a small sample (n = 2-3 bots, one match). Treat differences between archetypes as hints.
Reproduce: `bun tools/replay-summary.ts runs/data/mechanics-v2-16.jsonl.gz --archetypes` (add `--json` for everything).

## 0. The replay's ruleset is not ours

| Rule | v2 replay (measured) | Current config (`hello.config`) |
| --- | --- | --- |
| Gun bullet speed | **140 m/s** (projectile tracks) | 252 m/s |
| Walk / boost speed | **9.0 / 15.0 m/s** (p90 grounded) | 11.7 / 19.5 |
| Laser | **420 dmg** at 0 cubes, full charge **0.65 s** | 315 dmg, 0.75 s |
| Mortar | 72 m/s, g = 22, 200 direct (same) | same |
| Gun dmg / NPC bullet | 45 / 90 m/s (same) | same |
| Zone schedule | identical to the defaults | same |

Lead and hit-rate numbers below use the measured 140 m/s. Today's bullets are 1.8x faster, so lead errors and long-range
misses shrink. Movement is 30% faster today, which makes jinking more effective.

## 1. Outcome

- The match ended at **209.6 s**: 15 deaths, the last one in the zone. Deaths at 41.7, 66.1, 67.7, 67.8, 69.5, 81.3, 98.5, 125, 136.5, 136.8, 137.9, 160.7, 168.6, 198, 209.6 s.
  Half the field was dead by 125 s, before zone phase 2 finished.
- Winner: brawler #9 (gun + lightning, 4 kills, 7.8k damage dealt, 16 cubes, 1 supply drop, never below 34% HP).
- 2nd: brawler #2, a rooftop laser camper (z up to 46 m, 30 m above ground). It took **zero weapon damage** in 210 s and
  dealt 1.1k with the laser at 150-190 m. It died in the zone after 31 s outside (1456 zone damage).
- 3rd: sniper #3, 3 kills, survived 5k damage by healing (9 regen episodes, a drop at 107 s that gave it 9 cubes).
- Mean place by archetype (lower is better): brawler 1.5, farmer 4.5, sniper 7.5, medium 10, thirdparty 10.5, expert 11.3, hard 11.3.
- Kill weapon: gun 9, laser 3, lightning 1, mortar 1, zone 1.

## 2. Movement

| arch | speed med / p90 | boost % | airborne % | still % (<1 m/s) | elevated & grounded % | max above ground | strafe % in combat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| expert | 9.0 / 12.5 | 27 | 27 | 7.8 | 6.9 | 31 m | 56 |
| hard | 8.9 / 11.5 | 26 | 27 | 1.0 | 0.2 | 31 m | 60 |
| medium | 9.0 / 11.0 | 17 | 19 | 0.3 | 0 | 25 m | 62 |
| brawler | 8.9 / 10.8 | 21 | 26 | 1.3 | 0.6 | 30 m | 35 |
| sniper | 8.7 / 11.3 | 22 | 24 | 8.7 | 2.1 | 36 m | 30 |
| thirdparty | 8.9 / 10.9 | 23 | 40 | 3.7 | 0.3 | 29 m | 49 |
| farmer | 9.0 / 11.8 | 24 | 29 | 0.5 | 4.4 | 27 m | 37 |
| **all** | **8.9 / 11.6** | **23** | **27** | **3.2** | **2.2** | 36 m | **46** |

- Speed bands (all bots, frame to frame): 65% walking at 5-9.5 m/s, 16% at 1-5, 10% at 9.5-13, 6% above 13 (boosting), 3% still.
  Walking speed is almost always the full walk speed.
- They hop constantly: **5-9 airborne episodes per minute**, median 3 s, median rise **14 m** (jump plus jets). Airborne 27% of the time.
- Roof use is rare: grounded more than 3 m above terrain only 2.2% of the time. Exceptions were the rooftop laser brawler #2 and expert #6 (20 s).
- "Strafe %": frames within 0.5 s of a shot where the bot moves faster than 4 m/s and more across the line to its target than along it.
  Gunners (expert, hard, medium) strafe about 60%. Sniper, brawler, and farmer mostly walk along the line.

## 3. Combat

### Damage and accuracy (hits on mechs)
- Damage to mechs by weapon: gun 23.9k (65%), laser 7.4k (20%), lightning 3.0k (8%), mortar 2.4k (7%).
- Gun: 1061 shots, 433 mech hits, 63 NPC hits, 108 crate hits. **51% of shots aimed at a mech hit it** (843 attributed shots).
- Mortar: 18 of 57 shells (32%) damaged a mech. Laser: 11 of 39 shots (28%) hit a mech. Lightning: 33 of 47 zaps hit a mech, and every zap hit something.

Gun hit rate by shooter-target distance at fire time (hits/shots), all bots:

| 0-30 m | 30-60 | 60-100 | 100-150 | 150-230 |
| --- | --- | --- | --- | --- |
| 15/15 (100%) | 207/231 (90%) | 126/228 (55%) | 69/295 (23%) | 16/67 (24%) |

By archetype, 30-60 / 60-100 / 100-150 m: sniper 98 / 95 / 24%, thirdparty 76 / 79 / 0%, medium 91 / 57 / 33%,
expert 88 / 41 / 27%, hard 93 / 44 / 21%, brawler 82 / 54 / 24%, farmer 83 / 31 / 25%.

### Aim model fit (gun shots attributed to a mech, 140 m/s bullets)
| arch | lead fraction | yaw noise SD around own lead | pitch err SD | effective sigma from hit rates |
| --- | --- | --- | --- | --- |
| expert | 0.75 | 1.21 deg | 2.5 deg | 2.25 deg |
| hard | 0.81 | 0.85 | 2.1 | 2.25 |
| medium | 0.64 | 1.23 | 2.3 | 2.00 |
| brawler | 0.73 | 1.04 | 2.3 | 2.20 |
| sniper | 0.72 | 0.89 | 2.1 | 1.60 |
| thirdparty | 0.74 | 1.20 | 2.3 | 1.75 |
| farmer | 0.83 | 0.73 | 1.9 | 2.35 |
| **all** | **0.76** | **1.01** | **2.3** | **2.10** |

- **Lead fraction:** least-squares slope of the actual aim offset on the ideal intercept offset (yaw, target velocity
  from frame deltas). House bots apply about **75% of the ideal lead**.
- **Yaw noise:** SD of the residual. It is an upper bound, because it includes 1-tick timing and velocity-estimate noise.
- **Effective sigma:** MLE of one Gaussian angular error that reproduces the binned hit rates, with the target treated as a
  2.5 m x 9 m cylinder (`P = erf(R/(sqrt2*sigma*d)) * erf(4.5/(sqrt2*sigma*d))`). It includes target motion during the
  0.2-1.0 s flight, so it overstates their error under today's 252 m/s bullets.
- Tiers do not separate in this match: the experts' aim was no better than the hards'. The sniper is clearly best past 60 m.

### Distances
| weapon | hit distance p10 / median / p90 | engagement start distance p10 / median / p90 |
| --- | --- | --- |
| gun | 36 / 59 / 120 m (n 433) | 47 / 102 / 190 m (n 79) |
| laser | 51 / 82 / 180 m (n 11) | 64 / 134 / 178 m (n 17) |
| mortar | 42 / 57 / 89 m (n 18) | 52 / 131 / 182 m (n 16) |
| lightning | 16 / 31 / 39 m (n 33) | - |

- "Engagement start" is the first shot at a target after at least 5 s without shooting at it. Median start by archetype
  (gun): thirdparty 61 m, medium 74, hard 89, expert 98, farmer 99, sniper 107, brawler 147.
- Lasers always fire at full charge: the charging flag was on for 0.6-0.7 s on every one of 40 charges (full = 0.65 s in v2),
  then released. No partial charges, no holding.
- **Rear hits:** 14% of all mech hits came from behind (gun 60/433, mortar 4/18, **laser 6/11**, lightning 1/33).
  Gunners and medium land the most rear hits (medium 25%). Hard bots took the most from behind (23%).
- Cook-off: 6 laser hits on mortar carriers did 650-1170 each. Thirdparty #11 died to a cook-off sequence (1820 damage in 15 s from one laser).

### Target selection, reactions, retreat, healing, TTK
- **Target choice:** at engagement starts with 2 or more candidates in view (wedge or 45 m, no LOS test), the target was the
  **nearest 59%** of the time (random baseline 45%) and the **lowest-HP 44%** (baseline 45%, so no preference).
  Thirdparty and farmer picked the nearest 86-88% of the time. Median target HP at engagement start was 88%.
- **Reaction:** from the first hit by a new attacker to the victim's first shot back at that attacker: median **1.6 s**
  (p10 0.3 s, n = 13; this includes turning). Expert 0.65 s and medium 0.9 s; the others 1.6 s or slower.
- **Retreat:** share of frames moving away from the latest attacker (>3 m/s radial) within 1.5 s of being hit, by HP band:
  0-20% HP 19%, 20-40% 32%, 40-60% 24%, 60-80% 29%, 80-100% 28%. **No HP-triggered retreat** overall.
  Only the brawlers show a graded curve (2% at full HP rising to 36% at 20-40%).
- **Healing:** 49 regen episodes. Median start 76% HP, median end 96%, median length 2.7 s, and only 39% reached full.
  They re-engage before they are full.
- **Time to kill:** from the first hit of the killer's final streak (gaps under 8 s) to the death: median **11.6 s**
  (p10 2.7, p90 20.6), median 14 hits in that streak. Most victims had already been damaged by someone else.

## 4. Economy

- Weapons: 9 of 16 took a weapon in the first 11 s (laser at 1.7-6.7 s, mortar at 5.4-7.7 s, lightning at 3.2-10.4 s).
  5 of 16 never took one, and 4 of those were among the first 5 deaths. Takes: mortar 7, laser 6, lightning 3.
- Swaps: medium #8 dropped its laser for a mortar, farmer #5 its laser for a mortar, and farmer #12 swapped
  lightning, mortar, lightning, mortar. Mortar-first: both thirdparty bots.
- Cubes picked up: kills 18, NPCs 16 (8 NPC kills), crates 14 (16 of 36 crates broken), drops 6 (2 drops taken).
  Most bots ended with 0-4 cubes. The top 3 had 16, 1, and 9.
- NPC and crate kills per bot: brawler 2.5, farmer 2.5, hard 2.0, expert 1.0 (all 8 expert cubes came from NPCs), medium 1.0, sniper 1.0, thirdparty 1.0.
- Upgrades are picked immediately (within 0.05 s of the threshold). Picks: plating 5, gun_damage 4, reactor 3, gyros 2,
  nanites 2, lightning_efficiency 2, armor, gun_mag, laser_damage, mortar_splash, mortar_reload, and lightning_chain 1 each.
  By archetype: expert reactor x2, gun_damage, plating. Hard plating x2, gun_mag, nanites. Medium armor, reactor, laser_damage.
  Brawler gun_damage x3, lightning_efficiency x2, lightning_chain. Sniper gyros x2, plating x2. Thirdparty mortar_splash, nanites.
  Farmer mortar_reload. Only picks are visible, not the offers.

## 5. Zone

- No house bot was ever caught by the zone except the rooftop camper. Median margin inside the current circle: 330 m (0-60 s),
  282 m (60-110 s), 211 m (110-155 s), 201 m (155-195 s), 170 m (195-230 s).
- At each shrink start, every survivor except #2 was already inside the next circle (smallest margin 41 m).
- Zone deaths: 1 (#2, place 2, 209.6 s).

## 6. Top 3 vs the first 5 deaths

| | top 3 (#9 brawler, #2 brawler, #3 sniper) | first 5 deaths (#1 hard, #13 expert, #15 medium, #11 thirdparty, #10 sniper) |
| --- | --- | --- |
| death time | survived / 209.6 / 198 s | 41.7-69.5 s |
| weapon | lightning at 10 s / laser at 5 s / laser at 111 s | 4 of 5 had only the gun; #11 carried a mortar (cook-off bait) |
| cubes max | 16 / 1 / 9 | 0-2 |
| fights | #9 fought constantly, but at 74 m median gun range and 31 m lightning; #2 never got hit; #3 healed 9 times | 3 of 5 died to 2 attackers within 15 s (crossfire) |
| position | #2 on roofs 30 m up; #3 stood still 12% of the time (sniping) | ground level, engaged at 45-60 m |

The early deaths were gun-only bots that got caught at mid range by two attackers, or by a laser from a mech they
weren't facing. The survivors either won 1v1s with a strong weapon and snowballed cubes (#9: 8 cubes from 4 kills,
1960 max HP), or stayed out of everyone's line of fire (#2).

## 7. Facts that matter for our strategy

1. **House bots target the nearest enemy, not the weakest, and they don't retreat on low HP.** A bot that is already
   fighting keeps fighting, so third-party it: arrive when it's under 50% and finish it. In practice the squad
   hunts us anyway, but inside a fight each one locks onto whoever is closest.
2. **Their gun aim is about 1 deg of yaw noise around 75% of the correct lead** (pitch noise about 2.3 deg). With 252 m/s
   bullets and a target moving straight at 11.7 m/s, the model gives about 70% hits at 80 m and about 30% at 150 m.
   Direction changes during the 0.3-0.6 s flight beat their lead. Jink every 0.3-0.5 s and fight at 120 m or more
   when we only have the gun.
3. **Inside about 60 m, a house gunner hits ~90%** (old 140 m/s bullets). Close only with lightning. Lightning hit every
   zap within 45 m and won the match.
4. **The laser is their burst threat:** always a full charge (0.65 s in v2, probably 0.75 s now), 55% of laser hits landed
   in the back, and cook-offs did 650-1170. Watch `charging: true` on any mech aiming within a few degrees of us and
   sidestep at release. Don't hold a mortar near laser users.
5. **Reaction is slow.** From the first hit to the first shot back: median 1.6 s, and the experts 0.65 s. Opening from
   outside their wedge (behind or flank) buys 1-2 s of free fire, about 4-8 gun shots.
6. **Kill time is about 12 s for them.** A full-HP 1400 mech takes about 31 gun hits. With our faster aim solution, a
   clean 1v1 at 80-120 m from cover should beat any single house bot. Avoid two at once: 3 of the first 5 deaths were crossfire.
7. **Elevation and range keep you alive in FFA.** The rooftop laser camper took zero weapon damage in 210 s and placed
   2nd. House bots rarely stand on roofs (2% of the time) and seldom look up.
8. **Get a slot-1 weapon early.** Bots with no slot-1 weapon made up 4 of the first 5 deaths. Pickups were 1.7-10 s from spawn for most.
9. **The zone is not where house bots lose.** They sit about 200 m inside the circle. In FFA most of the field is dead
   by 140 s, so the endgame HP race only matters in squad/practice mode.
10. **They hop a lot:** airborne 27% of the time, 5-9 hops per minute, rising about 14 m. When we shoot at an airborne
    target, lead its vertical motion, or wait for it to land.

## 8. How `sim/archetypes.json` was derived

| field | meaning for the sim | evidence |
| --- | --- | --- |
| `aim_sigma_deg` | Gaussian aim error applied to yaw and pitch, on top of the weapon's own spread | measured yaw SD 1.0 deg, pitch SD 2.3 deg; ~1.4 deg isotropic gives the same hit probability on a 2.5 x 9 m cylinder |
| `lead_frac` | fraction of the ideal intercept lead the bot applies | measured 0.64-0.83, pooled 0.76 |
| `reaction_s` | delay before responding to a new threat, not counting turn time | measured with turning: expert 0.65 s, medium 0.9 s, all 1.6 s (n = 13) |
| `fire_range_m` | farthest distance at which the bot opens fire | p90 of engagement-start distances, capped at the 200 m vision range |
| `preferred_range_m` | typical fight distance | median distance of attributed shots |
| `retreat_hp_frac` | HP fraction below which the bot backs off | no retreat in most archetypes (0.15-0.2); brawler, sniper, and farmer rise at 20-40% HP |
| `strafe`, `boost_frac` | share of combat time spent strafing; share of all time boosting | measured directly (§2) |
| `loot_weapon_first`, `weapon_pref`, `farm_cubes`, `upgrade_pref` | economy habits | §4: takes, swaps, NPC and crate kills, and picks |

- Tier order easy < medium < hard < expert in aim and reaction is a prior. This match doesn't separate the tiers.
  `easy` is extrapolated from `medium`: worse aim, slower reaction, less lead, no farming.
- Calibration check: run the sim on the v2 rules (gun 140 m/s, walk 9 m/s, laser 420 / 0.65 s), then compare
  `gun_hit_rate_by_dist`, `aim_fit`, and `engagement` from `bun tools/replay-summary.ts <sim replay> --json` against §3.
