#!/usr/bin/env python3
"""Facts from the kit's recorded observation stream (kit/check/stream.jsonl.gz).

Standard library only. Prints a plain-text report; docs/stream-facts.md quotes it.

    python3 -I tools/stream_facts.py [--stream kit/check/stream.jsonl.gz] [--arena kit/arena]

Geometry here is a deliberately simple, independent model (prisms as extruded
polygons, bilinear terrain, trees as ellipsoid crowns + cylinder trunks) so it
can be used to cross-check the bot's own world code.
"""
import argparse
import gzip
import json
import math
import os
import statistics as st
import sys
from array import array
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAU = 2 * math.pi


def wrap(a):
    """Normalize an angle to (-pi, pi]."""
    a = math.fmod(a + math.pi, TAU)
    if a <= 0:
        a += TAU
    return a - math.pi


def deg(a):
    return a * 180 / math.pi


def pct(xs, q):
    xs = sorted(xs)
    if not xs:
        return float("nan")
    k = (len(xs) - 1) * q
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def fmt_dist(xs, unit="", nd=2):
    if not xs:
        return "n=0"
    return (f"n={len(xs)} min={min(xs):.{nd}f} p10={pct(xs, .1):.{nd}f} med={pct(xs, .5):.{nd}f} "
            f"p90={pct(xs, .9):.{nd}f} max={max(xs):.{nd}f}{unit}")


# ---------------------------------------------------------------- map ------

class Terrain:
    def __init__(self, world, path):
        t = world["terrain"]
        self.nx, self.ny = t["nx"], t["ny"]
        self.minx, self.miny, self.step = t["minX"], t["minY"], t["step"]
        self.scale = t.get("scale", 0.01)
        a = array("h")
        with open(path, "rb") as f:
            a.frombytes(f.read())
        if sys.byteorder != "little":
            a.byteswap()
        assert len(a) == self.nx * self.ny, (len(a), self.nx, self.ny)
        self.h = a

    def height(self, x, y):
        fx = (x - self.minx) / self.step
        fy = (y - self.miny) / self.step
        i = min(max(int(math.floor(fx)), 0), self.nx - 2)
        j = min(max(int(math.floor(fy)), 0), self.ny - 2)
        tx = min(max(fx - i, 0.0), 1.0)
        ty = min(max(fy - j, 0.0), 1.0)
        h, nx = self.h, self.nx
        k = j * nx + i
        h0 = h[k] * (1 - tx) + h[k + 1] * tx
        h1 = h[k + nx] * (1 - tx) + h[k + nx + 1] * tx
        return (h0 * (1 - ty) + h1 * ty) * self.scale


def pip(poly, x, y):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            if x < xj + (y - yj) * (xi - xj) / (yi - yj):
                inside = not inside
        j = i
    return inside


class Prism:
    __slots__ = ("idx", "kind", "base", "top", "ring", "holes", "bbox")

    def __init__(self, idx, p):
        self.idx = idx
        self.kind = p["kind"]
        self.base = p["base"]
        self.top = p["top"]
        r = p["ring"]
        self.ring = [(r[k], r[k + 1]) for k in range(0, len(r), 2)]
        self.holes = [[(h[k], h[k + 1]) for k in range(0, len(h), 2)] for h in p.get("holes", [])]
        xs = [q[0] for q in self.ring]
        ys = [q[1] for q in self.ring]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))

    def contains_xy(self, x, y):
        b = self.bbox
        if x < b[0] or x > b[2] or y < b[1] or y > b[3]:
            return False
        if not pip(self.ring, x, y):
            return False
        return not any(pip(h, x, y) for h in self.holes)

    def hits_segment(self, a, b):
        za, zb = a[2], b[2]
        if max(za, zb) < self.base or min(za, zb) > self.top:
            return False
        bx = self.bbox
        if max(a[0], b[0]) < bx[0] or min(a[0], b[0]) > bx[2] or max(a[1], b[1]) < bx[1] or min(a[1], b[1]) > bx[3]:
            return False
        dz = zb - za
        if abs(dz) < 1e-9:
            t0, t1 = 0.0, 1.0
        else:
            ta = (self.base - za) / dz
            tb = (self.top - za) / dz
            t0, t1 = max(0.0, min(ta, tb)), min(1.0, max(ta, tb))
        if t0 > t1:
            return False
        dx, dy = b[0] - a[0], b[1] - a[1]
        ts = [t0, t1]
        for poly in [self.ring] + self.holes:
            n = len(poly)
            for i in range(n):
                px, py = poly[i]
                qx, qy = poly[(i + 1) % n]
                ex, ey = qx - px, qy - py
                den = dx * ey - dy * ex
                if abs(den) < 1e-12:
                    continue
                wx, wy = px - a[0], py - a[1]
                t = (wx * ey - wy * ex) / den
                u = (wx * dy - wy * dx) / den
                if t0 < t < t1 and 0.0 <= u <= 1.0:
                    ts.append(t)
        ts.sort()
        if t1 - t0 < 1e-9:
            return self.contains_xy(a[0] + dx * t0, a[1] + dy * t0)
        for k in range(len(ts) - 1):
            if ts[k + 1] - ts[k] < 1e-9:
                continue
            tm = 0.5 * (ts[k] + ts[k + 1])
            if self.contains_xy(a[0] + dx * tm, a[1] + dy * tm):
                return True
        return False


class Tree:
    __slots__ = ("x", "y", "z", "h", "cr", "cb", "tr", "cx", "cy")


class World:
    CELL = 25.0

    def __init__(self, arena):
        with open(os.path.join(arena, "v2", "world.json")) as f:
            w = json.load(f)
        self.raw = w
        self.terrain = Terrain(w, os.path.join(arena, "v2", "terrain.i16"))
        self.prisms = [Prism(i, p) for i, p in enumerate(w["prisms"])]
        self.rules = w.get("rules", {})
        tf = w["trees"]["fields"]
        td = w["trees"]["data"]
        n = len(tf)
        ix = {k: tf.index(k) for k in tf}
        self.trees = []
        self.grid = defaultdict(list)
        for r in range(len(td) // n):
            row = td[r * n:(r + 1) * n]
            t = Tree()
            t.x, t.y, t.z = row[ix["x"]], row[ix["y"]], row[ix["z"]]
            t.h, t.cr, t.cb, t.tr = row[ix["height"]], row[ix["crownR"]], row[ix["crownBase"]], row[ix["trunkR"]]
            t.cx, t.cy = row[ix["crownX"]], row[ix["crownY"]]
            self.trees.append(t)
            x0 = min(t.cx - t.cr, t.x - t.tr)
            x1 = max(t.cx + t.cr, t.x + t.tr)
            y0 = min(t.cy - t.cr, t.y - t.tr)
            y1 = max(t.cy + t.cr, t.y + t.tr)
            for gi in range(int(math.floor(x0 / self.CELL)), int(math.floor(x1 / self.CELL)) + 1):
                for gj in range(int(math.floor(y0 / self.CELL)), int(math.floor(y1 / self.CELL)) + 1):
                    self.grid[(gi, gj)].append(len(self.trees) - 1)

    def prisms_at(self, x, y):
        return [p for p in self.prisms if p.contains_xy(x, y)]

    def prism_block(self, a, b):
        for p in self.prisms:
            if p.hits_segment(a, b):
                return p
        return None

    def terrain_block(self, a, b, step=1.0):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(2, int(L / step) + 1)
        for k in range(1, n):
            t = k / n
            x = a[0] + (b[0] - a[0]) * t
            y = a[1] + (b[1] - a[1]) * t
            z = a[2] + (b[2] - a[2]) * t
            if self.terrain.height(x, y) > z + 0.05:
                return True
        return False

    def trees_near(self, a, b):
        g = self.CELL
        x0, x1 = sorted((a[0], b[0]))
        y0, y1 = sorted((a[1], b[1]))
        seen = set()
        for gi in range(int(math.floor(x0 / g)), int(math.floor(x1 / g)) + 1):
            for gj in range(int(math.floor(y0 / g)), int(math.floor(y1 / g)) + 1):
                for k in self.grid.get((gi, gj), ()):
                    if k not in seen:
                        seen.add(k)
                        yield self.trees[k]

    def canopy(self, a, b):
        """Return (crown chord length in m, trunk_blocked) along segment a->b.
        Crown = vertical ellipsoid at (crownX, crownY) spanning z+crownBase..z+height
        (assumed relative to the tree's ground z), horizontal radius crownR.
        Trunk = cylinder radius trunkR at (x, y) from z to z+crownBase."""
        dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        seglen = math.sqrt(dx * dx + dy * dy + dz * dz)
        chord = 0.0
        trunk = False
        for t in self.trees_near(a, b):
            hz = 0.5 * (t.h - t.cb)
            if hz > 0 and t.cr > 0:
                cz = t.z + 0.5 * (t.cb + t.h)
                ax, ay, az = (a[0] - t.cx) / t.cr, (a[1] - t.cy) / t.cr, (a[2] - cz) / hz
                ux, uy, uz = dx / t.cr, dy / t.cr, dz / hz
                A = ux * ux + uy * uy + uz * uz
                B = 2 * (ax * ux + ay * uy + az * uz)
                C = ax * ax + ay * ay + az * az - 1
                disc = B * B - 4 * A * C
                if A > 0 and disc > 0:
                    sq = math.sqrt(disc)
                    t1 = max((-B - sq) / (2 * A), 0.0)
                    t2 = min((-B + sq) / (2 * A), 1.0)
                    if t2 > t1:
                        chord += (t2 - t1) * seglen
            if not trunk and t.tr > 0:
                # 2D segment vs circle, then z check
                fx, fy = a[0] - t.x, a[1] - t.y
                A = dx * dx + dy * dy
                if A > 1e-12:
                    B = 2 * (fx * dx + fy * dy)
                    C = fx * fx + fy * fy - t.tr * t.tr
                    disc = B * B - 4 * A * C
                    if disc > 0:
                        sq = math.sqrt(disc)
                        t1 = max((-B - sq) / (2 * A), 0.0)
                        t2 = min((-B + sq) / (2 * A), 1.0)
                        if t2 > t1:
                            z1 = a[2] + dz * t1
                            z2 = a[2] + dz * t2
                            if min(z1, z2) <= t.z + t.cb and max(z1, z2) >= t.z:
                                trunk = True
        return chord, trunk


# ------------------------------------------------------------- stream ------

def load_stream(path):
    with gzip.open(path, "rt") as f:
        lines = [json.loads(l) for l in f if l.strip()]
    hello = lines[0]
    obs = [x for x in lines[1:] if x.get("type") == "obs"]
    end = [x for x in lines[1:] if x.get("type") == "end"]
    return hello, obs, end[0] if end else None


def target_points(kind, pos, cubes, cfg):
    if kind == "mech":
        s = 1 + cfg["cubes"]["size_per_cube"] * (cubes or 0)
        h = cfg["mech"]["height"] * s
        return [(pos[0], pos[1], pos[2] + h / 2), (pos[0], pos[1], pos[2] + h)]
    if kind == "npc":
        h = cfg["npc"]["height"]
        return [(pos[0], pos[1], pos[2] + h / 2), (pos[0], pos[1], pos[2] + h)]
    if kind == "crate":
        h = cfg["crates"]["height"]
        return [(pos[0], pos[1], pos[2] + h / 2), (pos[0], pos[1], pos[2] + h)]
    # pickups, cubes: unknown object height; use the listed pos raised a little
    return [(pos[0], pos[1], pos[2] + 0.5), (pos[0], pos[1], pos[2] + 1.0)]


CANOPY_T = None  # crown-chord threshold in m, set in main() from world.json rules


def classify(world, cfg, s, kind, pos, cubes=0):
    """Geometric visibility of one object from self s (an obs.self dict).
    hard model: (near or wedge) and a target point with no prism/terrain in the way.
    soft model (geo_vis_soft): near -> hard LOS only (canopy ignored, as protocol §8 says);
    wedge -> also needs a hard-clear line with no trunk and crown chord < CANOPY_T."""
    st_ = s["stats"]
    eye = (s["pos"][0], s["pos"][1], s["pos"][2] + st_["eye_height"])
    dxy = math.hypot(pos[0] - eye[0], pos[1] - eye[1])
    pts = target_points(kind, pos, cubes, cfg)
    d3 = math.dist(eye, pts[0])
    near_r = cfg["vision"]["near_range"] + st_.get("near_range_bonus", 0)
    far_r = cfg["vision"]["range"] + st_.get("vision_bonus", 0)
    brg = math.atan2(pos[1] - eye[1], pos[0] - eye[0])
    dyaw = abs(wrap(brg - s["aim"][0]))
    half = math.radians(cfg["vision"]["fov_deg"]) / 2
    in_near = dxy <= near_r
    in_wedge = dxy <= far_r and dyaw <= half
    hard_ok = []
    canopy = []
    blocker = None
    for p in pts:
        pb = world.prism_block(eye, p)
        tb = world.terrain_block(eye, p)
        hard_ok.append(pb is None and not tb)
        if pb is not None and blocker is None:
            blocker = (pb.kind, pb.idx, pb.top)
        elif tb and blocker is None:
            blocker = ("terrain",)
        c, trunk = world.canopy(eye, p)
        canopy.append((c, trunk))
    los = any(hard_ok)
    # best soft line: among hard-clear lines, the one with least canopy
    soft = [canopy[i] for i in range(len(pts)) if hard_ok[i]]
    best_chord = min((c for c, tr in soft if not tr), default=None)
    any_trunkfree = any(not tr for c, tr in soft)
    soft_line = any(not tr and c < CANOPY_T for c, tr in soft)
    return {
        "dxy": dxy, "d3": d3, "dyaw": dyaw, "in_near": in_near, "in_wedge": in_wedge,
        "los": los, "blocker": blocker, "best_chord": best_chord, "trunk_free": any_trunkfree,
        "geo_vis": (in_near or in_wedge) and los,
        "geo_vis_soft": (in_near and los) or (in_wedge and soft_line),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stream", default=os.path.join(ROOT, "kit", "check", "stream.jsonl.gz"))
    ap.add_argument("--arena", default=os.path.join(ROOT, "kit", "arena"))
    args = ap.parse_args()

    hello, obs, end = load_stream(args.stream)
    cfg = hello["config"]
    world = World(args.arena)
    tick_hz = cfg["match"]["tick_hz"]
    global CANOPY_T
    dens = world.rules.get("canopyDensity", 0.35)
    blk = world.rules.get("canopyBlockT", 0.25)
    # hypothesis: transmittance exp(-density * chord) below canopyBlockT blocks sight
    CANOPY_T = math.log(1 / blk) / dens
    out = []

    def P(*a):
        out.append(" ".join(str(x) for x in a))

    # ------------------------------------------------------------ meta --
    P("== META")
    P(f"hello keys={sorted(hello)} slot={hello['slot']} map.dir={hello['map']['dir']!r} files={hello['map']['files']}")
    P(f"obs={len(obs)} ticks {obs[0]['tick']}..{obs[-1]['tick']}  t {obs[0]['t']}..{obs[-1]['t']}  end={end}")
    gaps = Counter(obs[i]["tick"] - obs[i - 1]["tick"] for i in range(1, len(obs)))
    P(f"tick step between consecutive obs: {dict(gaps)}")
    P("gaps (!=2):", [(obs[i - 1]["tick"], obs[i]["tick"]) for i in range(1, len(obs)) if obs[i]["tick"] - obs[i - 1]["tick"] != 2])
    P("t == tick/20 for all obs:", all(abs(o["t"] - o["tick"] / tick_hz) < 1e-9 for o in obs))
    okeys = Counter(k for o in obs for k in o)
    skeys = Counter(k for o in obs for k in o["self"])
    mkeys = Counter(tuple(sorted(m)) for o in obs for m in o["mechs"])
    P("obs keys:", dict(okeys))
    P("self keys:", sorted(skeys))
    P("mech entry key sets:", dict(mkeys))
    wkeys = Counter(tuple(sorted(w)) for o in obs for w in o["self"]["weapons"] if w)
    P("self.weapons entry key sets:", dict(wkeys))
    P("stats==config.mech for every obs:", all(all(o["self"]["stats"].get(k) == v for k, v in cfg["mech"].items()) for o in obs))
    alive = [(o["tick"], o["alive"]) for i, o in enumerate(obs) if i == 0 or o["alive"] != obs[i - 1]["alive"]]
    P("alive changes (tick, alive):", alive)
    zk = Counter(json.dumps(o["zone"], sort_keys=True) for o in obs)
    P("distinct zone dicts:", len(zk), "example:", obs[-1]["zone"])
    P("in_zone values:", Counter(o["self"]["in_zone"] for o in obs))
    P("offers seen:", sum(1 for o in obs if o["offer"]), " drops seen:", sum(1 for o in obs if o["drops"]))

    # --------------------------------------------------- visibility ------
    P("\n== VISIBILITY / MEMORY (mechs)")
    ids = sorted({(m["id"], m["kind"]) for o in obs for m in o["mechs"]})
    P("listed ids:", ids, " NPCs listed:", sum(1 for o in obs for m in o["mechs"] if m["kind"] == "npc"))
    rows = []
    for k, o in enumerate(obs):
        for m in o["mechs"]:
            c = classify(world, cfg, o["self"], m["kind"], m["pos"], m.get("cubes", 0))
            c.update(id=m["id"], tick=o["tick"], t=o["t"], k=k)
            rows.append(c)
    cnt = Counter()
    for r in rows:
        cls = "near" if r["in_near"] else ("wedge" if r["in_wedge"] else "outside")
        cnt[(cls, "LOS" if r["los"] else "blocked")] += 1
    P("listed mech entries by (geometry class, hard LOS):", dict(cnt))
    P("listed entries: dxy", fmt_dist([r["dxy"] for r in rows], " m", 1))
    P("listed entries: |yaw offset from self.aim|", fmt_dist([deg(r["dyaw"]) for r in rows], " deg", 1))
    soft = [r["best_chord"] for r in rows if r["geo_vis"] and r["best_chord"] is not None]
    P("geo-visible entries: canopy chord on best line", fmt_dist(soft, " m", 2),
      " trunk-blocked on all clear lines:", sum(1 for r in rows if r["geo_vis"] and not r["trunk_free"]))

    # memory: per id, track time since last geometrically visible listed frame
    by_id = defaultdict(dict)
    for r in rows:
        by_id[r["id"]][r["k"]] = r
    contiguous_after = {i for i in range(1, len(obs)) if obs[i]["tick"] - obs[i - 1]["tick"] == 2}
    P(f"canopy threshold used by the soft model: crown chord < {CANOPY_T:.2f} m "
      f"(= ln(1/canopyBlockT)/canopyDensity = ln(1/{blk})/{dens})")
    for model, key in (("HARD (prisms+terrain only)", "geo_vis"), ("SOFT (+canopy/trunks)", "geo_vis_soft")):
        P(f"-- model {model}")
        for mid, frames in by_id.items():
            last_vis = None
            runs = []
            cur = None
            ages_nonvis = []
            for k in range(len(obs)):
                r = frames.get(k)
                t = obs[k]["t"]
                if r is not None:
                    if cur is None:
                        cur = [k, k]
                        runs.append(cur)
                    cur[1] = k
                    if r[key]:
                        last_vis = t
                    else:
                        ages_nonvis.append(round(t - last_vis, 2) if last_vis is not None else None)
                else:
                    cur = None
            P(f"id {mid}: listed in {len(frames)} obs, {len(runs)} runs; not-visible listed frames "
              f"{sum(1 for r in frames.values() if not r[key])}")
            for a, b in runs:
                seg = [frames[k] for k in range(a, b + 1)]
                vis = [r for r in seg if r[key]]
                lv = vis[-1]["t"] if vis else None
                nxt = obs[b + 1] if b + 1 < len(obs) else None
                nxt_info = "end of stream" if nxt is None else (
                    f"next obs t={nxt['t']} {'contiguous, not listed' if (b + 1) in contiguous_after else 'after a STREAM GAP'}")
                P(f"  run t={obs[a]['t']}..{obs[b]['t']}: visible {len(vis)}/{len(seg)}; last visible t={lv}; "
                  f"listed until t={obs[b]['t']} (last_vis + {round(obs[b]['t'] - lv, 2) if lv is not None else None} s); "
                  f"{nxt_info}" + (f" -> dropped at last_vis + {round(nxt['t'] - lv, 2)} s" if nxt is not None and lv is not None else ""))
                stretch = []
                for r in seg:
                    if not r[key]:
                        why = []
                        if not (r["in_near"] or r["in_wedge"]):
                            why.append(f"outside FOV (dyaw={deg(r['dyaw']):.0f}deg, d={r['dxy']:.0f}m)")
                        if not r["los"]:
                            why.append(f"LOS blocked by {r['blocker']}")
                        elif key == "geo_vis_soft":
                            why.append(f"canopy chord {r['best_chord'] if r['best_chord'] is None else round(r['best_chord'], 1)} m"
                                       f"{'' if r['trunk_free'] else ' / trunk'}")
                        stretch.append((r["t"], "; ".join(why)))
                if stretch:
                    P(f"    not-visible listed frames: {len(stretch)}; first {stretch[0]}, last {stretch[-1]}")
            P(f"  ages (s since last visible) of listed-but-not-visible frames: "
              f"{fmt_dist([a for a in ages_nonvis if a is not None], ' s')}")

    # ---------------------------------------- static-object validation ---
    P("\n== VISION MODEL CHECK on static objects (crates / pickups / cubes)")
    # existence window = first..last obs index it was listed in
    objs = {}
    for k, o in enumerate(obs):
        for kind in ("crates", "pickups", "cubes"):
            for e in o[kind]:
                key = (kind, e["id"])
                if key not in objs:
                    objs[key] = {"pos": e["pos"], "first": k, "last": k, "kind": kind}
                objs[key]["last"] = k
    P("static objects seen:", Counter(v["kind"] for v in objs.values()),
      "(each checked on every obs between its first and last listing)")
    conf = {"geo_vis": Counter(), "geo_vis_soft": Counter()}
    misses = []
    chord_listed, chord_unlisted = [], []
    for key, v in objs.items():
        kind = {"crates": "crate", "pickups": "pickup", "cubes": "cube"}[v["kind"]]
        for k in range(v["first"], v["last"] + 1):
            o = obs[k]
            listed = any(e["id"] == key[1] for e in o[v["kind"]])
            c = classify(world, cfg, o["self"], kind, v["pos"])
            for mk in conf:
                conf[mk][("pred_vis" if c[mk] else "pred_hidden", "listed" if listed else "unlisted")] += 1
            if c["in_wedge"] and not c["in_near"] and c["los"] and c["best_chord"] is not None:
                (chord_listed if listed else chord_unlisted).append(c["best_chord"])
            if c["geo_vis_soft"] != listed:
                misses.append((v["kind"], key[1], o["tick"], listed, round(c["dxy"], 1), round(deg(c["dyaw"]), 1),
                               c["in_near"], c["in_wedge"], c["los"], c["blocker"],
                               None if c["best_chord"] is None else round(c["best_chord"], 2), c["trunk_free"]))
    for mk, cc in conf.items():
        tot = sum(cc.values())
        agree = cc[("pred_vis", "listed")] + cc[("pred_hidden", "unlisted")]
        P(f"  model {mk}: agreement {agree}/{tot}; {dict(cc)}")
    P(f"  wedge-only, hard-clear, trunk-free lines: crown chord when LISTED max {max(chord_listed):.2f} m (n={len(chord_listed)}); "
      f"when UNLISTED smallest {[round(c, 2) for c in sorted(chord_unlisted)[:3]]} m (n={len(chord_unlisted)})")
    P(f"  soft-model mismatches: {len(misses)} (kind,id,tick,listed,dxy,dyaw_deg,near,wedge,hardLOS,blocker,canopy_chord,trunk_free)")
    for m in misses[:20]:
        P("    ", m)
    for key, v in objs.items():
        x, y, z = v["pos"]
        th = world.terrain.height(x, y)
        if z - th > 1.0:
            P(f"  {v['kind'][:-1]} {key[1]} at z={z} is {z - th:.2f} m above terrain; prisms under it: "
              f"{[(p.kind, p.idx, p.base, p.top) for p in world.prisms_at(x, y)]}")
    # canopy threshold scan among wedge-only, hard-LOS, predicted-visible frames
    P("  canopy chord vs listing for wedge-only (not near) hard-LOS frames:")
    buckets = defaultdict(Counter)
    for key, v in objs.items():
        kind = {"crates": "crate", "pickups": "pickup", "cubes": "cube"}[v["kind"]]
        for k in range(v["first"], v["last"] + 1):
            o = obs[k]
            c = classify(world, cfg, o["self"], kind, v["pos"])
            if c["in_wedge"] and not c["in_near"] and c["los"]:
                listed = any(e["id"] == key[1] for e in o[v["kind"]])
                ch = c["best_chord"]
                b = "trunk" if ch is None else ("0" if ch == 0 else ("<2" if ch < 2 else ("<4" if ch < 4 else (
                    "<8" if ch < 8 else ">=8"))))
                buckets[b]["listed" if listed else "unlisted"] += 1
    for b in ["0", "<2", "<4", "<8", ">=8", "trunk"]:
        if b in buckets:
            P(f"    chord {b:>4} m: {dict(buckets[b])}")
    dmax = []
    for k, o in enumerate(obs):
        for kind_key, kind in (("crates", "crate"), ("pickups", "pickup"), ("cubes", "cube")):
            for e in o[kind_key]:
                c = classify(world, cfg, o["self"], kind, e["pos"])
                dmax.append((round(c["dxy"], 1), round(deg(c["dyaw"]), 1), c["in_near"]))
    P("  listed static objects: max dxy", max(d for d, _, _ in dmax), "m; max |dyaw| among non-near:",
      max((a for d, a, nr in dmax if not nr), default=None), "deg")

    # ---------------------------------------------------- self motion ----
    P("\n== SELF MOTION / ENERGY")
    walk, boost = cfg["mech"]["walk_speed"], cfg["mech"]["boost_speed"]
    hv_ground = []
    steady_walk, steady_boost = [], []
    accel = []
    vel_vs_dpos = []
    drain_ground, drain_air, regen = [], [], []
    regen_delay_ticks = []
    last_spend_tick = None
    prev = None
    for o in obs:
        s = o["self"]
        hv = math.hypot(s["vel"][0], s["vel"][1])
        if s["grounded"]:
            hv_ground.append(hv)
        if prev is not None and o["tick"] - prev["tick"] == 2:
            ps = prev["self"]
            dt = (o["tick"] - prev["tick"]) / tick_hz
            dpos = math.hypot(s["pos"][0] - ps["pos"][0], s["pos"][1] - ps["pos"][1]) / dt
            phv = math.hypot(ps["vel"][0], ps["vel"][1])
            dE = s["energy"] - ps["energy"]
            if s["grounded"] and ps["grounded"]:
                if abs(hv - walk) < 0.05 and abs(phv - walk) < 0.05:
                    steady_walk.append(dpos)
                if abs(hv - boost) < 0.05 and abs(phv - boost) < 0.05:
                    steady_boost.append(dpos)
                vel_vs_dpos.append(dpos - 0.5 * (hv + phv))
                accel.append(abs(hv - phv) / dt)
            if dE < -1e-6:
                (drain_ground if (s["grounded"] and ps["grounded"]) else drain_air).append(round(-dE / dt, 2))
                last_spend_tick = o["tick"]
            elif dE > 1e-6:
                regen.append(round(dE / dt, 2))
        prev = o
    # regen delay: for each regen onset (dE>0 after a flat stretch following a spend)
    onset = []
    k = 1
    while k < len(obs):
        o, p_ = obs[k], obs[k - 1]
        if o["tick"] - p_["tick"] == 2 and o["self"]["energy"] - p_["self"]["energy"] > 1e-6 and p_["self"]["energy"] < p_["self"]["max_energy"]:
            # walk back to the last spend
            j = k - 1
            ok = True
            while j > 0 and abs(obs[j]["self"]["energy"] - obs[j - 1]["self"]["energy"]) < 1e-9:
                if obs[j]["tick"] - obs[j - 1]["tick"] != 2:
                    ok = False
                    break
                j -= 1
            if ok and j > 0 and obs[j]["self"]["energy"] - obs[j - 1]["self"]["energy"] < 0 and obs[j]["tick"] - obs[j - 1]["tick"] == 2:
                first_regen_amt = o["self"]["energy"] - p_["self"]["energy"]
                onset.append((obs[j]["tick"], o["tick"], round(first_regen_amt, 2)))
        k += 1
    P(f"grounded |vel_xy| histogram (1 m/s bins): {dict(sorted(Counter(int(v) for v in hv_ground).items()))}")
    P(f"steady walk (|vel|={walk} both ends) speed from dpos: {fmt_dist(steady_walk, ' m/s')}")
    P(f"steady boost (|vel|={boost} both ends) speed from dpos: {fmt_dist(steady_boost, ' m/s')}")
    P(f"|vel_xy| max on ground: {max(hv_ground):.2f}")
    P(f"ground horizontal accel |d|v||/dt: {fmt_dist(accel, ' m/s^2', 1)}  (config ground_accel {cfg['mech']['ground_accel']})")
    P(f"dpos/dt - mean(|vel| at both obs): {fmt_dist(vel_vs_dpos, ' m/s')}")
    P(f"grounded vel[2] values: {dict(Counter(o['self']['vel'][2] for o in obs if o['self']['grounded']))}")
    gdz = []
    for i in range(1, len(obs)):
        a, b = obs[i - 1]["self"], obs[i]["self"]
        if a["grounded"] and b["grounded"] and obs[i]["tick"] - obs[i - 1]["tick"] == 2:
            gdz.append((b["pos"][2] - a["pos"][2]) * tick_hz / 2)
    P(f"grounded dz/dt from pos (slopes): {fmt_dist(gdz, ' m/s')}")
    P(f"energy drain rates (per s) on ground: {dict(Counter(drain_ground))}; in air: {dict(Counter(drain_air))}")
    P(f"energy regen rates (per s): {dict(Counter(regen))}")
    P(f"regen onsets (last spend tick, first regen obs tick, first increment): {onset}")
    P(f"   => ticks from last spend obs to first regen obs: {[b - a for a, b, _ in onset]}"
      f" (config energy_regen_delay {cfg['mech']['energy_regen_delay']} s = {cfg['mech']['energy_regen_delay'] * tick_hz:.0f} ticks)")

    # airborne segments
    P("airborne segments:")
    k = 0
    while k < len(obs):
        if not obs[k]["self"]["grounded"]:
            j = k
            while j + 1 < len(obs) and not obs[j + 1]["self"]["grounded"]:
                j += 1
            seg = obs[k:j + 1]
            pre = obs[k - 1] if k > 0 else None
            post = obs[j + 1] if j + 1 < len(obs) else None
            zs = [round(o["self"]["pos"][2], 2) for o in seg]
            vz = [o["self"]["vel"][2] for o in seg]
            es = [o["self"]["energy"] for o in seg]
            P(f"  ticks {seg[0]['tick']}..{seg[-1]['tick']} ({(seg[-1]['tick'] - seg[0]['tick']) / tick_hz:.1f} s): "
              f"z {pre['self']['pos'][2] if pre else None} -> peak {max(zs)} -> "
              f"{post['self']['pos'][2] if post else 'n/a'} (landed tick {post['tick'] if post else None}); "
              f"vel_z seq {vz[:4]}...{vz[-4:]}; energy {es[0]}->{es[-1]}")
            rising = [o for o in seg if o["self"]["vel"][2] > 8.8]
            if rising:
                P(f"    jet-rise vel_z values: {dict(Counter(o['self']['vel'][2] for o in rising))}; "
                  f"rise from z={rising[0]['self']['pos'][2]} to {rising[-1]['self']['pos'][2]} over "
                  f"{(rising[-1]['tick'] - rising[0]['tick']) / tick_hz:.1f} s; energy {rising[0]['self']['energy']}->{rising[-1]['self']['energy']}")
            ball = [seg[i]["self"]["vel"][2] - seg[i - 1]["self"]["vel"][2] for i in range(1, len(seg))
                    if seg[i]["self"]["vel"][2] < 8.8 and seg[i]["tick"] - seg[i - 1]["tick"] == 2]
            if ball:
                P(f"    ballistic d(vel_z)/dt: {dict(Counter(round(x * tick_hz / 2, 2) for x in ball))}")
            k = j + 1
        else:
            k += 1

    # ------------------------------------------------ other mech speeds ---
    P("\n== OTHER MECH MOTION (listed mechs)")
    for mid in sorted({m["id"] for o in obs for m in o["mechs"]}):
        seq = [(o["tick"], m) for o in obs for m in o["mechs"] if m["id"] == mid]
        hv = [math.hypot(m["vel"][0], m["vel"][1]) for _, m in seq]
        dp = []
        for i in range(1, len(seq)):
            (t0, a), (t1, b) = seq[i - 1], seq[i]
            if t1 - t0 == 2:
                dp.append(math.hypot(b["pos"][0] - a["pos"][0], b["pos"][1] - a["pos"][1]) * tick_hz / 2)
        P(f"id {mid}: |vel_xy| {fmt_dist(hv, ' m/s')}")
        P(f"        dpos/dt  {fmt_dist(dp, ' m/s')}")
        P(f"        |vel_xy| hist: {dict(sorted(Counter(int(v) for v in hv).items()))}")
        vz = Counter(m["vel"][2] for _, m in seq)
        P(f"        vel_z: 0 in {vz[0]} frames, 8.9 (jet rise) in {vz[8.9]}, other {sum(vz.values()) - vz[0] - vz[8.9]}")
        g = [m["pos"][2] - world.terrain.height(m["pos"][0], m["pos"][1]) for _, m in seq if m["vel"][2] == 0]
        P(f"        z - terrain when vel_z == 0: {fmt_dist(g, ' m', 3)}")
        P(f"        z range {min(m['pos'][2] for _, m in seq):.2f}..{max(m['pos'][2] for _, m in seq):.2f}; "
          f"hp values {sorted(set(m['hp'] for _, m in seq))}; weapons {Counter(tuple(m['weapons']) for _, m in seq)}; "
          f"charging frames {sum(1 for _, m in seq if m.get('charging'))}")
        hi = [(t, m["pos"]) for t, m in seq if m["pos"][2] - world.terrain.height(m["pos"][0], m["pos"][1]) > 1.0]
        if hi:
            P(f"        frames with z > terrain+1: {len(hi)}; e.g. tick {hi[0][0]} pos {hi[0][1]} terrain "
              f"{world.terrain.height(hi[0][1][0], hi[0][1][1]):.2f}; prisms there: "
              f"{[(p.kind, p.idx, p.base, p.top) for p in world.prisms_at(hi[0][1][0], hi[0][1][1])]}")
            mx = max(hi, key=lambda x: x[1][2])
            P(f"        highest: tick {mx[0]} pos {mx[1]} terrain {world.terrain.height(mx[1][0], mx[1][1]):.2f} prisms "
              f"{[(p.kind, p.idx, p.base, p.top) for p in world.prisms_at(mx[1][0], mx[1][1])]}")

    # ------------------------------------------------ grounded z vs terrain
    P("\n== GROUNDED self.pos.z vs TERRAIN")
    diffs = []
    above = []
    for o in obs:
        s = o["self"]
        if not s["grounded"]:
            continue
        x, y, z = s["pos"]
        th = world.terrain.height(x, y)
        diffs.append(z - th)
        if z - th > 0.5:
            above.append((o["tick"], s["pos"], round(th, 2), [(p.kind, p.idx, p.base, p.top) for p in world.prisms_at(x, y)]))
    P(f"z - terrain(x,y): {fmt_dist(diffs, ' m', 3)}")
    P(f"|diff| <= 0.05 m: {sum(1 for d in diffs if abs(d) <= 0.05)}/{len(diffs)}; <= 0.15 m: {sum(1 for d in diffs if abs(d) <= 0.15)}")
    P(f"grounded frames > 0.5 m above terrain: {len(above)}")
    for a in above[:6]:
        P("   ", a)
    # crates / pickups z vs terrain
    for kind_key in ("crates", "pickups", "cubes"):
        d = []
        roofs = 0
        for key, v in objs.items():
            if v["kind"] != kind_key:
                continue
            x, y, z = v["pos"]
            th = world.terrain.height(x, y)
            d.append(z - th)
            if z - th > 1:
                roofs += 1
        P(f"{kind_key} pos.z - terrain: {fmt_dist(d, ' m', 2)} (above terrain >1 m: {roofs})")

    # ---------------------------------------------------- projectiles -----
    P("\n== PROJECTILES")
    pj = defaultdict(list)
    for o in obs:
        for p in o["projectiles"]:
            pj[p["id"]].append((o["tick"], p))
    kinds = Counter(seq[0][1]["kind"] for seq in pj.values())
    P(f"distinct projectiles: {len(pj)} by kind {dict(kinds)}; listings {sum(len(v) for v in pj.values())}")
    sp = defaultdict(list)
    dsp = defaultdict(list)
    dvz = defaultdict(list)
    for pid, seq in pj.items():
        for i, (t, p) in enumerate(seq):
            sp[p["kind"]].append(math.sqrt(sum(c * c for c in p["vel"])))
            if i > 0 and t - seq[i - 1][0] == 2:
                a = seq[i - 1][1]
                dt = (t - seq[i - 1][0]) / tick_hz
                dsp[p["kind"]].append(math.dist(a["pos"], p["pos"]) / dt)
                dvz[p["kind"]].append((p["vel"][2] - a["vel"][2]) / dt)
    for kd in sp:
        P(f"  {kd}: |vel| {fmt_dist(sp[kd], ' m/s')}; |dpos|/dt {fmt_dist(dsp[kd], ' m/s')}; d(vel_z)/dt {fmt_dist(dvz[kd], ' m/s^2')}")
    life = [len(seq) for seq in pj.values()]
    P(f"  obs per projectile: {dict(Counter(life))}")
    # who shot: back-extrapolate toward listed mechs
    for pid, seq in list(pj.items())[:3]:
        t, p = seq[0]
        P(f"  e.g. id {pid} first tick {t} pos {p['pos']} vel {p['vel']}")

    # ---------------------------------------------------- events ----------
    P("\n== EVENTS")
    ev = Counter(e["type"] for o in obs for e in o["events"])
    P(f"event counts: {dict(ev)}")
    evkeys = defaultdict(Counter)
    for o in obs:
        for e in o["events"]:
            evkeys[e["type"]][tuple(sorted(e))] += 1
    for t_, c in evkeys.items():
        P(f"  {t_} key sets: {dict(c)}")
    examples = {}
    for o in obs:
        for e in o["events"]:
            examples.setdefault(e["type"], (o["tick"], e))
    for t_, (tk, e) in examples.items():
        P(f"  example {t_} @tick {tk}: {json.dumps(e)}")
    # damaged: bearing vs attacker pos, rear vs aim
    P("  damaged events vs attacker geometry (attacker listed in same obs):")
    dres = []
    for k, o in enumerate(obs):
        s = o["self"]
        for e in o["events"]:
            if e["type"] != "damaged" or e.get("by") is None:
                continue
            att = next((m for m in o["mechs"] if m["id"] == e["by"]), None)
            if att is None:
                P(f"    tick {o['tick']} by {e['by']} not listed")
                continue
            tb = math.atan2(att["pos"][1] - s["pos"][1], att["pos"][0] - s["pos"][0])
            rel = wrap(tb - s["aim"][0])
            res = wrap(e["bearing"] - tb)
            dres.append(deg(res))
            P(f"    tick {o['tick']} {e['weapon']} {e['amount']}: bearing {e['bearing']:.3f} true {tb:.3f} "
              f"(resid {deg(res):+.1f} deg); attacker rel. to self aim {deg(rel):+.0f} deg; rear flag {e.get('rear', False)}")
    P(f"  damaged bearing residuals: {fmt_dist(dres, ' deg', 1)}")
    P("  our hit events vs target facing (target listed):")
    for k, o in enumerate(obs):
        s = o["self"]
        for e in o["events"]:
            if e["type"] != "hit":
                continue
            tg = next((m for m in o["mechs"] if m["id"] == e["target"]), None)
            if tg is None:
                P(f"    tick {o['tick']} target {e['target']} not listed")
                continue
            fromdir = math.atan2(s["pos"][1] - tg["pos"][1], s["pos"][0] - tg["pos"][0])
            rel = wrap(fromdir - tg["aim"][0])
            P(f"    tick {o['tick']} {e['weapon']} amt {e['amount']} rear={e.get('rear', False)}: shooter is "
              f"{deg(rel):+.0f} deg off target's aim yaw; d={math.hypot(tg['pos'][0] - s['pos'][0], tg['pos'][1] - s['pos'][1]):.0f} m")

    # ---------------------------------------------------- sounds ----------
    P("\n== SOUNDS")
    snd = [(o, sd) for o in obs for sd in o["sounds"]]
    P(f"sound entries: {len(snd)}; by kind {dict(Counter(sd['kind'] for _, sd in snd))}")
    P(f"by (kind, dist): {dict(Counter((sd['kind'], sd['dist']) for _, sd in snd))}")
    P(f"age values: {dict(Counter(sd['age'] for _, sd in snd))}")
    P(f"sound key sets: {dict(Counter(tuple(sorted(sd)) for _, sd in snd))}")
    P(f"sounds per obs: {dict(Counter(len(o['sounds']) for o in obs))}")
    # bearing residuals vs listed mech 10-type sources
    res_by = defaultdict(list)
    band_check = Counter()
    near, mid = cfg["sound"]["near"], cfg["sound"]["mid"]
    for o, sd in snd:
        s = o["self"]
        cands = [m for m in o["mechs"] if m["kind"] == "mech"]
        if sd["kind"] == "laser":
            beam = next((b for b in o["beams"] if b["kind"] == "laser"), None)
            if beam is not None:
                src = beam["path"][0]
                tb = math.atan2(src[1] - s["pos"][1], src[0] - s["pos"][0])
                d = math.hypot(src[0] - s["pos"][0], src[1] - s["pos"][1])
                res_by["laser(beam origin)"].append(deg(wrap(sd["bearing"] - tb)))
                band_check[(sd["kind"], sd["dist"], "near" if d < near else "mid" if d < mid else "far")] += 1
                continue
        for m in cands:
            tb = math.atan2(m["pos"][1] - s["pos"][1], m["pos"][0] - s["pos"][0])
            d = math.hypot(m["pos"][0] - s["pos"][0], m["pos"][1] - s["pos"][1])
            band = "near" if d < near else "mid" if d < mid else "far"
            r = deg(wrap(sd["bearing"] - tb))
            if abs(r) < 40 and sd["dist"] == band:
                res_by[sd["kind"]].append(r)
                band_check[(sd["kind"], sd["dist"], band)] += 1
    allr = []
    for kd, rs in res_by.items():
        allr += rs
        P(f"  bearing residual vs listed source, {kd}: {fmt_dist(rs, ' deg', 1)}; rms {math.sqrt(sum(r * r for r in rs) / len(rs)):.1f}")
    if allr:
        P(f"  all matched residuals: n={len(allr)} mean {st.mean(allr):+.1f} sd {st.pstdev(allr):.1f} deg "
          f"(config bearing_noise_deg {cfg['sound']['bearing_noise_deg']})")
    P(f"  matched (kind, reported band, true band): {dict(band_check)}")
    unmatched = Counter((sd["kind"], sd["dist"]) for o, sd in snd if not any(
        m["kind"] == "mech" for m in o["mechs"]))
    P(f"  sounds while no mech listed: {dict(unmatched)}")

    # ---------------------------------------------------- beams -----------
    P("\n== BEAMS")
    bm = [(o, b) for o in obs for b in o["beams"]]
    P(f"beams: {len(bm)} {dict(Counter(b['kind'] for _, b in bm))}; key sets {dict(Counter(tuple(sorted(b)) for _, b in bm))}")
    for o, b in bm:
        a, c = b["path"][0], b["path"][-1]
        shooter = next((m for m in o["mechs"] if m["id"] == b["by"]), None)
        mz = (a[2] - shooter["pos"][2]) if shooter else None
        P(f"  tick {o['tick']} by {b['by']} len {math.dist(a, c):.1f} m; origin z - shooter z = "
          f"{'n/a' if mz is None else f'{mz:.2f}'}; dmg event this obs: "
          f"{[e['amount'] for e in o['events'] if e['type'] == 'damaged' and e.get('weapon') == 'laser']}")

    # charging telegraph -> beam timing
    P("  charging telegraph before each laser (listed frames of the shooter):")
    for o, b in bm:
        k = next(i for i, x in enumerate(obs) if x is o)
        j = k - 1
        while j >= 0 and obs[k]["tick"] - obs[j]["tick"] < 60:
            m = next((m for m in obs[j]["mechs"] if m["id"] == b["by"]), None)
            if m is None or not m.get("charging"):
                break
            j -= 1
        first = obs[j + 1]["tick"] if j + 1 < k else None
        lc = [(x["tick"], sd["dist"]) for x in obs[max(0, k - 20):k + 1] for sd in x["sounds"] if sd["kind"] == "laser_charge"]
        P(f"    beam at obs {o['tick']} (age {b['age']}): charging flag seen from obs {first} "
          f"({'n/a' if first is None else f'{(o['tick'] - first) / tick_hz:.2f} s before'}); laser_charge sounds in prior 1 s: {lc}")

    # ---------------------------------------------------- hp / regen -----
    P("\n== HP / REGEN")
    hp_steps = []
    for i in range(1, len(obs)):
        a, b = obs[i - 1], obs[i]
        d = b["self"]["hp"] - a["self"]["hp"]
        if d > 0:
            hp_steps.append((b["tick"], round(d, 2), b["tick"] - a["tick"]))
    P(f"HP increases (tick, +hp, dticks): {hp_steps}")
    last_dmg = None
    for o in obs:
        for e in o["events"]:
            if e["type"] in ("damaged", "hit"):
                last_dmg = (o["tick"], e["type"])
        if hp_steps and o["tick"] == hp_steps[0][0]:
            P(f"first regen at obs tick {o['tick']}; last damage event before it: {last_dmg}")
    P(f"max_hp values: {Counter(o['self']['max_hp'] for o in obs)}")

    # weapons / ammo
    P("\n== GUN STATE")
    ammo = [(o["tick"], o["self"]["weapons"][0].get("ammo"), o["self"]["weapons"][0].get("reload"), o["self"]["weapons"][0]["cooldown"])
            for o in obs if o["self"]["weapons"][0] and o["self"]["weapons"][0]["kind"] == "gun"]
    rl = [(t, a, r) for t, a, r, c in ammo if r and r > 0]
    P(f"reload>0 frames: {len(rl)}; first {rl[:3]} last {rl[-3:]}")
    cds = sorted(set(c for _, _, _, c in ammo))
    P(f"distinct gun cooldown values: {cds[:20]}")
    print("\n".join(out))


if __name__ == "__main__":
    main()
