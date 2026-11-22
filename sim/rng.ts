/** Small deterministic RNG (sfc32) with helpers. */
export class Rng {
  private a: number
  private b: number
  private c: number
  private d: number
  constructor(seed: number) {
    // splitmix-style seeding
    let s = seed >>> 0
    const next = () => {
      s = (s + 0x9e3779b9) >>> 0
      let z = s
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0
      return (z ^ (z >>> 16)) >>> 0
    }
    this.a = next()
    this.b = next()
    this.c = next()
    this.d = next()
    for (let i = 0; i < 12; i++) this.u32()
  }
  u32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0
    this.d = (this.d + 1) >>> 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) >>> 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.c = (this.c + t) >>> 0
    return t
  }
  /** [0,1) */
  next(): number {
    return this.u32() / 4294967296
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next()
  }
  int(n: number): number {
    return Math.floor(this.next() * n)
  }
  pick<T>(a: T[]): T {
    return a[Math.floor(this.next() * a.length)]
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  private spare: number | null = null
  gauss(): number {
    if (this.spare !== null) {
      const s = this.spare
      this.spare = null
      return s
    }
    let u = 0,
      v = 0,
      s = 0
    do {
      u = this.next() * 2 - 1
      v = this.next() * 2 - 1
      s = u * u + v * v
    } while (s >= 1 || s === 0)
    const m = Math.sqrt((-2 * Math.log(s)) / s)
    this.spare = v * m
    return u * m
  }
  shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      const t = a[i]
      a[i] = a[j]
      a[j] = t
    }
    return a
  }
}

/** mix integers into a seed */
export function hashSeed(...xs: number[]): number {
  let h = 0x811c9dc5
  for (const x of xs) {
    h ^= x >>> 0
    h = Math.imul(h, 0x01000193) >>> 0
    h ^= h >>> 15
  }
  return h >>> 0
}
