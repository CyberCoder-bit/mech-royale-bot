// Static exposure map: how visible a mech standing at a spot is to mechs around it, precomputed
// offline by tools/precompute-exposure.ts into data/exposure.{json,bin}. Sync load, a few ms.
//
// Values are fractions in [0, 1]: 0 = no sample viewpoint (rings of 15/30/44/80/130/190 m x 64
// directions, viewers on walkable ground or reachable roofs, eye +8 m, LOS to the target's centre
// or top under the vision rules) sees the spot, 1 = every one does. "near" is the same for the
// 15/30/44 m rings only (proximity range, canopy ignored: predicts surprise contact).
// Each 4 m cell has a ground layer (terrain or bridge deck) and, where a reachable prism top
// exists, a roof layer. Pass z (feet height) to pick the layer; without z the ground layer wins.
//
// Usage: call loadExposure() once at hello (loads ~2 ms, then warms the JIT), then
// exposureAt / nearExposureAt / bestSpots / coverMask anywhere. Data is looked up next to the
// bundle (/bot/data in the image: Dockerfile needs `COPY data/ ./data/`), at ../../data from this
// source file, or in $CWD/data. Missing data logs once to stderr and the wrappers return neutral
// values (0.5, [], false). Nothing throws after load; off-map lookups count as fully exposed.
import { existsSync, readFileSync } from "fs";

export const FLAG_GROUND = 1, FLAG_WALK = 2, FLAG_ROOF = 4, FLAG_COVER_G = 8, FLAG_COVER_R = 16;
export const FLAG_DECK = 32, FLAG_OVERHEAD = 64, FLAG_POCKET = 128;

export interface Spot {
  x: number;
  y: number;
  /** feet height of the surface */
  z: number;
  roof: boolean;
  exposure: number;
  near: number;
  /** bit k: wall within 6 m in the 45° sector centred on yaw k*45° */
  cover: number;
  score: number;
}

export interface BestSpotsOpts {
  /** points to keep away from (known enemies, danger) */
  avoid?: ArrayLike<number>[];
  /** candidates closer than this (m) to an avoid point are dropped; default 40 */
  avoidRadius?: number;
  /** minimum distance (m) between returned spots; default 12 */
  minSpacing?: number;
  /** score = (1 - w) * exposure + w * near; default 0.35 */
  nearWeight?: number;
  /** subtracted from the score of cover-adjacent cells; default 0.03 */
  coverBonus?: number;
  /** include reachable roofs (needs jets); default false */
  roofs?: boolean;
  /** only walkable cells (slope ok, body fits); default true */
  walkableOnly?: boolean;
  /** allow small enclosed pockets (reachable only by jetting over walls); default false */
  pockets?: boolean;
  /** use exposure to ground-level viewers only (ignores enemies on roofs); default false */
  groundViewersOnly?: boolean;
  /** extra cost added to each candidate's score, e.g. travel distance */
  penalty?: (x: number, y: number, z: number) => number;
}

export class ExposureMap {
  readonly cell: number;
  readonly x0: number;
  readonly y0: number;
  readonly nx: number;
  readonly ny: number;
  readonly meta: any;
  readonly groundZ: Int16Array;
  readonly roofZ: Int16Array;
  readonly flags: Uint8Array;
  readonly coverG: Uint8Array;
  readonly coverR: Uint8Array;
  private planes = new Map<string, Uint8Array | Int16Array>();
  /** load time in ms */
  loadMs = 0;

  constructor(meta: any, bin: Uint8Array) {
    if (meta.format !== "mech-exposure/1") throw new Error(`exposure: unknown format ${meta.format}`);
    if (bin.byteLength !== meta.bytes) throw new Error(`exposure: bin is ${bin.byteLength} bytes, expected ${meta.bytes}`);
    this.meta = meta;
    this.cell = meta.cell;
    this.x0 = meta.x0;
    this.y0 = meta.y0;
    this.nx = meta.nx;
    this.ny = meta.ny;
    const n = this.nx * this.ny;
    // own, aligned copy so Int16Array views are legal whatever buffer readFileSync returned
    const buf = new Uint8Array(bin.byteLength);
    buf.set(bin);
    for (const p of meta.planes as { name: string; type: string; offset: number }[]) {
      this.planes.set(
        p.name,
        p.type === "i16" ? new Int16Array(buf.buffer, p.offset, n) : new Uint8Array(buf.buffer, p.offset, n),
      );
    }
    this.groundZ = this.planes.get("groundZ") as Int16Array;
    this.roofZ = this.planes.get("roofZ") as Int16Array;
    this.flags = this.planes.get("flags") as Uint8Array;
    this.coverG = this.planes.get("coverG") as Uint8Array;
    this.coverR = this.planes.get("coverR") as Uint8Array;
  }

  /** Load from a directory holding exposure.json + exposure.bin (default: auto-detect). */
  static load(dir?: string): ExposureMap {
    const t0 = performance.now();
    const d = dir ?? findDataDir();
    if (!d) throw new Error("exposure: data/exposure.json not found");
    const meta = JSON.parse(readFileSync(`${d}/exposure.json`, "utf8"));
    const bin = readFileSync(`${d}/exposure.bin`);
    const m = new ExposureMap(meta, new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength));
    m.loadMs = performance.now() - t0;
    return m;
  }

  plane(name: string): Uint8Array {
    const p = this.planes.get(name);
    if (!p) throw new Error(`exposure: no plane ${name}`);
    return p as Uint8Array;
  }

  /** cell index containing (x, y), or -1 outside the grid */
  index(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((y - this.y0) / this.cell);
    if (!(i >= 0 && j >= 0 && i < this.nx && j < this.ny)) return -1; // also NaN
    return j * this.nx + i;
  }

  cellCenter(q: number): [number, number] {
    const i = q % this.nx, j = (q - i) / this.nx;
    return [this.x0 + (i + 0.5) * this.cell, this.y0 + (j + 0.5) * this.cell];
  }

  /** layer of cell q closest to feet height z: 0 ground, 1 roof, -1 none */
  layerOf(q: number, z?: number): number {
    const f = this.flags[q];
    const g = f & FLAG_GROUND, r = f & FLAG_ROOF;
    if (g && r) {
      if (z === undefined || z !== z) return 0;
      return Math.abs(z - this.roofZ[q] / 100) < Math.abs(z - this.groundZ[q] / 100) ? 1 : 0;
    }
    return g ? 0 : r ? 1 : -1;
  }

  /** packed (q << 1 | layer) of the cell at (x, y), falling back to the nearest valid neighbour; -1 if none */
  private lookup(x: number, y: number, z?: number): number {
    const hasZ = z !== undefined && z === z;
    const q = this.index(x, y);
    let first = -1;
    if (q >= 0) {
      const l = this.layerOf(q, z);
      if (l >= 0) {
        first = (q << 1) | l;
        // the containing cell's surface matches the feet height (or none given): done
        if (!hasZ || Math.abs(this.layerZ(q, l) - z!) <= 3) return first;
      }
    }
    // edge of a building or the map, or a layer at the wrong height (standing at a wall's foot
    // whose cell centre is on the roof): nearest neighbour cell whose surface matches
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((y - this.y0) / this.cell);
    let best = -1, bd = Infinity;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.ny) continue;
        const qq = jj * this.nx + ii;
        const l = this.layerOf(qq, z);
        if (l < 0) continue;
        if (hasZ && Math.abs(this.layerZ(qq, l) - z!) > 3) continue;
        const cx = this.x0 + (ii + 0.5) * this.cell, cy = this.y0 + (jj + 0.5) * this.cell;
        const d = (cx - x) * (cx - x) + (cy - y) * (cy - y);
        if (d < bd) {
          bd = d;
          best = (qq << 1) | l;
        }
      }
    return best >= 0 ? best : first;
  }

  private layerZ(q: number, l: number): number {
    return (l ? this.roofZ : this.groundZ)[q] / 100;
  }

  private value(x: number, y: number, z: number | undefined, gName: string, rName: string, dflt: number): number {
    const k = this.lookup(x, y, z);
    if (k < 0) return dflt;
    return this.plane(k & 1 ? rName : gName)[k >> 1] / 255;
  }

  /** fraction of viewpoints that see a mech standing here (0 hidden .. 1 fully exposed); 1 off-map */
  exposureAt(x: number, y: number, z?: number, groundViewersOnly = false): number {
    return groundViewersOnly
      ? this.value(x, y, z, "gExpGV", "rExpGV", 1)
      : this.value(x, y, z, "gExp", "rExp", 1);
  }

  /** same as exposureAt for viewers within 45 m (proximity range, sees through canopy) */
  nearExposureAt(x: number, y: number, z?: number, groundViewersOnly = false): number {
    return groundViewersOnly
      ? this.value(x, y, z, "gNearGV", "rNearGV", 1)
      : this.value(x, y, z, "gNear", "rNear", 1);
  }

  /** 8-sector wall mask (bit k: wall within 6 m around yaw k*45°) */
  coverMask(x: number, y: number, z?: number): number {
    const k = this.lookup(x, y, z);
    if (k < 0) return 0;
    return (k & 1 ? this.coverR : this.coverG)[k >> 1];
  }

  isCoverAdjacent(x: number, y: number, z?: number): boolean {
    return this.coverMask(x, y, z) !== 0;
  }

  /** is there a wall within 6 m roughly toward yaw (its 45° sector, or +-1 sector if wide)? */
  coverToward(x: number, y: number, yaw: number, z?: number, wide = false): boolean {
    const m = this.coverMask(x, y, z);
    if (!m) return false;
    const s = ((Math.round(yaw / (Math.PI / 4)) % 8) + 8) % 8;
    if (m & (1 << s)) return true;
    return wide && (m & (1 << ((s + 1) % 8)) || m & (1 << ((s + 7) % 8))) !== 0;
  }

  /** feet height of the chosen layer's surface, or NaN */
  surfaceZ(x: number, y: number, z?: number): number {
    const k = this.lookup(x, y, z);
    if (k < 0) return NaN;
    return (k & 1 ? this.roofZ : this.groundZ)[k >> 1] / 100;
  }

  /** walkable ground at (x, y): not inside a building, slope ok, a mech body fits */
  isWalkable(x: number, y: number): boolean {
    const q = this.index(x, y);
    return q >= 0 && (this.flags[q] & (FLAG_GROUND | FLAG_WALK)) === (FLAG_GROUND | FLAG_WALK);
  }

  /** walkable but cut off from the main walkable area (walls/cliffs all round: jet in) */
  isPocket(x: number, y: number): boolean {
    const q = this.index(x, y);
    return q >= 0 && (this.flags[q] & FLAG_POCKET) !== 0;
  }

  /**
   * Run the hot paths a few times so the JIT compiles them before the first in-match call (a cold
   * bestSpots over a big circle can take tens of ms). Returns the time spent in ms.
   */
  warm(): number {
    const t0 = performance.now();
    const cx = this.x0 + (this.nx * this.cell) / 2, cy = this.y0 + (this.ny * this.cell) / 2;
    let acc = 0;
    for (let r = 0; r < 6; r++) {
      const spots = this.bestSpots([cx + 13 * r, cy - 7 * r], 100 + 30 * r, 6, {
        avoid: [[cx, cy]],
        roofs: r % 2 === 1,
      });
      acc += spots.length;
    }
    for (let i = 0; i < 1500; i++) {
      const x = cx + ((i * 37) % 400) - 200, y = cy + ((i * 53) % 300) - 150;
      acc += this.exposureAt(x, y, i % 3 ? undefined : 2) + this.nearExposureAt(x, y) + this.coverMask(x, y);
    }
    if (acc < 0) console.error("[expo] warm: impossible");
    return performance.now() - t0;
  }

  private candQ = new Int32Array(0);
  private candS = new Float32Array(0);
  private order = new Int32Array(0);
  private bucket = new Int32Array(4097);

  /**
   * Top-k lowest-exposure standing spots whose cell centres lie inside the circle, best first,
   * at least minSpacing apart and outside avoidRadius of every avoid point.
   */
  bestSpots(center: ArrayLike<number>, radius: number, k: number, opts: BestSpotsOpts = {}): Spot[] {
    const cx = center[0], cy = center[1];
    const w = opts.nearWeight ?? 0.35;
    const coverBonus = opts.coverBonus ?? 0.03;
    const spacing2 = (opts.minSpacing ?? 12) ** 2;
    const avoid = opts.avoid ?? [];
    const ar2 = (opts.avoidRadius ?? 40) ** 2;
    const walkOnly = opts.walkableOnly ?? true;
    const pockets = opts.pockets ?? false;
    const gv = opts.groundViewersOnly ?? false;
    const gE = this.plane(gv ? "gExpGV" : "gExp"), gN = this.plane(gv ? "gNearGV" : "gNear");
    const rE = this.plane(gv ? "rExpGV" : "rExp"), rN = this.plane(gv ? "rNearGV" : "rNear");
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((cx - radius - this.x0) / c)), i1 = Math.min(this.nx - 1, Math.floor((cx + radius - this.x0) / c));
    const j0 = Math.max(0, Math.floor((cy - radius - this.y0) / c)), j1 = Math.min(this.ny - 1, Math.floor((cy + radius - this.y0) / c));
    // off-map circle or bad input (NaN): nothing to do (and no inverted-range allocation)
    if (!(i1 >= i0 && j1 >= j0) || !(k > 0)) return [];
    const maxN = (i1 - i0 + 1) * (j1 - j0 + 1) * 2;
    if (this.candQ.length < maxN) {
      this.candQ = new Int32Array(maxN);
      this.candS = new Float32Array(maxN);
    }
    const CQ = this.candQ, CS = this.candS;
    let n = 0;
    const r2 = radius * radius;
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + (j + 0.5) * c;
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + (i + 0.5) * c;
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r2) continue;
        const q = j * this.nx + i, f = this.flags[q];
        if (!(f & (FLAG_GROUND | FLAG_ROOF))) continue;
        let bad = false;
        for (const a of avoid)
          if ((x - a[0]) * (x - a[0]) + (y - a[1]) * (y - a[1]) < ar2) {
            bad = true;
            break;
          }
        if (bad) continue;
        if (f & FLAG_GROUND && (!walkOnly || f & FLAG_WALK) && (pockets || !(f & FLAG_POCKET))) {
          let s = ((1 - w) * gE[q] + w * gN[q]) / 255 - (f & FLAG_COVER_G ? coverBonus : 0);
          if (opts.penalty) s += opts.penalty(x, y, this.groundZ[q] / 100);
          CQ[n] = q << 1;
          CS[n++] = s;
        }
        if (opts.roofs && f & FLAG_ROOF) {
          let s = ((1 - w) * rE[q] + w * rN[q]) / 255 - (f & FLAG_COVER_R ? coverBonus : 0);
          if (opts.penalty) s += opts.penalty(x, y, this.roofZ[q] / 100);
          CQ[n] = (q << 1) | 1;
          CS[n++] = s;
        }
      }
    }
    // counting sort into score buckets (typed-array sort is slow in Bun; ties within 1/4096 of the
    // score range are left in scan order)
    let sMin = Infinity, sMax = -Infinity;
    for (let m = 0; m < n; m++) {
      const v = CS[m];
      if (v < sMin) sMin = v;
      if (v > sMax) sMax = v;
    }
    const B = 4096, scale = (B - 1) / Math.max(1e-9, sMax - sMin);
    const cnt = this.bucket;
    cnt.fill(0);
    if (this.order.length < n) this.order = new Int32Array(maxN);
    const order = this.order;
    for (let m = 0; m < n; m++) cnt[(((CS[m] - sMin) * scale) | 0) + 1]++;
    for (let b = 1; b <= B; b++) cnt[b] += cnt[b - 1];
    for (let m = 0; m < n; m++) order[cnt[((CS[m] - sMin) * scale) | 0]++] = m;
    const out: Spot[] = [];
    for (let mm = 0; mm < n && out.length < k; mm++) {
      const m = order[mm];
      const key = CQ[m], q = key >> 1, roof = (key & 1) === 1;
      const [x, y] = this.cellCenter(q);
      let ok = true;
      for (const s of out)
        if ((s.x - x) * (s.x - x) + (s.y - y) * (s.y - y) < spacing2) {
          ok = false;
          break;
        }
      if (!ok) continue;
      out.push({
        x,
        y,
        z: (roof ? this.roofZ : this.groundZ)[q] / 100,
        roof,
        exposure: (roof ? rE : gE)[q] / 255,
        near: (roof ? rN : gN)[q] / 255,
        cover: (roof ? this.coverR : this.coverG)[q],
        score: CS[m],
      });
    }
    return out;
  }
}

/** first directory holding exposure.json: next to the bundle, the repo's data/, or $CWD/data */
export function findDataDir(): string | null {
  const here = import.meta.dir;
  const cands = [`${here}/data`, `${here}/../data`, `${here}/../../data`, `${process.cwd()}/data`];
  for (const d of cands) if (existsSync(`${d}/exposure.json`) && existsSync(`${d}/exposure.bin`)) return d;
  return null;
}

// ---------------- default instance (lazy, never throws) ----------------
let shared: ExposureMap | null | undefined;

/** the shared map, loaded on first use; null if the data is missing or corrupt (logged once to stderr) */
export function expo(): ExposureMap | null {
  if (shared === undefined) {
    try {
      shared = ExposureMap.load();
    } catch (e) {
      console.error(`[expo] disabled: ${(e as Error).message}`);
      shared = null;
    }
  }
  return shared;
}

/**
 * Load eagerly and warm the JIT (call at hello: ~2 ms load + tens of ms warmup, so the first
 * bestSpots in a match is not slow). Returns load + warmup time in ms, or -1 if unavailable.
 */
export function loadExposure(dir?: string, warm = true): number {
  if (dir) {
    try {
      shared = ExposureMap.load(dir);
    } catch (e) {
      console.error(`[expo] disabled: ${(e as Error).message}`);
      shared = null;
    }
  }
  const m = expo();
  if (!m) return -1;
  return m.loadMs + (warm ? m.warm() : 0);
}

export const exposureAt = (x: number, y: number, z?: number): number => expo()?.exposureAt(x, y, z) ?? 0.5;
export const nearExposureAt = (x: number, y: number, z?: number): number => expo()?.nearExposureAt(x, y, z) ?? 0.5;
export const isCoverAdjacent = (x: number, y: number, z?: number): boolean => expo()?.isCoverAdjacent(x, y, z) ?? false;
export const coverMask = (x: number, y: number, z?: number): number => expo()?.coverMask(x, y, z) ?? 0;
export const bestSpots = (center: ArrayLike<number>, radius: number, k: number, opts?: BestSpotsOpts): Spot[] =>
  expo()?.bestSpots(center, radius, k, opts) ?? [];
