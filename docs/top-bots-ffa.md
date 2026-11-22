# Top-16 team bots in FFA (recorded showdown casts)

**Sample:** one recorded match so far: "Top 16 Showdown, 8 PM", match 2 of 6 (a re-air), seed 3893786677, 363.5 s,
current ruleset (gun 252 m/s, walk 11.7, boost 19.5 measured). n = 1 match per team, so per-team numbers are one game.
For the whole showdown we only have the standings: kyoto-max 65 points (3 wins), then 314159265 54, tigerbyte 54, azing 53 (1 win).
In this match kyoto-max placed 6th.

Reproduce or extend as more casts are recorded:
- `bun tools/replay-summary.ts <cast.jsonl> [--archetypes]`: works on cast files unchanged. Team entries (`bots` = `docker:...`) are grouped by `mechs[].name`.
- `bun tools/cast-teams.ts /home/jason/builders/mech_royale/runs/cast`: pools every cast file per team.

## 1. Per team (this match)

| place | team | death s | kills | dmg out / in | gun acc vs mechs (shots) | laser acc (shots) | gun hit d med | engage start med | still % | boost % | air % | cubes max | final loadout | upgrades |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | azing | survived | 7 | 9775 / 5947 | 85% (104) | 62% (21) | 61 m | 77 m | 47 | 3 | 1 | 31 | gun+laser | gun_rate x3, armor x2, plating, reactor |
| 2 | tigerbyte | 363.5 | 1 | 1700 / 2278 | 86% (35) | - | 48 | 64 | 28 | 8 | 1 | 2 | gun+lightning | armor |
| 3 | RailTazers | 307.5 | 0 | 1784 / 2547 | 92% (24) | 0% (2) | 41 | 52 | 66 | 1 | 1 | 2 | gun+laser | laser_damage |
| 4 | IT_Professionals | 235.1 | 3 | 5926 / 5817 | 67% (120) | 83% (6) | 72 | 62 | 10 | 16 | 0 | 9 | gun+laser | nanites, jets x2 |
| 5 | TigerTown27 | 216.8 | 0 | 552 / 1526 | 92% (13) | - | 61 | 76 | 44 | 10 | 2 | 0 | gun+lightning | - |
| 6 | kyoto-max | 212.0 | 0 | 2284 / 1945 | 86% (22) | 67% (6) | 62 | 59 | 61 | 8 | 0 | 2 | gun+laser | armor |
| 7 | giddygiddyboy | 202.4 | 0 | 1163 / 1601 | 92% (13) | 50% (4) | 52 | 77 | 81 | 3 | 0 | 2 | gun+laser | armor |
| 8 | 67 | 113.9 | 2 | 4444 / 2762 | 78% (54) | 73% (11) | 62 | 118 | 48 | 12 | 2 | 3 | gun+laser | nanites, gun_mag |
| 9 | Vice City Vibecoders | 92.8 | 0 | 1185 / 1456 | 81% (16) | 40% (5) | 77 | 117 | 48 | 10 | 5 | 1 | gun+laser | gun_rate |
| 10 | @GMUNVIS | 87.6 | 2 | 4854 / 3622 | 59% (41) | 73% (11) | 86 | 93 | 22 | 17 | 0 | 10 | gun+laser | plating x2, armor, laser_damage |
| 11 | 4141 | 62.3 | 0 | 1120 / 3273 | 100% (12) | 67% (3) | 88 | 165 | 21 | 24 | 0 | 1 | gun+laser | nanites |
| 12 | hamsters | 59.4 | 0 | 1170 / 1456 | 60% (42) | - | 83 | 57 | 8 | 10 | 0 | 1 | gun+lightning | gyros |
| 13 | 314159265 | 26.2 | 0 | 1235 / 1512 | 76% (33) | - | 93 | 84 | 0 | 28 | 4 | 2 | gun+mortar | gyros |
| 14 | BITS and Peaces | 24.0 | 0 | 1215 / 1400 | 63% (43) | - | 59 | 56 | 0 | 0 | 0 | 0 | gun | - |
| 15 | not even close | 12.5 | 0 | 855 / 1400 | 100% (19) | - | 30 | 39 | 29 | 38 | 0 | 0 | gun | - |
| 16 | ImagineLosing | 8.9 | 0 | 518 / 1400 | 92% (12) | - | 33 | 27 | 1 | 43 | 20 | 0 | gun+laser | - |

No team took any zone damage. Smallest zone margins: azing 8.9 m, tigerbyte 7.3 m, RailTazers 25.6 m.

## 2. Team bots vs house bots (all 16 pooled)

| metric | team bots (this cast) | house bots (v2 replay, docs/house-bots.md) |
| --- | --- | --- |
| gun hit rate vs mechs | **76.5%** (461/603) | 51% (140 m/s bullets) |
| gun hit rate at 30-60 / 60-100 / 100-150 m | 91 / 70 / 65% | 90 / 55 / 23% |
| pitch error SD | **0.65 deg** | 2.3 deg |
| yaw residual SD around own lead | 1.35 deg | 1.0 deg |
| laser hit rate | **64%** (44/69) | 28% |
| laser hold (charging flag) | median 0.8 s (full charge), p10 0.3, p90 2.7 s (held up to auto-fire) | always 0.6-0.65 s |
| damage share gun / laser / lightning / mortar | 58 / 39 / 3 / 0% | 65 / 20 / 8 / 7% |
| engagement start distance median (p10-p90) | **75 m** (44-210) | 106 m (47-188) |
| target = nearest (multi-candidate starts) | 80% (baseline 44%) | 59% (baseline 45%) |
| reaction (first hit to first shot back) | **0.2 s** median (n 15) | 1.6 s |
| time to kill (killer's final streak) | **5.6 s** median (p10 1.7, p90 13.7) | 11.6 s |
| rear hits taken / dealt | 4% / 4% | 14% / 14% |
| still (<1 m/s) | **43%** of alive time | 3% |
| boost / airborne | 8.5% / 1% | 23% / 27% |
| slot-1 weapon taken | 14 of 16, median about 8 s | 9 of 16 in the first 11 s |
| final loadouts | gun+laser 10, gun+lightning 3, gun+mortar 1, gun 2 | mixed; mortar common |
| upgrades picked | armor 6, gun_rate 4, nanites 3, plating 3, laser_damage 2, gyros 2, jets 2, gun_mag 1, reactor 1 | plating 5, gun_damage 4, reactor 3 |
| cube sources | kills 35, crates 14, NPCs 11, drops 6 | kills 18, NPCs 16, crates 14, drops 6 |

## 3. How the match went

- **Opening (0-30 s):** 4 deaths by 26 s, at 39-116 m. Three of the first four out boosted 28-43% of their short lives,
  and the fourth (BITS and Peaces) never took a slot-1 weapon. ImagineLosing died at 8.9 s while rushing (43% boost,
  20% airborne): RailTazers hit it first and tigerbyte finished it from 116 m.
- **Mid game (30-200 s): most bots camp.** In 30-60 s, 5 of the 12 alive were still 79-98% of the time
  (azing 96%, giddygiddyboy 97%, Vice City 98%, 67 92%, RailTazers 79%), and kyoto-max 58%. From 110 to 200 s:
  RailTazers 95%, giddygiddyboy 92%, kyoto-max 86%, azing 62%, TigerTown27 61%. IT_Professionals and tigerbyte kept moving.
- **Movement and place:** over whole lives, place correlates with stillness (Spearman -0.58) and boost (+0.56).
  Inside matched time windows the link is weak (|rho| 0.3 or less), so most of it is a life-length confound:
  early deaths only ever lived through the opening sprint. Gun accuracy does not predict place (rho -0.05). Everyone aims well.
- Kills mostly came from full-HP duels, not third-party cleanups. Of 15 kills, the victim was at 89% HP or more when the
  killer's final streak started in 11 cases. It was at 23-52% in 4 cases, and in 2 of those someone else was hitting it in the prior 10 s.

## 4. What the winner (azing) did differently

- **It snowballed cubes into raw damage.** It had 5 cubes by 25 s (crates and NPCs). The kill of @GMUNVIS (10 cubes) at
  87.6 s dropped 12, which it collected about 14 s later. The 2 supply drops added 6, and its 7 kills 20 in all, for 31 cubes. 10 or more cubes
  means +40% damage and HP. With gun_rate x3 (cooldown 0.24 to 0.16 s), its gun alone did about 400 DPS and each laser
  shot about 440. It killed full-HP mechs in **2.6-6.4 s** (TTK median 4.9 s, 7 kills).
- **It camped high and faced its threats.** Still 47% of the time and on roofs for 43 s (11.8%; no other team spent more than 1 s on one).
  It took **0 of 80 hits from behind**. Gun accuracy 85%, laser 62%.
- **It fought at 34-103 m** (gun hit median 61 m), opened at a median 77 m, and chose the nearest target 83% of the time.
  It never left the zone (smallest margin 8.9 m).
- Practice rank 15, FFA winner. Matches the coordinator's note that practice rank barely predicts FFA rank.

## 5. kyoto-max (showdown leader: 3 of 6 wins, 65 points; 6th in this match)

- **Passive survivor.** Only 2 engagements all match (both at about 60 m) and 0 kills. Still 61% of the time
  (86% from 110 to 200 s), boost 8%, never airborne, never on a roof. Zone margin at least 92 m, so it stayed deep inside.
- Early loot: 2 crates by 8.5 s (armor at 3.3 s), lightning at 8.4 s swapped for a laser at 15.3 s. Accuracy is high
  (gun 86%, laser 67%) but it barely shot.
- It died at 212 s to IT_Professionals' laser in a 6.3 s streak from 96% HP. It reacted (0.35 s) but lost the duel to a
  bot with 9 cubes against its 2.
- Reading: kyoto-max wins by being the last one standing, then by HP at the end, when the fighters trade each other down.
  It loses when a cube-rich fighter (azing here) finds it. Its other 5 matches aren't recorded yet. Check this read against them.

## 6. Facts for our FFA strategy

1. **Expect strong aimers.** Team bots hit 91% at 30-60 m and 65-70% out to 150 m, with near-perfect pitch. Range alone is
   no longer protection the way it is against house bots. Break line of sight with buildings, not distance.
2. **Fights end in about 3-6 s** (TTK median 5.6 s) and reactions take about 0.2 s. Taking a duel at even HP is a coin flip.
   Take a fight only with an edge: more cubes, first shot from cover, or a target already under fire.
3. **Cubes are the snowball.** 10 cubes is +40% HP and damage, and a kill transfers the victim's cubes plus 2. Early
   crates and NPCs, plus drops, are worth risk. A cube-rich enemy is the most dangerous mech and also the best prize.
4. **The laser is the meta weapon** (10 of 16 final loadouts, 39% of damage, 64% hit rate). Expect `charging` and full-charge
   beams (0.8 s holds). Lightning is the counter (short) once inside 45 m.
5. **Don't rush the opening.** All of the first four deaths happened before 26 s in open duels at 39-116 m. Loot near
   spawn, then hold cover.
6. **Mid-game camping is common** (most survivors were still 60-100% of the time from 30 to 200 s). Silent and still is the default.
   Third-party chances come from listening (gun and laser sounds) more than from roaming.
7. **Face the threat:** top bots took about 0% of hits from behind. Rear exposure is a choice we can't afford.
8. **No one dies to the zone,** but the late circle forces contact (the final kill came at 363 s, inside the 25 m circle).
   Plan the endgame to hold full HP with as many cubes as possible.
