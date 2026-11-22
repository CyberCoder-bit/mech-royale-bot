/**
 * Enemy tracker: remembers mechs and NPCs beyond the server's 5 s memory, computes our own line
 * of sight to each (the server also lists memory-tracked mechs that are out of view), and keeps
 * "ghost" threats from damage bearings when the attacker is unseen. Per bot instance.
 */
import type { ActorObs, Observation, WeaponKind } from "../mechfight.ts"
import type { World } from "../world/world.ts"
import { angDiff, type V2, type V3 } from "../util/math.ts"

export type Track = {
  id: number
  npc: boolean
  pos: V3
  vel: V3
  aim: V2
  hp: number
  maxHp: number
  cubes: number
  weapons: WeaponKind[]
  charging: boolean
  /** first time listed in this stretch */
  firstT: number
  /** last time listed in obs.mechs (visible or server memory) */
  seenT: number
  /** last time we had a clear shot line to it (our own LOS test) */
  losT: number
  /** clear shot line from our muzzle this tick */
  los: boolean
  /** aim point height offset above its feet that is in LOS (center, else head), when los */
  aimDz: number
  /** it has a clear line to us (could shoot us) this tick */
  threatLos: boolean
  /** its torso aim points at us (within a few degrees) */
  aimingAtUs: boolean
  hurtUsT: number
  /** we damaged it last at */
  hitT: number
  /** ghost: unseen attacker known only by a damage bearing */
  ghost: boolean
}

export class Tracker {
  tracks = new Map<number, Track>()
  private sizePerCube: number
  constructor(sizePerCube = 0.05) {
    this.sizePerCube = sizePerCube
  }

  height(tr: { npc: boolean; cubes: number }) {
    return tr.npc ? 3.5 : 9 * (1 + this.sizePerCube * tr.cubes)
  }
  center(tr: Track): V3 {
    return [tr.pos[0], tr.pos[1], tr.pos[2] + this.height(tr) * 0.5]
  }
  eye(tr: Track): V3 {
    return [tr.pos[0], tr.pos[1], tr.pos[2] + (tr.npc ? 3 : 8 * (1 + this.sizePerCube * tr.cubes))]
  }

  update(obs: Observation, world: World | null, muzzle: V3, myCenter: V3, myTop: V3) {
    const t = obs.t
    const myId = obs.self.id
    for (const m of obs.mechs) {
      if (m.id === myId) continue
      this.upsert(m, t)
    }
    for (const ev of obs.events ?? []) {
      if (ev.type === "damaged" && ev.by !== null && ev.by !== undefined) {
        let tr = this.tracks.get(ev.by)
        if (!tr && ev.bearing !== null && ev.bearing !== undefined) {
          // unseen attacker: a ghost along the bearing at a guessed distance
          const d = ev.weapon === "lightning" ? 30 : ev.weapon === "npc" ? 40 : 90
          const p = obs.self.pos
          tr = {
            id: ev.by, npc: ev.by >= 100, pos: [p[0] + Math.cos(ev.bearing) * d, p[1] + Math.sin(ev.bearing) * d, p[2]], vel: [0, 0, 0], aim: [ev.bearing + Math.PI, 0],
            hp: 1400, maxHp: 1400, cubes: 0, weapons: [], charging: false, firstT: t, seenT: t - 1, losT: -99, los: false, aimDz: 4.5, threatLos: true, aimingAtUs: true,
            hurtUsT: t, hitT: -99, ghost: true,
          }
          this.tracks.set(ev.by, tr)
        }
        if (tr) {
          tr.hurtUsT = t
          if (tr.ghost && ev.bearing !== null && ev.bearing !== undefined) {
            // keep the ghost on the latest bearing
            const p = obs.self.pos
            const d = Math.hypot(tr.pos[0] - p[0], tr.pos[1] - p[1])
            tr.pos = [p[0] + Math.cos(ev.bearing) * d, p[1] + Math.sin(ev.bearing) * d, p[2]]
            tr.seenT = t - 1
          }
        }
      } else if (ev.type === "hit") {
        const tr = this.tracks.get(ev.target)
        if (tr) tr.hitT = t
      } else if (ev.type === "kill") {
        this.tracks.delete(ev.target)
      }
    }
    // LOS bookkeeping
    for (const [id, tr] of this.tracks) {
      const age = t - tr.seenT
      if (age > (tr.npc ? 20 : 30)) {
        this.tracks.delete(id)
        continue
      }
      tr.los = false
      tr.threatLos = false
      tr.aimingAtUs = false
      if (tr.ghost) {
        tr.threatLos = t - tr.hurtUsT < 2
        continue
      }
      if (age > 0.01) continue // not listed this tick: no LOS claims
      const h = this.height(tr)
      if (!world) {
        tr.los = true
        tr.aimDz = h * 0.5
      } else {
        const c: V3 = [tr.pos[0], tr.pos[1], tr.pos[2] + h * 0.5]
        if (world.shotClear(muzzle, c)) {
          tr.los = true
          tr.aimDz = h * 0.5
        } else {
          const hd: V3 = [tr.pos[0], tr.pos[1], tr.pos[2] + h * 0.85]
          if (world.shotClear(muzzle, hd)) {
            tr.los = true
            tr.aimDz = h * 0.85
          }
        }
      }
      if (tr.los) tr.losT = t
      if (!tr.npc) {
        const e = this.eye(tr)
        tr.threatLos = !world || world.shotClear(e, myCenter) || world.shotClear(e, myTop)
        const yawToMe = Math.atan2(myCenter[1] - tr.pos[1], myCenter[0] - tr.pos[0])
        const d = Math.hypot(myCenter[0] - tr.pos[0], myCenter[1] - tr.pos[1])
        const tol = Math.max(0.05, Math.atan2(4, d))
        tr.aimingAtUs = Math.abs(angDiff(tr.aim[0], yawToMe)) < tol
      }
    }
  }

  private upsert(m: ActorObs, t: number) {
    let tr = this.tracks.get(m.id)
    if (!tr || tr.ghost) {
      tr = {
        id: m.id, npc: m.kind === "npc", pos: [...m.pos] as V3, vel: [...m.vel] as V3, aim: [...m.aim] as V2, hp: m.hp ?? m.max_hp ?? 1400, maxHp: m.max_hp ?? 1400,
        cubes: m.cubes ?? 0, weapons: m.weapons ?? [], charging: !!m.charging, firstT: t, seenT: t, losT: -99, los: false, aimDz: 4.5, threatLos: false, aimingAtUs: false,
        hurtUsT: tr?.hurtUsT ?? -99, hitT: -99, ghost: false,
      }
      this.tracks.set(m.id, tr)
      return
    }
    if (t - tr.seenT > 1) tr.firstT = t
    tr.pos = [m.pos[0], m.pos[1], m.pos[2]]
    tr.vel = [m.vel[0], m.vel[1], m.vel[2]]
    tr.aim = [m.aim[0], m.aim[1]]
    if (m.hp !== undefined) tr.hp = m.hp
    if (m.max_hp !== undefined) tr.maxHp = m.max_hp
    tr.cubes = m.cubes ?? tr.cubes
    tr.weapons = m.weapons ?? tr.weapons
    tr.charging = !!m.charging
    tr.seenT = t
  }

  /** Predicted position (dead reckoning, capped) for a track last seen at seenT. */
  predict(tr: Track, t: number, maxS = 1.5): V3 {
    const dt = Math.min(maxS, Math.max(0, t - tr.seenT))
    return [tr.pos[0] + tr.vel[0] * dt, tr.pos[1] + tr.vel[1] * dt, tr.pos[2]]
  }

  /** Enemy mechs (not NPCs) seen within maxAge seconds. */
  enemies(t: number, maxAge: number): Track[] {
    const r: Track[] = []
    for (const tr of this.tracks.values()) if (!tr.npc && t - tr.seenT <= maxAge) r.push(tr)
    return r
  }

  npcs(t: number, maxAge: number): Track[] {
    const r: Track[] = []
    for (const tr of this.tracks.values()) if (tr.npc && t - tr.seenT <= maxAge) r.push(tr)
    return r
  }
}
