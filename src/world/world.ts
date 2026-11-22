/**
 * Static world model: terrain heightfield, prisms (buildings, stadium, bridges) and trees, with
 * spatial indexes for point, surface and line-of-sight queries. Built once at hello from the map
 * files (hello.map.dir + hello.map.files) and immutable afterwards, so one instance can be shared
 * by every bot in a process (loadWorld caches by path). The only mutable fields are dedupe stamps
 * used inside a single query, which is safe because queries never interleave.
 *
 * Frames: x east, y north, z up, meters (protocol §5).
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const KIND_BUILDING = 0
export const KIND_STADIUM = 1
export const KIND_BRIDGE = 2

export type WorldOpts = {
  /** canopy model: line is blind once exp(-density * crownLength) < blockT (transmittance). */
  canopyDensity?: number
  canopyBlockT?: number
}

type RawWorld = {
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  rules?: { canopyDensity?: number; canopyBlockT?: number; maxStep?: number; maxSlopeDeg?: number }
  terrain: { minX: number; minY: number; step: number; nx: number; ny: number; scale?: number }
  prisms: { kind: string; base: number; top: number; ring: number[]; holes?: number[][] }[]
  trees?: { fields: string[]; data: number[] }
}

const GRID = 16 // m, prism/tree spatial grid cell
const CGRID = 8 // m, coarse terrain max grid cell

export class World {
  // map bounds (the map edge is a wall)
  minX: number
  maxX: number
  minY: number
  maxY: number
  // terrain heightfield (vertex grid, meters)
  tMinX: number
  tMinY: number
  tStep: number
  tnx: number
  tny: number
  th: Float32Array
  // coarse max terrain height per CGRID cell (for fast LOS rejects)
  private cnx: number
  private cny: number
  private cmax: Float32Array
  // prisms
  nPrisms: number
  pKind: Uint8Array
  pBase: Float64Array
  pTop: Float64Array
  pMinX: Float64Array
  pMinY: Float64Array
  pMaxX: Float64Array
  pMaxY: Float64Array
  /** edges of prism k (ring and holes) are ex0[e]..ey1[e] for e in [pE0[k], pE1[k]) */
  pE0: Int32Array
  pE1: Int32Array
  ex0: Float64Array
  ey0: Float64Array
  ex1: Float64Array
  ey1: Float64Array
  // trees
  nTrees: number
  trX: Float64Array // trunk position
  trY: Float64Array
  trZ: Float64Array // ground at trunk
  trTop: Float64Array // absolute top height
  trCB: Float64Array // absolute crown base height
  trTR: Float64Array // trunk radius
  trCX: Float64Array // crown center
  trCY: Float64Array
  trCR: Float64Array // crown radius
  // spatial grid shared by prisms and trees
  gOx: number
  gOy: number
  gnx: number
  gny: number
  private gpStart: Int32Array
  private gpItems: Int32Array
  private gtStart: Int32Array
  private gtItems: Int32Array
  private pStamp: Uint32Array
  private tStamp: Uint32Array
  private gen = 1
  /** crown length (m) along a sight line beyond which canopy blinds it */
  canopyLimit: number
  canopyDensity: number
  canopyBlockT: number
  loadMs = 0

  constructor(raw: RawWorld, terrain: Float32Array, opts: WorldOpts = {}) {
    const t0 = performance.now()
    const b = raw.bounds
    this.minX = b.minX
    this.maxX = b.maxX
    this.minY = b.minY
    this.maxY = b.maxY
    const tr = raw.terrain
    this.tMinX = tr.minX
    this.tMinY = tr.minY
    this.tStep = tr.step
    this.tnx = tr.nx
    this.tny = tr.ny
    this.th = terrain

    // coarse max grid: cell (ci,cj) covers vertices [ci*k, ci*k+k] inclusive
    const k = Math.max(1, Math.round(CGRID / tr.step))
    this.cnx = Math.ceil((tr.nx - 1) / k)
    this.cny = Math.ceil((tr.ny - 1) / k)
    this.cmax = new Float32Array(this.cnx * this.cny).fill(-1e9)
    for (let cj = 0; cj < this.cny; cj++)
      for (let ci = 0; ci < this.cnx; ci++) {
        let m = -1e9
        const j1 = Math.min(tr.ny - 1, cj * k + k), i1 = Math.min(tr.nx - 1, ci * k + k)
        for (let j = cj * k; j <= j1; j++) for (let i = ci * k; i <= i1; i++) m = Math.max(m, terrain[j * tr.nx + i])
        this.cmax[cj * this.cnx + ci] = m
      }

    // prisms
    const P = raw.prisms
    const n = P.length
    this.nPrisms = n
    this.pKind = new Uint8Array(n)
    this.pBase = new Float64Array(n)
    this.pTop = new Float64Array(n)
    this.pMinX = new Float64Array(n)
    this.pMinY = new Float64Array(n)
    this.pMaxX = new Float64Array(n)
    this.pMaxY = new Float64Array(n)
    this.pE0 = new Int32Array(n)
    this.pE1 = new Int32Array(n)
    let ne = 0
    for (const p of P) {
      ne += p.ring.length / 2
      for (const h of p.holes ?? []) ne += h.length / 2
    }
    this.ex0 = new Float64Array(ne)
    this.ey0 = new Float64Array(ne)
    this.ex1 = new Float64Array(ne)
    this.ey1 = new Float64Array(ne)
    let e = 0
    for (let i = 0; i < n; i++) {
      const p = P[i]
      this.pKind[i] = p.kind === "bridge" ? KIND_BRIDGE : p.kind === "stadium" ? KIND_STADIUM : KIND_BUILDING
      this.pBase[i] = p.base
      this.pTop[i] = p.top
      this.pE0[i] = e
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const loop of [p.ring, ...(p.holes ?? [])]) {
        const m = loop.length / 2
        for (let v = 0; v < m; v++) {
          const ax = loop[2 * v], ay = loop[2 * v + 1]
          const w = (v + 1) % m
          this.ex0[e] = ax
          this.ey0[e] = ay
          this.ex1[e] = loop[2 * w]
          this.ey1[e] = loop[2 * w + 1]
          e++
          if (ax < x0) x0 = ax
          if (ax > x1) x1 = ax
          if (ay < y0) y0 = ay
          if (ay > y1) y1 = ay
        }
      }
      this.pE1[i] = e
      this.pMinX[i] = x0
      this.pMinY[i] = y0
      this.pMaxX[i] = x1
      this.pMaxY[i] = y1
    }

    // trees
    const T = raw.trees
    const f = T?.fields ?? []
    const nf = f.length
    const nt = T && nf ? Math.floor(T.data.length / nf) : 0
    this.nTrees = nt
    const col = (name: string) => f.indexOf(name)
    const ix = col("x"), iy = col("y"), iz = col("z"), ih = col("height"), icr = col("crownR"), icb = col("crownBase"), itr = col("trunkR")
    const icx = col("crownX"), icy = col("crownY")
    this.trX = new Float64Array(nt)
    this.trY = new Float64Array(nt)
    this.trZ = new Float64Array(nt)
    this.trTop = new Float64Array(nt)
    this.trCB = new Float64Array(nt)
    this.trTR = new Float64Array(nt)
    this.trCX = new Float64Array(nt)
    this.trCY = new Float64Array(nt)
    this.trCR = new Float64Array(nt)
    for (let i = 0; i < nt; i++) {
      const d = T!.data, o = i * nf
      const x = d[o + ix], y = d[o + iy], z = iz >= 0 ? d[o + iz] : 0
      this.trX[i] = x
      this.trY[i] = y
      this.trZ[i] = z
      this.trTop[i] = z + (ih >= 0 ? d[o + ih] : 10)
      this.trCB[i] = z + (icb >= 0 ? d[o + icb] : 3)
      this.trTR[i] = itr >= 0 ? d[o + itr] : 0.3
      this.trCX[i] = icx >= 0 ? d[o + icx] : x
      this.trCY[i] = icy >= 0 ? d[o + icy] : y
      this.trCR[i] = icr >= 0 ? d[o + icr] : 3
    }

    // spatial grid over the union of bounds and terrain
    this.gOx = Math.min(this.minX, this.tMinX) - 1
    this.gOy = Math.min(this.minY, this.tMinY) - 1
    const gx1 = Math.max(this.maxX, this.tMinX + (tr.nx - 1) * tr.step) + 1
    const gy1 = Math.max(this.maxY, this.tMinY + (tr.ny - 1) * tr.step) + 1
    this.gnx = Math.ceil((gx1 - this.gOx) / GRID)
    this.gny = Math.ceil((gy1 - this.gOy) / GRID)
    const rangeOf = (x0: number, y0: number, x1: number, y1: number) => {
      const i0 = Math.max(0, Math.floor((x0 - this.gOx) / GRID)), i1 = Math.min(this.gnx - 1, Math.floor((x1 - this.gOx) / GRID))
      const j0 = Math.max(0, Math.floor((y0 - this.gOy) / GRID)), j1 = Math.min(this.gny - 1, Math.floor((y1 - this.gOy) / GRID))
      return [i0, i1, j0, j1]
    }
    const buildGrid = (count: number, box: (i: number) => number[]): [Int32Array, Int32Array] => {
      const cells = this.gnx * this.gny
      const cnt = new Int32Array(cells + 1)
      for (let i = 0; i < count; i++) {
        const [i0, i1, j0, j1] = box(i)
        for (let j = j0; j <= j1; j++) for (let q = i0; q <= i1; q++) cnt[j * this.gnx + q + 1]++
      }
      for (let c = 0; c < cells; c++) cnt[c + 1] += cnt[c]
      const items = new Int32Array(cnt[cells])
      const fill = cnt.slice(0, cells)
      for (let i = 0; i < count; i++) {
        const [i0, i1, j0, j1] = box(i)
        for (let j = j0; j <= j1; j++) for (let q = i0; q <= i1; q++) items[fill[j * this.gnx + q]++] = i
      }
      return [cnt, items]
    }
    ;[this.gpStart, this.gpItems] = buildGrid(n, (i) => rangeOf(this.pMinX[i], this.pMinY[i], this.pMaxX[i], this.pMaxY[i]))
    ;[this.gtStart, this.gtItems] = buildGrid(nt, (i) => {
      const r = Math.max(this.trCR[i], this.trTR[i])
      const x0 = Math.min(this.trX[i] - this.trTR[i], this.trCX[i] - r), x1 = Math.max(this.trX[i] + this.trTR[i], this.trCX[i] + r)
      const y0 = Math.min(this.trY[i] - this.trTR[i], this.trCY[i] - r), y1 = Math.max(this.trY[i] + this.trTR[i], this.trCY[i] + r)
      return rangeOf(x0, y0, x1, y1)
    })
    this.pStamp = new Uint32Array(n)
    this.tStamp = new Uint32Array(nt)

    this.canopyDensity = opts.canopyDensity ?? raw.rules?.canopyDensity ?? 0.35
    this.canopyBlockT = opts.canopyBlockT ?? raw.rules?.canopyBlockT ?? 0.25
    this.canopyLimit = Math.log(1 / Math.max(1e-6, this.canopyBlockT)) / Math.max(1e-6, this.canopyDensity)
    this.loadMs = performance.now() - t0
  }

  /** Read world.json and the terrain grid from hello.map.dir + hello.map.files. */
  static load(dir: string, files: string[], opts: WorldOpts = {}): World {
    const t0 = performance.now()
    const wf = files.find((f) => f.endsWith(".json")) ?? "v2/world.json"
    const raw = JSON.parse(readFileSync(join(dir, wf), "utf8")) as RawWorld
    const tf = files.find((f) => f.endsWith(".i16")) ?? join(dirname(wf), (raw.terrain as { file?: string }).file ?? "terrain.i16")
    const buf = readFileSync(join(dir, tf))
    const nv = raw.terrain.nx * raw.terrain.ny
    const scale = raw.terrain.scale ?? 0.01
    const h = new Float32Array(nv)
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const m = Math.min(nv, buf.byteLength >> 1)
    for (let i = 0; i < m; i++) h[i] = dv.getInt16(2 * i, true) * scale
    const w = new World(raw, h, opts)
    w.loadMs = performance.now() - t0
    return w
  }

  // ------------------------------------------------------------------ terrain

  /** Bilinear terrain height at (x, y); clamped at the grid edge. */
  groundZ(x: number, y: number): number {
    let fx = (x - this.tMinX) / this.tStep
    let fy = (y - this.tMinY) / this.tStep
    const mx = this.tnx - 1.000001, my = this.tny - 1.000001
    if (fx < 0) fx = 0
    else if (fx > mx) fx = mx
    if (fy < 0) fy = 0
    else if (fy > my) fy = my
    const i = fx | 0, j = fy | 0
    const ax = fx - i, ay = fy - j
    const k = j * this.tnx + i
    const h = this.th
    const a = h[k] + (h[k + 1] - h[k]) * ax
    const c = h[k + this.tnx] + (h[k + this.tnx + 1] - h[k + this.tnx]) * ax
    return a + (c - a) * ay
  }

  /** Max terrain height of the coarse cell containing (x, y): a fast upper bound for groundZ. */
  private coarseMax(x: number, y: number): number {
    let ci = Math.floor((x - this.tMinX) / (CGRID))
    let cj = Math.floor((y - this.tMinY) / (CGRID))
    if (ci < 0) ci = 0
    else if (ci >= this.cnx) ci = this.cnx - 1
    if (cj < 0) cj = 0
    else if (cj >= this.cny) cj = this.cny - 1
    return this.cmax[cj * this.cnx + ci]
  }

  /** Is the segment above the terrain everywhere (within tol)? Samples about every meter. */
  terrainClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, tol = 0.05): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const len = Math.sqrt(dx * dx + dy * dy)
    const n = Math.max(1, Math.ceil(len / 1.0))
    for (let s = 0; s <= n; s++) {
      const t = s / n
      const x = ax + dx * t, y = ay + dy * t, z = az + dz * t
      if (z >= this.coarseMax(x, y)) continue
      if (z < this.groundZ(x, y) - tol) return false
    }
    return true
  }

  // ------------------------------------------------------------------ prisms

  /** Is (x, y) inside prism k's footprint (ring minus holes)? Even-odd rule over all loops. */
  inside2D(k: number, x: number, y: number): boolean {
    if (x < this.pMinX[k] || x > this.pMaxX[k] || y < this.pMinY[k] || y > this.pMaxY[k]) return false
    let c = false
    const X0 = this.ex0, Y0 = this.ey0, X1 = this.ex1, Y1 = this.ey1
    for (let e = this.pE0[k], end = this.pE1[k]; e < end; e++) {
      const y0 = Y0[e], y1 = Y1[e]
      if (y0 > y !== y1 > y) {
        const xc = X0[e] + ((y - y0) / (y1 - y0)) * (X1[e] - X0[e])
        if (x < xc) c = !c
      }
    }
    return c
  }

  private cellOf(x: number, y: number): number {
    const i = Math.floor((x - this.gOx) / GRID), j = Math.floor((y - this.gOy) / GRID)
    if (i < 0 || j < 0 || i >= this.gnx || j >= this.gny) return -1
    return j * this.gnx + i
  }

  /** Prisms whose bbox overlaps the grid cell of (x, y). */
  prismsNear(x: number, y: number): Int32Array {
    const c = this.cellOf(x, y)
    if (c < 0) return new Int32Array(0)
    return this.gpItems.subarray(this.gpStart[c], this.gpStart[c + 1])
  }

  /** Index of a prism containing the 3D point, or -1. */
  prismAt(x: number, y: number, z: number): number {
    const c = this.cellOf(x, y)
    if (c < 0) return -1
    for (let q = this.gpStart[c], end = this.gpStart[c + 1]; q < end; q++) {
      const k = this.gpItems[q]
      if (z >= this.pBase[k] && z <= this.pTop[k] && this.inside2D(k, x, y)) return k
    }
    return -1
  }

  /**
   * Highest walkable surface under (x, y) that is not above zRef + stepUp: terrain or a prism top.
   * This is where a mech whose feet are near zRef stands.
   */
  surfaceZ(x: number, y: number, zRef = Infinity, stepUp = 1.2): number {
    let best = this.groundZ(x, y)
    const c = this.cellOf(x, y)
    if (c < 0) return best
    const lim = zRef + stepUp
    for (let q = this.gpStart[c], end = this.gpStart[c + 1]; q < end; q++) {
      const k = this.gpItems[q]
      const top = this.pTop[k]
      if (top > best && top <= lim && this.inside2D(k, x, y)) best = top
    }
    return best
  }

  /** Highest prism top over (x, y) (or the terrain if no prism covers it). */
  roofZ(x: number, y: number): number {
    return this.surfaceZ(x, y, Infinity)
  }

  /** Does segment a-b pass through prism k (exact: z-slab clip, then 2D polygon test)? */
  segHitsPrism(k: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const base = this.pBase[k], top = this.pTop[k]
    const dz = bz - az
    let t0 = 0, t1 = 1
    if (dz > -1e-9 && dz < 1e-9) {
      if (az < base || az > top) return false
    } else {
      let ta = (base - az) / dz, tb = (top - az) / dz
      if (ta > tb) {
        const s = ta
        ta = tb
        tb = s
      }
      if (ta > t0) t0 = ta
      if (tb < t1) t1 = tb
      if (t0 > t1) return false
    }
    const dx = bx - ax, dy = by - ay
    const x0 = ax + dx * t0, y0 = ay + dy * t0, x1 = ax + dx * t1, y1 = ay + dy * t1
    if ((x0 > x1 ? x0 : x1) < this.pMinX[k] || (x0 < x1 ? x0 : x1) > this.pMaxX[k]) return false
    if ((y0 > y1 ? y0 : y1) < this.pMinY[k] || (y0 < y1 ? y0 : y1) > this.pMaxY[k]) return false
    if (this.inside2D(k, x0, y0)) return true
    const sx = x1 - x0, sy = y1 - y0
    const X0 = this.ex0, Y0 = this.ey0, X1 = this.ex1, Y1 = this.ey1
    for (let e = this.pE0[k], end = this.pE1[k]; e < end; e++) {
      const qx = X0[e], qy = Y0[e]
      const ux = X1[e] - qx, uy = Y1[e] - qy
      const den = sx * uy - sy * ux
      if (den === 0) continue
      const wx = qx - x0, wy = qy - y0
      const s = (wx * uy - wy * ux) / den
      if (s < 0 || s > 1) continue
      const u = (wx * sy - wy * sx) / den
      if (u >= 0 && u <= 1) return true
    }
    return false
  }

  private nextGen(): number {
    this.gen = (this.gen + 1) >>> 0
    if (this.gen === 0) {
      this.pStamp.fill(0)
      this.tStamp.fill(0)
      this.gen = 1
    }
    return this.gen
  }

  /** Test the prisms of grid cell c (not yet stamped with gen) against segment a-b; hit index or -1. */
  private prismsInCell(c: number, gen: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    const items = this.gpItems, stamp = this.pStamp
    for (let q = this.gpStart[c], end = this.gpStart[c + 1]; q < end; q++) {
      const k = items[q]
      if (stamp[k] === gen) continue
      stamp[k] = gen
      if (this.segHitsPrism(k, ax, ay, az, bx, by, bz)) return k
    }
    return -1
  }

  /**
   * Index of the first prism (in traversal order) hit by segment a-b, or -1. Walks the spatial
   * grid cells along the segment (Amanatides-Woo); allocation-free.
   */
  segPrism(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    const gen = this.nextGen()
    const gx = (ax - this.gOx) / GRID, gy = (ay - this.gOy) / GRID
    const hx = (bx - this.gOx) / GRID, hy = (by - this.gOy) / GRID
    let i = Math.floor(gx), j = Math.floor(gy)
    const ie = Math.floor(hx), je = Math.floor(hy)
    const dx = hx - gx, dy = hy - gy
    const si = dx > 0 ? 1 : -1, sj = dy > 0 ? 1 : -1
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity
    let tmx = dx !== 0 ? (dx > 0 ? i + 1 - gx : gx - i) * tdx : Infinity
    let tmy = dy !== 0 ? (dy > 0 ? j + 1 - gy : gy - j) * tdy : Infinity
    const maxIt = Math.abs(ie - i) + Math.abs(je - j) + 2
    const gnx = this.gnx, gny = this.gny
    for (let it = 0; it <= maxIt; it++) {
      if (i >= 0 && j >= 0 && i < gnx && j < gny) {
        const k = this.prismsInCell(j * gnx + i, gen, ax, ay, az, bx, by, bz)
        if (k >= 0) return k
      }
      if (i === ie && j === je) break
      if (tmx < tmy) {
        tmx += tdx
        i += si
      } else {
        tmy += tdy
        j += sj
      }
    }
    return -1
  }

  /** Can a shot fly from a to b? Prisms and terrain block; trees never do. */
  shotClear(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
    const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2]
    if (this.segPrism(ax, ay, az, bx, by, bz) >= 0) return false
    return this.terrainClear(ax, ay, az, bx, by, bz)
  }

  /** crown length accumulated by treesInCell for the current canopyAlong call */
  private canopyAcc = 0

  /**
   * Trees of grid cell c (not yet stamped with gen) against segment a-b: adds crown chord lengths
   * to canopyAcc. Returns 1 when a trunk blocks, 2 when canopyAcc passed `limit`, else 0.
   */
  private treesInCell(
    c: number, gen: number, ax: number, ay: number, az: number, dx: number, dy: number, dz: number,
    len: number, l2: number, limit: number, trunks: boolean,
  ): number {
    const items = this.gtItems, stamp = this.tStamp
    for (let q = this.gtStart[c], end = this.gtStart[c + 1]; q < end; q++) {
      const k = items[q]
      if (stamp[k] === gen) continue
      stamp[k] = gen
      // trunk: vertical cylinder from ground to crown base
      if (trunks && l2 > 1e-9) {
        const tx = this.trX[k] - ax, ty = this.trY[k] - ay
        let t = (tx * dx + ty * dy) / l2
        if (t < 0) t = 0
        else if (t > 1) t = 1
        const ox = ax + dx * t - this.trX[k], oy = ay + dy * t - this.trY[k]
        const r = this.trTR[k]
        if (ox * ox + oy * oy < r * r) {
          const z = az + dz * t
          if (z >= this.trZ[k] && z <= this.trCB[k]) return 1
        }
      }
      // crown ellipsoid
      const R = this.trCR[k]
      const hh = (this.trTop[k] - this.trCB[k]) * 0.5
      if (R <= 0 || hh <= 0) continue
      const cz = this.trCB[k] + hh
      const px = (ax - this.trCX[k]) / R, py = (ay - this.trCY[k]) / R, pz = (az - cz) / hh
      const vx = dx / R, vy = dy / R, vz = dz / hh
      const A = vx * vx + vy * vy + vz * vz
      const B = 2 * (px * vx + py * vy + pz * vz)
      const C = px * px + py * py + pz * pz - 1
      const disc = B * B - 4 * A * C
      if (disc <= 0 || A < 1e-12) continue
      const sq = Math.sqrt(disc)
      let t1 = (-B - sq) / (2 * A), t2 = (-B + sq) / (2 * A)
      if (t1 < 0) t1 = 0
      if (t2 > 1) t2 = 1
      if (t2 <= t1) continue
      this.canopyAcc += (t2 - t1) * len
      if (this.canopyAcc > limit) return 2
    }
    return 0
  }

  /**
   * Crown length along segment a-b (sum over trees, crowns as ellipsoids filling
   * [crownBase, top] with radius crownR) and whether a trunk blocks it. Stops early once the
   * length exceeds `limit`. Returns -1 when a trunk blocks. Allocation-free.
   */
  canopyAlong(ax: number, ay: number, az: number, bx: number, by: number, bz: number, limit = Infinity, trunks = true): number {
    if (this.nTrees === 0) return 0
    const gen = this.nextGen()
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const l2 = dx * dx + dy * dy
    this.canopyAcc = 0
    const gx = (ax - this.gOx) / GRID, gy = (ay - this.gOy) / GRID
    const hx = (bx - this.gOx) / GRID, hy = (by - this.gOy) / GRID
    let i = Math.floor(gx), j = Math.floor(gy)
    const ie = Math.floor(hx), je = Math.floor(hy)
    const ddx = hx - gx, ddy = hy - gy
    const si = ddx > 0 ? 1 : -1, sj = ddy > 0 ? 1 : -1
    const tdx = ddx !== 0 ? Math.abs(1 / ddx) : Infinity, tdy = ddy !== 0 ? Math.abs(1 / ddy) : Infinity
    let tmx = ddx !== 0 ? (ddx > 0 ? i + 1 - gx : gx - i) * tdx : Infinity
    let tmy = ddy !== 0 ? (ddy > 0 ? j + 1 - gy : gy - j) * tdy : Infinity
    const maxIt = Math.abs(ie - i) + Math.abs(je - j) + 2
    const gnx = this.gnx, gny = this.gny
    for (let it = 0; it <= maxIt; it++) {
      if (i >= 0 && j >= 0 && i < gnx && j < gny) {
        const r = this.treesInCell(j * gnx + i, gen, ax, ay, az, dx, dy, dz, len, l2, limit, trunks)
        if (r === 1) return -1
        if (r === 2) return this.canopyAcc
      }
      if (i === ie && j === je) break
      if (tmx < tmy) {
        tmx += tdx
        i += si
      } else {
        tmy += tdy
        j += sj
      }
    }
    return this.canopyAcc
  }

  /**
   * Line of sight for vision (protocol §8): prisms and terrain block, tree trunks block, and
   * canopy blinds once the crown length passes canopyLimit. With canopy=false (proximity
   * sensors inside near_range) crowns are ignored.
   */
  sightClear(a: ArrayLike<number>, b: ArrayLike<number>, canopy = true): boolean {
    if (!this.shotClear(a, b)) return false
    const c = this.canopyAlong(a[0], a[1], a[2], b[0], b[1], b[2], canopy ? this.canopyLimit : Infinity, true)
    if (c < 0) return false
    return !canopy || c <= this.canopyLimit
  }
}

const cache = new Map<string, World>()

/** Load (or reuse) the immutable world for a map directory. */
export function loadWorld(dir: string, files: string[], opts: WorldOpts = {}): World {
  const key = dir + "|" + files.join(",") + "|" + JSON.stringify(opts)
  let w = cache.get(key)
  if (!w) {
    w = World.load(dir, files, opts)
    cache.set(key, w)
  }
  return w
}
