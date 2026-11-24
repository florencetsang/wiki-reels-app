/** Small seedable PRNG so slates and simulations are reproducible in tests. */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rng: Rng): number {
  const u = 1 - rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Marsaglia-Tsang gamma sampler (shape > 0, scale 1). */
export function gamma(rng: Rng, shape: number): number {
  if (shape < 1) return gamma(rng, shape + 1) * Math.pow(rng(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function beta(rng: Rng, a: number, b: number): number {
  const x = gamma(rng, a);
  return x / (x + gamma(rng, b));
}

/** Samples an index from softmax(values / temp); returns the index and its probability. */
export function softmaxSample(rng: Rng, values: number[], temp: number): { index: number; prob: number } {
  const max = Math.max(...values);
  const ws = values.map((v) => (Number.isFinite(v) ? Math.exp((v - max) / temp) : 0));
  const total = ws.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < ws.length; i++) {
    r -= ws[i];
    if (r <= 0 && ws[i] > 0) return { index: i, prob: ws[i] / total };
  }
  const last = ws.findLastIndex((w) => w > 0);
  return { index: last, prob: ws[last] / total };
}
