/** mulberry32: tiny seeded PRNG so every simulated run can be replayed from its seed. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
export const between = (rng: () => number, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
