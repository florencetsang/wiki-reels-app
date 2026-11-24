import type { Reason } from "@wiki-reels/shared";
import type { Catalog } from "./catalog.ts";
import { PARAMS } from "./params.ts";
import { beta as sampleBeta, type Rng, softmaxSample } from "./rng.ts";
import { type CfScores, exploreRate, scoreAll, type SimCache } from "./score.ts";
import { profileVector, type UserState } from "./state.ts";
import type { AppliedEvent } from "./state.ts";
import { dot } from "./vec.ts";

export interface SlatePick {
  row: number;
  pageid: number;
  reason: Reason;
  /** Probability this reel was chosen for its slot, for inverse-propensity weighting. */
  prob: number;
  explore: boolean;
}

export interface SlateRequest {
  need: number;
  /** Pageids never to serve: seen, queued on the client, pending. */
  exclude: Set<number>;
  /** Topic feed: restrict to this field index. */
  field?: number;
  /** Fields of the reels just before this slate (oldest first), for the same-field run limit. */
  recentFields?: number[];
  cf?: CfScores;
}

export interface Slate {
  picks: SlatePick[];
  notice?: "field-exhausted" | "catalog-exhausted";
}

export function buildSlate(
  state: UserState,
  catalog: Catalog,
  cache: SimCache,
  req: SlateRequest,
  rng: Rng,
): Slate {
  const topicMode = req.field !== undefined;
  const hidden = new Set(state.hiddenFields);
  const cooling = Object.entries(state.cooldown ?? {})
    .filter(([, until]) => state.nInteractions < until)
    .map(([f]) => Number(f));
  if (new Set([...hidden, ...cooling]).size < catalog.fields.length) cooling.forEach((f) => hidden.add(f));
  const eligible = (row: number) => {
    const it = catalog.items[row];
    if (req.exclude.has(it.id) || it.p.length === 0) return false;
    return topicMode ? it.f === req.field : !hidden.has(it.f);
  };

  const { score, simLong, conf } = scoreAll(state, catalog, cache, req.cf);
  const candidates: number[] = [];
  for (let r = 0; r < catalog.size; r++) if (eligible(r)) candidates.push(r);
  candidates.sort((a, b) => score[b] - score[a]);

  const picks: SlatePick[] = [];
  const chosen = new Set<number>();
  const fieldsSoFar = [...(req.recentFields ?? [])];
  const eps = exploreRate(conf, topicMode);
  const want = Math.min(req.need, candidates.length);
  const pool = candidates.slice(0, PARAMS.poolSize);

  while (picks.length < want) {
    let pick: SlatePick | null = null;
    if (!topicMode && rng() < eps) pick = explorePick(state, catalog, simLong, chosen, eligible, hidden, rng, eps);
    pick ??= exploitPick(state, catalog, score, pool, chosen, fieldsSoFar, rng, 1 - (topicMode ? 0 : eps), req.field);
    if (pick && !topicMode && breaksRun(fieldsSoFar, catalog.items[pick.row].f)) {
      // The pool is all one field: take the best candidate from another field instead.
      const alt = candidates.find((r) => !chosen.has(r) && !breaksRun(fieldsSoFar, catalog.items[r].f));
      if (alt !== undefined) {
        pick = { row: alt, pageid: catalog.items[alt].id, reason: exploitReason(state, catalog, alt), prob: 1 - eps, explore: false };
      }
    }
    if (!pick) {
      // Pool used up: refill from the remaining candidates.
      const rest = candidates.filter((r) => !chosen.has(r)).slice(0, PARAMS.poolSize);
      if (rest.length === 0) break;
      pool.splice(0, pool.length, ...rest);
      continue;
    }
    picks.push(pick);
    chosen.add(pick.row);
    fieldsSoFar.push(catalog.items[pick.row].f);
    const i = pool.indexOf(pick.row);
    if (i >= 0) pool.splice(i, 1);
  }

  const notice = picks.length < req.need ? (topicMode ? "field-exhausted" : "catalog-exhausted") : undefined;
  return { picks, notice };
}

/** True if adding a reel of this field makes more than maxSameFieldRun in a row. */
function breaksRun(fieldsSoFar: number[], field: number): boolean {
  const run = fieldsSoFar.slice(-PARAMS.maxSameFieldRun);
  return run.length === PARAMS.maxSameFieldRun && run.every((f) => f === field);
}

function exploitPick(
  state: UserState,
  catalog: Catalog,
  score: Float32Array,
  pool: number[],
  chosen: Set<number>,
  fieldsSoFar: number[],
  rng: Rng,
  slotProb: number,
  topicField?: number,
): SlatePick | null {
  if (pool.length === 0) return null;
  const adjusted = pool.map((r) => {
    if (topicField === undefined && breaksRun(fieldsSoFar, catalog.items[r].f)) return -Infinity;
    let maxSim = 0;
    for (const c of chosen) maxSim = Math.max(maxSim, catalog.dotRows(r, c));
    return score[r] - PARAMS.mmrPenalty * maxSim;
  });
  if (adjusted.every((v) => v === -Infinity)) adjusted.fill(0);
  const { index, prob } = softmaxSample(rng, adjusted, PARAMS.exploitTemp);
  const row = pool[index];
  return { row, pageid: catalog.items[row].id, reason: exploitReason(state, catalog, row, topicField), prob: prob * slotProb, explore: false };
}

function explorePick(
  state: UserState,
  catalog: Catalog,
  simLong: Float32Array,
  chosen: Set<number>,
  eligible: (row: number) => boolean,
  hidden: Set<number>,
  rng: Rng,
  eps: number,
): SlatePick | null {
  // Thompson sampling over fields.
  let field = -1;
  let best = -Infinity;
  state.beta.forEach(([a, b], f) => {
    if (hidden.has(f) || catalog.fieldRows[f].length === 0) return;
    const s = sampleBeta(rng, a, b);
    if (s > best) [field, best] = [f, s];
  });
  if (field < 0) return null;
  const rows = catalog.fieldRows[field].filter((r) => eligible(r) && !chosen.has(r));
  if (rows.length === 0) return null;
  // Popular reels the user's interests don't already cover.
  const top = rows.map((r) => ({ r, v: catalog.items[r].pop - 0.5 * simLong[r] })).sort((a, b) => b.v - a.v).slice(0, 30);
  const { index, prob } = softmaxSample(rng, top.map((x) => x.v), PARAMS.exploreTemp);
  const row = top[index].r;
  return {
    row,
    pageid: catalog.items[row].id,
    reason: state.chosenFields.includes(field) ? { kind: "picked" } : { kind: "explore" },
    prob: eps * thompsonShare(state, field, hidden) * prob,
    explore: true,
  };
}

/** Approximates P(Thompson picks field) by its share of Beta means. */
function thompsonShare(state: UserState, field: number, hidden: Set<number>): number {
  let total = 0;
  state.beta.forEach(([a, b], f) => {
    if (!hidden.has(f)) total += a / (a + b);
  });
  const [a, b] = state.beta[field];
  return a / (a + b) / total;
}

function exploitReason(state: UserState, catalog: Catalog, row: number, topicField?: number): Reason {
  if (topicField !== undefined) return { kind: "topic" };
  let anchor: string | undefined;
  let best = PARAMS.similarReasonSim;
  for (const id of state.recentPositive) {
    const r = catalog.rowOf(id);
    if (r === undefined || r === row) continue;
    const s = catalog.dotRows(row, r);
    if (s > best) [best, anchor] = [s, catalog.items[r].t];
  }
  if (anchor) return { kind: "similar", anchor };
  if (state.chosenFields.includes(catalog.items[row].f)) return { kind: "picked" };
  return { kind: "popular" };
}

/**
 * Queued reels to discard after this request's events: all but the next one when
 * the profile drifted, plus any close to something the user just rejected.
 */
export function reelsToDrop(
  state: UserState,
  catalog: Catalog,
  queued: number[],
  applied: AppliedEvent[],
): number[] {
  const drop = new Set<number>();
  const now = profileVector(state, catalog.dim);
  if (state.slateBasis && now && dot(state.slateBasis, now) < PARAMS.driftCos) {
    queued.slice(1).forEach((id) => drop.add(id));
  }
  for (const a of applied) {
    if (!a.event.notInterested && !a.event.lessTopic) continue;
    const bad = catalog.rowOf(a.event.pageid);
    if (bad === undefined) continue;
    for (const id of queued) {
      const r = catalog.rowOf(id);
      if (r === undefined) continue;
      const sameField = catalog.items[r].f === catalog.items[bad].f;
      if ((a.event.lessTopic && sameField) || catalog.dotRows(r, bad) > PARAMS.dislikeDropSim) drop.add(id);
    }
  }
  return queued.filter((id) => drop.has(id));
}

/** Records the profile a queue was built for; call after serving a slate. */
export function markSlateBasis(state: UserState, dim: number): void {
  state.slateBasis = profileVector(state, dim);
}
