import { describe, expect, it } from "vitest";
import { ReelTracker } from "../src/tracker.ts";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("ReelTracker", () => {
  it("attributes dwell to visible pages and excludes the end card and hidden time", () => {
    const c = clock();
    const t = new ReelTracker(7, 3, 2, "feed", c.now);
    c.advance(2000);
    t.setPage(1);
    c.advance(4000);
    t.pause();
    c.advance(60_000);
    t.resume();
    c.advance(1000);
    t.setPage(4); // end card
    c.advance(9000);
    t.flags.liked = true;
    expect(t.toEvent(123)).toMatchObject({
      pageid: 7,
      nPages: 4,
      pagesSeen: 2,
      dwellMs: [2000, 5000, 0, 0],
      liked: true,
      position: 2,
      mode: "feed",
      ts: 123,
    });
    expect(t.hasExplicit).toBe(true);
  });

  it("reports an instant skip as a single short title-card view", () => {
    const c = clock();
    const t = new ReelTracker(1, 5, 0, "topic", c.now);
    c.advance(400);
    const e = t.toEvent(1);
    expect(e).toMatchObject({ pagesSeen: 1, nPages: 6, dwellMs: [400, 0, 0, 0, 0, 0], mode: "topic" });
    expect(t.hasExplicit).toBe(false);
  });
});
