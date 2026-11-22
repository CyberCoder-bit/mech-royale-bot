/**
 * Roof mode, the "rooftop fortress" (P.roofMode, off by default).
 *
 * After the early loot, pick a roof inside the next zone circle (data/roofs.json, precomputed by
 * tools/precompute-roofs.ts), path there with the PathFollower (it jumps and jets up the wall), and fight
 * from the roof: with no enemy to shoot, hold the low-exposure interior spot (out of the ground's sight,
 * regen); with a target, move to the roof point that has a shot at it and the fewest other enemies with a
 * line to us (peek at the edge, jink along it); hurt, back off to points no enemy can see. Never walk off
 * the edge. Relocate when the zone no longer covers the roof. Movement only: aim and fire stay with bot.ts.
 */
import { existsSync, readFileSync } from "node:fs"
import type { NavGrid, PathFollower, World } from "../world/index.ts"
import type { ZoneObs } from "../mechfight.ts"
import { P as PRM } from "../params.ts"

export type RoofInfo = {
  id: number; area: number; cx: number; cy: number; z: number; ground: number; climb: number; depth: number
  sx: number; sy: number; sz: number; sExpGV: number; sExp: number
}

let ROOFS: RoofInfo[] | null | undefined

/** data/roofs.json next to the bundle, in the repo's data/, or $CWD/data (immutable, cached per process) */
export function loadRoofs(): RoofInfo[] {
  if (ROOFS !== undefined) return ROOFS ?? []
  ROOFS = null
  try {
    const here = import.meta.dir
    for (const d of [`${here}/data`, `${here}/../data`, `${here}/../../data`, `${process.cwd()}/data`]) {
      const f = `${d}/roofs.json`
      if (existsSync(f)) {
        ROOFS = (JSON.parse(readFileSync(f, "utf8")).roofs ?? []) as RoofInfo[]
        break
      }
    }
  } catch {
    ROOFS = null
  }
  return ROOFS ?? []
}

export type RoofEnemy = { x: number; y: number; z: number; cubes: number; threat: boolean }

export type RoofIn = {
  t: number
  pos: ArrayLike<number>
  vel: ArrayLike<number>
  grounded: boolean
  energy: number
  hpFrac: number
  zone: ZoneObs
  /** slot 1 holds a weapon */
  armed: boolean
  /** v2 knows a weapon pickup worth walking to */
  knownWeapon: boolean
  /** enemies listed now or within a few seconds (position estimates) */
  enemies: RoofEnemy[]
  target: RoofEnemy | null
  /** the closest threat (attacker / approaching) distance, m */
  threatDist: number
  /** seconds since we last took damage */
  hurtAgo: number
  /** our kills so far */
  kills: number
  mySize: number
  jinkSign: number
  climbPerM: number
}

export type RoofOut = { move: [number, number]; boost: boolean; jump: boolean; mode: string; pathed: boolean }

const DX = [1, -1, 0, 0, 1, 1, -1, -1]
const DY = [0, 0, 1, -1, 1, -1, 1, -1]

export class RoofBrain {
  world: World
  nav: NavGrid
  follow: PathFollower
  roofs: RoofInfo[]
  roof: RoofInfo | null = null
  /** node -> depth (cells from the edge) of the chosen roof's free nodes */
  comp = new Map<number, number>()
  private nextCheck = -1
  private started = false
  /** refuge variant (P.roofRefuge): heading for / healing on a roof right now */
  refuge = false
  private refugeT = -1
  private idleCheck = -1
  private lastIdleT = -1
  /** stats for local tools */
  stats = { firstOnRoof: -1, onRoofS: 0, roofsChosen: 0, lastT: -1, on: false, refuges: 0, healed: 0, idleS: 0 }
  private a: [number, number, number] = [0, 0, 0]
  private b: [number, number, number] = [0, 0, 0]

  constructor(world: World, nav: NavGrid, follow: PathFollower) {
    this.world = world
    this.nav = nav
    this.follow = follow
    this.roofs = loadRoofs()
  }

  private zoneOk(r: RoofInfo, z: ZoneObs, extra = 0): boolean {
    const nr = z.next_radius
    if (nr < 1) return false
    const margin = Math.max(PRM.roofZoneMin, nr * PRM.roofZoneFrac) + extra
    const dn = Math.hypot(r.sx - z.next_center[0], r.sy - z.next_center[1])
    const dc = Math.hypot(r.sx - z.center[0], r.sy - z.center[1])
    return dn <= nr - margin && dc <= z.radius - 4
  }

  private choose(inp: RoofIn, maxD = Infinity, distW = 1): RoofInfo | null {
    const P = inp.pos, z = inp.zone
    let best: RoofInfo | null = null, bs = Infinity
    for (const r of this.roofs) {
      const H = r.z - r.ground
      if (r.climb > PRM.roofMaxClimb || r.area < PRM.roofMinArea || r.depth < PRM.roofMinDepth || H < PRM.roofMinH) continue
      if (!this.zoneOk(r, z)) continue
      const d = Math.hypot(r.sx - P[0], r.sy - P[1]) * distW
      if (d > maxD * distW) continue
      const dn = Math.hypot(r.sx - z.next_center[0], r.sy - z.next_center[1]) / Math.max(1, z.next_radius)
      // cover reach: the deepest point is out of the shot line of ground shooters up to this far from the edge (m)
      const cover = (2 * r.depth * (H - 7)) / 4.5
      let s = d / 100 + PRM.roofExpW * r.sExpGV + 0.5 * r.sExp - (Math.min(r.area, 3000) / 3000) * 0.3 + dn * 0.5 - (Math.min(cover, 80) / 80) * PRM.roofCoverW
      if (r.climb > 30) s += (r.climb - 30) / 20
      for (const e of inp.enemies) if (Math.hypot(e.x - r.sx, e.y - r.sy) < 40) s += 0.5
      if (s < bs) (bs = s), (best = r)
    }
    return best
  }

  /** free nodes of the roof around the spot, with their depth from the edge */
  private buildComp(r: RoofInfo) {
    const nav = this.nav, comp = this.comp
    comp.clear()
    const s = nav.nodeAt(r.sx, r.sy, r.sz)
    if (s < 0 || nav.terr[s]) return
    const { w, h, st, hz, terr } = nav
    const nodes = [s]
    const inC = new Set<number>([s])
    for (let q = 0; q < nodes.length && nodes.length < 20000; q++) {
      const u = nodes[q], c = u >> 1, ci = c % w, cj = (c - ci) / w
      for (let d = 0; d < 8; d++) {
        const ii = ci + DX[d], jj = cj + DY[d]
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue
        for (let l = 0; l < 2; l++) {
          const v = 2 * (jj * w + ii) + l
          if (st[v] !== 1 || terr[v] || inC.has(v) || Math.abs(hz[v] - hz[u]) > 1.2) continue
          inC.add(v)
          nodes.push(v)
        }
      }
    }
    const q: number[] = []
    for (const u of nodes) {
      const c = u >> 1, ci = c % w, cj = (c - ci) / w
      let edge = false
      for (let d = 0; d < 8 && !edge; d++) {
        const ii = ci + DX[d], jj = cj + DY[d]
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) edge = true
        else {
          const cc = jj * w + ii
          if (!inC.has(2 * cc) && !inC.has(2 * cc + 1)) edge = true
        }
      }
      if (edge) (comp.set(u, 0), q.push(u))
    }
    for (let k = 0; k < q.length; k++) {
      const u = q[k], du = comp.get(u)!, c = u >> 1, ci = c % w, cj = (c - ci) / w
      for (let d = 0; d < 8; d++) {
        const ii = ci + DX[d], jj = cj + DY[d]
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue
        for (let l = 0; l < 2; l++) {
          const v = 2 * (jj * w + ii) + l
          if (!inC.has(v) || comp.has(v)) continue
          comp.set(v, du + 1)
          q.push(v)
        }
      }
    }
  }

  /** depth (cells from the edge) of the roof node under (x, y) near height z, or -1 if not on the roof */
  depthAt(x: number, y: number, z: number): number {
    const n = this.nav.nodeAt(x, y, z)
    if (n < 0 || Math.abs(this.nav.hz[n] - z) > 1.6) return -1
    const d = this.comp.get(n)
    return d === undefined ? -1 : d
  }

  onRoof(p: ArrayLike<number>, grounded: boolean): boolean {
    return !!this.roof && grounded && this.depthAt(p[0], p[1], p[2]) >= 0
  }

  /** on the roof and hurt: hold fire on passive targets so HP regenerates */
  healing(hpFrac: number, p: ArrayLike<number>, grounded: boolean): boolean {
    if (!this.onRoof(p, grounded)) return false
    return hpFrac < (PRM.roofRefuge ? PRM.refugeExitHp : PRM.roofHealHp)
  }

  /** Refuge variant: v2 plays as usual; hurt, it climbs the nearest good roof, heals to full there, comes back down. */
  private refugeControl(inp: RoofIn): RoofOut | null {
    const t = inp.t, P = inp.pos
    const on = this.onRoof(P, inp.grounded)
    if (!this.refuge) {
      if (inp.hpFrac >= PRM.refugeHp || inp.threatDist < PRM.refugeMinThreat || inp.hurtAgo < PRM.refugeCalmS) return null
      const r = this.choose(inp, PRM.refugeR, 3)
      if (!r) return null
      if (r !== this.roof) {
        this.roof = r
        this.buildComp(r)
        this.stats.roofsChosen++
      }
      if (!this.comp.size) return null
      this.refuge = true
      this.refugeT = t
      this.stats.refuges++
    }
    const r = this.roof!
    const onNow = this.onRoof(P, inp.grounded)
    if (onNow && inp.hpFrac >= PRM.refugeExitHp) {
      this.refuge = false
      this.stats.healed++
      return null
    }
    // give up: the trip takes too long, or the zone moved away from the roof
    if ((!onNow && t - this.refugeT > PRM.refugeMaxTravelS) || !this.zoneOk(r, inp.zone, -PRM.roofZoneMin * 0.5)) {
      this.refuge = false
      return null
    }
    void on
    if (!onNow) {
      this.follow.setGoal(r.sx, r.sy, r.sz, 2.5)
      const o = this.follow.update({ t, pos: P, vel: inp.vel, grounded: inp.grounded, energy: inp.energy, climbEnergyPerM: inp.climbPerM })
      const dRoof = Math.hypot(r.sx - P[0], r.sy - P[1])
      const need = r.climb * inp.climbPerM + 25
      const boost = o.boost || (dRoof > 30 && inp.energy > need + 15 && inp.grounded)
      return { move: o.move, boost, jump: o.jump, mode: `refuge-go:${o.state}`, pathed: true }
    }
    this.refugeT = t
    const out = this.hold(inp, PRM.refugePeekHp)
    out.mode = "refuge-" + out.mode
    return out
  }

  /** Movement for this tick, or null to leave it to the v2 logic. */
  control(inp: RoofIn): RoofOut | null {
    if (!this.roofs.length) return null
    const t = inp.t, P = inp.pos
    if (PRM.roofRefuge || PRM.roofIdle) {
      const o = PRM.roofRefuge ? this.refugeControl(inp) : null
      this.track(inp, !!o)
      return o
    }
    if (!this.started) {
      if (!(inp.armed || !inp.knownWeapon || t >= PRM.roofLootS)) return null
      // late fortress: keep playing v2 until this many kills or this match time
      if (!(inp.kills >= PRM.roofStartKills || t >= PRM.roofStartT)) return null
      this.started = true
    }
    // (re)choose: no roof yet, or the zone no longer covers it
    if (t >= this.nextCheck) {
      this.nextCheck = t + 1
      if (!this.roof || !this.zoneOk(this.roof, inp.zone, -PRM.roofZoneMin * 0.5)) {
        const r = this.choose(inp)
        if (r !== this.roof) {
          this.roof = r
          if (r) {
            this.buildComp(r)
            this.stats.roofsChosen++
          } else this.comp.clear()
        }
      }
    }
    const r = this.roof
    if (!r || !this.comp.size) return null
    const on = this.onRoof(P, inp.grounded)
    if (this.stats.lastT >= 0 && this.stats.on) this.stats.onRoofS += Math.min(0.3, t - this.stats.lastT)
    this.stats.lastT = t
    this.stats.on = on
    if (on && this.stats.firstOnRoof < 0) this.stats.firstOnRoof = t
    if (!on) {
      // close threat on the ground away from the roof: fight it the v2 way
      const dRoof = Math.hypot(r.sx - P[0], r.sy - P[1])
      if (inp.threatDist < PRM.roofFightR && dRoof > 40 && P[2] < r.sz - 3) return null
      this.follow.setGoal(r.sx, r.sy, r.sz, 2.5)
      const o = this.follow.update({ t, pos: P, vel: inp.vel, grounded: inp.grounded, energy: inp.energy, climbEnergyPerM: inp.climbPerM })
      const need = r.climb * inp.climbPerM + 25
      const boost = o.boost || (dRoof > 70 && inp.energy > need + 20 && inp.grounded)
      return { move: o.move, boost, jump: o.jump, mode: `roof-go:${o.state}`, pathed: true }
    }
    return this.hold(inp)
  }

  /** on-roof bookkeeping for local tools (once or twice per tick: control, then maybe idle) */
  private track(inp: RoofIn, controlled: boolean) {
    const t = inp.t
    const on = controlled && this.onRoof(inp.pos, inp.grounded)
    if (this.stats.lastT >= 0 && this.stats.on) this.stats.onRoofS += Math.min(0.3, t - this.stats.lastT)
    this.stats.lastT = t
    this.stats.on = on
    if (on && this.stats.firstOnRoof < 0) this.stats.firstOnRoof = t
  }

  /**
   * Idle variant (P.roofIdle): bot.ts calls this when the squad logic has nothing to do (no target, nothing
   * to loot or hunt). Wait on a nearby roof inside the next zone instead of the open ground; null = no roof.
   */
  idle(inp: RoofIn): RoofOut | null {
    if (!PRM.roofIdle || !this.roofs.length || this.refuge || inp.t < PRM.roofIdleT) return null
    const t = inp.t, P = inp.pos
    if (t >= this.idleCheck || !this.roof || !this.comp.size) {
      this.idleCheck = t + 1
      const r0 = this.roof
      const keep = !!r0 && this.comp.size > 0 && this.zoneOk(r0, inp.zone) && Math.hypot(r0.sx - P[0], r0.sy - P[1]) <= PRM.roofIdleR * 1.25
      if (!keep) {
        const r = this.choose(inp, PRM.roofIdleR, 3)
        if (r !== this.roof) {
          this.roof = r
          if (r) {
            this.buildComp(r)
            this.stats.roofsChosen++
          } else this.comp.clear()
        }
      }
    }
    const r = this.roof
    if (!r || !this.comp.size) return null
    let out: RoofOut
    if (!this.onRoof(P, inp.grounded)) {
      this.follow.setGoal(r.sx, r.sy, r.sz, 2.5)
      const o = this.follow.update({ t, pos: P, vel: inp.vel, grounded: inp.grounded, energy: inp.energy, climbEnergyPerM: inp.climbPerM })
      out = { move: o.move, boost: o.boost, jump: o.jump, mode: `idle-go:${o.state}`, pathed: true }
      this.lastIdleT = -1
    } else {
      if (this.lastIdleT >= 0) this.stats.idleS += Math.min(0.3, t - this.lastIdleT)
      this.lastIdleT = t
      out = this.hold(inp, PRM.refugePeekHp)
      out.mode = "idle-" + out.mode
    }
    this.track(inp, true)
    return out
  }

  private hold(inp: RoofIn, peekHp = PRM.roofPeekHp): RoofOut {
    const P = inp.pos, W = this.world, r = this.roof!
    const size = inp.mySize
    const tgt = inp.target
    const engage = !!tgt && (inp.hpFrac >= peekHp || Math.hypot(tgt.x - P[0], tgt.y - P[1]) < 25)
    const enemies = inp.enemies.slice().sort((a, b) => Math.hypot(a.x - P[0], a.y - P[1]) - Math.hypot(b.x - P[0], b.y - P[1])).slice(0, 5)
    const z0 = P[2]
    let bx = P[0], by = P[1], bScore = Infinity, bLos = false, bSeen = 0, nHd = 0, nLos = 0
    const tb = tgt ? Math.atan2(tgt.y - P[1], tgt.x - P[0]) : 0
    const eval1 = (x: number, y: number) => {
      const d = this.depthAt(x, y, z0)
      if (d < PRM.roofEdgeDepth) return
      const n = this.nav.nodeAt(x, y, z0)
      const cz = this.nav.hz[n]
      let exposure = 0, los = false, tSeen = 0
      for (const e of enemies) {
        const es = 1 + 0.05 * e.cubes
        this.a[0] = e.x, this.a[1] = e.y, this.a[2] = e.z + 7 * es
        this.b[0] = x, this.b[1] = y, this.b[2] = cz + 4.5 * size
        // hull-down: shots aimed at our center that the roof edge stops count less than an open line
        let seen = W.shotClear(this.a, this.b) ? 1 : 0
        if (!seen) {
          this.b[2] = cz + 8.5 * size
          seen = W.shotClear(this.a, this.b) ? PRM.roofTopW : 0
        }
        if (tgt && e === tgt) {
          // our shot line from this point (muzzle above our center) to the target's center
          this.a[0] = x, this.a[1] = y, this.a[2] = cz + 7 * size
          this.b[0] = e.x, this.b[1] = e.y, this.b[2] = e.z + 4.5 * es
          los = W.shotClear(this.a, this.b)
          tSeen = seen
          exposure += seen * (engage ? PRM.roofTgtExpW : 1.5)
        } else exposure += seen * (e.threat ? 1 : 0.5)
      }
      const dm = Math.hypot(x - P[0], y - P[1])
      let s = exposure + dm * 0.03 - 0.04 * Math.min(d, 4)
      if (engage) {
        if (!los) s += 2
        else if (dm > 0.5) {
          // jink: prefer stepping to the current strafe side across the target line
          const lat = (-(y - P[1]) * Math.cos(tb) + (x - P[0]) * Math.sin(tb)) / dm
          s -= 0.25 * lat * -inp.jinkSign
        }
      } else if (!enemies.length) s += Math.hypot(x - r.sx, y - r.sy) * 0.02
      if (los) nLos++
      if (los && tSeen < 1) nHd++
      if (s < bScore) (bScore = s), (bx = x), (by = y), (bLos = los), (bSeen = tSeen)
    }
    eval1(P[0], P[1])
    for (const rad of [3, 6, 10, 16]) for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6 + rad * 0.37
      eval1(P[0] + Math.cos(a) * rad, P[1] + Math.sin(a) * rad)
    }
    eval1(r.sx, r.sy)
    if (tgt) {
      // the edge point toward the target (peek)
      for (const f of [0.5, 0.8]) {
        const dd = Math.hypot(tgt.x - P[0], tgt.y - P[1]) * f
        const step = Math.min(dd, 30)
        eval1(P[0] + Math.cos(tb) * step, P[1] + Math.sin(tb) * step)
      }
    }
    const dx = bx - P[0], dy = by - P[1], dl = Math.hypot(dx, dy)
    let move: [number, number] = [0, 0]
    let mode = engage ? (bLos ? "roof-fight" : "roof-peek") : enemies.length ? "roof-hide" : "roof-hold"
    if (tgt) mode += `:los${nLos}hd${nHd}s${bSeen}`
    if (dl > 0.8) {
      const sp = engage || enemies.length ? 1 : dl > 4 ? 1 : 0.4
      move = [(dx / dl) * sp, (dy / dl) * sp]
    } else if (engage && bLos) {
      // at the best point with a shot: small strafe steps keep the enemy's lead wrong
      const px = -Math.sin(tb) * inp.jinkSign, py = Math.cos(tb) * inp.jinkSign
      if (this.depthAt(P[0] + px * 3, P[1] + py * 3, z0) >= PRM.roofEdgeDepth) move = [px, py]
    }
    return { move: this.clampMove(P, move), boost: false, jump: false, mode, pathed: false }
  }

  /** keep a move from leaving the roof: rotate it toward safe ground or stop */
  clampMove(P: ArrayLike<number>, move: [number, number]): [number, number] {
    const l = Math.hypot(move[0], move[1])
    if (l < 1e-6 || !this.roof) return move
    const z = P[2]
    const look = 3.5
    const ok = (ux: number, uy: number) => this.depthAt(P[0] + ux * look, P[1] + uy * look, z) >= 0 && this.depthAt(P[0] + ux * 1.5, P[1] + uy * 1.5, z) >= 0
    const ux = move[0] / l, uy = move[1] / l
    if (ok(ux, uy)) return move
    for (const da of [0.5, -0.5, 1.0, -1.0, 1.5, -1.5]) {
      const c = Math.cos(da), s = Math.sin(da)
      const vx = ux * c - uy * s, vy = ux * s + uy * c
      if (ok(vx, vy)) return [vx * l, vy * l]
    }
    // nothing safe ahead: head back to the spot
    const bx = this.roof.sx - P[0], by = this.roof.sy - P[1], bl = Math.hypot(bx, by)
    return bl > 1 ? [(bx / bl) * 0.6, (by / bl) * 0.6] : [0, 0]
  }
}
