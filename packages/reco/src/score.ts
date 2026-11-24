import type { Catalog } from "./catalog.ts";
import { PARAMS } from "./params.ts";
import { confidence, type UserState } from "./state.ts";

/**
 * Caches catalog-wide similarity arrays per prototype vector. Each event changes
 * at most one interest and the session vector, so a request recomputes ~2 of them.
 */
export class SimCache {
  private map = new Map<string, Float32Array>();
  private version = "";
  private used = new Set<string>();

  sims(catalog: Catalog, key: string, v: ArrayLike<number>): Float32Array {
    if (catalog.version !== this.version) {
      this.map.clear();
      this.version = catalog.version;
    }
    this.used.add(key);
    let s = this.map.get(key);
    if (!s) {
      s = catalog.dotAll(v);
      this.map.set(key, s);
    }
    return s;
  }

  /** Drops entries not used since the last prune. */
  prune(): void {
    for (const k of this.map.keys()) if (!this.used.has(k)) this.map.delete(k);
    this.used.clear();
  }
}

export interface Scores {
  score: Float32Array;
  simLong: Float32Array;
  conf: number;
}

/** Collaborative score per pageid in [0, 1], e.g. from item-item co-engagement. */
export type CfScores = Map<number, number>;

const protoWeights = (ws: number[]): number[] => {
  const max = Math.max(...ws, 1e-9);
  return ws.map((w) => 0.5 + 0.5 * (w / max));
};

export function scoreAll(state: UserState, catalog: Catalog, cache: SimCache, cf?: CfScores): Scores {
  const key = (kind: string, id: number, rev: number) => `${state.createdAt}:${kind}${id}.${rev}`;
  const interests = state.interests.map((p) => cache.sims(catalog, key("i", p.id, p.rev), p.v));
  const iw = protoWeights(state.interests.map((p) => p.w));
  const negatives = state.negatives.map((p) => cache.sims(catalog, key("n", p.id, p.rev), p.v));
  const nw = protoWeights(state.negatives.map((p) => p.w));
  const session = state.session.v ? cache.sims(catalog, key("s", 0, state.session.rev), state.session.v) : null;

  const conf = confidence(state);
  const w = {
    topic: 0.35 * (1 - conf) + 0.1,
    long: 0.3 * conf + 0.1,
    sess: 0.2,
    cf: 0.1,
    pop: 0.1 * (1 - conf) + 0.02,
    quality: 0.05,
    neg: 0.3,
  };
  const topicMean = state.beta.map(([a, b]) => a / (a + b));
  const n = catalog.size;
  const score = new Float32Array(n);
  const simLong = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    const it = catalog.items[r];
    let long = 0;
    for (let k = 0; k < interests.length; k++) long = Math.max(long, interests[k][r] * iw[k]);
    let neg = 0;
    for (let k = 0; k < negatives.length; k++) neg = Math.max(neg, negatives[k][r] * nw[k]);
    simLong[r] = long;
    score[r] =
      w.topic * topicMean[it.f] +
      w.long * long +
      w.sess * (session ? session[r] : 0) +
      w.cf * (cf?.get(it.id) ?? 0) +
      w.pop * it.pop +
      w.quality * Math.min(1, it.p.length / 8) -
      w.neg * neg;
  }
  return { score, simLong, conf };
}

export const exploreRate = (conf: number, topicMode: boolean): number =>
  topicMode ? PARAMS.topicExplore : PARAMS.exploreStart - (PARAMS.exploreStart - PARAMS.exploreEnd) * conf;
