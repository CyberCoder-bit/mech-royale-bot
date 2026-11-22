/** Bot factory. Keep ALL mutable state inside the instance returned by makeBot (the simulator runs many bots in one process). */
import { type Action, draw, type Hello, type Observation, type Bot } from "./mechfight.ts"

const dist = (a: number[], b: number[]) => Math.hypot(b[0] - a[0], b[1] - a[1])

export function makeBot(hello: Hello): Bot {
  return {
    name: "example-ts",
    act(obs: Observation) {
      const me = obs.self
      const [x, y, z] = me.pos
      const goal = obs.zone.next_center
      const yaw = Math.atan2(goal[1] - y, goal[0] - x)
      const act: Omit<Action, "tick"> = { move: [Math.cos(yaw), Math.sin(yaw)], aim: [yaw, 0], boost: !me.in_zone, jump: obs.tick % 40 === 0 }
      if (obs.offer) act.pick = 0
      const near = obs.pickups.find((p) => dist(p.pos, me.pos) < hello.config.loot.pickup_radius && p.kind !== "gun")
      if (!me.weapons[1] && near) act.take = near.id
      const enemy = obs.mechs.filter((m) => m.kind === "mech").sort((a, b) => dist(a.pos, me.pos) - dist(b.pos, me.pos))[0]
      if (enemy) {
        const t = enemy.pos
        act.aim = [Math.atan2(t[1] - y, t[0] - x), Math.atan2(t[2] - z - 2.5, dist(t, me.pos))]
        act.fire = [true, true]
        draw.line([x, y, z + 7], [t[0], t[1], t[2] + 4.5], "#ff5040")
      }
      return act
    },
  }
}
