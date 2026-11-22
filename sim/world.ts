/**
 * Simulator world geometry: terrain, prisms, trees. Written independently from src/world on purpose
 * (bot and sim are cross-checked, so a shared bug can't hide).
 *
 * Frame: x east, y north, z up, meters. Prism = polygon ring (minus holes) extruded from base to top.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface Prism {
  id: number
  kind: string
  base: number
  top: number
  /** polygons: ring first, then holes; flat [x0,y0,x1,y1,...] */
  polys: Float64Array[]
  minX: number
  maxX: number
  minY: number
  maxY: number
  area: number
}

const CELL = 8 // grid cell for the spatial index (m)

export class World {
  /** 0 = Beer-Lambert over foliage meters; 1/2 = per-crown opacity (linear / sqrt chord fraction) */
  static canopyModel = 0
  static trunkToCrownBase = false
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  rules: { canopyDensity: number; canopyBlockT: number }
  // terrain
  tnx: number
  tny: number
  tminX: number
  tminY: number
  tstep: number
  th: Float32Array
  // coarse terrain max (4 m cells, dilated by one cell) for fast raycasts
  cmN = 4
  cmnx: number
  cmny: number
  cmax: Float32Array
  prisms: Prism[] = []
  // trees (struct of arrays)
  nTrees = 0
  trX!: Float64Array
  trY!: Float64Array
  trZ!: Float64Array
  trH!: Float64Array // absolute top z
  trCB!: Float64Array // absolute crown base z
  trCR!: Float64Array
  trTR!: Float64Array
  trCX!: Float64Array
  trCY!: Float64Array
  trTrunkTop!: Float64Array
  // spatial grid
  gminX: number
  gminY: number
  gnx: number
  gny: number
  cellPrisms: Int32Array[] = []
  cellTrees: Int32Array[] = []
  private stampP: Int32Array
  private stampT: Int32Array
  private stamp = 1

  constructor(mapDir: string) {
    const w = JSON.parse(readFileSync(join(mapDir, "v2/world.json"), "utf8"))
    this.bounds = w.bounds
    this.rules = { canopyDensity: w.rules?.canopyDensity ?? 0.35, canopyBlockT: w.rules?.canopyBlockT ?? 0.25 }
    const t = w.terrain
    this.tnx = t.nx
    this.tny = t.ny
    this.tminX = t.minX
    this.tminY = t.minY
    this.tstep = t.step
    const buf = readFileSync(join(mapDir, "v2", t.file ?? "terrain.i16"))
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1)
    const scale = t.scale ?? 0.01
    this.th = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) this.th[i] = i16[i] * scale
    // coarse max grid
    this.cmnx = Math.ceil(this.tnx / this.cmN) + 1
    this.cmny = Math.ceil(this.tny / this.cmN) + 1
    const raw = new Float32Array(this.cmnx * this.cmny).fill(-1e9)
    for (let j = 0; j < this.tny; j++)
      for (let i = 0; i < this.tnx; i++) {
        const c = Math.floor(j / this.cmN) * this.cmnx + Math.floor(i / this.cmN)
        const h = this.th[j * this.tnx + i]
        if (h > raw[c]) raw[c] = h
      }
    this.cmax = new Float32Array(raw.length).fill(-1e9)
    for (let cj = 0; cj < this.cmny; cj++)
      for (let ci = 0; ci < this.cmnx; ci++) {
        let m = -1e9
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const a = ci + di,
              b = cj + dj
            if (a < 0 || b < 0 || a >= this.cmnx || b >= this.cmny) continue
            const v = raw[b * this.cmnx + a]
            if (v > m) m = v
          }
        this.cmax[cj * this.cmnx + ci] = m
      }
    // prisms
    let pid = 0
    for (const p of w.prisms) {
      const polys = [new Float64Array(p.ring), ...(p.holes ?? []).map((h: number[]) => new Float64Array(h))]
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity
      const r = polys[0]
      for (let i = 0; i < r.length; i += 2) {
        if (r[i] < minX) minX = r[i]
        if (r[i] > maxX) maxX = r[i]
        if (r[i + 1] < minY) minY = r[i + 1]
        if (r[i + 1] > maxY) maxY = r[i + 1]
      }
      let area = Math.abs(polyArea(polys[0]))
      for (let k = 1; k < polys.length; k++) area -= Math.abs(polyArea(polys[k]))
      this.prisms.push({ id: pid++, kind: p.kind, base: p.base, top: p.top, polys, minX, maxX, minY, maxY, area })
    }
    // trees
    const F: string[] = w.trees.fields
    const D: number[] = w.trees.data
    const nf = F.length
    const ix = (k: string) => F.indexOf(k)
    const iX = ix("x"),
      iY = ix("y"),
      iZ = ix("z"),
      iH = ix("height"),
      iCR = ix("crownR"),
      iCB = ix("crownBase"),
      iTR = ix("trunkR"),
      iCX = ix("crownX"),
      iCY = ix("crownY")
    const n = Math.floor(D.length / nf)
    this.nTrees = n
    this.trX = new Float64Array(n)
    this.trY = new Float64Array(n)
    this.trZ = new Float64Array(n)
    this.trH = new Float64Array(n)
    this.trCB = new Float64Array(n)
    this.trCR = new Float64Array(n)
    this.trTR = new Float64Array(n)
    this.trCX = new Float64Array(n)
    this.trCY = new Float64Array(n)
    this.trTrunkTop = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      const o = k * nf
      this.trX[k] = D[o + iX]
      this.trY[k] = D[o + iY]
      this.trZ[k] = D[o + iZ]
      this.trH[k] = D[o + iZ] + D[o + iH]
      this.trCB[k] = D[o + iZ] + D[o + iCB]
      this.trCR[k] = D[o + iCR]
      this.trTR[k] = D[o + iTR]
      this.trCX[k] = iCX >= 0 ? D[o + iCX] : D[o + iX]
      this.trCY[k] = iCY >= 0 ? D[o + iCY] : D[o + iY]
      // trunk runs from the ground into the middle of the crown
      this.trTrunkTop[k] = World.trunkToCrownBase ? this.trCB[k] : (this.trCB[k] + this.trH[k]) / 2
    }
    // grid
    this.gminX = Math.floor(this.bounds.minX) - CELL
    this.gminY = Math.floor(this.bounds.minY) - CELL
    this.gnx = Math.ceil((this.bounds.maxX - this.gminX) / CELL) + 2
    this.gny = Math.ceil((this.bounds.maxY - this.gminY) / CELL) + 2
    const cp: number[][] = Array.from({ length: this.gnx * this.gny }, () => [])
    const ct: number[][] = Array.from({ length: this.gnx * this.gny }, () => [])
    for (const p of this.prisms) {
      const i0 = this.cx(p.minX),
        i1 = this.cx(p.maxX),
        j0 = this.cy(p.minY),
        j1 = this.cy(p.maxY)
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cp[j * this.gnx + i].push(p.id)
    }
    for (let k = 0; k < n; k++) {
      const r = Math.max(this.trCR[k], this.trTR[k])
      const x0 = Math.min(this.trX[k] - this.trTR[k], this.trCX[k] - r),
        x1 = Math.max(this.trX[k] + this.trTR[k], this.trCX[k] + r)
      const y0 = Math.min(this.trY[k] - this.trTR[k], this.trCY[k] - r),
        y1 = Math.max(this.trY[k] + this.trTR[k], this.trCY[k] + r)
      for (let j = this.cy(y0); j <= this.cy(y1); j++) for (let i = this.cx(x0); i <= this.cx(x1); i++) ct[j * this.gnx + i].push(k)
    }
    this.cellPrisms = cp.map((a) => Int32Array.from(a))
    this.cellTrees = ct.map((a) => Int32Array.from(a))
    this.stampP = new Int32Array(this.prisms.length)
    this.stampT = new Int32Array(n)
  }

  cx(x: number) {
    const i = Math.floor((x - this.gminX) / CELL)
    return i < 0 ? 0 : i >= this.gnx ? this.gnx - 1 : i
  }
  cy(y: number) {
    const j = Math.floor((y - this.gminY) / CELL)
    return j < 0 ? 0 : j >= this.gny ? this.gny - 1 : j
  }

  /** bilinear terrain height */
  ground(x: number, y: number): number {
    let fx = (x - this.tminX) / this.tstep
    let fy = (y - this.tminY) / this.tstep
    if (fx < 0) fx = 0
    if (fy < 0) fy = 0
    if (fx > this.tnx - 1.001) fx = this.tnx - 1.001
    if (fy > this.tny - 1.001) fy = this.tny - 1.001
    const i = Math.floor(fx),
      j = Math.floor(fy)
    const ax = fx - i,
      ay = fy - j
    const o = j * this.tnx + i
    const h00 = this.th[o],
      h10 = this.th[o + 1],
      h01 = this.th[o + this.tnx],
      h11 = this.th[o + this.tnx + 1]
    return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay
  }

  /** terrain gradient magnitude (rise per meter) */
  slope(x: number, y: number): number {
    const e = 0.5
    const gx = (this.ground(x + e, y) - this.ground(x - e, y)) / (2 * e)
    const gy = (this.ground(x, y + e) - this.ground(x, y - e)) / (2 * e)
    return Math.hypot(gx, gy)
  }

  private coarseMax(x: number, y: number): number {
    let i = Math.floor((x - this.tminX) / (this.tstep * this.cmN))
    let j = Math.floor((y - this.tminY) / (this.tstep * this.cmN))
    if (i < 0) i = 0
    if (j < 0) j = 0
    if (i >= this.cmnx) i = this.cmnx - 1
    if (j >= this.cmny) j = this.cmny - 1
    return this.cmax[j * this.cmnx + i]
  }

  /** is (x,y) inside the prism's footprint (ring minus holes) */
  inPrism(p: Prism, x: number, y: number): boolean {
    if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) return false
    if (!pip(p.polys[0], x, y)) return false
    for (let k = 1; k < p.polys.length; k++) if (pip(p.polys[k], x, y)) return false
    return true
  }

  /** prisms whose AABB overlaps the box */
  forPrismsNear(x0: number, y0: number, x1: number, y1: number, f: (p: Prism) => void) {
    const s = ++this.stamp
    const i0 = this.cx(x0),
      i1 = this.cx(x1),
      j0 = this.cy(y0),
      j1 = this.cy(y1)
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const lst = this.cellPrisms[j * this.gnx + i]
        for (let k = 0; k < lst.length; k++) {
          const id = lst[k]
          if (this.stampP[id] === s) continue
          this.stampP[id] = s
          const p = this.prisms[id]
          if (p.maxX < x0 || p.minX > x1 || p.maxY < y0 || p.minY > y1) continue
          f(p)
        }
      }
  }

  /** highest surface (terrain or prism top) under (x,y) with height <= zMax */
  support(x: number, y: number, zMax: number): number {
    let s = this.ground(x, y)
    const lst = this.cellPrisms[this.cy(y) * this.gnx + this.cx(x)]
    for (let k = 0; k < lst.length; k++) {
      const p = this.prisms[lst[k]]
      if (p.top <= zMax && p.top > s && this.inPrism(p, x, y)) s = p.top
    }
    return s
  }

  /** highest surface of any kind at (x,y) (roofs included, ignoring reachability) */
  topSurface(x: number, y: number): number {
    return this.support(x, y, 1e9)
  }

  /** is there a solid (prism) containing the 3D point */
  solidAt(x: number, y: number, z: number): boolean {
    if (z < this.ground(x, y)) return true
    const lst = this.cellPrisms[this.cy(y) * this.gnx + this.cx(x)]
    for (let k = 0; k < lst.length; k++) {
      const p = this.prisms[lst[k]]
      if (z >= p.base && z <= p.top && this.inPrism(p, x, y)) return true
    }
    return false
  }

  /**
   * First hit of segment a->b against prisms and terrain. Returns t in [0,1], or 2 if clear.
   */
  raycast(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    let best = this.rayPrisms(ax, ay, az, bx, by, bz, 1)
    const tt = this.rayTerrain(ax, ay, az, bx, by, bz, best > 1 ? 1 : best)
    if (tt < best) best = tt
    return best
  }

  /** terrain first hit (t in [0,1]) or 2 */
  rayTerrain(ax: number, ay: number, az: number, bx: number, by: number, bz: number, tMax = 1): number {
    const dx = bx - ax,
      dy = by - ay,
      dz = bz - az
    const len = Math.hypot(dx, dy)
    if (az < this.ground(ax, ay) - 0.05) return 0
    const coarse = this.cmN * this.tstep
    const nC = Math.max(1, Math.ceil(len / coarse))
    const tEnd = Math.min(1, tMax)
    for (let c = 0; c < nC; c++) {
      const t0 = c / nC,
        t1 = (c + 1) / nC
      if (t0 > tEnd) break
      const za = az + dz * t0,
        zb = az + dz * t1
      const mx = ax + dx * (t0 + t1) * 0.5,
        my = ay + dy * (t0 + t1) * 0.5
      if (Math.min(za, zb) > this.coarseMax(mx, my) + 0.01) continue
      // fine sampling
      const seg = (t1 - t0) * len
      const nF = Math.max(2, Math.ceil(seg / 0.75))
      let prevT = t0
      for (let f = 1; f <= nF; f++) {
        const t = t0 + ((t1 - t0) * f) / nF
        const x = ax + dx * t,
          y = ay + dy * t,
          z = az + dz * t
        if (z < this.ground(x, y)) {
          // refine between prevT and t
          let lo = prevT,
            hi = t
          for (let it = 0; it < 6; it++) {
            const m = (lo + hi) / 2
            if (az + dz * m < this.ground(ax + dx * m, ay + dy * m)) hi = m
            else lo = m
          }
          return hi <= tEnd ? hi : 2
        }
        prevT = t
      }
    }
    return 2
  }

  /** first hit against prisms only; ignores prism `skip` filter fn */
  rayPrisms(ax: number, ay: number, az: number, bx: number, by: number, bz: number, tCut = 1): number {
    const s = ++this.stamp
    let best = 2
    const zlo = Math.min(az, bz),
      zhi = Math.max(az, bz)
    this.walkCells(ax, ay, bx, by, (cell, tEnter) => {
      if (tEnter > best || tEnter > tCut) return true
      const lst = this.cellPrisms[cell]
      for (let k = 0; k < lst.length; k++) {
        const id = lst[k]
        if (this.stampP[id] === s) continue
        this.stampP[id] = s
        const p = this.prisms[id]
        if (p.top < zlo || p.base > zhi) continue
        const t = segPrism(p, ax, ay, az, bx, by, bz)
        if (t < best) best = t
      }
      return false
    })
    return best
  }

  /**
   * Walk grid cells along a 2D segment; cb(cellIndex, tEnter) returns true to stop.
   */
  walkCells(ax: number, ay: number, bx: number, by: number, cb: (cell: number, tEnter: number) => boolean) {
    const dx = bx - ax,
      dy = by - ay
    let i = this.cx(ax),
      j = this.cy(ay)
    const ie = this.cx(bx),
      je = this.cy(by)
    const stepI = dx > 0 ? 1 : -1,
      stepJ = dy > 0 ? 1 : -1
    const fx = (ax - this.gminX) / CELL,
      fy = (ay - this.gminY) / CELL
    const tdx = dx !== 0 ? Math.abs(CELL / dx) : Infinity
    const tdy = dy !== 0 ? Math.abs(CELL / dy) : Infinity
    let tmx = dx !== 0 ? (dx > 0 ? Math.floor(fx) + 1 - fx : fx - Math.floor(fx)) * tdx : Infinity
    let tmy = dy !== 0 ? (dy > 0 ? Math.floor(fy) + 1 - fy : fy - Math.floor(fy)) * tdy : Infinity
    let tEnter = 0
    for (let guard = 0; guard < 4096; guard++) {
      if (cb(j * this.gnx + i, tEnter)) return
      if (i === ie && j === je) return
      if (tmx < tmy) {
        tEnter = tmx
        tmx += tdx
        i += stepI
      } else {
        tEnter = tmy
        tmy += tdy
        j += stepJ
      }
      if (tEnter > 1) return
      if (i < 0 || j < 0 || i >= this.gnx || j >= this.gny) return
    }
  }

  /**
   * Line of sight from a to b. Buildings and terrain block; trunks block; canopy fades the line
   * (blocked when transmission < canopyBlockT) if `canopy` is set.
   */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number, canopy: boolean): boolean {
    if (this.rayPrisms(ax, ay, az, bx, by, bz, 1) <= 1) return false
    if (this.rayTerrain(ax, ay, az, bx, by, bz, 1) <= 1) return false
    return this.treesClear(ax, ay, az, bx, by, bz, canopy)
  }

  treesClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, canopy: boolean): boolean {
    const s = ++this.stamp
    const dx = bx - ax,
      dy = by - ay,
      dz = bz - az
    const L = Math.hypot(dx, dy, dz)
    const dens = this.rules.canopyDensity
    const maxLen = Math.log(1 / this.rules.canopyBlockT) / dens
    const model = World.canopyModel
    let trans = 1
    let foliage = 0
    let blocked = false
    this.walkCells(ax, ay, bx, by, (cell) => {
      const lst = this.cellTrees[cell]
      for (let k = 0; k < lst.length; k++) {
        const id = lst[k]
        if (this.stampT[id] === s) continue
        this.stampT[id] = s
        // trunk: vertical cylinder
        const tr = this.trTR[id]
        const hit = segCircle(ax - this.trX[id], ay - this.trY[id], dx, dy, tr)
        if (hit) {
          const [t0, t1] = hit
          const za = az + dz * t0,
            zb = az + dz * t1
          const lo = Math.min(za, zb),
            hi = Math.max(za, zb)
          if (hi >= this.trZ[id] && lo <= this.trTrunkTop[id]) {
            blocked = true
            return true
          }
        }
        if (canopy) {
          // crown: ellipsoid centered (cx, cy, mid) radii (cr, cr, hh)
          const hh = (this.trH[id] - this.trCB[id]) / 2
          const cz = this.trCB[id] + hh
          const cr = this.trCR[id]
          const len = segEllipsoidChord(ax - this.trCX[id], ay - this.trCY[id], az - cz, dx, dy, dz, cr, hh)
          if (len > 0) {
            if (model === 0) {
              foliage += len * L
              if (foliage > maxLen) {
                blocked = true
                return true
              }
            } else {
              // per-crown opacity: density scaled by the chord through the crown relative to its diameter
              const frac = Math.min(1, (len * L) / (2 * cr))
              trans *= 1 - dens * (model === 1 ? frac : Math.sqrt(frac))
              if (trans < this.rules.canopyBlockT) {
                blocked = true
                return true
              }
            }
          }
        }
      }
      return false
    })
    return !blocked
  }

  /**
   * Resolve a vertical cylinder (center x,y; radius r; feet z; height h) against blocking prisms.
   * A prism blocks if its top > feet + stepUp and its base < feet + h. Returns pushed position and
   * accumulated push normal (for velocity sliding).
   */
  collide(x: number, y: number, z: number, r: number, h: number, stepUp: number, out: { x: number; y: number; nx: number; ny: number; hit: boolean }) {
    out.x = x
    out.y = y
    out.nx = 0
    out.ny = 0
    out.hit = false
    for (let iter = 0; iter < 3; iter++) {
      let moved = false
      this.forPrismsNear(out.x - r, out.y - r, out.x + r, out.y + r, (p) => {
        if (p.top <= z + stepUp || p.base >= z + h) return
        const res = pushOut(p, this, out.x, out.y, r)
        if (res) {
          out.x += res[0]
          out.y += res[1]
          const l = Math.hypot(res[0], res[1])
          if (l > 0) {
            out.nx += res[0] / l
            out.ny += res[1] / l
          }
          out.hit = true
          moved = true
        }
      })
      if (!moved) break
    }
    // bounds
    const b = this.bounds
    if (out.x < b.minX + r) {
      out.x = b.minX + r
      out.nx += 1
      out.hit = true
    }
    if (out.x > b.maxX - r) {
      out.x = b.maxX - r
      out.nx -= 1
      out.hit = true
    }
    if (out.y < b.minY + r) {
      out.y = b.minY + r
      out.ny += 1
      out.hit = true
    }
    if (out.y > b.maxY - r) {
      out.y = b.maxY - r
      out.ny -= 1
      out.hit = true
    }
  }

  /** lowest prism base above `zFrom` overlapping the disc (an overhead ceiling) or Infinity */
  ceiling(x: number, y: number, r: number, zFrom: number): number {
    let c = Infinity
    this.forPrismsNear(x - r, y - r, x + r, y + r, (p) => {
      if (p.base >= zFrom && p.base < c && discOverlapsPrism(p, this, x, y, r)) c = p.base
    })
    return c
  }

  /** highest prism top in [zLo, zHi] whose footprint overlaps the disc (for landing on roof edges) */
  edgeSupport(x: number, y: number, r: number, zLo: number, zHi: number): number {
    let s = -Infinity
    this.forPrismsNear(x - r, y - r, x + r, y + r, (p) => {
      if (p.top >= zLo && p.top <= zHi && p.top > s && discOverlapsPrism(p, this, x, y, r)) s = p.top
    })
    return s
  }

  /** true if a disc of radius r at (x,y) standing at z is clear of blocking geometry */
  discClear(x: number, y: number, z: number, r: number, h: number, stepUp: number): boolean {
    let clear = true
    this.forPrismsNear(x - r, y - r, x + r, y + r, (p) => {
      if (!clear) return
      if (p.top <= z + stepUp || p.base >= z + h) return
      if (discOverlapsPrism(p, this, x, y, r)) clear = false
    })
    return clear
  }
}

// ------------------------------------------------------------------ geometry helpers

export function polyArea(r: Float64Array): number {
  let a = 0
  const n = r.length
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1]
  return a / 2
}

/** point in polygon (even-odd) */
export function pip(r: Float64Array, x: number, y: number): boolean {
  let inside = false
  const n = r.length
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = r[i],
      yi = r[i + 1],
      xj = r[j],
      yj = r[j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const tmpT: number[] = []

/** first t in [0,1] where the 3D segment is inside the prism solid, or 2 */
export function segPrism(p: Prism, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax,
    dy = by - ay,
    dz = bz - az
  // AABB reject
  if (Math.max(ax, bx) < p.minX || Math.min(ax, bx) > p.maxX || Math.max(ay, by) < p.minY || Math.min(ay, by) > p.maxY) return 2
  tmpT.length = 0
  for (const r of p.polys) {
    const n = r.length
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const px = r[j],
        py = r[j + 1]
      const ex = r[i] - px,
        ey = r[i + 1] - py
      const den = dx * ey - dy * ex
      if (den === 0) continue
      const wx = px - ax,
        wy = py - ay
      const t = (wx * ey - wy * ex) / den
      if (t < 0 || t > 1) continue
      const s = (wx * dy - wy * dx) / den
      if (s < 0 || s >= 1) continue
      tmpT.push(t)
    }
  }
  let inside = false
  {
    // inside at a?
    if (ax >= p.minX && ax <= p.maxX && ay >= p.minY && ay <= p.maxY) {
      inside = pip(p.polys[0], ax, ay)
      if (inside) for (let k = 1; k < p.polys.length; k++) if (pip(p.polys[k], ax, ay)) inside = false
    }
  }
  if (tmpT.length === 0 && !inside) return 2
  tmpT.sort((a, b) => a - b)
  tmpT.push(1)
  let t0 = 0
  for (let k = 0; k < tmpT.length; k++) {
    const t1 = tmpT[k]
    if (inside) {
      // interval [t0, t1] inside footprint: find where base <= z <= top
      let lo: number, hi: number
      if (Math.abs(dz) < 1e-12) {
        if (az >= p.base && az <= p.top) {
          lo = t0
          hi = t1
        } else {
          lo = 1
          hi = 0
        }
      } else {
        const tb = (p.base - az) / dz,
          tt = (p.top - az) / dz
        lo = Math.max(t0, Math.min(tb, tt))
        hi = Math.min(t1, Math.max(tb, tt))
      }
      if (lo <= hi) return lo
    }
    inside = !inside
    t0 = t1
  }
  return 2
}

/** 2D segment (origin offset ox,oy relative to circle center; dir dx,dy over t in [0,1]) vs circle: [t0,t1] clipped or null */
export function segCircle(ox: number, oy: number, dx: number, dy: number, r: number): [number, number] | null {
  const a = dx * dx + dy * dy
  const b = 2 * (ox * dx + oy * dy)
  const c = ox * ox + oy * oy - r * r
  if (a < 1e-12) return c <= 0 ? [0, 1] : null
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const sq = Math.sqrt(disc)
  let t0 = (-b - sq) / (2 * a),
    t1 = (-b + sq) / (2 * a)
  if (t1 < 0 || t0 > 1) return null
  if (t0 < 0) t0 = 0
  if (t1 > 1) t1 = 1
  return [t0, t1]
}

/** chord fraction (in t units, 0..1) of a segment through an axis-aligned ellipsoid at origin with radii (r,r,hz) */
function segEllipsoidChord(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number, hz: number): number {
  if (hz <= 0 || r <= 0) return 0
  const s = r / hz
  const oz2 = oz * s,
    dz2 = dz * s
  const a = dx * dx + dy * dy + dz2 * dz2
  const b = 2 * (ox * dx + oy * dy + oz2 * dz2)
  const c = ox * ox + oy * oy + oz2 * oz2 - r * r
  if (a < 1e-12) return 0
  const disc = b * b - 4 * a * c
  if (disc <= 0) return 0
  const sq = Math.sqrt(disc)
  let t0 = (-b - sq) / (2 * a),
    t1 = (-b + sq) / (2 * a)
  if (t1 < 0 || t0 > 1) return 0
  if (t0 < 0) t0 = 0
  if (t1 > 1) t1 = 1
  // chord in true (unscaled) space: fraction of the segment, scaled by true length later
  return t1 - t0
}

/** closest point on segment to (x,y) */
function closestOnSeg(px: number, py: number, qx: number, qy: number, x: number, y: number): [number, number] {
  const ex = qx - px,
    ey = qy - py
  const l2 = ex * ex + ey * ey
  let t = l2 > 0 ? ((x - px) * ex + (y - py) * ey) / l2 : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  return [px + ex * t, py + ey * t]
}

/** squared distance from (x,y) to the prism footprint boundary, plus closest point */
function nearestEdge(p: Prism, x: number, y: number): [number, number, number] {
  let bd = Infinity,
    bx = x,
    by = y
  for (const r of p.polys) {
    const n = r.length
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const [cx, cy] = closestOnSeg(r[j], r[j + 1], r[i], r[i + 1], x, y)
      const d = (cx - x) * (cx - x) + (cy - y) * (cy - y)
      if (d < bd) {
        bd = d
        bx = cx
        by = cy
      }
    }
  }
  return [bd, bx, by]
}

export function discOverlapsPrism(p: Prism, w: World, x: number, y: number, r: number): boolean {
  if (x + r < p.minX || x - r > p.maxX || y + r < p.minY || y - r > p.maxY) return false
  if (w.inPrism(p, x, y)) return true
  const [d2] = nearestEdge(p, x, y)
  return d2 < r * r
}

/** push vector to move a disc out of a prism footprint, or null if no overlap */
function pushOut(p: Prism, w: World, x: number, y: number, r: number): [number, number] | null {
  if (x + r < p.minX || x - r > p.maxX || y + r < p.minY || y - r > p.maxY) return null
  const inside = w.inPrism(p, x, y)
  const [d2, cx, cy] = nearestEdge(p, x, y)
  if (!inside && d2 >= r * r) return null
  const d = Math.sqrt(d2)
  if (inside) {
    // move center to the nearest edge point, then r further outward
    if (d < 1e-9) return [r, 0]
    const nx = (cx - x) / d,
      ny = (cy - y) / d
    return [nx * (d + r + 0.01), ny * (d + r + 0.01)]
  }
  if (d < 1e-9) return [r, 0]
  const nx = (x - cx) / d,
    ny = (y - cy) / d
  return [nx * (r - d + 0.001), ny * (r - d + 0.001)]
}

let cached: World | null = null
let cachedDir = ""
export function loadWorld(mapDir: string): World {
  if (cached && cachedDir === mapDir) return cached
  cached = new World(mapDir)
  cachedDir = mapDir
  return cached
}
