import type { UserState } from "@wiki-reels/reco";
import { syntheticCatalog } from "@wiki-reels/reco/sim";
import type { ViewEvent } from "@wiki-reels/shared";
import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "../src/auth.ts";
import { buildCoeng } from "../src/coeng.ts";
import { FeedService, type LibraryKind, type Served, type UserStore } from "../src/feed-service.ts";

class MemoryStore implements UserStore {
  state: UserState | null = null;
  archive: { state: UserState; at: number } | null = null;
  seen = new Map<number, { at: number; reward: number }>();
  served = new Map<number, Served>();
  lib = new Map<string, number>();
  getState = () => (this.state ? structuredClone(this.state) : null);
  putState = (s: UserState) => void (this.state = structuredClone(s));
  getArchive = () => this.archive;
  putArchive = (state: UserState | null, at: number) => void (this.archive = state ? { state, at } : null);
  seenIds = () => new Set(this.seen.keys());
  markSeen = (pageid: number, at: number, reward: number) => void this.seen.set(pageid, { at, reward });
  history = (limit: number) =>
    [...this.seen].map(([pageid, v]) => ({ pageid, ...v })).sort((a, b) => b.at - a.at).slice(0, limit);
  putServed = (items: Served[]) => items.forEach((i) => this.served.set(i.pageid, i));
  takeServed = (pageid: number) => {
    const s = this.served.get(pageid);
    this.served.delete(pageid);
    return s;
  };
  setLibrary = (pageid: number, kind: LibraryKind, on: boolean, at: number) =>
    void (on ? this.lib.set(`${kind}:${pageid}`, at) : this.lib.delete(`${kind}:${pageid}`));
  library = (kind: LibraryKind, limit: number) =>
    [...this.lib]
      .filter(([k]) => k.startsWith(`${kind}:`))
      .map(([k, at]) => ({ pageid: Number(k.split(":")[1]), at }))
      .slice(0, limit);
}

const { catalog } = syntheticCatalog(5, 800, 32);
const ctx = (now: number) => ({ userId: "a_test", catalog, coeng: new Map(), imageBase: "https://img.example", now, seed: now });
const view = (pageid: number, over: Partial<ViewEvent> = {}): ViewEvent => ({
  pageid, pagesSeen: 4, nPages: 5, dwellMs: [4000, 5000, 5000, 5000], liked: false, saved: false, shared: false,
  openedWiki: false, notInterested: false, lessTopic: false, mode: "feed", position: 0, ts: 1, ...over,
});

describe("FeedService", () => {
  it("onboards, serves unseen reels, logs propensities and never repeats", () => {
    const store = new MemoryStore();
    const svc = new FeedService(store, 42);
    svc.onboard(catalog, ["history", "arts"], 1);
    expect(svc.profile(catalog, 1).chosenFields).toEqual(["history", "arts"]);

    const first = svc.feed(ctx(2), { events: [], need: 5, queued: [] }).response;
    expect(first.reels).toHaveLength(5);
    expect(first.reels[0].pages[0].url).toMatch(/^https:\/\/img\.example\/k0$/);

    const shown = first.reels[0];
    const { response, logs } = svc.feed(ctx(3), {
      events: [view(shown.pageid, { liked: true, ts: 3 })],
      need: 3,
      queued: first.reels.map((r) => r.pageid),
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ pageid: shown.pageid, reward: 1, bucket: 42, explicit: true });
    expect(logs[0].prob).toBeGreaterThan(0);
    expect(logs[0].reason).toBe(shown.reason.kind);

    const all = [...first.reels, ...response.reels].map((r) => r.pageid);
    expect(new Set(all).size).toBe(all.length);
    expect(svc.library(catalog, "x").liked.map((r) => r.pageid)).toEqual([shown.pageid]);
    expect(svc.library(catalog, "x").history.map((r) => r.pageid)).toEqual([shown.pageid]);
  });

  it("drops queued reels like one marked not interested and refills them", () => {
    const store = new MemoryStore();
    const svc = new FeedService(store, 0);
    svc.onboard(catalog, ["physical_sciences"], 1);
    const rows = catalog.fieldRows[8];
    const queued = rows.slice(0, 4).map((r) => catalog.items[r].id);
    const { response } = svc.feed(ctx(2), {
      events: [view(queued[0], { lessTopic: true, ts: 2 })],
      need: 1,
      queued,
    });
    expect(response.drop.sort()).toEqual(queued.slice(1).sort());
    expect(response.reels.length).toBe(1 + response.drop.length);
    expect(response.reels.every((r) => r.field !== "physical_sciences")).toBe(true);
  });

  it("supports soft reset, hard reset and undo", () => {
    const store = new MemoryStore();
    const svc = new FeedService(store, 0);
    svc.onboard(catalog, ["history"], 1);
    svc.reset(catalog, "soft", ["mathematics"], 2);
    expect(svc.profile(catalog, 2)).toMatchObject({ chosenFields: ["mathematics"], canUndoReset: true });
    svc.reset(catalog, "hard", undefined, 3);
    expect(svc.profile(catalog, 3).onboarded).toBe(false);
    svc.reset(catalog, "undo", undefined, 4);
    expect(svc.profile(catalog, 4)).toMatchObject({ onboarded: true, chosenFields: ["mathematics"], canUndoReset: false });
    expect(() => svc.reset(catalog, "undo", undefined, 5)).toThrow();
  });
});

describe("auth", () => {
  it("round-trips and rejects tampered tokens", async () => {
    const token = await signToken("a_123", "s3cret");
    expect(await verifyToken(token, "s3cret")).toBe("a_123");
    expect(await verifyToken(token.replace("a_123", "a_124"), "s3cret")).toBeNull();
    expect(await verifyToken(token, "other")).toBeNull();
  });
});

describe("buildCoeng", () => {
  it("links items liked by the same users and ignores low support", () => {
    const rows = Array.from({ length: 8 }, (_, u) => [
      { user_id: `u${u}`, pageid: 1 },
      { user_id: `u${u}`, pageid: 2 },
      ...(u < 2 ? [{ user_id: `u${u}`, pageid: 3 }] : []),
    ]).flat();
    const co = buildCoeng(rows);
    expect(co["1"].map(([id]) => id)).toEqual([2]);
    expect(co["1"][0][1]).toBeGreaterThan(0.3);
    expect(co["3"]).toBeUndefined();
  });
});
