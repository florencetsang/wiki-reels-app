import { Catalog, type CatalogMetaFile } from "@wiki-reels/reco";
import type { ReelCard } from "@wiki-reels/shared";

/** Item-item co-engagement written by the nightly cron: pageid -> [[pageid, score 0..1], ...]. */
export type Coeng = Map<number, [number, number][]>;

interface Loaded {
  catalog: Catalog;
  coeng: Coeng;
  checkedAt: number;
}

const CHECK_INTERVAL_MS = 60_000;
// Shared by every Durable Object and request in this isolate.
let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;

export class CatalogUnavailable extends Error {}

async function load(bucket: R2Bucket, previous: Loaded | null): Promise<Loaded> {
  const pointer = await bucket.get("catalog/current.json");
  if (!pointer) throw new CatalogUnavailable("catalog/current.json not found; run scripts/build-catalog.ts");
  const { version } = (await pointer.json()) as { version: string };
  if (previous && previous.catalog.version === version) {
    return { ...previous, checkedAt: Date.now() };
  }
  const [meta, vecs, coeng] = await Promise.all([
    bucket.get(`catalog/${version}/meta.json`),
    bucket.get(`catalog/${version}/vecs.i8`),
    bucket.get("catalog/coeng.json"),
  ]);
  if (!meta || !vecs) throw new CatalogUnavailable(`catalog/${version} is incomplete`);
  const catalog = new Catalog((await meta.json()) as CatalogMetaFile, new Int8Array(await vecs.arrayBuffer()));
  const coengMap: Coeng = new Map(
    coeng ? Object.entries((await coeng.json()) as Record<string, [number, number][]>).map(([k, v]) => [Number(k), v]) : [],
  );
  return { catalog, coeng: coengMap, checkedAt: Date.now() };
}

export async function getCatalog(bucket: R2Bucket): Promise<Loaded> {
  if (loaded && Date.now() - loaded.checkedAt < CHECK_INTERVAL_MS) return loaded;
  loading ??= load(bucket, loaded).finally(() => {
    loading = null;
  });
  try {
    loaded = await loading;
  } catch (err) {
    // Keep serving the last good catalog if a refresh fails.
    if (!loaded) throw err;
    loaded.checkedAt = Date.now();
  }
  return loaded;
}

export function imageBase(env: { IMAGE_BASE?: string }, origin: string): string {
  return (env.IMAGE_BASE || `${origin}/img`).replace(/\/$/, "");
}

export function toCard(catalog: Catalog, row: number, base: string): ReelCard {
  const it = catalog.items[row];
  return {
    pageid: it.id,
    title: it.t,
    field: catalog.fields[it.f],
    subfield: it.sf,
    level: it.l,
    summary: it.s,
    wikiUrl: it.u,
    revisionId: it.r,
    pages: it.p.map(([section, key]) => ({ section, url: `${base}/${key}` })),
  };
}
