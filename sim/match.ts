/**
 * Match engine: an approximate re-implementation of the mechfight/1 server rules (protocol.md).
 * 20 Hz ticks, decisions every `decide_every` ticks. Bots are driven from outside (see agents.ts):
 *   const m = new Match(opts); m.start(); while (!m.over) { const obs = m.observe(); ...; m.applyActions(acts); m.advance() }
 */
import type { BotAction, Config, Observation, WeaponKind, UpgradeDef, GameEvent, SoundObs, BeamObs, ActorObs } from "../src/mechfight.ts"
import { World, segCircle } from "./world.ts"
import { Rng, hashSeed } from "./rng.ts"

export const KINDS: WeaponKind[] = ["gun", "mortar", "laser", "lightning"]
const TAU = Math.PI * 2
export const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const r2 = (x: number) => Math.round(x * 100) / 100
const r3 = (x: number) => Math.round(x * 1000) / 1000
const r1 = (x: number) => Math.round(x * 10) / 10

export interface Weapon {
  kind: WeaponKind
  cooldown: number
  ammo: number
  reload: number
  charge: number
  charging: boolean
  fullT: number
  release: boolean // released before min_charge: fire when min_charge is reached
}

export interface MechStatsT {
  kills: number
  damageDealt: number
  damageTaken: number
  damageByWeapon: Record<string, number>
  zoneSeconds: number
  zoneDamage: number
  stuckSeconds: number
  lateAnswers: number
  missedAnswers: number
  idleSeconds: number
  rearHitsTaken: number
  cubesMax: number
  weaponsTaken: number
  firstWeaponT: number | null
  dropsTaken: number
  effects: Record<string, number>
  answerMs: number[]
  crashed: boolean
}

export class Mech {
  id: number
  name: string
  team: number
  alive = true
  place = 0
  deathT: number | null = null
  killedBy: number | null = null
  killedWith: string | null = null
  x = 0
  y = 0
  z = 0
  vx = 0
  vy = 0
  vz = 0
  grounded = true
  yaw = 0
  pitch = 0
  cyaw = 0
  cpitch = 0
  hp = 0
  energy = 0
  lastSpend = -99
  lastCombat = -99
  cubes = 0
  upCounts: Record<string, number> = {}
  upList: string[] = []
  ms: Record<string, number> // mech stats after upgrades (unscaled by size)
  wmods: Record<string, Record<string, number>> // weapon stats after upgrades
  slots: (Weapon | null)[] = [null, null]
  equipUntil = [0, 0]
  shortUntil = 0
  pendingOffers = 0
  offer: { id: number; expires: number; choices: UpgradeDef[] } | null = null
  events: GameEvent[] = []
  sounds: SoundObs[] = []
  beams: BeamObs[] = []
  // current controls
  move: [number, number] = [0, 0]
  boost = false
  fire: [boolean, boolean] = [false, false]
  lastValidT = 0
  idle = false
  boosting = false
  jetting = false
  stepAcc = 0
  pendingDying = false
  dmgFrom: number | null = null
  dmgWeapon: string | null = null
  /** in-process house bot: skip projectile/beam perception (unused) and refresh item visibility every 3rd decision */
  lite = false
  itemCacheT = -99
  itemVis: { crates: Set<number>; cubes: Set<number>; pickups: Set<number> } = { crates: new Set(), cubes: new Set(), pickups: new Set() }
  // stuck detection
  stuckRefT = 0
  stuckRefX = 0
  stuckRefY = 0
  stats: MechStatsT = {
    kills: 0,
    damageDealt: 0,
    damageTaken: 0,
    damageByWeapon: {},
    zoneSeconds: 0,
    zoneDamage: 0,
    stuckSeconds: 0,
    lateAnswers: 0,
    missedAnswers: 0,
    idleSeconds: 0,
    rearHitsTaken: 0,
    cubesMax: 0,
    weaponsTaken: 0,
    firstWeaponT: null,
    dropsTaken: 0,
    effects: {},
    answerMs: [],
    crashed: false,
  }
  constructor(id: number, name: string, team: number, cfg: Config) {
    this.id = id
    this.name = name
    this.team = team
    this.ms = { ...(cfg.mech as Record<string, number>) }
    this.wmods = {}
    for (const k of KINDS) this.wmods[k] = { ...(cfg.weapons as any)[k] }
  }
}

export interface Npc {
  id: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  hx: number
  hy: number
  yaw: number
  hp: number
  alive: boolean
  target: number | null
  cooldown: number
  wx: number
  wy: number
  wanderT: number
  scanT: number
  returning: boolean
}

export interface Proj {
  id: number
  kind: "gun" | "mortar" | "npc"
  owner: number
  team: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  traveled: number
  range: number
  ttl: number
  dmg: number
  radius: number
  splash?: number
  splashR?: number
  splashEdge?: number
  knock?: number
  knockUp?: number
  drain?: number
}

export interface Crate {
  id: number
  x: number
  y: number
  z: number
  hp: number
  alive: boolean
}
export interface Cube {
  id: number
  x: number
  y: number
  z: number
}
export interface Pickup {
  id: number
  kind: WeaponKind
  x: number
  y: number
  z: number
  w: Weapon
}
export interface Drop {
  id: number
  x: number
  y: number
  z: number
  callT: number
  landT: number
  holder: number | null
  progress: number
  taken: boolean
  landed: boolean
}
interface Circle {
  cx: number
  cy: number
  r: number
  holdStart: number
  shrinkStart: number
  shrinkEnd: number
  dps: number
}
interface SoundEv {
  kind: string
  x: number
  y: number
  t: number
  src: number
}
interface BeamEv {
  by: number
  team: number
  kind: "laser" | "lightning"
  path: number[][]
  t: number
}

export interface MatchOptions {
  seed: number
  config: Config
  world: World
  names: string[]
  /** team per slot; mechs on the same team >= 0 share vision and can't damage each other */
  teams?: number[]
  /** squad shares vision */
  sharedVision?: boolean
  record?: boolean
}

export class Match {
  cfg: Config
  w: World
  rng: Rng
  seed: number
  dt: number
  tick = 0
  t = 0
  over = false
  mechs: Mech[] = []
  npcs: Npc[] = []
  projs: Proj[] = []
  crates: Crate[] = []
  cubes: Cube[] = []
  pickups: Pickup[] = []
  drops: Drop[] = []
  circles: Circle[] = []
  soundsPending: SoundEv[] = []
  beamsPending: BeamEv[] = []
  nextProj = 1
  nextCube = 5000
  nextPickup = 8000
  nextOffer = 1
  sharedVision: boolean
  /** per vision group (team or mech) -> target id -> last time seen */
  memory = new Map<string, Map<number, number>>()
  /** per vision group, target ids visible now (this decision) */
  visibleNow = new Map<string, Set<number>>()
  aliveCount: number
  record: boolean
  frames: any[] = []
  frameEv: any[] = []
  placesFinal: number[] = []
  dropCalls: number[] = []
  dropIdx = 0
  // scratch
  private col = { x: 0, y: 0, nx: 0, ny: 0, hit: false }

  constructor(o: MatchOptions) {
    this.cfg = o.config
    this.w = o.world
    this.seed = o.seed
    this.rng = new Rng(hashSeed(o.seed, 0xabc))
    this.dt = 1 / (this.cfg.match.tick_hz ?? 20)
    this.sharedVision = o.sharedVision ?? false
    this.record = o.record ?? false
    const n = o.names.length
    for (let i = 0; i < n; i++) this.mechs.push(new Mech(i, o.names[i], o.teams ? o.teams[i] : -1, this.cfg))
    this.aliveCount = n
    this.setup()
  }

  // ------------------------------------------------------------------ setup
  private openGround(x: number, y: number, r = 3): boolean {
    const w = this.w
    const b = w.bounds
    if (x < b.minX + r || x > b.maxX - r || y < b.minY + r || y > b.maxY - r) return false
    const g = w.ground(x, y)
    if (w.support(x, y, g + 1.2) > g + 0.01) return false
    if (!w.discClear(x, y, g, r, 9, 0.5)) return false
    if (w.slope(x, y) > 0.6) return false
    // nothing overhead within 9 m
    if (w.ceiling(x, y, r, g) < g + 10) return false
    return true
  }

  private randomInCircle(cx: number, cy: number, R: number, margin: number): [number, number] {
    const b = this.w.bounds
    for (let k = 0; k < 1000; k++) {
      const a = this.rng.next() * TAU
      const d = Math.sqrt(this.rng.next()) * R
      const x = cx + Math.cos(a) * d,
        y = cy + Math.sin(a) * d
      if (x < b.minX + margin || x > b.maxX - margin || y < b.minY + margin || y > b.maxY - margin) continue
      return [x, y]
    }
    return [cx, cy]
  }

  private openPoint(cx: number, cy: number, R: number, margin: number, r = 3): [number, number, number] {
    for (let k = 0; k < 4000; k++) {
      const [x, y] = this.randomInCircle(cx, cy, R, margin)
      if (this.openGround(x, y, r)) return [x, y, this.w.ground(x, y)]
    }
    const [x, y] = this.randomInCircle(cx, cy, R, margin)
    return [x, y, this.w.topSurface(x, y)]
  }

  private roofPoint(cx: number, cy: number, R: number): [number, number, number] | null {
    const cands = this.w.prisms.filter((p) => p.kind === "building" && p.area > 60 && Math.hypot((p.minX + p.maxX) / 2 - cx, (p.minY + p.maxY) / 2 - cy) < R && p.top - this.w.ground((p.minX + p.maxX) / 2, (p.minY + p.maxY) / 2) < 58)
    if (!cands.length) return null
    let tot = 0
    for (const p of cands) tot += Math.sqrt(p.area)
    for (let k = 0; k < 200; k++) {
      let u = this.rng.next() * tot
      let p = cands[0]
      for (const c of cands) {
        u -= Math.sqrt(c.area)
        if (u <= 0) {
          p = c
          break
        }
      }
      for (let j = 0; j < 30; j++) {
        const x = this.rng.range(p.minX, p.maxX),
          y = this.rng.range(p.minY, p.maxY)
        if (!this.w.inPrism(p, x, y)) continue
        if (Math.abs(this.w.topSurface(x, y) - p.top) > 0.01) continue
        // keep away from roof edges a bit
        if (!this.w.inPrism(p, x + 1.5, y) || !this.w.inPrism(p, x - 1.5, y) || !this.w.inPrism(p, x, y + 1.5) || !this.w.inPrism(p, x, y - 1.5)) continue
        return [x, y, p.top]
      }
    }
    return null
  }

  private randomKind(): WeaponKind {
    const wts = this.cfg.loot.weights as Record<string, number>
    let tot = 0
    for (const k of KINDS) tot += wts[k] ?? 0
    let u = this.rng.next() * tot
    for (const k of KINDS) {
      u -= wts[k] ?? 0
      if (u <= 0) return k
    }
    return "laser"
  }

  newWeapon(kind: WeaponKind, m?: Mech): Weapon {
    const mag = m ? m.wmods.gun.mag : (this.cfg.weapons.gun.mag as number)
    return { kind, cooldown: 0, ammo: kind === "gun" ? mag : 0, reload: 0, charge: 0, charging: false, fullT: 0, release: false }
  }

  private setup() {
    const c = this.cfg
    const z = c.zone
    const [scx, scy] = z.start_center
    // zone circles
    let t = 0
    let cx = scx,
      cy = scy,
      r = z.start_radius
    this.circles.push({ cx, cy, r, holdStart: 0, shrinkStart: 0, shrinkEnd: 0, dps: z.phases[0]?.dps ?? 0 })
    const b = this.w.bounds
    for (const ph of z.phases) {
      const maxOff = Math.max(0, r - ph.radius)
      let nx = cx,
        ny = cy
      for (let k = 0; k < 200; k++) {
        const a = this.rng.next() * TAU
        const d = Math.sqrt(this.rng.next()) * maxOff
        nx = cx + Math.cos(a) * d
        ny = cy + Math.sin(a) * d
        if (nx > b.minX + 40 && nx < b.maxX - 40 && ny > b.minY + 40 && ny < b.maxY - 40) break
      }
      const holdStart = t
      const shrinkStart = t + ph.hold_s
      const shrinkEnd = shrinkStart + ph.shrink_s
      this.circles.push({ cx: nx, cy: ny, r: ph.radius, holdStart, shrinkStart, shrinkEnd, dps: ph.dps })
      t = shrinkEnd
      cx = nx
      cy = ny
      r = ph.radius
    }
    const R0 = z.start_radius
    const margin = c.match.arena_margin ?? 30
    // spawns
    const sepBase = c.match.spawn_min_separation ?? 130
    const sf = c.match.spawn_zone_fraction ?? 0.8
    const placed: [number, number][] = []
    for (const m of this.mechs) {
      let sep = sepBase
      let pt: [number, number, number] | null = null
      for (let k = 0; k < 3000 && !pt; k++) {
        if (k > 0 && k % 300 === 0) sep *= 0.9
        const p = this.openPoint(scx, scy, R0 * sf, margin)
        if (placed.every(([x, y]) => Math.hypot(x - p[0], y - p[1]) >= sep)) pt = p
      }
      if (!pt) pt = this.openPoint(scx, scy, R0 * sf, margin)
      placed.push([pt[0], pt[1]])
      m.x = pt[0]
      m.y = pt[1]
      m.z = pt[2]
      m.yaw = m.cyaw = Math.atan2(scy - m.y, scx - m.x)
      m.pitch = m.cpitch = 0
      m.hp = this.maxHp(m)
      m.energy = m.ms.energy
      m.slots = [this.newWeapon("gun", m), null]
      m.stuckRefX = m.x
      m.stuckRefY = m.y
    }
    // npcs
    const nc = c.npc
    for (let i = 0; i < (nc.count ?? 12); i++) {
      const [x, y, zz] = this.openPoint(scx, scy, R0 * 0.95, margin, 2)
      this.npcs.push({ id: 100 + i, x, y, z: zz, vx: 0, vy: 0, hx: x, hy: y, yaw: 0, hp: nc.hp, alive: true, target: null, cooldown: 0, wx: x, wy: y, wanderT: 0, scanT: this.rng.next() * 0.5, returning: false })
    }
    // crates
    const cc = c.crates
    for (let i = 0; i < (cc.count ?? 36); i++) {
      let p: [number, number, number] | null = null
      if (this.rng.next() < (cc.roof_fraction ?? 0.25)) p = this.roofPoint(scx, scy, R0 * 0.95)
      if (!p) p = this.openPoint(scx, scy, R0 * 0.95, margin, 2)
      this.crates.push({ id: 1000 + i, x: p[0], y: p[1], z: p[2], hp: cc.hp, alive: true })
    }
    // floor weapons
    const lc = c.loot
    for (let i = 0; i < (lc.floor_count ?? 40); i++) {
      let p: [number, number, number] | null = null
      if (this.rng.next() < (lc.floor_roof_fraction ?? 0.25)) p = this.roofPoint(scx, scy, R0 * 0.95)
      if (!p) p = this.openPoint(scx, scy, R0 * 0.95, margin, 2)
      const kind = this.randomKind()
      this.pickups.push({ id: this.nextPickup++, kind, x: p[0], y: p[1], z: p[2], w: this.newWeapon(kind) })
    }
    // drops are placed when called
    this.dropCalls = [...(c.drops?.times ?? [])]
    if (this.record) this.frames.push(this.header())
  }

  // ------------------------------------------------------------------ stats helpers
  size(m: Mech) {
    return 1 + (this.cfg.cubes.size_per_cube as number) * m.cubes
  }
  cubeMul(m: Mech) {
    return 1 + (this.cfg.cubes.damage_per_cube as number) * Math.min(m.cubes, this.cfg.cubes.stat_cap as number)
  }
  maxHp(m: Mech) {
    return m.ms.hp * (1 + (this.cfg.cubes.hp_per_cube as number) * Math.min(m.cubes, this.cfg.cubes.stat_cap as number))
  }
  radius(m: Mech) {
    return m.ms.radius * this.size(m)
  }
  height(m: Mech) {
    return m.ms.height * this.size(m)
  }
  eyeZ(m: Mech) {
    return m.z + m.ms.eye_height * this.size(m)
  }
  inZone(x: number, y: number): boolean {
    const z = this.zoneNow()
    return Math.hypot(x - z.cx, y - z.cy) <= z.r
  }
  /** current circle and phase index (1-based into circles) */
  zoneNow(): { cx: number; cy: number; r: number; k: number; dps: number } {
    const t = this.t
    const C = this.circles
    let k = 1
    while (k < C.length - 1 && t >= C[k].shrinkEnd) k++
    const prev = C[k - 1],
      nxt = C[k]
    if (t <= nxt.shrinkStart) return { cx: prev.cx, cy: prev.cy, r: prev.r, k, dps: nxt.dps }
    if (t >= nxt.shrinkEnd) return { cx: nxt.cx, cy: nxt.cy, r: nxt.r, k, dps: nxt.dps }
    const f = (t - nxt.shrinkStart) / (nxt.shrinkEnd - nxt.shrinkStart)
    return { cx: prev.cx + (nxt.cx - prev.cx) * f, cy: prev.cy + (nxt.cy - prev.cy) * f, r: prev.r + (nxt.r - prev.r) * f, k, dps: nxt.dps }
  }

  mechById(id: number): Mech | undefined {
    return id >= 0 && id < this.mechs.length ? this.mechs[id] : undefined
  }

  friendly(a: Mech, b: Mech) {
    return a !== b && a.team >= 0 && a.team === b.team
  }

  // ------------------------------------------------------------------ sounds / events
  sound(kind: string, x: number, y: number, src: number) {
    this.soundsPending.push({ kind, x, y, t: this.t, src })
  }
  ev(e: any) {
    if (this.record) this.frameEv.push({ t: this.tick, ...e })
  }

  // ------------------------------------------------------------------ actions
  /** apply one decision's actions (null = no valid answer: coast, then idle) */
  applyAction(m: Mech, a: BotAction | null, valid: boolean) {
    if (!m.alive) return
    const coast = this.cfg.bot.coast_s ?? 1
    if (!valid || !a) {
      m.stats.missedAnswers++
      m.fire = [false, false]
      if (this.t - m.lastValidT > coast) {
        m.idle = true
        m.move = [0, 0]
        m.boost = false
        m.cyaw = m.yaw
        m.cpitch = m.pitch
      }
      return
    }
    m.lastValidT = this.t
    m.idle = false
    const mv = a.move
    if (Array.isArray(mv) && mv.length >= 2 && Number.isFinite(mv[0]) && Number.isFinite(mv[1])) {
      let [mx, my] = mv
      const l = Math.hypot(mx, my)
      if (l > 1) {
        mx /= l
        my /= l
      }
      m.move = [mx, my]
    } else m.move = [0, 0]
    m.boost = !!a.boost
    if (Array.isArray(a.aim) && a.aim.length >= 2 && Number.isFinite(a.aim[0]) && Number.isFinite(a.aim[1])) {
      m.cyaw = wrap(a.aim[0])
      m.cpitch = Math.max(m.ms.min_pitch, Math.min(m.ms.max_pitch, a.aim[1]))
    }
    m.fire = Array.isArray(a.fire) ? [!!a.fire[0], !!a.fire[1]] : [false, false]
    if (a.jump && m.grounded) {
      m.vz = m.ms.jump_speed
      m.grounded = false
    }
    if (a.reload) {
      for (const w of m.slots) if (w && w.kind === "gun" && w.reload <= 0 && w.ammo < m.wmods.gun.mag) this.startReload(m, w)
    }
    if (typeof a.pick === "number" && m.offer) {
      const i = Math.floor(a.pick)
      if (i >= 0 && i < m.offer.choices.length) this.applyUpgrade(m, m.offer.choices[i])
    }
    if (typeof a.take === "number") this.doTake(m, a.take, typeof a.drop === "number" ? a.drop : undefined)
    else if (typeof a.drop === "number") this.doDrop(m, a.drop)
  }

  private startReload(m: Mech, w: Weapon) {
    w.reload = m.wmods.gun.reload
    this.sound("reload", m.x, m.y, m.id)
  }

  private doTake(m: Mech, id: number, drop?: number) {
    const idx = this.pickups.findIndex((p) => p.id === id)
    const fail = (reason: string) => m.events.push({ type: "take_failed", id, reason } as GameEvent)
    if (idx < 0) return fail("gone")
    const p = this.pickups[idx]
    const reach = this.cfg.loot.pickup_radius ?? 4
    if (Math.hypot(p.x - m.x, p.y - m.y) > reach || Math.abs(p.z - m.z) > 4) return fail("range")
    if (m.slots.some((s, i) => s && s.kind === p.kind && i !== drop)) return fail("have")
    let slot = -1
    if (drop === 0 || drop === 1) slot = drop
    else slot = m.slots[0] === null ? 0 : m.slots[1] === null ? 1 : -1
    if (slot < 0) return fail("full")
    const old = m.slots[slot]
    if (old && old.kind === "laser" && old.charging) return fail("busy")
    this.pickups.splice(idx, 1)
    if (old) this.dropWeapon(m, slot)
    const wpn = p.w
    wpn.charging = false
    wpn.charge = 0
    m.slots[slot] = wpn
    const cd = Math.max(this.cfg.loot.equip_s ?? 1, m.wmods[p.kind].cooldown ?? 0)
    wpn.cooldown = Math.max(wpn.cooldown, cd)
    m.events.push({ type: "took", id: p.id, kind: p.kind, slot } as GameEvent)
    m.stats.weaponsTaken++
    if (m.stats.firstWeaponT === null) m.stats.firstWeaponT = this.t
    this.ev({ e: "weapon", op: "take", id: p.id, kind: p.kind, by: m.id, slot })
  }

  private dropWeapon(m: Mech, slot: number) {
    const w = m.slots[slot]
    if (!w) return
    m.slots[slot] = null
    w.charging = false
    w.charge = 0
    const id = this.nextPickup++
    this.pickups.push({ id, kind: w.kind, x: m.x, y: m.y, z: m.z, w })
    m.events.push({ type: "dropped", id, kind: w.kind, slot } as GameEvent)
    this.ev({ e: "weapon", op: "drop", id, kind: w.kind, by: m.id, slot, at: [r2(m.x), r2(m.y), r2(m.z)] })
  }

  private doDrop(m: Mech, slot: number) {
    if (slot !== 0 && slot !== 1) return
    const w = m.slots[slot]
    if (!w) return
    if (w.kind === "laser" && w.charging) return
    this.dropWeapon(m, slot)
  }

  // ------------------------------------------------------------------ upgrades
  private drawOffer(m: Mech) {
    const held = new Set(m.slots.filter((s) => s).map((s) => s!.kind))
    const elig = this.cfg.upgrades.filter((u) => (m.upCounts[u.id] ?? 0) < u.max && (!u.requires || held.has(u.requires)))
    this.rng.shuffle(elig)
    const choices = elig.slice(0, 3)
    if (!choices.length) {
      m.pendingOffers = 0
      return
    }
    m.offer = { id: this.nextOffer++, expires: r2(this.t + (this.cfg.bot.offer_timeout_s ?? 5)), choices }
  }

  applyUpgrade(m: Mech, u: UpgradeDef) {
    const oldMax = this.maxHp(m)
    const oldE = m.ms.energy
    for (const e of u.effects) {
      const parts = e.path.split(".")
      let tgt: Record<string, number> | undefined
      let key: string
      if (parts[0] === "mech") {
        tgt = m.ms
        key = parts[1]
      } else if (parts[0] === "weapons") {
        tgt = m.wmods[parts[1]]
        key = parts[2]
      } else continue
      if (!tgt) continue
      if (e.mul !== undefined) tgt[key] = (tgt[key] ?? 0) * e.mul
      if (e.add !== undefined) tgt[key] = (tgt[key] ?? 0) + e.add
    }
    m.upCounts[u.id] = (m.upCounts[u.id] ?? 0) + 1
    m.upList.push(u.id)
    const newMax = this.maxHp(m)
    if (newMax > oldMax) m.hp += newMax - oldMax
    if (m.ms.energy > oldE) m.energy += m.ms.energy - oldE
    m.events.push({ type: "upgrade", id: u.id } as GameEvent)
    this.ev({ e: "upgrade", id: m.id, up: u.id })
    m.offer = null
    if (m.pendingOffers > 0) m.pendingOffers--
  }

  addCubes(m: Mech, n: number) {
    const th = this.cfg.cubes.upgrade_thresholds as number[]
    const oldMax = this.maxHp(m)
    for (let i = 0; i < n; i++) {
      m.cubes++
      if (th.includes(m.cubes)) m.pendingOffers++
    }
    const nm = this.maxHp(m)
    if (nm > oldMax) m.hp += nm - oldMax
    m.stats.cubesMax = Math.max(m.stats.cubesMax, m.cubes)
  }

  // ------------------------------------------------------------------ damage
  /**
   * Damage a mech. `fx,fy` = where the hit came from (for rear armor and bearing).
   * Returns damage dealt.
   */
  damageMech(tg: Mech, base: number, src: Mech | null, srcId: number | null, weapon: string, fx: number, fy: number, effect?: "cookoff" | "short" | "concuss", noRear = false): number {
    if (!tg.alive || tg.pendingDying) return 0
    if (src && this.friendly(src, tg)) return 0
    let amt = base
    let rear = false
    const bearing = Math.atan2(fy - tg.y, fx - tg.x)
    if (!noRear) {
      const half = ((tg.ms.front_arc_deg ?? 180) * Math.PI) / 360
      if (Math.abs(wrap(bearing - tg.yaw)) > half + 1e-9) {
        rear = true
        amt *= tg.ms.rear_mult ?? 1.5
      }
    }
    if (weapon !== "zone") amt *= Math.max(0, 1 - (tg.ms.armor ?? 0))
    if (src === tg) amt *= tg.ms.self_damage_mult ?? 0.5
    if (amt <= 0) return 0
    amt = Math.min(amt, tg.hp)
    tg.hp -= amt
    tg.lastCombat = this.t
    tg.stats.damageTaken += amt
    if (rear) tg.stats.rearHitsTaken++
    const dEv: any = { type: "damaged", amount: r2(amt), weapon, bearing: weapon === "zone" ? null : r3(bearing), by: srcId }
    if (rear) dEv.rear = true
    tg.events.push(dEv)
    if (src && src !== tg) {
      src.lastCombat = this.t
      src.stats.damageDealt += amt
      src.stats.damageByWeapon[weapon] = (src.stats.damageByWeapon[weapon] ?? 0) + amt
      const hEv: any = { type: "hit", target: tg.id, amount: r2(amt), weapon }
      if (effect) hEv.effect = effect
      if (rear) hEv.rear = true
      src.events.push(hEv)
    }
    if (effect && effect !== "concuss") tg.stats.effects[effect] = (tg.stats.effects[effect] ?? 0) + 1
    if (rear) tg.stats.effects.rear = (tg.stats.effects.rear ?? 0) + 1
    const rec: any = { e: "hit", src: srcId, dst: tg.id, amt: r2(amt), w: weapon }
    if (effect) rec.fx = effect
    if (rear) rec.rear = 1
    this.ev(rec)
    if (srcId !== null || weapon === "zone") {
      tg.dmgFrom = srcId
      tg.dmgWeapon = weapon
    }
    if (tg.hp <= 1e-6) {
      tg.hp = 0
      tg.pendingDying = true
      tg.killedBy = src && src !== tg ? src.id : null
      tg.killedWith = weapon
    }
    return amt
  }

  damageNpc(n: Npc, amt: number, src: Mech | null, weapon: string) {
    if (!n.alive) return
    amt = Math.min(amt, n.hp)
    n.hp -= amt
    if (src) {
      src.lastCombat = this.t
      src.stats.damageDealt += amt
      src.stats.damageByWeapon[weapon] = (src.stats.damageByWeapon[weapon] ?? 0) + amt
      src.events.push({ type: "hit", target: n.id, amount: r2(amt), weapon } as GameEvent)
      if (n.target === null || !this.mechById(n.target)?.alive) n.target = src.id
      else n.target = src.id
      n.returning = false
    }
    this.ev({ e: "hit", src: src ? src.id : null, dst: n.id, amt: r2(amt), w: weapon })
    if (n.hp <= 1e-6) {
      n.alive = false
      n.hp = 0
      this.ev({ e: "death", id: n.id, by: src ? src.id : null })
      this.spawnCubes(n.x, n.y, n.z, this.cfg.npc.cubes ?? 2, 2)
      this.sound("death", n.x, n.y, n.id)
    }
  }

  damageCrate(c: Crate, amt: number, src: Mech | null, weapon: string) {
    if (!c.alive) return
    amt = Math.min(amt, c.hp)
    c.hp -= amt
    if (src) {
      src.lastCombat = this.t
      src.events.push({ type: "hit", target: c.id, amount: r2(amt), weapon } as GameEvent)
    }
    this.ev({ e: "hit", src: src ? src.id : null, dst: c.id, amt: r2(amt), w: weapon })
    if (c.hp <= 1e-6) {
      c.alive = false
      c.hp = 0
      this.ev({ e: "crate", id: c.id, by: src ? src.id : null })
      this.sound("crate", c.x, c.y, -1)
      this.spawnCubes(c.x, c.y, c.z, this.cfg.crates.cubes ?? 1, 0)
      if (this.rng.next() < (this.cfg.loot.crate_weapon_chance ?? 0.5)) {
        const kind = this.randomKind()
        const id = this.nextPickup++
        const a = this.rng.next() * TAU
        const px = c.x + Math.cos(a) * 1.0,
          py = c.y + Math.sin(a) * 1.0
        const pz = this.w.support(px, py, c.z + 1.2)
        this.pickups.push({ id, kind, x: px, y: py, z: pz, w: this.newWeapon(kind) })
        this.ev({ e: "weapon", op: "spawn", id, kind, at: [r2(px), r2(py), r2(pz)], src: c.id })
      }
    }
  }

  spawnCubes(x: number, y: number, z: number, n: number, scatter: number) {
    for (let i = 0; i < n; i++) {
      let cx = x,
        cy = y
      if (scatter > 0 || n > 1) {
        const a = this.rng.next() * TAU
        const d = (scatter || 1.5) * Math.sqrt(this.rng.next())
        cx = x + Math.cos(a) * d
        cy = y + Math.sin(a) * d
      }
      const cz = this.w.support(cx, cy, z + 1.2)
      const id = this.nextCube++
      this.cubes.push({ id, x: cx, y: cy, z: Math.abs(cz - z) < 3 ? cz : z })
      this.ev({ e: "cube", id, at: [r2(cx), r2(cy), r2(cz)] })
    }
  }

  // ------------------------------------------------------------------ simulation
  /** advance `decide_every` ticks */
  advance() {
    const n = this.cfg.match.decide_every ?? 2
    for (let i = 0; i < n && !this.over; i++) this.step()
  }

  private step() {
    const dt = this.dt
    this.tick++
    this.t = this.tick * dt
    const cfg = this.cfg
    // drops
    while (this.dropIdx < this.dropCalls.length && this.t >= this.dropCalls[this.dropIdx] - 1e-9) {
      this.callDrop(this.dropIdx)
      this.dropIdx++
    }
    for (const m of this.mechs) if (m.alive) this.stepMech(m, dt)
    this.pushApart()
    this.stepProjectiles(dt)
    this.stepNpcs(dt)
    this.stepItems(dt)
    // offers
    for (const m of this.mechs) {
      if (!m.alive) continue
      if (m.offer && this.t >= m.offer.expires - 1e-9) this.applyUpgrade(m, m.offer.choices[0])
      if (!m.offer && m.pendingOffers > 0) this.drawOffer(m)
    }
    this.resolveDeaths()
    if (!this.over && this.t >= (cfg.match.duration_s ?? 480) - 1e-9) this.endByTime()
    if (this.record && (this.tick % (cfg.replay?.frame_every ?? 2) === 0 || this.over)) this.frame()
  }

  private stepMech(m: Mech, dt: number) {
    const ms = m.ms
    const w = this.w
    // aim slew
    const dyaw = wrap(m.cyaw - m.yaw)
    const ty = ms.turn_rate * dt
    m.yaw = Math.abs(dyaw) <= ty ? m.cyaw : wrap(m.yaw + Math.sign(dyaw) * ty)
    const dp = m.cpitch - m.pitch
    const tp = ms.pitch_rate * dt
    m.pitch = Math.abs(dp) <= tp ? m.cpitch : m.pitch + Math.sign(dp) * tp
    m.pitch = Math.max(ms.min_pitch, Math.min(ms.max_pitch, m.pitch))
    const size = this.size(m)
    const R = ms.radius * size
    const H = ms.height * size
    // weapons (cooldowns + firing) before movement so charge slowdown applies this tick
    let charging = false
    for (let s = 0; s < 2; s++) {
      const wp = m.slots[s]
      if (!wp) continue
      this.stepWeapon(m, wp, s, dt)
      if (wp.charging) charging = true
    }
    if (!m.alive || m.pendingDying) return
    // movement intent
    const [mx, my] = m.move
    const ml = Math.hypot(mx, my)
    let spend = false
    m.boosting = false
    m.jetting = false
    let speed = ms.walk_speed
    if (m.boost && m.energy > 0) {
      if (m.grounded && ml > 0.05) {
        speed = ms.boost_speed
        m.energy = Math.max(0, m.energy - ms.boost_drain * dt)
        spend = true
        m.boosting = true
      } else if (!m.grounded) {
        m.energy = Math.max(0, m.energy - ms.jet_drain * dt)
        spend = true
        m.jetting = true
      }
    }
    if (charging) speed *= ms.charge_move_mult ?? 0.5
    const tvx = mx * speed,
      tvy = my * speed
    const acc = (m.grounded ? ms.ground_accel : ms.air_accel) * dt
    let ex = tvx - m.vx,
      ey = tvy - m.vy
    const el = Math.hypot(ex, ey)
    if (el > acc) {
      ex *= acc / el
      ey *= acc / el
    }
    m.vx += ex
    m.vy += ey
    // vertical
    if (!m.grounded) {
      // jets add thrust capped at max_rise_speed, then gravity (measured effective rise 10 - 22*0.05 = 8.9 m/s)
      if (m.jetting && m.vz < ms.max_rise_speed) m.vz = Math.min(ms.max_rise_speed, m.vz + ms.jet_accel * dt)
      m.vz -= ms.gravity * dt
    }
    // energy regen restarts on the 14th tick after the last spend (measured on the real stream)
    if (spend) m.lastSpend = this.t
    else if (this.t - m.lastSpend >= ms.energy_regen_delay + 2 * dt - 1e-9) m.energy = Math.min(ms.energy, m.energy + ms.energy_regen * dt)
    // horizontal move with collision
    const ox = m.x,
      oy = m.y,
      oz = m.z
    let nx = m.x + m.vx * dt,
      ny = m.y + m.vy * dt
    const stepUp = ms.step_up
    const c = this.col
    w.collide(nx, ny, m.z, R, H, stepUp, c)
    if (c.hit) {
      nx = c.x
      ny = c.y
      const nl = Math.hypot(c.nx, c.ny)
      if (nl > 1e-9) {
        const ux = c.nx / nl,
          uy = c.ny / nl
        const vn = m.vx * ux + m.vy * uy
        if (vn < 0) {
          m.vx -= vn * ux
          m.vy -= vn * uy
        }
      }
    }
    // terrain step / slope check when grounded
    if (m.grounded) {
      const gNew = w.ground(nx, ny)
      const rise = gNew - m.z
      const hd = Math.hypot(nx - ox, ny - oy)
      const supNew = w.support(nx, ny, m.z + stepUp)
      if (supNew <= gNew + 1e-6 && rise > 0.02 && hd > 1e-6) {
        // walking on terrain uphill
        const tanMax = Math.tan(((ms.max_slope_deg ?? 50) * Math.PI) / 180)
        if (rise > stepUp || (rise / hd > tanMax && w.slope(nx, ny) > tanMax)) {
          nx = ox
          ny = oy
          m.vx = 0
          m.vy = 0
        }
      }
    }
    m.x = nx
    m.y = ny
    // vertical integrate
    if (m.grounded) {
      const sup = w.support(m.x, m.y, m.z + stepUp)
      if (sup >= m.z - 1.25 * Math.max(1, Math.hypot(m.vx, m.vy) * dt) && sup >= m.z - stepUp) {
        // stay on surface (walk down slopes / steps)
        if (sup < m.z - 0.6) {
          // significant drop: start falling
          m.grounded = false
          m.vz = 0
        } else {
          m.z = sup
          m.vz = 0
        }
      } else {
        // check roof edge: disc still overlaps a roof at our feet height
        const edge = w.edgeSupport(m.x, m.y, R * 0.8, m.z - 0.05, m.z + 0.05)
        if (edge > -Infinity && sup < m.z - 0.6) {
          // on an edge: slide off unless moving toward it
          m.z = edge
          m.vz = 0
          this.slideOffEdge(m, R)
        } else {
          m.grounded = false
          m.vz = 0
        }
      }
    }
    if (!m.grounded) {
      let nz = m.z + m.vz * dt
      // ceiling
      if (m.vz > 0) {
        const ceil = w.ceiling(m.x, m.y, R, m.z + H - 0.05)
        if (nz + H > ceil) {
          nz = Math.max(m.z, ceil - H)
          m.vz = 0
        }
      }
      const sup = w.support(m.x, m.y, Math.max(m.z, nz) + stepUp * 0.5)
      if (nz <= sup && m.vz <= 0) {
        m.z = sup
        m.vz = 0
        m.grounded = true
      } else if (m.vz <= 0) {
        // roof edge landing
        const edge = w.edgeSupport(m.x, m.y, R * 0.8, nz, m.z + 0.01)
        if (edge > -Infinity && edge > sup) {
          m.z = edge
          m.vz = 0
          m.grounded = true
        } else m.z = nz
      } else m.z = nz
      if (m.z < sup - 0.01 && m.vz > 0) m.z = Math.max(m.z, sup)
    }
    // knock stays as velocity; clamp vertical fall
    // zone
    const zn = this.zoneNow()
    const inZone = Math.hypot(m.x - zn.cx, m.y - zn.cy) <= zn.r
    if (!inZone) {
      m.stats.zoneSeconds += dt
      const before = m.hp
      this.damageMech(m, zn.dps * dt, null, null, "zone", m.x, m.y, undefined, true)
      m.stats.zoneDamage += before - m.hp
    } else if (this.t - m.lastCombat >= ms.regen_delay && m.hp < this.maxHp(m)) {
      m.hp = Math.min(this.maxHp(m), m.hp + ms.regen_per_s * dt)
    }
    // sounds: steps / boost / jets
    const hs = Math.hypot(m.x - ox, m.y - oy) / dt
    if (m.grounded && hs > (this.cfg.sound.step_speed ?? 5)) {
      m.stepAcc += dt
      if (m.stepAcc >= (this.cfg.sound.step_every ?? 0.6)) {
        m.stepAcc = 0
        this.sound(m.boosting ? "boost" : "step", m.x, m.y, m.id)
      }
    } else if (m.jetting) {
      m.stepAcc += dt
      if (m.stepAcc >= (this.cfg.sound.step_every ?? 0.6)) {
        m.stepAcc = 0
        this.sound("jet", m.x, m.y, m.id)
      }
    } else m.stepAcc = Math.min(m.stepAcc, 0.6)
    // stuck metric: commanded to move but no progress for 1 s
    if (ml > 0.3) {
      if (this.t - m.stuckRefT >= 1) {
        if (Math.hypot(m.x - m.stuckRefX, m.y - m.stuckRefY) < 1.0) m.stats.stuckSeconds += this.t - m.stuckRefT
        m.stuckRefT = this.t
        m.stuckRefX = m.x
        m.stuckRefY = m.y
      }
    } else {
      m.stuckRefT = this.t
      m.stuckRefX = m.x
      m.stuckRefY = m.y
    }
    if (m.idle) m.stats.idleSeconds += dt
    void oz
  }

  private slideOffEdge(m: Mech, R: number) {
    // find direction away from the roof the disc overlaps: test 8 directions
    const w = this.w
    const toward = Math.hypot(m.move[0], m.move[1]) > 0.2
    let bx = 0,
      by = 0,
      best = -Infinity
    for (let k = 0; k < 8; k++) {
      const a = (k * TAU) / 8
      const px = m.x + Math.cos(a) * R,
        py = m.y + Math.sin(a) * R
      const s = w.support(px, py, m.z + 0.05)
      if (s >= m.z - 0.05) {
        // roof in this direction
        if (toward && Math.cos(a) * m.move[0] + Math.sin(a) * m.move[1] > 0.3) return // moving onto it
        const score = 1
        if (score > best) {
          best = score
          bx -= Math.cos(a)
          by -= Math.sin(a)
        }
      }
    }
    const l = Math.hypot(bx, by)
    if (l > 1e-6) {
      const nx = m.x + (bx / l) * 0.6,
        ny = m.y + (by / l) * 0.6
      const c = this.col
      w.collide(nx, ny, m.z, R, this.height(m), m.ms.step_up, c)
      m.x = c.x
      m.y = c.y
    }
  }

  private pushApart() {
    const ms = this.mechs
    for (let i = 0; i < ms.length; i++) {
      const a = ms[i]
      if (!a.alive) continue
      for (let j = i + 1; j < ms.length; j++) {
        const b = ms[j]
        if (!b.alive) continue
        const ra = this.radius(a),
          rb = this.radius(b)
        const dx = b.x - a.x,
          dy = b.y - a.y
        const d = Math.hypot(dx, dy)
        if (d >= ra + rb) continue
        if (a.z + this.height(a) < b.z || b.z + this.height(b) < a.z) continue
        const pen = ra + rb - d
        const ux = d > 1e-6 ? dx / d : 1,
          uy = d > 1e-6 ? dy / d : 0
        const c = this.col
        this.w.collide(a.x - (ux * pen) / 2, a.y - (uy * pen) / 2, a.z, ra, this.height(a), a.ms.step_up, c)
        a.x = c.x
        a.y = c.y
        this.w.collide(b.x + (ux * pen) / 2, b.y + (uy * pen) / 2, b.z, rb, this.height(b), b.ms.step_up, c)
        b.x = c.x
        b.y = c.y
      }
    }
  }

  // ------------------------------------------------------------------ weapons
  private aimDir(m: Mech): [number, number, number] {
    const cp = Math.cos(m.pitch)
    return [cp * Math.cos(m.yaw), cp * Math.sin(m.yaw), Math.sin(m.pitch)]
  }

  /** muzzle base, and shot origin out along dir (clipped at walls). Returns [ox,oy,oz, blocked] */
  private shotOrigin(m: Mech, d: [number, number, number], height: number): [number, number, number, boolean] {
    const size = this.size(m)
    const bx = m.x,
      by = m.y,
      bz = m.z + height * size
    const L = m.ms.radius * size + 0.5
    const ex = bx + d[0] * L,
      ey = by + d[1] * L,
      ez = bz + d[2] * L
    const t = this.w.raycast(bx, by, bz, ex, ey, ez)
    if (t <= 1) {
      const tt = Math.max(0, t - 0.05 / L)
      return [bx + d[0] * L * tt, by + d[1] * L * tt, bz + d[2] * L * tt, true]
    }
    return [ex, ey, ez, false]
  }

  private stepWeapon(m: Mech, wp: Weapon, slot: number, dt: number) {
    const st = m.wmods[wp.kind]
    const held = m.fire[slot]
    const equipped = true
    void equipped
    if (wp.kind === "gun") {
      if (wp.reload > 0) {
        wp.reload -= dt
        if (wp.reload <= 1e-9) {
          wp.reload = 0
          wp.ammo = st.mag
        }
      }
      wp.cooldown -= dt
      if (held && wp.reload <= 0 && wp.ammo > 0 && wp.cooldown <= 1e-9) {
        this.fireGun(m, st)
        wp.ammo--
        wp.cooldown += st.cooldown
        if (wp.cooldown < 0) wp.cooldown = 0
        if (wp.ammo <= 0) this.startReload(m, wp)
      } else if (wp.cooldown < 0) wp.cooldown = 0
      return
    }
    if (wp.kind === "mortar") {
      wp.cooldown -= dt
      if (held && wp.cooldown <= 1e-9) {
        this.fireMortar(m, st)
        wp.cooldown += st.cooldown
        if (wp.cooldown < 0) wp.cooldown = 0
      } else if (wp.cooldown < 0) wp.cooldown = 0
      return
    }
    if (wp.kind === "lightning") {
      wp.cooldown -= dt
      if (held && wp.cooldown <= 1e-9 && m.energy >= st.energy) {
        m.energy -= st.energy
        m.lastSpend = this.t
        this.fireLightning(m, st)
        wp.cooldown += st.cooldown
        if (wp.cooldown < 0) wp.cooldown = 0
      } else if (wp.cooldown < 0) wp.cooldown = 0
      return
    }
    // laser
    if (wp.cooldown > 0) wp.cooldown = Math.max(0, wp.cooldown - dt)
    if (wp.charging) {
      wp.charge = Math.min(st.charge, wp.charge + dt)
      if (wp.charge >= st.charge - 1e-9) wp.fullT += dt
      if (!held) wp.release = true
      const fireNow = (wp.release && wp.charge >= st.min_charge - 1e-9) || wp.fullT >= st.hold_s - 1e-9
      if (fireNow) {
        this.fireLaser(m, st, wp.charge)
        wp.charging = false
        wp.charge = 0
        wp.fullT = 0
        wp.release = false
        wp.cooldown = st.cooldown
      }
    } else if (held && wp.cooldown <= 0 && this.t >= m.shortUntil) {
      wp.charging = true
      wp.charge = 0
      wp.fullT = 0
      wp.release = false
      this.sound("laser_charge", m.x, m.y, m.id)
      this.ev({ e: "charge", id: m.id, yaw: r3(m.yaw), pitch: r3(m.pitch), dur: st.charge, range: st.range })
    }
  }

  private fireGun(m: Mech, st: Record<string, number>) {
    const sp = ((st.spread_deg ?? 0.6) * Math.PI) / 180
    const yaw = m.yaw + this.rng.gauss() * sp,
      pitch = m.pitch + this.rng.gauss() * sp
    const cp = Math.cos(pitch)
    const d: [number, number, number] = [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)]
    const [ox, oy, oz, blocked] = this.shotOrigin(m, d, m.ms.muzzle_height)
    const id = this.nextProj++
    this.sound("gun", m.x, m.y, m.id)
    this.ev({ e: "fire", id: m.id, w: "gun" })
    if (blocked) {
      this.ev({ e: "impact", p: id, at: [r2(ox), r2(oy), r2(oz)], hit: null })
      return
    }
    this.projs.push({ id, kind: "gun", owner: m.id, team: m.team, x: ox, y: oy, z: oz, vx: d[0] * st.speed, vy: d[1] * st.speed, vz: d[2] * st.speed, traveled: 0, range: st.range, ttl: 10, dmg: st.damage * this.cubeMul(m), radius: this.cfg.projectile.gun_radius ?? 0.3 })
  }

  private fireMortar(m: Mech, st: Record<string, number>) {
    const d = this.aimDir(m)
    const tube = m.ms.height + 0.5
    const [ox, oy, oz, blocked] = this.shotOrigin(m, d, tube)
    const id = this.nextProj++
    this.sound("mortar", m.x, m.y, m.id)
    this.ev({ e: "fire", id: m.id, w: "mortar" })
    const p: Proj = { id, kind: "mortar", owner: m.id, team: m.team, x: ox, y: oy, z: oz, vx: d[0] * st.speed, vy: d[1] * st.speed, vz: d[2] * st.speed, traveled: 0, range: 1e9, ttl: st.ttl ?? 7, dmg: st.damage * this.cubeMul(m), radius: 0.4, splash: st.splash * this.cubeMul(m), splashR: st.splash_radius, splashEdge: st.splash_edge, knock: st.knock, knockUp: st.knock_up, drain: st.drain }
    if (blocked) {
      this.explode(p, ox, oy, oz, null)
      return
    }
    this.projs.push(p)
  }

  /** collect hittable targets along a segment: returns earliest [t, kind, ref] */
  private segTargets(ax: number, ay: number, az: number, bx: number, by: number, bz: number, rad: number, owner: number, team: number, skip?: Set<number>): { t: number; mech?: Mech; npc?: Npc; crate?: Crate } {
    let best = 2
    let res: { t: number; mech?: Mech; npc?: Npc; crate?: Crate } = { t: 2 }
    const dx = bx - ax,
      dy = by - ay,
      dz = bz - az
    const minX = Math.min(ax, bx) - 12,
      maxX = Math.max(ax, bx) + 12,
      minY = Math.min(ay, by) - 12,
      maxY = Math.max(ay, by) + 12
    for (const m of this.mechs) {
      if (!m.alive || m.id === owner) continue
      if (m.x < minX || m.x > maxX || m.y < minY || m.y > maxY) continue
      if (team >= 0 && m.team === team) continue
      if (skip && skip.has(m.id)) continue
      const t = segCyl(ax, ay, az, dx, dy, dz, m.x, m.y, this.radius(m) + rad, m.z, m.z + this.height(m))
      if (t < best) {
        best = t
        res = { t, mech: m }
      }
    }
    for (const n of this.npcs) {
      if (!n.alive || n.id === owner) continue
      if (n.x < minX || n.x > maxX || n.y < minY || n.y > maxY) continue
      if (skip && skip.has(n.id)) continue
      const t = segCyl(ax, ay, az, dx, dy, dz, n.x, n.y, (this.cfg.npc.radius ?? 1.8) + rad, n.z, n.z + (this.cfg.npc.height ?? 3.5))
      if (t < best) {
        best = t
        res = { t, npc: n }
      }
    }
    for (const c of this.crates) {
      if (!c.alive) continue
      if (c.x < minX || c.x > maxX || c.y < minY || c.y > maxY) continue
      if (skip && skip.has(c.id)) continue
      const t = segCyl(ax, ay, az, dx, dy, dz, c.x, c.y, (this.cfg.crates.radius ?? 1.4) + rad, c.z, c.z + (this.cfg.crates.height ?? 2.4))
      if (t < best) {
        best = t
        res = { t, crate: c }
      }
    }
    return res
  }

  private stepProjectiles(dt: number) {
    const g = this.cfg.weapons.mortar.gravity ?? 22
    const keep: Proj[] = []
    for (const p of this.projs) {
      let vx = p.vx,
        vy = p.vy,
        vz = p.vz
      if (p.kind === "mortar") vz -= g * dt
      let stepLen = Math.hypot(vx, vy, vz) * dt
      let frac = 1
      if (p.kind !== "mortar" && p.traveled + stepLen > p.range) {
        frac = Math.max(0, (p.range - p.traveled) / stepLen)
      }
      const ex = p.x + vx * dt * frac,
        ey = p.y + vy * dt * frac,
        ez = p.z + (p.kind === "mortar" ? (p.vz + vz) * 0.5 : vz) * dt * frac
      const tw = this.w.raycast(p.x, p.y, p.z, ex, ey, ez)
      const tg = this.segTargets(p.x, p.y, p.z, ex, ey, ez, p.radius, p.owner, p.team)
      const t = Math.min(tw, tg.t)
      if (t <= 1) {
        const hx = p.x + (ex - p.x) * t,
          hy = p.y + (ey - p.y) * t,
          hz = p.z + (ez - p.z) * t
        if (tg.t <= tw) this.projHit(p, hx, hy, hz, tg)
        else this.projHit(p, hx, hy, hz, null)
        continue
      }
      p.x = ex
      p.y = ey
      p.z = ez
      p.vx = vx
      p.vy = vy
      p.vz = vz
      p.traveled += stepLen * frac
      p.ttl -= dt
      if (p.kind !== "mortar" && (frac < 1 || p.traveled >= p.range - 1e-6)) continue
      if (p.ttl <= 0) {
        if (p.kind === "mortar") this.explode(p, p.x, p.y, p.z, null)
        continue
      }
      if (p.z < -200) continue
      keep.push(p)
    }
    this.projs = keep
  }

  private projHit(p: Proj, x: number, y: number, z: number, tg: { mech?: Mech; npc?: Npc; crate?: Crate } | null) {
    const owner = this.mechById(p.owner)
    const hitId = tg?.mech?.id ?? tg?.npc?.id ?? tg?.crate?.id ?? null
    if (p.kind === "mortar") {
      // back off slightly from the surface
      const l = Math.hypot(p.vx, p.vy, p.vz) || 1
      this.explode(p, x - (p.vx / l) * 0.15, y - (p.vy / l) * 0.15, z - (p.vz / l) * 0.15, tg)
      return
    }
    this.ev({ e: "impact", p: p.id, at: [r2(x), r2(y), r2(z)], hit: hitId })
    if (!tg) return
    // source point for rear: back along the bullet path
    const fx = x - p.vx,
      fy = y - p.vy
    if (p.kind === "npc") {
      if (tg.mech) this.damageMech(tg.mech, p.dmg, null, p.owner, "npc", fx, fy)
      return
    }
    if (tg.mech) this.damageMech(tg.mech, p.dmg, owner ?? null, p.owner, "gun", fx, fy)
    else if (tg.npc) this.damageNpc(tg.npc, p.dmg, owner ?? null, "gun")
    else if (tg.crate) this.damageCrate(tg.crate, p.dmg, owner ?? null, "gun")
  }

  private explode(p: Proj, x: number, y: number, z: number, direct: { mech?: Mech; npc?: Npc; crate?: Crate } | null) {
    const owner = this.mechById(p.owner) ?? null
    const R = owner ? owner.wmods.mortar.splash_radius : (p.splashR ?? 7)
    const edge = p.splashEdge ?? 0.3
    this.sound("explosion", x, y, -1)
    this.ev({ e: "boom", p: p.id, at: [r2(x), r2(y), r2(z)], r: r2(R) })
    const fall = (d: number) => (d >= R ? 0 : 1 - (1 - edge) * (d / R))
    // mechs
    for (const m of this.mechs) {
      if (!m.alive) continue
      const H = this.height(m),
        rr = this.radius(m)
      const dz = z < m.z ? m.z - z : z > m.z + H ? z - (m.z + H) : 0
      const dh = Math.max(0, Math.hypot(m.x - x, m.y - y) - rr)
      const d = Math.hypot(dh, dz)
      const isDirect = direct?.mech === m
      if (d >= R && !isDirect) continue
      if (owner && this.friendly(owner, m)) continue
      // walls block splash
      if (!isDirect && !this.w.los(x, y, z, m.x, m.y, m.z + H * 0.5, false) && !this.w.los(x, y, z, m.x, m.y, m.z + H * 0.9, false)) continue
      const f = isDirect ? 1 : fall(d)
      let dmg = (p.splash ?? 0) * f
      if (isDirect) dmg += p.dmg
      this.damageMech(m, dmg, owner, p.owner, "mortar", x, y, "concuss", owner === m)
      // concussion
      const kx = m.x - x,
        ky = m.y - y
      const kl = Math.hypot(kx, ky)
      const kf = f
      if (kl > 1e-6) {
        m.vx += (kx / kl) * (p.knock ?? 16) * kf
        m.vy += (ky / kl) * (p.knock ?? 16) * kf
      }
      m.vz = Math.max(m.vz, 0) + (p.knockUp ?? 9) * kf
      m.grounded = false
      const drain = (p.drain ?? 45) * kf
      m.energy = Math.max(0, m.energy - drain)
      m.events.push({ type: "effect", effect: "concuss", by: owner ? owner.id : null } as GameEvent)
      m.stats.effects.concuss = (m.stats.effects.concuss ?? 0) + 1
      this.ev({ e: "concuss", id: m.id, by: owner ? owner.id : null, v: [r2((kx / (kl || 1)) * (p.knock ?? 16) * kf), r2((ky / (kl || 1)) * (p.knock ?? 16) * kf), r2((p.knockUp ?? 9) * kf)], drain: r2(drain) })
    }
    for (const n of this.npcs) {
      if (!n.alive) continue
      const nh = this.cfg.npc.height ?? 3.5
      const dz = z < n.z ? n.z - z : z > n.z + nh ? z - (n.z + nh) : 0
      const d = Math.hypot(Math.max(0, Math.hypot(n.x - x, n.y - y) - (this.cfg.npc.radius ?? 1.8)), dz)
      const isDirect = direct?.npc === n
      if (d >= R && !isDirect) continue
      if (!isDirect && !this.w.los(x, y, z, n.x, n.y, n.z + nh * 0.5, false)) continue
      let dmg = (p.splash ?? 0) * (isDirect ? 1 : fall(d))
      if (isDirect) dmg += p.dmg
      this.damageNpc(n, dmg, owner, "mortar")
    }
    for (const c of this.crates) {
      if (!c.alive) continue
      const ch = this.cfg.crates.height ?? 2.4
      const dz = z < c.z ? c.z - z : z > c.z + ch ? z - (c.z + ch) : 0
      const d = Math.hypot(Math.max(0, Math.hypot(c.x - x, c.y - y) - (this.cfg.crates.radius ?? 1.4)), dz)
      const isDirect = direct?.crate === c
      if (d >= R && !isDirect) continue
      if (!isDirect && !this.w.los(x, y, z, c.x, c.y, c.z + ch * 0.5, false)) continue
      let dmg = (p.splash ?? 0) * (isDirect ? 1 : fall(d))
      if (isDirect) dmg += p.dmg
      this.damageCrate(c, dmg, owner, "mortar")
    }
  }

  private fireLaser(m: Mech, st: Record<string, number>, charge: number) {
    const frac = (st.min_frac ?? 0.35) + (1 - (st.min_frac ?? 0.35)) * Math.min(1, charge / st.charge)
    const base = st.damage * frac * this.cubeMul(m)
    const d = this.aimDir(m)
    const [ox, oy, oz, blocked] = this.shotOrigin(m, d, m.ms.muzzle_height)
    this.sound("laser", m.x, m.y, m.id)
    let ex = ox + d[0] * st.range,
      ey = oy + d[1] * st.range,
      ez = oz + d[2] * st.range
    const hits: number[] = []
    if (!blocked) {
      const tw = this.w.raycast(ox, oy, oz, ex, ey, ez)
      const tEnd = Math.min(tw, 1)
      const skip = new Set<number>()
      let pierce = Math.round(st.pierce ?? 0)
      for (let k = 0; k < 1 + pierce; k++) {
        const tg = this.segTargets(ox, oy, oz, ex, ey, ez, 0.0, m.id, m.team, skip)
        if (tg.t > tEnd) break
        const id = tg.mech?.id ?? tg.npc?.id ?? tg.crate?.id
        if (id === undefined) break
        skip.add(id)
        hits.push(id)
        if (tg.mech) {
          const cook = tg.mech.slots.some((s) => s && s.kind === "mortar")
          const dmg = base * (cook ? 1 + (st.cookoff ?? 0.6) : 1)
          if (cook) {
            tg.mech.events.push({ type: "effect", effect: "cookoff", by: m.id } as GameEvent)
            this.ev({ e: "cookoff", id: tg.mech.id, by: m.id, at: [r2(tg.mech.x), r2(tg.mech.y), r2(tg.mech.z + 4.5)] })
          }
          this.damageMech(tg.mech, dmg, m, m.id, "laser", ox, oy, cook ? "cookoff" : undefined)
        } else if (tg.npc) this.damageNpc(tg.npc, base, m, "laser")
        else if (tg.crate) this.damageCrate(tg.crate, base, m, "laser")
      }
      if (tw <= 1 && (hits.length === 0 || hits.length <= pierce)) {
        ex = ox + (ex - ox) * tw
        ey = oy + (ey - oy) * tw
        ez = oz + (ez - oz) * tw
      } else if (hits.length > pierce) {
        // beam ends at last target hit
        const last = hits[hits.length - 1]
        const tm = this.mechById(last)
        const tn = this.npcs.find((n) => n.id === last)
        const tc = this.crates.find((c) => c.id === last)
        const px = tm?.x ?? tn?.x ?? tc?.x ?? ex,
          py = tm?.y ?? tn?.y ?? tc?.y ?? ey
        const L = Math.hypot(px - ox, py - oy)
        const tt = L / Math.max(1e-6, Math.hypot(ex - ox, ey - oy))
        ex = ox + (ex - ox) * tt
        ey = oy + (ey - oy) * tt
        ez = oz + (ez - oz) * tt
      }
    } else {
      ex = ox
      ey = oy
      ez = oz
    }
    this.beamsPending.push({ by: m.id, team: m.team, kind: "laser", path: [[ox, oy, oz], [ex, ey, ez]], t: this.t })
    this.ev({ e: "laser", id: m.id, from: [r2(ox), r2(oy), r2(oz)], to: [r2(ex), r2(ey), r2(ez)], hits })
  }

  private fireLightning(m: Mech, st: Record<string, number>) {
    const size = this.size(m)
    const mx = m.x,
      my = m.y,
      mz = m.z + m.ms.muzzle_height * size
    const range = st.range
    const half = ((st.cone_deg ?? 30) * Math.PI) / 360
    type T = { id: number; x: number; y: number; z: number; mech?: Mech; npc?: Npc; crate?: Crate }
    const cands: T[] = []
    for (const o of this.mechs) if (o.alive && o !== m && !this.friendly(m, o)) cands.push({ id: o.id, x: o.x, y: o.y, z: o.z + this.height(o) * 0.5, mech: o })
    for (const n of this.npcs) if (n.alive) cands.push({ id: n.id, x: n.x, y: n.y, z: n.z + (this.cfg.npc.height ?? 3.5) / 2, npc: n })
    for (const c of this.crates) if (c.alive) cands.push({ id: c.id, x: c.x, y: c.y, z: c.z + (this.cfg.crates.height ?? 2.4) / 2, crate: c })
    let first: T | null = null
    let bd = Infinity
    for (const c of cands) {
      const d = Math.hypot(c.x - mx, c.y - my, c.z - mz)
      if (d > range || d >= bd) continue
      const by = Math.atan2(c.y - my, c.x - mx)
      if (Math.abs(wrap(by - m.yaw)) > half && Math.hypot(c.x - mx, c.y - my) > 3) continue
      if (!this.w.los(mx, my, mz, c.x, c.y, c.z, false)) continue
      bd = d
      first = c
    }
    this.sound("lightning", m.x, m.y, m.id)
    const path: number[][] = [[mx, my, mz]]
    const hits: number[] = []
    if (!first) {
      const d = this.aimDir(m)
      const ex = mx + d[0] * range,
        ey = my + d[1] * range,
        ez = mz + d[2] * range
      const t = this.w.raycast(mx, my, mz, ex, ey, ez)
      const tt = Math.min(1, t)
      path.push([mx + d[0] * range * tt, my + d[1] * range * tt, mz + d[2] * range * tt])
    } else {
      let cur: T = first
      let dmg = st.damage * this.cubeMul(m)
      const hitSet = new Set<number>()
      let prevX = mx,
        prevY = my
      for (let k = 0; k <= Math.round(st.chain ?? 2); k++) {
        hitSet.add(cur.id)
        hits.push(cur.id)
        path.push([cur.x, cur.y, cur.z])
        if (cur.mech) {
          const tgm = cur.mech
          const hasLaser = tgm.slots.some((s) => s && s.kind === "laser")
          if (hasLaser) {
            for (const s of tgm.slots)
              if (s && s.kind === "laser") {
                s.charging = false
                s.charge = 0
                s.fullT = 0
                s.release = false
              }
            tgm.shortUntil = this.t + (st.short_s ?? 2)
            tgm.events.push({ type: "effect", effect: "short", by: m.id } as GameEvent)
            this.ev({ e: "short", id: tgm.id, by: m.id, cancelled: false, dur: st.short_s ?? 2 })
          }
          this.damageMech(tgm, dmg, m, m.id, "lightning", prevX, prevY, hasLaser ? "short" : undefined)
        } else if (cur.npc) this.damageNpc(cur.npc, dmg, m, "lightning")
        else if (cur.crate) this.damageCrate(cur.crate, dmg, m, "lightning")
        // next jump
        let nxt: T | null = null
        let nd = Infinity
        for (const c of cands) {
          if (hitSet.has(c.id)) continue
          if (c.mech && !c.mech.alive) continue
          if (c.npc && !c.npc.alive) continue
          if (c.crate && !c.crate.alive) continue
          const d = Math.hypot(c.x - cur.x, c.y - cur.y, c.z - cur.z)
          if (d > (st.chain_range ?? 14) || d >= nd) continue
          if (!this.w.los(cur.x, cur.y, cur.z, c.x, c.y, c.z, false)) continue
          nd = d
          nxt = c
        }
        if (!nxt) break
        prevX = cur.x
        prevY = cur.y
        cur = nxt
        dmg *= st.chain_falloff ?? 0.7
      }
    }
    this.beamsPending.push({ by: m.id, team: m.team, kind: "lightning", path, t: this.t })
    this.ev({ e: "zap", id: m.id, path: path.map((p) => [r2(p[0]), r2(p[1]), r2(p[2])]), hits })
  }

  // ------------------------------------------------------------------ npcs
  private stepNpcs(dt: number) {
    const nc = this.cfg.npc
    const w = this.w
    for (const n of this.npcs) {
      if (!n.alive) continue
      n.cooldown = Math.max(0, n.cooldown - dt)
      const homeD = Math.hypot(n.x - n.hx, n.y - n.hy)
      let tgt = n.target !== null ? this.mechById(n.target) : undefined
      if (tgt && (!tgt.alive || Math.hypot(tgt.x - n.x, tgt.y - n.y) > (nc.deaggro_range ?? 90) || homeD > (nc.chase_leash ?? 60))) {
        n.target = null
        tgt = undefined
        n.returning = true
      }
      n.scanT -= dt
      if (!tgt && n.scanT <= 0 && homeD <= (nc.leash ?? 30)) {
        n.scanT = 0.5
        let best: Mech | undefined
        let bd = nc.aggro_range ?? 45
        for (const m of this.mechs) {
          if (!m.alive) continue
          const d = Math.hypot(m.x - n.x, m.y - n.y, m.z - n.z)
          if (d > bd) continue
          if (!w.los(n.x, n.y, n.z + 3, m.x, m.y, m.z + this.height(m) * 0.5, false)) continue
          bd = d
          best = m
        }
        if (best) {
          n.target = best.id
          tgt = best
          n.returning = false
        }
      }
      let gx = n.wx,
        gy = n.wy
      let spd = nc.speed ?? 5
      if (tgt) {
        const d = Math.hypot(tgt.x - n.x, tgt.y - n.y)
        n.yaw = Math.atan2(tgt.y - n.y, tgt.x - n.x)
        if (d > 25) {
          gx = tgt.x
          gy = tgt.y
        } else {
          gx = n.x
          gy = n.y
        }
        if (n.cooldown <= 0) {
          const tz = tgt.z + this.height(tgt) * 0.5
          const ez = n.z + 3
          if (w.los(n.x, n.y, ez, tgt.x, tgt.y, tz, false)) {
            const sp = ((nc.spread_deg ?? 2.5) * Math.PI) / 180
            const dd = Math.hypot(tgt.x - n.x, tgt.y - n.y, tz - ez)
            const yaw = Math.atan2(tgt.y - n.y, tgt.x - n.x) + this.rng.gauss() * sp
            const pitch = Math.asin((tz - ez) / Math.max(dd, 1e-6)) + this.rng.gauss() * sp
            const v = nc.projectile_speed ?? 90
            const cp = Math.cos(pitch)
            const id = this.nextProj++
            this.projs.push({ id, kind: "npc", owner: n.id, team: -2, x: n.x + Math.cos(yaw) * 2.3, y: n.y + Math.sin(yaw) * 2.3, z: ez, vx: cp * Math.cos(yaw) * v, vy: cp * Math.sin(yaw) * v, vz: Math.sin(pitch) * v, traveled: 0, range: 200, ttl: 3, dmg: nc.damage ?? 25, radius: this.cfg.projectile.npc_radius ?? 0.3 })
            this.sound("npc_gun", n.x, n.y, n.id)
            n.cooldown = nc.cooldown ?? 1
          }
        }
      } else if (n.returning) {
        gx = n.hx
        gy = n.hy
        if (homeD < 3) n.returning = false
      } else {
        n.wanderT -= dt
        if (n.wanderT <= 0 || Math.hypot(n.wx - n.x, n.wy - n.y) < 1.5) {
          const a = this.rng.next() * TAU
          const r = Math.sqrt(this.rng.next()) * (nc.leash ?? 30)
          n.wx = n.hx + Math.cos(a) * r
          n.wy = n.hy + Math.sin(a) * r
          n.wanderT = 3 + this.rng.next() * 5
        }
        gx = n.wx
        gy = n.wy
        spd *= 0.6
      }
      const dx = gx - n.x,
        dy = gy - n.y
      const dl = Math.hypot(dx, dy)
      if (dl > 0.5) {
        const vx = (dx / dl) * spd,
          vy = (dy / dl) * spd
        const nx = n.x + vx * dt,
          ny = n.y + vy * dt
        const nz = w.support(nx, ny, n.z + 1.2)
        if (Math.abs(nz - n.z) < 1.3 && w.discClear(nx, ny, nz, nc.radius ?? 1.8, nc.height ?? 3.5, 1.2)) {
          n.x = nx
          n.y = ny
          n.z = nz
          n.vx = vx
          n.vy = vy
          if (!tgt) n.yaw = Math.atan2(vy, vx)
        } else {
          n.vx = 0
          n.vy = 0
          n.wanderT = 0
        }
      } else {
        n.vx = 0
        n.vy = 0
      }
    }
  }

  // ------------------------------------------------------------------ items / drops
  private stepItems(dt: number) {
    const pr = this.cfg.cubes.pickup_radius as number
    if (this.cubes.length) {
      const keep: Cube[] = []
      for (const c of this.cubes) {
        let best: Mech | null = null
        let bd = Infinity
        for (const m of this.mechs) {
          if (!m.alive || m.pendingDying) continue
          const d = Math.hypot(m.x - c.x, m.y - c.y)
          if (d > pr || Math.abs(m.z - c.z) > 4) continue
          if (d < bd - 1e-9) {
            bd = d
            best = m
          }
        }
        if (best) {
          this.addCubes(best, 1)
          best.events.push({ type: "pickup", cubes: best.cubes } as GameEvent)
          this.ev({ e: "pickup", id: c.id, by: best.id })
        } else keep.push(c)
      }
      this.cubes = keep
    }
    const dc = this.cfg.drops
    if (dc) {
      for (const d of this.drops) {
        if (d.taken) continue
        if (!d.landed && this.t >= d.landT - 1e-9) {
          d.landed = true
          this.sound("drop", d.x, d.y, -1)
          this.ev({ e: "drop", op: "land", id: d.id })
        }
        if (!d.landed) continue
        const inside: Mech[] = []
        for (const m of this.mechs) if (m.alive && !m.pendingDying && Math.hypot(m.x - d.x, m.y - d.y) <= dc.radius && Math.abs(m.z - d.z) < 6) inside.push(m)
        if (inside.length === 0) {
          d.holder = null
          d.progress = 0
        } else if (inside.length === 1) {
          const m = inside[0]
          if (d.holder !== m.id) {
            d.holder = m.id
            d.progress = 0
          }
          d.progress += dt
          if (d.progress >= dc.capture_s - 1e-9) {
            d.taken = true
            this.addCubes(m, dc.cubes)
            m.hp = this.maxHp(m) * Math.max(1, dc.repair ?? 1) > m.hp ? this.maxHp(m) : m.hp
            m.energy = m.ms.energy
            m.events.push({ type: "drop", id: d.id, cubes: m.cubes } as GameEvent)
            m.stats.dropsTaken++
            this.ev({ e: "drop", op: "take", id: d.id, by: m.id })
          }
        }
      }
    }
  }

  private callDrop(i: number) {
    const dc = this.cfg.drops
    if (!dc) return
    const zn = this.zoneNow()
    const nxt = this.circles[Math.min(zn.k, this.circles.length - 1)]
    const R = Math.max(5, nxt.r * (dc.spread ?? 0.7))
    const [x, y, z] = this.openPoint(nxt.cx, nxt.cy, R, 20, 3)
    const id = 20000 + i
    const d: Drop = { id, x, y, z, callT: this.t, landT: this.t + dc.fall_s, holder: null, progress: 0, taken: false, landed: false }
    this.drops.push(d)
    this.ev({ e: "drop", op: "call", id, at: [r2(x), r2(y), r2(z)], lands: Math.round(d.landT / this.dt), r: dc.radius })
  }

  // ------------------------------------------------------------------ deaths / end
  onDeath?: (m: Mech) => void

  private resolveDeaths() {
    const dying = this.mechs.filter((m) => m.alive && m.pendingDying)
    if (!dying.length) return
    const place = this.aliveCount
    for (const m of dying) {
      m.alive = false
      m.place = place
      m.deathT = this.t
      if (m.killedBy !== null) {
        const k = this.mechById(m.killedBy)
        if (k) {
          k.stats.kills++
          k.events.push({ type: "kill", target: m.id } as GameEvent)
        }
      }
      this.ev({ e: "death", id: m.id, by: m.killedBy, place })
      this.sound("death", m.x, m.y, m.id)
      // drops: cubes + extra, weapons except gun
      const extra = (this.cfg.cubes.death_drop_extra as number) ?? 2
      this.spawnCubes(m.x, m.y, m.z, m.cubes + extra, 3)
      if (this.cfg.loot.death_drop) {
        for (let s = 0; s < 2; s++) {
          const w = m.slots[s]
          if (!w || w.kind === "gun") continue
          w.charging = false
          w.charge = 0
          const id = this.nextPickup++
          const a = this.rng.next() * TAU
          const px = m.x + Math.cos(a) * 1.5,
            py = m.y + Math.sin(a) * 1.5
          const pz = this.w.support(px, py, m.z + 1.2)
          this.pickups.push({ id, kind: w.kind, x: px, y: py, z: pz, w })
          this.ev({ e: "weapon", op: "spawn", id, kind: w.kind, at: [r2(px), r2(py), r2(pz)], src: m.id })
        }
      }
      m.slots = [null, null]
    }
    this.aliveCount -= dying.length
    for (const m of dying) this.onDeath?.(m)
    if (this.aliveCount <= 1) {
      for (const m of this.mechs)
        if (m.alive) {
          m.place = 1
        }
      this.finish()
    }
  }

  private endByTime() {
    const alive = this.mechs.filter((m) => m.alive)
    for (const m of alive) m.place = 1 + alive.filter((o) => o.hp > m.hp + 1e-9).length
    this.finish()
  }

  private finish() {
    this.over = true
    this.ev({ e: "end", tick: this.tick, places: this.mechs.map((m) => m.place) })
  }

  // ------------------------------------------------------------------ observations
  private visGroup(m: Mech): string {
    return this.sharedVision && m.team >= 0 ? "t" + m.team : "m" + m.id
  }

  /**
   * Can `m` see a point (target center/top)? near: 45 m any direction (canopy doesn't block);
   * far: range + fov wedge on torso yaw (canopy blocks).
   */
  canSee(m: Mech, ex: number, ey: number, ez: number, tx: number, ty: number, tzc: number, tzt: number): boolean {
    const vc = this.cfg.vision
    const near = vc.near_range + (m.ms.near_range_bonus ?? 0)
    const range = vc.range + (m.ms.vision_bonus ?? 0)
    const dx = tx - ex,
      dy = ty - ey
    const dh = Math.hypot(dx, dy)
    const d3c = Math.hypot(dh, tzc - ez)
    if (d3c > range + 10) return false
    const inNear = d3c <= near
    let inWedge = false
    if (d3c <= range) {
      const b = Math.atan2(dy, dx)
      inWedge = Math.abs(wrap(b - m.yaw)) <= (vc.fov_deg * Math.PI) / 360 || dh < 1
    }
    if (!inNear && !inWedge) return false
    const canopy = vc.canopy_blocks !== false
    // near: canopy doesn't block; far: it does
    if (this.w.los(ex, ey, ez, tx, ty, tzc, inNear ? false : canopy)) return true
    if (this.w.los(ex, ey, ez, tx, ty, tzt, inNear ? false : canopy)) return true
    return false
  }

  /** update vision memory for every observer group; call once per decision before observe() */
  updateVision() {
    const memS = this.cfg.vision.memory_s ?? 5
    this.visibleNow.clear()
    for (const m of this.mechs) {
      if (!m.alive) continue
      const g = this.visGroup(m)
      let mem = this.memory.get(g)
      if (!mem) {
        mem = new Map()
        this.memory.set(g, mem)
      }
      let now = this.visibleNow.get(g)
      if (!now) {
        now = new Set()
        this.visibleNow.set(g, now)
      }
      const ex = m.x,
        ey = m.y,
        ez = this.eyeZ(m)
      for (const o of this.mechs) {
        if (!o.alive || o === m) continue
        if (now.has(o.id)) continue
        const H = this.height(o)
        if (this.canSee(m, ex, ey, ez, o.x, o.y, o.z + H * 0.5, o.z + H)) {
          now.add(o.id)
          mem.set(o.id, this.t)
        }
      }
      const nh = this.cfg.npc.height ?? 3.5
      for (const n of this.npcs) {
        if (!n.alive || now.has(n.id)) continue
        if (this.canSee(m, ex, ey, ez, n.x, n.y, n.z + nh * 0.5, n.z + nh)) {
          now.add(n.id)
          mem.set(n.id, this.t)
        }
      }
      void memS
    }
  }

  private fmtWeapon(m: Mech, w: Weapon) {
    const st: Record<string, number> = {}
    for (const [k, v] of Object.entries(m.wmods[w.kind])) st[k] = typeof v === "number" ? Math.round(v * 10000) / 10000 : v
    const o: any = { kind: w.kind, cooldown: r2(Math.max(0, w.cooldown)), stats: st }
    if (w.kind === "gun") {
      o.ammo = w.ammo
      o.reload = r2(Math.max(0, w.reload))
    }
    if (w.kind === "laser") o.charge = r2(w.charging ? w.charge : 0)
    return o
  }

  selfStats(m: Mech): Record<string, number> {
    const s: Record<string, number> = {}
    const size = this.size(m)
    for (const [k, v] of Object.entries(m.ms)) s[k] = Math.round(v * 10000) / 10000
    s.radius = r3(m.ms.radius * size)
    s.height = r3(m.ms.height * size)
    s.eye_height = r3(m.ms.eye_height * size)
    s.muzzle_height = r3(m.ms.muzzle_height * size)
    return s
  }

  /** build the observation for mech m (call updateVision() first in this decision) */
  observe(m: Mech): Observation {
    const memS = this.cfg.vision.memory_s ?? 5
    const g = this.visGroup(m)
    const mem = this.memory.get(g) ?? new Map<number, number>()
    const ex = m.x,
      ey = m.y,
      ez = this.eyeZ(m)
    const mechs: ActorObs[] = []
    const showHp = this.cfg.vision.show_enemy_hp !== false
    for (const o of this.mechs) {
      if (!o.alive || o === m) continue
      const seen = mem.get(o.id)
      if (seen === undefined || this.t - seen > memS + 1e-9) continue
      const a: any = { id: o.id, kind: "mech", pos: [r2(o.x), r2(o.y), r2(o.z)], vel: [r2(o.vx), r2(o.vy), r2(o.grounded ? 0 : o.vz)], aim: [r3(o.yaw), r3(o.pitch)] }
      if (showHp) {
        a.hp = r2(o.hp)
        a.max_hp = r2(this.maxHp(o))
      }
      a.cubes = o.cubes
      a.weapons = o.slots.filter((s) => s).map((s) => s!.kind)
      a.charging = o.slots.some((s) => s && s.kind === "laser" && s.charging)
      mechs.push(a)
    }
    for (const n of this.npcs) {
      if (!n.alive) continue
      const seen = mem.get(n.id)
      if (seen === undefined || this.t - seen > memS + 1e-9) continue
      const a: any = { id: n.id, kind: "npc", pos: [r2(n.x), r2(n.y), r2(n.z)], vel: [r2(n.vx), r2(n.vy), 0], aim: [r3(n.yaw), 0] }
      if (showHp) {
        a.hp = r2(n.hp)
        a.max_hp = this.cfg.npc.hp
      }
      mechs.push(a)
    }
    const projectiles: any[] = []
    if (!m.lite)
      for (const p of this.projs) {
        if (p.owner === m.id) continue
        if (this.canSee(m, ex, ey, ez, p.x, p.y, p.z, p.z)) projectiles.push({ id: p.id, kind: p.kind, pos: [r2(p.x), r2(p.y), r2(p.z)], vel: [r2(p.vx), r2(p.vy), r2(p.vz)] })
      }
    const ch = this.cfg.crates.height ?? 2.4
    const refresh = !m.lite || this.t - m.itemCacheT > 0.25
    const iv = m.itemVis
    if (refresh) {
      m.itemCacheT = this.t
      iv.crates.clear()
      iv.cubes.clear()
      iv.pickups.clear()
      for (const c of this.crates) if (c.alive && this.canSee(m, ex, ey, ez, c.x, c.y, c.z + ch * 0.5, c.z + ch)) iv.crates.add(c.id)
      for (const c of this.cubes) if (this.canSee(m, ex, ey, ez, c.x, c.y, c.z + 0.5, c.z + 1)) iv.cubes.add(c.id)
      for (const p of this.pickups) if (this.canSee(m, ex, ey, ez, p.x, p.y, p.z + 0.5, p.z + 1)) iv.pickups.add(p.id)
    }
    const crates: any[] = []
    for (const c of this.crates) if (c.alive && iv.crates.has(c.id)) crates.push({ id: c.id, pos: [r2(c.x), r2(c.y), r2(c.z)], hp: r2(c.hp) })
    const cubes: any[] = []
    for (const c of this.cubes) if (iv.cubes.has(c.id)) cubes.push({ id: c.id, pos: [r2(c.x), r2(c.y), r2(c.z)] })
    const pickups: any[] = []
    for (const p of this.pickups) if (iv.pickups.has(p.id)) pickups.push({ id: p.id, kind: p.kind, pos: [r2(p.x), r2(p.y), r2(p.z)] })
    const zn = this.zoneNow()
    const nxt = this.circles[Math.min(zn.k, this.circles.length - 1)]
    const drops: any[] = []
    for (const d of this.drops) {
      if (d.taken) continue
      drops.push({ id: d.id, pos: [r2(d.x), r2(d.y), r2(d.z)], radius: this.cfg.drops!.radius, lands_in: r2(Math.max(0, d.landT - this.t)), capture_s: this.cfg.drops!.capture_s, progress: r2(d.progress), holder: d.holder })
    }
    const weapons = m.slots.map((w) => (w ? this.fmtWeapon(m, w) : null)) as any
    const obs: Observation = {
      type: "obs",
      tick: this.tick,
      t: r2(this.t),
      alive: this.aliveCount,
      self: {
        id: m.id,
        pos: [r2(m.x), r2(m.y), r2(m.z)],
        vel: [r2(m.vx), r2(m.vy), r2(m.grounded ? 0 : m.vz)],
        aim: [r3(m.yaw), r3(m.pitch)],
        hp: r2(m.hp),
        max_hp: r2(this.maxHp(m)),
        energy: r1(m.energy),
        max_energy: r2(m.ms.energy),
        grounded: m.grounded,
        cubes: m.cubes,
        upgrades: [...m.upList],
        weapons,
        in_zone: Math.hypot(m.x - zn.cx, m.y - zn.cy) <= zn.r,
        stats: this.selfStats(m),
      },
      mechs,
      projectiles,
      crates,
      cubes,
      pickups,
      sounds: m.sounds,
      beams: m.beams,
      events: m.events,
      zone: { center: [r2(zn.cx), r2(zn.cy)], radius: r2(zn.r), next_center: [r2(nxt.cx), r2(nxt.cy)], next_radius: r2(nxt.r), shrink_start: r2(nxt.shrinkStart), shrink_end: r2(nxt.shrinkEnd), dps: zn.dps },
      offer: m.offer ? { id: m.offer.id, expires: m.offer.expires, choices: m.offer.choices.map((u) => ({ id: u.id, name: u.name, desc: u.desc })) } : null,
      drops,
    }
    return obs
  }

  /** distribute pending sounds and beams to every mech's per-decision lists; call before observe() */
  distributePerception() {
    const sc = this.cfg.sound
    // measured bearing noise SD on the real stream is ~9.5 deg with bearing_noise_deg 7
    const noise = ((sc.bearing_noise_deg ?? 7) * (9.5 / 7) * Math.PI) / 180
    for (const m of this.mechs) {
      if (!m.alive) continue
      m.sounds = []
      m.beams = []
      for (const s of this.soundsPending) {
        if (s.src === m.id) continue
        const d = Math.hypot(s.x - m.x, s.y - m.y)
        const rng = (sc.range as any)[s.kind] ?? 100
        if (d > rng) continue
        const b = Math.atan2(s.y - m.y, s.x - m.x) + this.rng.gauss() * noise * (m.ms.hearing ?? 1)
        m.sounds.push({ kind: s.kind, bearing: r3(wrap(b)), dist: d < sc.near ? "near" : d < sc.mid ? "mid" : "far", age: r2(this.t - s.t) })
      }
      if (this.beamsPending.length && !m.lite) {
        const ex = m.x,
          ey = m.y,
          ez = this.eyeZ(m)
        for (const bm of this.beamsPending) {
          if (bm.by === m.id) continue
          let seen = false
          const P = bm.path
          for (let i = 0; i < P.length && !seen; i++) {
            if (this.canSee(m, ex, ey, ez, P[i][0], P[i][1], P[i][2], P[i][2])) seen = true
            if (!seen && i > 0) {
              const mx = (P[i][0] + P[i - 1][0]) / 2,
                my = (P[i][1] + P[i - 1][1]) / 2,
                mz = (P[i][2] + P[i - 1][2]) / 2
              if (this.canSee(m, ex, ey, ez, mx, my, mz, mz)) seen = true
            }
          }
          if (seen) m.beams.push({ by: bm.by, kind: bm.kind, path: P.map((p) => [r2(p[0]), r2(p[1]), r2(p[2])]) as any, age: r2(this.t - bm.t) })
        }
      }
    }
    this.soundsPending = []
    this.beamsPending = []
  }

  /** after observations are taken: clear event lists */
  clearEvents() {
    for (const m of this.mechs) m.events = []
  }

  // ------------------------------------------------------------------ replay
  header() {
    const c = this.cfg
    return {
      type: "header",
      format: "mechreplay/1",
      tick_hz: c.match.tick_hz ?? 20,
      frame_every: c.replay?.frame_every ?? 2,
      seed: this.seed,
      frame: "x east, y north, z up, meters (viewer/public/arena/collision.json)",
      fields: {
        m: ["id", "x", "y", "z", "aim_yaw", "aim_pitch", "hp", "energy", "flags", "cubes", "max_hp", "slot0", "slot1"],
        slot: "index into weapon_kinds, -1 = empty",
        n: ["id", "x", "y", "z", "yaw", "hp"],
        p: ["id", "kind(0 gun,1 mortar,2 npc)", "x", "y", "z"],
        z: ["cx", "cy", "r"],
        d: ["id", "state(0 inbound,1 landed,2 capturing,3 contested)", "holder", "progress 0..1"],
        flags: { "1": "grounded", "2": "boosting", "4": "laser charging" },
      },
      protocol: "mechfight/1",
      bots: this.mechs.map((m) => m.name),
      mechs: this.mechs.map((m) => ({ id: m.id, name: m.name.slice(0, 32), weapons: ["gun"], slots: ["gun", null], spawn: [r2(m.x), r2(m.y), r2(m.z)] })),
      npcs: this.npcs.map((n) => ({ id: n.id, spawn: [r2(n.x), r2(n.y), r2(n.z)] })),
      crates: this.crates.map((c) => ({ id: c.id, pos: [r2(c.x), r2(c.y), r2(c.z)] })),
      weapon_kinds: KINDS,
      pickups: this.pickups.map((p) => ({ id: p.id, kind: p.kind, pos: [r2(p.x), r2(p.y), r2(p.z)] })),
      drops: [] as any[],
      zone: this.circles.map((c) => ({ center: [r2(c.cx), r2(c.cy)], radius: c.r, shrink_start: c.shrinkStart, shrink_end: c.shrinkEnd })),
    }
  }

  private frame() {
    const kindIdx = (w: Weapon | null) => (w ? KINDS.indexOf(w.kind) : -1)
    const f: any = {
      t: this.tick,
      m: this.mechs
        .filter((m) => m.alive || m.deathT === this.t)
        .map((m) => [m.id, r2(m.x), r2(m.y), r2(m.z), r2(m.yaw), r2(m.pitch), r2(m.hp), Math.round(m.energy), (m.grounded ? 1 : 0) | (m.boosting || m.jetting ? 2 : 0) | (m.slots.some((s) => s && s.kind === "laser" && s.charging) ? 4 : 0), m.cubes, r2(this.maxHp(m)), kindIdx(m.slots[0]), kindIdx(m.slots[1])]),
      n: this.npcs.filter((n) => n.alive).map((n) => [n.id, r2(n.x), r2(n.y), r2(n.z), r2(n.yaw), r2(n.hp)]),
      p: this.projs.map((p) => [p.id, p.kind === "gun" ? 0 : p.kind === "mortar" ? 1 : 2, r2(p.x), r2(p.y), r2(p.z)]),
      z: (() => {
        const z = this.zoneNow()
        return [r2(z.cx), r2(z.cy), r2(z.r)]
      })(),
    }
    if (this.frameEv.length) f.ev = this.frameEv
    const ds = this.drops.filter((d) => !d.taken)
    if (ds.length) {
      const dc = this.cfg.drops!
      f.d = ds.map((d) => {
        let state = d.landed ? 1 : 0
        if (d.landed && d.holder !== null) {
          const inside = this.mechs.filter((m) => m.alive && Math.hypot(m.x - d.x, m.y - d.y) <= dc.radius).length
          state = inside > 1 ? 3 : 2
        }
        return [d.id, state, d.holder ?? -1, r2(d.progress / dc.capture_s)]
      })
    }
    this.frameEv = []
    this.frames.push(f)
  }

  result() {
    return {
      type: "result",
      ticks: this.tick,
      mechs: this.mechs.map((m) => ({
        id: m.id,
        name: m.name,
        place: m.place,
        kills: m.stats.kills,
        damage_dealt: Math.round(m.stats.damageDealt),
        damage_taken: Math.round(m.stats.damageTaken),
        damage_by_weapon: Object.fromEntries(Object.entries(m.stats.damageByWeapon).map(([k, v]) => [k, Math.round(v)])),
        cubes_max: m.stats.cubesMax,
        upgrades: m.upList,
        loadout: m.slots.filter((s) => s).map((s) => s!.kind),
        first_weapon_t: m.stats.firstWeaponT,
        weapons_taken: m.stats.weaponsTaken,
        death_t: m.deathT === null ? null : r2(m.deathT),
        killed_by: m.killedBy,
        killed_with: m.alive ? null : m.killedWith,
        killer_loadout: m.killedBy !== null ? (this.mechById(m.killedBy)?.slots.filter((s) => s).map((s) => s!.kind) ?? null) : null,
        effects: m.stats.effects,
        drops_taken: m.stats.dropsTaken,
      })),
    }
  }
}

/** segment (origin a, delta d over t in [0,1]) vs vertical cylinder; first t or 2 */
export function segCyl(ax: number, ay: number, az: number, dx: number, dy: number, dz: number, cx: number, cy: number, r: number, zb: number, zt: number): number {
  const h = segCircle(ax - cx, ay - cy, dx, dy, r)
  if (!h) return 2
  let [t0, t1] = h
  if (Math.abs(dz) < 1e-12) {
    if (az < zb || az > zt) return 2
    return t0
  }
  const ta = (zb - az) / dz,
    tb = (zt - az) / dz
  const lo = Math.max(t0, Math.min(ta, tb)),
    hi = Math.min(t1, Math.max(ta, tb))
  return lo <= hi ? lo : 2
}
