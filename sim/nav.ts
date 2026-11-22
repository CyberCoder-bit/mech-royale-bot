/** Ground navigation grid + A* for the in-process house bots (sim-internal, not shared with src/). */
import type { World } from "./world.ts"

export class NavGrid {
  cs: number
  nx: number
  ny: number
  minX: number
  minY: number
  walk: Uint8Array
  h: Float32Array
  comp: Int32Array
  // A* scratch
  private g: Float32Array
  private came: Int32Array
  private stamp: Int32Array
  private closed: Uint8Array
  private cur = 1
  private heap: Int32Array
  private heapF: Float32Array
  private hn = 0
  w: World

  constructor(w: World, cs = 3) {
    this.w = w
    this.cs = cs
    const b = w.bounds
    this.minX = b.minX
    this.minY = b.minY
    this.nx = Math.ceil((b.maxX - b.minX) / cs)
    this.ny = Math.ceil((b.maxY - b.minY) / cs)
    const N = this.nx * this.ny
    this.walk = new Uint8Array(N)
    this.h = new Float32Array(N)
    const R = 2.6
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) {
        const x = this.minX + (i + 0.5) * cs,
          y = this.minY + (j + 0.5) * cs
        const k = j * this.nx + i
        if (x < b.minX + R || x > b.maxX - R || y < b.minY + R || y > b.maxY - R) continue
        const gr = w.ground(x, y)
        const sup = w.support(x, y, gr + 1.2)
        this.h[k] = sup
        if (!w.discClear(x, y, sup, R, 9, 1.2)) continue
        if (w.ceiling(x, y, R, sup + 0.5) < sup + 9.2) continue
        if (sup <= gr + 0.01 && w.slope(x, y) > 1.0) continue
        this.walk[k] = 1
      }
    // connected components (4-neighbour, |dh| <= 1.3)
    this.comp = new Int32Array(N).fill(-1)
    let nc = 0
    const q: number[] = []
    for (let s0 = 0; s0 < N; s0++) {
      if (!this.walk[s0] || this.comp[s0] >= 0) continue
      q.length = 0
      q.push(s0)
      this.comp[s0] = nc
      while (q.length) {
        const k = q.pop()!
        const i = k % this.nx,
          j = Math.floor(k / this.nx)
        for (let d = 0; d < 4; d++) {
          const ii = i + (d === 0 ? 1 : d === 1 ? -1 : 0),
            jj = j + (d === 2 ? 1 : d === 3 ? -1 : 0)
          if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.ny) continue
          const n = jj * this.nx + ii
          if (!this.walk[n] || this.comp[n] >= 0) continue
          if (Math.abs(this.h[n] - this.h[k]) > 1.3) continue
          this.comp[n] = nc
          q.push(n)
        }
      }
      nc++
    }
    this.g = new Float32Array(N)
    this.came = new Int32Array(N)
    this.stamp = new Int32Array(N)
    this.closed = new Uint8Array(N)
    this.heap = new Int32Array(N + 8)
    this.heapF = new Float32Array(N + 8)
  }

  cell(x: number, y: number): number {
    let i = Math.floor((x - this.minX) / this.cs),
      j = Math.floor((y - this.minY) / this.cs)
    if (i < 0) i = 0
    if (j < 0) j = 0
    if (i >= this.nx) i = this.nx - 1
    if (j >= this.ny) j = this.ny - 1
    return j * this.nx + i
  }
  cx(k: number) {
    return this.minX + ((k % this.nx) + 0.5) * this.cs
  }
  cy(k: number) {
    return this.minY + (Math.floor(k / this.nx) + 0.5) * this.cs
  }

  walkable(x: number, y: number) {
    return this.walk[this.cell(x, y)] === 1
  }

  /** nearest walkable cell (spiral search up to r cells) */
  nearest(x: number, y: number, r = 12): number {
    const k0 = this.cell(x, y)
    if (this.walk[k0]) return k0
    const i0 = k0 % this.nx,
      j0 = Math.floor(k0 / this.nx)
    let best = -1,
      bd = Infinity
    for (let d = 1; d <= r; d++) {
      for (let dj = -d; dj <= d; dj++)
        for (let di = -d; di <= d; di++) {
          if (Math.abs(di) !== d && Math.abs(dj) !== d) continue
          const i = i0 + di,
            j = j0 + dj
          if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue
          const k = j * this.nx + i
          if (!this.walk[k]) continue
          const dd = di * di + dj * dj
          if (dd < bd) {
            bd = dd
            best = k
          }
        }
      if (best >= 0) return best
    }
    return -1
  }

  /** nearest cell to (x,y) that belongs to component c (ring search), or -1 */
  closestInComp(x: number, y: number, c: number, maxR = 80): number {
    const k0 = this.cell(x, y)
    if (this.walk[k0] && this.comp[k0] === c) return k0
    const i0 = k0 % this.nx,
      j0 = Math.floor(k0 / this.nx)
    for (let d = 1; d <= maxR; d++) {
      let best = -1,
        bd = Infinity
      for (let dj = -d; dj <= d; dj++)
        for (let di = -d; di <= d; di++) {
          if (Math.abs(di) !== d && Math.abs(dj) !== d) continue
          const i = i0 + di,
            j = j0 + dj
          if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue
          const k = j * this.nx + i
          if (!this.walk[k] || this.comp[k] !== c) continue
          const dd = di * di + dj * dj
          if (dd < bd) {
            bd = dd
            best = k
          }
        }
      if (best >= 0) return best
    }
    return -1
  }

  /** grid straight-line walkability (samples every half cell) */
  lineWalkable(ax: number, ay: number, bx: number, by: number): boolean {
    const L = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.ceil(L / (this.cs * 0.5)))
    let prevH = this.h[this.cell(ax, ay)]
    for (let s = 1; s <= n; s++) {
      const x = ax + ((bx - ax) * s) / n,
        y = ay + ((by - ay) * s) / n
      const k = this.cell(x, y)
      if (!this.walk[k]) return false
      if (Math.abs(this.h[k] - prevH) > 1.3) return false
      prevH = this.h[k]
    }
    return true
  }

  private push(k: number, f: number) {
    let i = this.hn++
    const H = this.heap,
      F = this.heapF
    while (i > 0) {
      const p = (i - 1) >> 1
      if (F[p] <= f) break
      H[i] = H[p]
      F[i] = F[p]
      i = p
    }
    H[i] = k
    F[i] = f
  }
  private pop(): number {
    const H = this.heap,
      F = this.heapF
    const top = H[0]
    const lk = H[--this.hn],
      lf = F[this.hn]
    let i = 0
    while (true) {
      let c = 2 * i + 1
      if (c >= this.hn) break
      if (c + 1 < this.hn && F[c + 1] < F[c]) c++
      if (F[c] >= lf) break
      H[i] = H[c]
      F[i] = F[c]
      i = c
    }
    H[i] = lk
    F[i] = lf
    return top
  }

  /** A* path as flat [x0,y0,x1,y1,...] of cell centers from start to goal, or null */
  path(sx: number, sy: number, gx: number, gy: number, maxExpand = 40000): number[] | null {
    const s = this.nearest(sx, sy, 6)
    let goal = this.nearest(gx, gy, 20)
    if (s < 0 || goal < 0) return null
    if (s === goal) return [gx, gy]
    const st = ++this.cur
    const nx = this.nx
    const gi = goal % nx,
      gj = Math.floor(goal / nx)
    this.hn = 0
    this.g[s] = 0
    this.stamp[s] = st
    this.came[s] = -1
    this.closed[s] = 0
    const hfun = (k: number) => {
      const di = Math.abs((k % nx) - gi),
        dj = Math.abs(Math.floor(k / nx) - gj)
      return (Math.max(di, dj) + 0.4142 * Math.min(di, dj)) * 1.0
    }
    this.push(s, hfun(s))
    let found = false
    let exp = 0
    let bestK = s,
      bestH = hfun(s)
    const DI = [1, -1, 0, 0, 1, 1, -1, -1],
      DJ = [0, 0, 1, -1, 1, -1, 1, -1],
      DC = [1, 1, 1, 1, 1.4142, 1.4142, 1.4142, 1.4142]
    while (this.hn > 0) {
      const k = this.pop()
      if (this.stamp[k] === st && this.closed[k] === 1) continue
      this.closed[k] = 1
      if (k === goal) {
        found = true
        break
      }
      if (++exp > maxExpand) break
      const hk = hfun(k)
      if (hk < bestH) {
        bestH = hk
        bestK = k
      }
      const i = k % nx,
        j = Math.floor(k / nx)
      const hk0 = this.h[k]
      for (let d = 0; d < 8; d++) {
        const ii = i + DI[d],
          jj = j + DJ[d]
        if (ii < 0 || jj < 0 || ii >= nx || jj >= this.ny) continue
        const n = jj * nx + ii
        if (!this.walk[n]) continue
        if (Math.abs(this.h[n] - hk0) > 1.3) continue
        if (d >= 4 && (!this.walk[j * nx + ii] || !this.walk[jj * nx + i])) continue
        const ng = this.g[k] + DC[d]
        if (this.stamp[n] === st) {
          if (this.closed[n] === 1 || ng >= this.g[n]) continue
        } else {
          this.stamp[n] = st
          this.closed[n] = 0
        }
        this.g[n] = ng
        this.came[n] = k
        this.push(n, ng + hfun(n))
      }
    }
    const end = found ? goal : bestK
    if (end === s) return null
    const cells: number[] = []
    for (let k = end; k !== -1 && cells.length < 100000; k = this.came[k]) cells.push(k)
    cells.reverse()
    const out: number[] = []
    // string-pull: keep cells where the straight line breaks
    let anchorX = sx,
      anchorY = sy
    for (let c = 1; c < cells.length; c++) {
      const x = this.cx(cells[c]),
        y = this.cy(cells[c])
      const nxtOk = c + 1 < cells.length ? this.lineWalkable(anchorX, anchorY, this.cx(cells[c + 1]), this.cy(cells[c + 1])) : false
      if (!nxtOk) {
        out.push(x, y)
        anchorX = x
        anchorY = y
      }
    }
    if (found) out.push(gx, gy)
    return out
  }
}

let shared: NavGrid | null = null
export function getNav(w: World): NavGrid {
  if (!shared || shared.w !== w) shared = new NavGrid(w)
  return shared
}
