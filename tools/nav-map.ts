/**
 * Render the nav grid to a PNG (one pixel per cell) for eyeballing: green = free terrain,
 * blue shades = free roofs/decks by height, grey = band (too close to a wall), black = none,
 * red = an A* path. `bun tools/nav-map.ts [out.png] [x0 y0 x1 y1]`
 */
import { deflateSync } from "node:zlib"
import { writeFileSync, mkdirSync } from "node:fs"
import { World } from "../src/world/world.ts"
import { NavGrid, Pathfinder } from "../src/world/nav.ts"

const out = process.argv[2] ?? "runs/nav.png"
const [x0, y0, x1, y1] = (process.argv.slice(3, 7).length === 4 ? process.argv.slice(3, 7) : ["320", "-280", "-80", "-60"]).map(Number)
const w = World.load("kit/arena", ["v2/world.json", "v2/terrain.i16"])
const g = NavGrid.build(w)
const W = g.w, H = g.h
const img = new Uint8Array(W * H * 3)
for (let j = 0; j < H; j++)
  for (let i = 0; i < W; i++) {
    const c = j * W + i
    const row = H - 1 - j // north up
    const o = (row * W + i) * 3
    let r = 0, gg = 0, b = 0
    const top = g.st[2 * c + 1] === 1 ? 2 * c + 1 : 2 * c
    const s = g.st[top]
    if (s === 1 && !g.terr[top]) {
      const z = Math.max(0, Math.min(1, (g.hz[top] + 5) / 50))
      r = 40
      gg = 60 + z * 120
      b = 140 + z * 115
    } else if (s === 1) {
      const z = Math.max(0, Math.min(1, (g.hz[top] + 10) / 30))
      r = 30 + z * 60
      gg = 110 + z * 100
      b = 30
      if (g.pen[top] > 0) gg -= 30
    } else if (s === 2) r = gg = b = 110
    if (g.st[2 * c + 1] === 1 && g.st[2 * c] === 1) {
      r = 200
      gg = 160
      b = 40
    } // two layers: under-bridge
    img[o] = r
    img[o + 1] = gg
    img[o + 2] = b
  }
const pf = new Pathfinder(g)
const res = pf.findPath(x0, y0, w.surfaceZ(x0, y0), x1, y1, w.surfaceZ(x1, y1), { maxMs: 500 })
console.log("path", res.status, res.nodes.length, "cost", res.cost.toFixed(0), "climbs", res.kinds.filter((k) => k === 1).length, "drops", res.kinds.filter((k) => k === 2).length)
for (let q = 0; q < res.nodes.length; q++) {
  const c = res.nodes[q] >> 1
  const i = c % W, j = Math.floor(c / W)
  const o = ((H - 1 - j) * W + i) * 3
  img[o] = 255
  img[o + 1] = res.kinds[q] === 1 ? 255 : 0
  img[o + 2] = res.kinds[q] === 2 ? 255 : 0
}
// PNG encode
const raw = new Uint8Array((W * 3 + 1) * H)
for (let r = 0; r < H; r++) {
  raw[r * (W * 3 + 1)] = 0
  raw.set(img.subarray(r * W * 3, (r + 1) * W * 3), r * (W * 3 + 1) + 1)
}
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc = (buf: Uint8Array) => {
  let c = -1
  for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type: string, data: Uint8Array) => {
  const b = new Uint8Array(12 + data.length)
  const dv = new DataView(b.buffer)
  dv.setUint32(0, data.length)
  b.set(new TextEncoder().encode(type), 4)
  b.set(data, 8)
  dv.setUint32(8 + data.length, crc(b.subarray(4, 8 + data.length)))
  return b
}
const ihdr = new Uint8Array(13)
const dv = new DataView(ihdr.buffer)
dv.setUint32(0, W)
dv.setUint32(4, H)
ihdr[8] = 8
ihdr[9] = 2
const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))]
mkdirSync("runs", { recursive: true })
writeFileSync(out, Buffer.concat(parts))
console.log("wrote", out, W, "x", H)
