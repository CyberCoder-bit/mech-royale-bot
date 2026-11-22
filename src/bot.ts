/**
 * Bot factory. Keep ALL mutable state inside the instance returned by makeBot
 * (the simulator runs many bots in one process).
 */
import { draw, type ActorObs, type Bot, type BotAction, type Hello, type Observation, type OfferChoice, type WeaponKind } from "./mechfight.ts"
import { aimAt, ballisticPitch, leadPoint } from "./brain/aim.ts"
import { angDiff, clamp, dist2, dist3, rng, unit, yawTo, type V2, type V3 } from "./util/math.ts"

export type Profile = "fighter" | "pacifist"
/** Build profile. "pacifist" is a probe build: never fires, avoids enemies. */
export const PROFILE: Profile = "pacifist"

/** Slot-1 weapon preference, best first. */
const WEAPON_PREF: WeaponKind[] = ["laser", "lightning", "mortar"]
const UPGRADE_PREF = [
  "plating", "armor", "nanites", "gun_damage", "gun_rate", "laser_damage", "laser_charge", "lightning_efficiency",
  "lightning_range", "gyros", "gun_velocity", "gun_mag", "servos", "sensors", "mortar_reload", "mortar_velocity",
  "mortar_splash", "lightning_chain", "laser_pierce", "reactor", "capacitor", "jets",
]

type Primary = "gun" | "laser" | "lightning" | "mortar"

export function makeBot(hello: Hello, profile: Profile = PROFILE): Bot {
  const cfg = hello.config
  const rand = rng(Number(hello.seed) || 1)
  const totalMechs = cfg.match?.mechs ?? 16
  const sizePerCube = Number((cfg.cubes as Record<string, unknown>).size_per_cube ?? 0.05)
  const reach = cfg.loot.pickup_radius ?? 4
  const lightningCfg = cfg.weapons.lightning

  // ---- per-instance state
  let kills = 0
  let ffa = false
  let lastHurtT = -99
  let hurtBearing: number | null = null
  let lastAttacker: number | null = null
  const attackers = new Map<number, number>() // id -> last time they damaged us
  const posHist: V3[] = []
  let stuckCount = 0
  let unstickUntil = -1
  let unstickAttempts = 0
  let detourYaw: number | null = null
  let detourUntil = -1
  let jinkSign = rand() < 0.5 ? -1 : 1
  let jinkUntil = 0
  let scanPhase = rand() * Math.PI * 2
  let lastMoveCmd: V2 = [0, 0]
  let laserNoTargetSince = -1

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

  return {
    name: profile === "pacifist" ? "mr-probe" : "mr-v0",
    act(obs: Observation): BotAction {
      const t = obs.t
      const me = obs.self
      const P = me.pos as V3
      const st = me.stats ?? {}
      const myId = me.id
      const act: BotAction = {}
      const fire: [boolean, boolean] = [false, false]

      // ---------------- events
      for (const ev of obs.events ?? []) {
        if (ev.type === "damaged") {
          if (ev.by !== null && ev.by !== undefined) {
            lastHurtT = t
            hurtBearing = ev.bearing
            lastAttacker = ev.by
            attackers.set(ev.by, t)
          } else if (ev.weapon !== "zone") {
            lastHurtT = t
            hurtBearing = ev.bearing
          }
        } else if (ev.type === "kill") kills++
      }
      // Mode detection: in practice house bots never kill each other.
      if (!ffa && totalMechs - obs.alive > kills + 1) ffa = true

      if (obs.offer && obs.offer.choices?.length) act.pick = pickUpgrade(obs.offer.choices)

      // ---------------- world summary
      const enemies = obs.mechs.filter((m) => m.kind === "mech" && m.id !== myId)
      const npcs = obs.mechs.filter((m) => m.kind === "npc")
      const hpFrac = me.hp / Math.max(1, me.max_hp)
      const muzzle: V3 = [P[0], P[1], P[2] + (st.muzzle_height ?? 7 * (1 + sizePerCube * me.cubes))]
      const tube: V3 = [P[0], P[1], P[2] + 9.5 * (1 + sizePerCube * me.cubes)]
      const slotOf = (k: WeaponKind) => me.weapons.findIndex((w) => w?.kind === k)
      const gunS = slotOf("gun"), laserS = slotOf("laser"), lightS = slotOf("lightning"), mortarS = slotOf("mortar")
      const gunW = gunS >= 0 ? me.weapons[gunS]! : null
      const laserW = laserS >= 0 ? me.weapons[laserS]! : null
      const lightW = lightS >= 0 ? me.weapons[lightS]! : null
      const mortarW = mortarS >= 0 ? me.weapons[mortarS]! : null

      // ---------------- zone
      const z = obs.zone
      const nc = z.next_center as V2, nr = z.next_radius
      const dNext = dist2(P, nc)
      const margin = nr < 1 ? 0 : Math.max(6, Math.min(40, nr * 0.25))
      const needZone = nr < 1 ? dNext > 2 : dNext > nr - margin
      const zoneYaw = yawTo(P, nc)
      const outside = !me.in_zone

      // ---------------- target selection
      const centerOf = (m: ActorObs): V3 => {
        const s = 1 + sizePerCube * (m.cubes ?? 0)
        const h = m.kind === "npc" ? 1.75 : 4.5 * s
        return [m.pos[0], m.pos[1], m.pos[2] + h]
      }
      let target: ActorObs | null = null
      let tScore = Infinity
      for (const e of enemies) {
        const d = dist3(P, e.pos)
        const ef = (e.hp ?? 1400) / Math.max(1, e.max_hp ?? 1400)
        const recent = (attackers.get(e.id) ?? -99) > t - 3 ? 0.8 : 0
        const s = d / 100 + ef * 1.2 - recent
        if (s < tScore) (tScore = s), (target = e)
      }
      // Farming targets when no enemy mech is around.
      let farm: { pos: V3; id: number; kind: "npc" | "crate" } | null = null
      if (!target && profile === "fighter") {
        let best = Infinity
        if (hpFrac > 0.7)
          for (const n of npcs) {
            const d = dist3(P, n.pos)
            if (d < 70 && d < best) (best = d), (farm = { pos: centerOf(n), id: n.id, kind: "npc" })
          }
        for (const c of obs.crates ?? []) {
          const d = dist3(P, c.pos)
          if (d < 70 && d + 20 < best) (best = d + 20), (farm = { pos: [c.pos[0], c.pos[1], c.pos[2] + 1.2], id: c.id, kind: "crate" })
        }
      }

      // ---------------- aim + fire
      let desired: [number, number] | null = null
      let primary: Primary = "gun"
      let tDist = Infinity
      if (target && profile === "fighter") {
        const c = centerOf(target)
        const v = target.vel as V3
        tDist = dist3(muzzle, c)
        const lightRange = (lightW?.stats.range ?? lightningCfg.range ?? 45) * 0.95
        const laserRange = (laserW?.stats.range ?? 280) * 0.97
        const lightReady = !!lightW && me.energy >= (lightW.stats.energy ?? 3) + 6
        const laserCharging = !!laserW && (laserW.charge ?? 0) > 0
        const laserReady = !!laserW && (laserCharging || laserW.cooldown < 0.35)
        if (lightReady && tDist < lightRange) primary = "lightning"
        else if (laserReady && tDist < laserRange) primary = "laser"
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
        if (primary === "laser" || primary === "lightning") {
          // hitscan: aim at where it will be at the next decision
          const p: V3 = [c[0] + v[0] * 0.1, c[1] + v[1] * 0.1, c[2] + v[2] * 0.05]
          desired = aimAt(muzzle, p)
        }
        const gunSpeed = gunW?.stats.speed ?? 252
        const gunSol = leadPoint(muzzle, c, [v[0], v[1], v[2] * 0.3], gunSpeed)
        const gunAim = aimAt(muzzle, gunSol.at)
        if (primary === "gun" || !desired) desired = gunAim

        // alignment of ACTUAL aim
        const ay = me.aim[0], ap = me.aim[1]
        const radius = 2.5 * (1 + sizePerCube * (target.cubes ?? 0))
        const yawTol = Math.max(0.012, Math.atan2(radius * 0.8, tDist))
        const pitchTol = Math.max(0.015, Math.atan2(3.5, tDist))
        const gunOk = Math.abs(angDiff(ay, gunAim[0])) < yawTol && Math.abs(ap - gunAim[1]) < pitchTol
        if (gunW && gunS >= 0 && gunW.reload === 0 && (gunW.ammo ?? 1) > 0 && tDist < (gunW.stats.range ?? 230) * 0.98 && gunOk) fire[gunS] = true

        if (lightW && lightS >= 0 && primary === "lightning") {
          const cone = ((lightW.stats.cone_deg ?? 30) * Math.PI) / 180
          if (Math.abs(angDiff(ay, yawTo(P, target.pos))) < cone * 0.4) fire[lightS] = true
        }
        if (laserW && laserS >= 0) {
          const full = laserW.stats.charge ?? 0.75
          const charge = laserW.charge ?? 0
          const ok = desired && Math.abs(angDiff(ay, desired[0])) < yawTol && Math.abs(ap - desired[1]) < pitchTol
          if (primary === "laser") {
            if (charge <= 0) fire[laserS] = laserW.cooldown <= 0.05 // start charging
            else if (charge < full - 0.02) fire[laserS] = true // keep charging
            else fire[laserS] = !ok // full: release (false) when aligned
          } else if (charge > 0) fire[laserS] = !ok
          laserNoTargetSince = -1
        }
        if (mortarW && mortarS >= 0 && primary === "mortar" && desired && tDist > 20) {
          if (Math.abs(angDiff(ay, desired[0])) < 0.03 && Math.abs(ap - desired[1]) < 0.03) fire[mortarS] = true
        }
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
        if (ok && gunW.reload === 0 && (gunW.ammo ?? 1) > 0) fire[gunS] = true
        if (lightW && lightS >= 0 && d < 40 && me.energy > 40 && ok) fire[lightS] = true
      }
      // reload in lulls
      if (gunW && !target && gunW.reload === 0 && (gunW.ammo ?? 0) < (gunW.stats.mag ?? 12) * 0.6 && !farm) act.reload = true

      // ---------------- movement
      let move: V2 = [0, 0]
      let boost = false
      let jump = false
      const now = t
      if (now - jinkUntil > 0) {
        jinkSign = -jinkSign
        jinkUntil = now + 0.45 + rand() * 0.8
      }
      const zonePull: V2 = needZone ? unit(zoneYaw) : [0, 0]

      if (target) {
        const ty = yawTo(P, target.pos)
        const d = dist2(P, target.pos)
        const ef = (target.hp ?? 1400) / Math.max(1, target.max_hp ?? 1400)
        const toT = unit(ty)
        const perp: V2 = [-toT[1] * jinkSign, toT[0] * jinkSign]
        const retreat = profile === "pacifist" || (hpFrac < 0.35 && (ef > hpFrac + 0.1 || enemies.length > 1))
        if (retreat) {
          move = norm2([-toT[0] + perp[0] * 0.6 + zonePull[0] * 1.2, -toT[1] + perp[1] * 0.6 + zonePull[1] * 1.2])
          boost = me.energy > 35
        } else {
          const pref = primary === "lightning" ? 20 : primary === "laser" ? 110 : primary === "mortar" ? 120 : lightW ? 30 : 70
          const radial = clamp((d - pref) / Math.max(20, pref * 0.5), -1, 1)
          move = norm2([toT[0] * radial + perp[0] + zonePull[0] * 1.5, toT[1] * radial + perp[1] + zonePull[1] * 1.5])
          boost = outside && me.energy > 30
        }
        if (profile === "pacifist") desired = aimAt(muzzle, centerOf(target))
      } else {
        // loot or travel
        let goal: V2 | null = needZone ? nc : null
        let goalDist = needZone ? dNext : 0
        const safeHere = (p: ArrayLike<number>) => nr < 1 || dist2(p, nc) < nr + 25
        if (profile === "fighter" && hpFrac > 0.25) {
          let best = 70
          for (const c of obs.cubes ?? []) {
            const d = dist2(P, c.pos)
            if (d < best && safeHere(c.pos) && Math.abs(c.pos[2] - P[2]) < 25) (best = d), (goal = [c.pos[0], c.pos[1]]), (goalDist = d)
          }
          const wantWeapon = !me.weapons[1] || (me.weapons[1] && WEAPON_PREF.indexOf(me.weapons[1].kind) > 0)
          if (wantWeapon) {
            let bestW = 90
            for (const p of obs.pickups ?? []) {
              if (p.kind === "gun" || slotOf(p.kind) >= 0) continue
              const cur = me.weapons[1]?.kind
              if (cur && WEAPON_PREF.indexOf(p.kind) >= WEAPON_PREF.indexOf(cur)) continue
              const d = dist2(P, p.pos)
              if (d < bestW && safeHere(p.pos) && Math.abs(p.pos[2] - P[2]) < 30) (bestW = d), (goal = [p.pos[0], p.pos[1]]), (goalDist = d)
            }
          }
          if (farm && !goal) {
            const d = dist2(P, farm.pos)
            if (farm.kind === "crate" && d > 12) (goal = [farm.pos[0], farm.pos[1]]), (goalDist = d)
          }
        }
        if (goal) {
          move = unit(yawTo(P, goal))
          if (goalDist < 3) move = [move[0] * 0.3, move[1] * 0.3]
        }
        boost = (outside && me.energy > 20) || (needZone && dNext - nr > 120 && me.energy > 75)
        if (now - lastHurtT < 3 && profile === "fighter") {
          // shot by someone we can't see: jink
          const by = hurtBearing ?? me.aim[0]
          const toB = unit(by)
          const perp: V2 = [-toB[1] * jinkSign, toB[0] * jinkSign]
          move = norm2([move[0] + perp[0], move[1] + perp[1]])
        }
      }

      // ---------------- take weapons in reach
      for (const p of obs.pickups ?? []) {
        if (p.kind === "gun" || slotOf(p.kind) >= 0) continue
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

      // ---------------- stuck detection and recovery
      const wantMove = Math.hypot(move[0], move[1]) > 0.5
      posHist.push([P[0], P[1], P[2]])
      if (posHist.length > 8) posHist.shift()
      const hspeed = Math.hypot(me.vel[0], me.vel[1])
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

      // ---------------- aim when idle: look where we go, sweep a little
      if (!desired) {
        if (now - lastHurtT < 4 && hurtBearing !== null) desired = [hurtBearing, 0]
        else {
          scanPhase += 0.12
          const base = wantMove ? Math.atan2(move[1], move[0]) : me.aim[0]
          desired = [base + Math.sin(scanPhase) * 0.9, -0.05]
        }
      }

      if (profile === "pacifist") (fire[0] = false), (fire[1] = false)
      act.move = move
      act.aim = [desired[0], clamp(desired[1], -0.69, 1.29)]
      act.fire = fire
      act.boost = boost
      act.jump = jump
      lastMoveCmd = move
      draw.label(`${ffa ? "FFA" : "SQD"} k${kills} hp${Math.round(hpFrac * 100)} ${target ? primary + " " + Math.round(tDist) + "m" : farm ? "farm" : needZone ? "zone" : "idle"}`)
      return act
    },
  }
}
