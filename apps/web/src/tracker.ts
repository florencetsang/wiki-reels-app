import type { ViewEvent } from "@wiki-reels/shared";

export type Flag = "liked" | "saved" | "shared" | "openedWiki" | "notInterested" | "lessTopic";
const EXPLICIT: Flag[] = ["liked", "saved", "shared", "openedWiki", "notInterested", "lessTopic"];

/**
 * Measures one view of a reel: which pages were visible and for how long.
 * Page 0 is the title card, 1..n the infographics; the end card (n + 1) is not a content page.
 */
export class ReelTracker {
  readonly nPages: number;
  private readonly dwell: number[];
  private readonly seen = new Set<number>([0]);
  private page = 0;
  private since: number | null;
  readonly flags: Record<Flag, boolean> = {
    liked: false,
    saved: false,
    shared: false,
    openedWiki: false,
    notInterested: false,
    lessTopic: false,
  };

  constructor(
    readonly pageid: number,
    infographics: number,
    readonly position: number,
    readonly mode: "feed" | "topic",
    private readonly now: () => number = () => performance.now(),
  ) {
    this.nPages = infographics + 1;
    this.dwell = new Array<number>(this.nPages).fill(0);
    this.since = now();
  }

  private accumulate(): void {
    if (this.since === null) return;
    const t = this.now();
    if (this.page < this.nPages) this.dwell[this.page] += t - this.since;
    this.since = t;
  }

  setPage(page: number): void {
    if (page === this.page) return;
    this.accumulate();
    this.page = page;
    if (page < this.nPages) this.seen.add(page);
  }

  pause(): void {
    this.accumulate();
    this.since = null;
  }

  resume(): void {
    if (this.since === null) this.since = this.now();
  }

  get hasExplicit(): boolean {
    return EXPLICIT.some((f) => this.flags[f]);
  }

  toEvent(ts = Date.now()): ViewEvent {
    this.accumulate();
    return {
      pageid: this.pageid,
      pagesSeen: this.seen.size,
      nPages: this.nPages,
      dwellMs: this.dwell.map((d) => Math.round(Math.min(d, 3_600_000))),
      ...this.flags,
      mode: this.mode,
      position: this.position,
      ts,
    };
  }
}
