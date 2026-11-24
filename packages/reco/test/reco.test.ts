import type { ViewEvent } from "@wiki-reels/shared";
import { describe, expect, it } from "vitest";
import {
  applyEvents,
  buildSlate,
  computeReward,
  hardReset,
  initUser,
  markSlateBasis,
  mulberry32,
  reelsToDrop,
  SimCache,
  softReset,
} from "../src/index.ts";
import { makeSimUsers, simulate, syntheticCatalog } from "../src/sim.ts";

const sc = syntheticCatalog(1, 1500, 32);
const { catalog } = sc;

const view = (pageid: number, over: Partial<ViewEvent> = {}): ViewEvent => ({
  pageid,
  pagesSeen: 1,
  nPages: 6,
  dwellMs: [400],
  liked: false,
  saved: false,
  shared: false,
  openedWiki: false,
  notInterested: false,
  lessTopic: false,
  mode: "feed",
  position: 0,
  ts: 1000,
  ...over,
});

describe("computeReward", () => {
  it("lets explicit actions win over dwell", () => {
    expect(computeReward(view(1, { notInterested: true, liked: true, pagesSeen: 6, dwellMs: [9e3] })).r).toBe(-1);
    expect(computeReward(view(1, { liked: true })).r).toBe(1);
  });

  it("scales implicit reward by pages read and stays below an explicit like", () => {
    const skip = computeReward(view(1));
    const card = computeReward(view(1, { dwellMs: [4000] }));
    const half = computeReward(view(1, { pagesSeen: 3, dwellMs: [4000, 5000, 5000] }));
    const full = computeReward(view(1, { pagesSeen: 6, dwellMs: Array(6).fill(6000) }));
    expect(skip.r).toBeLessThan(0);
    expect(Math.abs(card.r)).toBeLessThan(0.2);
    expect(half.r).toBeGreaterThan(card.r);
    expect(full.r).toBeGreaterThan(half.r);
    expect(full.r).toBeLessThan(1);
    expect(full.sw).toBeLessThan(1);
  });
});

describe("user state", () => {
  const rowOf = (field: number, i = 0) => catalog.fieldRows[field][i];

  it("seeds interests from chosen fields", () => {
    const s = initUser(catalog, [2, 5], 0);
    expect(s.interests).toHaveLength(2);
    expect(s.beta[2][0] / (s.beta[2][0] + s.beta[2][1])).toBeGreaterThan(s.beta[0][0] / (s.beta[0][0] + s.beta[0][1]));
  });

  it("learns from likes and dislikes", () => {
    const s = initUser(catalog, [0], 0);
    const liked = catalog.items[rowOf(3)].id;
    const before = s.beta[3][0] / (s.beta[3][0] + s.beta[3][1]);
    applyEvents(s, catalog, [view(liked, { liked: true })], 10);
    expect(s.beta[3][0] / (s.beta[3][0] + s.beta[3][1])).toBeGreaterThan(before);
    expect(s.recentPositive).toEqual([liked]);
    expect(s.interests.length).toBeGreaterThan(1);

    const disliked = catalog.items[rowOf(4)].id;
    applyEvents(s, catalog, [view(disliked, { notInterested: true })], 20);
    expect(s.negatives).toHaveLength(1);
    applyEvents(s, catalog, [view(catalog.items[rowOf(4, 1)].id, { lessTopic: true })], 30);
    expect(s.beta[4][1]).toBeGreaterThan(5);
  });

  it("soft reset keeps some history while hard reset starts onboarding again", () => {
    const s = initUser(catalog, [0], 0);
    for (let i = 0; i < 20; i++) applyEvents(s, catalog, [view(catalog.items[rowOf(1, i)].id, { liked: true })], i);
    const soft = softReset(s, catalog, [7], 100);
    expect(soft.profileVersion).toBe(2);
    expect(soft.nInteractions).toBe(4);
    expect(soft.chosenFields).toEqual([7]);
    expect(soft.beta[1][0]).toBeGreaterThan(1);
    expect(soft.beta[7][0]).toBeGreaterThan(soft.beta[1][0]);
    const hard = hardReset(s, catalog, 100);
    expect(hard.onboarded).toBe(false);
    expect(hard.interests).toHaveLength(0);
  });
});

describe("buildSlate", () => {
  it("never serves excluded or hidden reels and limits same-field runs", () => {
    const s = initUser(catalog, [0], 0);
    s.hiddenFields = [1];
    const exclude = new Set(catalog.fieldRows[0].slice(0, 50).map((r) => catalog.items[r].id));
    const slate = buildSlate(s, catalog, new SimCache(), { need: 20, exclude }, mulberry32(1));
    expect(slate.picks).toHaveLength(20);
    const fields = slate.picks.map((p) => catalog.items[p.row].f);
    for (const p of slate.picks) {
      expect(exclude.has(p.pageid)).toBe(false);
      expect(p.prob).toBeGreaterThan(0);
      expect(p.prob).toBeLessThanOrEqual(1);
    }
    expect(fields).not.toContain(1);
    for (let i = 3; i < fields.length; i++) {
      expect(new Set(fields.slice(i - 3, i + 1)).size).toBeGreaterThan(1);
    }
  });

  it("restricts topic mode to the field and reports exhaustion", () => {
    const s = initUser(catalog, [], 0);
    const rows = catalog.fieldRows[6];
    const exclude = new Set(rows.slice(2).map((r) => catalog.items[r].id));
    const slate = buildSlate(s, catalog, new SimCache(), { need: 5, exclude, field: 6 }, mulberry32(2));
    expect(slate.picks.map((p) => p.row).sort()).toEqual(rows.slice(0, 2).sort());
    expect(slate.notice).toBe("field-exhausted");
    expect(slate.picks.every((p) => p.reason.kind === "topic")).toBe(true);
  });
});

describe("reelsToDrop", () => {
  it("drops queued reels similar to one the user rejected", () => {
    const s = initUser(catalog, [0], 0);
    markSlateBasis(s, catalog.dim);
    const [bad, sameSub, ...rest] = catalog.fieldRows[2].filter((r) => sc.subtopic[r] === sc.subtopic[catalog.fieldRows[2][0]]);
    const other = catalog.fieldRows[9][0];
    const queued = [sameSub, other, ...rest.slice(0, 1)].map((r) => catalog.items[r].id);
    const applied = applyEvents(s, catalog, [view(catalog.items[bad].id, { lessTopic: true })], 10);
    const drop = reelsToDrop(s, catalog, queued, applied);
    expect(drop).toContain(catalog.items[sameSub].id);
    expect(drop).not.toContain(catalog.items[other].id);
  });
});

describe("simulation", () => {
  it("learns hidden tastes much better than random and keeps the feed varied", () => {
    const users = makeSimUsers(sc, 12, 3);
    const reco = simulate(sc, users, "reco", 120);
    const random = simulate(sc, users, "random", 120);
    expect(reco.lateEngagement).toBeGreaterThan(2.5 * random.lateEngagement);
    expect(reco.lateEngagement).toBeGreaterThan(reco.earlyEngagement);
    expect(reco.fieldsPer10).toBeGreaterThanOrEqual(2);
  });
});
