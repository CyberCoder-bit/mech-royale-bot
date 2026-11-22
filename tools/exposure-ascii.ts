// Quick look at data/exposure.*: coarse ASCII map on stdout, optional PNGs.
//   bun tools/exposure-ascii.ts [--plane gExp|gNear|gExpGV|rExp|...] [--step 3] [--png runs/expo]
// ASCII legend: digits 0-9 = exposure decile of the ground layer (0 = hidden), '#' = roof only
// (building), '.' = no layer. North is up.
import { mkdirSync, writeFileSync } from "fs";
import { deflateSync } from "zlib";
import { ExposureMap } from "../src/expo/exposure.ts";

function arg(name: string): string | undefined {
  const k = process.argv.indexOf(name);
  return k >= 0 ? process.argv[k + 1] : undefined;
}

const dir = arg("--data");
const map = dir ? ExposureMap.load(dir) : ExposureMap.load();
const planeName = arg("--plane") ?? "gExp";
const step = Number(arg("--step") ?? 3);
const { nx, ny } = map;
const plane = map.plane(planeName);

const lines: string[] = [];
for (let j = ny - 1; j >= 0; j -= step) {
  let s = "";
  for (let i = 0; i < nx; i += step) {
    // worst (max) exposure in the block, so hidden spots must be hidden everywhere in the block
    let best = -1, roofOnly = false;
    for (let dj = 0; dj < step && j - dj >= 0; dj++)
      for (let di = 0; di < step && i + di < nx; di++) {
        const q = (j - dj) * nx + i + di;
        const f = map.flags[q];
        const layerOk = planeName.startsWith("r") ? f & 4 : f & 1;
        if (layerOk) best = Math.max(best, plane[q]);
        else if (f & 4) roofOnly = true;
      }
    s += best >= 0 ? String(Math.min(9, Math.floor(best / 25.6))) : roofOnly ? "#" : ".";
  }
  lines.push(s);
}
console.log(`${planeName}  x ${map.x0}..${map.x0 + nx * map.cell}  y ${map.y0}..${map.y0 + ny * map.cell}  (${step * map.cell} m/char, north up)`);
console.log(lines.join("\n"));

// ---------------- PNG ----------------
const pngDir = arg("--png");
if (pngDir) {
  mkdirSync(pngDir, { recursive: true });
  const S = 3;
  const crcT = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ramp = (v: number): [number, number, number] => {
    // 0 dark blue -> cyan -> yellow -> red
    const t = v / 255;
    const stops: [number, number, number, number][] = [
      [0, 20, 30, 120],
      [0.35, 40, 170, 200],
      [0.65, 240, 220, 60],
      [1, 210, 30, 30],
    ];
    for (let k = 1; k < stops.length; k++)
      if (t <= stops[k][0]) {
        const a = stops[k - 1], b = stops[k], u = (t - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
      }
    return [210, 30, 30];
  };
  for (const name of ["gExp", "gNear", "gExpGV", "rExp"]) {
    const pl = map.plane(name);
    const W = nx * S, H = ny * S;
    const raw = new Uint8Array(H * (1 + W * 3));
    for (let y = 0; y < H; y++) {
      const j = ny - 1 - Math.floor(y / S);
      raw[y * (1 + W * 3)] = 0;
      for (let x = 0; x < W; x++) {
        const i = Math.floor(x / S), q = j * nx + i, f = map.flags[q];
        const ok = name.startsWith("r") ? f & 4 : f & 1;
        let c: [number, number, number];
        if (ok) c = ramp(pl[q]);
        else if (f & 4) c = [90, 90, 90];
        else if (f & 1) c = [60, 60, 60];
        else c = [0, 0, 0];
        if (!name.startsWith("r") && ok && f & 8 && x % S === 1 && y % S === 1) c = [255, 255, 255]; // cover dot
        const o = y * (1 + W * 3) + 1 + x * 3;
        raw[o] = c[0];
        raw[o + 1] = c[1];
        raw[o + 2] = c[2];
      }
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, W);
    dv.setUint32(4, H);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
    const png = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      png.set(p, o);
      o += p.length;
    }
    writeFileSync(`${pngDir}/${name}.png`, png);
  }
  console.error(`PNGs in ${pngDir}/ (gExp, gNear, gExpGV, rExp; white dots = cover-adjacent)`);
}
