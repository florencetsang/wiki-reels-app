import { fieldLabel } from "@wiki-reels/shared/fields";
import type { ServedReel } from "@wiki-reels/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFeed } from "../useFeed.ts";
import { Reel } from "./Reel.tsx";
import { Sheet, ZoomViewer } from "./Sheet.tsx";

interface Props {
  field?: string;
  active: boolean;
  dataSaver: boolean;
  reducedMotion: boolean;
  onOpenField(field: string): void;
  onBack?(): void;
  toast(msg: string): void;
}

/** Only reels near the current one are rendered; the rest are empty snap slots. */
const RENDER_WINDOW = 2;

export function Feed(props: Props) {
  const feed = useFeed({ field: props.field, active: props.active });
  const scroller = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<ServedReel | null>(null);
  const [zoom, setZoom] = useState<{ url: string; alt: string } | null>(null);
  const current = feed.items[feed.index];

  const onScroll = () => {
    const el = scroller.current;
    if (!el || el.clientHeight === 0) return;
    feed.setCurrent(Math.round(el.scrollTop / el.clientHeight));
  };

  const goReel = useCallback(
    (i: number) => {
      const el = scroller.current;
      if (!el) return;
      el.scrollTo({ top: i * el.clientHeight, behavior: props.reducedMotion ? "auto" : "smooth" });
    },
    [props.reducedMotion],
  );

  const share = async (reel: ServedReel) => {
    feed.flag("shared");
    const data = { title: reel.title, text: `${reel.title} — a 60-second Wikipedia reel`, url: reel.wikiUrl };
    try {
      if (navigator.share) await navigator.share(data);
      else {
        await navigator.clipboard.writeText(reel.wikiUrl);
        props.toast("Link copied");
      }
    } catch {
      /* share sheet dismissed */
    }
  };

  const dismiss = (kind: "notInterested" | "lessTopic", reel: ServedReel) => {
    setMore(null);
    feed.dismiss(kind);
    props.toast(kind === "lessTopic" ? `Showing less ${fieldLabel(reel.field)}` : "Got it — fewer reels like this");
    window.setTimeout(() => goReel(feed.index + 1), 150);
  };

  useEffect(() => {
    if (!props.active || !current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || more || zoom) return;
      const k = e.key.toLowerCase();
      if (k === "arrowdown" || k === "j") goReel(feed.index + 1);
      else if (k === "arrowup" || k === "k") goReel(feed.index - 1);
      else if (k === "l") feed.toggle("liked", current);
      else if (k === "s") feed.toggle("saved", current);
      else if (k === "x") dismiss("notInterested", current);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (feed.notice === "field-exhausted" && props.field) {
      props.toast(`You've seen everything in ${fieldLabel(props.field)} 🎉`);
      feed.clearNotice();
    } else if (feed.notice === "catalog-exhausted") {
      props.toast("You've seen every reel we have 🎉 New ones arrive regularly.");
      feed.clearNotice();
    }
  }, [feed.notice]);

  return (
    <div className="feed" hidden={!props.active}>
      {props.field && (
        <header className="topic-header">
          <button onClick={props.onBack} aria-label="Back to Explore">
            ←
          </button>
          <span>{fieldLabel(props.field)}</span>
        </header>
      )}
      <div className="reels" ref={scroller} onScroll={onScroll}>
        {feed.items.map((reel, i) =>
          Math.abs(i - feed.index) <= RENDER_WINDOW ? (
            <Reel
              key={reel.pageid}
              reel={reel}
              current={i === feed.index}
              preload={i === feed.index ? "all" : !props.dataSaver && i > feed.index && i <= feed.index + 2 ? "first" : "none"}
              liked={feed.liked.has(reel.pageid)}
              saved={feed.saved.has(reel.pageid)}
              reducedMotion={props.reducedMotion}
              onPage={(p) => i === feed.index && feed.setPage(p)}
              onLike={() => feed.toggle("liked", reel)}
              onSave={() => feed.toggle("saved", reel)}
              onShare={() => void share(reel)}
              onMore={() => setMore(reel)}
              onOpenWiki={() => feed.flag("openedWiki")}
              onOpenField={props.onOpenField}
              onZoom={(url, alt) => setZoom({ url, alt })}
              onRelated={(r) => {
                feed.insertNext(r, reel.title);
                window.setTimeout(() => goReel(i + 1), 50);
              }}
            />
          ) : (
            <div key={reel.pageid} className="reel-slot" />
          ),
        )}
        {feed.items.length === 0 && (
          <div className="empty">
            {feed.loading ? (
              <div className="spinner" aria-label="Loading" />
            ) : (
              <>
                <p>{feed.error ?? "Nothing here yet."}</p>
                <button className="primary" onClick={feed.retry}>
                  Try again
                </button>
              </>
            )}
          </div>
        )}
        {feed.items.length > 0 && feed.index === feed.items.length - 1 && feed.error && (
          <div className="empty">
            <p>{feed.error}</p>
            <button className="primary" onClick={feed.retry}>
              Try again
            </button>
          </div>
        )}
      </div>

      {more && (
        <Sheet title={more.title} onClose={() => setMore(null)}>
          <button className="sheet-item" onClick={() => dismiss("notInterested", more)}>
            🙅 Not interested
          </button>
          <button className="sheet-item" onClick={() => dismiss("lessTopic", more)}>
            ➖ Less {fieldLabel(more.field)}
          </button>
          <button className="sheet-item" onClick={() => (props.onOpenField(more.field), setMore(null))}>
            🔎 More {fieldLabel(more.field)}
          </button>
          <a
            className="sheet-item"
            target="_blank"
            rel="noopener"
            href={`https://github.com/florencetsang/wiki-reels-generator/issues/new?title=${encodeURIComponent(
              `Infographic problem: ${more.title} (${more.pageid})`,
            )}`}
            onClick={() => setMore(null)}
          >
            ⚠️ Report a problem with this reel
          </a>
        </Sheet>
      )}
      {zoom && <ZoomViewer {...zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}
