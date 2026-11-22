// Worker for tools/precompute-exposure.ts: evaluates exposure for whole grid rows.
import { World, loadWorld, CENTER_H, EYE_H, MECH_H } from "./geom.ts";
import { COUNTS, F_COVER_G, F_COVER_R, F_DECK, F_GROUND, F_OVERHEAD, F_ROOF, F_WALK } from "./common.ts";
import type { ExpoParams, RowResult } from "./common.ts";

declare var self: Worker;


let W: World;
let P: ExpoParams;
let OX: Float64Array, OY: Float64Array;
let vx0 = 0, vy0 = 0, vnx = 0, vny = 0;
let VE: Float32Array; // viewer eye z (NaN: nobody can stand there)
let VR: Uint8Array; // 1: viewer stands on a roof

function viewerIdx(x: number, y: number): number {
  const i = Math.floor((x - vx0) / P.viewerRes), j = Math.floor((y - vy0) / P.viewerRes);
  if (i < 0 || j < 0 || i >= vnx || j >= vny) return -1;
  return j * vnx + i;
}

function buildViewers() {
  const b = W.bounds, r = P.viewerRes;
  vx0 = Math.floor(b.minX / r) * r;
  vy0 = Math.floor(b.minY / r) * r;
  vnx = Math.ceil((b.maxX - vx0) / r);
  vny = Math.ceil((b.maxY - vy0) / r);
  VE = new Float32Array(vnx * vny).fill(NaN);
  VR = new Uint8Array(vnx * vny);
  for (let j = 0; j < vny; j++)
    for (let i = 0; i < vnx; i++) {
      const x = vx0 + (i + 0.5) * r, y = vy0 + (j + 0.5) * r;
      if (!W.inBounds(x, y)) continue;
      const c = W.column(x, y);
      if (c.ground === c.ground && c.slopeOk) VE[j * vnx + i] = c.ground + EYE_H;
      else if (c.roof === c.roof) {
        VE[j * vnx + i] = c.roof + EYE_H;
        VR[j * vnx + i] = 1;
      }
    }
}

function evalTarget(x: number, y: number, s: number, out: Uint8Array, o: number) {
  const zc = s + CENTER_H, zt = s + MECH_H;
  let sgN = 0, vgN = 0, srN = 0, vrN = 0, sgF = 0, vgF = 0, srF = 0, vrF = 0;
  const R = P.rings.length, D = P.dirs, NR = P.nearRings;
  for (let r = 0; r < R; r++) {
    const near = r < NR;
    for (let k = 0; k < D; k++) {
      const q = r * D + k;
      const vx = x + OX[q], vy = y + OY[q];
      const vi = viewerIdx(vx, vy);
      if (vi < 0) continue;
      const ez = VE[vi];
      if (ez !== ez) continue;
      const seen = W.los(vx, vy, ez, x, y, zc, near) || W.los(vx, vy, ez, x, y, zt, near) ? 1 : 0;
      if (VR[vi] === 1) {
        if (near) {
          vrN++;
          srN += seen;
        } else {
          vrF++;
          srF += seen;
        }
      } else if (near) {
        vgN++;
        sgN += seen;
      } else {
        vgF++;
        sgF += seen;
      }
    }
  }
  out[o] = sgN;
  out[o + 1] = vgN;
  out[o + 2] = srN;
  out[o + 3] = vrN;
  out[o + 4] = sgF;
  out[o + 5] = vgF;
  out[o + 6] = srF;
  out[o + 7] = vrF;
}

/**
 * Probe walls around (x, y) on surface s along coverDirs rays (0.5 m steps up to coverDist).
 * Returns the cover mask (bit k: a cover wall in the 45° sector centred on yaw k*45°) in bits 0-7
 * and bit 8 = the mech body (diameter 5 m) fits: every line through the centre has >= 5 m of room.
 */
const bodyDist = new Float64Array(64);
function probeWalls(x: number, y: number, s: number): number {
  let mask = 0;
  const nd = P.coverDirs;
  for (let k = 0; k < nd; k++) {
    const a = (2 * Math.PI * k) / nd;
    const sector = Math.round((k * 8) / nd) % 8;
    const c = Math.cos(a), sn = Math.sin(a);
    let body = 99;
    for (let d = 0.5; d <= P.coverDist + 1e-9; d += 0.5) {
      const w = W.wallAt(x + c * d, y + sn * d, s);
      if (w & 2 && body === 99) body = d;
      if (w & 1) {
        mask |= 1 << sector;
        break;
      }
    }
    bodyDist[k] = body;
  }
  let fits = true;
  for (let k = 0; k < nd / 2; k++) if (bodyDist[k] + bodyDist[k + nd / 2] < 5) fits = false;
  return mask | (fits ? 256 : 0);
}

/** a mech centre cannot be closer than its radius to a wall: step away from the nearest one (after probeWalls) */
function pushOut(x: number, y: number): [number, number] {
  const nd = P.coverDirs;
  let kMin = -1, dMin = 2.5;
  for (let k = 0; k < nd; k++)
    if (bodyDist[k] < dMin) {
      dMin = bodyDist[k];
      kMin = k;
    }
  if (kMin < 0) return [x, y];
  const a = (2 * Math.PI * kMin) / nd, push = 2.5 - dMin;
  return [x - push * Math.cos(a), y - push * Math.sin(a)];
}

function doRow(j: number): RowResult {
  const nx = P.nx;
  const res: RowResult = {
    j,
    groundZ: new Float32Array(nx).fill(NaN),
    roofZ: new Float32Array(nx).fill(NaN),
    flags: new Uint8Array(nx),
    coverG: new Uint8Array(nx),
    coverR: new Uint8Array(nx),
    cntG: new Uint8Array(nx * COUNTS),
    cntR: new Uint8Array(nx * COUNTS),
  };
  const y = P.y0 + (j + 0.5) * P.cell;
  for (let i = 0; i < nx; i++) {
    const x = P.x0 + (i + 0.5) * P.cell;
    if (!W.inBounds(x, y)) continue;
    const c = W.column(x, y);
    let f = 0;
    if (c.ground === c.ground) {
      f |= F_GROUND;
      if (c.groundIsDeck) f |= F_DECK;
      if (c.overhead) f |= F_OVERHEAD;
      res.groundZ[i] = c.ground;
      const m = probeWalls(x, y, c.ground);
      const [tx, ty] = pushOut(x, y);
      evalTarget(tx, ty, c.ground, res.cntG, i * COUNTS);
      res.coverG[i] = m & 255;
      if (m & 255) f |= F_COVER_G;
      if (c.slopeOk && m & 256) f |= F_WALK; // walkable: slope ok and the body fits
    }
    if (c.roof === c.roof) {
      f |= F_ROOF;
      res.roofZ[i] = c.roof;
      const m = probeWalls(x, y, c.roof);
      const [tx, ty] = pushOut(x, y);
      evalTarget(tx, ty, c.roof, res.cntR, i * COUNTS);
      res.coverR[i] = m & 255;
      if (m & 255) f |= F_COVER_R;
    }
    res.flags[i] = f;
  }
  return res;
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === "init") {
    P = msg.params;
    W = await loadWorld(P.mapDir);
    const R = P.rings.length, D = P.dirs;
    OX = new Float64Array(R * D);
    OY = new Float64Array(R * D);
    for (let r = 0; r < R; r++)
      for (let k = 0; k < D; k++) {
        // each ring is rotated by a fraction of a step so rings do not line up
        const a = (2 * Math.PI * (k + r / R)) / D;
        OX[r * D + k] = P.rings[r] * Math.cos(a);
        OY[r * D + k] = P.rings[r] * Math.sin(a);
      }
    buildViewers();
    postMessage({ type: "ready" });
  } else if (msg.type === "job") {
    const rows: RowResult[] = [];
    for (let j = msg.j0; j < msg.j1; j++) rows.push(doRow(j));
    postMessage({ type: "rows", rows });
  } else if (msg.type === "exit") {
    process.exit(0);
  }
};
