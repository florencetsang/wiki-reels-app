import { DurableObject } from "cloudflare:workers";
import type { UserState } from "@wiki-reels/reco";
import type { FeedRequest, FeedResponse, LibraryResponse, ProfileResponse } from "@wiki-reels/shared";
import { getCatalog } from "./catalog.ts";
import type { Env, EventLog } from "./env.ts";
import { FeedService, type LibraryKind, type Served, type UserStore } from "./feed-service.ts";

const SERVED_TTL_MS = 6 * 3600 * 1000;

/** SQLite-backed store; the seen set is cached in memory because every slate needs it. */
class SqlStore implements UserStore {
  private seen: Set<number> | null = null;

  constructor(private readonly sql: SqlStorage) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (pageid INTEGER PRIMARY KEY, at INTEGER NOT NULL, reward REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS seen_at ON seen (at);
      CREATE TABLE IF NOT EXISTS served (pageid INTEGER PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS library (pageid INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (pageid, kind));
    `);
  }

  private getKv<T>(k: string): T | null {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    return row ? (JSON.parse(row.v) as T) : null;
  }

  private putKv(k: string, v: unknown): void {
    if (v === null) this.sql.exec("DELETE FROM kv WHERE k = ?", k);
    else this.sql.exec("INSERT OR REPLACE INTO kv VALUES (?, ?)", k, JSON.stringify(v));
  }

  getState = () => this.getKv<UserState>("state");
  putState = (s: UserState) => this.putKv("state", s);
  getArchive = () => this.getKv<{ state: UserState; at: number }>("archive");
  putArchive = (state: UserState | null, at: number) => this.putKv("archive", state ? { state, at } : null);

  seenIds(): Set<number> {
    this.seen ??= new Set(this.sql.exec<{ pageid: number }>("SELECT pageid FROM seen").toArray().map((r) => r.pageid));
    return new Set(this.seen);
  }

  markSeen(pageid: number, at: number, reward: number): void {
    this.sql.exec("INSERT OR REPLACE INTO seen VALUES (?, ?, ?)", pageid, at, reward);
    this.seen?.add(pageid);
  }

  history(limit: number) {
    return this.sql
      .exec<{ pageid: number; at: number; reward: number }>(
        "SELECT pageid, at, reward FROM seen ORDER BY at DESC LIMIT ?",
        limit,
      )
      .toArray();
  }

  putServed(items: Served[]): void {
    const now = items[0]?.at ?? Date.now();
    this.sql.exec("DELETE FROM served WHERE at < ?", now - SERVED_TTL_MS);
    for (const it of items) this.sql.exec("INSERT OR REPLACE INTO served VALUES (?, ?, ?)", it.pageid, JSON.stringify(it), it.at);
  }

  takeServed(pageid: number): Served | undefined {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM served WHERE pageid = ?", pageid).toArray()[0];
    if (!row) return undefined;
    this.sql.exec("DELETE FROM served WHERE pageid = ?", pageid);
    return JSON.parse(row.v) as Served;
  }

  setLibrary(pageid: number, kind: LibraryKind, on: boolean, at: number): void {
    if (on) this.sql.exec("INSERT OR IGNORE INTO library VALUES (?, ?, ?)", pageid, kind, at);
    else this.sql.exec("DELETE FROM library WHERE pageid = ? AND kind = ?", pageid, kind);
  }

  library(kind: LibraryKind, limit: number) {
    return this.sql
      .exec<{ pageid: number; at: number }>(
        "SELECT pageid, at FROM library WHERE kind = ? ORDER BY at DESC LIMIT ?",
        kind,
        limit,
      )
      .toArray();
  }
}

/** One instance per user: strongly consistent recommender state with no database round trip per swipe. */
export class UserDO extends DurableObject<Env> {
  private service: FeedService | null = null;

  private svc(userId: string): FeedService {
    if (!this.service) {
      let h = 0;
      for (const c of userId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      this.service = new FeedService(new SqlStore(this.ctx.storage.sql), h % 100);
    }
    return this.service;
  }

  private catalog() {
    return getCatalog(this.env.REELS);
  }

  async profile(userId: string): Promise<ProfileResponse> {
    const { catalog } = await this.catalog();
    return this.svc(userId).profile(catalog, Date.now());
  }

  async onboard(userId: string, fields: string[]): Promise<void> {
    const { catalog } = await this.catalog();
    this.svc(userId).onboard(catalog, fields, Date.now());
  }

  async setHidden(userId: string, fields: string[]): Promise<void> {
    const { catalog } = await this.catalog();
    this.svc(userId).setHidden(catalog, fields);
  }

  async reset(userId: string, mode: "soft" | "hard" | "undo", fields?: string[]): Promise<void> {
    const { catalog } = await this.catalog();
    this.svc(userId).reset(catalog, mode, fields, Date.now());
  }

  async feed(userId: string, req: FeedRequest, imageBase: string): Promise<{ response: FeedResponse; logs: EventLog[] }> {
    const { catalog, coeng } = await this.catalog();
    return this.svc(userId).feed({ userId, catalog, coeng, imageBase, now: Date.now() }, req);
  }

  async setLibrary(userId: string, pageid: number, kind: LibraryKind, on: boolean): Promise<void> {
    this.svc(userId).setLibrary(pageid, kind, on, Date.now());
  }

  async library(userId: string, imageBase: string): Promise<LibraryResponse> {
    const { catalog } = await this.catalog();
    return this.svc(userId).library(catalog, imageBase);
  }
}
