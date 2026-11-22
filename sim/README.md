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

Bot specs: `inproc:<path>[@profile]` (in-process, the module must export `makeBot`; bundled older versions work:
`bun build src/bot.ts --target=bun --outfile runs/bots/v3.js`), `house:<archetype>` (in-process house-like bot), or
any other string, which is run as a subprocess command speaking mechfight/1 on stdin/stdout, exactly like
`kit/check/check.py` and the real server do it (hello, ready within `hello_budget_ms`, one obs per decision, the tick
echoed, a 50 ms wall-clock deadline, coast then idle on missing answers, `end` at death or match end).

Other flags:
- `--squad "t_all=330,hunters_know_position=1,base_hunters=1,nonhunter_engage_m=..,retaliate_s=6,escalate_every_s=0,first_hunter_t=0"`: squad controller.
- `--house "aim_mul=..,react_mul=..,lead_mul=..,fire_duty=..,hop_rate=.."`: global house-bot skill knobs (calibration).
- `--budget-ms 50`: the answer deadline for subprocess bots. `--stderr runs/logs`: keep subprocess stderr per match.
- `--name label`, `--quiet`.

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
- `sim/calibrate.sh "<squad k=v>" "<house k=v>" [seeds] [jobs]`: runs the three reference bots in squad mode.

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

CALIBRATION_PLACEHOLDER

## Performance

PERF_PLACEHOLDER

## Fidelity gaps (known)

GAPS_PLACEHOLDER
