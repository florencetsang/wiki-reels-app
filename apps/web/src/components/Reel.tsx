import { FIELDS, fieldLabel } from "@wiki-reels/shared/fields";
import type { ReelCard, ServedReel } from "@wiki-reels/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { FIELD_HUES, reasonText } from "../reasons.ts";

interface Props {
  reel: ServedReel;
  /** This reel is on screen. */
  current: boolean;
  /** Load images eagerly: all pages when current, the first infographic when next up. */
  preload: "all" | "first" | "none";
  liked: boolean;
  saved: boolean;
  reducedMotion: boolean;
  onPage(page: number): void;
  onLike(): void;
  onSave(): void;
  onShare(): void;
  onMore(): void;
  onOpenWiki(): void;
  onOpenField(field: string): void;
  onZoom(url: string, alt: string): void;
  onRelated(reel: ReelCard): void;
}

export function attributionUrl(reel: ReelCard): string {
  return reel.revisionId ? `https://en.wikipedia.org/w/index.php?curid=${reel.pageid}&oldid=${reel.revisionId}` : reel.wikiUrl;
}

export function Reel(props: Props) {
  const { reel, current, preload } = props;
  const pagesRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [heart, setHeart] = useState(0);
  const [why, setWhy] = useState(false);
  const total = reel.pages.length + 2;
  const emoji = FIELDS.find((f) => f.id === reel.field)?.emoji ?? "📖";
  const hue = FIELD_HUES[reel.field] ?? 220;

  const onScroll = () => {
    const el = pagesRef.current;
    if (!el) return;
    const p = Math.round(el.scrollLeft / el.clientWidth);
    if (p !== page) {
      setPage(p);
      props.onPage(p);
    }
  };

  const goPage = (p: number) => {
    const el = pagesRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(total - 1, p));
    el.scrollTo({ left: clamped * el.clientWidth, behavior: props.reducedMotion ? "auto" : "smooth" });
  };

  // Keyboard paging for the current reel.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      if (e.key === "ArrowRight") goPage(page + 1);
      else if (e.key === "ArrowLeft") goPage(page - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Double-tap likes (never unlikes); a long press opens the zoomable viewer.
  const lastTap = useRef(0);
  const pressTimer = useRef<number | undefined>(undefined);
  const onTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      if (!props.liked) props.onLike();
      setHeart((h) => h + 1);
      lastTap.current = 0;
    } else lastTap.current = now;
  };
  const pressStart = (url: string, alt: string) => {
    window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => props.onZoom(url, alt), 550);
  };
  const pressEnd = () => window.clearTimeout(pressTimer.current);

  const isExplore = reel.reason.kind === "explore";

  return (
    <article className={page === total - 1 ? "reel at-end" : "reel"} aria-label={reel.title} aria-roledescription="reel" style={{ ["--hue" as string]: hue }}>
      <div className="dots" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={i === page ? "on" : ""} />
        ))}
      </div>

      <div className="pages" ref={pagesRef} onScroll={onScroll} onClick={onTap}>
        <section className="page title-card" aria-label={`${reel.title}: summary`}>
          <div className="title-emoji" aria-hidden>
            {emoji}
          </div>
          <button className="chip" onClick={(e) => (e.stopPropagation(), props.onOpenField(reel.field))}>
            {fieldLabel(reel.field)}
            {reel.subfield ? ` · ${reel.subfield}` : ""}
          </button>
          <h2>{reel.title}</h2>
          <p className="summary">{reel.summary}</p>
          <button className="swipe-hint" onClick={(e) => (e.stopPropagation(), goPage(1))}>
            {reel.pages.length} pages · swipe ←
          </button>
        </section>

        {reel.pages.map((p, i) => {
          const alt = `${reel.title}: ${p.section} (infographic ${i + 1} of ${reel.pages.length})`;
          const eager = preload === "all" || (preload === "first" && i === 0);
          return (
            <section className="page image-page" key={p.url} aria-label={p.section}>
              <img
                src={p.url}
                alt={alt}
                loading={eager ? "eager" : "lazy"}
                decoding="async"
                draggable={false}
                onPointerDown={() => pressStart(p.url, alt)}
                onPointerUp={pressEnd}
                onPointerLeave={pressEnd}
                onPointerCancel={pressEnd}
                onContextMenu={(e) => e.preventDefault()}
              />
            </section>
          );
        })}

        <EndCard reel={reel} visible={page >= total - 2 && current} onOpenWiki={props.onOpenWiki} onRelated={props.onRelated} />
      </div>

      {heart > 0 && !props.reducedMotion && (
        <div key={heart} className="heart-burst" aria-hidden>
          ♥
        </div>
      )}

      <div className="rail">
        <button className={props.liked ? "act on" : "act"} aria-pressed={props.liked} aria-label="Like (L)" onClick={props.onLike}>
          <span>{props.liked ? "♥" : "♡"}</span>
          <small>Like</small>
        </button>
        <button className={props.saved ? "act on" : "act"} aria-pressed={props.saved} aria-label="Save (S)" onClick={props.onSave}>
          <span>🔖</span>
          <small>{props.saved ? "Saved" : "Save"}</small>
        </button>
        <button className="act" aria-label="Share" onClick={props.onShare}>
          <span>↗</span>
          <small>Share</small>
        </button>
        <button className="act" aria-label="More options" onClick={props.onMore}>
          <span>⋯</span>
          <small>More</small>
        </button>
      </div>

      <footer className="overlay">
        <div className="overlay-title">
          <strong>{reel.title}</strong>
          {isExplore && <span className="badge">New for you</span>}
        </div>
        <button className="why" onClick={() => setWhy((w) => !w)} aria-expanded={why}>
          {why ? reasonText(reel.reason, reel.field) : "Why this?"}
        </button>
        <a className="attribution" href={attributionUrl(reel)} target="_blank" rel="noopener" onClick={props.onOpenWiki}>
          Wikipedia · CC BY-SA 4.0
        </a>
      </footer>
    </article>
  );
}

function EndCard(props: { reel: ServedReel; visible: boolean; onOpenWiki(): void; onRelated(r: ReelCard): void }) {
  const { reel, visible } = props;
  const [related, setRelated] = useState<ReelCard[] | null>(null);
  useEffect(() => {
    if (!visible || related) return;
    api
      .related(reel.pageid)
      .then((r) => setRelated(r.related.slice(0, 4)))
      .catch(() => setRelated([]));
  }, [visible, related, reel.pageid]);

  return (
    <section className="page end-card" aria-label="Read more">
      <h3>Want the full story?</h3>
      <a className="primary" href={reel.wikiUrl} target="_blank" rel="noopener" onClick={props.onOpenWiki}>
        Read “{reel.title}” on Wikipedia
      </a>
      <p className="license">
        Text and infographics are derived from the Wikipedia article{" "}
        <a href={attributionUrl(reel)} target="_blank" rel="noopener">
          {reel.title}
        </a>{" "}
        by its contributors, licensed under{" "}
        <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">
          CC BY-SA 4.0
        </a>
        .
      </p>
      {related && related.length > 0 && (
        <>
          <h4>Related reels</h4>
          <ul className="related">
            {related.map((r) => (
              <li key={r.pageid}>
                <button onClick={(e) => (e.stopPropagation(), props.onRelated(r))}>
                  {r.pages[0] && <img src={r.pages[0].url} alt="" loading="lazy" />}
                  <span>{r.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
