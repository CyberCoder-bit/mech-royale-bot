// Tests for the static exposure map (src/expo/exposure.ts + data/exposure.*).
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ExposureMap,
  FLAG_COVER_G,
  FLAG_GROUND,
  FLAG_POCKET,
  FLAG_ROOF,
  FLAG_WALK,
  exposureAt,
  bestSpots,
} from "../src/expo/exposure.ts";
import { loadWorld } from "../tools/expo/geom.ts";

const ROOT = join(import.meta.dir, "..");
const M = ExposureMap.load();
const W = await loadWorld(join(ROOT, "kit/arena"));
const gExp = M.plane("gExp");
const N = M.nx * M.ny;
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const walk = (q: number) => (M.flags[q] & (FLAG_GROUND | FLAG_WALK)) === (FLAG_GROUND | FLAG_WALK);

describe("loader", () => {
  test("loads from the repo data/ fast and matches its meta", () => {
    const m = ExposureMap.load();
    expect(m.loadMs).toBeLessThan(100);
    expect(m.meta.format).toBe("mech-exposure/1");
    expect(m.flags.length).toBe(m.nx * m.ny);
    expect(m.groundZ.length).toBe(m.nx * m.ny);
    // the grid covers the map bounds
    expect(m.x0).toBeLessThanOrEqual(-512.38);
    expect(m.x0 + m.nx * m.cell).toBeGreaterThanOrEqual(555.08);
    expect(m.y0).toBeLessThanOrEqual(-333.09);
    expect(m.y0 + m.ny * m.cell).toBeGreaterThanOrEqual(388.64);
  });

  test("bundled copy finds data/ next to bot.js (image layout /bot/bot.js + /bot/data)", () => {
    const dir = mkdtempSync(join(tmpdir(), "expo-bundle-"));
    try {
      const b = Bun.spawnSync(["bun", "build", join(ROOT, "src/expo/selftest.ts"), "--target=bun", `--outfile=${dir}/bot.js`]);
      expect(b.exitCode).toBe(0);
      mkdirSync(join(dir, "data"));
      cpSync(join(ROOT, "data/exposure.json"), join(dir, "data/exposure.json"));
      cpSync(join(ROOT, "data/exposure.bin"), join(dir, "data/exposure.bin"));
      const r = Bun.spawnSync(["bun", join(dir, "bot.js")], { cwd: "/" });
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout.toString().trim());
      expect(out.ok).toBe(true);
      expect(out.dir).toBe(join(dir, "data"));
      expect(out.loadMs).toBeLessThan(100);
      expect(out.warmMs).toBeLessThan(2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("module wrappers load lazily", () => {
    const v = exposureAt(40, -70);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
    expect(bestSpots([40, -70], 100, 2).length).toBe(2);
  });
});

describe("lookups", () => {
  test("values are fractions; off-map is fully exposed", () => {
    for (const [x, y] of [[0, 0], [-276, 128], [300, -100], [-450, 250]]) {
      const e = M.exposureAt(x, y), n = M.nearExposureAt(x, y);
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(1);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
      // ground viewers only can never see more than all viewers
      expect(M.exposureAt(x, y, undefined, true)).toBeLessThanOrEqual(e + 1e-9);
    }
    expect(M.exposureAt(5000, 5000)).toBe(1);
    expect(M.isCoverAdjacent(5000, 5000)).toBe(false);
  });

  test("surface heights follow the terrain and the stadium field", () => {
    expect(M.surfaceZ(-276, 128)).toBeCloseTo(-9.23, 1);
    let worst = 0;
    for (let q = 0; q < N; q += 97) {
      if (!walk(q) || M.flags[q] & 32) continue; // terrain cells only (not decks)
      const [x, y] = M.cellCenter(q);
      worst = Math.max(worst, Math.abs(M.groundZ[q] / 100 - W.groundAt(x, y)));
    }
    expect(worst).toBeLessThan(0.02);
  });

  test("z picks the roof layer on buildings", () => {
    let checked = 0;
    const rExp = M.plane("rExp");
    for (let q = 0; q < N && checked < 50; q += 7) {
      if (!(M.flags[q] & FLAG_ROOF)) continue;
      const [x, y] = M.cellCenter(q);
      const rz = M.roofZ[q] / 100;
      expect(M.surfaceZ(x, y, rz)).toBeCloseTo(rz, 2);
      expect(M.exposureAt(x, y, rz)).toBeCloseTo(rExp[q] / 255, 6);
      checked++;
    }
    expect(checked).toBe(50);
  });

  test("cover mask and coverToward agree", () => {
    let q = 0;
    while (q < N && !(M.flags[q] & FLAG_COVER_G && walk(q))) q++;
    const [x, y] = M.cellCenter(q);
    const m = M.coverMask(x, y);
    expect(m).not.toBe(0);
    const k = Math.clz32(m) ^ 31; // highest set sector
    expect(M.coverToward(x, y, (k * Math.PI) / 4)).toBe(true);
    expect(M.isCoverAdjacent(x, y)).toBe(true);
  });

  test("points just inside a building edge fall back to the nearest standable cell", () => {
    // find a ground cell whose east neighbour has no ground layer, query 1 m into the neighbour
    for (let q = 0; q < N - 1; q++) {
      if (!walk(q) || M.flags[q + 1] & FLAG_GROUND || !(M.flags[q + 1] & FLAG_ROOF)) continue;
      const [x, y] = M.cellCenter(q);
      const v = M.exposureAt(x + M.cell / 2 + 1, y, M.groundZ[q] / 100);
      expect(v).toBeCloseTo(gExp[q] / 255, 6);
      return;
    }
    throw new Error("no building edge found");
  });
});

describe("precompute geometry (synthetic world)", () => {
  // flat terrain at z=0, a 20x20 m box 15 m tall at x,y in [0,20], a walk-under bridge, one big tree
  const nx = 201, ny = 201;
  const terrain = new Int16Array(nx * ny).buffer;
  const world = {
    bounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
    rules: { canopyDensity: 0.35, canopyBlockT: 0.25 },
    terrain: { minX: -100, minY: -100, step: 1, nx, ny, scale: 0.01 },
    prisms: [
      { kind: "building", base: -2, top: 15, ring: [0, 0, 20, 0, 20, 20, 0, 20], holes: [] },
      { kind: "bridge", base: 10, top: 11, ring: [-60, -10, -40, -10, -40, 10, -60, 10], holes: [] },
    ],
    trees: {
      fields: ["x", "y", "z", "height", "crownR", "crownBase", "trunkR", "osm", "crownX", "crownY"],
      data: [-20, 60, 0, 14, 4, 4, 0.4, 0, -20, 60],
    },
  };
  const S = new (W.constructor as any)(world, terrain) as typeof W;

  test("buildings block, rays over them do not, ends touching a wall do not self-occlude", () => {
    expect(S.los(-30, 10, 8, 50, 10, 4.5, true)).toBe(false); // straight through the box
    expect(S.los(-30, 10, 30, 50, 10, 25, true)).toBe(true); // above its 15 m roof
    expect(S.los(-30, 30, 8, 50, 30, 4.5, true)).toBe(true); // passes north of it
    expect(S.los(-30, 0, 8, 0, 0, 4.5, true)).toBe(true); // target exactly on a corner
  });

  test("columns: building -> roof only, walk-under bridge -> ground + deck", () => {
    const b = S.column(10, 10);
    expect(Number.isNaN(b.ground)).toBe(true);
    expect(b.roof).toBe(15);
    const br = S.column(-50, 0);
    expect(br.ground).toBe(0);
    expect(br.overhead).toBe(true);
    expect(br.roof).toBe(11);
    expect(S.column(-80, -80).ground).toBe(0);
  });

  test("canopy blocks long chords only beyond near range; trunks block far rays", () => {
    // crown: centre (-20, 60, 9), radius 4 horizontal, 5 vertical
    expect(S.los(-80, 60, 9, 40, 60, 9, false)).toBe(false); // 8 m of crown, far rules
    expect(S.los(-80, 60, 9, 40, 60, 9, true)).toBe(true); // proximity rules ignore trees
    expect(S.los(-80, 63.8, 9, 40, 63.8, 9, false)).toBe(true); // grazes the edge: ~2.5 m of crown (< 3.96 m blocking chord)
    expect(S.los(-80, 60, 2, 40, 60, 2, false)).toBe(false); // below the crown: trunk
  });
});

describe("vision model vs the recorded server stream", () => {
  test("ground heights match and sight transitions agree with LOS + 5 s memory", async () => {
    const { gunzipSync } = await import("zlib");
    const raw = new Uint8Array(await Bun.file(join(ROOT, "kit/check/stream.jsonl.gz")).arrayBuffer());
    const obs = new TextDecoder()
      .decode(gunzipSync(raw))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((o) => o.type === "obs");
    // per observation: is mech m listed, and does our model say it is visible right now?
    const seen = new Map<number, { t: number; listed: boolean; vis: boolean }[]>();
    let worstZ = 0;
    for (const o of obs) {
      const [x, y, z] = o.self.pos;
      if (o.self.grounded) worstZ = Math.max(worstZ, Math.abs(z - W.groundAt(x, y)));
      const ez = z + o.self.stats.eye_height;
      for (const id of new Set([...seen.keys(), ...o.mechs.filter((m: any) => m.kind === "mech").map((m: any) => m.id)])) {
        const m = o.mechs.find((mm: any) => mm.id === id);
        if (!seen.has(id)) seen.set(id, []);
        if (!m) {
          seen.get(id)!.push({ t: o.t, listed: false, vis: false });
          continue;
        }
        const [mx, my, mz] = m.pos;
        const near = Math.hypot(mx - x, my - y, mz + 4.5 - ez) <= 45;
        let dyaw = Math.atan2(my - y, mx - x) - o.self.aim[0];
        dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
        const inView = near || (Math.hypot(mx - x, my - y) <= 200 && Math.abs(dyaw) <= Math.PI / 3);
        const vis = inView && (W.los(x, y, ez, mx, my, mz + 4.5, near) || W.los(x, y, ez, mx, my, mz + 9, near));
        seen.get(id)!.push({ t: o.t, listed: true, vis });
      }
    }
    expect(worstZ).toBeLessThan(0.05);
    let checks = 0;
    for (const track of seen.values())
      for (let k = 1; k < track.length; k++) {
        const a = track[k - 1], b = track[k];
        // first listing after an absence: the server sees it now, so must we
        if (!a.listed && b.listed) {
          expect(b.vis).toBe(true);
          checks++;
        }
        // dropped from the list: our last visible frame must be ~memory_s (5 s) earlier
        if (a.listed && !b.listed) {
          let last = -1;
          for (let q = k - 1; q >= 0 && track[q].listed; q--)
            if (track[q].vis) {
              last = track[q].t;
              break;
            }
          expect(last).toBeGreaterThan(0);
          expect(b.t - last).toBeGreaterThan(4.6);
          expect(b.t - last).toBeLessThan(5.4);
          checks++;
        }
      }
    expect(checks).toBeGreaterThanOrEqual(3);
  });
});

describe("sanity: the map ranks hiding places sensibly", () => {
  // classify walkable ground cells
  const alley: number[] = [], open: number[] = [];
  for (let q = 0; q < N; q++) {
    if (!walk(q)) continue;
    const m = M.coverG[q];
    const opp = (m & 0x11) === 0x11 || (m & 0x22) === 0x22 || (m & 0x44) === 0x44 || (m & 0x88) === 0x88;
    if (opp) alley.push(gExp[q] / 255);
    else if (!m) open.push(gExp[q] / 255);
  }

  test("alleys (walls on opposite sides) are much less exposed than open ground", () => {
    expect(alley.length).toBeGreaterThan(100);
    expect(mean(alley)).toBeLessThan(0.4);
    expect(mean(open)).toBeGreaterThan(0.6);
    expect(mean(open) - mean(alley)).toBeGreaterThan(0.25);
  });

  test("enclosed courtyards are well hidden", async () => {
    const world = await Bun.file(join(ROOT, "kit/arena/v2/world.json")).json();
    const vals: number[] = [];
    for (const p of world.prisms as any[])
      for (const h of (p.holes ?? []) as number[][]) {
        let a = 0, cx = 0, cy = 0;
        for (let i = 0; i < h.length; i += 2) {
          const x0 = h[i], y0 = h[i + 1], x1 = h[(i + 2) % h.length], y1 = h[(i + 3) % h.length];
          const c = x0 * y1 - x1 * y0;
          a += c;
          cx += (x0 + x1) * c;
          cy += (y0 + y1) * c;
        }
        a /= 2;
        if (Math.abs(a) < 250) continue;
        const q = M.index(cx / (6 * a), cy / (6 * a));
        if (q >= 0 && M.flags[q] & FLAG_GROUND) vals.push(gExp[q] / 255);
      }
    expect(vals.length).toBeGreaterThan(0);
    expect(Math.max(...vals)).toBeLessThan(0.35);
  });

  test("open lots far from buildings and trees are highly exposed; tree cover lowers exposure", () => {
    const bare: number[] = [], wooded: number[] = [];
    for (let q = 0; q < N; q += 3) {
      if (!walk(q)) continue;
      const [x, y] = M.cellCenter(q);
      let nearB = false;
      for (let p = 0; p < W.np && !nearB; p++) {
        const B = W.pBox;
        const dx = Math.max(B[p * 4] - x, 0, x - B[p * 4 + 2]), dy = Math.max(B[p * 4 + 1] - y, 0, y - B[p * 4 + 3]);
        if (dx * dx + dy * dy < 3600) nearB = true;
      }
      if (nearB) continue;
      let n = 0;
      for (let t = 0; t < W.nt; t++) if (Math.hypot(W.cX[t] - x, W.cY[t] - y) < 25) n++;
      if (n === 0) bare.push(gExp[q] / 255);
      else if (n >= 6) wooded.push(gExp[q] / 255);
    }
    expect(bare.length).toBeGreaterThan(100);
    expect(wooded.length).toBeGreaterThan(100);
    expect(mean(bare)).toBeGreaterThan(0.75);
    expect(mean(bare) - mean(wooded)).toBeGreaterThan(0.08);
  });
});

describe("bestSpots", () => {
  test("returns sorted, spaced, in-circle, walkable spots away from avoid points", () => {
    const c: [number, number] = [40, -70], r = 240;
    const avoid: [number, number][] = [[60, -60], [-40, -120]];
    const spots = M.bestSpots(c, r, 12, { avoid, avoidRadius: 50, minSpacing: 20 });
    expect(spots.length).toBe(12);
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      expect(Math.hypot(s.x - c[0], s.y - c[1])).toBeLessThanOrEqual(r);
      for (const a of avoid) expect(Math.hypot(s.x - a[0], s.y - a[1])).toBeGreaterThanOrEqual(50);
      for (let j = 0; j < i; j++) expect(Math.hypot(s.x - spots[j].x, s.y - spots[j].y)).toBeGreaterThanOrEqual(20);
      if (i > 0) expect(s.score).toBeGreaterThanOrEqual(spots[i - 1].score);
      const q = M.index(s.x, s.y);
      expect(walk(q)).toBe(true);
      expect(M.flags[q] & FLAG_POCKET).toBe(0);
      expect(s.roof).toBe(false);
    }
    // the best spot is much better than the typical cell in the circle
    expect(spots[0].exposure).toBeLessThan(0.3);
  });

  test("roofs, penalty and empty circles", () => {
    const withRoofs = M.bestSpots([150, 50], 200, 30, { roofs: true, minSpacing: 4 });
    expect(withRoofs.some((s) => s.roof)).toBe(true);
    // a distance penalty pulls spots toward the centre
    const far = M.bestSpots([150, 50], 200, 5);
    const nearC = M.bestSpots([150, 50], 200, 5, { penalty: (x, y) => Math.hypot(x - 150, y - 50) / 50 });
    const md = (a: typeof far) => mean(a.map((s) => Math.hypot(s.x - 150, s.y - 50)));
    expect(md(nearC)).toBeLessThan(md(far));
    expect(M.bestSpots([9000, 9000], 50, 5)).toEqual([]);
  });

  test("is fast enough to call on zone updates (after warm())", () => {
    M.warm();
    const t: number[] = [];
    for (let i = 0; i < 31; i++) {
      const t0 = performance.now();
      M.bestSpots([40 + i, -70], 300, 8, { avoid: [[0, 0]] });
      t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    // best of 31: wall-clock medians on a shared machine are dominated by scheduler slices;
    // ~0.5 ms on an idle core
    expect(t[0]).toBeLessThan(5);
  });
});
