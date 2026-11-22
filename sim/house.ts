/**
 * In-process house-like bots (archetypes in sim/archetypes.json) and the practice-mode squad controller.
 * House bots act only on the Observation the engine builds for them (real visibility rules, plus shared
 * squad vision in squad mode). The one exception is the squad directive `hunters_know_position`.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { BotAction, Hello, Observation, ActorObs, WeaponObs } from "../src/mechfight.ts"
import type { Agent } from "./agents.ts"
import type { Match, Mech } from "./match.ts"
import { Rng, hashSeed } from "./rng.ts"
import { getNav, type NavGrid } from "./nav.ts"
import { ROOT } from "./config.ts"

export interface Archetype {
  reaction_s: number
  aim_sigma_deg: number
  lead_frac: number
  fire_range_m: { gun: number; laser: number; mortar: number; lightning: number }
  preferred_range_m: number
  retreat_hp_frac: number
  strafe: number
  boost_frac: number
  loot_weapon_first: boolean
  weapon_pref: string[]
  farm_cubes: boolean
  upgrade_pref: string[]
  /** optional extras (sim-specific) */
  engage_range_m?: number
  aggression?: number
  third_party?: boolean
  use_drops?: boolean
  /** chance that a new roam goal is "hold this spot" for 15-30 s (top bots stand still 43% of the time) */
  camp?: number
  /** per-archetype override of the global fire_duty knob */
  fire_duty?: number
}

let archCache: { archetypes: Record<string, Archetype>; tiers: Record<string, string> } | null = null
export function loadArchetypes(path = join(ROOT, "sim/archetypes.json")) {
  if (!archCache) archCache = JSON.parse(readFileSync(path, "utf8"))
  return archCache!
}
export function setArchetypes(a: { archetypes: Record<string, Archetype>; tiers: Record<string, string> }) {
  archCache = a
}

/** global house-bot skill knobs (sim calibration): multiply aim sigma / reaction / lead of every archetype */
export interface HouseTuning {
  aim_mul: number
  react_mul: number
  lead_mul: number
  /** house bots hop (jump + jet) while fighting with this probability per second */
  hop_rate: number
  /** fraction of time the trigger is actually held when a shot is available (burst windows) */
  fire_duty: number
  /** multiplies retreat_hp_frac (0 = never retreat; the replay shows no HP-triggered retreat) */
  retreat_mul: number
}
/** fire_duty 0.45: real house bots fire ~0.5-0.8 gun shots/s with an enemy inside 150 m (replay), ours 1.5/s at duty 1 */
export const DEFAULT_TUNING: HouseTuning = { aim_mul: 1, react_mul: 1, lead_mul: 1, hop_rate: 0, fire_duty: 0.45, retreat_mul: 1 }

/** sim-only behaviour knobs per archetype (archetypes.json values win when present) */
const SIM_EXTRAS: Record<string, Partial<Archetype>> = {
  // other teams' bots in the final (docs/top-bots-ffa.md: 76.5% gun hit rate, 0.2 s reaction, still 43%, boost 8.5%)
  top: {
    reaction_s: 0.2, aim_sigma_deg: 0.7, lead_frac: 0.95,
    fire_range_m: { gun: 200, laser: 240, mortar: 200, lightning: 44 },
    preferred_range_m: 75, retreat_hp_frac: 0.35, strafe: 0.35, boost_frac: 0.08,
    loot_weapon_first: true, weapon_pref: ["laser", "lightning", "mortar"], farm_cubes: true,
    upgrade_pref: ["armor", "gun_rate", "plating", "nanites", "laser_damage", "gyros"],
    engage_range_m: 120, use_drops: true, camp: 0.6,
  },
  thirdparty: { third_party: true, aggression: 0.4 },
  farmer: { aggression: 0.3, use_drops: true },
  expert: { use_drops: true },
  sniper: { engage_range_m: 200 },
}

const TIER_RANK: Record<string, number> = { easy: 0, medium: 1, hard: 2, expert: 3 }
const TAU = Math.PI * 2
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const d2 = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay)

// ------------------------------------------------------------------ squad controller
export interface SquadParams {
  /** after this time every squad member hunts */
  t_all: number
  /** hunters path to the test bot's true position (else: squad's last sighting) */
  hunters_know_position: boolean
  /** no hunters before this time */
  first_hunter_t: number
  /** hunters = min(alive, base_hunters + kills_by_test_bot) */
  base_hunters: number
  /** extra hunters added per this many seconds (0 = off) */
  escalate_every_s: number
  /** non-hunters engage the test bot only inside this range (or when it attacked them recently) */
  nonhunter_engage_m: number
  /** seconds a non-hunter keeps fighting back after the test bot damaged it */
  retaliate_s: number
  /** hunters added per test-bot kill (k = base + floor(kills * hunters_per_kill)) */
  hunters_per_kill: number
}
/** calibrated against the official practice scores (see sim/README.md) */
export const DEFAULT_SQUAD: SquadParams = { t_all: 330, hunters_know_position: true, first_hunter_t: 0, base_hunters: 1, escalate_every_s: 0, nonhunter_engage_m: 0, retaliate_s: 0, hunters_per_kill: 1 }

export class SquadController {
  testId: number
  p: SquadParams
  match: Match | null = null
  tiers = new Map<number, number>()
  hunters = new Set<number>()
  lastSeen: { x: number; y: number; z: number; t: number } | null = null
  constructor(testId: number, p: Partial<SquadParams>) {
    this.testId = testId
    this.p = { ...DEFAULT_SQUAD, ...p }
  }
  register(id: number, tierRank: number) {
    this.tiers.set(id, tierRank)
  }
  attach(m: Match) {
    this.match = m
  }
  update() {
    const m = this.match
    if (!m) return
    const test = m.mechs[this.testId]
    const squad = m.mechs.filter((x) => x.alive && x.id !== this.testId)
    squad.sort((a, b) => (this.tiers.get(a.id) ?? 9) - (this.tiers.get(b.id) ?? 9) || a.id - b.id)
    let k = Math.min(squad.length, this.p.base_hunters + Math.floor(test.stats.kills * this.p.hunters_per_kill + 1e-9))
    if (this.p.escalate_every_s > 0) k = Math.min(squad.length, k + Math.floor(m.t / this.p.escalate_every_s))
    if (m.t >= this.p.t_all) k = squad.length
    if (m.t < this.p.first_hunter_t) k = 0
    this.hunters = new Set(squad.slice(0, k).map((x) => x.id))
    // squad sighting memory of the test bot
    const vis = m.visibleNow.get("t0")
    if (vis && vis.has(this.testId)) this.lastSeen = { x: test.x, y: test.y, z: test.z, t: m.t }
  }
  directive(id: number): { hunt: boolean; x: number; y: number; z: number; known: boolean } | null {
    const m = this.match
    if (!m) return null
    const test = m.mechs[this.testId]
    if (!test.alive || !this.hunters.has(id)) return null
    if (this.p.hunters_know_position) return { hunt: true, x: test.x, y: test.y, z: test.z, known: true }
    if (this.lastSeen) return { hunt: true, x: this.lastSeen.x, y: this.lastSeen.y, z: this.lastSeen.z, known: false }
    return null
  }
}

// ------------------------------------------------------------------ house agent
interface Track {
  id: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  hp: number
  maxHp: number
  cubes: number
  weapons: string[]
  charging: boolean
  firstSeen: number
  lastSeen: number
  npc: boolean
}
interface ItemMem {
  id: number
  kind: string
  x: number
  y: number
  z: number
  t: number
  hp?: number
}

export class HouseAgent implements Agent {
  kind = "house" as const
  name: string
  archName: string
  a: Archetype
  squad: SquadController | null
  team: number
  rng: Rng = new Rng(1)
  hello: Hello | null = null
  nav: NavGrid | null = null
  match: Match | null = null
  me: Mech | null = null
  tracks = new Map<number, Track>()
  items = new Map<number, ItemMem>()
  crates = new Map<number, ItemMem>()
  path: number[] = []
  pathGoal: [number, number] | null = null
  pathT = -99
  strafeDir = 1
  strafeT = 0
  strafeOn = false
  boostOn = false
  boostT = 0
  errYaw = 0
  errPitch = 0
  errT = 0
  stuckT = 0
  lastX = 0
  lastY = 0
  lastProgT = 0
  unstickUntil = 0
  roam: [number, number] | null = null
  roamT = 0
  lastHitBy = new Map<number, number>()
  mode = ""
  bridgeGoal: [number, number] | null = null
  bridgePt: [number, number] | null = null
  climbState = 0
  climbT = 0
  burstOn = true
  burstT = 0
  hopUntil = 0
  zoneLockUntil = 0
  tune: HouseTuning
  constructor(arch: string, squad: SquadController | null, team: number, tune: Partial<HouseTuning> = {}) {
    const A = loadArchetypes()
    const real = A.archetypes[arch] || SIM_EXTRAS[arch]?.reaction_s !== undefined ? arch : (A.tiers[arch] ?? "expert")
    this.archName = arch
    this.tune = { ...DEFAULT_TUNING, ...tune }
    const full = SIM_EXTRAS[real]?.reaction_s !== undefined
    const base = { ...(full ? {} : A.archetypes.expert), ...(SIM_EXTRAS[real] ?? {}), ...(A.archetypes[real] ?? {}) } as Archetype
    this.a = { ...base, aim_sigma_deg: base.aim_sigma_deg * this.tune.aim_mul, reaction_s: base.reaction_s * this.tune.react_mul, lead_frac: Math.min(1, base.lead_frac * this.tune.lead_mul), retreat_hp_frac: base.retreat_hp_frac * this.tune.retreat_mul }
    this.name = `house:${arch}`
    this.squad = squad
    this.team = team
  }
  async init(hello: Hello): Promise<boolean> {
    this.hello = hello
    this.rng = new Rng(hashSeed(hello.seed, 4242))
    return true
  }
  /** identity + nav only (house bots read the world through their Observation) */
  attach(match: Match, me: Mech) {
    this.match = match
    this.me = me
    this.nav = getNav(match.w)
    this.squad?.register(me.id, TIER_RANK[this.archName] ?? 3)
  }
  end() {}

  private isFriend(id: number): boolean {
    if (this.team < 0 || !this.match) return false
    const m = this.match.mechById(id)
    return !!m && m.team === this.team
  }

  act(obs: Observation): BotAction {
    const s = obs.self
    const t = obs.t
    const A = this.a
    const act: BotAction = { tick: obs.tick }
    const [x, y, z] = s.pos
    // ---------------- memory
    for (const m of obs.mechs) {
      if (m.kind === "mech" && this.isFriend(m.id)) continue
      let tr = this.tracks.get(m.id)
      if (!tr || t - tr.lastSeen > 6) {
        tr = { id: m.id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, hp: 0, maxHp: 1, cubes: 0, weapons: [], charging: false, firstSeen: t, lastSeen: t, npc: m.kind === "npc" }
        this.tracks.set(m.id, tr)
      }
      tr.x = m.pos[0]
      tr.y = m.pos[1]
      tr.z = m.pos[2]
      tr.vx = m.vel[0]
      tr.vy = m.vel[1]
      tr.vz = m.vel[2]
      tr.hp = m.hp ?? 1000
      tr.maxHp = m.max_hp ?? 1400
      tr.cubes = m.cubes ?? 0
      tr.weapons = (m.weapons ?? []) as string[]
      tr.charging = !!m.charging
      tr.lastSeen = t
    }
    for (const [id, tr] of this.tracks) if (t - tr.lastSeen > 0.25 && !obs.mechs.some((m) => m.id === id)) this.tracks.delete(id)
    for (const p of obs.pickups) this.items.set(p.id, { id: p.id, kind: p.kind, x: p.pos[0], y: p.pos[1], z: p.pos[2], t })
    for (const c of obs.crates) this.crates.set(c.id, { id: c.id, kind: "crate", x: c.pos[0], y: c.pos[1], z: c.pos[2], t, hp: c.hp })
    // forget items we should see but don't (within 40 m)
    for (const [id, it] of this.items) if (d2(x, y, it.x, it.y) < 35 && it.t < t - 0.5) this.items.delete(id)
    for (const [id, it] of this.crates) if (d2(x, y, it.x, it.y) < 35 && it.t < t - 0.5) this.crates.delete(id)
    for (const e of obs.events) {
      if (e.type === "damaged" && e.by !== null && e.by !== undefined) this.lastHitBy.set(e.by, t)
      if (e.type === "took") this.items.delete(e.id)
    }
    // ---------------- upgrades
    if (obs.offer) {
      let pick = 0
      let best = 1e9
      obs.offer.choices.forEach((c, i) => {
        const r = A.upgrade_pref.indexOf(c.id)
        const score = r < 0 ? 100 + i : r
        if (score < best) {
          best = score
          pick = i
        }
      })
      act.pick = pick
    }
    // ---------------- zone
    const zone = obs.zone
    const nextR = zone.next_radius
    const dNext = d2(x, y, zone.next_center[0], zone.next_center[1])
    const dCur = d2(x, y, zone.center[0], zone.center[1])
    const safeR = Math.max(nextR * 0.8 - 4, nextR - 25, 0)
    const travel = Math.max(0, dNext - safeR) / 9
    const mustMove = !s.in_zone || dCur > zone.radius - 8 || (dNext > safeR && t >= zone.shrink_start - travel - 15) || nextR <= 30
    if (mustMove) this.zoneLockUntil = t + 4
    const zoneUrgent = mustMove || (t < this.zoneLockUntil && dNext > safeR - 15)
    // goals (loot, crates, drops, roaming) must lie inside this circle once a shrink is near
    const goalOk = (gx: number, gy: number) => !(zoneUrgent || t > zone.shrink_start - 45) || d2(gx, gy, zone.next_center[0], zone.next_center[1]) <= safeR
    // ---------------- target selection
    const maxHp = s.max_hp
    const hpFrac = s.hp / maxHp
    const dir = this.squad?.directive(s.id) ?? null
    let target: Track | null = null
    let bestScore = Infinity
    const engageR = A.engage_range_m ?? Math.min(A.fire_range_m.gun, A.preferred_range_m * 1.6)
    for (const tr of this.tracks.values()) {
      if (tr.npc) continue
      const d = d2(x, y, tr.x, tr.y)
      const attackedMe = (this.lastHitBy.get(tr.id) ?? -99) > t - (this.squad ? this.squad.p.retaliate_s : 4)
      let limit = engageR
      if (this.squad && !(dir && dir.hunt)) limit = Math.min(limit, this.squad.p.nonhunter_engage_m)
      if (dir && dir.hunt) limit = Math.max(limit, A.fire_range_m.gun)
      if (attackedMe) limit = Math.max(limit, A.fire_range_m.gun)
      if (d > limit) continue
      // aggression / third party: only engage weakened targets unless attacked
      const agg = A.aggression ?? 1
      if (!attackedMe && !(dir && dir.hunt) && agg < 1) {
        const weak = tr.hp / Math.max(1, tr.maxHp) < 0.6
        if (A.third_party ? !weak : this.rng.next() > agg && !weak) continue
      }
      let score = d - (attackedMe ? 60 : 0) + (tr.hp / Math.max(1, tr.maxHp)) * 30
      if (this.squad && tr.id === this.squad.testId) score -= 1000
      if (score < bestScore) {
        bestScore = score
        target = tr
      }
    }
    // NPC targets for farming (or self defense)
    let npcTarget: Track | null = null
    {
      let bd = Infinity
      for (const tr of this.tracks.values()) {
        if (!tr.npc) continue
        const d = d2(x, y, tr.x, tr.y)
        const attackedMe = (this.lastHitBy.get(tr.id) ?? -99) > t - 3
        const ok = attackedMe || (A.farm_cubes && hpFrac > 0.75 && d < 110 && !zoneUrgent)
        if (!ok) continue
        if (d < bd) {
          bd = d
          npcTarget = tr
        }
      }
    }
    // ---------------- movement goal
    let goal: [number, number] | null = null
    let goalBoost = false
    let faceYaw: number | null = null
    const wantRetreat = target && hpFrac < A.retreat_hp_frac && !(dir && dir.hunt && hpFrac > A.retreat_hp_frac * 0.6)
    this.mode = "roam"
    if (target) {
      const d = d2(x, y, target.x, target.y)
      const toT = Math.atan2(target.y - y, target.x - x)
      if (wantRetreat) {
        this.mode = "retreat"
        // back off away from target, biased to zone center
        const zx = zone.next_center[0] - x,
          zy = zone.next_center[1] - y
        const zl = Math.hypot(zx, zy) || 1
        const ax = -Math.cos(toT) + (zx / zl) * 0.6,
          ay = -Math.sin(toT) + (zy / zl) * 0.6
        goal = [x + ax * 30, y + ay * 30]
        goalBoost = s.energy > 25
      } else {
        this.mode = "fight"
        let pref = A.preferred_range_m
        const hasL = s.weapons.some((w) => w && w.kind === "lightning")
        if (hasL && A.weapon_pref[0] === "lightning") pref = Math.min(pref, 30)
        if (d > pref + 12) goal = [target.x, target.y]
        else if (d < pref - 12) goal = [x - Math.cos(toT) * 20, y - Math.sin(toT) * 20]
        else goal = null
      }
      faceYaw = toT
    } else if (dir && dir.hunt) {
      this.mode = "hunt"
      goal = [dir.x, dir.y]
      goalBoost = d2(x, y, dir.x, dir.y) > 120 && s.energy > 50
    }
    if (!goal && !target) {
      // loot / farm / drops / roam
      const reach = this.hello!.config.loot.pickup_radius
      // weapon pickups
      const slot1 = s.weapons[1]
      const slot0 = s.weapons[0]
      const held = new Set(s.weapons.filter((w) => w).map((w) => (w as WeaponObs).kind))
      let bestItem: ItemMem | null = null
      let bi = Infinity
      for (const it of this.items.values()) {
        if (held.has(it.kind as any)) continue
        const prefIdx = A.weapon_pref.indexOf(it.kind)
        if (prefIdx < 0) continue
        if (Math.abs(it.z - this.nav!.h[this.nav!.cell(it.x, it.y)]) > 1.5) continue // roof loot: skip
        const d = d2(x, y, it.x, it.y)
        if (d > 160) continue
        if (!goalOk(it.x, it.y)) continue
        // want it if a slot is free, or it beats what we hold in slot 1
        let want = !slot1 || !slot0
        let dropSlot: number | undefined
        if (!want && slot1) {
          const curIdx = A.weapon_pref.indexOf(slot1.kind)
          if (curIdx < 0 || prefIdx < curIdx) {
            want = d < 60
            dropSlot = 1
          }
        }
        if (!want) continue
        const score = d + prefIdx * 25
        if (score < bi) {
          bi = score
          bestItem = { ...it, hp: dropSlot }
        }
      }
      if (bestItem && (A.loot_weapon_first || !slot1)) {
        this.mode = "loot"
        goal = [bestItem.x, bestItem.y]
        if (d2(x, y, bestItem.x, bestItem.y) < reach - 0.6 && Math.abs(bestItem.z - z) < 3.5) {
          act.take = bestItem.id
          if (bestItem.hp !== undefined) act.drop = bestItem.hp
        }
      }
      // cubes on the ground
      if (!goal) {
        let bc: number[] | null = null
        let bd = 90
        for (const c of obs.cubes) {
          const d = d2(x, y, c.pos[0], c.pos[1])
          if (d < bd && goalOk(c.pos[0], c.pos[1]) && Math.abs(c.pos[2] - this.nav!.h[this.nav!.cell(c.pos[0], c.pos[1])]) < 1.5) {
            bd = d
            bc = c.pos
          }
        }
        if (bc) {
          this.mode = "cube"
          goal = [bc[0], bc[1]]
        }
      }
      // supply drop
      if (!goal && A.use_drops && hpFrac > 0.5) {
        for (const dr of obs.drops) {
          const d = d2(x, y, dr.pos[0], dr.pos[1])
          if (d < 160 && dr.lands_in < 12 && goalOk(dr.pos[0], dr.pos[1])) {
            this.mode = "drop"
            goal = [dr.pos[0], dr.pos[1]]
            break
          }
        }
      }
      // crates (ground) to farm
      if (!goal && A.farm_cubes && !zoneUrgent) {
        let bc: ItemMem | null = null
        let bd = 130
        for (const c of this.crates.values()) {
          if (Math.abs(c.z - this.nav!.h[this.nav!.cell(c.x, c.y)]) > 1.5) continue
          if (!goalOk(c.x, c.y)) continue
          const d = d2(x, y, c.x, c.y)
          if (d < bd) {
            bd = d
            bc = c
          }
        }
        if (bc) {
          this.mode = "crate"
          const d = d2(x, y, bc.x, bc.y)
          if (d > 18) goal = [bc.x, bc.y]
          faceYaw = Math.atan2(bc.y - y, bc.x - x)
          if (d < 60) {
            // shoot the crate with the gun
            const gi = s.weapons.findIndex((w) => w && w.kind === "gun")
            const li = s.weapons.findIndex((w) => w && w.kind === "lightning")
            const pitch = Math.atan2(bc.z + 1.2 - (z + s.stats.muzzle_height), d)
            act.aim = [faceYaw, pitch]
            const aligned = Math.abs(wrap(s.aim[0] - faceYaw)) < 0.05 && Math.abs(s.aim[1] - pitch) < 0.06
            const fire: [boolean, boolean] = [false, false]
            if (li >= 0 && d < 40 && s.energy > 30 && Math.abs(wrap(s.aim[0] - faceYaw)) < 0.2) fire[li] = true
            else if (gi >= 0 && aligned) fire[gi] = true
            act.fire = fire
          }
        }
      }
      if (!goal && npcTarget) {
        this.mode = "npc"
        const d = d2(x, y, npcTarget.x, npcTarget.y)
        if (d > 50) goal = [npcTarget.x, npcTarget.y]
        else if (d < 30) goal = [x - (npcTarget.x - x), y - (npcTarget.y - y)]
      }
    }
    // zone override
    if (zoneUrgent && this.mode !== "fight") {
      const gx = zone.next_center[0],
        gy = zone.next_center[1]
      if (!goal || d2(goal[0], goal[1], gx, gy) > safeR) {
        goal = [gx, gy]
        if (!s.in_zone || dNext > nextR) goalBoost = s.energy > 20
        if (this.mode !== "retreat") this.mode = "zone"
      }
    } else if (this.mode === "fight" && (!s.in_zone || (zoneUrgent && dNext > nextR))) {
      // fighting outside: drift toward zone while fighting
      goal = [zone.next_center[0], zone.next_center[1]]
    }
    if (!goal && this.mode === "roam") {
      const camping = this.roam && t <= this.roamT && (A.camp ?? 0) > 0 && d2(x, y, this.roam[0], this.roam[1]) < 8
      if (!camping && (!this.roam || t > this.roamT || d2(x, y, this.roam[0], this.roam[1]) < 8 || d2(this.roam[0], this.roam[1], zone.next_center[0], zone.next_center[1]) > safeR)) {
        const ang = this.rng.next() * TAU
        const rr = Math.sqrt(this.rng.next()) * Math.max(10, safeR * 0.7)
        this.roam = [zone.next_center[0] + Math.cos(ang) * rr, zone.next_center[1] + Math.sin(ang) * rr]
        this.roamT = t + 20 + this.rng.next() * 20
        if ((A.camp ?? 0) > 0 && this.rng.next() < A.camp! && d2(x, y, zone.next_center[0], zone.next_center[1]) < safeR) {
          this.roam = [x, y]
          this.roamT = t + 15 + this.rng.next() * 15
        }
      }
      goal = this.roam
    }
    // ---------------- steering
    let mv: [number, number] = [0, 0]
    if (goal) mv = this.steer(x, y, goal, t)
    // stuck handling
    const moved = d2(x, y, this.lastX, this.lastY)
    if (t - this.lastProgT >= 1) {
      if (Math.hypot(mv[0], mv[1]) > 0.3 && moved < 1.2 && s.grounded) {
        this.unstickUntil = t + 0.6
        this.pathT = -99
        this.strafeDir = -this.strafeDir
      }
      this.lastX = x
      this.lastY = y
      this.lastProgT = t
    }
    if (this.climbState > 0 && (!goal || t - this.climbT > 25)) this.climbState = 0
    if (this.climbState === 1) {
      // charge energy at the wall, then commit to one jump + jet over it
      act.boost = false
      if (s.grounded) mv = [mv[0] * 0.2, mv[1] * 0.2]
      if (s.grounded && s.energy >= s.max_energy * 0.95) {
        this.climbState = 2
        act.jump = true
        act.boost = true
      }
    } else if (this.climbState === 2) {
      if (s.grounded && s.energy < 25) this.climbState = 1
      else {
        if (s.grounded) act.jump = true
        act.boost = s.energy > 1
      }
    } else if (t < this.unstickUntil) {
      act.jump = s.grounded
      act.boost = true
      const side = this.strafeDir
      mv = [mv[0] - mv[1] * side * 0.7, mv[1] + mv[0] * side * 0.7]
    }
    // ---------------- combat: aim + fire
    if (target && this.mode !== "loot") {
      this.combat(obs, target, act, mv)
    } else if (npcTarget && !act.fire) {
      this.combat(obs, npcTarget, act, mv)
    } else if (!act.aim) {
      // look where we go, scan a bit
      const yaw = goal ? Math.atan2(goal[1] - y, goal[0] - x) : s.aim[0] + 0.5
      act.aim = [faceYaw ?? yaw + Math.sin(t * 0.7) * 0.5, 0]
      // reload in lulls
      const g = s.weapons.find((w) => w && w.kind === "gun")
      if (g && (g.ammo ?? 12) < 6 && (g.reload ?? 0) === 0) act.reload = true
    }
    // strafe / boost in fights
    if (this.mode === "fight" || this.mode === "retreat") {
      if (t >= this.strafeT) {
        this.strafeOn = this.rng.next() < A.strafe
        if (this.rng.next() < 0.5) this.strafeDir = -this.strafeDir
        this.strafeT = t + 0.5 + this.rng.next() * 1.0
        this.boostOn = this.rng.next() < A.boost_frac
      }
      if (this.strafeOn && target) {
        const toT = Math.atan2(target.y - y, target.x - x)
        const px = -Math.sin(toT) * this.strafeDir,
          py = Math.cos(toT) * this.strafeDir
        mv = [mv[0] * 0.6 + px, mv[1] * 0.6 + py]
      }
      if (this.boostOn && s.energy > 35) act.boost = true
    }
    const ml = Math.hypot(mv[0], mv[1])
    if (ml > 1) mv = [mv[0] / ml, mv[1] / ml]
    act.move = mv
    if (goalBoost && !act.boost) act.boost = true
    if (act.boost && s.energy < 8) act.boost = false
    return act
  }

  private steer(x: number, y: number, goal: [number, number], t: number): [number, number] {
    const nav = this.nav!
    const dg = d2(x, y, goal[0], goal[1])
    if (dg < 2) return [0, 0]
    // goal in another walkable component (e.g. the stadium bowl, a roof): walk to the closest
    // reachable cell, then jet over the obstacle toward the goal
    const sk = nav.nearest(x, y, 4)
    const gk = nav.nearest(goal[0], goal[1], 12)
    let tgt = goal
    if (sk >= 0 && gk >= 0 && nav.comp[sk] !== nav.comp[gk]) {
      if (!this.bridgeGoal || d2(this.bridgeGoal[0], this.bridgeGoal[1], goal[0], goal[1]) > 15) {
        const k = nav.closestInComp(goal[0], goal[1], nav.comp[sk])
        this.bridgeGoal = [goal[0], goal[1]]
        this.bridgePt = k >= 0 ? [nav.cx(k), nav.cy(k)] : null
      }
      if (this.bridgePt) {
        if (this.climbState === 0 && d2(x, y, this.bridgePt[0], this.bridgePt[1]) < 9) {
          this.climbState = 1
          this.climbT = t
          this.path = []
        }
        if (this.climbState > 0) return [(goal[0] - x) / dg, (goal[1] - y) / dg]
        tgt = this.bridgePt
      }
    } else if (this.climbState > 0 && this.me && this.me.grounded) this.climbState = 0
    if (this.climbState > 0) return [(goal[0] - x) / dg, (goal[1] - y) / dg]
    const dt2 = d2(x, y, tgt[0], tgt[1])
    if (dt2 < 2) return [0, 0]
    // direct if walkable line
    if (dt2 < 25 || nav.lineWalkable(x, y, tgt[0], tgt[1])) {
      this.path = []
      return [(tgt[0] - x) / dt2, (tgt[1] - y) / dt2]
    }
    const goalMoved = !this.pathGoal || d2(this.pathGoal[0], this.pathGoal[1], tgt[0], tgt[1]) > 10
    const replan = (goalMoved && t - this.pathT > 0.5) || t - this.pathT > 4 || (this.path.length === 0 && t - this.pathT > 1.5)
    if (replan) {
      const p = nav.path(x, y, tgt[0], tgt[1], 12000)
      this.path = p ?? []
      this.pathGoal = [tgt[0], tgt[1]]
      this.pathT = t
    }
    while (this.path.length >= 4 && d2(x, y, this.path[0], this.path[1]) < 3.5) this.path.splice(0, 2)
    if (this.path.length >= 4 && nav.lineWalkable(x, y, this.path[2], this.path[3])) this.path.splice(0, 2)
    if (this.path.length >= 2) {
      const wx = this.path[0],
        wy = this.path[1]
      const dw = d2(x, y, wx, wy)
      if (dw < 1.5 && this.path.length === 2) return [0, 0]
      return [(wx - x) / Math.max(dw, 1e-6), (wy - y) / Math.max(dw, 1e-6)]
    }
    return [(tgt[0] - x) / dt2, (tgt[1] - y) / dt2]
  }

  private combat(obs: Observation, tr: Track, act: BotAction, mv: [number, number]) {
    const s = obs.self
    const t = obs.t
    const A = this.a
    const cfg = this.hello!.config
    const [x, y, z] = s.pos
    const d = d2(x, y, tr.x, tr.y)
    const muzzle = z + (s.stats.muzzle_height ?? 7)
    const size = 1 + ((cfg.cubes.size_per_cube as number) ?? 0.05) * (tr.cubes ?? 0)
    const tzc = tr.z + (tr.npc ? 1.75 : 4.5 * size)
    // aim error (drifting)
    if (t >= this.errT) {
      const sg = (A.aim_sigma_deg * Math.PI) / 180
      this.errYaw = this.rng.gauss() * sg
      this.errPitch = this.rng.gauss() * sg * 0.6
      this.errT = t + 0.3 + this.rng.next() * 0.4
    }
    // choose weapon
    const W = s.weapons
    let slot = -1
    let kind = ""
    const can = (i: number) => W[i] && (W[i] as WeaponObs).cooldown <= 0.12
    const idx = (k: string) => W.findIndex((w) => w && w.kind === k)
    const li = idx("lightning"),
      la = idx("laser"),
      mo = idx("mortar"),
      gu = idx("gun")
    const laserCharging = la >= 0 && ((W[la] as WeaponObs).charge ?? 0) > 0
    if (laserCharging) {
      slot = la
      kind = "laser"
    } else if (li >= 0 && d <= Math.min(A.fire_range_m.lightning, (W[li] as WeaponObs).stats.range * 0.95) && s.energy >= 4) {
      slot = li
      kind = "lightning"
    } else if (la >= 0 && can(la) && d <= A.fire_range_m.laser && d > 12) {
      slot = la
      kind = "laser"
    } else if (mo >= 0 && can(mo) && d >= 30 && d <= A.fire_range_m.mortar) {
      slot = mo
      kind = "mortar"
    } else if (gu >= 0 && d <= A.fire_range_m.gun) {
      slot = gu
      kind = "gun"
    }
    let yaw = Math.atan2(tr.y - y, tr.x - x)
    let pitch = Math.atan2(tzc - muzzle, d)
    if (kind === "gun" && slot >= 0) {
      const sp = (W[slot] as WeaponObs).stats.speed ?? 252
      let px = tr.x,
        py = tr.y,
        pz = tzc
      for (let it = 0; it < 2; it++) {
        const tt = Math.hypot(px - x, py - y, pz - muzzle) / sp
        px = tr.x + tr.vx * tt * A.lead_frac
        py = tr.y + tr.vy * tt * A.lead_frac
        pz = tzc + tr.vz * tt * A.lead_frac * 0.5
      }
      yaw = Math.atan2(py - y, px - x)
      pitch = Math.atan2(pz - muzzle, Math.hypot(px - x, py - y))
    } else if (kind === "mortar" && slot >= 0) {
      const st = (W[slot] as WeaponObs).stats
      const v = st.speed ?? 72,
        g = st.gravity ?? 22
      const tube = z + (s.stats.height ?? 9) + 0.5
      let px = tr.x,
        py = tr.y
      let sol: number | null = null
      for (let it = 0; it < 2; it++) {
        const D = Math.hypot(px - x, py - y)
        const h = tr.z - tube
        const disc = v ** 4 - g * (g * D * D + 2 * h * v * v)
        if (disc < 0) {
          sol = null
          break
        }
        sol = Math.atan((v * v - Math.sqrt(disc)) / (g * D))
        const T = D / (v * Math.cos(sol))
        px = tr.x + tr.vx * T * A.lead_frac
        py = tr.y + tr.vy * T * A.lead_frac
      }
      if (sol === null) {
        kind = gu >= 0 ? "gun" : ""
        slot = gu
      } else {
        yaw = Math.atan2(py - y, px - x)
        pitch = sol
      }
    }
    yaw += this.errYaw
    pitch += this.errPitch
    act.aim = [yaw, pitch]
    const fire: [boolean, boolean] = [false, false]
    const seenFor = t - tr.firstSeen
    const yawErr = Math.abs(wrap(s.aim[0] - yaw))
    const pitchErr = Math.abs(s.aim[1] - pitch)
    const tol = Math.max(0.02, Math.atan2(2.2, Math.max(d, 1)))
    const ready = seenFor >= A.reaction_s
    if (slot >= 0 && ready) {
      if (kind === "gun") {
        const g = W[slot] as WeaponObs
        if ((g.reload ?? 0) === 0 && yawErr < tol * 1.5 && pitchErr < tol * 1.5) fire[slot] = true
      } else if (kind === "lightning") {
        if (yawErr < 0.2) fire[slot] = true
      } else if (kind === "mortar") {
        if (yawErr < 0.04 && pitchErr < 0.04) fire[slot] = true
      } else if (kind === "laser") {
        const w = W[slot] as WeaponObs
        const ch = w.charge ?? 0
        const full = (w.stats.charge ?? 0.75) * 0.97
        if (ch <= 0) {
          if (yawErr < 0.3) fire[slot] = true // start charging
        } else if (ch < full) fire[slot] = true
        else fire[slot] = !(yawErr < tol && pitchErr < tol) // release when aligned
      }
    }
    // keep gun busy while laser is on cooldown (both slots can fire)
    if (ready && kind !== "gun" && gu >= 0 && gu !== slot && d <= A.fire_range_m.gun) {
      const g = W[gu] as WeaponObs
      if ((g.reload ?? 0) === 0 && kind !== "laser" && yawErr < tol * 1.5 && pitchErr < tol * 1.5 && kind !== "mortar") fire[gu] = true
    }
    // burst windows: a share (fire_duty) of the time the bot actually pulls the trigger
    if (t >= this.burstT) {
      this.burstOn = this.rng.next() < (A.fire_duty ?? this.tune.fire_duty)
      this.burstT = t + 0.6 + this.rng.next() * 0.9
    }
    if (!this.burstOn) {
      for (let i = 0; i < 2; i++) {
        const w = W[i] as WeaponObs | null
        // never drop a laser charge that is already building
        if (w && w.kind === "laser" && (w.charge ?? 0) > 0) continue
        fire[i] = false
      }
    }
    act.fire = fire
    // hop while fighting
    if (this.tune.hop_rate > 0 && s.grounded && this.rng.next() < this.tune.hop_rate * 0.1) {
      act.jump = true
      this.hopUntil = t + 0.6 + this.rng.next() * 0.8
    }
    if (t < this.hopUntil && !s.grounded && s.energy > 30) act.boost = true
    void mv
  }
}
