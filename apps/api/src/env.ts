export interface Env {
  USER: DurableObjectNamespace<import("./user-do.ts").UserDO>;
  /** Bucket written by wiki-reels-generator: reels/*, catalog/*. */
  REELS: R2Bucket;
  DB?: D1Database;
  EVENTS?: Queue<EventLog>;
  METRICS?: AnalyticsEngineDataset;
  VECTORIZE?: Vectorize;
  /** Public base URL for R2 objects (custom domain); empty = proxy through /img. */
  IMAGE_BASE?: string;
  ALLOWED_ORIGINS?: string;
  TOKEN_SECRET: string;
}

/** One row of the append-only events log (D1 `events`). */
export interface EventLog {
  userId: string;
  profileVersion: number;
  bucket: number;
  catalogVersion: string;
  pageid: number;
  field: string | null;
  ts: number;
  reward: number;
  effective: number;
  explicit: boolean;
  pagesSeen: number;
  nPages: number;
  dwellMs: number;
  liked: boolean;
  saved: boolean;
  notInterested: boolean;
  lessTopic: boolean;
  mode: string;
  position: number;
  reason: string | null;
  prob: number | null;
  explore: boolean | null;
}
