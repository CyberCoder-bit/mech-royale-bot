// Offline precompute of the static exposure map: data/exposure.bin + data/exposure.json.
//   bun tools/precompute-exposure.ts [--map kit/arena] [--out data] [--workers 23] [--rows j0:j1]
// Exposure of a cell = fraction of sample viewpoints (mechs standing on walkable ground or roofs at
// rings of 15/30/44/80/130/190 m x 64 directions, eye at surface + 8 m) that have LOS to the
// target mech's centre (+4.5) or top (+9). FOV wedge ignored (viewers can turn). Near rings
// (<= 45 m) use proximity rules (trees do not block); far rings add trunks and canopy.
import { cpus } from "os";
import { mkdirSync, writeFileSync } from "fs";
import type { ExpoParams, RowResult } from "./expo/common.ts";
import { COUNTS, F_GROUND, F_POCKET, F_WALK } from "./expo/common.ts";

function arg(name: string): string | undefined {
  const k = process.argv.indexOf(name);
  return k >= 0 ? process.argv[k + 1] : undefined;
}

const mapDir = arg("--map") ?? "kit/arena";
const outDir = arg("--out") ?? "data";
const nWorkers = Number(arg("--workers") ?? Math.max(1, cpus().length - 1));
const CELL = 4;
const RINGS = [15, 30, 44, 80, 130, 190];
const NEAR_RINGS = 3;
const DIRS = Number(arg("--dirs") ?? 64); // spec asks >= 32; 64 halves sampling noise, still fits a byte

const world = await Bun.file(`${mapDir}/v2/world.json`).json();
const b = world.bounds;
const x0 = Math.floor(b.minX / CELL) * CELL, y0 = Math.floor(b.minY / CELL) * CELL;
const nx = Math.ceil((b.maxX - x0) / CELL), ny = Math.ceil((b.maxY - y0) / CELL);
const N = nx * ny;
let rowLo = 0, rowHi = ny;
const rowsArg = arg("--rows");
if (rowsArg) [rowLo, rowHi] = rowsArg.split(":").map(Number);

const params: ExpoParams = {
  mapDir,
  x0,
  y0,
  nx,
  ny,
  cell: CELL,
  rings: RINGS,
  nearRings: NEAR_RINGS,
  dirs: DIRS,
  viewerRes: 2,
  coverDist: 6,
  coverDirs: 16,
};

console.error(`grid ${nx}x${ny} cells of ${CELL} m from (${x0}, ${y0}); rows ${rowLo}..${rowHi}; ${nWorkers} workers`);
const t0 = performance.now();

const groundZ = new Float32Array(N).fill(NaN);
const roofZ = new Float32Array(N).fill(NaN);
const flags = new Uint8Array(N);
const coverG = new Uint8Array(N);
const coverR = new Uint8Array(N);
const cntG = new Uint8Array(N * COUNTS);
const cntR = new Uint8Array(N * COUNTS);

function store(r: RowResult) {
  const o = r.j * nx;
  groundZ.set(r.groundZ, o);
  roofZ.set(r.roofZ, o);
  flags.set(r.flags, o);
  coverG.set(r.coverG, o);
  coverR.set(r.coverR, o);
  cntG.set(r.cntG, o * COUNTS);
  cntR.set(r.cntR, o * COUNTS);
}

// dynamic row scheduling: city rows are much slower than open ones
const CHUNK = 1;
let next = rowLo, done = 0;
const total = rowHi - rowLo;
await new Promise<void>((resolve, reject) => {
  let live = 0;
  for (let w = 0; w < Math.min(nWorkers, total); w++) {
    const worker = new Worker(new URL("./expo/worker.ts", import.meta.url).href);
    live++;
    const feed = () => {
      if (next >= rowHi) {
        worker.terminate();
        if (--live === 0) resolve();
        return;
      }
      const j0 = next, j1 = Math.min(rowHi, next + CHUNK);
      next = j1;
      worker.postMessage({ type: "job", j0, j1 });
    };
    worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (m.type === "ready") feed();
      else if (m.type === "rows") {
        for (const r of m.rows as RowResult[]) store(r);
        done += m.rows.length;
        if (done % 20 === 0 || done === total)
          console.error(`  ${done}/${total} rows, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        feed();
      }
    };
    worker.onerror = (e) => reject(e);
    worker.postMessage({ type: "init", params });
  }
});
const tCompute = (performance.now() - t0) / 1000;

// ---- pockets: small walkable components (4-connected, |dz| <= 4 m between neighbours) ----
const POCKET_CELLS = 30;
{
  const comp = new Int32Array(N).fill(-1);
  const stack: number[] = [];
  const walk = (q: number) => (flags[q] & (F_GROUND | F_WALK)) === (F_GROUND | F_WALK);
  let nComp = 0;
  for (let s = 0; s < N; s++) {
    if (!walk(s) || comp[s] >= 0) continue;
    const members: number[] = [];
    comp[s] = nComp;
    stack.push(s);
    while (stack.length) {
      const q = stack.pop()!;
      members.push(q);
      const i = q % nx, j = (q - i) / nx;
      const nb = [i > 0 ? q - 1 : -1, i < nx - 1 ? q + 1 : -1, j > 0 ? q - nx : -1, j < ny - 1 ? q + nx : -1];
      for (const r of nb) {
        if (r < 0 || comp[r] >= 0 || !walk(r)) continue;
        if (Math.abs(groundZ[r] - groundZ[q]) > 4) continue;
        comp[r] = nComp;
        stack.push(r);
      }
    }
    if (members.length < POCKET_CELLS) for (const q of members) flags[q] |= F_POCKET;
    nComp++;
  }
}

// ---- reduce counts to bytes ----
const frac = (s: number, v: number) => (v > 0 ? Math.round((255 * s) / v) : 0);
function planes(cnt: Uint8Array) {
  const exp = new Uint8Array(N), near = new Uint8Array(N), expGV = new Uint8Array(N), nearGV = new Uint8Array(N);
  for (let q = 0; q < N; q++) {
    const o = q * COUNTS;
    const sgN = cnt[o], vgN = cnt[o + 1], srN = cnt[o + 2], vrN = cnt[o + 3];
    const sgF = cnt[o + 4], vgF = cnt[o + 5], srF = cnt[o + 6], vrF = cnt[o + 7];
    exp[q] = frac(sgN + srN + sgF + srF, vgN + vrN + vgF + vrF);
    near[q] = frac(sgN + srN, vgN + vrN);
    // same denominators as exp/near, so exp = expGV + the roof viewers' share
    expGV[q] = frac(sgN + sgF, vgN + vrN + vgF + vrF);
    nearGV[q] = frac(sgN, vgN + vrN);
  }
  return { exp, near, expGV, nearGV };
}
const G = planes(cntG), R = planes(cntR);
const toCm = (a: Float32Array) => {
  const o = new Int16Array(N);
  for (let q = 0; q < N; q++) o[q] = a[q] === a[q] ? Math.max(-32767, Math.min(32767, Math.round(a[q] * 100))) : -32768;
  return o;
};

const planeList: [string, "i16" | "u8", ArrayBufferView][] = [
  ["groundZ", "i16", toCm(groundZ)],
  ["roofZ", "i16", toCm(roofZ)],
  ["flags", "u8", flags],
  ["coverG", "u8", coverG],
  ["coverR", "u8", coverR],
  ["gExp", "u8", G.exp],
  ["gNear", "u8", G.near],
  ["gExpGV", "u8", G.expGV],
  ["gNearGV", "u8", G.nearGV],
  ["rExp", "u8", R.exp],
  ["rNear", "u8", R.near],
  ["rExpGV", "u8", R.expGV],
  ["rNearGV", "u8", R.nearGV],
];
let off = 0;
const meta: any[] = [];
for (const [name, type, arr] of planeList) {
  meta.push({ name, type, offset: off });
  off += arr.byteLength;
}
const bin = new Uint8Array(off);
for (let k = 0; k < planeList.length; k++) {
  const arr = planeList[k][2];
  bin.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), meta[k].offset);
}

// ---- stats ----
let nG = 0, nW = 0, nR = 0, nCG = 0, nCR = 0, nP = 0;
const hist = new Array(10).fill(0);
for (let q = 0; q < N; q++) {
  const f = flags[q];
  if (f & 1) {
    nG++;
    hist[Math.min(9, Math.floor(G.exp[q] / 25.6))]++;
  }
  if (f & 2) nW++;
  if (f & 4) nR++;
  if (f & 8) nCG++;
  if (f & 16) nCR++;
  if (f & 128) nP++;
}

const json = {
  format: "mech-exposure/1",
  generated: new Date().toISOString(),
  cell: CELL,
  x0,
  y0,
  nx,
  ny,
  bytes: off,
  noneZ: -32768,
  planes: meta,
  flags: { ground: 1, walkable: 2, roof: 4, coverGround: 8, coverRoof: 16, deck: 32, overhead: 64, pocket: 128 },
  flagNotes: "walkable = ground layer, slope <= 50° and a 5 m wide body fits; pocket = walkable cell in a component of < 30 cells (cut off by walls or cliffs, reach with jets)",
  cover: "bit k: wall (solid spanning surface+1..surface+6 m, or terrain >= surface+6) within 6 m in the 45° sector centred on yaw k*45°",
  model: {
    rings: RINGS,
    nearRings: NEAR_RINGS,
    dirs: DIRS,
    viewerRes: params.viewerRes,
    viewer: "mech on walkable ground (slope <= 50°) or a reachable roof (<= 58 m up), eye at surface + 8",
    target: "LOS to surface+4.5 or surface+9",
    near: "rings <= 44 m: terrain and prisms block, trees do not",
    far: "terrain, prisms and trunks block; crowns (ellipsoids) block when exp(-canopyDensity * chord) < canopyBlockT",
    canopyDensity: world.rules?.canopyDensity,
    canopyBlockT: world.rules?.canopyBlockT,
    planes: "gExp/rExp: all viewers, all rings; gNear/rNear: rings <= 44 m; *GV: only viewers standing on the ground count as seeing (same denominator, so *GV <= the plain plane). 0..255 = fraction of valid viewpoints that see the target",
  },
  stats: {
    rows: [rowLo, rowHi],
    computeSeconds: +tCompute.toFixed(1),
    workers: nWorkers,
    groundCells: nG,
    walkableCells: nW,
    roofCells: nR,
    coverGroundCells: nCG,
    coverRoofCells: nCR,
    pocketCells: nP,
    groundExpHistogram: hist,
  },
};

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/exposure.bin`, bin);
writeFileSync(`${outDir}/exposure.json`, JSON.stringify(json, null, 1) + "\n");
console.error(`wrote ${outDir}/exposure.bin (${(off / 1024).toFixed(0)} KiB) + exposure.json in ${tCompute.toFixed(1)} s`);
console.error(JSON.stringify(json.stats));
process.exit(0);
