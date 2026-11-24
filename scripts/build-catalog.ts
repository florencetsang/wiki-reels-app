/**
 * Builds the in-memory recommendation catalog from wiki-reels-generator output.
 *
 *   node scripts/build-catalog.ts --reels-dir <dir>      # reels/<pageid>.json files
 *   node scripts/build-catalog.ts --progress-db <path>   # the generator's local progress SQLite
 *   ... [--out catalog-out] [--upload local|remote]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { buildCatalog, type ReelJson, upload, writeCatalog } from "./catalog-lib.ts";

const { values } = parseArgs({
  options: {
    "reels-dir": { type: "string" },
    "progress-db": { type: "string" },
    out: { type: "string", default: "catalog-out" },
    upload: { type: "string" },
    version: { type: "string" },
  },
});

function fromDir(dir: string): ReelJson[] {
  const out: ReelJson[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /^\d+\.json$/.test(entry.name)) {
      out.push(JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8")));
    }
  }
  return out;
}

function decodeEmbedding(value: string | Uint8Array): number[] {
  if (typeof value === "string") return JSON.parse(value);
  return Array.from(new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4));
}

function fromProgressDb(path: string): ReelJson[] {
  const db = new DatabaseSync(path, { readOnly: true });
  const cols = new Set(db.prepare("PRAGMA table_info(articles)").all().map((c) => c.name));
  const label = cols.has("vital_field") ? "vital_field, vital_subfield" : "NULL AS vital_field, NULL AS vital_subfield";
  const articles = db
    .prepare(
      `SELECT title, pageid, resolved_title, canonical_url, revision_id, vital_level, ${label}, summary, categories,
              embedding_model, embedding_dim, embedding
       FROM articles WHERE status = 'done' AND embedding IS NOT NULL AND r2_reel_uploaded_at IS NOT NULL`,
    )
    .all();
  const sections = db.prepare(
    "SELECT position, section_title, r2_key FROM sections WHERE title = ? AND r2_uploaded_at IS NOT NULL ORDER BY position",
  );
  return articles.map((a) => ({
    pageid: Number(a.pageid),
    title: String(a.resolved_title ?? a.title),
    canonical_url: a.canonical_url as string | null,
    revision_id: a.revision_id as number | null,
    vital_level: Number(a.vital_level),
    vital_field: a.vital_field as string | null,
    vital_subfield: a.vital_subfield as string | null,
    summary: a.summary as string | null,
    categories: a.categories ? JSON.parse(String(a.categories)) : [],
    embedding: {
      model: String(a.embedding_model),
      dim: Number(a.embedding_dim),
      vector: decodeEmbedding(a.embedding as string | Uint8Array),
    },
    infographics: sections.all(a.title as string).map((s) => ({
      page: Number(s.position),
      section: String(s.section_title),
      r2_key: s.r2_key as string,
    })),
  }));
}

const reels = [
  ...(values["reels-dir"] ? fromDir(values["reels-dir"]) : []),
  ...(values["progress-db"] ? fromProgressDb(values["progress-db"]) : []),
];
if (!values["reels-dir"] && !values["progress-db"]) {
  console.error("usage: build-catalog.ts (--reels-dir <dir> | --progress-db <path>) [--out dir] [--upload local|remote]");
  process.exit(2);
}
const result = buildCatalog(reels, values.version);
const entries = writeCatalog(values.out!, result);
const perField = result.meta.fields.map((f, i) => `${f}=${result.meta.items.filter((it) => it.f === i).length}`);
console.log(`catalog ${result.meta.version}: ${result.meta.items.length} reels, dim ${result.meta.dim}`);
console.log(`  fields: ${perField.join(" ")}`);
console.log(`  inferred fields: ${result.stats.inferred}; skipped: ${JSON.stringify(result.stats.skipped)}`);
if (values.upload) {
  if (values.upload !== "local" && values.upload !== "remote") throw new Error("--upload must be local or remote");
  upload(entries, values.upload === "remote");
}
