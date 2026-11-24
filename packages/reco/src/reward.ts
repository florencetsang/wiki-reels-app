import type { ViewEvent } from "@wiki-reels/shared";

/** Expected attention per infographic page; dense 9:16 infographics take a few seconds. */
export const EXPECTED_PAGE_MS = 5000;
export const INSTANT_SKIP_MS = 1500;

export interface Reward {
  /** Reward in [-1, 1]. */
  r: number;
  /** Trust in the signal: explicit actions 1.0, implicit dwell/completion 0.4. */
  sw: number;
  explicit: boolean;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Converts one reel view into a reward. Explicit actions set the label; for
 * implicit views, how much of the reel was read (pages) matters more than raw time.
 */
export function computeReward(e: ViewEvent): Reward {
  if (e.notInterested || e.lessTopic) return { r: -1, sw: 1, explicit: true };
  if (e.liked || e.saved || e.shared) return { r: 1, sw: 1, explicit: true };
  if (e.openedWiki) return { r: 0.8, sw: 1, explicit: true };

  const total = e.dwellMs.reduce((a, b) => a + b, 0);
  if (total < INSTANT_SKIP_MS && e.pagesSeen <= 1) return { r: -0.4, sw: 0.4, explicit: false };

  const pages = Math.max(1, Math.min(e.pagesSeen, e.nPages));
  const completion = pages / e.nPages;
  const seenDwell = e.dwellMs.filter((d) => d > 0);
  const quality = Math.min(1.5, median(seenDwell) / EXPECTED_PAGE_MS);

  // Only the title card: a weak signal around zero, negative for a glance.
  if (pages <= 1 && e.nPages > 1) return { r: 0.3 * Math.min(quality, 1) - 0.15, sw: 0.4, explicit: false };
  const r = Math.min(0.9, 0.2 + 0.6 * completion + 0.2 * Math.min(quality, 1));
  return { r, sw: 0.4, explicit: false };
}
