/**
 * FFA brain: drives the mech once the bot's `ffa` flag is set (mechs died that we didn't kill, so the
 * other bots fight each other: the final / qualifying format). Self-contained on purpose, so it
 * ports to any squad-mode bot through a small hook:
 *
 *   const ffaBrain = new FfaBrain(hello)            // in the factory (loads world, nav, exposure)
 *   const a = ffaBrain.tick(obs, ffa); if (a) return a   // in act(), after the ffa flag update
 *
 * tick() always updates its memory and returns null while the flag is off (or if it ever throws),
 * so the host bot keeps full control in squad mode. It also stays off if the flag first comes on
 * after FP.lateCutoff (150 s): in practice only late zone/drone deaths could set it.
 * Needs src/world (loadWorld/navFor/PathFollower; navFor is cached, so a host that already builds
 * the nav pays nothing extra) and src/expo + data/exposure.{json,bin}.
 *
 * Policy (docs/top-bots-ffa.md): top bots aim well and kill in ~5 s, so even duels are coin flips.
 * Stay unseen in low-exposure spots inside the next circle, break line of sight when seen, fight
 * only with an edge (weak or busy targets, forced close contact, better HP; always in the last
 * duel), heal in cover, kill drones that shoot us, farm crates/drones only when nobody is near, and
 * hold full HP for the endgame. Sim tools: MR_FFA="k=v,..." overrides FP, MR_FFA_TRACE=1 logs a
 * line per second (tools/ffa-deaths.py, tools/ffa-modes.py read it).
 */
import { draw, log, type ActorObs, type BotAction, type Hello, type Observation, type OfferChoice, type WeaponKind, type WeaponObs } from "../mechfight.ts"
import { loadWorld, navFor, PathFollower, type World, type NavGrid } from "../world/index.ts"
import { expo, loadExposure, type ExposureMap } from "../expo/exposure.ts"
import { aimAt, ballisticPitch, leadPoint } from "./aim.ts"
import { angDiff, clamp, dist2, dist3, rng, unit, yawTo, type V2, type V3 } from "../util/math.ts"

/** Tunables (MR_FFA="k=v,k=v" overrides them for sim experiments). */
export const FP = {
  /** never take over if the flag first comes on this late: in practice only zone/drone deaths could set it,
   *  and those come late; in sim FFA the flag comes on at 12-69 s (48 traced matches) */
  lateCutoff: 150,
  /** also take over after a single death we didn't cause before this time (0 = host flag only) */
  earlyT: 0,
  /** take over only once this many mechs died that we did not kill (our rule; a host flag set by other
   *  evidence, e.g. HP drops, is not enough), unless t >= minDeathsT */
  minDeaths: 2,
  minDeathsT: 1e9,
  /** fight instead of fleeing when our (hp x dmg) / theirs is at least this */
  fightRatio: 1.35,
  /** strike a weakened enemy (hp fraction below this) */
  weakFrac: 0.45,
  /** strike enemies that took damage from someone else within this many seconds */
  busyS: 2.5,
  /** our HP fraction needed to strike busy / weak / fresh targets */
  strikeHp: 0.6,
  strikeWeakHp: 0.4,
  /** max distance to start a strike */
  strikeRange: 170,
  /** strike healthy, unaware enemies within this range (0 = never) */
  freshRange: 0,
  freshHp: 0.9,
  /** enemies that see us within this range will engage (sim top bots: 120) */
  contactRange: 130,
  /** cover search: farthest candidate (m) */
  coverMax: 45,
  /** an enemy that saw us counts as a threat for this long (s) */
  seenHyst: 1.2,
  /** highest climb (m) a hide/zone path may use (climbs expose us; 50 = any) */
  climbCap: 3,
  /** with no cover in reach, fight back when the power ratio is above this (else run) */
  noCoverFight: 0.8,
  /** with this many alive (us included), always fight back when no cover is in reach */
  duelAlive: 2,
  /** after any threat, keep hiding at least this long (s) */
  holdS: 4,
  /** stay hidden and regenerate below this HP fraction (if the zone allows) */
  healFrac: 0.85,
  /** farm (crates, NPC drones) only if no enemy was seen within this range in the last 10 s */
  farmSafeR: 150,
  /** shoot crates within this range (0 = never) */
  farmCrateR: 45,
  /** shoot NPC drones within this range above this HP fraction (0 = only when they shoot us) */
  farmNpcR: 60,
  farmNpcHp: 0.75,
  /** supply drops (off): contest within dropRange m if no healthy idle enemy was seen within dropSafeR m
   *  of the ring in the last dropMemS s; leave to arrive dropEarlyS s before it lands. Off because no
   *  variant beat "never contest" in sim FFA (96 paired, deterministic): default -0.20 +- 0.15 (51
   *  captures; matches with a capture +0.3..0.5, failed attempts cost more), 80 m -0.02, low HP and
   *  100 m +0.05 +- 0.04, late arrival -0.06, 3rd drop only -0.11, ambush -0.12. */
  dropUse: 0,
  dropRange: 180,
  dropSafeR: 70,
  dropMemS: 10,
  dropEarlyS: 2,
  /** contest only at or below this HP fraction (a capture is a full heal), and from this match time */
  dropMaxHp: 1,
  dropMinT: 0,
  /** stand on the least exposed cell inside the ring instead of its centre */
  dropSpot: 1,
  /** drop as bait (off): from ambushLeadS s before landing until it is taken, hold a low-exposure spot
   *  ambushMinR..ambushR m from a drop within ambushRange m that has a clear shot at the ring */
  ambushUse: 0,
  ambushRange: 160,
  ambushLeadS: 12,
  ambushR: 90,
  ambushMinR: 35,
  /** loot only if no enemy was seen within this range in the last 8 s */
  lootSafeR: 120,
  /** endgame: this many alive or a next circle this small; heal to endHeal there, prefer central spots */
  endAlive: 3,
  endRadius: 70,
  endHeal: 0.95,
  endCenterMul: 3,
  /** endgame knobs (off): laser duck radius (m), stuck recovery when the zone net can't get back in,
   *  and with 3 alive let the other two finish their duel (strike only below egWaitFinish) */
  duckR: 0,
  /** keep paths off cells near low bridges once we are too tall to fit under them. With duelFresh
   *  below, 192 paired deterministic sim FFA seeds vs bd23fa7: +0.06 +- 0.03 (18 better, 4 worse),
   *  win 41% vs 33% (2nd -> 1st 18 times, 1st -> 2nd 3), top-3 63% vs 64%; zone deaths 5 -> 1 (1-96) */
  bigFix: 1,
  stuckFix: 0,
  egWait: 0,
  egWaitFinish: 0.35,
  /** final duel (2 alive): open on an unaware enemy within duelFresh m when our HP fraction is at least duelFreshHp (first shot) */
  duelFresh: 150,
  duelFreshHp: 0.5,
  duelFreshAlive: 2,
  /** outside the zone this long (s): drop everything and walk straight back in */
  outsideS: 1.0,
  /** drop a held mortar in FFA (cook-off bait against the laser meta) */
  dropMortar: 1,
  /** zone: keep this far inside the next circle */
  marginFrac: 0.3,
  marginMin: 8,
  marginMax: 45,
  /** hide spots: avoid known enemies by this radius; travel and zone-centre penalties */
  avoidR: 70,
  travelW: 0.08,
  centerW: 0.04,
  /** hide spot search radius cap (m) */
  spotSearchR: 140,
  /** re-pick the hide spot after this long en route (s; 0 = never) */
  spotEvery: 12,
  /** walk silently (move 0.4) when an enemy was seen within this range recently */
  sneakRange: 0,
  /** loot visible cubes / weapons within these ranges when safe */
  cubeRange: 60,
  weaponRange: 70,
  /** idle scan: sweep +-scanAmp rad around the watch direction */
  scanAmp: 0.75,
  /** jink period (s) */
  jinkMin: 0.35,
  jinkRand: 0.6,
  /** preferred fight range by weapon */
  prefLaser: 100,
  prefGun: 75,
  prefLight: 22,
  /** A* wall-time safety cap of the brain's follower (ms); sims set it huge so only the expansion budget binds (reproducible) */
  planMs: 12,
  /** run a synchronous full GC at the end of the constructor (before ready) */
  initGc: 1,
  /** debug label */
  label: 1,
}

const env = (globalThis as any).process?.env?.MR_FFA as string | undefined
if (env)
  for (const kv of env.split(",")) {
    const [k, v] = kv.split("=")
    if (k && k in FP && v !== undefined) (FP as any)[k] = parseFloat(v)
  }

const TRACE = !!(globalThis as any).process?.env?.MR_FFA_TRACE

const UPGRADES = [
  "plating", "armor", "nanites", "laser_damage", "gun_damage", "gun_rate", "laser_charge", "lightning_efficiency",
  "gyros", "gun_mag", "sensors", "gun_velocity", "servos", "reactor", "capacitor", "jets", "lightning_range",
  "lightning_chain", "laser_pierce", "mortar_reload", "mortar_velocity", "mortar_splash",
]
const WEAPON_PREF: WeaponKind[] = ["laser", "lightning", "mortar"]

type Track = {
  id: number
  pos: V3
  vel: V3
  aim: V2
  hp: number
  maxHp: number
  cubes: number
  weapons: string[]
  charging: boolean
  /** last time listed in obs.mechs (live position) */
  seenT: number
  firstT: number
  /** last time its HP dropped without our hit (someone else is fighting it) */
  busyT: number
  /** last time it damaged us, and how much in the last few seconds */
  hitUsT: number
  hitUsDmg: number
  /** last time our visibility model said it could see us */
  seenUsT: number
}

type Mode = "hide" | "move" | "heal" | "loot" | "strike" | "fight" | "flee" | "end"

export class FfaBrain {
  world: World | null = null
  nav: NavGrid | null = null
  ex: ExposureMap | null = null
  follow: PathFollower | null = null
  active = false
  since = -1
  failed = 0
  rand: () => number
  cfg: Hello["config"]
  spc: number
  tracks = new Map<number, Track>()
  kills = 0
  lastHurtT = -99
  lastDealtT = -99
  hurtBearing: number | null = null
  sounds: { kind: string; bearing: number; dist: string; t: number }[] = []
  spot: { x: number; y: number; z: number; t: number; key: string } | null = null
  cover: { x: number; y: number; z: number; t: number } | null = null
  mode: Mode = "hide"
  jinkSign = 1
  jinkUntil = 0
  scanPhase = 0
  laserIdleSince = -1
  killDrop: { x: number; y: number; z: number; t: number } | null = null
  lastHp = 0
  holdUntil = -1
  outsideSince = -1
  prog = { key: "", d: 1e9, t: 0 }
  badSpots: { x: number; y: number; t: number }[] = []
  stuckSpots = 0
  fstate = ""
  msSum = 0
  msN = 0
  msMax = 0
  myHits = new Set<number>()
  npcHitT = new Map<number, number>()
  // stats for tools
  modeTime: Record<string, number> = {}

  bid = 0
  totalMechs = 16
  constructor(hello: Hello) {
    this.cfg = hello.config
    this.totalMechs = Number(hello.config.match?.mechs ?? 16)
    this.bid = Number(hello.seed) % 100000
    this.rand = rng((Number(hello.seed) || 1) ^ 0x5f3759df)
    this.spc = Number((hello.config.cubes as Record<string, unknown>).size_per_cube ?? 0.05)
    this.scanPhase = this.rand() * Math.PI * 2
    try {
      this.world = loadWorld(hello.map.dir, hello.map.files)
      this.nav = navFor(this.world)
      this.follow = new PathFollower(this.nav)
      // deterministic A* budget (expansions; the wall-time cap is only a safety net) for reproducible sims
      this.follow.planMs = FP.planMs
      ;(this.follow as unknown as { planExpand?: number }).planExpand = 2000
      // nodes with little free height above them (under bridges): mechs grown by cubes don't fit
      const nav = this.nav
      for (let v = 0; v < nav.N; v++) if (nav.st[v] === 1 && nav.ceil[v] < 20) this.lowNodes.push({ c: v >> 1, ceil: nav.ceil[v] })
    } catch (e) {
      log(`[ffa] world/nav unavailable: ${(e as Error).message}`)
    }
    try {
      loadExposure()
      this.ex = expo()
    } catch (e) {
      log(`[ffa] exposure unavailable: ${(e as Error).message}`)
    }
    try {
      this.warmMs = this.warm()
    } catch (e) {
      log(`[ffa] warmup failed: ${(e as Error).message}`)
    }
    // collect the init garbage (map parsing, warm-ups) now, before `ready`, instead of as a long GC
    // pause during the first ticks of the match
    try {
      const B = (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun
      if (FP.initGc && B?.gc) B.gc(true)
    } catch {}
  }
  warmMs = 0

  /** JIT-warm the per-tick paths at hello (raycasts, nav queries, spot search, A*) so tick 1 isn't slow. */
  private warm(): number {
    const t0 = performance.now()
    const w = this.world, nav = this.nav, ex = this.ex
    if (!w || !nav) return 0
    const cx = (w.minX + w.maxX) / 2, cy = (w.minY + w.maxY) / 2
    const r = rng(12345)
    let acc = 0
    for (let i = 0; i < 400; i++) {
      const ax = cx + (r() - 0.5) * 600, ay = cy + (r() - 0.5) * 400
      const bx = ax + (r() - 0.5) * 200, by = ay + (r() - 0.5) * 200
      const az = w.groundZ(ax, ay) + 7, bz = w.groundZ(bx, by) + 4.5
      if (w.shotClear([ax, ay, az], [bx, by, bz])) acc++
      if (w.sightClear([ax, ay, az + 1], [bx, by, bz], i % 2 === 0)) acc++
      const n = nav.nodeAt(bx, by, bz)
      if (n >= 0 && nav.lineWalkable(ax, ay, az - 7, bx, by, 50)) acc++
    }
    if (ex) {
      for (let k = 0; k < 3; k++) {
        const sp = ex.bestSpots([cx + 40 * k, cy - 30 * k], 380 - 100 * k, 6, {
          avoid: [[cx, cy]],
          avoidRadius: 70,
          minSpacing: 16,
          penalty: (x, y) => Math.hypot(x - cx, y - cy) / 1000,
        })
        acc += sp.length
      }
    }
    // warm our own follower (a throwaway one would leave ~6 MB of A* scratch as garbage), then reset it
    const f = this.follow
    if (f) {
      for (let k = 0; k < 2; k++) {
        const sx = cx - 150 + 60 * k, sy = cy + 20, tx = cx + 120, ty = cy - 60
        f.setGoal(tx, ty, w.groundZ(tx, ty), 2.5, 6, 3)
        f.update({ t: k * 10, pos: [sx, sy, w.groundZ(sx, sy)], vel: [0, 0, 0], grounded: true, energy: 100 })
      }
      f.clear()
    }
    if (acc < 0) log("[ffa] warm: impossible")
    return performance.now() - t0
  }

  /** Update memory every tick; return an action only while FFA mode is active. */
  tick(obs: Observation, flag: boolean): BotAction | null {
    try {
      this.observe(obs)
      // faster than the host's flag: one death we didn't cause before earlyT can't happen in practice
      // (house bots never shoot each other; zone and drones can't kill a full mech that early)
      const early = FP.earlyT > 0 && obs.t < FP.earlyT && this.totalMechs - obs.alive - this.kills >= 1
      if (!(flag || early) || this.failed > 20) return null
      // optionally let the host bot keep playing the opening until more of the field is gone
      if (!this.active && FP.minDeaths > 0 && this.totalMechs - obs.alive - this.kills < FP.minDeaths && obs.t < FP.minDeathsT) return null
      if (!this.active) {
        if (obs.t > FP.lateCutoff) return null
        this.active = true
        this.since = obs.t
      }
      const t0 = performance.now()
      const a = this.decide(obs)
      const ms = performance.now() - t0
      this.msSum += ms
      this.msN++
      if (ms > this.msMax) this.msMax = ms
      this.modeTime[this.mode] = (this.modeTime[this.mode] ?? 0) + 0.1
      if (TRACE && this.msN % 300 === 0) log(`[ffa ${obs.self.id} ${this.bid}] timing avg ${(this.msSum / this.msN).toFixed(2)} ms max ${this.msMax.toFixed(1)} ms n ${this.msN} modes ${JSON.stringify(this.modeTime)}`)
      return a
    } catch (e) {
      this.failed++
      if (this.failed <= 3) log(`[ffa] error at t=${obs.t}: ${(e as Error).stack ?? e}`)
      return null
    }
  }

  // ------------------------------------------------------------------ memory
  private observe(obs: Observation) {
    const t = obs.t
    this.myHits.clear()
    for (const ev of obs.events ?? []) {
      if (ev.type === "damaged") {
        if (ev.by !== null && ev.by !== undefined) {
          this.lastHurtT = t
          this.hurtBearing = ev.bearing ?? null
          const tr = this.tracks.get(ev.by)
          if (tr) {
            if (t - tr.hitUsT > 4) tr.hitUsDmg = 0
            tr.hitUsT = t
            tr.hitUsDmg += ev.amount
            // not in view: re-estimate its position along the damage bearing (live data overrides below)
            if (t - tr.seenT > 0.5 && ev.bearing !== null && ev.bearing !== undefined) {
              const P = obs.self.pos
              const dPrev = dist2(P, tr.pos)
              const off = Math.abs(angDiff(yawTo(P, tr.pos), ev.bearing))
              if (off > 0.3 || dPrev > 230) {
                const dEst = estRange(ev.weapon, dPrev)
                tr.pos = [P[0] + Math.cos(ev.bearing) * dEst, P[1] + Math.sin(ev.bearing) * dEst, P[2]]
              }
            }
          } else if (ev.by < 100) {
            const nt = this.newTrack(ev.by, t, obs, ev.bearing ?? 0)
            const dEst = estRange(ev.weapon, 80)
            const P = obs.self.pos
            nt.pos = [P[0] + Math.cos(ev.bearing ?? 0) * dEst, P[1] + Math.sin(ev.bearing ?? 0) * dEst, P[2]]
            nt.hitUsT = t
            nt.hitUsDmg = ev.amount
            this.tracks.set(ev.by, nt)
          }
        } else if (ev.weapon !== "zone") this.lastHurtT = t
        if (ev.weapon === "npc" && ev.by !== null && ev.by !== undefined) this.npcHitT.set(ev.by, t)
      } else if (ev.type === "hit") {
        this.lastDealtT = t
        this.myHits.add(ev.target)
      } else if (ev.type === "kill") {
        this.kills++
        const tr = this.tracks.get(ev.target)
        if (tr) this.killDrop = { x: tr.pos[0], y: tr.pos[1], z: tr.pos[2], t }
        this.tracks.delete(ev.target)
      }
    }
    const myId = obs.self.id
    for (const m of obs.mechs) {
      if (m.kind !== "mech" || m.id === myId) continue
      let tr = this.tracks.get(m.id)
      if (!tr) {
        tr = this.newTrack(m.id, t, obs, 0)
        this.tracks.set(m.id, tr)
      }
      const hp = m.hp ?? tr.hp
      if (tr.seenT >= t - 0.35 && hp < tr.hp - 1 && !this.myHits.has(m.id)) tr.busyT = t
      tr.pos = [m.pos[0], m.pos[1], m.pos[2]]
      tr.vel = [m.vel[0], m.vel[1], m.vel[2]]
      tr.aim = [m.aim[0], m.aim[1]]
      tr.hp = hp
      tr.maxHp = m.max_hp ?? tr.maxHp
      tr.cubes = m.cubes ?? 0
      tr.weapons = (m.weapons ?? []) as string[]
      tr.charging = !!m.charging
      tr.seenT = t
    }
    // beams fired by someone at someone else: that shooter is busy
    for (const b of obs.beams ?? []) {
      const tr = this.tracks.get(b.by)
      if (!tr || !b.path?.length) continue
      const end = b.path[b.path.length - 1]
      if (dist2(end, obs.self.pos) > 15) tr.busyT = t
    }
    for (const s of obs.sounds ?? []) {
      if (s.kind === "gun" || s.kind === "laser" || s.kind === "mortar" || s.kind === "lightning" || s.kind === "explosion")
        this.sounds.push({ kind: s.kind, bearing: s.bearing, dist: s.dist, t: t - (s.age ?? 0) })
    }
    while (this.sounds.length && (this.sounds.length > 40 || this.sounds[0].t < t - 12)) this.sounds.shift()
    // forget dead or long-gone tracks
    for (const [id, tr] of this.tracks) if (t - Math.max(tr.seenT, tr.hitUsT) > 45) this.tracks.delete(id)
  }

  private newTrack(id: number, t: number, obs: Observation, bearing: number): Track {
    const P = obs.self.pos
    // unknown attacker: place it 80 m out along the damage bearing
    const pos: V3 = [P[0] + Math.cos(bearing) * 80, P[1] + Math.sin(bearing) * 80, P[2]]
    return { id, pos, vel: [0, 0, 0], aim: [bearing + Math.PI, 0], hp: 1400, maxHp: 1400, cubes: 0, weapons: [], charging: false, seenT: -99, firstT: t, busyT: -99, hitUsT: -99, hitUsDmg: 0, seenUsT: -99 }
  }

  // ------------------------------------------------------------------ geometry helpers
  private scale(cubes: number) {
    return 1 + this.spc * (cubes ?? 0)
  }
  private centerOf(tr: { pos: ArrayLike<number>; cubes: number }): V3 {
    return [tr.pos[0], tr.pos[1], tr.pos[2] + 4.5 * this.scale(tr.cubes)]
  }

  /** Could this enemy see a mech standing at feet position p (our size)? */
  private seesPoint(tr: Track, p: ArrayLike<number>, myScale: number): boolean {
    const w = this.world!
    const s = this.scale(tr.cubes)
    const eye: V3 = [tr.pos[0], tr.pos[1], tr.pos[2] + 8 * s]
    const c: V3 = [p[0], p[1], p[2] + 4.5 * myScale]
    const top: V3 = [p[0], p[1], p[2] + 9 * myScale - 0.2]
    const d = dist3(eye, c)
    const vis = this.cfg.vision
    if (d <= (vis.near_range ?? 45)) return w.sightClear(eye, c, false) || w.sightClear(eye, top, false)
    if (d > (vis.range ?? 200)) return false
    const half = (((vis.fov_deg ?? 120) / 2) * Math.PI) / 180
    if (Math.abs(angDiff(tr.aim[0], yawTo(tr.pos, p))) > half + 0.05) return false
    return w.sightClear(eye, c, true) || w.sightClear(eye, top, true)
  }

  /** Could this enemy's shot reach a mech at feet position p (buildings/terrain only)? */
  private shotReaches(tr: Track, p: ArrayLike<number>, myScale: number): boolean {
    const s = this.scale(tr.cubes)
    const mz: V3 = [tr.pos[0], tr.pos[1], tr.pos[2] + 7 * s]
    const w = this.world!
    return w.shotClear(mz, [p[0], p[1], p[2] + 4.5 * myScale]) || w.shotClear(mz, [p[0], p[1], p[2] + 8.5 * myScale])
  }

  // ------------------------------------------------------------------ decision
  private decide(obs: Observation): BotAction {
    const t = obs.t
    const me = obs.self
    const P = me.pos as V3
    const st = me.stats ?? {}
    const myScale = this.scale(me.cubes)
    const act: BotAction = {}
    const fire: [boolean, boolean] = [false, false]
    const hpFrac = me.hp / Math.max(1, me.max_hp)
    const muzzle: V3 = [P[0], P[1], P[2] + (st.muzzle_height ?? 7 * myScale)]
    const slotOf = (k: WeaponKind) => me.weapons.findIndex((w) => w?.kind === k)
    const gunS = slotOf("gun"), laserS = slotOf("laser"), lightS = slotOf("lightning"), mortarS = slotOf("mortar")
    const gunW = gunS >= 0 ? me.weapons[gunS]! : null
    const laserW = laserS >= 0 ? me.weapons[laserS]! : null
    const lightW = lightS >= 0 ? me.weapons[lightS]! : null
    const mortarW = mortarS >= 0 ? me.weapons[mortarS]! : null
    const w = this.world!

    if (obs.offer && obs.offer.choices?.length) act.pick = pickUpgrade(obs.offer.choices)

    // ---- zone
    const z = obs.zone
    const nc = z.next_center as V2, nr = z.next_radius
    const margin = nr < 1 ? 0 : clamp(nr * FP.marginFrac, FP.marginMin, FP.marginMax)
    const safeR = nr < 1 ? 3 : Math.max(4, nr - margin)
    const dNext = dist2(P, nc)
    const outside = !me.in_zone
    const shrinkSoon = t > z.shrink_start - Math.max(0, dNext - safeR) / 9 - 20
    const zoneUrgent = outside || (dNext > safeR && shrinkSoon) || (dist2(P, z.center) > z.radius - 6)

    // ---- threats
    type E = { tr: Track; d: number; sees: boolean; aimAt: boolean; canHit: boolean; weHit: boolean; fresh: boolean }
    const E: E[] = []
    for (const tr of this.tracks.values()) {
      const fresh = tr.seenT >= t - 0.01
      if (!fresh && t - tr.hitUsT > 3) continue
      const d = dist3(P, tr.pos)
      if (d > 320) continue
      const bearingToUs = yawTo(tr.pos, P)
      const aimTol = Math.max(0.1, Math.atan2(6, d))
      const aimAtUs = fresh && Math.abs(angDiff(tr.aim[0], bearingToUs)) < aimTol
      const sees = fresh ? this.seesPoint(tr, P, myScale) : true
      if (sees && fresh) tr.seenUsT = t
      const canHit = fresh ? this.shotReaches(tr, P, myScale) : true
      const weHit = fresh && w.shotClear(muzzle, this.centerOf(tr))
      E.push({ tr, d, sees, aimAt: aimAtUs, canHit, weHit, fresh })
    }
    const recentHit = (e: E) => t - e.tr.hitUsT < 3
    // enemies engaging (or about to engage) us; seen-us has a short memory so modes don't flicker
    let threats = E.filter((e) => recentHit(e) || (e.fresh && t - e.tr.seenUsT < FP.seenHyst && (e.d < FP.contactRange || (e.aimAt && e.d < 230))))
    // the zone comes first: while it forces a move, only enemies actually hitting us change the plan
    let watch: E | null = null
    if (zoneUrgent) {
      const calm = threats.filter((e) => !recentHit(e))
      if (calm.length) watch = calm.reduce((a, b) => (a.d < b.d ? a : b))
      threats = threats.filter((e) => recentHit(e))
    }
    // laser telegraph: an enemy charging while pointing at us
    const laserThreat = E.find((e) => e.tr.charging && e.aimAt && e.canHit && e.d < 285)

    // ---- choose what to do
    let target: E | null = null
    let mode: Mode = "hide"
    const myPower = me.hp * (1 + 0.04 * Math.min(me.cubes, 10))
    const power = (e: E) => e.tr.hp * (1 + 0.04 * Math.min(e.tr.cubes, 10))
    if (threats.length) {
      // main threat: who hurt us most recently, else the closest that aims at us
      threats.sort((a, b) => threatScore(a, t) - threatScore(b, t))
      const main = threats[0]
      let theirs = 0
      for (const e of threats) if (e.canHit) theirs += power(e)
      if (theirs <= 0) theirs = power(main)
      const ratio = myPower / Math.max(1, theirs)
      const closeLight = !!lightW && main.d < (lightW.stats.range ?? 45) * 0.9 && me.energy > 20
      const cover = this.findCover(P, threats, t, myScale, zoneUrgent ? nc : null, safeR)
      // last duel (two left): with no cover, running only gives the enemy free shots
      const forced = (!cover && (ratio > FP.noCoverFight || obs.alive <= FP.duelAlive)) || main.d < 20
      const weakMain = main.tr.hp / Math.max(1, main.tr.maxHp) < FP.weakFrac && ratio > 0.7
      target = main.fresh ? main : threats.find((e) => e.fresh) ?? null
      mode = ratio >= FP.fightRatio || closeLight || forced || weakMain ? "fight" : "flee"
      // can't see who is hitting us: get behind cover against where it should be
      if (!target && cover) mode = "flee"
      this.holdUntil = t + FP.holdS
    } else {
      // opportunities: weak or busy enemies we can hit
      let best: E | null = null
      let bestS = Infinity
      for (const e of E) {
        if (!e.fresh || !e.weHit || e.d > FP.strikeRange) continue
        const f = e.tr.hp / Math.max(1, e.tr.maxHp)
        const weak = f < FP.weakFrac && hpFrac >= FP.strikeWeakHp
        let busy = t - e.tr.busyT < FP.busyS && hpFrac >= FP.strikeHp
        if (busy && FP.egWait && obs.alive === 3 && f >= FP.egWaitFinish) busy = false
        const freshOk = (FP.freshRange > 0 && e.d < FP.freshRange && hpFrac >= FP.freshHp && !e.aimAt) ||
          (FP.duelFresh > 0 && obs.alive <= FP.duelFreshAlive && e.d < FP.duelFresh && hpFrac >= FP.duelFreshHp && !e.aimAt)
        if (!weak && !busy && !freshOk) continue
        const s = e.d / 100 + f * 1.5 - (busy ? 0.4 : 0)
        if (s < bestS) (bestS = s), (best = e)
      }
      if (best) {
        mode = "strike"
        target = best
      }
    }
    // NPC drones shooting at us, or free cubes (crates, drones) when nobody is around
    let farm: { at: V3; vel: V3; id: number; d: number; npc: boolean } | null = null
    if (!target && !threats.length) {
      const calm = !this.recentEnemyWithin(P, FP.farmSafeR, t, 10) && !zoneUrgent
      let bd = Infinity
      for (const m of obs.mechs) {
        if (m.kind !== "npc") continue
        const d = dist3(P, m.pos)
        const at: V3 = [m.pos[0], m.pos[1], m.pos[2] + 1.75]
        const hitUs = t - (this.npcHitT.get(m.id) ?? -99) < 4
        const want = hitUs || (calm && hpFrac > FP.farmNpcHp && d < FP.farmNpcR)
        if (!want || d > 200 || d - (hitUs ? 100 : 0) >= bd) continue
        if (!w.shotClear(muzzle, at)) continue
        bd = d - (hitUs ? 100 : 0)
        farm = { at, vel: [m.vel[0], m.vel[1], 0], id: m.id, d, npc: true }
      }
      if (!farm && calm && hpFrac > 0.5 && FP.farmCrateR > 0) {
        for (const c of obs.crates ?? []) {
          const d = dist3(P, c.pos)
          if (d > FP.farmCrateR || d >= bd) continue
          const at: V3 = [c.pos[0], c.pos[1], c.pos[2] + 1.2]
          if (!w.shotClear(muzzle, at)) continue
          bd = d
          farm = { at, vel: [0, 0, 0], id: c.id, d, npc: false }
        }
      }
    }

    // ---- aim + fire at target
    let desired: [number, number] | null = null
    let tDist = Infinity
    let primary = "gun"
    if (target && target.fresh && (mode === "fight" || mode === "strike" || mode === "flee")) {
      const tr = target.tr
      const c = this.centerOf(tr)
      const v = tr.vel
      tDist = dist3(muzzle, c)
      const clear = target.weHit
      const lightRange = (lightW?.stats.range ?? 45) * 0.92
      const laserRange = (laserW?.stats.range ?? 280) * 0.97
      const lightReady = !!lightW && me.energy >= (lightW.stats.energy ?? 3) + 4
      const laserCharging = !!laserW && (laserW.charge ?? 0) > 0
      const laserReady = !!laserW && (laserCharging || laserW.cooldown < 0.35)
      if (lightReady && tDist < lightRange) primary = "lightning"
      else if (laserReady && tDist < laserRange) primary = "laser"
      else if (mortarW && mortarW.cooldown < 0.2 && tDist > 30 && tDist < 220 && !lightW) primary = "mortar"
      if (laserCharging && primary !== "laser" && tDist < laserRange) primary = "laser"
      const gunSpeed = gunW?.stats.speed ?? 252
      const gunSol = leadPoint(muzzle, c, [v[0], v[1], v[2] * 0.3], gunSpeed)
      const gunAim = aimAt(muzzle, gunSol.at)
      if (primary === "mortar") {
        const sp = mortarW!.stats.speed ?? 72, g = mortarW!.stats.gravity ?? 22
        const tube: V3 = [P[0], P[1], P[2] + 9.5 * myScale]
        let aimPt: V3 = [tr.pos[0], tr.pos[1], tr.pos[2] + 0.5]
        let sol = null as ReturnType<typeof ballisticPitch>
        for (let k = 0; k < 3; k++) {
          sol = ballisticPitch(dist2(tube, aimPt), aimPt[2] - tube[2], sp, g, false)
          if (!sol) break
          aimPt = [tr.pos[0] + v[0] * sol.t, tr.pos[1] + v[1] * sol.t, tr.pos[2] + 0.5]
        }
        if (sol) desired = [yawTo(tube, aimPt), sol.pitch]
        else primary = "gun"
      }
      if (primary === "laser" || primary === "lightning") desired = aimAt(muzzle, [c[0] + v[0] * 0.1, c[1] + v[1] * 0.1, c[2] + v[2] * 0.05])
      if (primary === "gun" || !desired) desired = gunAim
      const ay = me.aim[0], ap = me.aim[1]
      const radius = 2.5 * this.scale(tr.cubes)
      const yawTol = Math.max(0.012, Math.atan2(radius * 0.8, tDist))
      const pitchTol = Math.max(0.015, Math.atan2(3.5, tDist))
      const gunOk = Math.abs(angDiff(ay, gunAim[0])) < yawTol && Math.abs(ap - gunAim[1]) < pitchTol
      if (gunW && gunS >= 0 && clear && gunW.reload === 0 && (gunW.ammo ?? 1) > 0 && tDist < (gunW.stats.range ?? 230) * 0.98 && gunOk) fire[gunS] = true
      if (lightW && lightS >= 0 && primary === "lightning") {
        const cone = ((lightW.stats.cone_deg ?? 30) * Math.PI) / 180
        if (Math.abs(angDiff(ay, yawTo(P, tr.pos))) < cone * 0.4) fire[lightS] = true
      }
      if (laserW && laserS >= 0) {
        const full = laserW.stats.charge ?? 0.75
        const charge = laserW.charge ?? 0
        const ok = clear && !!desired && Math.abs(angDiff(ay, desired[0])) < yawTol && Math.abs(ap - desired[1]) < pitchTol
        if (primary === "laser") {
          if (charge <= 0) fire[laserS] = laserW.cooldown <= 0.05 && Math.abs(angDiff(ay, desired![0])) < 0.5
          else if (charge < full - 0.02) fire[laserS] = true
          else fire[laserS] = !ok
        } else if (charge > 0) fire[laserS] = !ok
        this.laserIdleSince = -1
      }
      if (mortarW && mortarS >= 0 && primary === "mortar" && desired && tDist > 25) {
        if (Math.abs(angDiff(ay, desired[0])) < 0.03 && Math.abs(ap - desired[1]) < 0.03) fire[mortarS] = true
      }
    } else if (farm) {
      const gunSpeed = gunW?.stats.speed ?? 252
      const sol = leadPoint(muzzle, farm.at, farm.vel, gunSpeed)
      desired = aimAt(muzzle, sol.at)
      const dd = dist3(muzzle, farm.at)
      const ok = Math.abs(angDiff(me.aim[0], desired[0])) < Math.max(0.015, Math.atan2(1.2, dd)) && Math.abs(me.aim[1] - desired[1]) < Math.max(0.02, Math.atan2(1.2, dd))
      if (ok && gunW && gunS >= 0 && gunW.reload === 0 && (gunW.ammo ?? 1) > 0 && dd < (gunW.stats.range ?? 230) * 0.95) fire[gunS] = true
      if (ok && lightW && lightS >= 0 && dd < (lightW.stats.range ?? 45) * 0.9 && me.energy > 40) fire[lightS] = true
      if (laserW && laserS >= 0 && (laserW.charge ?? 0) > 0) fire[laserS] = !ok
    } else if (laserW && laserS >= 0 && (laserW.charge ?? 0) > 0) {
      if (this.laserIdleSince < 0) this.laserIdleSince = t
      fire[laserS] = t - this.laserIdleSince < 1.0
    }

    // ---- movement
    let move: V2 = [0, 0]
    let boost = false
    let jump = false
    if (t > this.jinkUntil) {
      this.jinkSign = -this.jinkSign
      this.jinkUntil = t + FP.jinkMin + this.rand() * FP.jinkRand
    }
    const hasFollow = !!this.follow && !!this.nav
    const goTo = (x: number, y: number, zz: number, fast: boolean, tol = 2.5, replan = 6): boolean => {
      if (!hasFollow) {
        move = unit(yawTo(P, [x, y]))
        boost = fast && me.energy > 25
        return dist2(P, [x, y]) < tol
      }
      this.follow!.setGoal(x, y, zz, tol, replan, this.stuckSpots > 1 ? 50 : FP.climbCap)
      const o = this.follow!.update({ t, pos: P, vel: me.vel, grounded: me.grounded, energy: me.energy })
      this.fstate = o.state + (o.steer ? `@${o.steer[0] | 0},${o.steer[1] | 0},${o.steer[2] | 0}` : "")
      move = o.move
      jump = o.jump
      boost = o.boost || (fast && me.energy > 25 && me.grounded && Math.hypot(o.move[0], o.move[1]) > 0.5)
      return o.arrived
    }

    if (mode === "fight" && target) {
      const tr = target.tr
      const d = dist2(P, tr.pos)
      const toT = unit(yawTo(P, tr.pos))
      const perp: V2 = [-toT[1] * this.jinkSign, toT[0] * this.jinkSign]
      const pref = primary === "lightning" ? FP.prefLight : primary === "laser" ? FP.prefLaser : lightW ? 35 : FP.prefGun
      const radial = clamp((d - pref) / Math.max(20, pref * 0.5), -1, 1)
      const zp: V2 = zoneUrgent ? unit(yawTo(P, nc)) : [0, 0]
      move = norm2([toT[0] * radial * 0.7 + perp[0] + zp[0] * 1.5, toT[1] * radial * 0.7 + perp[1] + zp[1] * 1.5])
      boost = (outside || primary === "lightning") && me.energy > 35
      if (this.follow) this.follow.clear()
    } else if (mode === "fight" && !target) {
      // hurt by someone we can't see: jink across the damage bearing toward cover
      const by = this.hurtBearing ?? me.aim[0]
      const toB = unit(by)
      move = [-toB[1] * this.jinkSign, toB[0] * this.jinkSign]
    } else if (mode === "flee") {
      const cv = this.cover
      if (cv) {
        goTo(cv.x, cv.y, cv.z, true, 1.5, 1)
        boost = me.energy > 15 && me.grounded && Math.hypot(move[0], move[1]) > 0.5
      } else {
        // no cover in reach: run away from the threats (toward the zone when it matters)
        let ax = 0, ay = 0
        for (const e of threats) {
          const u = unit(yawTo(e.tr.pos, P))
          const wgt = 1 / Math.max(20, e.d)
          ax += u[0] * wgt
          ay += u[1] * wgt
        }
        let away = norm2([ax, ay])
        if (zoneUrgent || dist2(P, nc) > safeR) {
          const zp = unit(yawTo(P, nc))
          away = norm2([away[0] + zp[0] * 1.2, away[1] + zp[1] * 1.2])
        }
        // best walkable direction close to "away" (a straight run into a wall is a sitting target)
        let bestDir: V2 = away
        if (this.nav) {
          let bs = -Infinity
          const ay0 = Math.atan2(away[1], away[0])
          for (let k = 0; k < 16; k++) {
            const a = ay0 + ((k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.PI) / 8
            const u = unit(a)
            if (!this.nav.lineWalkable(P[0], P[1], P[2], P[0] + u[0] * 14, P[1] + u[1] * 14, 20)) continue
            const sc = u[0] * away[0] + u[1] * away[1]
            if (sc > bs) (bs = sc), (bestDir = u)
          }
        }
        const perp: V2 = [-bestDir[1] * this.jinkSign * 0.4, bestDir[0] * this.jinkSign * 0.4]
        move = norm2([bestDir[0] + perp[0], bestDir[1] + perp[1]])
        boost = me.energy > 15 && me.grounded
        if (this.follow) this.follow.clear()
      }
    } else if (mode === "strike" && target) {
      // hold still-ish where we are (we are usually in cover); small sidesteps when they look at us
      if (target.aimAt) {
        const toT = unit(yawTo(P, target.tr.pos))
        move = [-toT[1] * this.jinkSign * 0.8, toT[0] * this.jinkSign * 0.8]
      }
      if (this.follow) this.follow.clear()
    } else {
      // no fight: zone, loot, hide, heal
      mode = "hide"
      const spot = this.chooseSpot(obs, P, nc, safeR, nr, zoneUrgent)
      let goal: { x: number; y: number; z: number } | null = spot
      let fast = zoneUrgent && (outside || dNext - safeR > 60)
      // recently in a fight, or hurt: stay out of every recent enemy's line of fire and regenerate
      const recent: Track[] = []
      for (const tr of this.tracks.values()) if (t - tr.seenT < 10 && dist2(P, tr.pos) < 230) recent.push(tr)
      const endgame = obs.alive <= FP.endAlive || nr <= FP.endRadius
      const lying = !zoneUrgent && (t < this.holdUntil || (hpFrac < FP.healFrac && t - this.lastHurtT < 40) || (endgame && hpFrac < FP.endHeal))
      if (lying) {
        mode = "heal"
        const th = recent.map((tr) => ({ tr, fresh: false, canHit: this.shotReaches(tr, P, myScale) }))
        const cv = th.length ? this.findCover(P, th, t, myScale, nc, safeR) : null
        goal = cv && dist2(P, [cv.x, cv.y]) > 1.5 ? cv : { x: P[0], y: P[1], z: P[2] }
        fast = false
      }
      // loot when nothing threatens us
      const safeLoot = !lying && !zoneUrgent && !this.recentEnemyWithin(P, FP.lootSafeR, t, 8)
      const loot = safeLoot ? this.lootGoal(obs, P, nc, safeR, hpFrac) : null
      if (loot) {
        goal = loot
        mode = "loot"
      }
      // supply drop: 3 cubes + full HP and energy for capture_s alone in the ring; only when it's safe
      // (overrides healing in cover: a capture is a full heal)
      const dropG = FP.dropUse && hpFrac <= FP.dropMaxHp && t >= FP.dropMinT ? this.dropGoal(obs, P, nc, safeR, nr, st.walk_speed ?? 11.7) : null
      if (dropG) {
        goal = dropG
        mode = "drop"
        fast = dropG.late
      }
      // drop as bait: watch the ring from a low-exposure spot with a clear shot at it; whoever comes to
      // fight over it is busy (the strike logic third-parties them)
      if (!dropG && !lying && FP.ambushUse) {
        const ag = this.ambushGoal(obs, P, nc, safeR, nr, myScale)
        if (ag) {
          goal = ag
          mode = "loot"
        }
      }
      if (goal) {
        const dg = dist2(P, [goal.x, goal.y])
        if (dg > (mode === "heal" ? 1.5 : 2.5)) {
          if (mode === "hide") mode = "move"
          // no progress toward this goal for a while: give the spot up
          const gk = `${goal.x | 0},${goal.y | 0}`
          if (this.prog.key !== gk || dg < this.prog.d - 3) this.prog = { key: gk, d: dg, t }
          else if (t - this.prog.t > 7) {
            this.badSpots.push({ x: goal.x, y: goal.y, t })
            if (this.badSpots.length > 12) this.badSpots.shift()
            this.stuckSpots++
            this.spot = null
            this.prog = { key: "", d: 1e9, t }
          }
          goTo(goal.x, goal.y, goal.z, fast, mode === "heal" ? 1.2 : 2.5, mode === "move" ? 6 : 1)
          if (FP.sneakRange > 0 && !fast && this.recentEnemyWithin(P, FP.sneakRange, t, 10)) {
            const l = Math.hypot(move[0], move[1])
            if (l > 0.4) move = [(move[0] / l) * 0.4, (move[1] / l) * 0.4]
            boost = false
          }
        } else {
          move = [0, 0]
          this.stuckSpots = 0
          if (hpFrac < 0.99) mode = "heal"
        }
      }
    }

    // laser telegraph: step behind cover within duckR if there is any (the beam is hitscan, a sidestep
    // rarely beats it), else sidestep across its line (overrides holding still)
    if (laserThreat && mode !== "flee") {
      const duck = FP.duckR > 0 ? this.duckPoint(P, laserThreat.tr, myScale) : null
      if (duck) {
        move = unit(yawTo(P, duck))
        if (me.grounded) boost = me.energy > 5
        mode = mode === "fight" ? "fight" : "flee"
      } else {
        const toT = unit(yawTo(P, laserThreat.tr.pos))
        const perp: V2 = [-toT[1] * this.jinkSign, toT[0] * this.jinkSign]
        move = norm2([perp[0] * 1.5 + move[0] * 0.5, perp[1] * 1.5 + move[1] * 0.5])
        if (me.energy > 20 && me.grounded) boost = true
      }
    }

    // ---- grown mechs (cubes add 5% size each, no cap) don't fit under low bridges: keep our paths off
    // the cells around them (penalties re-applied every 2 s: the follower's unstick may clear them)
    if (FP.bigFix && this.follow && this.nav && this.lowNodes.length) {
      const Hm = 9 * myScale
      if (Hm > this.penH + 0.3 || t - this.penT > 2) {
        const nav = this.nav
        const rc = Math.ceil((2.5 * myScale + 1.5) / nav.cs)
        for (const ln of this.lowNodes) {
          if (ln.ceil >= Hm + 0.5) continue
          for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) this.follow.pf.cellPenalty.set(ln.c + dj * nav.w + di, 400)
        }
        this.penH = Hm
        this.penT = t
      }
    }

    // ---- zone safety net: outside the circle for a moment -> straight back in, whatever the plan
    if (outside) {
      if (this.outsideSince < 0) this.outsideSince = t
    } else this.outsideSince = -1
    if (this.outsideSince >= 0 && t - this.outsideSince > FP.outsideS) {
      const dc = dist2(P, z.center)
      const goal: V2 = dc > z.radius - 4 ? (z.center as V2) : nc
      const want = unit(yawTo(P, goal))
      let dir: V2 = want
      if (this.nav) {
        let bs = -Infinity
        const a0 = Math.atan2(want[1], want[0])
        for (let k = 0; k < 12; k++) {
          const a = a0 + ((k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.PI) / 8
          const u = unit(a)
          if (!this.nav.lineWalkable(P[0], P[1], P[2], P[0] + u[0] * 10, P[1] + u[1] * 10, 15)) continue
          const sc = u[0] * want[0] + u[1] * want[1]
          if (sc > bs) (bs = sc), (dir = u)
        }
      }
      boost = me.energy > 8 && me.grounded
      jump = false
      // no progress while trying to get back in (a ledge or wall the walk test missed): alternate
      // sides and hop with jets
      if (FP.stuckFix) {
        const op = this.outProg
        if (!op || dist2(P, op.p) > 2.5) this.outProg = { p: [P[0], P[1]], t }
        else if (t - op.t > 1.2) {
          const side = Math.floor((t - op.t) / 1.5) % 2 ? 1 : -1
          const a = Math.atan2(dir[1], dir[0]) + side * 0.8
          dir = unit(a)
          if (me.grounded) jump = true
          else boost = me.energy > 3
        }
      }
      move = dir
      if (this.follow) this.follow.clear()
      mode = mode === "fight" ? "fight" : "move"
    } else this.outProg = null

    // ---- take weapons in reach
    const reach = this.cfg.loot.pickup_radius ?? 4
    for (const p of obs.pickups ?? []) {
      if (p.kind === "gun" || slotOf(p.kind) >= 0 || (FP.dropMortar && p.kind === "mortar")) continue
      const dh = dist2(P, p.pos), dv = Math.abs(p.pos[2] - P[2])
      if (dh > reach - 0.3 || dv > 3.8) continue
      const cur = me.weapons[1]
      if (!cur) act.take = p.id
      else if (WEAPON_PREF.indexOf(p.kind) < WEAPON_PREF.indexOf(cur.kind) && !(cur.kind === "laser" && (cur.charge ?? 0) > 0)) {
        act.take = p.id
        act.drop = 1
      }
      if (act.take !== undefined) break
    }

    // ---- reload in lulls
    const lull = mode === "hide" || mode === "heal" || mode === "move" || mode === "loot"
    if (gunW && lull && gunW.reload === 0 && (gunW.ammo ?? 0) < (gunW.stats.mag ?? 12) * 0.7) act.reload = true
    // a mortar is cook-off bait against lasers (+60%), and we don't lob: drop it when calm
    if (FP.dropMortar && mortarS >= 0 && lull && act.take === undefined) act.drop = mortarS

    // ---- idle aim: watch where enemies come from
    if (!desired) {
      if (target) desired = aimAt(muzzle, this.centerOf(target.tr))
      else if (watch) desired = aimAt(muzzle, this.centerOf(watch.tr))
      else if (t - this.lastHurtT < 4 && this.hurtBearing !== null) desired = [this.hurtBearing, 0]
      else {
        this.scanPhase += 0.07
        desired = [this.watchYaw(P, t, nc, move) + Math.sin(this.scanPhase) * FP.scanAmp, -0.03]
      }
    }

    this.mode = mode
    act.move = move
    act.aim = [desired[0], clamp(desired[1], (st.min_pitch ?? -0.7) + 0.01, (st.max_pitch ?? 1.3) - 0.01)]
    act.fire = fire
    act.boost = boost
    act.jump = jump
    if (FP.label) draw.label(`FFA ${mode} hp${Math.round(hpFrac * 100)} thr${threats.length}${target ? " t" + target.tr.id + "@" + Math.round(target.d) : ""}`)
    if (TRACE && (Math.round(t * 10) % 10 === 0 || (obs.events ?? []).some((e) => e.type === "damaged" || e.type === "kill"))) {
      const dm = (obs.events ?? []).filter((e) => e.type === "damaged").map((e: any) => `${e.weapon}${e.amount | 0}<${e.by}${e.rear ? "R" : ""}`).join(",")
      const th = threats.map((e) => `${e.tr.id}:${e.d | 0}${e.sees ? "s" : ""}${e.aimAt ? "a" : ""}${e.canHit ? "h" : ""}${recentHit(e) ? "!" : ""}hp${((e.tr.hp / e.tr.maxHp) * 100) | 0}`).join(" ")
      log(`[ffa ${me.id} ${this.bid}] t=${t.toFixed(1)} ${mode} hp=${me.hp | 0}/${me.max_hp | 0} e=${me.energy | 0} pos=${P[0] | 0},${P[1] | 0},${P[2] | 0} alive=${obs.alive} z=${dist2(P, z.center) | 0}/${z.radius | 0},${dNext | 0}/${safeR | 0} thr=[${th}] tgt=${target ? target.tr.id : "-"} vis=${E.length} spot=${this.spot ? (dist2(P, [this.spot.x, this.spot.y]) | 0) : "-"} cov=${this.cover ? (dist2(P, [this.cover.x, this.cover.y]) | 0) : "-"} fire=${fire.map(Number).join("")} fs=${this.fstate} mv=${move[0].toFixed(1)},${move[1].toFixed(1)}${jump ? "J" : ""}${boost ? "B" : ""} ${dm}`)
    }
    return act
  }

  private recentEnemyWithin(P: V3, r: number, t: number, age: number): boolean {
    for (const tr of this.tracks.values()) if (t - tr.seenT < age && dist2(P, tr.pos) < r) return true
    return false
  }

  /** Where to look while holding: last known enemies, recent fights we heard, else the zone centre. */
  private watchYaw(P: V3, t: number, nc: V2, move: V2): number {
    let best: Track | null = null
    let bs = Infinity
    for (const tr of this.tracks.values()) {
      const age = t - tr.seenT
      if (age > 20) continue
      const s = dist2(P, tr.pos) / 100 + age / 10
      if (s < bs) (bs = s), (best = tr)
    }
    if (best) return yawTo(P, best.pos)
    for (let i = this.sounds.length - 1; i >= 0; i--) {
      const s = this.sounds[i]
      if (t - s.t < 8 && s.dist !== "far") return s.bearing
    }
    if (Math.hypot(move[0], move[1]) > 0.3) return Math.atan2(move[1], move[0])
    // face away from the walls next to us (we can't see through them anyway)
    const m = this.ex?.coverMask(P[0], P[1], P[2]) ?? 0
    if (m) {
      let sx = 0, sy = 0
      for (let k = 0; k < 8; k++) if (!(m & (1 << k))) (sx += Math.cos((k * Math.PI) / 4)), (sy += Math.sin((k * Math.PI) / 4))
      if (Math.hypot(sx, sy) > 0.1) return Math.atan2(sy, sx)
    }
    return dist2(P, nc) > 5 ? yawTo(P, nc) : this.scanPhase
  }

  /** Nearest reachable point that blocks every threat's shot line. Cached for 0.6 s. */
  private findCover(P: V3, threats: { tr: Track; fresh: boolean; canHit: boolean }[], t: number, myScale: number, nc: V2 | null, safeR: number) {
    if (!this.nav || !this.world) return null
    const c = this.cover
    if (c && t - c.t < 0.6) {
      // still valid?
      let ok = true
      for (const e of threats) if (this.shotReaches(e.tr, [c.x, c.y, c.z], myScale)) (ok = false)
      if (ok) return c
    }
    // already covered here?
    let exposedNow = false
    for (const e of threats) if (e.canHit) exposedNow = true
    const nav = this.nav
    const rings = [6, 11, 17, 24, 32, 45, 60, 75]
    let best: { x: number; y: number; z: number; t: number } | null = null
    let bestCost = Infinity
    const avgThreat = threats.reduce((a, e) => [a[0] + e.tr.pos[0], a[1] + e.tr.pos[1]], [0, 0])
    const ty = Math.atan2(avgThreat[1] / threats.length - P[1], avgThreat[0] / threats.length - P[0])
    if (!exposedNow) {
      this.cover = { x: P[0], y: P[1], z: P[2], t }
      return this.cover
    }
    for (const r of rings) {
      if (r > FP.coverMax) break
      if (best && r > bestCost) break
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        const x = P[0] + Math.cos(a) * r, y = P[1] + Math.sin(a) * r
        const n = nav.nodeAt(x, y, P[2] + 1.5)
        if (n < 0) continue
        const zz = nav.hz[n]
        if (Math.abs(zz - P[2]) > 3) continue
        if (!nav.lineWalkable(P[0], P[1], P[2], x, y, 80)) continue
        // toward threats costs extra (we'd run into fire)
        const toward = Math.cos(angDiff(a, ty))
        let cost = r * (1 + Math.max(0, toward) * 0.8)
        if (nc && dist2([x, y], nc) > safeR) cost += 15
        if (cost >= bestCost) continue
        let hidden = true
        for (const e of threats) if (this.shotReaches(e.tr, [x, y, zz], myScale)) (hidden = false)
        if (!hidden) continue
        bestCost = cost
        best = { x, y, z: zz, t }
      }
    }
    this.cover = best
    return best
  }

  /** Hide spot inside the next circle (exposure map), re-picked on zone changes, threats, or timeout. */
  private chooseSpot(obs: Observation, P: V3, nc: V2, safeR: number, nr: number, urgent: boolean) {
    const t = obs.t
    const key = `${nc[0].toFixed(0)},${nc[1].toFixed(0)},${nr.toFixed(0)}`
    const s = this.spot
    let why = !s ? "none" : s.key !== key ? "zone" : ""
    if (s && !why) {
      // an enemy near the spot, or the spot no longer safe (no timeouts: re-picks en route zig-zag)
      for (const tr of this.tracks.values()) if (t - tr.seenT < 8 && dist2(tr.pos, [s.x, s.y]) < FP.avoidR * 0.6) why = "enemy"
      if (dist2([s.x, s.y], nc) > safeR) why = "unsafe"
      if (FP.spotEvery > 0 && t - s.t > FP.spotEvery && dist2(P, [s.x, s.y]) > 4) why = "timeout"
    }
    if (!why) return s
    const ex = this.ex
    if (!ex) {
      this.spot = { x: nc[0], y: nc[1], z: P[2], t, key }
      return this.spot
    }
    const avoid: number[][] = []
    for (const tr of this.tracks.values()) if (t - tr.seenT < 20) avoid.push([tr.pos[0], tr.pos[1]])
    // search near us (inside the safe circle), or near the closest part of the safe circle; the
    // radius cap keeps bestSpots cheap (a 380 m circle is ~28k cells)
    const dn = dist2(P, nc)
    const inside = dn <= safeR
    let cx = P[0], cy = P[1]
    if (!inside) {
      const k = Math.max(0, dn - Math.min(safeR, FP.spotSearchR) * 0.8) / Math.max(1e-6, dn)
      cx = P[0] + (nc[0] - P[0]) * k
      cy = P[1] + (nc[1] - P[1]) * k
    }
    const rad = Math.min(FP.spotSearchR, inside ? safeR * 2 : safeR)
    const late = obs.alive <= FP.endAlive || nr <= FP.endRadius
    const travelW = FP.travelW, centerW = FP.centerW * (late ? FP.endCenterMul : 1)
    // directions toward recently seen enemies (walking there means walking into them)
    const dirs: number[] = []
    for (const tr of this.tracks.values()) {
      const d = dist2(P, tr.pos)
      if (t - tr.seenT < 15 && d < 180) dirs.push(yawTo(P, tr.pos), d)
    }
    const bad = this.badSpots.filter((b) => t - b.t < 90)
    const spots = ex.bestSpots([cx, cy], rad, 6, {
      avoid,
      avoidRadius: FP.avoidR,
      minSpacing: 16,
      penalty: (x, y) => {
        const dz = Math.hypot(x - nc[0], y - nc[1])
        if (dz > safeR) return 5
        const dd = Math.hypot(x - P[0], y - P[1])
        let pen = (travelW * dd) / 100 + (centerW * dz) / Math.max(30, safeR)
        for (const b of bad) if (Math.abs(x - b.x) < 14 && Math.abs(y - b.y) < 14) pen += 1
        if (dirs.length && dd > 10) {
          const a = Math.atan2(y - P[1], x - P[0])
          for (let i = 0; i < dirs.length; i += 2) {
            const c = Math.cos(a - dirs[i])
            if (c > 0.3 && dd > dirs[i + 1] * 0.5) pen += 0.25 * c
          }
        }
        return pen
      },
    })
    let pick = null as null | { x: number; y: number; z: number }
    for (const sp of spots) {
      if (dist2([sp.x, sp.y], nc) > safeR) continue
      // ground level only (decks and roofs need climbs that expose us)
      if (this.world && Math.abs(sp.z - this.world.groundZ(sp.x, sp.y)) > 2.5) continue
      if (this.nav && this.nav.nodeAt(sp.x, sp.y, sp.z + 1) < 0) continue
      pick = sp
      break
    }
    if (!pick) {
      // nothing good: head toward the centre, stop inside the safe radius
      const d = dist2(P, nc)
      if (d <= safeR) pick = { x: P[0], y: P[1], z: P[2] }
      else {
        const yaw = yawTo(nc, P)
        const rr = Math.min(safeR * 0.7, d)
        pick = { x: nc[0] + Math.cos(yaw) * rr, y: nc[1] + Math.sin(yaw) * rr, z: P[2] }
      }
    }
    this.spot = { x: pick.x, y: pick.y, z: pick.z, t, key }
    if (TRACE) log(`[ffa ${obs.self.id} ${this.bid}] t=${t.toFixed(1)} SPOT ${why} d=${dist2(P, [pick.x, pick.y]) | 0} exp=${this.ex ? this.ex.exposureAt(pick.x, pick.y, pick.z).toFixed(2) : "-"} n=${spots.length}`)
    return this.spot
  }

  /**
   * A supply drop we can reach by its landing time (or that has landed) with nobody else capturing it
   * and no healthy, idle enemy seen near its ring recently (busy or weak ones don't count). Returns the
   * ring centre, and whether we are late (boost).
   */
  private dropGoal(obs: Observation, P: V3, nc: V2, safeR: number, nr: number, walk: number) {
    const t = obs.t
    let best: { x: number; y: number; z: number; late: boolean } | null = null
    let bd = Infinity
    for (const dr of obs.drops ?? []) {
      const d = dist2(P, dr.pos)
      if (d > FP.dropRange) continue
      if (nr > 1 && dist2(dr.pos, nc) > safeR + 10) continue
      const eta = (d * 1.25) / Math.max(5, walk) + 1
      if (dr.lands_in > eta + FP.dropEarlyS) continue // too early: don't wait in the open
      if (dr.holder !== null && dr.holder !== undefined && dr.holder !== obs.self.id && dr.progress > 0.3) continue
      let danger = false
      for (const tr of this.tracks.values()) {
        if (t - tr.seenT > FP.dropMemS || dist2(tr.pos, dr.pos) > FP.dropSafeR) continue
        const weak = tr.hp / Math.max(1, tr.maxHp) < FP.weakFrac
        const busy = t - tr.busyT < FP.busyS
        if (!weak && !busy) danger = true
      }
      if (danger) continue
      if (d < bd) {
        bd = d
        best = { x: dr.pos[0], y: dr.pos[1], z: dr.pos[2], late: dr.lands_in < eta - 2 }
        // stand on the least exposed walkable cell inside the ring (it counts anywhere within radius)
        if (FP.dropSpot && this.ex) {
          const key = `${dr.id}`
          if (this.dropSpotKey !== key) {
            const sp = this.ex.bestSpots(dr.pos, Math.max(1, (dr.radius ?? 8) - 2), 1, { minSpacing: 1 })
            this.dropSpotKey = key
            this.dropSpotPt = sp.length && Math.abs(sp[0].z - dr.pos[2]) < 2 ? [sp[0].x, sp[0].y, sp[0].z] : null
          }
          if (this.dropSpotPt) (best.x = this.dropSpotPt[0]), (best.y = this.dropSpotPt[1]), (best.z = this.dropSpotPt[2])
        }
      }
    }
    return best
  }
  outProg: { p: V2; t: number } | null = null
  lowNodes: { c: number; ceil: number }[] = []
  penH = 0
  penT = -99
  /** nearest point within duckR that blocks one shooter's shot line (walkable straight line from us) */
  private duckPoint(P: V3, tr: Track, myScale: number): V2 | null {
    const nav = this.nav
    if (!nav) return null
    if (!this.shotReaches(tr, P, myScale)) return null
    for (const r of [3, 5.5, 8, 11]) {
      if (r > FP.duckR) break
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2
        const x = P[0] + Math.cos(a) * r, y = P[1] + Math.sin(a) * r
        const n = nav.nodeAt(x, y, P[2] + 1.5)
        if (n < 0 || Math.abs(nav.hz[n] - P[2]) > 2) continue
        if (!nav.lineWalkable(P[0], P[1], P[2], x, y, 15)) continue
        if (this.shotReaches(tr, [x, y, nav.hz[n]], myScale)) continue
        return [x, y]
      }
    }
    return null
  }
  ambushKey = ""
  ambushPt: V3 | null = null
  private ambushGoal(obs: Observation, P: V3, nc: V2, safeR: number, nr: number, myScale: number) {
    const ex = this.ex, w = this.world
    if (!ex || !w) return null
    let best: (typeof obs.drops)[number] | null = null
    let bd = Infinity
    for (const dr of obs.drops ?? []) {
      const d = dist2(P, dr.pos)
      if (d > FP.ambushRange || dr.lands_in > FP.ambushLeadS) continue
      if (nr > 1 && dist2(dr.pos, nc) > safeR + 10) continue
      if (d < bd) (bd = d), (best = dr)
    }
    if (!best) return null
    const key = `${best.id}`
    if (this.ambushKey !== key) {
      this.ambushKey = key
      this.ambushPt = null
      const c = best.pos
      const tgt: V3 = [c[0], c[1], c[2] + 4.5]
      const spots = ex.bestSpots(c, FP.ambushR, 12, {
        avoid: [c],
        avoidRadius: FP.ambushMinR,
        minSpacing: 8,
        penalty: (x, y) => (FP.travelW * Math.hypot(x - P[0], y - P[1])) / 100 + (nr > 1 && Math.hypot(x - nc[0], y - nc[1]) > safeR ? 5 : 0),
      })
      for (const sp of spots) {
        if (Math.abs(sp.z - w.groundZ(sp.x, sp.y)) > 2.5) continue
        if (!w.shotClear([sp.x, sp.y, sp.z + 7 * myScale], tgt)) continue
        this.ambushPt = [sp.x, sp.y, sp.z]
        break
      }
    }
    return this.ambushPt ? { x: this.ambushPt[0], y: this.ambushPt[1], z: this.ambushPt[2] } : null
  }
  dropSpotKey = ""
  dropSpotPt: V3 | null = null

  /** Nearby visible cubes, a better slot-1 weapon, or our kill's cubes, when nothing threatens us. */
  private lootGoal(obs: Observation, P: V3, nc: V2, safeR: number, hpFrac: number) {
    const t = obs.t
    const okPos = (p: ArrayLike<number>) => dist2(p, nc) < safeR + 20 && Math.abs(p[2] - P[2]) < 6
    let best: { x: number; y: number; z: number } | null = null
    let bd = FP.cubeRange
    for (const c of obs.cubes ?? []) {
      const d = dist2(P, c.pos)
      if (d < bd && okPos(c.pos)) (bd = d), (best = { x: c.pos[0], y: c.pos[1], z: c.pos[2] })
    }
    if (best) return best
    const me = obs.self
    const cur = me.weapons[1]
    if (!cur || WEAPON_PREF.indexOf(cur.kind) > 0) {
      let bw = FP.weaponRange
      for (const p of obs.pickups ?? []) {
        if (p.kind === "gun" || (FP.dropMortar && p.kind === "mortar") || me.weapons.some((x) => x?.kind === p.kind)) continue
        if (cur && WEAPON_PREF.indexOf(p.kind) >= WEAPON_PREF.indexOf(cur.kind)) continue
        const d = dist2(P, p.pos)
        if (d < bw && okPos(p.pos)) (bw = d), (best = { x: p.pos[0], y: p.pos[1], z: p.pos[2] })
      }
      if (best) return best
    }
    const kd = this.killDrop
    if (kd && t - kd.t < 20 && hpFrac > 0.3 && dist2(P, [kd.x, kd.y]) < 90 && okPos([kd.x, kd.y, kd.z])) {
      if (dist2(P, [kd.x, kd.y]) < 6) this.killDrop = null
      else return kd
    }
    return null
  }
}

/** plausible attacker distance by weapon when we can't see it */
function estRange(weapon: string, prev: number): number {
  const d = weapon === "lightning" ? 30 : weapon === "laser" ? 110 : weapon === "mortar" ? 120 : 85
  return prev > 20 && prev < 230 ? (prev + d) / 2 : d
}

function threatScore(e: { tr: Track; d: number; aimAt: boolean; canHit: boolean }, t: number) {
  const recent = t - e.tr.hitUsT < 2 ? -150 - Math.min(150, e.tr.hitUsDmg * 0.2) : 0
  return e.d + recent - (e.aimAt ? 40 : 0) + (e.canHit ? 0 : 60)
}

function pickUpgrade(choices: OfferChoice[]) {
  let best = 0, bestRank = 1e9
  choices.forEach((c, i) => {
    const r = UPGRADES.indexOf(c.id)
    const rank = r < 0 ? 500 : r
    if (rank < bestRank) (bestRank = rank), (best = i)
  })
  return best
}

function norm2(v: V2): V2 {
  const l = Math.hypot(v[0], v[1])
  return l > 1e-6 ? [v[0] / l, v[1] / l] : [0, 0]
}
