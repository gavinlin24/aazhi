// mulberry32: tiny, seedable, and good enough to drive test data. A seed makes
// any failing generated bill reproducible from the test name alone.
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(random, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
