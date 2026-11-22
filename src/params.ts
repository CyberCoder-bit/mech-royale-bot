/**
 * Tunable parameters. Practice experiments change ONLY this file (variant branches), so the bot
 * logic can evolve elsewhere without merge conflicts. Keep names stable; add new ones freely.
 */
import type { WeaponKind } from "./mechfight.ts"

export type Profile = "fighter" | "pacifist"

export const P = {
  /** "pacifist" is a probe build: never fires, avoids enemies. */
  profile: "fighter" as Profile,
  /** Slot-1 weapon preference, best first. */
  weaponPref: ["laser", "lightning", "mortar"] as WeaponKind[],
  upgradePref: [
    "plating", "armor", "nanites", "gun_damage", "gun_rate", "laser_damage", "laser_charge", "lightning_efficiency",
    "lightning_range", "gyros", "gun_velocity", "gun_mag", "servos", "sensors", "mortar_reload", "mortar_velocity",
    "mortar_splash", "lightning_chain", "laser_pierce", "reactor", "capacitor", "jets",
  ],
  /** Retreat when HP fraction is below this and the target is healthier (by retreatMargin) or we face several enemies. */
  retreatHp: 0.35,
  retreatMargin: 0.1,
  /** Preferred fighting distance (m) by primary weapon. */
  prefRange: { lightning: 20, laser: 110, mortar: 120, gunWithLightning: 30, gun: 70 },
  /** Jink: flip strafe direction every jinkMin + rand*jinkRand seconds. */
  jinkMin: 0.45,
  jinkRand: 0.8,
  /** Farm NPC drones only above this HP fraction; farm/loot search ranges (m). */
  farmNpcHp: 0.7,
  farmRange: 70,
  lootCubeRange: 70,
  lootWeaponRange: 130,
  /** Zone: aim to be inside the next circle by margin = clamp(r * frac, min, max). */
  zoneMarginFrac: 0.25,
  zoneMarginMin: 6,
  zoneMarginMax: 40,
  /** FFA detector: deaths not caused by us beyond this slack switch to FFA mode. */
  ffaSlack: 1,
  /** FFA detector: a listed mech losing at least this much HP in one obs without our hit (no NPC near) counts as evidence; 2 = FFA (0 = off). */
  ffaHpDrop: 40,

  // ---------------- squad tactics (sq)
  /** Use the map model (LOS gates, nav paths). */
  useWorld: true,
  /** Gate gun/laser/lightning fire on a clear shot line (prisms + terrain). */
  losGate: true,
  /** Target score weights: attacker bonus, no-LOS penalty, stickiness bonus, HP weight. */
  tgtAttacker: 2.0,
  tgtNoLos: 1.2,
  tgtSticky: 0.4,
  tgtHp: 1.0,
  /** An enemy that damaged us within this many seconds counts as an attacker. */
  attackerS: 6,
  /** Engage non-attackers only at or above this HP fraction (unless they are weak or close). */
  engageHp: 0.0,
  /** ...or when they are below this HP fraction (finish them), or closer than this (m). */
  finishHp: 0.35,
  closeEngage: 0,
  /** Heal: with no attacker and HP below this, hold fire on passive targets, crates and NPCs. */
  healHp: 0.0,
  /** Hunt: with no target and HP at or above this, path toward remembered enemies / sounds. */
  huntHp: 0.6,
  /** Hunt: forget remembered enemy positions after this many seconds. */
  huntMemS: 40,
  /** Hunt: stop hunting at this match time (everyone hunts us after ~330 s). */
  huntUntil: 330,
  /** Torso scan amplitude (rad) while hunting/travelling. */
  scanAmp: 0.9,
  /** Supply drops: go capture one within this range (m); 0 = off. Arrive no earlier than this before landing (s). */
  dropRange: 0,
  dropEarlyS: 4,
  /** ...also while fighting when the drop is this close (m). */
  dropFightRange: 90,
  /** Focus: extra score bonus for the current target per unit of HP it has lost (finish what we started). */
  tgtFocus: 2,
  /** Preferred range (m) vs passive (non-attacking) targets: with lightning / gun only; 0 = same as attackers. */
  passiveRangeL: 22,
  passiveRangeG: 20,
  /** Loot memory: remembered weapon pickups within this range (m) while slot 1 is empty (0 = off: visible only). */
  lootMemRange: 320,
  /** ...in FFA mode (detected): long trips across a map full of campers are risky. */
  ffaLootRange: 320,
  /** While slot 1 is empty and a weapon is known: ignore passive targets farther than this (m). */
  lootFirstIgnore: 40,
  /** Spin the torso this long at the start (s) to see loot all around. */
  openScanS: 2,
  /** Aim at the gun's lead point while lightning fires or a laser charges (switch to the laser aim this long before full charge). */
  gunDuringCharge: false,
  /** Lead airborne targets with gravity (jetting ones at constant rise), floor at the surface below them. */
  gravityLead: false,
  /** Boost on hunting/looting trips longer than travelBoostD m while energy is above travelBoostE (0 = off). */
  travelBoostE: 0,
  travelBoostD: 80,
  /** Crossfire: with 2+ attackers holding a line on us, step (up to this radius, m) to where at most one does (0 = off). */
  xfireR: 0,
  /** Target the attacker that hit us in the last 2 s (extra score bonus; 0 = off). */
  tgtRecentAtk: 0,
  /** Rear hit by an unseen attacker while shooting a non-attacker: drop it and face the shooter. */
  rearReveal: false,
  /** Shoot back at an NPC drone that hit us in the last 3 s, at any HP (when no mech target). */
  npcDefend: false,
  laserSwitchS: 0.12,
  /** Fight: walk over visible cubes within this range (m) while fighting (0 = off). */
  cubeGrab: 30,
  /** Give up a cube/weapon goal after this many seconds without getting 2 m closer (ban it 60 s); 0 = off. */
  lootGiveUpS: 0,
  /** Idle (not hunting): wait at the lowest-exposure spot within this radius (m; 0 = off), re-chosen every holdRefresh s. */
  holdR: 0,
  holdRefresh: 20,
  holdDistCost: 0.004,
  /** Mortar dodge: run out of the predicted splash of visible incoming shells (radius + margin m). */
  dodgeMortar: true,
  dodgeMargin: 4,
  /** Approach detector: a mech walking straight at us this long (s) counts as a threat (0 = off). */
  approachS: 0,
  /** JIT warm-up of the world/nav code at hello (ms of wall time, 0 = off). */
  warmMs: 0,
  /** Cold-start guard: skip loading the map / nav / warm-up once the process is this old (ms since start). */
  initSkipMs: 6000,
  /** A* budget per plan: expansions (deterministic; 0 = use the follower's time budget) and a wall-time safety cap (ms). */
  planExpand: 1500,
  planCapMs: 12,
  /** Duck: an enemy charging a laser at us with a clear line -> move to the nearest cover within this radius (m); 0 = off. */
  duckR: 0,
  /** Reveal: shot by an attacker we can't see within this many seconds -> face it and advance to see it (0 = off). */
  revealS: 3,
  /** Reveal: assumed attacker distance (m) when we never saw it; stop advancing this close to the estimate. */
  revealDist: 60,
  revealStop: 30,
  /** Reveal: blind gun fire at the estimate (trees don't stop shots). */
  revealFire: true,
  /**
   * Early safety posture (0 = off): before this match time, and while no FFA is detected, don't close
   * in on non-attacking mechs (no chase, no approach, no hunting); attackers are still fought, loot and
   * zone logic are unchanged. With earlySafeFinish, passive mechs are engaged only when already
   * damaged (below finishHp). 15 s, 192 paired sim seeds vs v3 (0 = v3): squad -0.03 +- 0.18,
   * HK0 -0.29 +- 0.16, FFA +1.07 +- 0.35 (deaths before the FFA takeover 13 -> 7-11 of 96).
   */
  earlySafeT: 15,
  earlySafeFinish: true,
}

/**
 * Experiment hook: MR_PARAMS='{"healHp":0.7}' overrides tunables for local sim runs (shallow merge).
 * Never set in a match container; ignored when absent or invalid.
 */
try {
  const env = typeof process !== "undefined" ? process.env?.MR_PARAMS : undefined
  if (env) Object.assign(P, JSON.parse(env))
} catch {
  // keep defaults
}
