import {
  applyEvents,
  buildSlate,
  type Catalog,
  type CfScores,
  hardReset,
  markSlateBasis,
  mulberry32,
  onboard,
  reelsToDrop,
  SimCache,
  softReset,
  type UserState,
} from "@wiki-reels/reco";
import {
  type FeedRequest,
  type FeedResponse,
  fieldIndex,
  type LibraryItem,
  type LibraryResponse,
  type ProfileResponse,
  type Reason,
} from "@wiki-reels/shared";
import { type Coeng, toCard } from "./catalog.ts";
import type { EventLog } from "./env.ts";

export interface Served {
  pageid: number;
  reason: Reason;
  prob: number;
  explore: boolean;
  at: number;
}

export type LibraryKind = "saved" | "liked";

/** Persistence used by FeedService; implemented on Durable Object SQLite and in memory for tests. */
export interface UserStore {
  getState(): UserState | null;
  putState(state: UserState): void;
  getArchive(): { state: UserState; at: number } | null;
  putArchive(state: UserState | null, at: number): void;
  seenIds(): Set<number>;
  markSeen(pageid: number, at: number, reward: number): void;
  history(limit: number): { pageid: number; at: number; reward: number }[];
  putServed(items: Served[]): void;
  takeServed(pageid: number): Served | undefined;
  setLibrary(pageid: number, kind: LibraryKind, on: boolean, at: number): void;
  library(kind: LibraryKind, limit: number): { pageid: number; at: number }[];
}

export interface FeedContext {
  userId: string;
  catalog: Catalog;
  coeng: Coeng;
  imageBase: string;
  now: number;
  seed?: number;
}

const UNDO_WINDOW_MS = 7 * 24 * 3600 * 1000;
const fieldIndices = (ids: string[]) => ids.map(fieldIndex).filter((i) => i >= 0);

export class FeedService {
  // Similarity arrays survive across requests while the Durable Object stays in memory.
  private readonly cache = new SimCache();

  constructor(
    private readonly store: UserStore,
    private readonly bucket: number,
  ) {}

  profile(catalog: Catalog, now: number): ProfileResponse {
    const s = this.store.getState();
    const archive = this.store.getArchive();
    return {
      onboarded: s?.onboarded ?? false,
      chosenFields: (s?.chosenFields ?? []).map((f) => catalog.fields[f]),
      hiddenFields: (s?.hiddenFields ?? []).map((f) => catalog.fields[f]),
      fieldInterest: Object.fromEntries(
        catalog.fields.map((id, f) => {
          const [a, b] = s?.beta[f] ?? [1, 1];
          return [id, Math.round((a / (a + b)) * 100) / 100];
        }),
      ),
      interactions: s?.nInteractions ?? 0,
      canUndoReset: !!archive && now - archive.at < UNDO_WINDOW_MS,
    };
  }

  onboard(catalog: Catalog, fields: string[], now: number): void {
    const state = onboard(this.store.getState(), catalog, fieldIndices(fields), now, this.bucket);
    this.store.putState(state);
  }

  setHidden(catalog: Catalog, fields: string[]): void {
    const s = this.requireState(catalog, Date.now());
    s.hiddenFields = fieldIndices(fields);
    this.store.putState(s);
  }

  reset(catalog: Catalog, mode: "soft" | "hard" | "undo", fields: string[] | undefined, now: number): void {
    const s = this.requireState(catalog, now);
    if (mode === "undo") {
      const archive = this.store.getArchive();
      if (!archive || now - archive.at >= UNDO_WINDOW_MS) throw new Error("nothing to undo");
      this.store.putState({ ...archive.state, profileVersion: s.profileVersion + 1 });
      this.store.putArchive(null, now);
      return;
    }
    this.store.putArchive(s, now);
    const next =
      mode === "soft" ? softReset(s, catalog, fieldIndices(fields ?? []), now) : hardReset(s, catalog, now);
    this.store.putState(next);
  }

  /** Applies events, then returns the next reels; one round trip per interaction. */
  feed(ctx: FeedContext, req: FeedRequest): { response: FeedResponse; logs: EventLog[] } {
    const { catalog, now } = ctx;
    const state = this.requireState(catalog, now);
    const applied = applyEvents(state, catalog, req.events, now);

    const logs: EventLog[] = applied.map((a) => {
      const served = this.store.takeServed(a.event.pageid);
      this.store.markSeen(a.event.pageid, a.event.ts, a.reward);
      if (a.event.liked) this.store.setLibrary(a.event.pageid, "liked", true, a.event.ts);
      if (a.event.saved) this.store.setLibrary(a.event.pageid, "saved", true, a.event.ts);
      return {
        userId: ctx.userId,
        profileVersion: state.profileVersion,
        bucket: state.bucket,
        catalogVersion: catalog.version,
        pageid: a.event.pageid,
        field: a.field === null ? null : catalog.fields[a.field],
        ts: a.event.ts,
        reward: a.reward,
        effective: a.effective,
        explicit: a.explicit,
        pagesSeen: a.event.pagesSeen,
        nPages: a.event.nPages,
        dwellMs: Math.round(a.event.dwellMs.reduce((x, y) => x + y, 0)),
        liked: a.event.liked,
        saved: a.event.saved,
        notInterested: a.event.notInterested,
        lessTopic: a.event.lessTopic,
        mode: a.event.mode,
        position: a.event.position,
        reason: served?.reason.kind ?? null,
        prob: served?.prob ?? null,
        explore: served?.explore ?? null,
      };
    });

    const viewed = new Set(req.events.map((e) => e.pageid));
    const queued = req.queued.filter((id) => !viewed.has(id));
    const drop = reelsToDrop(state, catalog, queued, applied);
    const kept = queued.filter((id) => !drop.includes(id));
    const need = req.need > 0 ? req.need + drop.length : 0;

    const response: FeedResponse = { reels: [], drop };
    if (need > 0) {
      const exclude = this.store.seenIds();
      for (const id of kept) exclude.add(id);
      const recentFields = kept
        .slice(-3)
        .map((id) => catalog.rowOf(id))
        .filter((r): r is number => r !== undefined)
        .map((r) => catalog.items[r].f);
      const field = req.field ? fieldIndex(req.field) : undefined;
      const slate = buildSlate(
        state,
        catalog,
        this.cache,
        { need, exclude, field, recentFields, cf: cfScores(ctx.coeng, state.recentPositive) },
        mulberry32(ctx.seed ?? (now ^ (state.nInteractions << 8))),
      );
      this.cache.prune();
      if (field === undefined) markSlateBasis(state, catalog.dim);
      this.store.putServed(slate.picks.map((p) => ({ ...p, at: now })));
      response.reels = slate.picks.map((p) => ({ ...toCard(catalog, p.row, ctx.imageBase), reason: p.reason }));
      if (slate.notice) response.notice = slate.notice;
    }
    this.store.putState(state);
    return { response, logs };
  }

  setLibrary(pageid: number, kind: LibraryKind, on: boolean, now: number): void {
    this.store.setLibrary(pageid, kind, on, now);
  }

  library(catalog: Catalog, imageBase: string): LibraryResponse {
    const cards = (rows: { pageid: number; at: number; reward?: number }[]): LibraryItem[] =>
      rows.flatMap((x) => {
        const row = catalog.rowOf(x.pageid);
        return row === undefined ? [] : [{ ...toCard(catalog, row, imageBase), at: x.at, reward: x.reward }];
      });
    return {
      saved: cards(this.store.library("saved", 200)),
      liked: cards(this.store.library("liked", 200)),
      history: cards(this.store.history(200)),
    };
  }

  private requireState(catalog: Catalog, now: number): UserState {
    const s = this.store.getState();
    if (s) {
      // Field list grew (new catalog): extend per-field priors.
      while (s.beta.length < catalog.fields.length) s.beta.push([1, 1]);
      return s;
    }
    // Feed before onboarding behaves like "Surprise me".
    const fresh = onboard(null, catalog, [], now, this.bucket);
    this.store.putState(fresh);
    return fresh;
  }
}

/** Collaborative score: best co-engagement with any recent positive. */
export function cfScores(coeng: Coeng, recentPositive: number[]): CfScores | undefined {
  if (coeng.size === 0 || recentPositive.length === 0) return undefined;
  const out: CfScores = new Map();
  for (const id of recentPositive.slice(-5)) {
    for (const [other, score] of coeng.get(id) ?? []) out.set(other, Math.max(out.get(other) ?? 0, score));
  }
  return out;
}
