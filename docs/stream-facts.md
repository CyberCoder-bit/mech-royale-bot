# Stream facts: what the kit's recorded observations show

Source: `kit/check/stream.jsonl.gz`, one real match seen from slot 3: hello, 300 obs (ticks 0–736, t 0–36.8 s), then `end` (place 13, 0 kills).
Every number below comes from `python3 -I tools/stream_facts.py`, which takes `--stream PATH` and `--arena DIR` and prints the raw report. The script uses its own simple geometry: extruded prisms, bilinear terrain, ellipsoid tree crowns, and cylinder trunks. That makes it usable to cross-check the bot's world code.

**Coverage caveat:** the stream has one enemy (id 10, gun + laser, about 55–150 m away). It has no NPCs, mortar shells, lightning, offers, supply drops, or roof standing by us. Those cases are untested here.

## 0. Cadence, fields, bookkeeping

- Obs arrive every 2 ticks: 295 of 299 steps are 2 ticks, and `t == tick/20` exactly in every obs. The recording has gaps of 590→718 (6.4 s missing), 718→722, 722→730, and 730→736, so the bot must handle `dt ≠ 0.1`.
- obs keys are exactly `type tick t alive self mechs projectiles crates cubes pickups sounds beams events zone offer drops`. Nothing appears that protocol.md doesn't list.
- `self` keys are `id pos vel aim hp max_hp energy max_energy grounded cubes upgrades weapons in_zone stats`. `self.stats` equals `config.mech` in every obs (no upgrades were taken).
- Gun slot keys are `kind cooldown stats ammo reload`. During a reload, `reload` counts down 0.1 s per obs from 2.35, with `ammo` 0.
- Mech entries always carry `id kind pos vel aim hp max_hp cubes weapons charging`. `hp` is live: it shows the enemy's damage and its regen (+4.5 per obs).
- `alive` went 16→15→14→13 at ticks 360, 454, and 498. Each time, a `death` sound (far) arrived in the same obs. We died with `alive` = 13, and `end.place` was 13, which matches the definition.
- `zone` was identical in every obs (hold phase): center (41.3, −72.8), radius 560, next (−42.12, 7.11), next radius 380, shrink 60–110, dps 20. `in_zone` was true throughout.
- The recorded `hello.map.dir` is `"../arena"`, a relative path. check.py rewrites it, so always join it with `map.files`.

## 1. Vision and the 5 s memory

**Answer: yes. `obs.mechs` includes tracked but not visible mechs for 5.0 s after the last real sighting.** Their entries carry the live `pos`, `vel`, `aim`, `hp`, and `charging`, and no field marks them as remembered.

The vision model was fitted on static objects. The stream lists 13 of them (9 pickups, 3 crates, 1 cube), and each was checked on every obs between its first and last listing (654 object-frames). Static objects are listed only while seen, so they ground-truth the model.

| Model (eye = pos.z + eye_height; target = center or top) | Agreement with listing |
| --- | --- |
| hard: (≤45 m, or ≤200 m and \|Δyaw\| ≤ 60°) and no prism or terrain on the line | 448/654 (all 206 misses: listed as hidden but predicted visible) |
| soft: hard, plus for wedge sightings a line with **crown chord < 3.96 m** and no trunk | **652/654** |

- Crown chord separates the two classes. On wedge-only, hard-clear, trunk-free lines, the chord when listed was at most **3.99 m** (n = 254). When unlisted, the smallest values were 4.03 and 4.12 m (n = 183, plus one rooftop edge case at 0). 3.96 m equals `ln(1/canopyBlockT)/canopyDensity` = ln(4)/0.35. That fits sight being blocked when `exp(-0.35 · crown_metres) < 0.25`.
- The crown model behind those numbers: an ellipsoid centered at (`crownX`, `crownY`), spanning `z+crownBase` to `z+height` vertically, with horizontal radius `crownR`. Chords are summed over all crowns on the line. The trunk is a cylinder of radius `trunkR` at (`x`, `y`) from `z` to `z+crownBase`. 23 trunk-blocked object-frames were all unlisted.
- The listing limits held. Listed static objects reached at most 199.6 m horizontal, and at most 56.7° off the aim yaw unless within 45 m. The mech was listed at up to 32.6°.

**Memory test on mech 10 (169 listed obs, 3 runs):**

| Run | Visible frames (soft model) | Last visible | Dropped from `mechs` at | Gap |
| --- | --- | --- | --- | --- |
| t 4.9–13.2 | 28/84 | t = 8.2 | t = 13.3 (obs contiguous) | **5.1 s** |
| t 18.0–26.0 | 5/81 | t = 21.2 | t = 26.1 (obs contiguous) | **4.9 s** |
| t 35.9–36.8 | 3/4 | t = 36.5 | end of stream | – |

- Under the soft model, 133 of 169 listings (79%) were memory entries. Their ages since the last sighting ranged from 0.1 to 5.0 s (median 2.0). The causes were canopy (chords of 5–64 m on a 150 m line), trunks, and buildings 26 and 27.
- The hard model alone gives nonsense drop gaps of 0.1 s and 1.3 s, so canopy matters for mechs too. The boundary jitter of ±0.1 s is one obs of sampling. The run-2 last sighting (ticks 420–424) depended only on the "top" line, so it is marginal.
- A remembered mech still shows live state. Mech 10 charged its laser, jetted to z = 20.9, regenerated HP, and shot us, all while it was out of our sight.

## 2. Movement, jets, energy, regen (self, 239 grounded obs)

- **Walk:** `|vel_xy|` is 11.70 (11.69 at spawn). The position-delta speed has a median of 11.68 (11.37–11.81, n = 109).
- **Boost:** `|vel_xy|` is 19.50, and the position-delta median is 19.47 (19.46–19.60, n = 12). The ground speed never exceeded 19.50.
- **Ground acceleration:** the maximum change in `|v|` was **58.5 m/s²**, so 0→walk takes 0.2 s and a full reversal at walk takes 0.4 s.
- **Grounded `vel[2]` is always 0** (239/239 for self and 139/139 for mech 10), even on slopes where z changes by −2.3 to +3.3 m/s. Use position deltas for vertical motion on the ground.
- **Jet rise:** `vel_z` = **8.90 m/s** while jetting, the same for self (30 obs) and mech 10 (17 obs). That is `max_rise_speed` 10 minus one tick of gravity, 22·0.05. The jump impulse is never visible: jump plus jet shows 8.9 from the first airborne obs.
  - Profile, twice: a 1.5 s jet climbed 13.35 m for 22.5 energy, about 0.59 m per energy point (≈ 59 m per 100 energy). It peaked at +14.9 m above takeoff, landed 3.1 s after takeoff (2.9 s of airborne obs), and hit the ground at −24.1 m/s.
  - Ballistic `d(vel_z)/dt` = −22.0 (15/15 samples). Air control changes horizontal speed by up to 1.2 m/s per obs (air_accel 12).
- **Energy:**
  - Boost drains **17.0/s** (73 obs). Drain continues while boost is held during braking or turning at 1–9 m/s.
  - Jets drain **15.0/s** (30 obs).
  - Regen is **18.0/s**. The first increment is always +0.9 (one tick), and regen also works in the air.
  - **Regen restarts on the 14th tick after the last spending tick** (7/7 onsets: 98→112, 128→142, 308→322, …). That is 0.65 s idle plus one tick, against the configured 0.6 s (12 ticks).
- **HP regen:** 2.25 HP per tick (45/s). It began 101 ticks (5.05 s) after the last damage event, and that event was *our own* hit at tick 270. Our next hit stopped it again, at tick 376. Dealing damage resets the timer, as documented.

## 3. Grounded z vs terrain

- Self, grounded: `z − terrain_bilinear(x,y)` runs from −0.005 to +0.006 m (239/239 within 5 mm). The `j*nx+i` bilinear sampler matches the server.
- Mech 10 with `vel_z` = 0: −0.005 to +0.005 m (139 frames). All 29 frames where mech 10 was more than 1 m above terrain were jetting or falling. There were no roofs under it.
- We never stood on a roof or under a bridge in this stream, so that case is untested for mechs.
- **Roof loot sits exactly at prism `top`.** Pickups 8001 and 8006 are at 17.41 = building 29's top, 8007 at 12.81 = building 26's top, and 8003 at 23.5 = building 30's top. Crates (3) and the cube sit at terrain height (±0.00).

## 4. Projectiles, events, sounds, beams

- **Gun bullets:** 11 distinct, 30 listings. `|vel|` = **252.00** every time, and the position-delta speed was 251.93–252.07. `d(vel_z)/dt` = 0, so bullets fly straight with no drop.
  - A bullet is listed for 1–7 obs (0.1–0.7 s), only while visible. Bullets aimed at us came in with `vel_z` −7 to −17, aimed down at us from higher ground.
  - No mortar or NPC projectiles appear in the stream.
- **Events:**
  - 13 `damaged`: 4 laser hits of 315 each (full charge) and 9 gun hits of 45. Together that is 1665 damage, and lasers were 76% of it.
  - 10 `hit`: 9 for 45 and 1 for **67.5 with `rear: true`** (45 × 1.5).
  - Both event types omit `rear` when it is false. `damaged` always carried `by` and a bearing.
- **`damaged.bearing` vs the true bearing to the attacker:** laser residuals were within 0.6° (4/4). **Gun residuals were −8.4° to +18.0°** (sd ≈ 8°, n = 9). Gun bearings appear to come from the impact point or bullet path, not the shooter.
- **`rear` checks out:**
  - None of our 13 `damaged` events was rear. In every one, the attacker was within ±21° of our aim yaw.
  - Our rear hit came from 103° off the target's aim yaw. Our non-rear hits came from at most 36° off.
- **Sounds:**
  - 82 entries in 75 obs (at most 2 per obs). By kind: gun 62, laser 6, explosion 5, death 3, crate 2, laser_charge 2, mortar 1, boost 1.
  - Keys are exactly `kind bearing dist age`, with no source id. `age` was 0.1 (72) or 0.05 (10), meaning the sound came on one of the two ticks since the last obs.
  - Against a listed source, bearing residuals had a mean of +1.3° and **sd 9.5° (n = 19)**, against `bearing_noise_deg` 7. The `dist` band was right 19/19 times (near < 60, mid < 160).
  - `laser_charge` is heard once, at charge start, and only within 140 m. At about 150 m we never heard it.
- **Beams:** 5 lasers from mech 10. The origin z minus the shooter's z was **7.00** (muzzle height). A miss draws the full 280 m range.
  - The **`charging: true` flag appears 0.80 s (8 obs) before the beam obs** for every full charge (3/3). That gives about 0.7 s to sidestep.
  - One quick 0.2 s charge missed.
  - Beams were listed even when the shooter was only remembered, because the beam's far end was in view.

## 5. Contradictions and surprises vs protocol.md

1. In §6, the `mechs` row says "Everything you can **see** right now". In fact, remembered mechs (≤ 5 s) are listed too, with live state and no flag. §8 describes this correctly, and §6 is the misleading one.
2. The canopy rule isn't specified. It fits a **total crown chord of about 4 m** (`ln(1/canopyBlockT)/canopyDensity` = 3.96 m), with trunks blocking (652/654 frames).
3. The effective jet rise speed is **8.9 m/s**, not 10 (the cap applies before the tick's gravity).
4. The energy regen delay is effectively 0.65 s; regen starts on the 14th tick after the last spending tick. HP regen starts 5.05 s after the last damage event.
5. Grounded `vel[2]` is 0 even on slopes.
6. For gun hits, `damaged.bearing` is up to 18° off the shooter. Laser bearings are exact.
7. The recorded `hello.map.dir` is relative (`../arena`), and the recording has tick gaps.

Nothing contradicts field names, units, the `t`/tick relation, speeds, drains, regen rates, ranges, or the rear multiplier.

## 6. Implications for our bot

- **Don't treat a `mechs` entry as being in line of sight.** Run our own soft visibility (§1 rule) to judge whether an enemy is in view. Run hard LOS (prisms and terrain only) to judge whether a shot can land, since trees don't stop shots.
- **Remembered enemies are perfect targets.** We get their live position for 5 s through canopy, and bullets pass through trees. Lead and keep firing at a remembered enemy that is hidden only by canopy.
- **The same rule works against us,** assuming house bots follow the same observation rules. Enemies keep our live position for 5 s after losing sight, and shots pass through trees, so canopy alone is not cover while we are remembered. Disengage behind buildings or terrain. HP regen starts 5.05 s after the last damage dealt or taken. A pursuer loses track only after 5 s with no sighting.
- Concealment is about 4 m of crown along the line, or a trunk, or a building. Per protocol, near range (45 m) ignores canopy; that case is not tested here.
- **Laser telegraph:** `charging` is visible 0.8 s before the shot. Strafe perpendicular to the shooter's aim as soon as it appears. In this match, lasers did 76% of the damage that killed us.
- **Movement constants for planning:** walk 11.7, boost 19.5, accel 58.5 m/s². Jets rise at 8.9 m/s, about 0.59 m per energy point, and 15 energy/s. Energy regen restarts on the 14th idle tick.
- Read vertical speed on the ground from position deltas, because `vel[2]` is 0 there.
- **Bearings:** for gun hits, use `damaged.by` plus the tracker rather than `damaged.bearing` (±10–18°). For sounds, assume about 9° of noise.
- Handle tick jumps (dt > 0.1) without breaking velocity estimates or timers.
