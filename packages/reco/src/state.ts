import type { ViewEvent } from "@wiki-reels/shared";
import type { Catalog } from "./catalog.ts";
import { PARAMS } from "./params.ts";
import { computeReward } from "./reward.ts";
import { dot, mix, normalize, toArray, weightedMean } from "./vec.ts";

export interface Proto {
  id: number;
  /** Bumped whenever v changes; used as a similarity-cache key. */
  rev: number;
  v: number[];
  w: number;
}

/** Per-user recommender state; JSON-serializable, stored in the user's Durable Object. */
export interface UserState {
  schema: 1;
  profileVersion: number;
  createdAt: number;
  onboarded: boolean;
  chosenFields: number[];
  hiddenFields: number[];
  /** Field index -> nInteractions until which the field is skipped in the main feed ("less like this topic"). */
  cooldown?: Record<number, number>;
  /** Beta(alpha, beta) interest per field index. */
  beta: [number, number][];
  interests: Proto[];
  negatives: Proto[];
  session: { v: number[] | null; rev: number; lastAt: number };
  /** Profile vector when the client's queue was last filled; used for drift checks. */
  slateBasis: number[] | null;
  nInteractions: number;
  /** Most recent positively-rated pageids, newest last. */
  recentPositive: number[];
  nextId: number;
  /** Stable 0-99 bucket for A/B tests. */
  bucket: number;
}

export interface AppliedEvent {
  event: ViewEvent;
  reward: number;
  effective: number;
  explicit: boolean;
  field: number | null;
}

const RECENT_POSITIVE = 10;

export function initUser(catalog: Catalog, chosenFields: number[], now: number, bucket = 0): UserState {
  const nFields = catalog.fields.length;
  const chosen = [...new Set(chosenFields)].filter((f) => f >= 0 && f < nFields);
  const state: UserState = {
    schema: 1,
    profileVersion: 1,
    createdAt: now,
    onboarded: true,
    chosenFields: chosen,
    hiddenFields: [],
    beta: Array.from({ length: nFields }, (_, f): [number, number] =>
      chosen.length === 0 ? [1, 1] : chosen.includes(f) ? [3, 1] : [1, 2],
    ),
    interests: [],
    negatives: [],
    session: { v: null, rev: 0, lastAt: now },
    slateBasis: null,
    nInteractions: 0,
    recentPositive: [],
    nextId: 1,
    bucket,
  };
  seedInterests(state, catalog, chosen, 1);
  state.session.v = profileVector(state, catalog.dim);
  return state;
}

function seedInterests(state: UserState, catalog: Catalog, fields: number[], w: number): void {
  for (const f of fields) {
    if (catalog.fieldRows[f]?.length) {
      state.interests.push({ id: state.nextId++, rev: 0, v: toArray(catalog.fieldCentroid(f)), w });
    }
  }
  trim(state.interests, PARAMS.maxInterests);
}

export function confidence(state: UserState): number {
  return 1 - Math.exp(-state.nInteractions / PARAMS.confidenceScale);
}

/** Weighted mean of long-term interests plus the session vector; null for an empty profile. */
export function profileVector(state: UserState, dim: number): number[] | null {
  const vs: ArrayLike<number>[] = state.interests.map((p) => p.v);
  const ws = state.interests.map((p) => p.w);
  if (state.session.v) {
    vs.push(state.session.v);
    ws.push(Math.max(1, ...ws));
  }
  if (vs.length === 0) return null;
  return toArray(weightedMean(vs, ws, dim));
}

/** Applies events in order and returns their rewards for logging. */
export function applyEvents(state: UserState, catalog: Catalog, events: ViewEvent[], now: number): AppliedEvent[] {
  const out: AppliedEvent[] = [];
  for (const event of [...events].sort((a, b) => a.ts - b.ts)) {
    out.push(applyEvent(state, catalog, event, now));
  }
  return out;
}

function applyEvent(state: UserState, catalog: Catalog, event: ViewEvent, now: number): AppliedEvent {
  const { r, sw, explicit } = computeReward(event);
  const eff = r * sw * (event.mode === "topic" ? PARAMS.topicModeFactor : 1);
  const row = catalog.rowOf(event.pageid);
  const applied: AppliedEvent = { event, reward: r, effective: eff, explicit, field: null };
  if (row === undefined) return applied;

  const field = catalog.items[row].f;
  applied.field = field;
  const e = catalog.vector(row);
  state.nInteractions += 1;

  if (now - state.session.lastAt > PARAMS.sessionTimeoutMs) {
    state.session.v = longTermVector(state, catalog.dim);
    state.session.rev += 1;
  }
  state.session.lastAt = now;

  if (eff > 0) {
    state.session.v = toArray(
      state.session.v ? mix(state.session.v, 1 - PARAMS.sessionLr, e, PARAMS.sessionLr * eff) : normalize(e.slice()),
    );
    state.session.rev += 1;
    state.recentPositive = [...state.recentPositive.filter((id) => id !== event.pageid), event.pageid].slice(
      -RECENT_POSITIVE,
    );
  }

  const b = state.beta[field];
  b[0] += Math.max(eff, 0);
  b[1] += Math.max(-eff, 0);
  if (event.lessTopic) lessOfField(state, catalog, field);

  if (eff > 0) {
    addToProtos(state, state.interests, e, eff, PARAMS.maxInterests, PARAMS.interestLr);
  } else if (eff <= PARAMS.negativeThreshold) {
    addToProtos(state, state.negatives, e, -eff, PARAMS.maxNegatives, 0.2);
  }

  for (const list of [state.interests, state.negatives]) {
    for (const p of list) p.w *= PARAMS.decay;
  }
  state.interests = state.interests.filter((p) => p.w >= PARAMS.pruneWeight);
  state.negatives = state.negatives.filter((p) => p.w >= PARAMS.pruneWeight);
  return applied;
}

/** "Less like this topic": an explicit, field-wide signal that also weakens interests in that field. */
function lessOfField(state: UserState, catalog: Catalog, field: number): void {
  state.chosenFields = state.chosenFields.filter((f) => f !== field);
  state.cooldown = { ...state.cooldown, [field]: state.nInteractions + PARAMS.lessTopicCooldown };
  const b = state.beta[field];
  b[1] = Math.max(b[1] + PARAMS.lessTopicPenalty, 3 * b[0]);
  const centroid = catalog.fieldCentroid(field);
  for (const p of state.interests) {
    if (dot(p.v, centroid) > 0.5) {
      p.w *= 0.3;
      p.rev += 1;
    }
  }
  if (state.session.v) {
    state.session.v = toArray(normalize(mix(state.session.v, 1, centroid, -0.5)));
    state.session.rev += 1;
  }
}

function addToProtos(state: UserState, list: Proto[], e: Float32Array, w: number, max: number, lr: number): void {
  let best = -1;
  let bestSim = -Infinity;
  list.forEach((p, i) => {
    const s = dot(p.v, e);
    if (s > bestSim) [best, bestSim] = [i, s];
  });
  if (best >= 0 && bestSim > PARAMS.interestMergeSim) {
    const p = list[best];
    p.v = toArray(mix(p.v, 1, e, lr * w));
    p.w += w;
    p.rev += 1;
    return;
  }
  list.push({ id: state.nextId++, rev: 0, v: toArray(normalize(e.slice())), w });
  trim(list, max);
}

function trim(list: Proto[], max: number): void {
  while (list.length > max) {
    let weakest = 0;
    list.forEach((p, i) => {
      if (p.w < list[weakest].w) weakest = i;
    });
    list.splice(weakest, 1);
  }
}

function longTermVector(state: UserState, dim: number): number[] | null {
  if (state.interests.length === 0) return null;
  return toArray(
    weightedMean(
      state.interests.map((p) => p.v),
      state.interests.map((p) => p.w),
      dim,
    ),
  );
}

/**
 * "Edit my topics": keeps 20% of the learned evidence and makes the new topics
 * dominate again by lowering confidence.
 */
export function softReset(state: UserState, catalog: Catalog, fields: number[], now: number): UserState {
  const next: UserState = structuredClone(state);
  const chosen = [...new Set(fields)].filter((f) => f >= 0 && f < catalog.fields.length);
  next.profileVersion += 1;
  next.chosenFields = chosen;
  next.hiddenFields = next.hiddenFields.filter((f) => !chosen.includes(f));
  next.beta = next.beta.map(([a, b]) => [1 + 0.2 * (a - 1), 1 + 0.2 * (b - 1)]);
  // Newly chosen topics must outrank anything learned before the reset.
  const maxAlpha = Math.max(...next.beta.map(([a]) => a));
  for (const f of chosen) next.beta[f][0] = Math.max(next.beta[f][0] + 2, maxAlpha + 1);
  next.interests = next.interests.map((p) => ({ ...p, w: p.w * 0.2 }));
  next.negatives = next.negatives.map((p) => ({ ...p, w: p.w * 0.5 }));
  // Drop learned interests first so the new topic seeds fit.
  next.interests.sort((a, b) => b.w - a.w);
  next.interests = next.interests.slice(0, Math.max(0, PARAMS.maxInterests - chosen.length));
  seedInterests(next, catalog, chosen, 1);
  next.nInteractions = Math.floor(next.nInteractions * 0.2);
  next.cooldown = undefined;
  next.session = { v: null, rev: next.session.rev + 1, lastAt: now };
  next.session.v = chosen.length
    ? toArray(weightedMean(chosen.map((f) => catalog.fieldCentroid(f)), chosen.map(() => 1), catalog.dim))
    : longTermVector(next, catalog.dim);
  next.slateBasis = null;
  next.recentPositive = [];
  return next;
}

/** "Start over": a fresh profile that goes through onboarding again; the caller keeps the old one for undo. */
export function hardReset(state: UserState, catalog: Catalog, now: number): UserState {
  const next = initUser(catalog, [], now, state.bucket);
  next.profileVersion = state.profileVersion + 1;
  next.hiddenFields = [...state.hiddenFields];
  next.onboarded = false;
  return next;
}

/** Onboarding for an existing (e.g. hard-reset) profile keeps its version, bucket and hidden fields. */
export function onboard(prev: UserState | null, catalog: Catalog, fields: number[], now: number, bucket: number): UserState {
  const next = initUser(catalog, fields, now, prev?.bucket ?? bucket);
  if (prev) {
    next.profileVersion = prev.profileVersion;
    next.hiddenFields = prev.hiddenFields.filter((f) => !next.chosenFields.includes(f));
    next.nextId = Math.max(next.nextId, prev.nextId);
  }
  return next;
}
