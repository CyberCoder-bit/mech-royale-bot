/**
 * Path following (per bot instance): plans with the Pathfinder, smooths with lineWalkable,
 * steers toward a lookahead point, performs climbs (jump + jets) and drops, and detects and
 * recovers from stuck states (jet hop, then re-plan with a temporary penalty on the spot).
 */
import { EDGE_CLIMB, EDGE_DROP, type NavGrid, Pathfinder, type PathResult } from "./nav.ts"

export type FollowIn = {
  t: number
  pos: ArrayLike<number>
  vel: ArrayLike<number>
  grounded: boolean
  energy: number
  /** energy spent per meter of climb (jet_drain / max_rise_speed), plus margin applied inside */
  climbEnergyPerM?: number
}

export type FollowOut = {
  move: [number, number]
  jump: boolean
  boost: boolean
  /** distance left along the path (m, approx) */
  remaining: number
  /** true when we are at the goal */
  arrived: boolean
  /** current steering point (for debug drawing) */
  steer: [number, number, number] | null
  state: string
}

type Goal = { x: number; y: number; z: number; tol: number }

export class PathFollower {
  nav: NavGrid
  pf: Pathfinder
  private goal: Goal | null = null
  private path: PathResult | null = null
  private px: number[] = []
  private py: number[] = []
  private pz: number[] = []
  private kinds: number[] = []
  private idx = 0
  private planT = -99
  private lastProgressT = 0
  private progressPos: [number, number, number] = [0, 0, 0]
  private stuckLevel = 0
  private hopUntil = -1
  private climbIdx = -1
  private climbStartT = -1
  private waitEnergyUntil = -1
  /** replan at least this often (s) */
  replanEvery = 3
  /** A* time budget per plan (ms) */
  planMs = 6
  maxClimb = 50

  constructor(nav: NavGrid) {
    this.nav = nav
    this.pf = new Pathfinder(nav)
  }

  clear() {
    this.goal = null
    this.path = null
    this.px.length = this.py.length = this.pz.length = this.kinds.length = 0
  }

  hasGoal() {
    return this.goal !== null
  }

  goalPos(): Goal | null {
    return this.goal
  }

  /** Set (or update) the goal. Replans when it moved more than `replanDist`. */
  setGoal(x: number, y: number, z: number, tol = 2.5, replanDist = 6) {
    const g = this.goal
    if (g && Math.hypot(g.x - x, g.y - y) < replanDist && Math.abs(g.z - z) < 4) {
      g.tol = tol
      return
    }
    this.goal = { x, y, z, tol }
    this.planT = -99 // force a replan
  }

  private plan(t: number, x: number, y: number, z: number, energy: number, climbPerM: number) {
    const g = this.goal!
    const maxClimb = Math.max(0, Math.min(this.maxClimb, (energy - 8) / climbPerM))
    const res = this.pf.findPath(x, y, z, g.x, g.y, g.z, { maxMs: this.planMs, maxClimb: Math.max(maxClimb, 12) })
    this.planT = t
    this.path = res
    this.px.length = this.py.length = this.pz.length = this.kinds.length = 0
    const nav = this.nav
    for (let i = 0; i < res.nodes.length; i++) {
      const n = res.nodes[i]
      this.px.push(nav.nodeX(n))
      this.py.push(nav.nodeY(n))
      this.pz.push(nav.hz[n])
      this.kinds.push(res.kinds[i])
    }
    // the exact goal point as the final waypoint when the goal cell was reached
    if (res.status === "ok" && this.px.length) {
      const L = this.px.length - 1
      if (Math.hypot(this.px[L] - g.x, this.py[L] - g.y) < 3) {
        this.px[L] = g.x
        this.py[L] = g.y
      }
    }
    this.idx = this.px.length > 1 ? 1 : 0
    this.climbIdx = -1
  }

  /** Index of the next climb/drop edge at or after i (the edge into node k), or -1. */
  private nextSpecial(i: number): number {
    for (let k = Math.max(1, i); k < this.kinds.length; k++) if (this.kinds[k] === EDGE_CLIMB || this.kinds[k] === EDGE_DROP) return k
    return -1
  }

  /** Feed one observation; returns the movement command. */
  update(inp: FollowIn): FollowOut {
    const out: FollowOut = { move: [0, 0], jump: false, boost: false, remaining: 0, arrived: false, steer: null, state: "idle" }
    const g = this.goal
    if (!g) return out
    const x = inp.pos[0], y = inp.pos[1], z = inp.pos[2]
    const t = inp.t
    const climbPerM = inp.climbEnergyPerM ?? 1.6
    const dGoal = Math.hypot(g.x - x, g.y - y)
    if (dGoal <= g.tol && Math.abs(g.z - z) < 3) {
      out.arrived = true
      out.state = "arrived"
      this.stuckLevel = 0
      this.lastProgressT = t
      this.progressPos = [x, y, z]
      return out
    }

    // progress / stuck bookkeeping
    if (Math.hypot(x - this.progressPos[0], y - this.progressPos[1]) > 1.5 || Math.abs(z - this.progressPos[2]) > 1.5) {
      this.progressPos = [x, y, z]
      this.lastProgressT = t
      if (this.stuckLevel > 0 && t > this.hopUntil) this.stuckLevel = 0
    }

    // (re)plan
    let needPlan = !this.path || t - this.planT > this.replanEvery
    if (!needPlan && this.px.length) {
      // deviated from the path?
      const i = Math.min(this.idx, this.px.length - 1)
      const j = Math.max(0, i - 1)
      const dd = distToSeg(x, y, this.px[j], this.py[j], this.px[i], this.py[i])
      if (dd > 7 && this.climbIdx < 0) needPlan = true
    }
    if (!needPlan && this.path && this.path.status !== "ok" && t - this.planT > 1) needPlan = true
    if (needPlan) this.plan(t, x, y, z, inp.energy, climbPerM)
    const P = this.px.length
    if (P === 0) {
      // no path: head straight for the goal
      out.move = unitv(g.x - x, g.y - y)
      out.state = "direct"
      return this.unstick(inp, out)
    }

    // advance waypoints we have reached
    while (this.idx < P - 1) {
      const k = this.kinds[this.idx]
      const near = Math.hypot(this.px[this.idx] - x, this.py[this.idx] - y)
      const zOk = Math.abs(this.pz[this.idx] - z) < (k === EDGE_CLIMB ? 1.5 : 3)
      if (near < 2.2 && zOk) {
        this.idx++
        continue
      }
      // passed it: projection onto the next segment is beyond the waypoint
      if (k !== EDGE_CLIMB && k !== EDGE_DROP && this.idx + 1 < P) {
        const ax = this.px[this.idx], ay = this.py[this.idx]
        const bx = this.px[this.idx + 1], by = this.py[this.idx + 1]
        const dot = (x - ax) * (bx - ax) + (y - ay) * (by - ay)
        if (dot > 0 && near < 4 && Math.abs(this.pz[this.idx] - z) < 3) {
          this.idx++
          continue
        }
      }
      break
    }

    // climbing state machine
    const sp = this.nextSpecial(this.idx)
    if (sp >= 0 && this.kinds[sp] === EDGE_CLIMB) {
      const fx = this.px[sp - 1], fy = this.py[sp - 1] // departure (wall foot)
      const tx = this.px[sp], ty = this.py[sp], tz = this.pz[sp]
      const dFoot = Math.hypot(fx - x, fy - y)
      const dTop = Math.hypot(tx - x, ty - y)
      if (this.climbIdx === sp || (sp === this.idx && dFoot < 3.5) || (sp <= this.idx + 1 && dTop < 7)) {
        const need = (tz - z) * climbPerM + 6
        if (this.climbIdx !== sp) {
          if (inp.grounded && inp.energy < need && z < tz - 1) {
            // wait for energy at the foot of the wall
            if (this.waitEnergyUntil < 0) this.waitEnergyUntil = t + 8
            if (t < this.waitEnergyUntil) {
              out.move = [0, 0]
              out.state = "wait-energy"
              this.lastProgressT = t
              return out
            }
            // waited too long: plan without this climb
            this.waitEnergyUntil = -1
            this.planT = -99
            this.maxClimb = Math.max(4, (tz - z) - 2)
            out.state = "climb-abort"
            return out
          }
          this.waitEnergyUntil = -1
          this.climbIdx = sp
          this.climbStartT = t
        }
        out.state = "climb"
        out.steer = [tx, ty, tz]
        out.move = unitv(tx - x, ty - y)
        if (z < tz + 0.6) {
          if (inp.grounded) out.jump = true
          else out.boost = inp.energy > 1
        }
        if (z >= tz - 0.3 && dTop < 2.5) {
          this.climbIdx = -1
          this.idx = Math.min(P - 1, sp + 1)
          this.maxClimb = 50
        }
        if (t - this.climbStartT > 9) {
          this.climbIdx = -1
          this.planT = -99
        }
        this.lastProgressT = Math.max(this.lastProgressT, t - 0.5)
        return out
      }
    }
    if (this.climbIdx >= 0 && (sp < 0 || this.kinds[sp] !== EDGE_CLIMB)) this.climbIdx = -1

    // steer: the farthest waypoint reachable in a straight flat walk, not past the next special edge
    const lim = sp >= 0 ? sp - 1 : P - 1
    let tgt = Math.min(this.idx, P - 1)
    const maxLook = Math.min(lim, this.idx + 14)
    for (let j = maxLook; j > this.idx; j--) {
      if (this.nav.lineWalkable(x, y, z, this.px[j], this.py[j], 40)) {
        tgt = j
        break
      }
    }
    if (sp >= 0 && this.kinds[sp] === EDGE_DROP && tgt >= sp - 1 && Math.hypot(this.px[sp - 1] - x, this.py[sp - 1] - y) < 2.5) {
      tgt = sp // walk off the edge toward the landing
      out.state = "drop"
    } else out.state = "walk"
    const sx = this.px[tgt], sy = this.py[tgt]
    out.steer = [sx, sy, this.pz[tgt]]
    out.move = unitv(sx - x, sy - y)
    // slow down near the final goal
    let rem = Math.hypot(sx - x, sy - y)
    for (let j = tgt; j + 1 < P; j++) rem += Math.hypot(this.px[j + 1] - this.px[j], this.py[j + 1] - this.py[j])
    out.remaining = rem
    if (tgt === P - 1 && rem < 3) {
      const s = Math.max(0.3, rem / 3)
      out.move = [out.move[0] * s, out.move[1] * s]
    }
    return this.unstick(inp, out)
  }

  /** Stuck recovery: no progress for ~1.2 s while trying to move. */
  private unstick(inp: FollowIn, out: FollowOut): FollowOut {
    const t = inp.t
    const moving = Math.hypot(out.move[0], out.move[1]) > 0.3
    if (!moving) {
      this.lastProgressT = t
      return out
    }
    if (t < this.hopUntil) {
      if (inp.grounded) out.jump = true
      else out.boost = inp.energy > 3
      out.state += "+hop"
      return out
    }
    if (t - this.lastProgressT > 1.2) {
      this.stuckLevel++
      this.lastProgressT = t
      if (this.stuckLevel <= 2 && inp.energy > 15) {
        this.hopUntil = t + 0.9
        out.jump = inp.grounded
        out.state += "+hop"
      } else {
        // penalize this spot and replan
        const c = this.nav.cellOf(inp.pos[0], inp.pos[1])
        if (c >= 0) {
          const w = this.nav.w
          for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) this.pf.cellPenalty.set(c + dj * w + di, 25)
          if (this.pf.cellPenalty.size > 600) this.pf.cellPenalty.clear()
        }
        this.planT = -99
        this.stuckLevel = 0
        out.state += "+replan"
      }
    }
    return out
  }

  /** Waypoints of the current path from the current index (for debug drawing). */
  waypoints(max = 30): [number, number, number][] {
    const r: [number, number, number][] = []
    for (let i = this.idx; i < this.px.length && r.length < max; i++) r.push([this.px[i], this.py[i], this.pz[i]])
    return r
  }
}

function unitv(dx: number, dy: number): [number, number] {
  const l = Math.hypot(dx, dy)
  return l > 1e-6 ? [dx / l, dy / l] : [0, 0]
}

function distToSeg(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax, ey = by - ay
  const l2 = ex * ex + ey * ey
  let t = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(ax + ex * t - x, ay + ey * t - y)
}
