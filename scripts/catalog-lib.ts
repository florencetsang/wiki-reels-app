import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CatalogItemFile, type CatalogMetaFile, quantize } from "../packages/reco/src/index.ts";
import { FIELD_IDS, type FieldId } from "../packages/shared/src/index.ts";

/** Subset of the wiki-reels-generator reel JSON (reels/<pageid>.json) the app needs. */
export interface ReelJson {
  pageid: number;
  title: string;
  canonical_url?: string | null;
  revision_id?: number | null;
  vital_level?: number | null;
  vital_field?: string | null;
  vital_subfield?: string | null;
  summary?: string | null;
  categories?: string[];
  embedding: { model: string; dim: number; vector: number[] };
  infographics: { page: number; section: string; r2_key?: string | null }[];
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const API_DIR = join(ROOT, "apps/api");
export const BUCKET = "wikiinfo";

/** Fallback for reels generated before vital_field existed: keywords in "... vital articles in <X>" categories. */
const FIELD_KEYWORDS: [FieldId, RegExp][] = [
  ["people", /\b(people|biograph|persons?)\b/i],
  ["history", /\bhistory\b/i],
  ["geography", /\b(geography|countries|cities|places)\b/i],
  ["arts", /\b(arts?|music|literature|film|architecture)\b/i],
  ["philosophy_religion", /\b(philosophy|religion|mythology)\b/i],
  ["everyday_life", /\b(everyday life|sports?|food|recreation)\b/i],
  ["society", /\b(society|social sciences|politics|economics|law)\b/i],
  ["biology_health", /\b(biology|health|medicine|organisms?)\b/i],
  ["physical_sciences", /\b(physical sciences|physics|chemistry|astronomy|earth sciences)\b/i],
  ["technology", /\b(technology|engineering|computing)\b/i],
  ["mathematics", /\bmathematics\b/i],
];

const POP_BY_LEVEL: Record<number, number> = { 1: 1, 2: 1, 3: 0.8, 4: 0.5, 5: 0.2 };

export function truncateSummary(text: string, max = 300): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

function keywordField(categories: string[]): number {
  for (const c of categories) {
    const m = /vital articles in (.+)$/i.exec(c);
    if (!m) continue;
    for (const [id, re] of FIELD_KEYWORDS) if (re.test(m[1])) return FIELD_IDS.indexOf(id);
  }
  return -1;
}

export interface BuildResult {
  meta: CatalogMetaFile;
  vecs: Int8Array;
  stats: { skipped: Record<string, number>; inferred: number };
}

export function buildCatalog(reels: ReelJson[], version = defaultVersion()): BuildResult {
  const skipped: Record<string, number> = {};
  const skip = (why: string) => void (skipped[why] = (skipped[why] ?? 0) + 1);
  const first = reels.find((r) => r.embedding?.vector?.length);
  if (!first) throw new Error("no reels with embeddings");
  const { model, dim } = first.embedding;

  const seen = new Set<number>();
  const rows: { reel: ReelJson; f: number; v: Float32Array; pages: [string, string][] }[] = [];
  for (const reel of reels) {
    if (seen.has(reel.pageid)) { skip("duplicate"); continue; }
    if (reel.embedding?.model !== model || reel.embedding.vector?.length !== dim) { skip("embedding"); continue; }
    const pages = [...(reel.infographics ?? [])]
      .filter((p) => p.r2_key)
      .sort((a, b) => a.page - b.page)
      .map((p): [string, string] => [p.section, p.r2_key as string]);
    if (pages.length === 0) { skip("no uploaded infographics"); continue; }
    seen.add(reel.pageid);
    const f = reel.vital_field ? FIELD_IDS.indexOf(reel.vital_field as FieldId) : -1;
    rows.push({ reel, f: f >= 0 ? f : keywordField(reel.categories ?? []), v: Float32Array.from(reel.embedding.vector), pages });
  }

  // Last resort: nearest centroid of the labelled reels.
  const centroids = FIELD_IDS.map(() => new Float32Array(dim));
  for (const r of rows) if (r.f >= 0) r.v.forEach((x, j) => (centroids[r.f][j] += x));
  let inferred = 0;
  for (const r of rows) {
    if (r.f >= 0) continue;
    let best = -Infinity;
    centroids.forEach((c, f) => {
      let s = 0;
      for (let j = 0; j < dim; j++) s += c[j] * r.v[j];
      if (s > best) [best, r.f] = [s, f];
    });
    if (best === 0) r.f = FIELD_IDS.indexOf("everyday_life");
    inferred++;
  }

  rows.sort((a, b) => a.reel.pageid - b.reel.pageid);
  const { vecs, scales } = quantize(rows.map((r) => r.v), dim);
  const items: CatalogItemFile[] = rows.map(({ reel, f, pages }, i) => ({
    id: reel.pageid,
    t: reel.title,
    f,
    sf: reel.vital_subfield ?? null,
    l: reel.vital_level ?? 5,
    s: truncateSummary(reel.summary ?? ""),
    u: reel.canonical_url ?? `https://en.wikipedia.org/?curid=${reel.pageid}`,
    r: reel.revision_id ?? null,
    p: pages,
    pop: POP_BY_LEVEL[reel.vital_level ?? 5] ?? 0.2,
    sc: Math.round(scales[i] * 1000) / 1000,
  }));
  // Re-quantize with the rounded scales so value = int8 / sc stays exact.
  rows.forEach((r, i) => {
    for (let j = 0; j < dim; j++) {
      vecs[i * dim + j] = Math.max(-127, Math.min(127, Math.round(r.v[j] * items[i].sc)));
    }
  });
  return {
    meta: { version, model, dim, builtAt: new Date().toISOString(), fields: [...FIELD_IDS], items },
    vecs,
    stats: { skipped, inferred },
  };
}

export function defaultVersion(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** Writes catalog/<version>/{meta.json,vecs.i8} and catalog/current.json under outDir; returns R2 key/file pairs. */
export function writeCatalog(outDir: string, { meta, vecs }: BuildResult): { key: string; file: string }[] {
  const dir = join(outDir, "catalog", meta.version);
  mkdirSync(dir, { recursive: true });
  const files = [
    { key: `catalog/${meta.version}/meta.json`, file: join(dir, "meta.json"), data: JSON.stringify(meta) },
    { key: `catalog/${meta.version}/vecs.i8`, file: join(dir, "vecs.i8"), data: vecs },
    // current.json last so readers never see a pointer to a partial upload.
    { key: "catalog/current.json", file: join(outDir, "catalog/current.json"), data: JSON.stringify({ version: meta.version }) },
  ];
  for (const f of files) writeFileSync(f.file, f.data);
  return files.map(({ key, file }) => ({ key, file: resolve(file) }));
}

/** Uploads key/file pairs to R2 with wrangler (local Miniflare storage unless remote). */
export function upload(entries: { key: string; file: string }[], remote: boolean, bucket = BUCKET): void {
  // Windows: npx is npx.cmd, which Node only spawns via a shell (args then need manual quoting).
  const win = process.platform === "win32";
  const quote = (a: string) => (win && /[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  const run = (args: string[]) =>
    execFileSync(win ? "npx.cmd" : "npx", ["wrangler", "r2", ...args, remote ? "--remote" : "--local"].map(quote), {
      cwd: API_DIR,
      stdio: "inherit",
      shell: win,
    });
  const pointer = entries.filter((e) => e.key === "catalog/current.json");
  const bulk = entries.filter((e) => e.key !== "catalog/current.json");
  if (bulk.length) {
    const list = join(API_DIR, ".wrangler", "bulk-put.json");
    mkdirSync(dirname(list), { recursive: true });
    writeFileSync(list, JSON.stringify(bulk));
    run(["bulk", "put", bucket, "--filename", list]);
  }
  for (const e of pointer) run(["object", "put", `${bucket}/${e.key}`, "--file", e.file]);
}
