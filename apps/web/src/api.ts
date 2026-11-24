import type {
  FeedRequest,
  FeedResponse,
  LibraryResponse,
  ProfileResponse,
  ReelCard,
  SessionResponse,
  ViewEvent,
} from "@wiki-reels/shared";

const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
const DEVICE_KEY = "wr.device";
const TOKEN_KEY = "wr.token";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export async function startSession(): Promise<SessionResponse> {
  const res = await fetch(`${BASE}/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: deviceId() }),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const session = (await res.json()) as SessionResponse;
  localStorage.setItem(TOKEN_KEY, session.token);
  return session;
}

async function call<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401 && retry) {
    await startSession();
    return call(path, init, false);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  profile: () => call<ProfileResponse>("/v1/profile"),
  onboard: (fields: string[]) => post("/v1/onboarding", { fields }),
  feed: (req: Partial<FeedRequest>) => post<FeedResponse>("/v1/feed", req),
  library: () => call<LibraryResponse>("/v1/library"),
  setLibrary: (pageid: number, kind: "saved" | "liked", on: boolean) => post("/v1/library", { pageid, kind, on }),
  reset: (mode: "soft" | "hard" | "undo", fields?: string[]) => post("/v1/profile/reset", { mode, fields }),
  setHidden: (hiddenFields: string[]) => post("/v1/prefs", { hiddenFields }),
  related: (pageid: number) => call<{ pageid: number; related: ReelCard[] }>(`/v1/related/${pageid}`),
};

/** Delivers events while the page is being hidden or closed; fetch may not complete then. */
export function sendEventsBeacon(events: ViewEvent[], queued: number[], field?: string): boolean {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token || events.length === 0 || !navigator.sendBeacon) return false;
  const body = new Blob([JSON.stringify({ events, need: 0, queued, field })], { type: "text/plain" });
  return navigator.sendBeacon(`${BASE}/v1/feed?token=${encodeURIComponent(token)}`, body);
}
