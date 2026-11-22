/**
 * Navigation grid (2.5D) and A* search.
 *
 * Every 2 m cell holds up to two standing surfaces ("layers"): the lowest and the highest place a
 * mech fits (≥ mech height of free space above): open ground, a roof, a bridge deck, or the ground
 * under a high bridge. A node is cell*2 + layer. Node state: 0 = none, 1 = free, 2 = band (closer
 * than the mech radius to a wall that overlaps the body's height range there). Edges are implicit
 * between 8-neighbors (walk within step_up / max slope, drop down, or jet up), plus precomputed
 * "hop" edges that cross band cells: walking off a roof edge, or jetting up a wall onto a roof.
 *
 * NavGrid is immutable and can be shared; Pathfinder holds the per-bot search scratch arrays.
 */
import type { World } from "./world.ts"

export type NavOpts = {
  cell?: number
  /** clearance radius (mech radius + margin) */
  radius?: number
  /** free height a standing mech needs */
  height?: number
  stepUp?: number
  maxSlopeDeg?: number
  /** highest climb (m) an edge may need */
  maxJet?: number
  /** cost per meter climbed (in meters of walking) */
  climbCost?: number
  /** flat cost of a drop */
  dropCost?: number
  /** extra cost (m per step) near walls, to keep paths off them */
  wallPen?: number
  wallPenDist?: number
}

export const EDGE_WALK = 0
export const EDGE_CLIMB = 1
export const EDGE_DROP = 2

const DX = [1, -1, 0, 0, 1, 1, -1, -1]
const DY = [0, 0, 1, -1, 1, -1, 1, -1]

export class NavGrid {
  world: World
  cs: number
  ox: number
  oy: number
  w: number
  h: number
  nCells: number
  N: number
  hz: Float32Array
  st: Uint8Array
  terr: Uint8Array
  /** free height above the surface up to the next solid (Infinity when open sky) */
  ceil: Float32Array
  /** near-wall penalty per node (m per step) */
  pen: Float32Array
  /** hop edges: for node u, entries [xStart[u], xStart[u+1]) */
  xStart: Int32Array
  xTo: Int32Array
  xCost: Float32Array
  xDh: Float32Array
  xKind: Uint8Array
  radius: number
  height: number
  stepUp: number
  slopeTan: number
  maxJet: number
  climbCost: number
  dropCost: number
  buildMs = 0

  private constructor(world: World, o: Required<NavOpts>) {
    this.world = world
    this.cs = o.cell
    this.ox = world.minX
    this.oy = world.minY
    this.w = Math.ceil((world.maxX - world.minX) / o.cell)
    this.h = Math.ceil((world.maxY - world.minY) / o.cell)
    this.nCells = this.w * this.h
    this.N = this.nCells * 2
    this.hz = new Float32Array(this.N).fill(NaN)
    this.st = new Uint8Array(this.N)
    this.terr = new Uint8Array(this.N)
    this.ceil = new Float32Array(this.N)
    this.pen = new Float32Array(this.N)
    this.radius = o.radius
    this.height = o.height
    this.stepUp = o.stepUp
    this.slopeTan = Math.tan((o.maxSlopeDeg * Math.PI) / 180)
    this.maxJet = o.maxJet
    this.climbCost = o.climbCost
    this.dropCost = o.dropCost
    this.xStart = new Int32Array(this.N + 1)
    this.xTo = new Int32Array(0)
    this.xCost = new Float32Array(0)
    this.xDh = new Float32Array(0)
    this.xKind = new Uint8Array(0)
  }

  static build(world: World, opts: NavOpts = {}): NavGrid {
    const t0 = performance.now()
    const o: Required<NavOpts> = {
      cell: 2,
      radius: 2.7,
      height: 9.3,
      stepUp: 1.2,
      maxSlopeDeg: 50,
      maxJet: 52,
      climbCost: 2.5,
      dropCost: 2,
      wallPen: 0.6,
      wallPenDist: 4.5,
      ...opts,
    }
    const g = new NavGrid(world, o)
    const { cs, ox, oy, w, h, nCells } = g
    const H = o.height, R = o.radius, SU = o.stepUp

    // 1. which prisms cover each cell center (scanline fill)
    const covHead = new Int32Array(nCells).fill(-1)
    const covNext: number[] = []
    const covK: number[] = []
    const xs: number[] = []
    for (let k = 0; k < world.nPrisms; k++) {
      const j0 = Math.max(0, Math.ceil((world.pMinY[k] - oy) / cs - 0.5))
      const j1 = Math.min(h - 1, Math.floor((world.pMaxY[k] - oy) / cs - 0.5))
      for (let j = j0; j <= j1; j++) {
        const yc = oy + (j + 0.5) * cs
        xs.length = 0
        for (let e = world.pE0[k]; e < world.pE1[k]; e++) {
          const y0 = world.ey0[e], y1 = world.ey1[e]
          if (y0 > yc !== y1 > yc) xs.push(world.ex0[e] + ((yc - y0) / (y1 - y0)) * (world.ex1[e] - world.ex0[e]))
        }
        xs.sort((a, b) => a - b)
        for (let q = 0; q + 1 < xs.length; q += 2) {
          const i0 = Math.max(0, Math.ceil((xs[q] - ox) / cs - 0.5))
          const i1 = Math.min(w - 1, Math.floor((xs[q + 1] - ox) / cs - 0.5))
          for (let i = i0; i <= i1; i++) {
            const c = j * w + i
            covNext.push(covHead[c])
            covK.push(k)
            covHead[c] = covK.length - 1
          }
        }
      }
    }
    const covers = (c: number, k: number) => {
      for (let p = covHead[c]; p >= 0; p = covNext[p]) if (covK[p] === k) return true
      return false
    }

    // 2. standing surfaces per column
    const ivB: number[] = [], ivT: number[] = [], order: number[] = []
    const surf: number[] = [], surfCeil: number[] = []
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const c = j * w + i
        const x = ox + (i + 0.5) * cs, y = oy + (j + 0.5) * cs
        const gz = world.groundZ(x, y)
        surf.length = 0
        surfCeil.length = 0
        if (covHead[c] < 0) {
          surf.push(gz)
          surfCeil.push(Infinity)
        } else {
          ivB.length = 0
          ivT.length = 0
          order.length = 0
          for (let p = covHead[c]; p >= 0; p = covNext[p]) {
            ivB.push(world.pBase[covK[p]])
            ivT.push(world.pTop[covK[p]])
            order.push(order.length)
          }
          order.sort((a, b) => ivB[a] - ivB[b])
          let cur = gz
          for (const q of order) {
            if (ivB[q] > cur) {
              if (ivB[q] - cur >= H) {
                surf.push(cur)
                surfCeil.push(ivB[q] - cur)
              }
              cur = ivT[q]
            } else if (ivT[q] > cur) cur = ivT[q]
          }
          surf.push(cur)
          surfCeil.push(Infinity)
        }
        const n0 = 2 * c
        g.hz[n0] = surf[0]
        g.ceil[n0] = surfCeil[0]
        g.st[n0] = 1
        g.terr[n0] = surf[0] === gz ? 1 : 0
        if (surf.length > 1) {
          const L = surf.length - 1
          g.hz[n0 + 1] = surf[L]
          g.ceil[n0 + 1] = surfCeil[L]
          g.st[n0 + 1] = 1
        }
        // map edge is a wall
        if (x < world.minX + R || x > world.maxX - R || y < world.minY + R || y > world.maxY - R) {
          g.st[n0] = 0
          g.st[n0 + 1] = 0
        }
      }

    // 3. clearance band and near-wall penalty around prism walls
    const RP = R + o.wallPenDist
    for (let k = 0; k < world.nPrisms; k++) {
      const base = world.pBase[k], top = world.pTop[k]
      for (let e = world.pE0[k]; e < world.pE1[k]; e++) {
        const ax = world.ex0[e], ay = world.ey0[e], bx = world.ex1[e], by = world.ey1[e]
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - RP - ox) / cs))
        const i1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + RP - ox) / cs))
        const j0 = Math.max(0, Math.floor((Math.min(ay, by) - RP - oy) / cs))
        const j1 = Math.min(h - 1, Math.floor((Math.max(ay, by) + RP - oy) / cs))
        const ex = bx - ax, ey = by - ay
        const l2 = ex * ex + ey * ey
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const x = ox + (i + 0.5) * cs, y = oy + (j + 0.5) * cs
            let t = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / l2 : 0
            if (t < 0) t = 0
            else if (t > 1) t = 1
            const qx = ax + ex * t - x, qy = ay + ey * t - y
            const d = Math.sqrt(qx * qx + qy * qy)
            if (d >= RP) continue
            const c = j * w + i
            if (covers(c, k)) continue
            for (let l = 0; l < 2; l++) {
              const n = 2 * c + l
              if (g.st[n] === 0) continue
              const hz = g.hz[n]
              if (!(base < hz + H && top > hz + SU)) continue
              if (d < R) g.st[n] = 2
              else {
                const p = o.wallPen * (1 - (d - R) / o.wallPenDist)
                if (p > g.pen[n]) g.pen[n] = p
              }
            }
          }
      }
    }

    // 4. hop edges across band cells (roof edge drops, wall climbs onto roofs)
    const hopFrom: number[] = [], hopTo: number[] = [], hopCost: number[] = [], hopDh: number[] = [], hopKind: number[] = []
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const c = j * w + i
        for (let l = 0; l < 2; l++) {
          const u = 2 * c + l
          if (g.st[u] !== 1) continue
          const hu = g.hz[u]
          // only nodes next to a band cell can hop
          let nearBand = false
          for (let d = 0; d < 8 && !nearBand; d++) {
            const ii = i + DX[d], jj = j + DY[d]
            if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue
            const cc = jj * w + ii
            if (g.st[2 * cc] === 2 || g.st[2 * cc + 1] === 2) nearBand = true
          }
          if (!nearBand) continue
          for (let d = 0; d < 8; d++) {
            const diag = d >= 4
            for (let s = 1; s <= 4; s++) {
              const ii = i + DX[d] * s, jj = j + DY[d] * s
              if (ii < 0 || jj < 0 || ii >= w || jj >= h) break
              const cc = jj * w + ii
              let stop = false
              for (let l2 = 0; l2 < 2; l2++) {
                const v = 2 * cc + l2
                if (g.st[v] !== 1) continue
                const dh = g.hz[v] - hu
                if (Math.abs(dh) <= SU * 1.5) {
                  stop = true // same level reachable (or a gap too narrow): not a hop
                  continue
                }
                stop = true
                if (s === 1) continue // adjacent: handled by the implicit edges
                const len = s * cs * (diag ? Math.SQRT2 : 1)
                if (dh > 0) {
                  if (dh > o.maxJet || g.ceil[u] < dh + H) continue
                  hopFrom.push(u), hopTo.push(v), hopCost.push(len + dh * o.climbCost + 2), hopDh.push(dh), hopKind.push(EDGE_CLIMB)
                } else {
                  hopFrom.push(u), hopTo.push(v), hopCost.push(len + o.dropCost), hopDh.push(dh), hopKind.push(EDGE_DROP)
                }
              }
              if (stop) break
            }
          }
        }
      }
    const nh = hopFrom.length
    const cnt = g.xStart
    for (let q = 0; q < nh; q++) cnt[hopFrom[q] + 1]++
    for (let n = 0; n < g.N; n++) cnt[n + 1] += cnt[n]
    g.xTo = new Int32Array(nh)
    g.xCost = new Float32Array(nh)
    g.xDh = new Float32Array(nh)
    g.xKind = new Uint8Array(nh)
    const fill = cnt.slice(0, g.N)
    for (let q = 0; q < nh; q++) {
      const p = fill[hopFrom[q]]++
      g.xTo[p] = hopTo[q]
      g.xCost[p] = hopCost[q]
      g.xDh[p] = hopDh[q]
      g.xKind[p] = hopKind[q]
    }
    g.buildMs = performance.now() - t0
    return g
  }

  summary() {
    let free = 0, band = 0, roof = 0
    for (let n = 0; n < this.N; n++) {
      if (this.st[n] === 1) {
        free++
        if (!this.terr[n]) roof++
      } else if (this.st[n] === 2) band++
    }
    return { cells: this.nCells, free, band, nonTerrainFree: roof, hops: this.xTo.length, buildMs: Math.round(this.buildMs) }
  }

  cellOf(x: number, y: number): number {
    const i = Math.floor((x - this.ox) / this.cs), j = Math.floor((y - this.oy) / this.cs)
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1
    return j * this.w + i
  }
  nodeX(n: number): number {
    return this.ox + (((n >> 1) % this.w) + 0.5) * this.cs
  }
  nodeY(n: number): number {
    return this.oy + (Math.floor((n >> 1) / this.w) + 0.5) * this.cs
  }
  nodeZ(n: number): number {
    return this.hz[n]
  }

  /** The node of the surface a mech at (x, y, z feet) is on: the layer closest below z + slack. */
  nodeAt(x: number, y: number, z: number, freeOnly = true): number {
    const c = this.cellOf(x, y)
    if (c < 0) return -1
    let best = -1, bd = Infinity
    for (let l = 0; l < 2; l++) {
      const n = 2 * c + l
      if (this.st[n] === 0 || (freeOnly && this.st[n] !== 1)) continue
      const dz = this.hz[n] - z
      const d = dz > 2 ? dz * 4 : Math.abs(dz)
      if (d < bd) (bd = d), (best = n)
    }
    return best
  }

  /** Nearest free node to (x, y, z) within maxR meters (spiral over cells), or -1. */
  nearestFree(x: number, y: number, z: number, maxR = 12): number {
    const n0 = this.nodeAt(x, y, z)
    if (n0 >= 0) return n0
    const ci = Math.floor((x - this.ox) / this.cs), cj = Math.floor((y - this.oy) / this.cs)
    const rings = Math.ceil(maxR / this.cs)
    let best = -1, bd = Infinity
    for (let r = 1; r <= rings; r++) {
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
          const i = ci + di, j = cj + dj
          if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue
          const c = j * this.w + i
          for (let l = 0; l < 2; l++) {
            const n = 2 * c + l
            if (this.st[n] !== 1) continue
            const dx = this.nodeX(n) - x, dy = this.nodeY(n) - y, dz = this.hz[n] - z
            const d = dx * dx + dy * dy + (dz > 0 ? dz * dz * 4 : dz * dz)
            if (d < bd) (bd = d), (best = n)
          }
        }
      if (best >= 0 && r * this.cs > Math.sqrt(bd)) break
    }
    return best
  }

  /** Is a straight walk from node a's surface to (x1, y1) flat-connected (no band, no ledges)? */
  lineWalkable(x0: number, y0: number, z0: number, x1: number, y1: number, maxLen = 60): boolean {
    const dx = x1 - x0, dy = y1 - y0
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len > maxLen) return false
    const n = Math.ceil(len / (this.cs * 0.5))
    let z = z0
    for (let s = 1; s <= n; s++) {
      const t = s / n
      const x = x0 + dx * t, y = y0 + dy * t
      const c = this.cellOf(x, y)
      if (c < 0) return false
      let ok = false
      let bz = z
      for (let l = 0; l < 2; l++) {
        const q = 2 * c + l
        if (this.st[q] !== 1) continue
        const dz = this.hz[q] - z
        const lim = this.terr[q] ? Math.max(this.stepUp, this.slopeTan * this.cs * 0.5) : this.stepUp
        if (dz <= lim && dz >= -this.stepUp * 1.5) {
          ok = true
          bz = this.hz[q]
          break
        }
      }
      if (!ok) return false
      z = bz
    }
    return true
  }
}

export type PathResult = {
  status: "ok" | "partial" | "fail"
  /** node ids from start to goal (or to the node closest to the goal when partial) */
  nodes: number[]
  /** edge kind into nodes[i] (EDGE_WALK/CLIMB/DROP); kinds[0] = EDGE_WALK */
  kinds: number[]
  cost: number
  expanded: number
}

export type SearchOpts = {
  maxMs?: number
  maxExpand?: number
  /** highest climb allowed on this search (energy-limited) */
  maxClimb?: number
  /** heuristic weight (>1 = greedier, faster) */
  weight?: number
  /** optional extra cost per node (e.g. threat exposure); must be >= 0 */
  extraCost?: (n: number) => number
}

/** Per-bot A* scratch space over a shared NavGrid. */
export class Pathfinder {
  nav: NavGrid
  private g: Float32Array
  private par: Int32Array
  private kind: Uint8Array
  private seen: Uint32Array
  private closed: Uint32Array
  private gen = 0
  private heapN: Int32Array
  private heapF: Float64Array
  private heapSize = 0
  /** optional per-cell temporary penalty (stuck spots), added to walk cost */
  cellPenalty: Map<number, number> = new Map()

  constructor(nav: NavGrid) {
    this.nav = nav
    this.g = new Float32Array(nav.N)
    this.par = new Int32Array(nav.N)
    this.kind = new Uint8Array(nav.N)
    this.seen = new Uint32Array(nav.N)
    this.closed = new Uint32Array(nav.N)
    this.heapN = new Int32Array(1 << 14)
    this.heapF = new Float64Array(1 << 14)
  }

  private push(n: number, f: number) {
    if (this.heapSize >= this.heapN.length) {
      const nn = new Int32Array(this.heapN.length * 2)
      nn.set(this.heapN)
      const nf = new Float64Array(this.heapF.length * 2)
      nf.set(this.heapF)
      this.heapN = nn
      this.heapF = nf
    }
    let i = this.heapSize++
    const HN = this.heapN, HF = this.heapF
    while (i > 0) {
      const p = (i - 1) >> 1
      if (HF[p] <= f) break
      HN[i] = HN[p]
      HF[i] = HF[p]
      i = p
    }
    HN[i] = n
    HF[i] = f
  }

  private pop(): number {
    const HN = this.heapN, HF = this.heapF
    const top = HN[0]
    const n = --this.heapSize
    if (n > 0) {
      const ln = HN[n], lf = HF[n]
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && HF[c + 1] < HF[c]) c++
        if (HF[c] >= lf) break
        HN[i] = HN[c]
        HF[i] = HF[c]
        i = c
      }
      HN[i] = ln
      HF[i] = lf
    }
    return top
  }

  /** A* between world points (feet heights). */
  findPath(sx: number, sy: number, sz: number, tx: number, ty: number, tz: number, opts: SearchOpts = {}): PathResult {
    const nav = this.nav
    const s = nav.nearestFree(sx, sy, sz, 10)
    const t = nav.nearestFree(tx, ty, tz, 16)
    if (s < 0 || t < 0) return { status: "fail", nodes: [], kinds: [], cost: 0, expanded: 0 }
    return this.search(s, t, opts)
  }

  search(s: number, t: number, opts: SearchOpts = {}): PathResult {
    const nav = this.nav
    const t0 = performance.now()
    const maxMs = opts.maxMs ?? 8
    const maxExpand = opts.maxExpand ?? 200000
    const maxClimb = Math.min(opts.maxClimb ?? nav.maxJet, nav.maxJet)
    const W = opts.weight ?? 1.25
    const extra = opts.extraCost
    this.gen = (this.gen + 1) >>> 0
    if (this.gen === 0) {
      this.seen.fill(0)
      this.closed.fill(0)
      this.gen = 1
    }
    const gen = this.gen
    const G = this.g, PAR = this.par, KIND = this.kind, SEEN = this.seen, CLOSED = this.closed
    const hz = nav.hz, st = nav.st, terr = nav.terr, pen = nav.pen, ceil = nav.ceil
    const w = nav.w, hgt = nav.h, cs = nav.cs
    const tc = t >> 1
    const ti = tc % w, tj = Math.floor(tc / w)
    const heur = (n: number) => {
      const c = n >> 1
      const di = Math.abs((c % w) - ti), dj = Math.abs(Math.floor(c / w) - tj)
      return cs * (di > dj ? di + 0.41421356 * dj : dj + 0.41421356 * di)
    }
    this.heapSize = 0
    G[s] = 0
    PAR[s] = -1
    KIND[s] = 0
    SEEN[s] = gen
    this.push(s, W * heur(s))
    let best = s, bestH = heur(s)
    let expanded = 0
    const SU = nav.stepUp, H = nav.height
    const pens = this.cellPenalty.size ? this.cellPenalty : null
    let found = false
    let timedOut = false
    while (this.heapSize > 0) {
      const u = this.pop()
      if (CLOSED[u] === gen) continue
      CLOSED[u] = gen
      if (u === t) {
        found = true
        break
      }
      expanded++
      if ((expanded & 255) === 0 && (performance.now() - t0 > maxMs || expanded > maxExpand)) {
        timedOut = true
        break
      }
      const hu = heur(u)
      if (hu < bestH) (bestH = hu), (best = u)
      const gu = G[u]
      const c = u >> 1
      const ci = c % w, cj = (c - ci) / w
      const zu = hz[u]
      const tu = terr[u]
      for (let d = 0; d < 8; d++) {
        const ii = ci + DX[d], jj = cj + DY[d]
        if (ii < 0 || jj < 0 || ii >= w || jj >= hgt) continue
        const cc = jj * w + ii
        const len = d >= 4 ? cs * Math.SQRT2 : cs
        for (let l = 0; l < 2; l++) {
          const v = 2 * cc + l
          if (st[v] !== 1 || CLOSED[v] === gen) continue
          const dh = hz[v] - zu
          const up = tu && terr[v] ? Math.max(SU, nav.slopeTan * len) : SU
          let cost: number, k: number
          if (dh > up) {
            if (dh > maxClimb || ceil[u] < dh + H) continue
            cost = len + dh * nav.climbCost + 2
            k = 1
          } else if (dh < -2.5) {
            cost = len + nav.dropCost
            k = 2
          } else {
            cost = len * (1 + pen[v])
            k = 0
          }
          if (pens) {
            const p = pens.get(cc)
            if (p) cost += p
          }
          if (extra) cost += extra(v)
          const ng = gu + cost
          if (SEEN[v] !== gen || ng < G[v]) {
            SEEN[v] = gen
            G[v] = ng
            PAR[v] = u
            KIND[v] = k
            this.push(v, ng + W * heur(v))
          }
        }
      }
      for (let q = nav.xStart[u], end = nav.xStart[u + 1]; q < end; q++) {
        const v = nav.xTo[q]
        if (CLOSED[v] === gen) continue
        if (nav.xKind[q] === 1 && nav.xDh[q] > maxClimb) continue
        let cost = nav.xCost[q]
        if (extra) cost += extra(v)
        const ng = gu + cost
        if (SEEN[v] !== gen || ng < G[v]) {
          SEEN[v] = gen
          G[v] = ng
          PAR[v] = u
          KIND[v] = nav.xKind[q]
          this.push(v, ng + W * heur(v))
        }
      }
    }
    const end = found ? t : best
    const nodes: number[] = []
    const kinds: number[] = []
    for (let n = end; n >= 0; n = PAR[n]) {
      nodes.push(n)
      kinds.push(KIND[n])
      if (n === s) break
      if (nodes.length > 100000) break
    }
    nodes.reverse()
    kinds.reverse()
    if (kinds.length) kinds[0] = 0
    return {
      status: found ? "ok" : nodes.length > 1 || timedOut ? "partial" : "fail",
      nodes,
      kinds,
      cost: G[end],
      expanded,
    }
  }
}
