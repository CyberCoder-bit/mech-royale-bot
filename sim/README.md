# Local simulator (`sim/`)

An approximate re-implementation of the mechfight/1 server rules (`protocol.md`), built to A/B test bot
versions, catch crashes, stuck states, and timeouts, and to write replays for the official viewer.
TypeScript on Bun, no dependencies. Geometry and physics are written independently of `src/world`.
That independence is on purpose: when bot and sim are cross-checked, a bug they share can't hide.

## Usage

```sh
# practice imitation: 1 bot under test + 15 house-like bots (4 easy, 4 medium, 4 hard, 3 expert) as one squad
bun sim/run.ts --mode squad --seeds 48 --bot "bun src/main.ts" [--seed-start 1] [--jobs 12] [--replay runs/replays] [--out runs/x.json]
# fast path, in-process (makeBot(hello[, profile]) from the module)
bun sim/run.ts --mode squad --seeds 48 --bot inproc:src/bot.ts
bun sim/run.ts --mode squad --seeds 48 --bot inproc:runs/bots/main/src/bot.ts@pacifist
# final imitation: everyone fights everyone; --field fills the other 15 slots (missing slots: house:expert)
bun sim/run.ts --mode ffa --seeds 48 --bot "bun src/main.ts" --field "inproc:src/bot.ts*4,house:expert*6,house:sniper*3,house:brawler*3"
# paired comparison on common seeds: mean diff ± se, n
bun sim/run.ts --compare runs/a.json runs/b.json
```

Bot specs: `inproc:<path>[@profile]` (in-process; the module must export `makeBot`, and `@profile` is passed as its
second argument), `house:<archetype>` (in-process house-like bot: easy, medium, hard, expert, brawler, sniper,
thirdparty, farmer, plus the sim-only `top` imitation of other teams' bots), or
any other string, which is run as a subprocess command speaking mechfight/1 on stdin/stdout, exactly like
`kit/check/check.py` and the real server do it (hello, ready within `hello_budget_ms`, one obs per decision, the tick
echoed, a 50 ms wall-clock deadline, coast then idle on missing answers, `end` at death or match end).

Past versions for `ffa`: `sim/bundle.sh <git-ref> [out.js]` bundles that ref's `src/` into one module that exports
`makeBot` and its `draw` singleton (the sim clears drawings after every act). Example:
`sim/bundle.sh v3 runs/bots/v3.js`, then `--field "inproc:runs/bots/v3.js*4,house:top*11"`.

Other flags:
- `--squad "k=v,..."`: squad controller. Calibrated defaults: `t_all=330, hunters_know_position=1, base_hunters=1,
  hunters_per_kill=0.5, nonhunter_engage_m=0, retaliate_s=0, escalate_every_s=0, first_hunter_t=0`.
- `--house "k=v,..."`: global house-bot knobs. Defaults: `aim_mul=1, react_mul=1, lead_mul=1, fire_duty=0.45,
  retreat_mul=1, hop_rate=0`.
- `--full`: keep simulating after the test bot died. By default a match stops there, because the test bot's place is
  final, and that halves the wall time. Use it for full replays or field statistics.
- `--budget-ms 50`: the answer deadline for subprocess bots. `--stderr runs/logs`: keep subprocess stderr per match.
- `--name label`, `--quiet`, `--seed-start N`, `--jobs N` (one worker process per job; a subprocess bot adds one more).

Output: a readable table on stdout plus `runs/<label>_<ts>.json` with the summary and every match result (place,
points = 16 - place, survival, kills, death cause and killer, damage, zone seconds, stuck seconds, idle seconds, rear
hits, cubes, upgrades, answer-time p50/p99/max, late/missed answers, crashes). The field's per-archetype points and
death causes are listed too, which shows how the opponents died: zone, test bot, or each other.

Replays (`--replay <dir>`) are `mechreplay/1` (`.jsonl.gz`): a header with `fields`, frames every 2 ticks with
`m/n/p/z/d` arrays and `ev` events, and a final `result` line. `sim/replay_check.py <ours> <reference>` compares the
structure with the public reference replay (`runs/data/mechanics-v2-16.jsonl.gz`). Header keys, fields, frame arrays,
event names and keys, and the result table all match. Viewer: `https://play.joinbuilders.org/game.html?replay=<url>`
(the file has to be served at a public URL).

Tools:
- `bun sim/validate_stream.ts`: checks the sim geometry against the recorded real stream (grounded z vs terrain and
  roofs, LOS of visible mechs, max speed) and measures raycast speed.
- `bun sim/dump_obs.ts runs/obs.jsonl [seed] [mode]` then `python3 -I sim/schema_check.py runs/obs.jsonl`: validates
  sim observations against `kit/mechfight.schema.json` with check.py's own validator (0 invalid in 2241).
- `bun sim/debug_match.ts <seed> squad` (`VERBOSE=1` for per-bot lines), `bun sim/trace_test.ts <seed> <bot>`:
  per-match diagnostics, including who damaged the test bot and whether it was a hunter.
- `sim/calibrate.sh "<squad k=v>" "<house k=v>" [seeds] [jobs]`: runs the three reference bots in squad mode, and
  `python3 -I sim/cal_table.py` tabulates every run in `runs/cal/`.
- `python3 -I sim/replay_stats.py <replays...>`: gun shots per second by nearest-enemy distance, weapon use, airborne
  share, speed, death times. Works on sim replays, the public replay, and recorded casts. It's the basis of the
  house fire_duty and the FFA calibration.
- `bun test test/sim.test.ts`: rule checks (gun rate, laser damage, jet rise, regen tick, rear multiplier, zone).

## What is simulated

- 20 Hz ticks, decisions every `decide_every` ticks, lockstep. Every observation is built before any action applies.
- Terrain (bilinear int16 grid), 259 prisms (ring minus holes, base..top), trees (trunk cylinders, crown ellipsoids).
  A uniform 8 m grid indexes them. Exact segment-vs-prism intersection, and terrain raycasts with a coarse max grid.
- Movement: acceleration toward the commanded velocity (ground/air), boost and jets with energy, jump, gravity,
  measured jet behavior (capped thrust, then gravity: 8.9 m/s effective rise), cylinder-vs-wall push-out with
  sliding, step-up 1.2 m, terrain slope limit, map-edge walls, bridges you can walk under, ceilings that stop jets,
  roof landing including roof edges (slid off unless moving onto the roof), overlapping mechs pushed apart.
- Vision: near range in every direction (canopy doesn't block), plus range and FOV wedge on torso yaw (canopy blocks
  under Beer-Lambert: blocked after ln(1/canopyBlockT)/canopyDensity = 3.96 m of crown). Trunks block. LOS to the
  center or the top. 5 s memory with live position, shared within the squad in squad mode. Fit against the real
  stream: every listed-mech segment ends 5.0 s after our last LOS sighting.
- Weapons: gun projectiles (spread, range, mag, reload, exact cooldown rate), mortar (ballistic, direct + splash with
  falloff to splash_edge, walls block splash, self-damage 50%, knockback, energy drain, concussion), laser
  (charge/release, min charge, auto-fire after hold_s, half-speed while charging, cooldown, cook-off vs mortar holders,
  pierce), lightning (nearest target in range and cone with LOS: mechs, NPCs, crates; chains with falloff; energy;
  shorts lasers; fires without a target). Shot origin at radius + 0.5 along the aim, clipped at walls. Rear
  multiplier from the front arc, cube damage scaling, armor, regen after regen_delay (not outside the zone), zone
  phases with random next centers inside the current circle and linear shrink, per-tick zone dps.
- Economy: floor weapons (a quarter on roofs), crates (a quarter on roofs; cube + weapon chance), cubes (pickup radius,
  closest mech, HP/damage/size scaling), kill drops (victim cubes + 2, weapons), upgrades (offers at thresholds, 3
  random eligible choices, mul/add effects, timeout picks choice 0, queued offers), NPC drones (leash, aggro, chase,
  shoot, 2 cubes), supply drops (call times, land in the next circle, solo capture with the freeze/restart rules).
- Sounds with carry ranges, bearing noise (measured ~9.5 deg SD), distance bands, ages. Beams seen at either end or
  mid-segment. All event types: damaged, hit, kill, pickup, upgrade, took, dropped, take_failed, effect, drop.
- Placement: same-tick deaths share a place; the match ends with one mech left or at duration_s (ranked by HP).

## House bots and modes

`sim/house.ts`: archetypes from `sim/archetypes.json` (numbers from the data analyst's replay analysis), with
sim-only extras in code (thirdparty only engages weakened targets, farmers avoid fights, experts and farmers take
supply drops). The bots act only on the Observation the engine builds for them. They navigate a 3 m ground nav grid
with A* and connected components. When a goal lies in another component (the stadium bowl, for example), they walk to
the closest reachable cell, charge energy, and jet over. They also loot weapons, farm ground crates, NPCs and cubes,
keep inside the next circle (with hysteresis), lead shots (lead_frac), add drifting aim noise, wait reaction_s before
firing, use the weapon that fits the range, release a full laser charge when aligned, solve mortar arcs, strafe, and
boost.

- `squad`: house bots share vision and can't damage each other. Hunters are the k weakest alive members (tier order
  easy < medium < hard < expert) with k = min(alive, base_hunters + kills by the test bot), and all of them after
  `t_all`. Hunters path to the test bot's true position (`hunters_know_position`). Non-hunters engage it only
  inside `nonhunter_engage_m`, or for `retaliate_s` after it damaged them.
- `ffa`: no teams. The field mixes house archetypes and any bot specs.

## Calibration (squad mode vs official practice)

The official practice gives three anchors on its 48 fixed seeds: the kit example scores 1.15, our v0 "fighter" 3.38,
and the same bot as "pacifist" 0.08. The sim has its own seeds (1-48). Its example is the kit example's TS twin
in-process (`inproc:src/bot.ts`), and fighter/pacifist are main's `src/bot.ts` profiles in-process.

| squad model (house knobs) | example (1.15) | fighter (3.38) | pacifist (0.08) |
| --- | --- | --- | --- |
| non-hunters engage < 60 m and retaliate (fire_duty 1) | 0.23 ± 0.06 | 1.42 ± 0.20 | 0.00 |
| non-hunters only retaliate, aim/reaction x2 | 0.23 ± 0.07 | 1.48 ± 0.20 | 0.00 |
| non-hunters only retaliate, fire_duty 0.4, aim/reaction x1.6 | 0.33 ± 0.10 | 2.06 ± 0.26 | 0.00 |
| passive non-hunters, hunters = 1 + kills, fire_duty 0.45 | 1.10 ± 0.17 | 2.31 ± 0.23 | 0.00 |
| **default: passive non-hunters, hunters = 1 + floor(kills/2), fire_duty 0.45** | **1.15 ± 0.20** | **3.21 ± 0.27** | **0.06 ± 0.06** |

Findings: a squad that retaliates kills the example far too fast, because the example shoots whatever it sees and
pulls in everyone near it. The calibrated model is passive non-hunters plus one hunter per two kills. Hunters are
the weakest alive members, so easy bots come first, and from 330 s on everyone hunts. That reproduces all three
anchors within one standard error. `fire_duty=0.45` comes from the public replay, not from the fit: real house bots
fire 0.56-0.77 gun shots/s with an enemy within 30-100 m, and ours fired about 1.5/s at duty 1.

`ffa` (top-team imitation, `top` archetype) against the 7 recorded Top-16 casts (real team bots, current rules):

| | sim, field top*15 (8 matches) | casts (7 matches) |
| --- | --- | --- |
| death time Q1 / median / Q3 | 33 / 65 / 134 s | 33 / 85 / 143 s |
| gun shots/s with nearest enemy 60-100 m / 100-150 m | 0.65 / 0.45 | 0.69 / 0.40 |
| laser shots per gun shot | 10.6% | 8.1% |
| mean speed, airborne share | 5.9 m/s, 4% | 6.4 m/s, 7% |

`top` = 0.2 s reaction, 0.7 deg aim noise, 0.95 lead, engages at about 120 m, prefers 75 m, camps (holds its spot 75%
of roam decisions and fights from where it stands), little boosting, gun+laser first. The default `ffa` field is
`house:top*12,house:expert*3`.

Cross-check through the real protocol path: the kit Python example as a subprocess
(`--bot "python3 -u kit/python/example_bot.py"`, 48 seeds) scores **1.19 ± 0.19**, against 1.15 ± 0.20 for its
in-process twin and 1.15 official. The machine was saturated during that run (5.7% late answers, p99 368 ms), so
the calibration holds even with some coasting.

## Performance

Measured on this 24-core machine while it was shared (load average 50-75 from other jobs, so treat the numbers as
lower bounds):
- One in-process squad match to full length (about 420 s of match time): 6-9 s wall early in the session at lighter
  load, 48 s at load 70. With the early stop: 14 s (test bot died at 68 s) and 35 s (died at 304 s) at load 70.
  Observation building (vision, items) is about half the cost, then house AI, then physics.
- Batches, in-process, full-length matches: 54-73 matches/min with 12 jobs on a lighter load. With the early stop
  under heavy load: 18.5 matches/min with 12 jobs.
- Subprocess bot (`bun src/main.ts`): 4-10 matches/min with 8-10 jobs under heavy load. Each decision waits for the
  bot's answer, so the bot's own speed and the machine load dominate.
- World load is 40-70 ms and the house nav grid build about 250 ms, once per worker process.
- Raycasts: about 2.5 us per 150 m LOS ray (prisms + terrain + trees).
- Late answers: check.py itself measured p99 68 ms for the trivial example bot on this machine under that load. The
  sim measures the same way, so late answers in a batch usually mean "machine busy". Run timing-sensitive checks on
  an idle machine, or use the docker check.

## Fidelity gaps (known)

- **House-bot AI is an imitation.** Archetype numbers come from one public replay on an older ruleset, and the squad
  logic (who hunts, who fights back) is fitted to three aggregate practice scores, not observed. Treat `squad` numbers
  as a ranking signal for bot versions, not as a predicted practice score, and confirm big decisions with `ffa` too.
- **Non-hunters are passive in the default squad model** (`nonhunter_engage_m=0, retaliate_s=0`): they never shoot
  the test bot unless they are hunting. That is what reproduced the kit example's 1.15. A bot that farms passive
  squad members looks better here than it may be in reality. `--squad "nonhunter_engage_m=60,retaliate_s=6"` is the
  pessimistic variant, worth checking before relying on "attack everything" behavior.
- Movement: roof-edge landing and slide-off are simplified (8-direction probe). The eave slide-out rule (0.6 m/tick
  out from under an overhang) is only applied at roof edges. "A step up under an overhang that would put your head
  into it" is not checked. Mech-vs-mech overlap is resolved after movement with a simple push-apart.
- Mortar splash distance is measured to the nearest point of the target cylinder (the server's metric is unknown).
  Splash is blocked when neither the mid nor the upper body of the target has LOS from the blast point.
- Lightning cone: |yaw offset| <= cone_deg / 2 is assumed (the replay's max observed offset is 6.7 deg, so either
  reading fits). Chains go to the nearest unhit target within chain_range with LOS.
- Gun spread is Gaussian with SD = spread_deg on yaw and pitch independently (an assumed reading of "spread").
- Crates don't block movement or sight. NPC drones walk on the ground, wander within the leash, aggro on attackers or
  on mechs within aggro_range with LOS while near home, chase up to chase_leash, and shoot without lead.
- Spawns: open ground inside spawn_zone_fraction x start radius, separation relaxed 10% per 300 failed tries.
  Next zone centers are uniform in the allowed disc and kept 40 m inside the map bounds. Drops land on open ground
  within spread x next radius of the next center. All of these are guesses at the server's sampling.
- Vision distance is 3D. Canopy crowns are ellipsoids (Beer-Lambert; fits the stream), trunks reach mid-crown.
- Sounds: bearing noise scaled to the measured ~9.5 deg SD. Jets make a `jet` sound every step_every. Reload sounds
  at reload start. Ages are 0.05 / 0.1 s like the stream.
- Regen: damage dealt to NPCs and crates also resets your regen timer (a guess). Plating heals the max-HP gain.
- Upgrade offers draw 3 uniformly random eligible upgrades. Offer ids count up per match.
- Timing: each decision computes in-process bots first, then sends observations to subprocess bots and waits on a
  free event loop. A subprocess bot's answer time is its own compute plus pipe latency, like on the server. The
  machine is shared, though: under heavy load (load average > cores) late answers show up that a quiet machine
  doesn't have. Use `--budget-ms` to relax the deadline for behavior-only runs.
- In-process bots run in one process per match. Module-level state in a bot leaks between instances: keep all state
  in the makeBot instance (src/bot.ts already says so).
