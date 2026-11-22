// Sanity numbers for data/exposure.* and the best hiding areas, labelled by the nearest named building.
//   bun tools/expo-report.ts [--map kit/arena] [--k 10] [--spacing 70]
import { ExposureMap, FLAG_GROUND, FLAG_WALK } from "../src/expo/exposure.ts";
import { loadWorld } from "./expo/geom.ts";

function arg(name: string): string | undefined {
  const k = process.argv.indexOf(name);
  return k >= 0 ? process.argv[k + 1] : undefined;
}
const mapDir = arg("--map") ?? "kit/arena";
const K = Number(arg("--k") ?? 10);
const spacing = Number(arg("--spacing") ?? 70);

const M = ExposureMap.load();
const W = await loadWorld(mapDir);
const world = await Bun.file(`${mapDir}/v2/world.json`).json();
console.log(`loaded in ${M.loadMs.toFixed(1)} ms; grid ${M.nx}x${M.ny} @ ${M.cell} m`);

const gExp = M.plane("gExp"), gNear = M.plane("gNear");
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const f2 = (v: number) => v.toFixed(2);

// ---- global ----
const all: number[] = [];
for (let q = 0; q < M.nx * M.ny; q++) if ((M.flags[q] & (FLAG_GROUND | FLAG_WALK)) === 3) all.push(gExp[q] / 255);
console.log(`walkable ground cells ${all.length}: mean exposure ${f2(mean(all))}`);

// ---- named regions (blocks) for labels ----
const blocks = (world.blocks as any[]).map((b) => {
  let sx = 0, sy = 0, n = 0;
  for (const p of b.prisms as number[]) {
    const r = world.prisms[p].ring as number[];
    for (let i = 0; i < r.length; i += 2) {
      sx += r[i];
      sy += r[i + 1];
      n++;
    }
  }
  return { name: (b.names?.[0] as string) ?? b.id, x: sx / n, y: sy / n };
});
const label = (x: number, y: number) => {
  let best = blocks[0], bd = Infinity;
  for (const b of blocks) {
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < bd) {
      bd = d;
      best = b;
    }
  }
  const st = world.stadium;
  const ds = Math.hypot(st.center[0] - x, st.center[1] - y);
  if (ds < bd) return `${st.name} (${ds.toFixed(0)} m from centre)`;
  return `${best.name} (${bd.toFixed(0)} m)`;
};

// ---- open lots ----
const lots: number[] = [];
for (const p of world.parking as any[]) {
  const r = p.ring as number[];
  let sx = 0, sy = 0;
  for (let i = 0; i < r.length; i += 2) {
    sx += r[i];
    sy += r[i + 1];
  }
  const x = sx / (r.length / 2), y = sy / (r.length / 2);
  if (!M.isWalkable(x, y)) continue;
  lots.push(M.exposureAt(x, y));
}
console.log(`parking-lot centroids (${lots.length}): mean exposure ${f2(mean(lots))}`);

// ---- courtyards: prism holes big enough to stand in ----
const yards: { x: number; y: number; area: number; e: number; n: number }[] = [];
for (const p of world.prisms as any[])
  for (const h of (p.holes ?? []) as number[][]) {
    let a = 0, cx = 0, cy = 0;
    const n = h.length / 2;
    for (let i = 0; i < n; i++) {
      const x0 = h[2 * i], y0 = h[2 * i + 1], x1 = h[(2 * i + 2) % h.length], y1 = h[(2 * i + 3) % h.length];
      const c = x0 * y1 - x1 * y0;
      a += c;
      cx += (x0 + x1) * c;
      cy += (y0 + y1) * c;
    }
    a /= 2;
    if (Math.abs(a) < 250) continue;
    cx /= 6 * a;
    cy /= 6 * a;
    const q = M.index(cx, cy);
    if (q < 0 || !(M.flags[q] & FLAG_GROUND)) continue;
    yards.push({ x: cx, y: cy, area: Math.abs(a), e: gExp[q] / 255, n: gNear[q] / 255 });
  }
console.log(`courtyards >= 250 m2 with ground (${yards.length}): mean exposure ${f2(mean(yards.map((c) => c.e)))}, near ${f2(mean(yards.map((c) => c.n)))}`);
for (const c of yards.slice(0, 8)) console.log(`  (${c.x.toFixed(0)}, ${c.y.toFixed(0)}) ${c.area.toFixed(0)} m2 exp ${f2(c.e)} near ${f2(c.n)}`);

// ---- alleys: walls on opposite sides ----
const alley: number[] = [], openNoCover: number[] = [], oneSide: number[] = [];
for (let q = 0; q < M.nx * M.ny; q++) {
  if ((M.flags[q] & 3) !== 3) continue;
  const m = M.coverG[q];
  const opp = (m & 0x11) === 0x11 || (m & 0x22) === 0x22 || (m & 0x44) === 0x44 || (m & 0x88) === 0x88;
  if (opp) alley.push(gExp[q] / 255);
  else if (m) oneSide.push(gExp[q] / 255);
  else openNoCover.push(gExp[q] / 255);
}
console.log(`alleys (walls on opposite sides) ${alley.length}: ${f2(mean(alley))}; one-side cover ${oneSide.length}: ${f2(mean(oneSide))}; no wall within 6 m ${openNoCover.length}: ${f2(mean(openNoCover))}`);

// ---- trees: cells far from buildings, by crown count within 25 m ----
const buckets = new Map<string, number[]>();
for (let q = 0; q < M.nx * M.ny; q++) {
  if ((M.flags[q] & 3) !== 3) continue;
  const [x, y] = M.cellCenter(q);
  // no building within 60 m (isolates the tree effect)
  let nearB = false;
  for (let p = 0; p < W.np && !nearB; p++) {
    const B = W.pBox;
    const dx = Math.max(B[p * 4] - x, 0, x - B[p * 4 + 2]), dy = Math.max(B[p * 4 + 1] - y, 0, y - B[p * 4 + 3]);
    if (dx * dx + dy * dy < 3600) nearB = true;
  }
  if (nearB) continue;
  let n = 0;
  for (let t = 0; t < W.nt; t++) if (Math.hypot(W.cX[t] - x, W.cY[t] - y) < 25) n++;
  const key = n === 0 ? "0" : n <= 3 ? "1-3" : n <= 8 ? "4-8" : "9+";
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key)!.push(gExp[q] / 255);
}
for (const k of ["0", "1-3", "4-8", "9+"]) {
  const a = buckets.get(k) ?? [];
  console.log(`no building within 60 m, ${k.padStart(3)} crowns within 25 m: ${String(a.length).padStart(5)} cells, mean exposure ${f2(mean(a))}`);
}

// ---- best hiding areas ----
console.log(`\nbest ${K} hiding spots (walkable ground, >= ${spacing} m apart, score = 0.65 exp + 0.35 near):`);
const spots = M.bestSpots([20, 30], 2000, K, { minSpacing: spacing });
for (const s of spots)
  console.log(
    `  (${s.x.toFixed(0)}, ${s.y.toFixed(0)}, z ${s.z.toFixed(1)}) exp ${f2(s.exposure)} near ${f2(s.near)} cover ${s.cover.toString(2).padStart(8, "0")}  ${label(s.x, s.y)}`,
  );
// areas: mean score over walkable cells in a 5x5 (20 m) window with room to move (>= 12 cells)
const score = (q: number) => (0.65 * gExp[q] + 0.35 * gNear[q]) / 255;
const ok = (q: number) => (M.flags[q] & (FLAG_GROUND | FLAG_WALK | 128)) === (FLAG_GROUND | FLAG_WALK);
const areas: { q: number; s: number; e: number; n: number }[] = [];
for (let j = 2; j < M.ny - 2; j++)
  for (let i = 2; i < M.nx - 2; i++) {
    const q = j * M.nx + i;
    if (!ok(q)) continue;
    let s = 0, e = 0, c = 0;
    for (let dj = -2; dj <= 2; dj++)
      for (let di = -2; di <= 2; di++) {
        const r = q + dj * M.nx + di;
        if (!ok(r)) continue;
        s += score(r);
        e += gExp[r] / 255;
        c++;
      }
    if (c >= 12) areas.push({ q, s: s / c, e: e / c, n: c });
  }
areas.sort((a, b) => a.s - b.s);
const picked: typeof areas = [];
for (const a of areas) {
  if (picked.length >= K) break;
  const [x, y] = M.cellCenter(a.q);
  if (picked.some((p) => Math.hypot(M.cellCenter(p.q)[0] - x, M.cellCenter(p.q)[1] - y) < spacing)) continue;
  picked.push(a);
}
console.log(`\nbest ${K} hiding AREAS (20 m window, >= 12 walkable cells, >= ${spacing} m apart):`);
for (const a of picked) {
  const [x, y] = M.cellCenter(a.q);
  console.log(`  (${x.toFixed(0)}, ${y.toFixed(0)}) mean exp ${f2(a.e)} (score ${f2(a.s)}, ${a.n} cells)  ${label(x, y)}`);
}

const t0 = performance.now();
for (let r = 0; r < 20; r++) M.bestSpots([40, -70], 240, 8, { avoid: [[0, 0]] });
console.log(`bestSpots(r=240, k=8) ${((performance.now() - t0) / 20).toFixed(2)} ms/call`);
