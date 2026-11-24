import { fieldLabel } from "@wiki-reels/shared/fields";
import type { LibraryItem, LibraryResponse } from "@wiki-reels/shared";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { attributionUrl } from "./Reel.tsx";
import { ZoomViewer } from "./Sheet.tsx";

type Tab = "saved" | "liked" | "history";
const LABELS: Record<Tab, string> = { saved: "Saved", liked: "Liked", history: "History" };

export function Library(props: { active: boolean }) {
  const [tab, setTab] = useState<Tab>("saved");
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<LibraryItem | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!props.active) return;
    api.library().then(setData, () => setError(true));
  }, [props.active]);

  const remove = async (item: LibraryItem, kind: "saved" | "liked") => {
    await api.setLibrary(item.pageid, kind, false).catch(() => undefined);
    setData((d) => d && { ...d, [kind]: d[kind].filter((x) => x.pageid !== item.pageid) });
  };

  const list = data?.[tab] ?? [];
  return (
    <main className="page-screen">
      <h1>Library</h1>
      <div className="tabs" role="tablist">
        {(Object.keys(LABELS) as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {LABELS[t]}
            {data ? ` · ${data[t].length}` : ""}
          </button>
        ))}
      </div>
      {error && <p className="lead">Couldn't load your library.</p>}
      {data && list.length === 0 && (
        <p className="lead">
          {tab === "history" ? "Reels you watch appear here." : `Nothing ${LABELS[tab].toLowerCase()} yet. Tap ${tab === "saved" ? "🔖" : "♥"} on a reel.`}
        </p>
      )}
      <ul className="lib-grid">
        {list.map((item) => (
          <li key={`${tab}-${item.pageid}-${item.at}`}>
            <button className="lib-card" onClick={() => (setOpen(item), setPage(0))}>
              {item.pages[0] && <img src={item.pages[0].url} alt="" loading="lazy" />}
              <span className="lib-title">{item.title}</span>
              <span className="lib-meta">
                {fieldLabel(item.field)}
                {tab === "history" && item.reward !== undefined && item.reward < 0 ? " · skipped" : ""}
              </span>
            </button>
            {tab !== "history" && (
              <button className="lib-remove" aria-label={`Remove ${item.title} from ${LABELS[tab]}`} onClick={() => void remove(item, tab)}>
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      {open && open.pages[page] && (
        <ZoomViewer url={open.pages[page].url} alt={`${open.title}: ${open.pages[page].section}`} onClose={() => setOpen(null)} />
      )}
      {open && (
        <div className="lib-pager">
          <button disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">
            ←
          </button>
          <span>
            {page + 1} / {open.pages.length}
          </span>
          <button disabled={page >= open.pages.length - 1} onClick={() => setPage(page + 1)} aria-label="Next page">
            →
          </button>
          <a href={attributionUrl(open)} target="_blank" rel="noopener">
            Wikipedia · CC BY-SA
          </a>
        </div>
      )}
    </main>
  );
}
