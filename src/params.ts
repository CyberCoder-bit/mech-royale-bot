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
  lootWeaponRange: 90,
  /** Zone: aim to be inside the next circle by margin = clamp(r * frac, min, max). */
  zoneMarginFrac: 0.25,
  zoneMarginMin: 6,
  zoneMarginMax: 40,
  /** FFA detector: deaths not caused by us beyond this slack switch to FFA mode. */
  ffaSlack: 1,

  // ---------------- v1 (map-aware) parameters
  /** Map model on/off (off = v1 logic with straight-line movement and no LOS gates). */
  useWorld: true,
  /** Jink timing in fights (house bots apply ~75% lead; flips every 0.3-0.5 s beat it). */
  fightJinkMin: 0.3,
  fightJinkRand: 0.35,
  /** Preferred fight range (m) by primary weapon, v1. */
  v1Range: { lightning: 22, laser: 115, mortar: 120, gunWithLightning: 35, gun: 95 },
  /** Retreat to cover below this HP fraction unless the target is weaker by retreatMargin. */
  v1RetreatHp: 0.4,
  /**
   * Heal (hide and regen) when no target is visible and HP fraction is below this. Off in squad
   * mode: sim A/B (32 paired seeds) 2.56 -> 4.00 points without it (hunters find us anyway).
   */
  healHp: 0,
  /** Stop healing at this HP fraction. */
  healDoneHp: 0.985,
  /** Fight near a cover point: max cover search radius and the leash to it while fighting (m). */
  coverSearch: 24,
  coverLeash: 13,
  /** Duck to cover when an enemy laser charging at us is visible and cover is this close (m). */
  duckLaserDist: 14,
  /** Duck when all our weapons are unavailable for at least this long (s). */
  duckReloadS: 0.7,
  /** Retreat/heal cover search radius (m). */
  retreatSearch: 50,
  /** Remember enemies for heal/cover decisions this long (s). */
  threatMemory: 12,
  /** FFA: engage only targets that attack us, are weak (< this HP fraction) or close (< ffaCloseRange). */
  ffaWeakHp: 0.45,
  ffaCloseRange: 45,
  /** Climb energy per meter = jet_drain / effective rise speed (8.9 m/s) */
  jetRiseSpeed: 8.9,
  /** Fight range band [min, max] (m) by primary weapon: approach beyond max, back off inside min, else strafe. */
  v1Band: { lightning: [8, 32], laser: [60, 190], mortar: [60, 190], gunWithLightning: [15, 90], gun: [55, 125] } as Record<string, [number, number]>,
  /** Keep the fight going this long (s) after losing sight of the target: duck, reload, peek back. */
  peekS: 4,
  /** Below this target HP fraction never duck (crossfire/reload): finish it. */
  finishHp: 0.25,
  /** Search radius (m) for a spot with a clear shot when the target ducks out of sight. */
  peekSearch: 18,
  /** Chase a wounded enemy (HP fraction below pursueHp) seen within pursueS seconds if we have pursueMinHp. */
  pursueHp: 0.35,
  pursueMinHp: 0.45,
  pursueS: 10,
  /** Loot: remembered weapon pickups within this range (m) early (t < lootEarlyT s), else lootWeaponRange. */
  lootWeaponRangeEarly: 170,
  lootEarlyT: 45,
  /** Spin the torso this long at the start to see loot all around (s). */
  openScanS: 2,
  /** Go capture a landed, uncontested supply drop within this range (m) when nobody is in view. */
  dropRange: 140,
  /** Idle: wait at a low-exposure spot within holdRadius (m), re-chosen every holdRefresh s; distance cost per m. */
  holdRadius: 45,
  holdRefresh: 25,
  holdDistCost: 0.004,
  /** Retreat to cover when at least this many enemies have a clear line to us. */
  crossfireN: 2,
  /** Overrides applied once FFA (the final's format) is detected: avoid fights, hide and heal. */
  ffaOverrides: { healHp: 0.9 } as Record<string, unknown>,
  /** Seek remembered NPC drones (2 cubes each) within this range (m) when healthy and idle. 0 = off. */
  npcSeekRange: 0,
  /** Idle (no threat, no sound): spin the torso this far ahead each decision (rad; 0 = sweep around the move direction). */
  idleSpin: 0,
  /** Hold spots may be reachable roofs (jet up when nobody is around). */
  holdRoofs: false,
  /** At a hold spot, watch the open side (exposure map cover mask) instead of sweeping around. */
  holdFaceOpen: false,
  /** Pre-charge the laser when an enemy was seen within 1.5 s inside this range (m), for a full first shot. 0 = off. */
  preChargeRange: 0,
  /** Dodge a mortar shell whose predicted impact is within splash radius + this margin (m). */
  shellMargin: 3,
  /** Wall-time cap (ms) of the JIT warm-up at hello (synthetic decisions). */
  warmMs: 700,
  /** Soft per-tick compute budget (ms) for optional work (replans, cover searches), and the A* cap per plan. */
  tickBudgetMs: 9,
  planMs: 4,
  /** Draw the path and cover point (debug, team only). */
  debugDraw: true,
}

/**
 * Experiment hook: MR_PARAMS='{"healHp":0}' overrides tunables for local sim runs (shallow merge).
 * Never set in a match container; ignored when absent or invalid.
 */
try {
  const env = typeof process !== "undefined" ? process.env?.MR_PARAMS : undefined
  if (env) Object.assign(P, JSON.parse(env))
} catch {
  // keep defaults
}
