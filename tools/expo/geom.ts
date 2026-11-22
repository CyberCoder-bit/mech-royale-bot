// Offline world model for the exposure precompute (tools only; the bot's runtime geometry lives in src/world).
// Vision rules modelled (protocol.md §8): terrain and every prism block sight; within near range
// trees do not block; beyond it trunks block and crowns soft-block (optical depth canopyDensity
// per metre of crown, blocked once transmittance drops below canopyBlockT).

export const MECH_H = 9;
export const EYE_H = 8;
export const CENTER_H = 4.5;
export const MAX_CLIMB = 58; // ~60 m with 100 energy (AGENTS.md §5)
export const LOW_PLATFORM = 3; // a solid this close above the terrain counts as ground (jumpable)
export const MAX_SLOPE_DEG = 50;

const KIND: Record<string, number> = { building: 0, stadium: 1, bridge: 2 };

interface Grid {
  x0: number;
  y0: number;
  cs: number;
  nx: number;
  ny: number;
  start: Int32Array; // CSR offsets, length nx*ny+1
  ids: Int32Array;
}

function buildGrid(
  x0: number,
  y0: number,
  cs: number,
  nx: number,
  ny: number,
  n: number,
  bbox: (k: number) => [number, number, number, number],
): Grid {
  const counts = new Int32Array(nx * ny + 1);
  const spans: number[] = [];
  for (let k = 0; k < n; k++) {
    const [a, b, c, d] = bbox(k);
    const i0 = Math.max(0, Math.floor((a - x0) / cs));
    const i1 = Math.min(nx - 1, Math.floor((c - x0) / cs));
    const j0 = Math.max(0, Math.floor((b - y0) / cs));
    const j1 = Math.min(ny - 1, Math.floor((d - y0) / cs));
    spans.push(i0, i1, j0, j1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * nx + i + 1]++;
  }
  for (let q = 1; q <= nx * ny; q++) counts[q] += counts[q - 1];
  const ids = new Int32Array(counts[nx * ny]);
  const fill = counts.slice(0, nx * ny);
  for (let k = 0; k < n; k++) {
    const i0 = spans[k * 4], i1 = spans[k * 4 + 1], j0 = spans[k * 4 + 2], j1 = spans[k * 4 + 3];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) ids[fill[j * nx + i]++] = k;
  }
  return { x0, y0, cs, nx, ny, start: counts, ids };
}

export interface Column {
  g: number; // terrain height
  ground: number; // walkable ground-layer surface (NaN: inside a solid)
  groundIsDeck: boolean; // ground layer is a bridge deck / low platform, not terrain
  overhead: boolean; // a solid lies above the ground layer (walk-under bridge/overhang)
  roof: number; // reachable elevated surface (NaN: none)
  slopeOk: boolean;
}

export class World {
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  // terrain
  tnx: number;
  tny: number;
  tx0: number;
  ty0: number;
  tstep: number;
  th: Float32Array;
  tbs = 8;
  tbnx: number;
  tbny: number;
  tmax: Float32Array;
  // prisms
  np: number;
  pKind: Uint8Array;
  pBase: Float64Array;
  pTop: Float64Array;
  pBox: Float64Array; // minx,miny,maxx,maxy
  pE0: Int32Array;
  pE1: Int32Array;
  E: Float64Array; // x0,y0,x1,y1 per edge (ring + holes, even-odd)
  pg: Grid;
  pStamp: Int32Array;
  // trees
  nt: number;
  cX: Float64Array;
  cY: Float64Array;
  cZ: Float64Array;
  cRh: Float64Array;
  cRv: Float64Array;
  kX: Float64Array;
  kY: Float64Array;
  kZ0: Float64Array;
  kZ1: Float64Array;
  kR: Float64Array;
  tg: Grid;
  tStamp: Int32Array;
  canopyDensity: number;
  canopyBlockT: number;
  chordLimit: number; // metres of crown that block sight
  private stamp = 0;
  private cellBuf = new Int32Array(4096);

  constructor(world: any, terrain: ArrayBuffer) {
    this.bounds = world.bounds;
    const T = world.terrain;
    this.tnx = T.nx;
    this.tny = T.ny;
    this.tx0 = T.minX;
    this.ty0 = T.minY;
    this.tstep = T.step;
    const raw = new Int16Array(terrain);
    if (raw.length !== T.nx * T.ny) throw new Error(`terrain size ${raw.length} != ${T.nx}x${T.ny}`);
    this.th = new Float32Array(raw.length);
    const sc = T.scale ?? 0.01;
    for (let q = 0; q < raw.length; q++) this.th[q] = raw[q] * sc;
    const bs = this.tbs;
    this.tbnx = Math.ceil((T.nx - 1) / bs);
    this.tbny = Math.ceil((T.ny - 1) / bs);
    this.tmax = new Float32Array(this.tbnx * this.tbny).fill(-1e9);
    for (let bj = 0; bj < this.tbny; bj++)
      for (let bi = 0; bi < this.tbnx; bi++) {
        let m = -1e9;
        for (let j = bj * bs; j <= Math.min(bj * bs + bs, T.ny - 1); j++)
          for (let i = bi * bs; i <= Math.min(bi * bs + bs, T.nx - 1); i++) m = Math.max(m, this.th[j * T.nx + i]);
        this.tmax[bj * this.tbnx + bi] = m;
      }

    // prisms
    const P = world.prisms as any[];
    this.np = P.length;
    this.pKind = new Uint8Array(P.length);
    this.pBase = new Float64Array(P.length);
    this.pTop = new Float64Array(P.length);
    this.pBox = new Float64Array(P.length * 4);
    this.pE0 = new Int32Array(P.length);
    this.pE1 = new Int32Array(P.length);
    const edges: number[] = [];
    P.forEach((p, k) => {
      this.pKind[k] = KIND[p.kind] ?? 0;
      this.pBase[k] = p.base;
      this.pTop[k] = p.top;
      this.pE0[k] = edges.length / 4;
      let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
      for (const ring of [p.ring, ...(p.holes ?? [])] as number[][]) {
        const n = ring.length / 2;
        for (let v = 0; v < n; v++) {
          const w = (v + 1) % n;
          edges.push(ring[2 * v], ring[2 * v + 1], ring[2 * w], ring[2 * w + 1]);
          mnx = Math.min(mnx, ring[2 * v]);
          mxx = Math.max(mxx, ring[2 * v]);
          mny = Math.min(mny, ring[2 * v + 1]);
          mxy = Math.max(mxy, ring[2 * v + 1]);
        }
      }
      this.pE1[k] = edges.length / 4;
      this.pBox.set([mnx, mny, mxx, mxy], k * 4);
    });
    this.E = new Float64Array(edges);
    const gx0 = this.tx0 - 32, gy0 = this.ty0 - 32, cs = 16;
    const gnx = Math.ceil((this.tnx * this.tstep + 64) / cs), gny = Math.ceil((this.tny * this.tstep + 64) / cs);
    this.pg = buildGrid(gx0, gy0, cs, gnx, gny, P.length, (k) => [
      this.pBox[k * 4],
      this.pBox[k * 4 + 1],
      this.pBox[k * 4 + 2],
      this.pBox[k * 4 + 3],
    ]);
    this.pStamp = new Int32Array(P.length);

    // trees
    const tr = world.trees;
    const F: string[] = tr.fields;
    const nf = F.length;
    const fi = (name: string) => F.indexOf(name);
    const ix = fi("x"), iy = fi("y"), iz = fi("z"), ih = fi("height"), icr = fi("crownR"), icb = fi("crownBase");
    const itr = fi("trunkR"), icx = fi("crownX"), icy = fi("crownY");
    const D = tr.data as number[];
    const nt = Math.floor(D.length / nf);
    this.nt = nt;
    this.cX = new Float64Array(nt);
    this.cY = new Float64Array(nt);
    this.cZ = new Float64Array(nt);
    this.cRh = new Float64Array(nt);
    this.cRv = new Float64Array(nt);
    this.kX = new Float64Array(nt);
    this.kY = new Float64Array(nt);
    this.kZ0 = new Float64Array(nt);
    this.kZ1 = new Float64Array(nt);
    this.kR = new Float64Array(nt);
    for (let t = 0; t < nt; t++) {
      const o = t * nf;
      const x = D[o + ix], y = D[o + iy], z = D[o + iz];
      const h = D[o + ih], cr = D[o + icr], cb = D[o + icb];
      this.kX[t] = x;
      this.kY[t] = y;
      this.kZ0[t] = z;
      this.kZ1[t] = z + Math.max(cb, 0.5 * h); // trunk visible below the crown (and a bit into it)
      this.kR[t] = itr >= 0 ? D[o + itr] : 0.3;
      this.cX[t] = icx >= 0 ? D[o + icx] : x;
      this.cY[t] = icy >= 0 ? D[o + icy] : y;
      this.cZ[t] = z + 0.5 * (cb + h);
      this.cRh[t] = cr;
      this.cRv[t] = Math.max(0.5, 0.5 * (h - cb));
    }
    this.tg = buildGrid(gx0, gy0, cs, gnx, gny, nt, (t) => {
      const r = this.cRh[t];
      return [
        Math.min(this.cX[t] - r, this.kX[t] - this.kR[t]),
        Math.min(this.cY[t] - r, this.kY[t] - this.kR[t]),
        Math.max(this.cX[t] + r, this.kX[t] + this.kR[t]),
        Math.max(this.cY[t] + r, this.kY[t] + this.kR[t]),
      ];
    });
    this.tStamp = new Int32Array(nt);
    this.canopyDensity = world.rules?.canopyDensity ?? 0.35;
    this.canopyBlockT = world.rules?.canopyBlockT ?? 0.25;
    this.chordLimit = Math.log(1 / this.canopyBlockT) / this.canopyDensity;
  }

  // ---------------- terrain ----------------
  groundAt(x: number, y: number): number {
    const fx = (x - this.tx0) / this.tstep, fy = (y - this.ty0) / this.tstep;
    let i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0) i = 0;
    else if (i > this.tnx - 2) i = this.tnx - 2;
    if (j < 0) j = 0;
    else if (j > this.tny - 2) j = this.tny - 2;
    let tx = fx - i, ty = fy - j;
    tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
    ty = ty < 0 ? 0 : ty > 1 ? 1 : ty;
    const q = j * this.tnx + i, h = this.th;
    const a = h[q], b = h[q + 1], c = h[q + this.tnx], d = h[q + this.tnx + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  slopeDeg(x: number, y: number, d = 2): number {
    const gx = (this.groundAt(x + d, y) - this.groundAt(x - d, y)) / (2 * d);
    const gy = (this.groundAt(x, y + d) - this.groundAt(x, y - d)) / (2 * d);
    return (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
  }

  /** true if the segment dips below the terrain anywhere strictly between its ends */
  terrainBlocks(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = Math.sqrt(dx * dx + dy * dy);
    const n = Math.ceil(L / this.tstep);
    if (n < 2) return false;
    const inv = 1 / n, ibs = 1 / (this.tbs * this.tstep);
    const tbnx = this.tbnx, tmax = this.tmax, mi = this.tbnx - 1, mj = this.tbny - 1;
    for (let k = 1; k < n; k++) {
      const t = k * inv;
      const x = ax + dx * t, y = ay + dy * t, z = az + dz * t;
      let bi = Math.floor((x - this.tx0) * ibs), bj = Math.floor((y - this.ty0) * ibs);
      bi = bi < 0 ? 0 : bi > mi ? mi : bi;
      bj = bj < 0 ? 0 : bj > mj ? mj : bj;
      if (z > tmax[bj * tbnx + bi]) continue;
      if (z < this.groundAt(x, y) - 0.05) return true;
    }
    return false;
  }

  // ---------------- grid traversal ----------------
  /** cells of grid g crossed by the 2D segment, into this.cellBuf; returns count */
  private rayCells(g: Grid, ax: number, ay: number, bx: number, by: number): number {
    const out = this.cellBuf;
    const x = (ax - g.x0) / g.cs, y = (ay - g.y0) / g.cs;
    const ex = (bx - g.x0) / g.cs, ey = (by - g.y0) / g.cs;
    let i = Math.floor(x), j = Math.floor(y);
    const iE = Math.floor(ex), jE = Math.floor(ey);
    const dx = ex - x, dy = ey - y;
    const si = dx > 0 ? 1 : -1, sj = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx > 0 ? (i + 1 - x) * tdx : dx < 0 ? (x - i) * tdx : Infinity;
    let tmy = dy > 0 ? (j + 1 - y) * tdy : dy < 0 ? (y - j) * tdy : Infinity;
    const steps = Math.abs(iE - i) + Math.abs(jE - j);
    let n = 0;
    for (let s = 0; s <= steps && n < out.length; s++) {
      if (i >= 0 && j >= 0 && i < g.nx && j < g.ny) out[n++] = j * g.nx + i;
      if (tmx < tmy) {
        tmx += tdx;
        i += si;
      } else {
        tmy += tdy;
        j += sj;
      }
    }
    return n;
  }

  // ---------------- prisms ----------------
  inFootprint(p: number, x: number, y: number): boolean {
    const E = this.E;
    let c = false;
    for (let e = this.pE0[p] * 4, e1 = this.pE1[p] * 4; e < e1; e += 4) {
      const y0 = E[e + 1], y1 = E[e + 3];
      if (y0 > y !== y1 > y) {
        const x0 = E[e], x1 = E[e + 2];
        if (x < ((x1 - x0) * (y - y0)) / (y1 - y0) + x0) c = !c;
      }
    }
    return c;
  }

  /**
   * does the segment pass through the solid of prism p? Only t in [lo, hi] counts: callers trim a
   * few cm off both ends so a target touching a wall (cell centre on a vertex) is not self-occluded.
   */
  prismBlocks(p: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, lo = 0, hi = 1): boolean {
    const base = this.pBase[p], top = this.pTop[p];
    let t0 = lo, t1 = hi;
    const sz = bz - az;
    if (sz === 0) {
      if (az < base || az > top) return false;
    } else {
      let ta = (base - az) / sz, tb = (top - az) / sz;
      if (ta > tb) {
        const tmp = ta;
        ta = tb;
        tb = tmp;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    const sx = bx - ax, sy = by - ay, B = this.pBox, o = p * 4;
    // slab clip to the footprint bbox
    if (sx === 0) {
      if (ax < B[o] || ax > B[o + 2]) return false;
    } else {
      let ta = (B[o] - ax) / sx, tb = (B[o + 2] - ax) / sx;
      if (ta > tb) {
        const tmp = ta;
        ta = tb;
        tb = tmp;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    if (sy === 0) {
      if (ay < B[o + 1] || ay > B[o + 3]) return false;
    } else {
      let ta = (B[o + 1] - ay) / sy, tb = (B[o + 3] - ay) / sy;
      if (ta > tb) {
        const tmp = ta;
        ta = tb;
        tb = tmp;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    // inside at t0, or a boundary crossing within [t0, t1]
    if (this.inFootprint(p, ax + sx * t0, ay + sy * t0)) return true;
    const E = this.E;
    for (let e = this.pE0[p] * 4, e1 = this.pE1[p] * 4; e < e1; e += 4) {
      const x0 = E[e], y0 = E[e + 1];
      const ex = E[e + 2] - x0, ey = E[e + 3] - y0;
      const den = sx * ey - sy * ex;
      if (den === 0) continue;
      const wx = x0 - ax, wy = y0 - ay;
      const t = (wx * ey - wy * ex) / den;
      if (t < t0 || t > t1) continue;
      const u = (wx * sy - wy * sx) / den;
      if (u >= 0 && u <= 1) return true;
    }
    return false;
  }

  prismsBlock(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const g = this.pg;
    const n = this.rayCells(g, ax, ay, bx, by);
    const st = ++this.stamp;
    const cells = this.cellBuf, S = this.pStamp;
    const L = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2);
    const eps = L > 0.2 ? 0.05 / L : 0;
    for (let c = 0; c < n; c++) {
      const q = cells[c];
      for (let m = g.start[q], m1 = g.start[q + 1]; m < m1; m++) {
        const p = g.ids[m];
        if (S[p] === st) continue;
        S[p] = st;
        if (this.prismBlocks(p, ax, ay, az, bx, by, bz, eps, 1 - eps)) return true;
      }
    }
    return false;
  }

  /** prisms whose footprint contains (x, y) */
  prismsAt(x: number, y: number, out: number[]): number[] {
    out.length = 0;
    const g = this.pg;
    const i = Math.floor((x - g.x0) / g.cs), j = Math.floor((y - g.y0) / g.cs);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return out;
    const q = j * g.nx + i, B = this.pBox;
    for (let m = g.start[q]; m < g.start[q + 1]; m++) {
      const p = g.ids[m];
      if (x < B[p * 4] || x > B[p * 4 + 2] || y < B[p * 4 + 1] || y > B[p * 4 + 3]) continue;
      if (this.inFootprint(p, x, y)) out.push(p);
    }
    return out;
  }

  // ---------------- trees ----------------
  treesBlock(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const g = this.tg;
    const n = this.rayCells(g, ax, ay, bx, by);
    const st = ++this.stamp;
    const cells = this.cellBuf, S = this.tStamp;
    const sx = bx - ax, sy = by - ay, sz = bz - az;
    const L3 = Math.sqrt(sx * sx + sy * sy + sz * sz);
    const a2 = sx * sx + sy * sy;
    const limit = this.chordLimit;
    let sum = 0;
    for (let c = 0; c < n; c++) {
      const q = cells[c];
      for (let m = g.start[q], m1 = g.start[q + 1]; m < m1; m++) {
        const t = g.ids[m];
        if (S[t] === st) continue;
        S[t] = st;
        // trunk: vertical cylinder
        {
          const fx = ax - this.kX[t], fy = ay - this.kY[t], r = this.kR[t];
          const b = fx * sx + fy * sy, cc = fx * fx + fy * fy - r * r;
          const disc = b * b - a2 * cc;
          if (disc >= 0 && a2 > 0) {
            const sq = Math.sqrt(disc);
            let t0 = (-b - sq) / a2, t1 = (-b + sq) / a2;
            if (t0 < 0) t0 = 0;
            if (t1 > 1) t1 = 1;
            if (t0 <= t1) {
              const za = az + sz * t0, zb = az + sz * t1;
              if (Math.max(za, zb) >= this.kZ0[t] && Math.min(za, zb) <= this.kZ1[t]) return true;
            }
          }
        }
        // crown: ellipsoid, accumulate chord length
        {
          const irh = 1 / this.cRh[t], irv = 1 / this.cRv[t];
          const px = (ax - this.cX[t]) * irh, py = (ay - this.cY[t]) * irh, pz = (az - this.cZ[t]) * irv;
          const dx = sx * irh, dy = sy * irh, dz = sz * irv;
          const a = dx * dx + dy * dy + dz * dz;
          const b = px * dx + py * dy + pz * dz;
          const cc = px * px + py * py + pz * pz - 1;
          const disc = b * b - a * cc;
          if (disc > 0) {
            const sq = Math.sqrt(disc);
            let t0 = (-b - sq) / a, t1 = (-b + sq) / a;
            if (t0 < 0) t0 = 0;
            if (t1 > 1) t1 = 1;
            if (t1 > t0) {
              sum += (t1 - t0) * L3;
              if (sum > limit) return true;
            }
          }
        }
      }
    }
    return false;
  }

  /** line of sight from eye A to point B under the vision rules; near = within proximity range */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number, near: boolean): boolean {
    if (this.prismsBlock(ax, ay, az, bx, by, bz)) return false;
    if (this.terrainBlocks(ax, ay, az, bx, by, bz)) return false;
    if (!near && this.treesBlock(ax, ay, az, bx, by, bz)) return false;
    return true;
  }

  // ---------------- columns ----------------
  inBounds(x: number, y: number, margin = 2.5): boolean {
    const b = this.bounds;
    return x >= b.minX + margin && x <= b.maxX - margin && y >= b.minY + margin && y <= b.maxY - margin;
  }

  private tmpIds: number[] = [];
  private tmpIv: number[] = [];

  /** walkable surfaces at (x, y) */
  column(x: number, y: number): Column {
    const g = this.groundAt(x, y);
    const ids = this.prismsAt(x, y, this.tmpIds);
    // solid intervals above the terrain, merged where the gap cannot hold a mech
    const iv = this.tmpIv;
    iv.length = 0;
    for (const p of ids) {
      const top = this.pTop[p];
      if (top <= g + 0.05) continue; // buried under terrain
      iv.push(Math.max(this.pBase[p], g), top, this.pKind[p]);
    }
    const out: Column = {
      g,
      ground: NaN,
      groundIsDeck: false,
      overhead: false,
      roof: NaN,
      slopeOk: this.slopeDeg(x, y) <= MAX_SLOPE_DEG,
    };
    if (iv.length === 0) {
      out.ground = g;
      return out;
    }
    // sort intervals by base (tiny n)
    const n = iv.length / 3;
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => iv[a * 3] - iv[b * 3]);
    const merged: { b: number; t: number; kind: number }[] = [];
    for (const k of order) {
      const b = iv[k * 3], t = iv[k * 3 + 1], kind = iv[k * 3 + 2];
      const last = merged[merged.length - 1];
      if (last && b < last.t + MECH_H) {
        if (t > last.t) last.t = t;
        if (kind !== 2) last.kind = kind; // any non-bridge part makes it a building stack
      } else merged.push({ b, t, kind });
    }
    const first = merged[0];
    let groundLevel: number;
    if (first.b >= g + MECH_H) {
      out.ground = g; // walk under
      out.overhead = true;
      groundLevel = g;
    } else if (first.kind === 2 || first.t - g <= LOW_PLATFORM) {
      out.ground = first.t; // bridge deck or low platform
      out.groundIsDeck = true;
      out.slopeOk = true;
      groundLevel = first.t;
      if (merged.length > 1) out.overhead = true;
    } else {
      groundLevel = NaN; // inside a building
    }
    const last = merged[merged.length - 1];
    if (!(last.t - g > MAX_CLIMB) && !(last.t <= groundLevel + LOW_PLATFORM)) {
      if (!(groundLevel === last.t)) out.roof = last.t;
    }
    return out;
  }

  /**
   * What stands at (x, y) for a mech on surface s: bit 1 = cover wall (solid spanning s+1..s+6,
   * or terrain >= s+6), bit 2 = something the body (s+1.2..s+9) collides with.
   */
  wallAt(x: number, y: number, s: number): number {
    const ids = this.prismsAt(x, y, this.tmpIds);
    let r = 0;
    for (const p of ids) {
      const b = this.pBase[p], t = this.pTop[p];
      if (b <= s + 1 && t >= s + 6) return 3;
      if (t > s + 1.2 && b < s + MECH_H) r |= 2;
    }
    if (this.groundAt(x, y) >= s + 6) r |= 1;
    return r;
  }
}

export async function loadWorld(mapDir: string): Promise<World> {
  const world = await Bun.file(`${mapDir}/v2/world.json`).json();
  const terr = await Bun.file(`${mapDir}/v2/terrain.i16`).arrayBuffer();
  return new World(world, terr);
}
