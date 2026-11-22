/**
 * Bot factory. Keep ALL mutable state inside the instance returned by makeBot
 * (the simulator runs many bots in one process).
 *
 * v0 plus squad tactics ("sq"): a map model for line-of-sight gated fire and nav paths, an enemy
 * tracker (attackers vs passive mechs), target priority (attackers first, clear shots, finish weak
 * ones), heal cycles (hold fire on passive targets while hurt), and hunting remembered enemies.
 */
import { draw, log, type ActorObs, type Bot, type BotAction, type Hello, type Observation, type OfferChoice, type WeaponKind } from "./mechfight.ts"
import { aimAt, ballisticPitch, leadPoint, leadPointBallistic } from "./brain/aim.ts"
import { angDiff, clamp, dist2, dist3, rng, unit, yawTo, type V2, type V3 } from "./util/math.ts"
import { P as PRM, type Profile } from "./params.ts"
import { loadWorld, navFor, PathFollower, type World } from "./world/index.ts"
import { bestSpots, loadExposure } from "./expo/exposure.ts"
import { FfaBrain } from "./brain/ffa.ts" // FFA hook

const WEAPON_PREF: WeaponKind[] = PRM.weaponPref
const UPGRADE_PREF = PRM.upgradePref

type Primary = "gun" | "laser" | "lightning" | "mortar"

/** set once the map + nav were built in this process (they are cached: later instances get them instantly) */
let mapBuiltOnce = false

type Track = {
  id: number
  pos: V3
  vel: V3
  hp: number
  maxHp: number
  cubes: number
  weapons: string[]
  /** last time it was listed in obs.mechs (seen or remembered by the server) */
  lastListed: number
  /** last time we had a clear shot line to it */
  lastLos: number
  /** last time it damaged us */
  lastAttack: number
  firstSeen: number
  /** listed in the current observation */
  listed: boolean
  /** clear shot line in the current observation */
  los: boolean
  /** seconds it has spent walking straight at us (decays) */
  appT: number
}

export function makeBot(hello: Hello, profile: Profile = PRM.profile): Bot & { dbg: { mode: string; target: number; los: boolean; listed: string; weapons: string; info: string } } {
  const cfg = hello.config
  const rand = rng(Number(hello.seed) || 1)
  const totalMechs = cfg.match?.mechs ?? 16
  const sizePerCube = Number((cfg.cubes as Record<string, unknown>).size_per_cube ?? 0.05)
  const reach = cfg.loot.pickup_radius ?? 4
  const lightningCfg = cfg.weapons.lightning
  const jetDrain = Number((cfg.mech as Record<string, unknown>).jet_drain ?? 15)
  const mortarG = Number((cfg.weapons.mortar as Record<string, unknown>)?.gravity ?? 22) || 22
  const mortarSplash = Number((cfg.weapons.mortar as Record<string, unknown>)?.splash_radius ?? 7) || 7
  const mechG = Number((cfg.mech as Record<string, unknown>).gravity ?? 22) || 22
  /** observed rise speed while jetting: max_rise_speed minus one tick of gravity (stream: 8.9) */
  const jetRise = (Number((cfg.mech as Record<string, unknown>).max_rise_speed ?? 10) || 10) - mechG * 0.05

  // ---- map model (optional: every use is guarded)
  let world: World | null = null
  let follow: PathFollower | null = null
  // cold-start guard: `ready` must reach the server within 20 s of hello, container start included.
  // performance.now() counts from process start; on a very slow host skip the optional parts.
  // (only the first instance in a process pays the build; later ones reuse the cached map, e.g. in the sim)
  const upMs = () => performance.now()
  const fresh = !mapBuiltOnce
  if (PRM.useWorld && (!fresh || upMs() < PRM.initSkipMs)) {
    try {
      world = loadWorld(hello.map.dir, hello.map.files)
      if (!fresh || upMs() < PRM.initSkipMs) {
        follow = new PathFollower(navFor(world))
        follow.planMs = 3
        mapBuiltOnce = true
      }
    } catch (e) {
      log("world load failed", e)
      world = null
      follow = null
    }
  }
  if (world && follow) {
    try {
      // deterministic A* budget (expansions, with a wall-time safety cap): reproducible sims, bounded ticks
      if (PRM.planExpand > 0) {
        const pf = follow.pf
        const orig = pf.findPath.bind(pf)
        pf.findPath = (sx, sy, sz, tx, ty, tz, opts = {}) => orig(sx, sy, sz, tx, ty, tz, { ...opts, maxMs: PRM.planCapMs, maxExpand: PRM.planExpand })
      }
      // JIT warm-up of the hot world paths (cold first calls cost tens of ms inside a match)
      if (PRM.warmMs > 0 && fresh && upMs() < PRM.initSkipMs) {
        const t0 = performance.now()
        const W = world, nav = follow.nav
        let sd = 12345
        const r = () => (sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
        let acc = 0
        for (let i = 0; i < 4000 && performance.now() - t0 < PRM.warmMs * 0.5; i++) {
          const x = -300 + r() * 600, y = -250 + r() * 500, a = r() * Math.PI * 2, d = 20 + r() * 180
          const x1 = x + Math.cos(a) * d, y1 = y + Math.sin(a) * d
          if (W.shotClear([x, y, W.groundZ(x, y) + 7], [x1, y1, W.groundZ(x1, y1) + 4.5])) acc++
          if (nav.lineWalkable(x, y, W.groundZ(x, y), x + Math.cos(a) * 20, y + Math.sin(a) * 20, 30)) acc++
          if (nav.nodeAt(x1, y1, W.groundZ(x1, y1)) >= 0) acc++
        }
        for (let i = 0; i < 10 && performance.now() - t0 < PRM.warmMs; i++) {
          const x = -200 + r() * 400, y = -200 + r() * 400, x1 = x - 60 + r() * 120, y1 = y - 60 + r() * 120
          acc += follow.pf.findPath(x, y, W.groundZ(x, y), x1, y1, W.groundZ(x1, y1), { maxMs: 4, weight: 1.25 }).expanded
        }
        if (acc < 0) log("warm-up: impossible")
      }
    } catch (e) {
      log("nav setup failed", e)
    }
  }
  if (PRM.useWorld && !follow) log(`map model limited (world ${!!world}, nav ${!!follow}) at ${upMs().toFixed(0)} ms`)
  if (PRM.holdR > 0 && (!fresh || upMs() < PRM.initSkipMs)) {
    try {
      loadExposure(undefined, fresh)
    } catch (e) {
      log("exposure load failed", e)
    }
  }
  // ==== FFA hook (1/2): FFA brain (src/brain/ffa.ts), only when the map model loaded (cold-start guard) ====
  let ffaBrain: FfaBrain | null = null
  if (world && follow)
    try {
      ffaBrain = new FfaBrain(hello)
    } catch {}
  // ==== end FFA hook ====

  // ---- per-instance state
  let kills = 0
  let ffa = false
  let lastHurtT = -99
  let hurtBearing: number | null = null
  let lastDealT = -99
  const tracks = new Map<number, Track>()
  const posHist: V3[] = []
  let stuckCount = 0
  let unstickUntil = -1
  let unstickAttempts = 0
  let detourYaw: number | null = null
  let detourUntil = -1
  let jinkSign = rand() < 0.5 ? -1 : 1
  let jinkUntil = 0
  let scanPhase = rand() * Math.PI * 2
  let laserNoTargetSince = -1
  let curTarget: number | null = null
  let lastAttackerId: number | null = null
  let ffaEvidence = 0
  let lastRearT = -99
  let lastMechHurtT = -99
  let holdSpot: V3 | null = null
  let holdUntil = -1
  let duckPt: V2 | null = null
  let duckUntil = -1
  let xfPt: V3 | null = null
  let xfUntil = -1
  let fbOn = false
  const pickMem = new Map<number, { kind: WeaponKind; pos: V3; t: number }>()
  let soundPt: { x: number; y: number; t: number } | null = null
  let mode = "idle"

  const pickUpgrade = (choices: OfferChoice[]) => {
    let best = 0, bestRank = 1e9
    choices.forEach((c, i) => {
      const r = UPGRADE_PREF.indexOf(c.id)
      const rank = r < 0 ? 500 : r
      if (rank < bestRank) (bestRank = rank), (best = i)
    })
    return best
  }

  const norm2 = (v: V2): V2 => {
    const l = Math.hypot(v[0], v[1])
    return l > 1e-6 ? [v[0] / l, v[1] / l] : [0, 0]
  }

  const shotOk = (a: V3, b: V3) => !PRM.losGate || !world || world.shotClear(a, b)

  /** read-only debug view for local tools (not part of the protocol) */
  const dbg = { mode: "", target: -1, los: false, listed: "", weapons: "", info: "" }
  return {
    name: profile === "pacifist" ? "mr-probe" : "mr-sq",
    dbg,
    act(obs: Observation): BotAction {
      const t = obs.t
      const me = obs.self
      const P = me.pos as V3
      const st = me.stats ?? {}
      const myId = me.id
      const act: BotAction = {}
      const fire: [boolean, boolean] = [false, false]
      const mySize = 1 + sizePerCube * me.cubes

      // ---------------- events
      for (const ev of obs.events ?? []) {
        if (ev.type === "damaged") {
          if (ev.by !== null && ev.by !== undefined) {
            lastHurtT = t
            hurtBearing = ev.bearing
            if (ev.by < 100) (lastAttackerId = ev.by), (lastMechHurtT = t)
            if (ev.rear) lastRearT = t
            const tr = tracks.get(ev.by)
            if (tr) tr.lastAttack = t
            else
              tracks.set(ev.by, {
                id: ev.by, pos: [P[0] + Math.cos(ev.bearing ?? 0) * 80, P[1] + Math.sin(ev.bearing ?? 0) * 80, P[2]], vel: [0, 0, 0],
                hp: 1400, maxHp: 1400, cubes: 0, weapons: [], lastListed: -99, lastLos: -99, lastAttack: t, firstSeen: t, listed: false, los: false, appT: 0,
              })
          } else if (ev.weapon !== "zone") {
            lastHurtT = t
            hurtBearing = ev.bearing
          }
        } else if (ev.type === "took") {
          pickMem.delete(ev.id)
        } else if (ev.type === "take_failed") {
          if (ev.reason === "gone") pickMem.delete(ev.id)
        } else if (ev.type === "hit") {
          lastDealT = t
        } else if (ev.type === "kill") {
          kills++
          tracks.delete(ev.target)
          if (curTarget === ev.target) curTarget = null
        }
      }
      // Mode detection: in practice house bots never kill each other.
      if (!ffa && totalMechs - obs.alive > kills + PRM.ffaSlack) ffa = true
      const npcs = obs.mechs.filter((m) => m.kind === "npc")
      // ...nor damage each other: a listed mech losing a weapon-sized chunk of HP that we did not hit,
      // with no NPC drone near it, is someone else's fight (FFA evidence)
      if (!ffa && PRM.ffaHpDrop > 0) {
        const hitNow = new Set<number>()
        for (const ev of obs.events ?? []) if (ev.type === "hit") hitNow.add(ev.target)
        for (const m of obs.mechs) {
          if (m.kind !== "mech" || m.id === me.id) continue
          const tr = tracks.get(m.id)
          if (!tr || !tr.listed || m.hp === undefined || hitNow.has(m.id)) continue
          if (tr.hp - m.hp >= PRM.ffaHpDrop && !npcs.some((n) => dist2(n.pos, m.pos) < 70)) ffaEvidence++
        }
        if (ffaEvidence >= 2) ffa = true
      }
      const sq = !ffa
      // ==== FFA hook (2/2): tick() always updates its memory; it acts only after 2+ deaths we didn't cause, before 150 s ====
      const ffaAct = ffaBrain?.tick(obs, ffa)
      if (ffaAct) return ffaAct
      // ==== end FFA hook ====

      if (obs.offer && obs.offer.choices?.length) act.pick = pickUpgrade(obs.offer.choices)

      // ---------------- world summary
      const hpFrac = me.hp / Math.max(1, me.max_hp)
      const muzzle: V3 = [P[0], P[1], P[2] + (st.muzzle_height ?? 7 * mySize)]
      const tube: V3 = [P[0], P[1], P[2] + 9.5 * mySize]
      const slotOf = (k: WeaponKind) => me.weapons.findIndex((w) => w?.kind === k)
      const gunS = slotOf("gun"), laserS = slotOf("laser"), lightS = slotOf("lightning"), mortarS = slotOf("mortar")
      const gunW = gunS >= 0 ? me.weapons[gunS]! : null
      const laserW = laserS >= 0 ? me.weapons[laserS]! : null
      const lightW = lightS >= 0 ? me.weapons[lightS]! : null
      const mortarW = mortarS >= 0 ? me.weapons[mortarS]! : null

      const centerOf = (m: { kind?: string; pos: ArrayLike<number>; cubes?: number }): V3 => {
        const s = 1 + sizePerCube * (m.cubes ?? 0)
        const h = m.kind === "npc" ? 1.75 : 4.5 * s
        return [m.pos[0], m.pos[1], m.pos[2] + h]
      }

      // ---------------- tracker
      for (const tr of tracks.values()) (tr.listed = false), (tr.los = false)
      const listed: ActorObs[] = []
      for (const m of obs.mechs) {
        if (m.kind !== "mech" || m.id === myId) continue
        listed.push(m)
        let tr = tracks.get(m.id)
        if (!tr) {
          tr = {
            id: m.id, pos: [0, 0, 0], vel: [0, 0, 0], hp: 1400, maxHp: 1400, cubes: 0, weapons: [],
            lastListed: t, lastLos: -99, lastAttack: -99, firstSeen: t, listed: true, los: false, appT: 0,
          }
          tracks.set(m.id, tr)
        }
        // approach detector: moving straight at us for a while (squad hunters path to our position)
        {
          const dt = clamp(t - tr.lastListed, 0, 0.3)
          const dx = P[0] - m.pos[0], dy = P[1] - m.pos[1]
          const dd = Math.hypot(dx, dy), sp = Math.hypot(m.vel[0], m.vel[1])
          const cosA = dd > 1 && sp > 1e-3 ? (m.vel[0] * dx + m.vel[1] * dy) / (dd * sp) : 0
          if (sp > 5 && cosA > 0.8 && dd > 30) tr.appT += dt
          else tr.appT = Math.max(0, tr.appT - 2 * dt)
        }
        tr.pos = [m.pos[0], m.pos[1], m.pos[2]]
        tr.vel = [m.vel[0], m.vel[1], m.vel[2]]
        tr.hp = m.hp ?? tr.hp
        tr.maxHp = m.max_hp ?? tr.maxHp
        tr.cubes = m.cubes ?? 0
        tr.weapons = (m.weapons ?? []) as string[]
        tr.lastListed = t
        tr.listed = true
        const c = centerOf(m)
        const top: V3 = [c[0], c[1], m.pos[2] + 8.5 * (1 + sizePerCube * (m.cubes ?? 0))]
        tr.los = !world || world.shotClear(muzzle, c) || world.shotClear(muzzle, top)
        if (tr.los) tr.lastLos = t
      }
      for (const [id, tr] of tracks) if (t - tr.lastListed > PRM.huntMemS && t - tr.lastAttack > PRM.huntMemS) tracks.delete(id)
      const isAttacker = (tr: Track) => t - tr.lastAttack < PRM.attackerS
      /** attacker, or (approach detector) a mech that has been walking straight at us */
      const isThreat = (tr: Track) => isAttacker(tr) || (PRM.approachS > 0 && tr.appT >= PRM.approachS && tr.listed)
      let engagedBy = 0
      for (const tr of tracks.values()) if (isAttacker(tr) && t - tr.lastListed < 3) engagedBy++
      const underFire = t - lastHurtT < PRM.attackerS
      // weapon pickups: remember what we saw; forget what should be in view but is not listed
      {
        const seen = new Set<number>()
        for (const p of obs.pickups ?? []) {
          seen.add(p.id)
          pickMem.set(p.id, { kind: p.kind, pos: [p.pos[0], p.pos[1], p.pos[2]], t })
        }
        for (const [id, pm] of pickMem) if (!seen.has(id) && dist2(P, pm.pos) < 30 && Math.abs(pm.pos[2] - P[2]) < 5) pickMem.delete(id)
      }
      const noSlot1 = !me.weapons[1] && !(me.weapons[0] && me.weapons[0].kind !== "gun")
      // squad: a mortar is cook-off bait for the house lasers (+60% per beam)
      const skipMortar = PRM.noMortar && sq
      let knownWeapon = false
      if (noSlot1 && PRM.lootMemRange > 0)
        for (const pm of pickMem.values()) if (pm.kind !== "gun" && !(skipMortar && pm.kind === "mortar") && dist2(P, pm.pos) < (sq ? PRM.lootMemRange : PRM.ffaLootRange)) knownWeapon = true
      // sounds of fights / farming: remember a rough source point for hunting
      for (const s of obs.sounds ?? []) {
        if (s.kind === "gun" || s.kind === "laser" || s.kind === "lightning" || s.kind === "mortar" || s.kind === "crate" || s.kind === "npc_gun" || s.kind === "explosion" || s.kind === "step" || s.kind === "boost") {
          const r = s.dist === "near" ? 35 : s.dist === "mid" ? 100 : 200
          if (!soundPt || t - soundPt.t > 3 || s.dist === "near") soundPt = { x: P[0] + Math.cos(s.bearing) * r, y: P[1] + Math.sin(s.bearing) * r, t }
        }
      }

      // ---------------- zone
      const z = obs.zone
      const nc = z.next_center as V2, nr = z.next_radius
      const dNext = dist2(P, nc)
      const margin = nr < 1 ? 0 : Math.max(PRM.zoneMarginMin, Math.min(PRM.zoneMarginMax, nr * PRM.zoneMarginFrac))
      const needZone = nr < 1 ? dNext > 2 : dNext > nr - margin
      const zoneYaw = yawTo(P, nc)
      const outside = !me.in_zone
      const safeHere = (p: ArrayLike<number>) => nr < 1 || dist2(p, nc) < nr + 25

      // ---------------- supply drop
      let drop: { pos: V3; r: number; d: number; landed: boolean } | null = null
      if (profile === "fighter" && PRM.dropRange > 0) {
        for (const dr of obs.drops ?? []) {
          const d = dist2(P, dr.pos)
          if (d > PRM.dropRange) continue
          if (dr.holder !== null && dr.holder !== undefined && dr.holder !== myId && dr.progress > dr.capture_s * 0.6) continue
          const travel = d / Math.max(5, st.walk_speed ?? 11.7)
          if (dr.lands_in > travel + PRM.dropEarlyS + 2) continue
          if (!drop || d < drop.d) drop = { pos: [dr.pos[0], dr.pos[1], dr.pos[2]], r: dr.radius ?? 8, d, landed: dr.lands_in <= 0 }
        }
      }

      // ---------------- target selection
      const healing = profile === "fighter" && hpFrac < PRM.healHp && !underFire
      let target: ActorObs | null = null
      let tScore = Infinity
      for (const e of listed) {
        const tr = tracks.get(e.id)!
        const d = dist3(P, e.pos)
        const ef = (e.hp ?? 1400) / Math.max(1, e.max_hp ?? 1400)
        const attacker = isThreat(tr)
        if (!attacker) {
          // passive (or not yet hostile) mech: engage only when we can afford it
          let allowed = !healing && (hpFrac >= PRM.engageHp || ef < PRM.finishHp || d < PRM.closeEngage)
          if (knownWeapon && PRM.lootFirstIgnore > 0 && d > PRM.lootFirstIgnore && e.id !== curTarget) allowed = false
          // a mech is shooting us: no passive targets (only nearly dead ones) until it is dealt with
          if (PRM.atkOnly > 0 && sq && t - lastMechHurtT < PRM.atkOnly && ef >= PRM.finishHp) allowed = false
          if (!allowed) continue
        }
        let s = d / 100 + ef * PRM.tgtHp
        if (attacker) s -= PRM.tgtAttackerD > 0 && d > PRM.tgtAttackerD ? PRM.tgtAttacker * 0.25 : PRM.tgtAttacker
        if (t - tr.lastAttack < 2) s -= PRM.tgtRecentAtk // the one shooting us right now: face it (rear hits x1.5)
        // lasers: 315 per hitscan shot, the house bots' burst threat
        if (PRM.tgtLaser > 0 && e.weapons?.includes("laser")) s -= PRM.tgtLaser
        // a kill drops all of the victim's cubes + 2
        if (PRM.tgtCubes > 0) s -= PRM.tgtCubes * Math.min(10, e.cubes ?? 0)
        // our laser cooks off a mortar holder (+60%)
        if (PRM.tgtCook > 0 && laserS >= 0 && e.weapons?.includes("mortar")) s -= PRM.tgtCook
        // a mech turned away from us takes x1.5 (rear arc): free damage
        if (PRM.tgtRear > 0 && Math.abs(angDiff(yawTo(e.pos, P), e.aim[0])) > Math.PI / 2 + 0.1) s -= PRM.tgtRear
        if (PRM.tgtCharging > 0 && e.charging && Math.abs(angDiff(e.aim[0], yawTo(e.pos, P))) < 0.25) s -= PRM.tgtCharging
        if (!tr.los) s += PRM.tgtNoLos
        if (e.id === curTarget) s -= PRM.tgtSticky + PRM.tgtFocus * (1 - ef)
        // last stand (about to die under fire): the mech closest to dying, so the final seconds still buy a place
        if (PRM.lastStandHp > 0 && sq && hpFrac < PRM.lastStandHp && underFire)
          s = (e.hp ?? 1400) / 700 + d / 200 + (tr.los ? 0 : 1.5) - (e.id === curTarget ? 0.2 : 0)
        if (s < tScore) (tScore = s), (target = e)
      }
      // shot in the back by someone we cannot see while busy with a non-attacker: turn to face the shooter instead
      if (PRM.rearReveal && target && t - lastRearT < 1.5 && lastAttackerId !== null && !isThreat(tracks.get(target.id)!)) {
        const la = tracks.get(lastAttackerId)
        if (!la || !la.listed) target = null
      }
      // shot by a mech we can't see (behind us, in canopy) while busy with a passive one: drop it, face the shooter
      if (PRM.unseenSwitch > 0 && sq && target && t - lastMechHurtT < PRM.unseenSwitch && lastAttackerId !== null && !isThreat(tracks.get(target.id)!)) {
        const la = tracks.get(lastAttackerId)
        if (!la || !la.listed) target = null
      }
      curTarget = target ? target.id : null
      const tgtTrack = target ? tracks.get(target.id)! : null
      // Farming targets when no enemy mech is around (not while healing: dealing damage resets regen).
      let farm: { pos: V3; id: number; kind: "npc" | "crate" } | null = null
      // A drone that is shooting us is always fair game (350 HP, 2 cubes; ignoring it costs 25 per hit).
      let npcAtk: ActorObs | null = null
      if (PRM.npcDefend && !target && profile === "fighter")
        for (const n of npcs) if (t - (tracks.get(n.id)?.lastAttack ?? -99) < 3 && dist3(P, n.pos) < 90) npcAtk = n
      if (npcAtk) farm = { pos: centerOf(npcAtk), id: npcAtk.id, kind: "npc" }
      else if (!target && profile === "fighter" && !healing && !(PRM.farmHealHp > 0 && hpFrac < PRM.farmHealHp && !underFire)) {
        let best = Infinity
        if (hpFrac > PRM.farmNpcHp)
          for (const n of npcs) {
            const d = dist3(P, n.pos)
            if (d < PRM.farmRange && d < best) (best = d), (farm = { pos: centerOf(n), id: n.id, kind: "npc" })
          }
        for (const c of obs.crates ?? []) {
          const d = dist3(P, c.pos)
          if (d < PRM.farmRange && d + 20 < best) (best = d + 20), (farm = { pos: [c.pos[0], c.pos[1], c.pos[2] + 1.2], id: c.id, kind: "crate" })
        }
      }

      // ---------------- reveal: shot by someone we can't see (canopy, behind us): face it and close in
      let reveal: V3 | null = null
      if (!target && profile === "fighter" && PRM.revealS > 0 && t - lastHurtT < PRM.revealS && hurtBearing !== null && lastAttackerId !== null) {
        const tr = tracks.get(lastAttackerId)
        if (!tr || !tr.listed) {
          let r = PRM.revealDist
          if (tr && t - tr.lastListed < 30) r = clamp(dist2(P, tr.pos), 25, 120)
          reveal = [P[0] + Math.cos(hurtBearing) * r, P[1] + Math.sin(hurtBearing) * r, P[2]]
        }
      }

      // ---------------- aim + fire
      let desired: [number, number] | null = null
      let primary: Primary = "gun"
      let tDist = Infinity
      const losNow = !!tgtTrack && tgtTrack.los
      if (target && profile === "fighter") {
        const c = centerOf(target)
        const v = target.vel as V3
        tDist = dist3(muzzle, c)
        const lightRange = (lightW?.stats.range ?? lightningCfg.range ?? 45) * 0.95
        const laserRange = (laserW?.stats.range ?? 280) * 0.97
        const lightReady = !!lightW && me.energy >= (lightW.stats.energy ?? 3) + 6
        const laserCharging = !!laserW && (laserW.charge ?? 0) > 0
        const laserReady = !!laserW && (laserCharging || laserW.cooldown < 0.35)
        if (lightReady && tDist < lightRange && losNow) primary = "lightning"
        else if (laserReady && tDist < laserRange && (losNow || laserCharging)) primary = "laser"
        else if (mortarW && mortarW.cooldown < 0.2 && tDist > 25 && tDist < 225) primary = "mortar"
        else primary = "gun"
        if (laserCharging && primary !== "laser" && tDist < laserRange) primary = "laser"

        if (primary === "mortar") {
          const sp = mortarW!.stats.speed ?? 72, g = mortarW!.stats.gravity ?? 22
          let aimPt: V3 = [target.pos[0], target.pos[1], target.pos[2] + 0.5]
          let sol = null as ReturnType<typeof ballisticPitch>
          for (let k = 0; k < 3; k++) {
            sol = ballisticPitch(dist2(tube, aimPt), aimPt[2] - tube[2], sp, g, false)
            if (!sol) break
            aimPt = [target.pos[0] + v[0] * sol.t, target.pos[1] + v[1] * sol.t, target.pos[2] + 0.5]
          }
          if (sol) desired = [yawTo(tube, aimPt), sol.pitch]
          else primary = "gun"
        }
        let hitscanPt: V3 | null = null
        let laserAim: [number, number] | null = null
        if (primary === "laser" || primary === "lightning") {
          // hitscan: aim at where it will be at the next decision
          hitscanPt = [c[0] + v[0] * 0.1, c[1] + v[1] * 0.1, c[2] + v[2] * 0.05]
          desired = laserAim = aimAt(muzzle, hitscanPt)
        }
        const gunSpeed = gunW?.stats.speed ?? 252
        // grounded mechs report vel[2] = 0 exactly; airborne ones fall at gravity unless jetting (constant ~8.9 m/s rise)
        const airborne = Math.abs(v[2]) > 0.05
        const gunSol = PRM.gravityLead && airborne
          ? leadPointBallistic(muzzle, c, v, gunSpeed, mechG, target.pos[2], world ? world.surfaceZ(target.pos[0], target.pos[1], target.pos[2]) : -1e9, Math.abs(v[2] - jetRise) < 0.3)
          : leadPoint(muzzle, c, [v[0], v[1], v[2] * 0.3], gunSpeed)
        const gunAim = aimAt(muzzle, gunSol.at)
        if (primary === "gun" || !desired) desired = gunAim
        // keep the gun busy: lightning's cone covers the gun's lead point, and a laser only needs its
        // own aim for the last moment of the charge (the torso re-aims in ~0.01 s)
        if (PRM.gunDuringCharge && gunW && gunW.reload === 0 && (gunW.ammo ?? 0) > 0) {
          if (primary === "lightning") desired = gunAim
          else if (primary === "laser" && laserW && (laserW.charge ?? 0) < (laserW.stats.charge ?? 0.75) - PRM.laserSwitchS) desired = gunAim
        }

        // alignment of ACTUAL aim
        const ay = me.aim[0], ap = me.aim[1]
        const radius = 2.5 * (1 + sizePerCube * (target.cubes ?? 0))
        const yawTol = Math.max(0.012, Math.atan2(radius * 0.8, tDist))
        const pitchTol = Math.max(0.015, Math.atan2(3.5, tDist))
        const gunOk = Math.abs(angDiff(ay, gunAim[0])) < yawTol && Math.abs(ap - gunAim[1]) < pitchTol
        if (gunW && gunS >= 0 && gunW.reload === 0 && (gunW.ammo ?? 1) > 0 && tDist < (gunW.stats.range ?? 230) * 0.98 && gunOk && losNow && shotOk(muzzle, gunSol.at)) fire[gunS] = true

        if (lightW && lightS >= 0 && primary === "lightning") {
          const cone = ((lightW.stats.cone_deg ?? 30) * Math.PI) / 180
          if (Math.abs(angDiff(ay, yawTo(P, target.pos))) < cone * 0.4) fire[lightS] = true
        }
        if (laserW && laserS >= 0) {
          const full = laserW.stats.charge ?? 0.75
          const charge = laserW.charge ?? 0
          const la = laserAim ?? desired
          const aligned = !!la && Math.abs(angDiff(ay, la[0])) < yawTol && Math.abs(ap - la[1]) < pitchTol
          const clear = losNow && (!hitscanPt || shotOk(muzzle, hitscanPt))
          const ok = aligned && clear
          if (primary === "laser") {
            if (charge <= 0) fire[laserS] = laserW.cooldown <= 0.05 && losNow // start charging
            else if (charge < full - 0.02) fire[laserS] = true // keep charging
            else fire[laserS] = !ok // full: release (false) when aligned with a clear line
          } else if (charge > 0) fire[laserS] = !ok
          else if (PRM.preCharge && primary !== "lightning" && !losNow && laserW.cooldown <= 0.05 && tgtTrack && t - tgtTrack.lastLos < PRM.preChargeLos && tDist < laserRange)
            fire[laserS] = true // pre-charge: it ducked out of line, the first shot back lands at full charge
          laserNoTargetSince = -1
        }
        if (mortarW && mortarS >= 0 && primary === "mortar" && desired && tDist > 20) {
          if (Math.abs(angDiff(ay, desired[0])) < 0.03 && Math.abs(ap - desired[1]) < 0.03) fire[mortarS] = true
        }
        dbg.info = `${primary} d${Math.round(tDist)} gOk${+gunOk} sh${+shotOk(muzzle, gunSol.at)} am${gunW?.ammo ?? -1} rl${(gunW?.reload ?? 0).toFixed(1)} lc${(laserW?.charge ?? 0).toFixed(2)} lcd${(laserW?.cooldown ?? 0).toFixed(2)} f${+fire[0]}${+fire[1]} dy${angDiff(ay, desired![0]).toFixed(3)} dp${(ap - desired![1]).toFixed(3)}`
      } else if (laserW && laserS >= 0 && (laserW.charge ?? 0) > 0) {
        // charged with nobody to shoot: hold for a while, then let it go
        if (laserNoTargetSince < 0) laserNoTargetSince = t
        fire[laserS] = t - laserNoTargetSince < 1.2
      }
      if (!target && farm && gunW && gunS >= 0) {
        const fa = aimAt(muzzle, farm.pos)
        desired = fa
        const d = dist3(muzzle, farm.pos)
        const ok = Math.abs(angDiff(me.aim[0], fa[0])) < Math.max(0.02, Math.atan2(1.2, d)) && Math.abs(me.aim[1] - fa[1]) < Math.max(0.03, Math.atan2(1.5, d))
        const clear = shotOk(muzzle, farm.pos)
        if (ok && clear && gunW.reload === 0 && (gunW.ammo ?? 1) > 0) fire[gunS] = true
        if (lightW && lightS >= 0 && d < 40 && me.energy > 40 && ok && clear) fire[lightS] = true
      }
      // reload in lulls
      if (gunW && (!target || !losNow) && gunW.reload === 0 && (gunW.ammo ?? 0) < (gunW.stats.mag ?? 12) * 0.6 && !(farm && !target)) act.reload = true

      // ---------------- duck: a laser is charging at us with a clear line -> nearest cover
      let ducking = false
      if (PRM.duckR > 0 && world && follow && profile === "fighter") {
        let threat: ActorObs | null = null
        for (const e of listed) {
          if (!e.charging) continue
          const tr = tracks.get(e.id)
          if (!tr || !tr.los) continue
          const d = dist2(P, e.pos)
          if (d > 230) continue
          const bearing = yawTo(e.pos, P)
          if (Math.abs(angDiff(e.aim[0], bearing)) > Math.max(0.08, Math.atan2(6, d))) continue
          threat = e
          break
        }
        if (threat) {
          const nav = follow.nav
          const from: V3 = [threat.pos[0], threat.pos[1], threat.pos[2] + 7 * (1 + sizePerCube * (threat.cubes ?? 0))]
          let best: V2 | null = null
          for (const r of [4, 7, 10, 13, 16]) {
            if (r > PRM.duckR) break
            for (let k = 0; k < 12 && !best; k++) {
              const a = (k * Math.PI) / 6
              const x = P[0] + Math.cos(a) * r, y = P[1] + Math.sin(a) * r
              const n = nav.nodeAt(x, y, P[2])
              if (n < 0) continue
              const zz = nav.hz[n]
              if (Math.abs(zz - P[2]) > 1.5) continue
              if (world.shotClear(from, [x, y, zz + 4.5 * mySize]) || world.shotClear(from, [x, y, zz + 8.5 * mySize])) continue
              if (!nav.lineWalkable(P[0], P[1], P[2], x, y, 20)) continue
              best = [x, y]
            }
            if (best) break
          }
          if (best) (duckPt = best), (duckUntil = t + 0.4)
        }
        if (duckPt && t < duckUntil) ducking = true
        else duckPt = null
      }

      // ---------------- movement
      let move: V2 = [0, 0]
      let boost = false
      let jump = false
      let pathed = false
      const now = t
      if (now - jinkUntil > 0) {
        jinkSign = -jinkSign
        jinkUntil = now + PRM.jinkMin + rand() * PRM.jinkRand
      }
      const zonePull: V2 = needZone ? unit(zoneYaw) : [0, 0]
      const goPath = (gx: number, gy: number, gz: number, tol = 2.5): V2 | null => {
        if (!follow) return null
        follow.setGoal(gx, gy, gz, tol)
        const o = follow.update({ t, pos: P, vel: me.vel, grounded: me.grounded, energy: me.energy, climbEnergyPerM: jetDrain / 8.9 })
        if (o.arrived) return [0, 0]
        pathed = true
        if (o.jump) jump = true
        if (o.boost) boost = true
        return o.move
      }

      if (target) {
        const ty = yawTo(P, target.pos)
        const d = dist2(P, target.pos)
        const ef = (target.hp ?? 1400) / Math.max(1, target.max_hp ?? 1400)
        const toT = unit(ty)
        const perp: V2 = [-toT[1] * jinkSign, toT[0] * jinkSign]
        const retreat = profile === "pacifist" || (hpFrac < PRM.retreatHp && (ef > hpFrac + PRM.retreatMargin || engagedBy > 1))
        if (retreat) {
          mode = "retreat"
          move = norm2([-toT[0] + perp[0] * 0.6 + zonePull[0] * 1.2, -toT[1] + perp[1] * 0.6 + zonePull[1] * 1.2])
          boost = me.energy > 35
        } else if (!losNow && tgtTrack && !isThreat(tgtTrack) && follow && t - tgtTrack.lastLos > 1) {
          // passive target behind cover: walk around to it
          mode = "chase"
          const m = goPath(target.pos[0], target.pos[1], target.pos[2], 6)
          if (m) move = m
          if (PRM.chaseBoostE > 0 && me.energy > PRM.chaseBoostE && me.grounded) boost = true
        } else if (drop && drop.d < PRM.dropFightRange && !(drop.d < drop.r - 2.5)) {
          // fight on the way into the drop ring
          mode = "fight-drop"
          const m = goPath(drop.pos[0], drop.pos[1], drop.pos[2], Math.max(1.5, drop.r - 3))
          move = norm2([(m ?? unit(yawTo(P, drop.pos)))[0] + perp[0] * 0.5, (m ?? unit(yawTo(P, drop.pos)))[1] + perp[1] * 0.5])
        } else if (drop && drop.d < drop.r - 2.5) {
          // inside the ring: strafe without leaving it
          mode = "fight-hold"
          const back = unit(yawTo(P, drop.pos))
          const w = drop.d / Math.max(1, drop.r - 2.5)
          move = norm2([perp[0] + back[0] * w * 1.5, perp[1] + back[1] * w * 1.5])
        } else {
          mode = "fight"
          const pr = PRM.prefRange
          let pref = primary === "lightning" ? pr.lightning : primary === "laser" ? pr.laser : primary === "mortar" ? pr.mortar : lightW ? pr.gunWithLightning : pr.gun
          if (tgtTrack && !isThreat(tgtTrack)) {
            if (sq && lightW && PRM.passiveRangeL > 0) pref = PRM.passiveRangeL
            else if (sq && !lightW && PRM.passiveRangeG > 0) pref = PRM.passiveRangeG
          }
          const radial = clamp((d - pref) / Math.max(20, pref * 0.5), -1, 1)
          move = norm2([toT[0] * radial + perp[0] + zonePull[0] * 1.5, toT[1] * radial + perp[1] + zonePull[1] * 1.5])
          // flank a passive target: work around to its back (x1.5 rear hits) at the preferred range
          if (PRM.flankW > 0 && sq && tgtTrack && !isThreat(tgtTrack) && !needZone) {
            const bk = unit(target.aim[0] + Math.PI)
            const fx = target.pos[0] + bk[0] * pref - P[0], fy = target.pos[1] + bk[1] * pref - P[1]
            const fd = Math.hypot(fx, fy)
            if (fd > 6) {
              move = norm2([move[0] + (fx / fd) * PRM.flankW, move[1] + (fy / fd) * PRM.flankW])
              mode = "fight-flank"
            }
          }
          // pincer: attackers on opposite sides -> back away from their middle so they end up on one side (front arc)
          if (PRM.pincerW > 0) {
            let cx = 0, cy = 0, n = 0, ux = 0, uy = 0
            for (const tr of tracks.values()) {
              if (!isAttacker(tr) || tr.id >= 100) continue
              let px = tr.pos[0], py = tr.pos[1]
              if (t - tr.lastListed > 5) {
                // unseen shooter: only the latest one, placed along the last damage bearing
                if (tr.id !== lastAttackerId || t - lastMechHurtT > 3 || hurtBearing === null) continue
                px = P[0] + Math.cos(hurtBearing) * 60, py = P[1] + Math.sin(hurtBearing) * 60
              }
              const a = Math.atan2(py - P[1], px - P[0])
              ux += Math.cos(a), uy += Math.sin(a)
              cx += px, cy += py, n++
            }
            // resultant length of the bearings: cos(spread / 2) for two attackers
            if (n >= 2 && Math.hypot(ux, uy) / n < Math.cos((PRM.pincerDeg * Math.PI) / 360)) {
              const u = norm2([P[0] - cx / n, P[1] - cy / n])
              move = norm2([move[0] + u[0] * PRM.pincerW, move[1] + u[1] * PRM.pincerW])
              mode = "fight-pincer"
            }
          }
          boost = outside && me.energy > 30
          // dodge: strafe at boost speed while a threat has a line on us (keep energy for lightning up close)
          // close the gap to a passive target faster (it does not shoot back; the hunters do)
          if (PRM.chaseBoostE > 0 && !boost && tgtTrack && !isThreat(tgtTrack) && d > pref + 25 && me.energy > PRM.chaseBoostE + (lightW ? 40 : 0)) boost = true
          if (PRM.fightBoostE > 0 && !boost) {
            const keep = lightW && tDist < 70 ? 40 : 0
            if (me.energy >= PRM.fightBoostE + keep) fbOn = true
            else if (me.energy < PRM.fightBoostLo + keep) fbOn = false
            if (fbOn && (t - lastHurtT < 2 || (losNow && !!tgtTrack && isThreat(tgtTrack)))) boost = true
          }
          if (PRM.hopP > 0 && me.grounded && d > PRM.hopMin && d < PRM.hopMax && rand() < PRM.hopP) jump = true
          // grab cubes lying close by while fighting (kill drops: +HP, +damage)
          const grabR = sq ? PRM.cubeGrab : PRM.ffaCubeGrab // FFA mode keeps the v3 range
          if (grabR > 0 && me.cubes < 30) {
            let bc: ArrayLike<number> | null = null, bd = grabR
            for (const cu of obs.cubes ?? []) {
              const dc = dist2(P, cu.pos)
              if (dc < bd && Math.abs(cu.pos[2] - P[2]) < 4 && safeHere(cu.pos)) (bd = dc), (bc = cu.pos)
            }
            if (bc) {
              mode = "fight-cube"
              const tc = norm2([bc[0] - P[0], bc[1] - P[1]])
              move = norm2([tc[0] * 1.5 + perp[0] * 0.4, tc[1] * 1.5 + perp[1] * 0.4])
              if (PRM.cubeBoostE > 0 && sq && me.energy > PRM.cubeBoostE + (lightW && tDist < 70 ? 40 : 0) && bd > 6) boost = true // less time on a predictable line
            }
          }
        }
        if (profile === "pacifist") desired = aimAt(muzzle, centerOf(target))
      } else {
        // loot, hunt, heal or travel
        let goal: V2 | null = needZone ? nc : null
        let goalDist = needZone ? dNext : 0
        let goalZ = P[2]
        mode = needZone ? "zone" : "idle"
        if (profile === "fighter" && hpFrac > 0.25) {
          let best = PRM.lootCubeRange
          for (const c of obs.cubes ?? []) {
            const d = dist2(P, c.pos)
            if (d < best && safeHere(c.pos) && Math.abs(c.pos[2] - P[2]) < 25) (best = d), (goal = [c.pos[0], c.pos[1]]), (goalDist = d), (goalZ = c.pos[2]), (mode = "cube")
          }
          const wantWeapon = !me.weapons[1] || (me.weapons[1] && WEAPON_PREF.indexOf(me.weapons[1].kind) > 0)
          if (wantWeapon) {
            const range = noSlot1 && PRM.lootMemRange > 0 ? (sq ? PRM.lootMemRange : PRM.ffaLootRange) : PRM.lootWeaponRange
            let bestW = range
            const dzMax = follow ? 45 : 30
            const src: { kind: WeaponKind; pos: ArrayLike<number> }[] = PRM.lootMemRange > 0 ? [...pickMem.values()] : (obs.pickups ?? [])
            for (const p of src) {
              if (p.kind === "gun" || slotOf(p.kind) >= 0 || (skipMortar && p.kind === "mortar")) continue
              const cur = me.weapons[1]?.kind
              if (cur && WEAPON_PREF.indexOf(p.kind) >= WEAPON_PREF.indexOf(cur)) continue
              const d = dist2(P, p.pos) + (WEAPON_PREF.indexOf(p.kind) > 0 && noSlot1 ? 0 : 0)
              if (d < bestW && safeHere(p.pos) && Math.abs(p.pos[2] - P[2]) < dzMax) (bestW = d), (goal = [p.pos[0], p.pos[1]]), (goalDist = d), (goalZ = p.pos[2]), (mode = "loot")
            }
          }
          if (farm && !goal) {
            const d = dist2(P, farm.pos)
            if (farm.kind === "crate" && d > 12) (goal = [farm.pos[0], farm.pos[1]]), (goalDist = d), (mode = "farm")
          }
          // hunt: go where enemies were last seen or heard
          if (!goal && sq && !healing && hpFrac >= PRM.huntHp && t < PRM.huntUntil && !underFire) {
            let bd = Infinity
            let hg: V3 | null = null
            for (const tr of tracks.values()) {
              if (tr.listed || (PRM.npcDefend && tr.id >= 100)) continue // (drone tracks come only from damage events)
              const age = t - tr.lastListed
              const gx = tr.pos[0] + tr.vel[0] * Math.min(age, 2), gy = tr.pos[1] + tr.vel[1] * Math.min(age, 2)
              if (!safeHere([gx, gy])) continue
              // squad: mechs that never shot at us are free kills; the hunters come to us anyway
              const d = Math.hypot(gx - P[0], gy - P[1]) + age * 3 + (tr.lastAttack > 0 ? PRM.huntAtkPen : 0)
              if (d < bd) (bd = d), (hg = [gx, gy, tr.pos[2]])
            }
            if (!hg && soundPt && t - soundPt.t < 15 && safeHere([soundPt.x, soundPt.y])) hg = [soundPt.x, soundPt.y, P[2]]
            if (!hg && nr > 1) hg = [nc[0], nc[1], P[2]]
            if (hg) (goal = [hg[0], hg[1]]), (goalDist = dist2(P, hg)), (goalZ = hg[2]), (mode = "hunt")
          }
        }
        if (drop && (!needZone || dist2(drop.pos, nc) < nr)) {
          goal = [drop.pos[0], drop.pos[1]]
          goalDist = drop.d
          goalZ = drop.pos[2]
          mode = "drop"
        }
        if (reveal && (!needZone || dist2(reveal, nc) < nr)) {
          const d = dist2(P, reveal)
          mode = "reveal"
          if (sq) goal = d > PRM.revealStop ? [reveal[0], reveal[1]] : null // FFA: keep our course, just face it
          if (sq) goalDist = d
          if (sq) goalZ = reveal[2]
          const ca = aimAt(muzzle, [reveal[0], reveal[1], reveal[2] + 4.5])
          desired = ca
          if (PRM.revealFire && gunW && gunS >= 0 && gunW.reload === 0 && (gunW.ammo ?? 0) > 0 && t - lastHurtT < 1.5 && d < 110) {
            if (Math.abs(angDiff(me.aim[0], ca[0])) < 0.05 && Math.abs(me.aim[1] - ca[1]) < 0.06 && shotOk(muzzle, [reveal[0], reveal[1], reveal[2] + 4.5])) fire[gunS] = true
          }
        }
        if (healing && !needZone && mode === "idle") mode = "heal"
        // nothing to do (not hunting: hurt or late): wait at a low-exposure spot nearby
        if (mode === "idle" && PRM.holdR > 0 && profile === "fighter" && !goal) {
          if (!holdSpot || t > holdUntil || (nr > 1 && dist2(holdSpot, nc) > nr - 5)) {
            const avoid: V3[] = []
            for (const tr of tracks.values()) if (t - tr.lastListed < 20) avoid.push(tr.pos)
            const spots = bestSpots(P, PRM.holdR, 1, {
              avoid, avoidRadius: 35,
              penalty: (x, y) => Math.hypot(x - P[0], y - P[1]) * PRM.holdDistCost + (nr > 1 && Math.hypot(x - nc[0], y - nc[1]) > nr - margin ? 10 : 0),
            })
            holdSpot = spots.length ? [spots[0].x, spots[0].y, spots[0].z] : [P[0], P[1], P[2]]
            holdUntil = t + PRM.holdRefresh
          }
          const dh = dist2(P, holdSpot)
          if (dh > 2.5) {
            goal = [holdSpot[0], holdSpot[1]]
            goalDist = dh
            goalZ = holdSpot[2]
            mode = "hold"
          }
        }
        if (mode === "drop" && drop && drop.d < drop.r - 2.5) {
          // inside the ring: small circles near the middle
          const back = unit(yawTo(P, drop.pos))
          const side: V2 = [-back[1] * jinkSign, back[0] * jinkSign]
          move = norm2([side[0] * 0.5 + back[0] * (drop.d / drop.r), side[1] * 0.5 + back[1] * (drop.d / drop.r)])
          move = [move[0] * 0.5, move[1] * 0.5]
          goal = null
        }
        if (goal) {
          const m = goalDist > 8 ? goPath(goal[0], goal[1], goalZ, mode === "hunt" ? 8 : 2.5) : null
          if (m) move = m
          else {
            move = unit(yawTo(P, goal))
            if (goalDist < 3) move = [move[0] * 0.3, move[1] * 0.3]
          }
          // cover long hunting/looting trips faster, keeping energy for the fight at the end
          if (PRM.travelBoostE > 0 && (mode === "hunt" || mode === "loot") && goalDist > PRM.travelBoostD && me.energy > PRM.travelBoostE && me.grounded) boost = true
          // cubes (kill drops) are contested by the squad's loot runs and by our own next fight: get there first
          if (PRM.cubeTravelBoostE > 0 && mode === "cube" && goalDist > 6 && me.energy > PRM.cubeTravelBoostE && me.grounded) boost = true
        }
        boost = boost || (outside && me.energy > 20) || (needZone && dNext - nr > 120 && me.energy > 75)
        if (now - lastHurtT < 3 && profile === "fighter") {
          // shot by someone we can't see: jink
          const by = hurtBearing ?? me.aim[0]
          const toB = unit(by)
          const perp: V2 = [-toB[1] * jinkSign, toB[0] * jinkSign]
          move = norm2([move[0] + perp[0], move[1] + perp[1]])
        }
      }

      if (ducking && duckPt) {
        mode = "duck"
        const dd = Math.hypot(duckPt[0] - P[0], duckPt[1] - P[1])
        move = dd > 1.2 ? norm2([duckPt[0] - P[0], duckPt[1] - P[1]]) : [0, 0]
        boost = dd > 3 && me.energy > 8
        jump = false
      }

      // ---------------- crossfire: 2+ attackers with a line on us -> step to where at most one sees us
      if (PRM.xfireR > 0 && world && follow && profile === "fighter" && mode !== "dodge") {
        const shooters: V3[] = []
        for (const tr of tracks.values())
          if (tr.listed && tr.los && isAttacker(tr)) shooters.push([tr.pos[0], tr.pos[1], tr.pos[2] + 7 * (1 + sizePerCube * tr.cubes)])
        if (shooters.length >= 2) {
          if (!xfPt || t >= xfUntil) {
            const nav = follow.nav
            const tgtC: V3 | null = target ? centerOf(target) : null
            const exposed = (x: number, y: number, zz: number) => {
              let n = 0
              for (const s of shooters) if (world!.shotClear(s, [x, y, zz + 4.5 * mySize]) || world!.shotClear(s, [x, y, zz + 8.5 * mySize])) n++
              return n
            }
            let best: V3 = [P[0], P[1], P[2]]
            let bestS = exposed(P[0], P[1], P[2]) * 100
            for (const r of [5, 9, 13, 17]) {
              if (r > PRM.xfireR) break
              for (let k = 0; k < 12; k++) {
                const a = (k * Math.PI) / 6
                const x = P[0] + Math.cos(a) * r, y = P[1] + Math.sin(a) * r
                const nn = nav.nodeAt(x, y, P[2])
                if (nn < 0) continue
                const zz = nav.hz[nn]
                if (Math.abs(zz - P[2]) > 1.5) continue
                let s = exposed(x, y, zz) * 100 + r
                if (s >= bestS) continue
                // keep a line on our own target so the fight goes on (one shooter at a time)
                if (tgtC && !world.shotClear([x, y, zz + 7 * mySize], tgtC)) s += 60
                if (s >= bestS || !nav.lineWalkable(P[0], P[1], P[2], x, y, 25)) continue
                bestS = s
                best = [x, y, zz]
              }
            }
            xfPt = best
            xfUntil = t + 0.5
          }
        } else xfPt = null
        if (xfPt && dist2(P, xfPt) > 1.5) {
          mode = "xfire"
          move = norm2([xfPt[0] - P[0], xfPt[1] - P[1]])
          boost = dist2(P, xfPt) > 4 && me.energy > 15
          jump = false
        }
      }

      // ---------------- laser telegraph: a mech charging at us -> boost (hitscan beams land where the shooter last saw us)
      if (PRM.laserBoost && profile === "fighter" && me.energy > 8 && Math.hypot(move[0], move[1]) > 0.5 && mode !== "duck")
        for (const e of listed)
          if (e.charging && dist2(P, e.pos) < 240 && Math.abs(angDiff(e.aim[0], yawTo(e.pos, P))) < Math.max(0.06, Math.atan2(8, dist2(P, e.pos)))) {
            boost = true
            break
          }

      // ---------------- mortar dodge: incoming shell landing near us -> get out of the splash
      if (PRM.dodgeMortar && profile === "fighter") {
        let ax = 0, ay = 0, n = 0
        for (const pr of obs.projectiles ?? []) {
          if (pr.kind !== "mortar") continue
          const z0 = pr.pos[2] - P[2], vz = pr.vel[2]
          const disc = vz * vz + 2 * mortarG * z0
          if (disc < 0) continue
          const th = (vz + Math.sqrt(disc)) / mortarG
          if (!(th > 0) || th > 8) continue
          const ix = pr.pos[0] + pr.vel[0] * th, iy = pr.pos[1] + pr.vel[1] * th
          const dx = P[0] - ix, dy = P[1] - iy
          const dd = Math.hypot(dx, dy)
          // house mortars lead their target: also dodge a shell landing where our current motion takes us
          let danger = dd
          if (PRM.dodgePredict) {
            const tq = Math.min(th, 1.5)
            danger = Math.min(dd, Math.hypot(P[0] + me.vel[0] * tq - ix, P[1] + me.vel[1] * tq - iy))
          }
          if (danger > mortarSplash + PRM.dodgeMargin) continue
          // away from the impact point; straight on top of it: sideways to the shell's path
          if (dd > 0.5) (ax += dx / dd), (ay += dy / dd)
          else {
            const vl = Math.hypot(pr.vel[0], pr.vel[1]) || 1
            ax += (-pr.vel[1] / vl) * jinkSign
            ay += (pr.vel[0] / vl) * jinkSign
          }
          n++
        }
        if (n > 0 && (ax !== 0 || ay !== 0)) {
          mode = "dodge"
          move = norm2([ax, ay])
          // run across the target's line, not along it (a straight radial run is easy to lead)
          if (PRM.dodgeLateral && target) {
            const tl = unit(yawTo(P, target.pos))
            const px = -tl[1], py = tl[0]
            const side = move[0] * px + move[1] * py
            const s = Math.abs(side) > 0.15 ? Math.sign(side) : jinkSign
            move = norm2([px * s + move[0] * 0.35, py * s + move[1] * 0.35])
          }
          boost = me.energy > 5
          jump = false
        }
      }

      // ---------------- take weapons in reach
      for (const p of obs.pickups ?? []) {
        if (p.kind === "gun" || slotOf(p.kind) >= 0 || (skipMortar && p.kind === "mortar")) continue
        const dh = dist2(P, p.pos), dv = Math.abs(p.pos[2] - P[2])
        if (dh > reach - 0.3 || dv > 3.8) continue
        const cur = me.weapons[1]
        if (!cur) act.take = p.id
        else if (WEAPON_PREF.indexOf(p.kind) < WEAPON_PREF.indexOf(cur.kind) && !(cur.kind === "laser" && (cur.charge ?? 0) > 0)) {
          act.take = p.id
          act.drop = 1
        }
        if (act.take !== undefined) break
      }

      // ---------------- stuck detection and recovery (the path follower has its own)
      const wantMove = Math.hypot(move[0], move[1]) > 0.5
      posHist.push([P[0], P[1], P[2]])
      if (posHist.length > 8) posHist.shift()
      const hspeed = Math.hypot(me.vel[0], me.vel[1])
      if (!pathed) {
        if (wantMove && hspeed < 1.5 && now > unstickUntil) stuckCount++
        else if (hspeed > 4) stuckCount = 0
        if (stuckCount >= 5 && now > unstickUntil) {
          stuckCount = 0
          unstickAttempts++
          unstickUntil = now + 1.6
          if (unstickAttempts % 3 === 0 || me.energy < 25) {
            detourYaw = Math.atan2(move[1], move[0]) + (rand() < 0.5 ? 1.3 : -1.3)
            detourUntil = now + 1.4
          }
        }
        if (hspeed > 6 && now > unstickUntil + 3) unstickAttempts = 0
        if (now < detourUntil && detourYaw !== null) move = unit(detourYaw)
        else if (now < unstickUntil && wantMove) {
          if (me.grounded) jump = true
          if (!me.grounded && me.energy > 5) boost = true
        }
      } else stuckCount = 0

      // ---------------- aim when idle: look where we go, sweep a little
      if (!desired && t < PRM.openScanS) desired = [me.aim[0] + 1.4, -0.1]
      if (!desired) {
        if (now - lastHurtT < 4 && hurtBearing !== null) desired = [hurtBearing, 0]
        else {
          scanPhase += 0.12
          const base = wantMove ? Math.atan2(move[1], move[0]) : me.aim[0]
          desired = [base + Math.sin(scanPhase) * PRM.scanAmp, -0.05]
        }
      }

      if (profile === "pacifist") (fire[0] = false), (fire[1] = false)
      act.move = move
      act.aim = [desired[0], clamp(desired[1], -0.69, 1.29)]
      act.fire = fire
      act.boost = boost
      act.jump = jump
      dbg.mode = mode
      dbg.target = target ? target.id : -1
      dbg.los = losNow
      dbg.weapons = me.weapons.map((w) => w?.kind ?? "-").join("/")
      dbg.listed = listed.map((e) => `${e.id}${tracks.get(e.id)?.los ? "+" : "-"}`).join(",")
      draw.label(`${ffa ? "FFA" : "SQD"} k${kills} hp${Math.round(hpFrac * 100)} ${mode} ${target ? primary + " " + Math.round(tDist) + "m" : ""}`)
      return act
    },
  }
}
