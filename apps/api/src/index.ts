import {
  FeedRequest,
  LibraryRequest,
  OnboardingRequest,
  PrefsRequest,
  ResetRequest,
  SessionRequest,
  type SessionResponse,
} from "@wiki-reels/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { z } from "zod";
import { signToken, verifyToken } from "./auth.ts";
import { CatalogUnavailable, getCatalog, imageBase, toCard } from "./catalog.ts";
import { buildCoeng } from "./coeng.ts";
import type { Env, EventLog } from "./env.ts";

export { UserDO } from "./user-do.ts";

type Ctx = { Bindings: Env; Variables: { userId: string } };
const app = new Hono<Ctx>();

app.use(
  "/v1/*",
  cors({
    origin: (origin, c) => {
      const allowed = (c.env.ALLOWED_ORIGINS ?? "*").split(",").map((s: string) => s.trim());
      return allowed.includes("*") || allowed.includes(origin) ? origin : null;
    },
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.onError((err, c) => {
  if (err instanceof CatalogUnavailable) return c.json({ error: err.message }, 503);
  if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

class BadRequest extends Error {}

/** Parses JSON bodies, including text/plain bodies sent by navigator.sendBeacon. */
async function body<T extends z.ZodType>(c: { req: { text(): Promise<string> } }, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = JSON.parse((await c.req.text()) || "{}");
  } catch {
    throw new BadRequest("invalid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequest(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

const stub = (env: Env, userId: string) => env.USER.get(env.USER.idFromName(userId));

app.post("/v1/session", async (c) => {
  const { deviceId } = await body(c, SessionRequest);
  const userId = `a_${deviceId}`;
  const token = await signToken(userId, c.env.TOKEN_SECRET);
  const profile = await stub(c.env, userId).profile(userId);
  if (c.env.DB) {
    const now = Date.now();
    c.executionCtx.waitUntil(
      c.env.DB.prepare(
        "INSERT INTO users (id, created_at, last_seen) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen",
      )
        .bind(userId, now, now)
        .run(),
    );
  }
  return c.json<SessionResponse>({ token, userId, onboarded: profile.onboarded });
});

// Public, cacheable catalog reads.
app.get("/v1/reels/:pageid{[0-9]+}", async (c) => {
  const { catalog } = await getCatalog(c.env.REELS);
  const row = catalog.rowOf(Number(c.req.param("pageid")));
  if (row === undefined) return c.json({ error: "Not found" }, 404);
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(toCard(catalog, row, imageBase(c.env, new URL(c.req.url).origin)));
});

app.get("/v1/related/:pageid{[0-9]+}", async (c) => {
  const pageid = Number(c.req.param("pageid"));
  const limit = Math.min(20, Math.max(1, Number(c.req.query("limit") ?? 6) || 6));
  const { catalog } = await getCatalog(c.env.REELS);
  const row = catalog.rowOf(pageid);
  if (row === undefined) return c.json({ error: "Not found" }, 404);
  let rows: number[];
  if (c.env.VECTORIZE) {
    const { matches } = await c.env.VECTORIZE.queryById(String(pageid), { topK: limit + 1 });
    rows = matches.map((m) => catalog.rowOf(Number(m.id))).filter((r): r is number => r !== undefined && r !== row);
  } else {
    const sims = catalog.dotAll(catalog.vector(row));
    rows = [...sims.keys()].filter((r) => r !== row).sort((a, b) => sims[b] - sims[a]);
  }
  const base = imageBase(c.env, new URL(c.req.url).origin);
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({ pageid, related: rows.slice(0, limit).map((r) => toCard(catalog, r, base)) });
});

// Everything below needs a session token (header, or ?token= for sendBeacon).
app.use("/v1/*", async (c, next) => {
  const header = c.req.header("Authorization")?.replace(/^Bearer /, "");
  const userId = await verifyToken(header ?? c.req.query("token"), c.env.TOKEN_SECRET);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", userId);
  await next();
});

app.get("/v1/profile", async (c) => c.json(await stub(c.env, c.var.userId).profile(c.var.userId)));

app.post("/v1/onboarding", async (c) => {
  const { fields } = await body(c, OnboardingRequest);
  await stub(c.env, c.var.userId).onboard(c.var.userId, fields);
  return c.json({ ok: true });
});

app.post("/v1/prefs", async (c) => {
  const { hiddenFields } = await body(c, PrefsRequest);
  await stub(c.env, c.var.userId).setHidden(c.var.userId, hiddenFields);
  return c.json({ ok: true });
});

app.post("/v1/profile/reset", async (c) => {
  const { mode, fields } = await body(c, ResetRequest);
  try {
    await stub(c.env, c.var.userId).reset(c.var.userId, mode, fields);
  } catch (err) {
    if (err instanceof Error && err.message.includes("nothing to undo")) throw new BadRequest("nothing to undo");
    throw err;
  }
  return c.json({ ok: true });
});

app.post("/v1/feed", async (c) => {
  const req = await body(c, FeedRequest);
  const base = imageBase(c.env, new URL(c.req.url).origin);
  const { response, logs } = await stub(c.env, c.var.userId).feed(c.var.userId, req, base);
  if (logs.length) c.executionCtx.waitUntil(recordEvents(c.env, logs));
  return c.json(response);
});

app.get("/v1/library", async (c) => {
  const base = imageBase(c.env, new URL(c.req.url).origin);
  return c.json(await stub(c.env, c.var.userId).library(c.var.userId, base));
});

app.post("/v1/library", async (c) => {
  const { pageid, kind, on } = await body(c, LibraryRequest);
  await stub(c.env, c.var.userId).setLibrary(c.var.userId, pageid, kind, on);
  return c.json({ ok: true });
});

const IMAGE_TYPES: Record<string, string> = { webp: "image/webp", png: "image/png", svg: "image/svg+xml" };

// R2 proxy for infographics when no public bucket domain is configured (IMAGE_BASE unset).
app.get("/img/:key{reels/.+}", async (c) => {
  const key = c.req.param("key");
  if (!/^reels\/\d+\/infographics\/\d{3}\.(webp|png|svg)$/.test(key)) return c.notFound();
  const object = await c.env.REELS.get(key);
  if (!object) return c.notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", IMAGE_TYPES[key.slice(key.lastIndexOf(".") + 1)]);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=604800, immutable");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(object.body, { headers });
});

async function recordEvents(env: Env, logs: EventLog[]): Promise<void> {
  for (const l of logs) {
    env.METRICS?.writeDataPoint({
      indexes: [String(l.bucket)],
      blobs: [l.mode, l.field ?? "", l.reason ?? "", l.explicit ? "explicit" : "implicit"],
      doubles: [l.reward, l.pagesSeen / l.nPages, l.dwellMs, l.liked ? 1 : 0, l.notInterested ? 1 : 0],
    });
  }
  if (env.EVENTS) await env.EVENTS.sendBatch(logs.map((body) => ({ body })));
  else if (env.DB) await insertEvents(env.DB, logs);
}

export async function insertEvents(db: D1Database, logs: EventLog[]): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO events (user_id, profile_version, bucket, catalog_version, pageid, field, ts, reward, effective,
      explicit, pages_seen, n_pages, dwell_ms, liked, saved, not_interested, less_topic, mode, position, reason, prob, explore)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const b = (x: boolean) => (x ? 1 : 0);
  await db.batch(
    logs.map((l) =>
      stmt.bind(
        l.userId, l.profileVersion, l.bucket, l.catalogVersion, l.pageid, l.field, l.ts, l.reward, l.effective,
        b(l.explicit), l.pagesSeen, l.nPages, l.dwellMs, b(l.liked), b(l.saved), b(l.notInterested), b(l.lessTopic),
        l.mode, l.position, l.reason, l.prob, l.explore === null ? null : b(l.explore),
      ),
    ),
  );
}

/** Nightly: rebuild item-item co-engagement from the last 30 days of positive events. */
export async function rebuildCoeng(env: Env, now = Date.now()): Promise<number> {
  if (!env.DB) return 0;
  const { results } = await env.DB.prepare(
    "SELECT user_id, pageid FROM events WHERE ts > ? AND (reward >= 0.5 OR liked = 1 OR saved = 1) ORDER BY ts",
  )
    .bind(now - 30 * 24 * 3600 * 1000)
    .all<{ user_id: string; pageid: number }>();
  const coeng = buildCoeng(results);
  await env.REELS.put("catalog/coeng.json", JSON.stringify(coeng), {
    httpMetadata: { contentType: "application/json" },
  });
  return Object.keys(coeng).length;
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<EventLog>, env: Env): Promise<void> {
    if (!env.DB) return batch.ackAll();
    await insertEvents(env.DB, batch.messages.map((m) => m.body));
    batch.ackAll();
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(rebuildCoeng(env).then((n) => console.log(`co-engagement rebuilt for ${n} reels`)));
  },
} satisfies ExportedHandler<Env, EventLog>;
