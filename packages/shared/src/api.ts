import { z } from "zod";
import { FIELD_IDS } from "./fields.ts";

const pageid = z.number().int().positive();
const fieldId = z.enum(FIELD_IDS as [string, ...string[]]);

/** Sent when a reel leaves the screen, or immediately for explicit actions. */
export const ViewEvent = z.object({
  pageid,
  /** Distinct pages viewed, counting the title card as page 1. */
  pagesSeen: z.number().int().min(0).max(100),
  /** Total pages in the reel, including the title card. */
  nPages: z.number().int().min(1).max(100),
  /** Visible time per page in ms, index-aligned with pages. */
  dwellMs: z.array(z.number().min(0).max(3_600_000)).max(100),
  liked: z.boolean().default(false),
  saved: z.boolean().default(false),
  shared: z.boolean().default(false),
  openedWiki: z.boolean().default(false),
  notInterested: z.boolean().default(false),
  lessTopic: z.boolean().default(false),
  mode: z.enum(["feed", "topic"]).default("feed"),
  position: z.number().int().min(0).default(0),
  ts: z.number().int().positive(),
});
export type ViewEvent = z.infer<typeof ViewEvent>;

export const SessionRequest = z.object({ deviceId: z.string().uuid() });
export const OnboardingRequest = z.object({
  fields: z.array(fieldId).max(11),
});

export const FeedRequest = z.object({
  events: z.array(ViewEvent).max(50).default([]),
  need: z.number().int().min(0).max(20).default(5),
  /** Reels already queued on the client but not yet viewed. */
  queued: z.array(pageid).max(50).default([]),
  field: fieldId.optional(),
});
export type FeedRequest = z.infer<typeof FeedRequest>;

export const LibraryRequest = z.object({
  pageid,
  kind: z.enum(["saved", "liked"]),
  on: z.boolean(),
});

export const ResetRequest = z.object({
  mode: z.enum(["soft", "hard", "undo"]),
  fields: z.array(fieldId).max(11).optional(),
});

export const PrefsRequest = z.object({ hiddenFields: z.array(fieldId).max(11) });

export interface ReelPage {
  section: string;
  url: string;
}

export interface ReelCard {
  pageid: number;
  title: string;
  field: string;
  subfield: string | null;
  level: number;
  summary: string;
  wikiUrl: string;
  revisionId: number | null;
  pages: ReelPage[];
}

export type ReasonKind = "picked" | "similar" | "explore" | "popular" | "topic";
export interface Reason {
  kind: ReasonKind;
  /** Title of the reel this one is similar to, for kind "similar". */
  anchor?: string;
}

export interface ServedReel extends ReelCard {
  reason: Reason;
}

export interface FeedResponse {
  reels: ServedReel[];
  /** Queued reels the client should discard because the profile moved. */
  drop: number[];
  notice?: "field-exhausted" | "catalog-exhausted";
}

export interface SessionResponse {
  token: string;
  userId: string;
  onboarded: boolean;
}

export interface ProfileResponse {
  onboarded: boolean;
  chosenFields: string[];
  hiddenFields: string[];
  /** Mean interest per field, 0..1. */
  fieldInterest: Record<string, number>;
  interactions: number;
  canUndoReset: boolean;
}

export interface LibraryItem extends ReelCard {
  at: number;
  reward?: number;
}

export interface LibraryResponse {
  saved: LibraryItem[];
  liked: LibraryItem[];
  history: LibraryItem[];
}
