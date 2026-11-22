# AGENTS.md: Mech Royale bot

Instructions for any coding agent working in this repo. Read this file in full before you change anything.
The rulebook is `protocol.md` (identical to `kit/protocol.md`). Where this file and protocol.md disagree, protocol.md wins.
Live numbers always come from `hello.config`. The numbers below are the defaults, for reasoning only.

## 1. Goal and deadline

Build a bot for the Builders Mech Royale track: a 16-mech battle royale on the OSU Oval map. A match runs at most 8:00 and the zone closes by about 6:55.

- **Metric:** mean of `16 - place` over every match in a run. 15 for a win, 0 for dying first. Placement counts, kills do not.
- **Baseline to beat:** 1.15 (the kit's Python example bot).
- **Cutoff: Sun 2026-11-22 11:00 AM EST (16:00 UTC).** This machine's clock is EST. Run `date` at the start of every session and plan around the time left.
- **Practice:** 48 matches against 15 house bots (4 easy, 4 medium, 4 hard, 3 expert). Seeds are private and fixed for the whole event. The team gets **6 submissions per hour** (raised from 4; live quota on joinbuilders.org/buildathon/status, can change). Scoring takes p50 ~1m40s, p95 ~3m20s. The best practice score counts. Equal scores rank the earlier submission first.
- **What wins:** your practice score decides whether you get into the top 32. Qualifying (16 matches) and the final (64 matches) are **16-mech free-for-alls against other teams' bots** on new seeds, with expert house bots filling empty slots. The bot has to do well in both modes. See §5.
- **The bar:** 323 teams. At Sat 19:45 EST the leaderboard top was 6.44 and **#32 was ≈ 6.14**, with many teams packed in 5.8–6.4. It will rise. Target **≥ 7.5 practice**.
- **Code-reuse rule (new):** "excessive code reuse, another team's entry included, may result in disqualification." Write all code yourself. **Never open, read, or copy other teams' public repos.** OSS libraries and the organizer kit (wrapper, check.py) are fine.

## 2. Hard constraints

Breaking any of these gets a submission rejected, or makes the mech a sitting target. Check every one before you submit.

| Constraint | Detail |
| --- | --- |
| Packaging | Public GitHub repo with `Dockerfile` at the top level. At most 20 MB at the submitted commit. Built on linux/amd64 with the network on, in at most 10 min. |
| Reproducible build | Finalists are rebuilt later. Pin everything: the base image tag (a digest is better), the bun version, any deps, with a lockfile. No `latest` and no unpinned downloads. |
| Runtime sandbox | No network. uid 65534 (not root). Read-only filesystem except `/tmp` (64 MB). 1 CPU, 512 MB RAM with no swap, at most 128 processes and threads. The map is read-only at `hello.map.dir` (`/arena` in matches). |
| Timing | You have **50 ms** from `obs` to your answer line. Late answers are dropped: the mech coasts, then idles after 1 s. `ready` must arrive within 20 s of `hello`, and that includes container start. Target **p99 < 20 ms and max < 40 ms** inside the docker sandbox, because scorer timing varies by a few ms. |
| Protocol | stdout carries protocol JSON lines only, each under 64 KiB. Logs go to stderr. **In Bun, `console.log` writes to stdout.** Use the wrapper's `log()` (stderr) instead. Echo `tick`, answer only the newest queued obs, keep debug drawings within the caps, and exit after `end`. |
| Conformance | `kit/check/check.py` must PASS under the sandbox flags (§4). The scorer runs that same check. |
| Robustness | A crash or a hang leaves the mech idle and still scored. Never let `act()` throw out of the loop (the wrapper catches errors, so keep that). Guard every heavy computation with a time budget. |

## 3. Stack and repo layout

**Stack: TypeScript on Bun**, using the kit's `ts/mechfight.ts` wrapper (no dependencies). It was chosen over Python for per-tick speed on 1 CPU: raycasts, pathing, and position scoring all fit in a few ms. Avoid npm runtime dependencies. If you add one, vendor it with a lockfile.

Target layout (create it if it doesn't exist yet):

```
Dockerfile          # pinned oven/bun image; COPY only what the bot needs; bundle at build time
.dockerignore       # exclude kit/, sim/, runs/, tools/, *.tar.gz, *:Zone.Identifier
.gitignore          # runs/, node_modules/, *:Zone.Identifier, mechfight-kit.tar.gz, recipes.json
src/
  mechfight.ts      # kit wrapper, copied verbatim. Don't edit the generated types block.
  main.ts           # entry: run(factory). Build all state in the factory (at hello).
  world/            # map load, terrain sampler, prism spatial index, LOS raycast, nav grid/pathing
  brain/            # tracker (enemies, sounds, threats), decision/modes, movement, aiming, weapons, upgrades
  util/             # math (angles, vectors), seeded RNG, timing guard
data/               # optional: offline-precomputed map data (nav grid etc.). Keep it small.
kit/                # pristine extract of mechfight-kit.tar.gz: protocol.md, schema, check/, arena/, python/, ts/
sim/                # local approximate simulator, opponent bots, batch runner (§6)
tools/              # check-local.sh, check-docker.sh, eval scripts, precompute scripts
test/               # bun test: geometry, lead/mortar solvers, world model vs the recorded stream
LOG.md              # experiment and submission log (§8)
```

Bootstrap, if the repo isn't set up yet:
1. `mkdir kit && tar -xzf mechfight-kit.tar.gz -C kit --strip-components=1`. check.py finds the schema at `kit/mechfight.schema.json` and the map at `kit/arena` relative to its own location, so keep `kit/` intact.
2. Copy `kit/ts/mechfight.ts` to `src/`. Start `src/main.ts` from `kit/ts/example.ts`.
3. Write a Dockerfile along these lines, then verify it with the sandbox check:
   ```dockerfile
   FROM oven/bun:1.4.4-slim
   WORKDIR /bot
   COPY src/ ./src/
   COPY data/ ./data/
   RUN bun build src/main.ts --target=bun --outfile=/bot/bot.js
   ENTRYPOINT ["bun", "/bot/bot.js"]
   ```
   Without a `data/` directory, drop that COPY line. Bundling at build time avoids runtime transpiling, which matters on a read-only disk.
4. `git init` and make the first commit. (Done: the repo is `CyberCoder-bit/mech-royale-bot`, see §8.)

Notes:
- Local bun is 1.3.14 and the image uses 1.4.4. The docker sandbox check is authoritative, so run it before every submission.
- Read the map from `hello.map.dir` + `hello.map.files`. Never hardcode `/arena`: check.py run locally passes the kit path.
- The map is the same every match, so precomputing map data offline into `data/` is allowed. Spawns, loot, NPCs, and zone centers are random per match.

## 4. Commands

```sh
# fast protocol check, no docker
python3 kit/check/check.py -- bun src/main.ts

# build the image and run the real gate, the same sandbox the scorer uses
docker build --platform linux/amd64 -t mech-bot .
python3 kit/check/check.py --map-dir /arena -- docker run --rm -i --network none --cpus 1 --memory 512m \
  --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 --pids-limit 128 -v "$PWD/kit/arena:/arena:ro" mech-bot

bun test                        # unit tests
docker image ls mech-bot        # sanity-check image size
du -sh --exclude=.git .         # repo must stay well under 20 MB
```

Read the check output: `ready in N ms` (cold start, must be far below 20 000) and `answer time ms: p50/p90/p99/max`. check.py replays recorded observations and does not react to your actions. It tests protocol and timing only, not play quality.

## 5. The game, distilled for decisions

Full rules are in protocol.md §5–§11. This section covers the implications.

### Scoring dynamics: the most important section
- Your place is `obs.alive` at the moment you die. Every mech that dies before you is worth +1.
- **Practice:** the 15 house bots are one squad. They share vision and never fight each other, so they only die to you, the zone, or NPC drones. They hunt you weakest first: one hunter early, more as you thin them out, all of them late. As a result:
  - Pure hiding scores about 0. **Confirmed Sat 20:50 by a pacifist probe: 0.08.** House bots essentially never die unless we kill them, so the practice score ≈ the number of house bots we kill before we die (top teams ≈ 6.4).
  - Pure brawling dies early.
  - Scoring comes from killing the lone early hunters efficiently (easy bots first), healing to full between fights, and outlasting the rest in the final zone collapse.
- **Endgame HP race:** the last circle reaches radius 0 at about 415 s with 260 HP/s, so everyone left loses HP at the same rate and dies in order of HP. If the clock runs out, survivors rank by HP. Max HP at about 6:50 decides the win: cubes add +4% each up to 10, plating +15% ×3, and a supply drop fully heals.
- **Final (FFA):** independent bots fight each other, so waiting and third-partying are worth a lot and kills are worth little. Don't hard-code practice-squad assumptions (for example, "only one enemy hunts me early" or "visible enemies never fight each other"). Prefer behavior that wins in both modes.

### Zone timeline (defaults; read `config.zone.phases` and `obs.zone`)
| Phase | Hold (s) | Shrink (s) | Radius after | DPS outside |
| --- | --- | --- | --- | --- |
| 1 | 0–60 | 60–110 | 560 → 380 | 20 |
| 2 | 110–155 | 155–195 | 240 | 35 |
| 3 | 195–230 | 230–265 | 140 | 60 |
| 4 | 265–295 | 295–325 | 70 | 100 |
| 5 | 325–350 | 350–375 | 25 | 160 |
| 6 | 375–390 | 390–415 | 0 | 260 |

During a shrink the center and radius move linearly. `obs.zone` always shows the current circle and the next one, so plan to be inside the next circle with margin before `shrink_end`. HP doesn't regenerate outside the zone.

### Combat facts that drive behavior
- **Rear hits deal ×1.5.** The front arc is 180° around your torso yaw. Keep torso aim within ±90° of the most dangerous attacker. Legs move independently of the torso, so you can retreat while facing the threat.
- **Aim slews** at 4 rad/s yaw and 3 rad/s pitch, clamped to [-0.7, 1.3]. Shots leave along the *actual* `self.aim`. Fire only once the actual aim is within tolerance of the solution. Normalize yaw differences to (-π, π].
- **HP regen** gives 45 HP/s after 5 s without **dealing or taking** damage, and never outside the zone. Poking with the gun resets your own regen. Disengage, break line of sight from *all* known enemies (the squad shares vision), then wait.
- **Gun:** 252 m/s, 45 dmg, 0.24 s, mag 12, 2.4 s reload, range 230, spread 0.6°. Lead moving targets: solve the intercept from muzzle height (pos.z + muzzle_height, scaled by cubes) to the target's center (pos.z + 4.5 × size). Reload early during lulls.
- **Mortar:** ballistic, 72 m/s, g = 22, so pitch sets range (max ≈ 235 m at 45°). A direct hit does 200 plus up to 160 splash in 7 m, and walls block splash. Your own splash hits you at 50% and knocks you back, so never fire at anything within about 12 m. The high arc reaches targets behind cover: tracked (memory) or heard ones.
- **Laser:** hold to charge (full charge 0.75 s → 315 dmg), and it fires on release along the actual aim. You move at half speed while charging. Enemies see `charging: true`. Cook-off adds +60% against mortar holders. When an enemy with `charging` aims at you, strafe perpendicular to its line.
- **Lightning:** auto-targets the nearest target (mech, NPC, or crate) within 45 m and a 30° cone with line of sight. 60 dmg every 0.25 s (≈240 DPS) and 3 energy per shot. This is the strongest close-range weapon and needs almost no aiming. It shorts lasers.
- **Triangle:** laser > mortar > lightning > laser, and the gun is neutral. You can't hold two weapons of the same kind. A weapon you take can't fire for max(1 s, its cooldown).
- **Energy** is shared by boost (17/s), jets (15/s), and lightning (3 per shot). It regenerates at 18/s after 0.6 s without spending. Don't enter a fight with no energy.
- **Dodging:** a bullet takes about 0.4 s to cross 100 m. Lateral movement at 11.7–19.5 m/s beats the 2.5 m hit radius, so jink unpredictably when an enemy is shooting at you. Visible incoming projectiles are listed in `obs.projectiles`.

### Information
- **Vision:** 200 m inside a 120° yaw wedge around your torso aim, plus 45 m all around. Line of sight runs from eye to the target's center or top, and buildings, dense canopy, and trunks block it. Seen mechs stay tracked at their real position for 5 s. Turning to scan costs aim time.
- **Trees block sight but not shots.** Dense canopy hides you, and you can fire into trees at a heard bearing.
- **Sound:** a bearing with σ = 7° noise and a distance band near (<60 m), mid (<160 m), or far. Carry ranges: gun 320 m, mortar and explosions 420 m, laser 380 m, steps 40 m. **Walking below 5 m/s is silent**, so use `move` length ≤ 0.4 when sneaking. The weapon a sound names tells you what the shooter holds.
- `events.damaged` gives the attacker's bearing and id even when you can't see them.

### Economy
- **Cubes:** +4% HP and damage each (cap 10) and +5% size each (no cap, so you get easier to hit). Pickup radius is 3.5 m. Sources:
  - crates: 300 HP, 1 cube, 50% chance of a weapon
  - NPC drones: 350 HP, 2 cubes, but they shoot back at 25 dmg/s
  - kills: all of the victim's cubes plus 2
  - supply drops: 3 cubes plus full HP and energy for 4 s alone in the 8 m ring. They are called at 70/140/210 s and land 25 s later inside the next circle.
- **Upgrades** are offered at cube totals 1, 3, 6, 10, … Pick within 5 s or choice 0 is applied. Start with survival-first priorities (plating, armor, nanites, then gyros, servos, and upgrades for weapons you hold) and tune them in the sim.
- **Weapon pickups:** 40 floor spawns at match start, plus drops from crates and dead mechs. `take` needs ≤ 4 m horizontal and ≤ 4 m vertical distance, and failures arrive as `take_failed` events.

### Movement and map
- Walk 11.7 m/s, boost 19.5, ground accel 58.5, jump 11 m/s, jets 34 m/s² up to a 10 m/s rise. Step-up 1.2 m, max slope 50°. 100 energy climbs about 60 m, which reaches almost every roof. Walls slide you along them, and the map edge is a wall. Bounds are about x ∈ [-512, 555], y ∈ [-333, 389].
- `world.json` has 259 prisms (building, stadium, bridge) and about 1 560 trees. `terrain.i16` is a 1070×724 grid of int16 centimeters at 1 m spacing. Sample it bilinearly.
- Bridges with a base more than 9 m above the ground can be walked under.
- Build a nav grid (about 2 m cells) from terrain slope and prisms, then run A* or a flow field to the zone or other goals. Detect stuck states (commanded movement but no progress for about 1 s) and recover with jump, jets, or a re-plan.

## 6. Local simulator: the highest-leverage tool

Practice returns one noisy number per submission, at most 6 per hour, with no stderr (check the track page for any per-match detail). To iterate faster, build `sim/`: an approximate re-implementation of the server rules from protocol.md. Steps, in order:

1. **Fidelity where it matters:** movement and collision against terrain and prisms, vision (FOV, near range, LOS, 5 s memory, squad sharing), gun, mortar, laser, and lightning, rear armor, regen, zone, cubes, crates, NPCs, pickups, upgrades, drops, and sounds. Run at 20 ticks/s with a decision every 2 ticks.
2. **Run our bot through the real protocol:** a subprocess speaking JSON lines, with the 50 ms budget and coast/idle rules enforced. Run opponents in-process for speed.
3. **Two opponent modes:**
   - `squad`: house-bot imitations with shared vision and weakest-first hunter escalation, at several skill levels.
   - `ffa`: our own past versions plus simple archetypes (camper, rusher, sniper) that also fight each other, to imitate the final.
4. **Calibrate:** the kit's Python example should score about 1.15 in `squad` mode. If it doesn't, tune house-bot strength before trusting any numbers.
5. **Batch runner:** a fixed seed list, versions A/B compared on the same seeds (paired). Report mean `16 - place`, its standard error, survival time, kills, and death causes (zone, weapon, rear hits). Run matches in parallel across cores locally (this machine has 24 CPUs; the bot itself still gets only 1).
6. **Sim numbers are guidance, not truth.** Measured Sat 23:40: the calibrated sim tracks AGGRESSIVE tactics well (v2: sim 4.7, official 4.63) but over-rates DEFENSIVE ones (hiding, holding cover, peeking) by ~0.5–0.8 points (core v1: sim +0.8 over v0, official −0.38). Validate defensive gains on the real scorer. If the bot and the sim share world code (LOS, terrain), a bug in it stays invisible to the sim. Validate the sim with `kit/check/stream.jsonl.gz` (hello plus 300 real observations): grounded `self.pos.z` should match terrain or roof height, observed speeds should match the config limits, and visible mechs should pass our LOS test.

## 7. Bot architecture guidelines

- **Init (in the factory at hello):** load the map, build the spatial index and nav grid, and seed the RNG with `hello.seed`. Keep cold start under about 3 s in the sandbox.
- **Per tick:**
  1. Update the tracker: enemies with position, velocity, weapons, HP, and last-seen time; sound and damage bearings; incoming projectiles.
  2. Pick a mode: loot, rotate, engage, disengage/heal, hide, capture drop, endgame.
  3. Choose a movement goal by scoring candidate positions: cover from known threats, inside the future zone, distance to threats, and the value of cubes or pickups.
  4. Run the aim and fire solution for the best weapon.
  5. Handle pick, take, drop, and reload.
- **Budget guard:** check `performance.now()` against a soft limit of about 15 ms and skip or amortize optional work, such as path replans, at most every N ticks. Avoid per-tick allocation of large arrays, since GC pauses show up as `max` in check.py.
- **Units and frames:** x is east, y north, z up, in meters and radians. Yaw 0 points east and π/2 north. `pos` is the feet. Center of mass, eye, and muzzle heights scale with cubes, and `self.stats` has your current `eye_height` and `muzzle_height`.
- Read weapon and mech numbers from `self.weapons[i].stats` and `self.stats`, because upgrades change them. Never hard-code config values.
- Debug drawing (`draw.*`) costs bytes. Keep it small and inside the caps.

## 8. Workflow and submission discipline

- **Always keep `main` shippable.** Do experiments on branches or behind flags.
- **Definition of done for any change:** `bun test` passes, the local check passes, the docker sandbox check passes with p99 < 20 ms, and the sim A/B shows no regression in either `squad` or `ffa` mode.
- **Before every submission:**
  1. Run the docker sandbox check and get PASS.
  2. Make sure `git status` is clean.
  3. Tag the commit `vN`.
  4. Add a LOG.md entry.
  5. Push.

  A rejected build doesn't hurt the score but wastes one of the 6 hourly slots.
- **Who does what (user-approved):** the repo is public at `github.com/CyberCoder-bit/mech-royale-bot`. Only the **main session** pushes to `main` and submits, by driving the track page with Playwright MCP after the user signs in. **Sub-agents never push, never submit, never touch `main`:** they work on their own branch/worktree and report back. `main` moves only at submit time, because the scorer fetches it.
- **LOG.md format**, one row per experiment or submission:
  `| time (EST) | tag/commit | change | sim squad (mean ± se, n) | sim ffa | practice score |`
- **Milestones** (adjust them to the time left):
  - **M0:** bootstrap, sandbox PASS, push, and a first submission of a simple improved bot: zone-safe, leads its shots, faces attackers, takes weapons, picks upgrades. This proves the pipeline and puts a score above 1.15 on the board early.
  - **M1:** world model (terrain, prisms, LOS, nav) and solid combat: leading, weapon use, rear-armor facing, dodging, disengage-to-regen.
  - **M2:** the simulator, calibrated.
  - **M3:** iterate with the sim and use the submission slots every hour.
  - **Sun 00:58: the scorer was reset.** Every earlier score shows "Scored under a previous version", the board restarted (baseline now 1.13), and the final pick was cleared. Earlier official numbers below may not transfer exactly. Re-establish scores under the new version and RE-PICK the final entry.
  - **Final entry is a MANUAL PICK (since Sun 00:00):** BB-327713BA = d65b7cf (bd23fa7 salt 2 = v3 + earlySafe 15 + FFA brain, 5.22 on the new scorer). A higher-scoring submission does NOT replace a pick automatically. After any new best that contains the FFA brain, click "Pick as our final entry" on it. Before 10:45 verify the pick is the intended FFA-capable version.
  - **Sun 09:00–09:30 real A/B (all on `robust` 247f67e = d65b7cf + wrapper keeps events of collapsed obs + FFA flag from deaths only):** robust 4.95, supply drops 4.97, aggro hunting 5.06, cube/kill-spot memory 5.07, gun during laser charge 4.88, duck to cover on laser charge **4.63**. The v3 family is pinned at ~5.0 ± 0.15 whatever the tactic; defensive/evasive changes keep losing in reality (cover/peek, roof refuge, duck). Real stream: gun hits 42% at 100–150 m (sim 82%), damage taken is mostly 315-pt lasers, laser range 280 m > vision 200 m. Cut line at 09:28: #32 = 6.11; we are #129 (5.22).
  - **Freeze:** no risky changes after about 09:30 EST Sunday. Make the final submission by about 10:30 EST, and make sure the chosen submission is the one you intend (by default, the best one).
- Seeds are fixed, so a deterministic bot rescored gives nearly the same practice number. Differences between versions are real *for those 48 seeds*, which means overfitting is possible. Prefer changes that also improve sim `ffa`.

## 9. Strategy hypotheses to test, roughly by expected value

1. **Zone discipline:** reach the next circle early and in cover. Never take zone damage unless forced.
2. **Fight hygiene:** face the attacker, strafe or jink, lead shots, and fire only when aligned. Use the best weapon for the range (lightning ≤ 45 m, laser or gun at mid range, mortar over cover).
3. **Heal cycles:** after a fight, break line of sight and regen to full before re-engaging.
4. **Pick off the lone early hunter:** in practice, the first hunter is an easy bot that arrives alone. Kill it and collect its cubes.
5. **Early safe loot:** in the first ~60 s, collect the nearest slot-1 weapon, crates, and maybe an NPC drone. Each cube adds HP.
6. **Endgame HP stacking:** stay at full HP and max HP for the final collapse after about 390 s. Grab a supply drop if it's uncontested.
7. **Stealth:** move slowly (silent) when enemies are near and unaware. Use canopy and rooftops for concealment.
8. **Projectile dodging** using `obs.projectiles` and `charging` telegraphs.

## 10. External resources (public, read-only)

- **Top 16 Showdown cast:** every hour or two the organizers run 6 exhibition FFA matches among the top-16 practice bots (the final's format) and air them. `bun tools/record-cast.ts runs/cast` records the live stage feed (`wss://watch.joinbuilders.org/live`, same line format as replays) plus the show state (`/state`, with team names and showdown standings). At the 8 PM showdown, kyoto-max (practice #6) won 3 of 6 matches; practice rank barely predicted FFA rank. Observing these is scouting, not code reuse.

- **Public full-state replay** of a 16-house-bot FFA match (format `mechreplay/1`, older "mechanics-v2" rules, but close): `https://play.joinbuilders.org/replays/mechanics-v2-16.jsonl.gz`. Line 1 is a header whose `fields` describe the frame arrays (`m` = `[id,x,y,z,aim_yaw,aim_pitch,hp,energy,flags,cubes,max_hp,slot0,slot1]`, flags 1 grounded / 2 boosting / 4 laser charging), plus spawns, NPCs, crates, pickups, drops, and the zone schedule. Frames come every 2 ticks (`t` is in ticks) with `ev` events (`fire`, `hit{src,dst,amt,w}`, `impact`, `boom`, `zap`, `laser`, `charge{dur}`, `concuss`, `death{id,by}`, `cube`, `pickup`, `crate`, `weapon{op}`, `upgrade`, `drop`, `short`, `cookoff`, `end`). The last line is a per-mech result table. House archetypes seen: expert, hard, medium, brawler, sniper, thirdparty, farmer. The winner was a gun+lightning brawler with 16 cubes; the match was over by 3:30.
- **Official 3D viewer:** `https://play.joinbuilders.org/game.html?replay=<url>&debug=<comma-separated debug files>` loads any `mechreplay/1` file (gzip OK). The sim should write this format so its matches can be watched there.
- Leaderboard: `joinbuilders.org/buildathon/leaderboard`. Live quotas: `joinbuilders.org/buildathon/status`.

## 11. Common pitfalls

- Writing to stdout by accident (`console.log`) fails the conformance check.
- Writing files anywhere but `/tmp` crashes on the read-only filesystem, including caches a library writes by itself.
- Spawning Workers or many threads can hit the 128 pids limit. Keep the bot single-threaded.
- Yaw wrap-around bugs.
- Using the commanded aim instead of the actual `self.aim` when deciding to fire.
- Holding `fire` on a laser forever: it fires only on release, or on its own after 2 s at full charge.
- Trying to drop a laser while it's charging, which isn't allowed.
- Treating `obs.mechs` as all enemies. It also includes NPC drones (`kind: "npc"`).
- Assuming a listed mech is in line of sight. Mechs tracked from the 5 s memory may appear in `mechs` while out of view (check this against the recorded stream). Run your own LOS test before you rely on a shot.
- Don't commit the kit tarball, `*:Zone.Identifier` files (Windows download artifacts), or `recipes.json` (an unrelated tool file).
