export type Vec = Float32Array;

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function normalize(v: Float32Array): Float32Array {
  const n = Math.sqrt(dot(v, v));
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** out = a*x + b*y, normalized. */
export function mix(x: ArrayLike<number>, a: number, y: ArrayLike<number>, b: number): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = a * x[i] + b * y[i];
  return normalize(out);
}

export function weightedMean(vs: ArrayLike<number>[], ws: number[], dim: number): Float32Array {
  const out = new Float32Array(dim);
  vs.forEach((v, k) => {
    for (let i = 0; i < dim; i++) out[i] += ws[k] * v[i];
  });
  return normalize(out);
}

export const toArray = (v: Float32Array): number[] => Array.from(v, (x) => Math.round(x * 1e6) / 1e6);
