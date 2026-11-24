import type { FeedResponse, ReelCard, ServedReel, ViewEvent } from "@wiki-reels/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, sendEventsBeacon } from "./api.ts";
import { type Flag, ReelTracker } from "./tracker.ts";

/** Reels the client keeps ahead of the user, including the current one. */
const TARGET_AHEAD = 5;
const REFILL_AT = 3;

export interface FeedState {
  items: ServedReel[];
  index: number;
  loading: boolean;
  error: string | null;
  notice: FeedResponse["notice"] | null;
  liked: Set<number>;
  saved: Set<number>;
}

export interface FeedApi extends FeedState {
  setCurrent(index: number): void;
  setPage(page: number): void;
  toggle(kind: "liked" | "saved", reel: ServedReel): void;
  flag(flag: Flag): void;
  /** Explicit negative feedback: ends the current view immediately and refreshes the queue. */
  dismiss(kind: "notInterested" | "lessTopic"): void;
  insertNext(reel: ReelCard, anchor: string): void;
  retry(): void;
  clearNotice(): void;
}

export function useFeed(opts: { field?: string; active: boolean }): FeedApi {
  const { field, active } = opts;
  const mode = field ? "topic" : "feed";
  const [items, setItems] = useState<ServedReel[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<FeedResponse["notice"] | null>(null);
  const [liked, setLiked] = useState(new Set<number>());
  const [saved, setSaved] = useState(new Set<number>());

  const itemsRef = useRef<ServedReel[]>([]);
  const indexRef = useRef(0);
  const pending = useRef<ViewEvent[]>([]);
  const evented = useRef(new Set<number>());
  const tracker = useRef<ReelTracker | null>(null);
  const inflight = useRef(false);
  const again = useRef(false);
  const exhausted = useRef(false);

  const commitItems = (next: ServedReel[]) => {
    itemsRef.current = next;
    setItems(next);
  };

  const queued = () =>
    itemsRef.current
      .slice(indexRef.current)
      .filter((r) => !evented.current.has(r.pageid))
      .map((r) => r.pageid);

  const startTracker = useCallback(() => {
    const reel = itemsRef.current[indexRef.current];
    tracker.current = reel ? new ReelTracker(reel.pageid, reel.pages.length, indexRef.current, mode) : null;
    if (!document.hidden && active) tracker.current?.resume();
    else tracker.current?.pause();
  }, [mode, active]);

  /** Ends the current reel's view; revisits only produce an event when the user acted. */
  const finishCurrent = () => {
    const t = tracker.current;
    if (!t) return;
    tracker.current = null;
    if (evented.current.has(t.pageid) && !t.hasExplicit) return;
    pending.current.push(t.toEvent());
    evented.current.add(t.pageid);
  };

  const sync = useCallback(async () => {
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    try {
      do {
        again.current = false;
        const ahead = itemsRef.current.length - indexRef.current;
        const need = ahead <= REFILL_AT && !exhausted.current ? TARGET_AHEAD - ahead : 0;
        const events = pending.current.splice(0);
        if (events.length === 0 && need === 0) break;
        let res: FeedResponse;
        try {
          res = await api.feed({ events, need, queued: queued(), field });
        } catch (err) {
          pending.current.unshift(...events);
          throw err;
        }
        const drop = new Set(res.drop);
        const cur = indexRef.current;
        const kept = itemsRef.current.filter((r, i) => i <= cur || !drop.has(r.pageid));
        const have = new Set(kept.map((r) => r.pageid));
        commitItems([...kept, ...res.reels.filter((r) => !have.has(r.pageid))]);
        if (res.notice) {
          setNotice(res.notice);
          exhausted.current = res.reels.length === 0;
        }
        if (!tracker.current && itemsRef.current[indexRef.current]) startTracker();
        setError(null);
      } while (again.current);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 503 ? "No reels are available yet." : "Can't reach Wiki Reels. Check your connection.");
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [field, startTracker]);

  useEffect(() => {
    void sync();
  }, [sync]);

  // Pause dwell timing while hidden or on another tab, and flush before the page goes away.
  useEffect(() => {
    const onHide = () => {
      if (!document.hidden) {
        if (active) tracker.current?.resume();
        return;
      }
      finishCurrent();
      const events = pending.current.splice(0);
      if (!sendEventsBeacon(events, queued(), field)) pending.current.unshift(...events);
      startTracker();
    };
    if (active) tracker.current?.resume();
    else tracker.current?.pause();
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [active, field, startTracker]);

  // Leaving a topic feed (unmount): deliver its remaining events.
  useEffect(
    () => () => {
      finishCurrent();
      const events = pending.current.splice(0);
      if (events.length) void api.feed({ events, need: 0, queued: [], field }).catch(() => sendEventsBeacon(events, [], field));
    },
    [field],
  );

  const setCurrent = useCallback(
    (next: number) => {
      if (next === indexRef.current || next < 0 || next >= itemsRef.current.length) return;
      finishCurrent();
      indexRef.current = next;
      setIndex(next);
      startTracker();
      void sync();
    },
    [startTracker, sync],
  );

  const toggle = useCallback((kind: "liked" | "saved", reel: ServedReel) => {
    const setter = kind === "liked" ? setLiked : setSaved;
    setter((prev) => {
      const next = new Set(prev);
      const on = !next.has(reel.pageid);
      if (on) next.add(reel.pageid);
      else next.delete(reel.pageid);
      if (tracker.current?.pageid === reel.pageid) tracker.current.flags[kind] = on;
      void api.setLibrary(reel.pageid, kind, on).catch(() => undefined);
      return next;
    });
  }, []);

  const flag = useCallback((f: Flag) => {
    if (tracker.current) tracker.current.flags[f] = true;
  }, []);

  const dismiss = useCallback(
    (kind: "notInterested" | "lessTopic") => {
      if (tracker.current) tracker.current.flags[kind] = true;
      finishCurrent();
      startTracker();
      // A revisit of the same reel must not overwrite the negative signal.
      if (tracker.current) evented.current.add(tracker.current.pageid);
      void sync();
    },
    [startTracker, sync],
  );

  const insertNext = useCallback((reel: ReelCard, anchor: string) => {
    if (itemsRef.current.some((r) => r.pageid === reel.pageid)) return;
    const at = indexRef.current + 1;
    const next = [...itemsRef.current];
    next.splice(at, 0, { ...reel, reason: { kind: "similar", anchor } });
    commitItems(next);
  }, []);

  return {
    items,
    index,
    loading,
    error,
    notice,
    liked,
    saved,
    setCurrent,
    setPage: useCallback((p: number) => tracker.current?.setPage(p), []),
    toggle,
    flag,
    dismiss,
    insertNext,
    retry: useCallback(() => {
      setLoading(true);
      void sync();
    }, [sync]),
    clearNotice: useCallback(() => setNotice(null), []),
  };
}
