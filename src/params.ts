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
}
