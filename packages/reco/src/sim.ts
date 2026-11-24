import type { ViewEvent } from "@wiki-reels/shared";
import { FIELD_IDS } from "@wiki-reels/shared";
import { Catalog, type CatalogItemFile, quantize } from "./catalog.ts";
import { mulberry32, normal, type Rng } from "./rng.ts";
import { SimCache } from "./score.ts";
import { buildSlate, markSlateBasis, reelsToDrop } from "./slate.ts";
import { applyEvents, initUser } from "./state.ts";
import { dot, normalize } from "./vec.ts";

export interface SyntheticCatalog {
  catalog: Catalog;
  /** Subtopic index per row. */
  subtopic: Int32Array;
  subtopicCenters: Float32Array[];
  subtopicsPerField: number;
}

const randUnit = (rng: Rng, dim: number) => normalize(Float32Array.from({ length: dim }, () => normal(rng)));

/** Clustered synthetic catalog: field -> subtopic -> items, mimicking real embedding geometry. */
export function syntheticCatalog(seed = 1, nItems = 3000, dim = 64, subtopicsPerField = 6): SyntheticCatalog {
  const rng = mulberry32(seed);
  const fields = [...FIELD_IDS];
  const fieldCenters = fields.map(() => randUnit(rng, dim));
  const subtopicCenters: Float32Array[] = [];
  fieldCenters.forEach((fc) => {
    for (let s = 0; s < subtopicsPerField; s++) {
      const noise = randUnit(rng, dim);
      subtopicCenters.push(normalize(fc.map((x, i) => x + 0.8 * noise[i])));
    }
  });
  const vectors: Float32Array[] = [];
  const subtopic = new Int32Array(nItems);
  const items: Omit<CatalogItemFile, "sc">[] = [];
  for (let i = 0; i < nItems; i++) {
    const st = Math.floor(rng() * subtopicCenters.length);
    subtopic[i] = st;
    const noise = randUnit(rng, dim);
    vectors.push(normalize(subtopicCenters[st].map((x, j) => x + 0.6 * noise[j])));
    const nPages = 2 + Math.floor(rng() * 8);
    items.push({
      id: 1000 + i,
      t: `Reel ${i}`,
      f: Math.floor(st / subtopicsPerField),
      sf: `sub-${st}`,
      l: 4,
      s: "",
      u: "",
      r: null,
      p: Array.from({ length: nPages }, (_, k): [string, string] => [`S${k}`, `k${k}`]),
      pop: rng() ** 2,
    });
  }
  const { vecs, scales } = quantize(vectors, dim);
  const catalog = new Catalog(
    {
      version: `synthetic-${seed}`,
      model: "synthetic",
      dim,
      builtAt: "",
      fields,
      items: items.map((it, i) => ({ ...it, sc: scales[i] })),
    },
    vecs,
  );
  return { catalog, subtopic, subtopicCenters, subtopicsPerField };
}

export type Policy = "reco" | "random" | "popular";

export interface SimUser {
  tastes: Float32Array[];
  /** Fields the user picks at onboarding (may be only partly right). */
  stated: number[];
}

export interface SimResult {
  policy: Policy;
  /** Mean probability of engagement over served reels, early (first 20) and late (last 50). */
  earlyEngagement: number;
  lateEngagement: number;
  likeRate: number;
  /** Mean distinct fields per 10 consecutive reels. */
  fieldsPer10: number;
  drops: number;
}

/** Engagement probability of a simulated user for an item. */
function engageProb(user: SimUser, catalog: Catalog, row: number): number {
  const e = catalog.vector(row);
  const a = Math.max(...user.tastes.map((t) => dot(t, e)));
  return 1 / (1 + Math.exp(-(a - 0.45) * 10));
}

function simulateView(user: SimUser, catalog: Catalog, row: number, rng: Rng, ts: number): { ev: ViewEvent; p: number } {
  const p = engageProb(user, catalog, row);
  const nPages = catalog.items[row].p.length + 1;
  const engaged = rng() < p;
  const pagesSeen = engaged ? Math.max(2, Math.round(nPages * (0.5 + 0.5 * rng()))) : rng() < 0.5 ? 1 : 2;
  const dwellMs = Array.from({ length: pagesSeen }, () => (engaged ? 3000 + 4000 * rng() : 300 + 1200 * rng()));
  const liked = engaged && rng() < 0.3;
  const notInterested = !engaged && rng() < 0.05;
  return {
    p,
    ev: {
      pageid: catalog.items[row].id,
      pagesSeen,
      nPages,
      dwellMs,
      liked,
      saved: false,
      shared: false,
      openedWiki: false,
      notInterested,
      lessTopic: false,
      mode: "feed",
      position: 0,
      ts,
    },
  };
}

export function makeSimUsers(sc: SyntheticCatalog, n: number, seed: number): SimUser[] {
  const rng = mulberry32(seed);
  const nFields = sc.catalog.fields.length;
  return Array.from({ length: n }, () => {
    const st1 = Math.floor(rng() * sc.subtopicCenters.length);
    const st2 = Math.floor(rng() * sc.subtopicCenters.length);
    const f1 = Math.floor(st1 / sc.subtopicsPerField);
    // One correct stated field plus one the user turns out not to care about.
    const wrong = (f1 + 1 + Math.floor(rng() * (nFields - 1))) % nFields;
    return { tastes: [sc.subtopicCenters[st1], sc.subtopicCenters[st2]], stated: [f1, wrong] };
  });
}

export function simulate(sc: SyntheticCatalog, users: SimUser[], policy: Policy, steps = 150, seed = 7): SimResult {
  const { catalog } = sc;
  const rng = mulberry32(seed);
  let early = 0;
  let late = 0;
  let likes = 0;
  let fieldsPer10 = 0;
  let windows = 0;
  let drops = 0;
  const byPop = [...catalog.items.keys()].sort((a, b) => catalog.items[b].pop - catalog.items[a].pop);

  for (const user of users) {
    const state = initUser(catalog, user.stated, 0, 0);
    const cache = new SimCache();
    const seen = new Set<number>();
    let queue: number[] = [];
    const served: number[] = [];
    let ts = 1;
    for (let step = 0; step < steps; step++) {
      if (queue.length === 0) {
        if (policy === "reco") {
          const slate = buildSlate(
            state,
            catalog,
            cache,
            { need: 5, exclude: seen, recentFields: served.slice(-2).map((r) => catalog.items[r].f) },
            rng,
          );
          markSlateBasis(state, catalog.dim);
          queue = slate.picks.map((p) => p.row);
        } else if (policy === "popular") {
          queue = byPop.filter((r) => !seen.has(catalog.items[r].id)).slice(0, 5);
        } else {
          while (queue.length < 5) {
            const r = Math.floor(rng() * catalog.size);
            if (!seen.has(catalog.items[r].id) && !queue.includes(r)) queue.push(r);
          }
        }
      }
      const row = queue.shift()!;
      seen.add(catalog.items[row].id);
      served.push(row);
      ts += 20_000;
      const { ev, p } = simulateView(user, catalog, row, rng, ts);
      if (step < 20) early += p;
      if (step >= steps - 50) late += p;
      if (ev.liked) likes++;
      if (policy === "reco") {
        const applied = applyEvents(state, catalog, [ev], ts);
        const drop = reelsToDrop(state, catalog, queue.map((r) => catalog.items[r].id), applied);
        if (drop.length) {
          drops += drop.length;
          queue = queue.filter((r) => !drop.includes(catalog.items[r].id));
        }
        cache.prune();
      }
    }
    for (let i = 0; i + 10 <= served.length; i += 10) {
      fieldsPer10 += new Set(served.slice(i, i + 10).map((r) => catalog.items[r].f)).size;
      windows++;
    }
  }
  const n = users.length;
  return {
    policy,
    earlyEngagement: early / (20 * n),
    lateEngagement: late / (50 * n),
    likeRate: likes / (steps * n),
    fieldsPer10: fieldsPer10 / windows,
    drops: drops / n,
  };
}
