/**
 * Builds the in-memory recommendation catalog from wiki-reels-generator output.
 *
 *   node scripts/build-catalog.ts --reels-dir <dir>      # reels/<pageid>.json files
 *   node scripts/build-catalog.ts --progress-db <path>   # the generator's local progress SQLite
 *   node scripts/build-catalog.ts --d1 [--env-file <generator .env>]   # the generator's Cloudflare D1 progress database
 *   ... [--out catalog-out] [--upload local|remote]
 *
 * --d1 reads D1_DATABASE_ID, CLOUDFLARE_ACCOUNT_ID (or R2_ACCOUNT_ID) and CLOUDFLARE_API_TOKEN from --env-file,
 * falling back to the environment. Values from --env-file are not exported, so wrangler keeps its own credentials.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { buildCatalog, type ReelJson, upload, writeCatalog } from "./catalog-lib.ts";

const { values } = parseArgs({
  options: {
    "reels-dir": { type: "string" },
    "progress-db": { type: "string" },
    d1: { type: "boolean" },
    "env-file": { type: "string" },
    out: { type: "string", default: "catalog-out" },
    upload: { type: "string" },
    version: { type: "string" },
  },
});

type Row = Record<string, unknown>;
type Query = (sql: string, params?: (string | number)[]) => Promise<Row[]>;

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

function localQuery(path: string): Query {
  if (!existsSync(path)) {
    console.error(
      `progress database not found: ${resolve(path)}\n` +
        "The generator writes vital_progress.sqlite3 (or its --db path) in the directory it ran from, and only when D1 is not configured. " +
        "If it uses D1, pass --d1 --env-file <generator .env> instead.",
    );
    process.exit(2);
  }
  const db = new DatabaseSync(path, { readOnly: true });
  return async (sql, params = []) => db.prepare(sql).all(...params) as Row[];
}

function d1Query(envFile: string | undefined): Query {
  const fileEnv: Record<string, string | undefined> = envFile ? parseEnv(readFileSync(envFile, "utf8")) : {};
  // Same rules as the generator: values copied unchanged from .env.example count as unset.
  const env = (name: string) => {
    const value = (fileEnv[name] ?? process.env[name] ?? "").trim();
    return value === "replace_me" ? "" : value;
  };
  const config = {
    CLOUDFLARE_ACCOUNT_ID: env("CLOUDFLARE_ACCOUNT_ID") || env("R2_ACCOUNT_ID"),
    CLOUDFLARE_API_TOKEN: env("CLOUDFLARE_API_TOKEN"),
    D1_DATABASE_ID: env("D1_DATABASE_ID"),
  };
  const missing = Object.entries(config).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`missing D1 configuration: ${missing.join(", ")}${envFile ? ` (checked ${resolve(envFile)} and the environment)` : ""}`);
    process.exit(2);
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/d1/database/${config.D1_DATABASE_ID}/query`;
  return async (sql, params = []) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      errors?: { message: string }[];
      result?: { results?: Row[] }[];
    } | null;
    if (!res.ok || !body?.success) {
      throw new Error(`D1 query failed (HTTP ${res.status}): ${body?.errors?.map((e) => e.message).join("; ") || res.statusText}`);
    }
    return body.result?.[0]?.results ?? [];
  };
}

const PAGE = 500;

async function fromProgressDb(query: Query): Promise<ReelJson[]> {
  const cols = new Set((await query("PRAGMA table_info(articles)")).map((c) => c.name));
  const label = cols.has("vital_field") ? "vital_field, vital_subfield" : "NULL AS vital_field, NULL AS vital_subfield";

  // Keyset-paginated so large D1 results stay within per-request limits.
  const articles: Row[] = [];
  for (let after = ""; ; ) {
    const page = await query(
      `SELECT title, pageid, resolved_title, canonical_url, revision_id, vital_level, ${label}, summary, categories,
              embedding_model, embedding_dim, embedding
       FROM articles WHERE status = 'done' AND embedding IS NOT NULL AND r2_reel_uploaded_at IS NOT NULL AND title > ?
       ORDER BY title LIMIT ${PAGE}`,
      [after],
    );
    articles.push(...page);
    if (page.length < PAGE) break;
    after = String(page.at(-1)!.title);
  }

  const sections = new Map<string, Row[]>();
  for (let after: [string, number] = ["", -1]; ; ) {
    const page = await query(
      `SELECT title, position, section_title, r2_key FROM sections
       WHERE r2_uploaded_at IS NOT NULL AND (title, position) > (?, ?)
       ORDER BY title, position LIMIT ${PAGE * 10}`,
      after,
    );
    for (const s of page) {
      const key = String(s.title);
      if (!sections.has(key)) sections.set(key, []);
      sections.get(key)!.push(s);
    }
    if (page.length < PAGE * 10) break;
    const last = page.at(-1)!;
    after = [String(last.title), Number(last.position)];
  }

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
    infographics: (sections.get(String(a.title)) ?? []).map((s) => ({
      page: Number(s.position),
      section: String(s.section_title),
      r2_key: s.r2_key as string,
    })),
  }));
}

if (!values["reels-dir"] && !values["progress-db"] && !values.d1) {
  console.error(
    "usage: build-catalog.ts (--reels-dir <dir> | --progress-db <path> | --d1 [--env-file <path>]) [--out dir] [--upload local|remote]",
  );
  process.exit(2);
}
const reels = [
  ...(values["reels-dir"] ? fromDir(values["reels-dir"]) : []),
  ...(values["progress-db"] ? await fromProgressDb(localQuery(values["progress-db"])) : []),
  ...(values.d1 ? await fromProgressDb(d1Query(values["env-file"])) : []),
];
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
