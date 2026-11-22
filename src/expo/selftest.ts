// Standalone check that the exposure data is found and loads where this file ends up (dev or
// bundled as /bot/bot.js next to /bot/data). Not part of the bot. Prints one JSON line.
//   bun src/expo/selftest.ts            bun build src/expo/selftest.ts --target=bun --outfile=X/bot.js && bun X/bot.js
import { expo, findDataDir, loadExposure } from "./exposure.ts";

const total = loadExposure();
const m = expo();
const spots = m ? m.bestSpots([40, -70], 240, 3) : [];
console.log(
  JSON.stringify({
    ok: m !== null,
    dir: findDataDir(),
    loadMs: m ? +m.loadMs.toFixed(2) : -1,
    warmMs: +(total - (m?.loadMs ?? 0)).toFixed(2),
    grid: m ? [m.nx, m.ny, m.cell] : null,
    sample: m ? +m.exposureAt(40, -70).toFixed(3) : null,
    spots: spots.map((s) => [s.x, s.y, +s.exposure.toFixed(3)]),
  }),
);
