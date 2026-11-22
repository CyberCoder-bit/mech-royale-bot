/**
 * Bot factory (v1, map-aware). Keep ALL mutable state inside the instance returned by makeBot
 * (the simulator runs many bots in one process). The static world/nav model is shared and immutable.
 *
 * Per tick: events -> tracker (own LOS) -> mode (fight / retreat / evade / heal / zone / loot / idle)
 * -> movement (nav paths, cover points, walkable strafing) -> aim + fire (gated on a clear shot line).
 */
import { draw, log, type Bot, type BotAction, type Hello, type Observation, type OfferChoice, type WeaponKind } from "./mechfight.ts"
import { aimAt, ballisticPitch, leadPointAir } from "./brain/aim.ts"
import { Tracker, type Track } from "./brain/tracker.ts"
import { findCover, findPeek, exposure, hiddenFrom } from "./brain/cover.ts"
import { walkableDir } from "./brain/steer.ts"
import { angDiff, clamp, dist2, dist3, rng, unit, yawTo, type V2, type V3 } from "./util/math.ts"
import { P as PRM, type Profile } from "./params.ts"
import { loadWorld, navFor, PathFollower, type NavGrid, type World } from "./world/index.ts"
import { makeBotV0 } from "./bot_v0.ts"
import { bestSpots, loadExposure } from "./expo/exposure.ts"

type Primary = "gun" | "laser" | "lightning" | "mortar"
type Mode = "fight" | "pursue" | "retreat" | "evade" | "heal" | "zone" | "loot" | "idle"

const LOUD = new Set(["gun", "laser", "laser_charge", "lightning", "mortar", "step", "boost", "jet", "reload"])

export function makeBot(hello: Hello, profile: Profile = PRM.profile, opts: { warm?: boolean } = {}): Bot {
  const cfg = hello.config
  const rand = rng(Number(hello.seed) || 1)
  const totalMechs = cfg.match?.mechs ?? 16
  const sizePerCube = Number((cfg.cubes as Record<string, unknown>).size_per_cube ?? 0.05)
  const reach = cfg.loot.pickup_radius ?? 4
  const lightningCfg = cfg.weapons.lightning
  const nearRange = cfg.vision?.near_range ?? 45

  // static map model (shared, immutable); the bot keeps working without it
  let world: World | null = null
  let nav: NavGrid | null = null
  let follow: PathFollower | null = null
  if (PRM.useWorld)
    try {
      world = loadWorld(hello.map.dir, hello.map.files)
      nav = navFor(world)
      follow = new PathFollower(nav)
    } catch (e) {
      log("world load failed", e)
      world = null
      nav = null
      follow = null
    }
  const fallback = makeBotV0(hello, profile)
  if (PRM.useWorld)
    try {
      loadExposure()
    } catch (e) {
      log("exposure load failed", e)
    }
  const tracker = new Tracker(sizePerCube)
  // JIT warm-up of the hot world paths (first calls otherwise cost 10-30 ms in a match)
  if (world && nav && follow)
    try {
      const w0 = performance.now()
      const wr = rng(12345)
      for (let i = 0; i < 6 && performance.now() - w0 < 400; i++) {
        const x = -300 + wr() * 600, y = -200 + wr() * 450
        const zg = world.groundZ(x, y)
        follow.pf.findPath(x, y, zg, x + 60 + wr() * 120, y - 80 + wr() * 160, zg, { maxMs: 30 })
        findCover(world, nav, { pos: [x, y, zg], eyes: [[x + 80, y + 20, zg + 8]], threatPos: [[x + 80, y + 20, zg]], maxDist: 40, budgetMs: 20 })
        for (let k = 0; k < 200; k++) world.sightClear([x, y, zg + 8], [x - 100 + wr() * 200, y - 100 + wr() * 200, zg + 4])
        walkableDir(nav, x, y, nav.hz[Math.max(0, nav.nodeAt(x, y, zg))] ?? zg, [1, 0])
      }
      follow.pf.cellPenalty.clear()
    } catch (e) {
      log("warm-up failed", e)
    }

  // ---- per-instance state
  let kills = 0
  let ffa = false
  let lastHurtT = -99
  let lastDealtT = -99
  let hurtBearing: number | null = null
  let jinkSign = rand() < 0.5 ? -1 : 1
  let jinkUntil = 0
  let scanPhase = rand() * Math.PI * 2
  let laserNoTargetSince = -1
  let mode: Mode = "idle"
  let modeT = 0
  let cover: { x: number; y: number; z: number; t: number; key: string } | null = null
  let lastLosPos: V3 | null = null
  let duckUntil = -1
  let duckWhy = ""
  let attention: { yaw: number; t: number } | null = null
  let errors = 0
  let lastPos: V3 | null = null
  let stuckT = 0
  let lastGroundZ = 0
  let lastTargetId = -1
  let hold: { x: number; y: number; z: number; t: number } | null = null
  let peek: { x: number; y: number; z: number; t: number; id: number } | null = null
  // remembered loot: weapon pickups and crates stay put until taken or destroyed
  const pickMem = new Map<number, { kind: WeaponKind; pos: V3; t: number }>()
  const crateMem = new Map<number, { pos: V3; t: number }>()
  // engagement memory: keep fighting (peek after reload, chase the wounded) instead of dropping to heal
  let engagedId = -1
  let engagedLosT = -99

  const pickUpgrade = (choices: OfferChoice[]) => {
    let best = 0, bestRank = 1e9
    choices.forEach((c, i) => {
      const r = PRM.upgradePref.indexOf(c.id)
      const rank = r < 0 ? 500 : r
      if (rank < bestRank) (bestRank = rank), (best = i)
    })
    return best
  }
  const norm2 = (v: V2): V2 => {
    const l = Math.hypot(v[0], v[1])
    return l > 1e-6 ? [v[0] / l, v[1] / l] : [0, 0]
  }

  function decide(obs: Observation): BotAction {
    const tick0 = performance.now()
    const t = obs.t
    const me = obs.self
    const P = me.pos as V3
    const st = me.stats ?? {}
    const size = 1 + sizePerCube * me.cubes
    const act: BotAction = {}
    const fire: [boolean, boolean] = [false, false]
    const hpFrac = me.hp / Math.max(1, me.max_hp)
    const eyeH = st.eye_height ?? 8 * size
    const muzH = st.muzzle_height ?? 7 * size
    const bodyH = 9 * size
    const muzzle: V3 = [P[0], P[1], P[2] + muzH]
    const tube: V3 = [P[0], P[1], P[2] + 9.5 * size]
    const myCenter: V3 = [P[0], P[1], P[2] + bodyH * 0.5]
    const myTop: V3 = [P[0], P[1], P[2] + bodyH * 0.92]
    const walk = st.walk_speed ?? 11.7
    const climbPerM = (st.jet_drain ?? 15) / Math.max(1, PRM.jetRiseSpeed)
    const dbg = PRM.debugDraw

    // ---------------- events
    for (const ev of obs.events ?? []) {
      if (ev.type === "damaged") {
        lastHurtT = t
        if (ev.weapon !== "zone" && ev.bearing !== null && ev.bearing !== undefined) hurtBearing = ev.bearing
      } else if (ev.type === "hit") lastDealtT = t
      else if (ev.type === "kill") kills++
    }
    if (!ffa && totalMechs - obs.alive > kills + PRM.ffaSlack) ffa = true
    if (obs.offer && obs.offer.choices?.length) act.pick = pickUpgrade(obs.offer.choices)
    for (const s of obs.sounds ?? []) {
      if (!LOUD.has(s.kind) || s.dist === "far") continue
      if (!attention || t - attention.t > 0.5 || s.dist === "near") attention = { yaw: s.bearing, t }
    }

    // ---------------- tracking (own LOS: the server also lists remembered, hidden mechs)
    tracker.update(obs, world, muzzle, myCenter, myTop)
    const enemies = tracker.enemies(t, 6)
    const known = tracker.enemies(t, PRM.threatMemory)
    const visible = enemies.filter((e) => e.los && !e.ghost)
    const npcsNow = tracker.npcs(t, 0.01)
    // loot memory: refresh what we see, forget what should be visible (near, clear line) but is gone
    {
      const eye: V3 = [P[0], P[1], P[2] + eyeH]
      const seenP = new Set<number>(), seenC = new Set<number>()
      for (const p of obs.pickups ?? []) {
        pickMem.set(p.id, { kind: p.kind, pos: [p.pos[0], p.pos[1], p.pos[2]], t })
        seenP.add(p.id)
      }
      for (const c of obs.crates ?? []) {
        crateMem.set(c.id, { pos: [c.pos[0], c.pos[1], c.pos[2]], t })
        seenC.add(c.id)
      }
      for (const ev of obs.events ?? []) if (ev.type === "took") pickMem.delete(ev.id)
      const gone = (pos: V3) => {
        const d = Math.hypot(pos[0] - P[0], pos[1] - P[1])
        return d < 38 && (!world || world.shotClear(eye, [pos[0], pos[1], pos[2] + 0.6]))
      }
      for (const [id, m] of pickMem) if (!seenP.has(id) && (t - m.t > 120 || gone(m.pos))) pickMem.delete(id)
      for (const [id, m] of crateMem) if (!seenC.has(id) && (t - m.t > 120 || gone(m.pos))) crateMem.delete(id)
    }

    // weapons
    const slotOf = (k: WeaponKind) => me.weapons.findIndex((w) => w?.kind === k)
    const gunS = slotOf("gun"), laserS = slotOf("laser"), lightS = slotOf("lightning"), mortarS = slotOf("mortar")
    const gunW = gunS >= 0 ? me.weapons[gunS]! : null
    const laserW = laserS >= 0 ? me.weapons[laserS]! : null
    const lightW = lightS >= 0 ? me.weapons[lightS]! : null
    const mortarW = mortarS >= 0 ? me.weapons[mortarS]! : null
    const laserCharge = laserW?.charge ?? 0

    // ---------------- zone
    const z = obs.zone
    const nc = z.next_center as V2, nr = z.next_radius
    const dNext = dist2(P, nc)
    const margin = nr < 1 ? 0 : Math.max(PRM.zoneMarginMin, Math.min(PRM.zoneMarginMax, nr * PRM.zoneMarginFrac))
    const needZone = nr < 1 ? dNext > 2 : dNext > nr - margin
    const outside = !me.in_zone
    const travelT = needZone ? (Math.max(0, dNext - (nr - margin)) * 1.35) / walk : 0
    const zoneUrgent = outside || (needZone && t > z.shrink_start - travelT - 10)
    const zoneGoal = (): V2 => {
      if (nr < 1) return [nc[0], nc[1]]
      const want = Math.max(0, nr - margin * 1.3)
      if (dNext <= want) return [P[0], P[1]]
      return [nc[0] + ((P[0] - nc[0]) / dNext) * want, nc[1] + ((P[1] - nc[1]) / dNext) * want]
    }
    const inSafe = (x: number, y: number, slack = 0) => nr < 1 || Math.hypot(x - nc[0], y - nc[1]) < nr - margin * 0.5 + slack

    // ---------------- target choice
    const centerOf = (e: Track): V3 => [e.pos[0], e.pos[1], e.pos[2] + (e.npc ? 1.75 : 4.5 * (1 + sizePerCube * e.cubes))]
    const hpF = (e: Track) => e.hp / Math.max(1, e.maxHp)
    let target: Track | null = null
    let tScore = Infinity
    for (const e of visible) {
      const d = dist3(P, e.pos)
      const recent = t - e.hurtUsT < 3 ? 0.8 : 0
      const laserThreat = e.charging && e.aimingAtUs ? 0.4 : 0
      const s = d / 100 + hpF(e) * 1.2 - recent - laserThreat - (e.id === lastTargetId ? 0.25 : 0)
      if (s < tScore) (tScore = s), (target = e)
    }
    const tgt = target as Track | null
    // FFA: only take fights with an edge (attacking us, weak, or too close to avoid)
    let engage = !!tgt && profile === "fighter"
    if (tgt && ffa) {
      const d = dist2(P, tgt.pos)
      const attacking = t - tgt.hurtUsT < 4 || (tgt.aimingAtUs && tgt.threatLos)
      engage = attacking || hpF(tgt) < PRM.ffaWeakHp || d < PRM.ffaCloseRange || hpFrac - hpF(tgt) > 0.35
    }
    if (tgt) lastTargetId = tgt.id
    // the most dangerous known enemy (for facing and cover)
    let threat: Track | null = tgt
    if (!threat) {
      let best = Infinity
      for (const e of enemies) {
        const d = dist2(P, e.pos) - (t - e.hurtUsT < 4 ? 80 : 0) - (e.threatLos ? 40 : 0)
        if (d < best) (best = d), (threat = e)
      }
    }
    const seenBy = enemies.filter((e) => e.threatLos)

    function rememberedCrate(): V3 | null {
      if (profile !== "fighter" || enemies.length) return null
      let best: V3 | null = null, bd = PRM.farmRange + 10
      for (const [, c] of crateMem) {
        const d = dist2(P, c.pos)
        if (d < bd && inSafe(c.pos[0], c.pos[1], 10) && Math.abs(c.pos[2] - P[2]) < 30) (bd = d), (best = c.pos)
      }
      return best
    }
    function farmTarget(): { pos: V3; aim: V3; npc: boolean } | null {
      if (profile !== "fighter") return null
      let best = Infinity
      let f: { pos: V3; aim: V3; npc: boolean } | null = null
      if (hpFrac > PRM.farmNpcHp && !enemies.length)
        for (const n of npcsNow) {
          const d = dist3(P, n.pos)
          if (d < PRM.farmRange && d < best && n.los) (best = d), (f = { pos: n.pos as V3, aim: [n.pos[0], n.pos[1], n.pos[2] + 1.75], npc: true })
        }
      for (const c of obs.crates ?? []) {
        const d = dist3(P, c.pos)
        const aim: V3 = [c.pos[0], c.pos[1], c.pos[2] + 1.2]
        if (d < PRM.farmRange && d + 20 < best && (!world || world.shotClear(muzzle, aim))) (best = d + 20), (f = { pos: [c.pos[0], c.pos[1], c.pos[2]], aim, npc: false })
      }
      return f
    }

    // supply drop worth taking: landed (or about to), uncontested, near, inside the safe circle, nobody in view
    let dropGoal: V3 | null = null
    if (profile === "fighter" && !visible.length && !seenBy.length)
      for (const d of obs.drops ?? []) {
        const dd = dist2(P, d.pos)
        if (d.lands_in > dd / walk + 3 || dd > PRM.dropRange || !inSafe(d.pos[0], d.pos[1], 10)) continue
        if (d.holder !== null && d.holder !== me.id) continue
        if (!dropGoal || dd < dist2(P, dropGoal)) dropGoal = [d.pos[0], d.pos[1], d.pos[2]]
      }

    // ---------------- mode
    const prevMode = mode
    const lowHp = hpFrac < PRM.v1RetreatHp
    // crossfire: several enemies with a line on us -> break line of sight first, fight them one at a time
    const crossfire = seenBy.filter((e) => (e.ghost ? t - e.hurtUsT < 2 : dist2(P, e.pos) < 170)).length >= PRM.crossfireN
    if (tgt && engage) {
      engagedId = tgt.id
      engagedLosT = t
    }
    const eng = engagedId >= 0 ? tracker.tracks.get(engagedId) ?? null : null
    const engLive = !!eng && !eng.ghost && t - eng.seenT < 5.5
    const engWeak = !!eng && hpF(eng) < PRM.pursueHp
    if (tgt && engage) {
      const tWeak = hpF(tgt) < hpFrac - PRM.retreatMargin
      mode = lowHp && !tWeak ? "retreat" : "fight"
    } else if (engLive && !lowHp && t - engagedLosT < PRM.peekS && !crossfire) mode = "fight"
    else if (eng && engWeak && hpFrac > PRM.pursueMinHp && t - eng.seenT < PRM.pursueS && profile === "fighter" && (!ffa || hpFrac > 0.6)) mode = "pursue"
    else if (seenBy.length && (ffa || lowHp)) mode = "evade"
    else if (hpFrac < PRM.healHp || (prevMode === "heal" && hpFrac < PRM.healDoneHp)) mode = "heal"
    else if (needZone) mode = "zone"
    else mode = "loot"
    if (mode !== prevMode) modeT = t

    // threat eyes for cover queries: enemies seen recently (memory gives live positions for 5 s)
    const threatEyes = (maxAge: number, only?: Track): V3[] => {
      const list = only ? [only] : known.filter((e) => t - e.seenT <= maxAge)
      return list.map((e) => {
        const p = tracker.predict(e, t, 1)
        return [p[0], p[1], p[2] + (e.npc ? 3 : 8 * (1 + sizePerCube * e.cubes))] as V3
      })
    }
    const refreshCover = (eyes: V3[], tps: V3[], maxDist: number, key: string, every = 0.7) => {
      if (!world || !nav || !eyes.length) {
        cover = null
        return
      }
      if (cover && cover.key === key && t - cover.t < every) return
      // keep the current point while it still hides us from every threat (stable ducking)
      if (cover && cover.key === key && t - cover.t < 6 && Math.hypot(cover.x - P[0], cover.y - P[1]) < maxDist && inSafe(cover.x, cover.y, 5) && hiddenFrom(world, cover.x, cover.y, cover.z, eyes, bodyH)) {
        cover.t = t - every * 0.5
        return
      }
      const c = findCover(world, nav, {
        pos: P, eyes, threatPos: tps, maxDist, zoneC: nc, zoneR: nr < 1 ? 0 : Math.max(nr - margin * 0.5, 8),
        bodyH, budgetMs: clamp(PRM.tickBudgetMs - 3 - (performance.now() - tick0), 0.3, 2.5), maxDz: 3, wiggle: 0,
      })
      cover = c ? { x: c.x, y: c.y, z: c.z, t, key } : null
      if (!c) cover = null
    }

    // ---------------- movement
    let move: V2 = [0, 0]
    let boost = false
    let jump = false
    let goalLabel = ""
    let dbgNote = ""
    if (t > jinkUntil) {
      jinkSign = -jinkSign
      jinkUntil = t + PRM.fightJinkMin + rand() * PRM.fightJinkRand
    }
    const goTo = (x: number, y: number, zz: number, tol = 2.5, climbCap = 50): boolean => {
      if (!follow) {
        const d = Math.hypot(x - P[0], y - P[1])
        move = d > tol ? norm2([x - P[0], y - P[1]]) : [0, 0]
        return d <= tol
      }
      follow.allowHop = mode !== "fight" && mode !== "retreat" && mode !== "evade"
      follow.setGoal(x, y, zz, tol, 6, climbCap)
      follow.planMs = clamp(PRM.tickBudgetMs - (performance.now() - tick0), 1, 6)
      const o = follow.update({ t, pos: P, vel: me.vel, grounded: me.grounded, energy: me.energy, climbEnergyPerM: climbPerM })
      move = o.move
      jump = o.jump
      boost = o.boost
      goalLabel = o.state
      if (dbg && o.steer) draw.line([P[0], P[1], P[2] + 1], [o.steer[0], o.steer[1], o.steer[2] + 1], "#40c0ff")
      return o.arrived
    }
    const steer = (d: V2, look = 6): V2 => walkableDir(nav, P[0], P[1], P[2], d, look)
    /** Wait at a low-exposure spot near us (inside the safe circle, away from known enemies): silent and hard to find. */
    const holdSpot = () => {
      const valid = hold && inSafe(hold.x, hold.y) && t - hold.t < PRM.holdRefresh && !known.some((e) => dist2(e.pos, [hold!.x, hold!.y]) < 40)
      if (!valid) {
        hold = null
        try {
          const spots = bestSpots([P[0], P[1]], PRM.holdRadius, 3, {
            avoid: known.map((e) => e.pos), avoidRadius: 50, minSpacing: 8,
            penalty: (x, y) => Math.hypot(x - P[0], y - P[1]) * PRM.holdDistCost + (inSafe(x, y) ? 0 : 1),
          })
          if (spots.length && inSafe(spots[0].x, spots[0].y)) hold = { x: spots[0].x, y: spots[0].y, z: spots[0].z, t }
        } catch {
          hold = null
        }
      }
      if (hold && Math.hypot(hold.x - P[0], hold.y - P[1]) > 2) {
        goTo(hold.x, hold.y, hold.z, 2, 3)
        goalLabel = "hold"
      } else {
        move = [0, 0]
        follow?.clear()
      }
    }
    const zoneMove = () => {
      const g = zoneGoal()
      goTo(g[0], g[1], world ? world.groundZ(g[0], g[1]) : P[2], 6)
      if (!boost && (outside || dNext - nr > 100) && me.energy > (outside ? 25 : 70)) boost = true
    }

    const ft = mode === "fight" ? tgt ?? eng : null
    if (mode === "fight" && ft) {
      const d = dist2(P, ft.pos)
      const ty = yawTo(P, ft.pos)
      const toT = unit(ty)
      if (tgt && tgt.los) lastLosPos = [P[0], P[1], P[2]]
      // cover from the target (and other recent threats) near us
      refreshCover(threatEyes(4), known.filter((e) => t - e.seenT < 4).map((e) => e.pos as V3), PRM.coverSearch, "fight" + ft.id)
      const coverD = cover ? Math.hypot(cover.x - P[0], cover.y - P[1]) : Infinity
      // duck: an enemy laser charging at us, or nothing to shoot with for a while
      const laserThreat = visible.some((e) => e.charging && e.aimingAtUs && e.threatLos)
      const gunOut = !gunW || (gunW.reload ?? 0) > PRM.duckReloadS || (gunW.ammo ?? 1) <= 0
      const laserOut = !laserW || (laserW.cooldown > PRM.duckReloadS && laserCharge <= 0)
      const lightOk = !!lightW && d < (lightW.stats.range ?? 45) * 0.9 && me.energy > 10
      const finishing = hpF(ft) < 0.15 && d < 120
      if (laserThreat && coverD < PRM.duckLaserDist) (duckUntil = Math.max(duckUntil, t + 0.6)), (duckWhy = "L")
      else if (crossfire && !finishing && coverD < PRM.coverSearch) (duckUntil = Math.max(duckUntil, t + 0.4)), (duckWhy = "X")
      else if (gunOut && laserOut && !lightOk && coverD < PRM.coverLeash + 4) (duckUntil = Math.max(duckUntil, t + 0.3)), (duckWhy = "R")
      dbgNote = `c${Number.isFinite(coverD) ? Math.round(coverD) : "-"}${t < duckUntil ? duckWhy : ""} s${seenBy.length}`
      if (t < duckUntil && cover && !zoneUrgent) {
        goTo(cover.x, cover.y, cover.z, 1.5, 2)
        goalLabel = "duck"
      } else if (zoneUrgent) {
        zoneMove()
      } else if (!tgt) {
        // line of sight lost: step to the nearest spot with a clear shot at its live position
        if (world && nav && (!peek || t - peek.t > 0.5 || peek.id !== ft.id)) {
          const tc: V3 = [ft.pos[0], ft.pos[1], ft.pos[2] + ft.aimDz]
          const pk = findPeek(world, nav, P, tc, muzH, PRM.peekSearch, clamp(PRM.tickBudgetMs - 4 - (performance.now() - tick0), 0.3, 1.5), nc, nr < 1 ? 0 : Math.max(nr - margin * 0.5, 8))
          peek = pk ? { x: pk.x, y: pk.y, z: pk.z, t, id: ft.id } : { x: NaN, y: NaN, z: NaN, t, id: ft.id }
        }
        if (peek && Number.isFinite(peek.x)) goTo(peek.x, peek.y, peek.z, 1.2, 2)
        else if (lastLosPos && Math.hypot(lastLosPos[0] - P[0], lastLosPos[1] - P[1]) > 2.5) goTo(lastLosPos[0], lastLosPos[1], lastLosPos[2], 2, 2)
        else {
          const perp: V2 = [-toT[1] * jinkSign, toT[0] * jinkSign]
          move = steer(norm2([toT[0] * 0.6 + perp[0], toT[1] * 0.6 + perp[1]]), 5)
        }
        goalLabel = "peek"
      } else {
        const band = PRM.v1Band
        const primary: Primary = lightW && d < (lightW.stats.range ?? 45) ? "lightning" : laserW ? "laser" : mortarW ? "mortar" : "gun"
        let [lo, hi] = primary === "lightning" ? band.lightning : primary === "laser" ? band.laser : primary === "mortar" ? band.mortar : lightW ? band.gunWithLightning : band.gun
        if (hpF(ft) < PRM.pursueHp) hi = Math.min(hi, lo + 25) // press a wounded target
        const radial = d > hi ? clamp((d - hi) / 30, 0, 1) * 0.8 : d < lo ? -clamp((lo - d) / 20, 0, 1) : 0
        const perp: V2 = [-toT[1] * jinkSign, toT[0] * jinkSign]
        let mv: V2 = [toT[0] * radial + perp[0], toT[1] * radial + perp[1]]
        // stay near cover so ducking is quick
        if (cover && coverD > PRM.coverLeash) {
          const toC = norm2([cover.x - P[0], cover.y - P[1]])
          mv = [mv[0] * 0.5 + toC[0] * 1.2, mv[1] * 0.5 + toC[1] * 1.2]
        }
        if (!inSafe(P[0], P[1])) {
          const toZ = norm2([nc[0] - P[0], nc[1] - P[1]])
          mv = [mv[0] + toZ[0] * 1.2, mv[1] + toZ[1] * 1.2]
        }
        move = steer(norm2(mv), 5)
        // charging a laser halves speed: no need to boost; otherwise boost only to dodge a laser
        boost = laserThreat && me.energy > 35 && laserCharge <= 0
        goalLabel = "strafe"
      }
    } else if (mode === "pursue" && eng) {
      const p = tracker.predict(eng, t, 3)
      goTo(p[0], p[1], p[2], 12, 12)
      goalLabel = "chase"
      if (me.energy > 50 && dist2(P, p) > 60) boost = true
    } else if (mode === "retreat" || mode === "evade") {
      const thr = enemies.length ? enemies : known
      refreshCover(threatEyes(6), thr.map((e) => e.pos as V3), PRM.retreatSearch, "retreat", 0.5)
      if (zoneUrgent && (!cover || !inSafe(cover.x, cover.y))) zoneMove()
      else if (cover) {
        goTo(cover.x, cover.y, cover.z, 1.5, 2)
        if (me.energy > 30 && Math.hypot(cover.x - P[0], cover.y - P[1]) > 8) boost = true
      } else if (threat) {
        // no cover nearby: open distance, sideways to the shooter
        const away = unit(yawTo(threat.pos, P))
        const perp: V2 = [-away[1] * jinkSign, away[0] * jinkSign]
        move = steer(norm2([away[0] + perp[0] * 0.8, away[1] + perp[1] * 0.8]))
        boost = me.energy > 30
      }
    } else if (mode === "heal") {
      // hide from everything we know about and wait; regen needs 5 s without dealing or taking damage
      const eyes = threatEyes(PRM.threatMemory)
      const exposed = world && eyes.length ? exposure(world, P[0], P[1], P[2], eyes, bodyH) > 0 : false
      if (zoneUrgent) zoneMove()
      else if (exposed) {
        refreshCover(eyes, known.map((e) => e.pos as V3), PRM.retreatSearch, "heal", 1.0)
        if (cover) goTo(cover.x, cover.y, cover.z, 1.5, 2)
      } else if (cover && cover.key === "heal" && Math.hypot(cover.x - P[0], cover.y - P[1]) > 1.5 && t - cover.t < 8) {
        goTo(cover.x, cover.y, cover.z, 1.5, 2)
      } else if (dropGoal && !known.length) {
        goTo(dropGoal[0], dropGoal[1], dropGoal[2], 2.5)
        goalLabel = "drop"
      } else if (needZone && !known.length) zoneMove()
      else if (!known.length) holdSpot()
      else {
        move = [0, 0]
        follow?.clear()
      }
    } else if (mode === "zone" && dropGoal && !zoneUrgent) {
      goTo(dropGoal[0], dropGoal[1], dropGoal[2], 2.5)
      goalLabel = "drop"
    } else if (mode === "zone") {
      zoneMove()
    } else {
      // loot / farm / idle
      let goal: V3 | null = null
      let tol = 1.5
      if (profile === "fighter") {
        let best = PRM.lootCubeRange
        for (const c of obs.cubes ?? []) {
          const d = dist2(P, c.pos)
          if (d < best && inSafe(c.pos[0], c.pos[1], 20) && Math.abs(c.pos[2] - P[2]) < 25) (best = d), (goal = [c.pos[0], c.pos[1], c.pos[2]])
        }
        const cur = me.weapons[1]?.kind
        const wantWeapon = !cur || PRM.weaponPref.indexOf(cur) > 0
        if (wantWeapon) {
          // remembered pickups: prefer better kinds, nearer, reachable inside the safe circle
          const range = t < PRM.lootEarlyT ? PRM.lootWeaponRangeEarly : PRM.lootWeaponRange
          let bestW = Infinity
          for (const [, p] of pickMem) {
            if (p.kind === "gun" || slotOf(p.kind) >= 0) continue
            if (cur && PRM.weaponPref.indexOf(p.kind) >= PRM.weaponPref.indexOf(cur)) continue
            const d = dist2(P, p.pos)
            if (d > range || !inSafe(p.pos[0], p.pos[1], 20) || Math.abs(p.pos[2] - P[2]) > 45) continue
            const score = d * (1 + 0.35 * PRM.weaponPref.indexOf(p.kind)) * (cur ? 1.5 : 1) + Math.max(0, p.pos[2] - P[2]) * 1.5
            if (score < bestW) (bestW = score), (goal = [p.pos[0], p.pos[1], p.pos[2]]), (tol = 1.2)
          }
        }
      }
      if (dropGoal && !zoneUrgent) {
        goTo(dropGoal[0], dropGoal[1], dropGoal[2], 2.5)
        goalLabel = "drop"
      } else if (goal) goTo(goal[0], goal[1], goal[2], tol)
      else if (farmTarget()) {
        // approach to a comfortable shooting distance, then stand and shoot
        const f = farmTarget()!
        const d = dist2(P, f.pos)
        const want = f.npc ? 32 : 14
        if (d > want + 6) goTo(f.pos[0], f.pos[1], f.pos[2], want)
        else move = [0, 0]
      } else if (rememberedCrate()) {
        const c = rememberedCrate()!
        goTo(c[0], c[1], c[2], 12)
        goalLabel = "crate"
      } else if (needZone) zoneMove()
      else holdSpot()
    }

    // generic stuck nudge when not following a path (strafing into something)
    if (lastPos && Math.hypot(move[0], move[1]) > 0.5 && Math.hypot(me.vel[0], me.vel[1]) < 1 && me.grounded) stuckT += 0.1
    else stuckT = 0
    if (stuckT > 1.0 && !jump) {
      jump = true
      stuckT = 0
    }
    if (me.grounded) lastGroundZ = P[2]
    else if (goalLabel === "strafe" && me.vel[2] > 0 && P[2] < lastGroundZ + 3.5 && me.energy > 20) boost = true // clear a low obstacle
    lastPos = [P[0], P[1], P[2]]

    // ---------------- aim and fire
    let desired: [number, number] | null = null
    let primary: Primary = "gun"
    let tDist = Infinity
    const shootAt: Track | null = tgt && (engage || t - tgt.hurtUsT < 3 || mode === "retreat") ? tgt : null
    if (shootAt) {
      const c: V3 = [shootAt.pos[0], shootAt.pos[1], shootAt.pos[2] + shootAt.aimDz]
      const v = shootAt.vel as V3
      tDist = dist3(muzzle, c)
      const lightRange = (lightW?.stats.range ?? lightningCfg.range ?? 45) * 0.95
      const laserRange = (laserW?.stats.range ?? 280) * 0.97
      const lightReady = !!lightW && me.energy >= (lightW.stats.energy ?? 3) + 6
      const laserCharging = !!laserW && laserCharge > 0
      const laserReady = !!laserW && (laserCharging || laserW.cooldown < 0.35)
      if (lightReady && tDist < lightRange) primary = "lightning"
      else if (laserReady && tDist < laserRange) primary = "laser"
      else if (mortarW && mortarW.cooldown < 0.2 && tDist > 25 && tDist < 225) primary = "mortar"
      else primary = "gun"
      if (laserCharging && primary !== "laser" && tDist < laserRange) primary = "laser"

      if (primary === "mortar") {
        const sp = mortarW!.stats.speed ?? 72, g = mortarW!.stats.gravity ?? 22
        let sol = null as ReturnType<typeof ballisticPitch>
        let aimPt: V3 = [shootAt.pos[0], shootAt.pos[1], shootAt.pos[2] + 0.5]
        for (const high of [false, true]) {
          aimPt = [shootAt.pos[0], shootAt.pos[1], shootAt.pos[2] + 0.5]
          let s2 = null as ReturnType<typeof ballisticPitch>
          for (let k = 0; k < 3; k++) {
            s2 = ballisticPitch(dist2(tube, aimPt), aimPt[2] - tube[2], sp, g, high)
            if (!s2) break
            aimPt = [shootAt.pos[0] + v[0] * s2.t, shootAt.pos[1] + v[1] * s2.t, shootAt.pos[2] + 0.5]
          }
          if (s2 && arcClear(tube, yawTo(tube, aimPt), s2.pitch, sp, g, dist2(tube, aimPt))) {
            sol = s2
            break
          }
        }
        if (sol) desired = [yawTo(tube, aimPt), sol.pitch]
        else primary = "gun"
      }
      const hitscanPt: V3 = [c[0] + v[0] * 0.1, c[1] + v[1] * 0.1, c[2] + v[2] * 0.05]
      if (primary === "laser" || primary === "lightning") desired = aimAt(muzzle, hitscanPt)
      const gunSpeed = gunW?.stats.speed ?? 252
      const floorZ = (world ? world.surfaceZ(shootAt.pos[0], shootAt.pos[1], shootAt.pos[2] + 0.5) : shootAt.pos[2]) + shootAt.aimDz
      const gunSol = leadPointAir(muzzle, c, v, gunSpeed, cfg.mech.gravity ?? 22, floorZ, PRM.jetRiseSpeed)
      const gunAim = aimAt(muzzle, gunSol.at)
      if (primary === "gun" || !desired) desired = gunAim

      const ay = me.aim[0], ap = me.aim[1]
      const radius = 2.5 * (1 + sizePerCube * shootAt.cubes)
      const yawTol = Math.max(0.012, Math.atan2(radius * 0.8, tDist))
      const pitchTol = Math.max(0.015, Math.atan2(3.5, tDist))
      const canShoot = shootAt.los
      const gunOk = Math.abs(angDiff(ay, gunAim[0])) < yawTol && Math.abs(ap - gunAim[1]) < pitchTol
      if (gunW && gunS >= 0 && canShoot && gunW.reload === 0 && (gunW.ammo ?? 1) > 0 && tDist < (gunW.stats.range ?? 230) * 0.98 && gunOk) {
        if (!world || world.shotClear(muzzle, gunSol.at)) fire[gunS] = true
      }
      if (lightW && lightS >= 0 && primary === "lightning" && canShoot) {
        const cone = ((lightW.stats.cone_deg ?? 30) * Math.PI) / 180
        if (Math.abs(angDiff(ay, yawTo(P, shootAt.pos))) < cone * 0.4) fire[lightS] = true
      }
      if (laserW && laserS >= 0) {
        const full = laserW.stats.charge ?? 0.75
        const holdS = laserW.stats.hold_s ?? 2
        const ok = !!desired && Math.abs(angDiff(ay, desired[0])) < yawTol && Math.abs(ap - desired[1]) < pitchTol
        const clear = canShoot && (!world || world.shotClear(muzzle, hitscanPt))
        if (primary === "laser") {
          if (laserCharge <= 0) fire[laserS] = laserW.cooldown <= 0.05 && (canShoot || t - shootAt.losT < 1.5) && mode !== "retreat"
          else if (laserCharge < full - 0.02) fire[laserS] = true
          else fire[laserS] = !(ok && clear) && laserCharge < full + holdS - 0.25 // release when aligned and clear
        } else if (laserCharge > 0) fire[laserS] = !(ok && clear) && laserCharge < full + holdS - 0.25
        laserNoTargetSince = -1
      }
      if (mortarW && mortarS >= 0 && primary === "mortar" && desired && tDist > 20) {
        if (Math.abs(angDiff(ay, desired[0])) < 0.03 && Math.abs(ap - desired[1]) < 0.03) fire[mortarS] = true
      }
    } else if (laserW && laserS >= 0 && laserCharge <= 0 && laserW.cooldown <= 0.05 && mode === "fight" && engLive && t - engagedLosT < PRM.peekS - 1) {
      // pre-charge behind cover, release on the peek (house bots react slowly)
      fire[laserS] = true
      laserNoTargetSince = t
    } else if (laserW && laserS >= 0 && laserCharge > 0) {
      // charged with nobody to shoot: hold while a target may reappear, release before auto-fire
      if (laserNoTargetSince < 0) laserNoTargetSince = t
      const full = laserW.stats.charge ?? 0.75
      const holdS = laserW.stats.hold_s ?? 2
      fire[laserS] = laserCharge < full + holdS - 0.3 && t - laserNoTargetSince < 2.2
    }

    // farming (no enemy to shoot): drones when healthy, crates
    const farm = !shootAt && mode !== "heal" && mode !== "evade" && mode !== "retreat" ? farmTarget() : null
    if (farm && gunW && gunS >= 0) {
      const fa = aimAt(muzzle, farm.aim)
      desired = fa
      const d = dist3(muzzle, farm.aim)
      const ok = Math.abs(angDiff(me.aim[0], fa[0])) < Math.max(0.02, Math.atan2(1.2, d)) && Math.abs(me.aim[1] - fa[1]) < Math.max(0.03, Math.atan2(1.5, d))
      const clear = !world || world.shotClear(muzzle, farm.aim)
      if (ok && clear && gunW.reload === 0 && (gunW.ammo ?? 1) > 0) fire[gunS] = true
      if (lightW && lightS >= 0 && d < 40 && me.energy > 40 && ok && clear) fire[lightS] = true
    }
    // reload in lulls
    if (gunW && !shootAt && gunW.reload === 0 && (gunW.ammo ?? 0) < (gunW.stats.mag ?? 12) * 0.6 && !farm) act.reload = true
    if (gunW && shootAt && !shootAt.los && gunW.reload === 0 && (gunW.ammo ?? 0) < (gunW.stats.mag ?? 12) * 0.35) act.reload = true

    // face the threat when not shooting (front arc takes x1 damage, rear x1.5)
    if (!desired && (mode === "fight" || mode === "pursue") && eng && t - eng.seenT < 8) desired = aimAt(muzzle, centerOf(eng))
    if (!desired && threat) desired = aimAt(muzzle, centerOf(threat))
    if (!desired && t - lastHurtT < 4 && hurtBearing !== null) desired = [hurtBearing, 0]
    if (!desired && attention && t - attention.t < 3) desired = [attention.yaw + Math.sin(scanPhase) * 0.3, 0]
    if (!desired && t < PRM.openScanS) desired = [me.aim[0] + 1.5, -0.05] // look all around once: find loot
    if (!desired) {
      scanPhase += 0.12
      const base = Math.hypot(move[0], move[1]) > 0.5 ? Math.atan2(move[1], move[0]) : me.aim[0]
      desired = [base + Math.sin(scanPhase) * 0.9, -0.05]
    }

    // ---------------- take weapons in reach
    for (const p of obs.pickups ?? []) {
      if (p.kind === "gun" || slotOf(p.kind) >= 0) continue
      const dh = dist2(P, p.pos), dv = Math.abs(p.pos[2] - P[2])
      if (dh > reach - 0.3 || dv > 3.8) continue
      const cur = me.weapons[1]
      if (!cur) act.take = p.id
      else if (PRM.weaponPref.indexOf(p.kind) < PRM.weaponPref.indexOf(cur.kind) && !(cur.kind === "laser" && (cur.charge ?? 0) > 0)) {
        act.take = p.id
        act.drop = 1
      }
      if (act.take !== undefined) break
    }

    if (profile === "pacifist") (fire[0] = false), (fire[1] = false)
    act.move = move
    act.aim = [desired[0], clamp(desired[1], -0.69, 1.29)]
    act.fire = fire
    act.boost = boost
    act.jump = jump
    if (dbg) {
      if (cover) draw.point([cover.x, cover.y, cover.z + 1], "#30ff60", 6)
      if (follow && (mode === "zone" || mode === "loot" || mode === "heal" || mode === "retreat" || mode === "evade")) {
        const wps = follow.waypoints(12)
        for (let i = 0; i + 1 < wps.length; i++) draw.line([wps[i][0], wps[i][1], wps[i][2] + 0.5], [wps[i + 1][0], wps[i + 1][1], wps[i + 1][2] + 0.5], "#ffd060")
      }
    }
    draw.label(`${ffa ? "FFA" : "SQD"} ${mode}${goalLabel ? ":" + goalLabel : ""} k${kills} hp${Math.round(hpFrac * 100)}${tgt ? " " + primary + " " + Math.round(tDist) + "m" + (tgt.los ? "" : "?") : ""} ${dbgNote}`)
    return act

  }

  /** Sample a shell's flight and check each chord against the world until it reaches `range`. */
  function arcClear(o: V3, yaw: number, pitch: number, sp: number, g: number, range: number): boolean {
    if (!world) return true
    const vx = Math.cos(pitch) * Math.cos(yaw) * sp, vy = Math.cos(pitch) * Math.sin(yaw) * sp, vz = Math.sin(pitch) * sp
    const hs = Math.cos(pitch) * sp
    const T = range / Math.max(1, hs)
    const n = 10
    let prev: V3 = [o[0] + Math.cos(yaw) * 3, o[1] + Math.sin(yaw) * 3, o[2]]
    for (let i = 1; i <= n; i++) {
      const tt = (T * i) / n * 0.97
      const p: V3 = [o[0] + vx * tt, o[1] + vy * tt, o[2] + vz * tt - 0.5 * g * tt * tt]
      if (!world.shotClear(prev, p)) return false
      prev = p
    }
    return true
  }

  const bot: Bot = {
    name: profile === "pacifist" ? "mr-probe" : "mr-v1",
    act(obs: Observation): BotAction {
      try {
        return decide(obs)
      } catch (e) {
        errors++
        if (errors <= 5 || errors % 100 === 0) log(`v1 act failed at t=${obs.t} (${errors}):`, e)
        draw.clear()
        return fallback.act(obs)
      }
    },
  }
  if (opts.warm !== false && world && nav) warmUp(hello, profile, world, nav)
  return bot
}

/**
 * Run a throwaway instance through synthetic fight / retreat / heal / zone observations so the JIT
 * has compiled the decision code before the first real observation (first calls cost 10-30 ms).
 */
function warmUp(hello: Hello, profile: Profile, world: World, nav: NavGrid) {
  const t0 = performance.now()
  try {
    const cfg = hello.config
    const z0 = cfg.zone.start_center as V2
    const snap = (x: number, y: number): V3 => {
      const n = nav.nearestFree(x, y, world.groundZ(x, y), 30)
      return n >= 0 ? [nav.nodeX(n), nav.nodeY(n), nav.hz[n]] : [x, y, world.groundZ(x, y)]
    }
    const gun = { kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: { ...cfg.weapons.gun } }
    const laser = { kind: "laser", cooldown: 0, charge: 0, stats: { ...cfg.weapons.laser } }
    const light = { kind: "lightning", cooldown: 0, stats: { ...cfg.weapons.lightning } }
    const spots: V2[] = [[z0[0], z0[1]], [-120, 40], [150, 150], [-250, -150], [60, -200]]
    const enemyId = (hello.slot + 1) % 16
    let n = 0
    const b = makeBot(hello, profile, { warm: false }) // one throwaway instance (each owns ~7 MB of A* scratch)
    for (let rep = 0; rep < 3; rep++)
      for (let si = 0; si < spots.length; si++) {
        const me = snap(spots[si][0], spots[si][1])
        for (let i = 0; i < 60; i++) {
          if (performance.now() - t0 > PRM.warmMs) return
          const t = 1 + n * 0.1
          const ang = si + i * 0.05
          const dist = 30 + ((i * 7) % 150)
          const e = snap(me[0] + Math.cos(ang) * dist, me[1] + Math.sin(ang) * dist)
          const phase = Math.floor(i / 15)
          const hp = phase === 1 ? 420 : phase === 2 ? 800 : 1400
          const slot1 = rep === 0 ? laser : rep === 1 ? light : null
          const obs = {
            type: "obs", tick: Math.round(t * 20), t, alive: 16 - rep,
            self: {
              id: hello.slot, pos: [me[0] + (i % 3) * 0.5, me[1], me[2]], vel: [i % 2 ? 5 : -5, 0, 0], aim: [ang, 0], hp, max_hp: 1400, energy: 100 - (i % 50), max_energy: 100,
              grounded: true, cubes: rep, upgrades: [], weapons: [{ ...gun, ammo: 12 - (i % 13), reload: i % 13 === 12 ? 1.2 : 0 }, slot1 && { ...slot1, cooldown: i % 20 < 10 ? 0 : 1 }],
              in_zone: phase !== 3, stats: { ...cfg.mech },
            },
            mechs: phase === 2 && i % 2 ? [] : [{ id: enemyId, kind: "mech", pos: e, vel: [3, -2, 0], aim: [ang + Math.PI, 0], hp: 1400 - i * 20, max_hp: 1400, cubes: 0, weapons: ["gun", "laser"], charging: i % 4 === 0 }],
            projectiles: [], crates: i % 10 === 0 ? [{ id: 1000 + i, pos: snap(me[0] + 20, me[1]), hp: 300 }] : [], cubes: [], pickups: [], sounds: i % 7 === 0 ? [{ kind: "gun", bearing: ang, dist: "mid", age: 0.1 }] : [], beams: [],
            events: i % 5 === 0 ? [{ type: "damaged", amount: 45, weapon: "gun", bearing: ang, by: enemyId }] : i % 5 === 2 ? [{ type: "hit", target: enemyId, amount: 45, weapon: "gun" }] : [],
            zone: phase === 3
              ? { center: z0, radius: 560, next_center: [me[0] + 250, me[1]], next_radius: 100, shrink_start: 5, shrink_end: 60, dps: 20 }
              : { center: z0, radius: 560, next_center: [me[0], me[1]], next_radius: 380, shrink_start: 60, shrink_end: 110, dps: 20 },
            offer: null, drops: [],
          }
          b.act(JSON.parse(JSON.stringify(obs)) as Observation)
          n++
        }
      }
  } catch (e) {
    log("warm-up failed", e)
  } finally {
    draw.clear()
  }
}
