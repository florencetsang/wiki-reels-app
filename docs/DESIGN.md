# Wiki Reels: design

Wiki Reels is a mobile-first PWA that serves "reels" made by
[wiki-reels-generator](https://github.com/florencetsang/wiki-reels-generator): one Wikipedia Vital Article per reel,
shown as a title card plus a few 9:16 section infographics. The feed learns what each user enjoys from how they watch
and picks the next reels for them.

## 1. Principles

1. **Everything expensive is precomputed.** The generator writes the reel JSON, the infographics and a 384-d
   all-MiniLM-L6-v2 embedding for each article. The app never calls a model at request time.
2. **Score the whole catalog in memory.** The whole library is held in memory as int8 vectors: 10k reels × 384
   dimensions ≈ 3.8 MB (50k ≈ 19 MB). The library is loaded once per Worker isolate from a versioned R2 snapshot.
   Every request scores every unseen reel exactly. This makes "already seen" filtering, topic feeds and exploration
   trivial, and avoids Vectorize top-K and metadata limits. Vectorize is optional, for `/related`.
3. **One Durable Object per user** holds that user's recommender state. Updates are strongly consistent, and a swipe
   needs no database round trip.
4. **One round trip per swipe.** `POST /v1/feed` takes the latest view events, updates the profile and returns the
   next reels. It can also tell the client to drop queued reels that the user's latest feedback made stale.
5. **A reel has several pages.** Pages read and time per page are the main implicit signal, rather than raw time on
   the reel.
6. **Topic labels come free.** The generator records which "Wikipedia level-N vital articles in &lt;Field&gt;"
   category each article came from (`vital_field`), so no classifier is needed.

## 2. Architecture

```
 wiki-reels-generator (Python, offline)            wiki-reels-app (this repo)
 ──────────────────────────────────────            ──────────────────────────────────────────────────
 discover → summarize → embed → render             apps/web   React + Vite PWA (service worker caches images)
   + vital_field / vital_subfield                    │  same origin, served as Worker static assets
   ▼                                                 ▼
 R2 reels/<id>.json, reels/<id>/infographics/*   apps/api   Cloudflare Worker (Hono)
 Vectorize wiki-reels (optional)                    ├─ POST /v1/session, /v1/feed, /v1/onboarding, ...
        │                                           ├─ UserDO (SQLite): profile, seen, served, library
        ▼                                           ├─ in-memory catalog (per isolate, refreshed every 60 s)
 scripts/build-catalog.ts  ──►  R2 catalog/<v>/{meta.json, vecs.i8}, catalog/current.json
                                                    ├─ Queue → D1 events (append-only log)
                                                    ├─ Analytics Engine (live metrics)
                                                    └─ Cron (daily): item-item co-engagement → R2 catalog/coeng.json
```

| Data | Where |
|---|---|
| Infographics | R2 (generator bucket). Served from a public custom domain when `IMAGE_BASE` is set; otherwise proxied by `/img/*`. Immutable, cached for 7 days by the browser and 30 days by the service worker. |
| Catalog snapshot | R2 `catalog/<version>/meta.json` and `vecs.i8` (int8 rows with a per-row scale). `catalog/current.json` points at the live version. |
| User state | `UserDO` SQLite: `kv` (state JSON, reset archive), `seen`, `served` (reason and probability, 6 h TTL), `library`. |
| Event log | D1 `events`, written through a Queue (or directly when no Queue is bound). |
| Co-engagement | R2 `catalog/coeng.json`, rebuilt daily from 90 days of positive events. |

### API (v1)

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/session {deviceId}` | – | Anonymous session. Returns an HMAC token for user `a_<deviceId>`. |
| `GET /v1/profile` | ✓ | Chosen and hidden fields, interest per field, interaction count, whether undo is possible. |
| `POST /v1/onboarding {fields}` | ✓ | Starting priors; an empty list means "Surprise me". |
| `POST /v1/feed {events, need, queued, field?}` | ✓ | Applies events and returns `{reels, drop, notice?}`. Also accepts `?token=` with a text/plain body, for `sendBeacon`. |
| `GET/POST /v1/library` | ✓ | Saved, liked and history. |
| `POST /v1/profile/reset {mode: soft\|hard\|undo, fields?}` | ✓ | Edit topics, start over, or undo (within 7 days). |
| `POST /v1/prefs {hiddenFields}` | ✓ | Fields that never appear. |
| `GET /v1/reels/:id`, `GET /v1/related/:id` | – | Public, cacheable. |
| `GET /img/reels/...` | – | R2 image proxy. |

## 3. UI/UX

**Screens**

1. **Onboarding:** "Learn something in 60 seconds." The user picks at least 3 of the 11 Vital Articles fields, or
   chooses 🎲 *Surprise me*. There is no sign-up.
2. **For you (the feed):**
   - Full-screen 9:16 frame, letterboxed on desktop.
   - Swipe **up/down** to move between reels and **left/right** to move between pages. Progress bars at the top show
     the current page.
   - Page 1 is the title card (field chip, title, summary, "N pages · swipe ←"). Then come the infographics. The
     last page is an end card with *Read on Wikipedia*, the full CC BY-SA attribution and 4 related reels; tapping one
     plays it next.
   - **Action rail:** ♥ Like, 🔖 Save, ↗ Share, ⋯ More. *More* opens *Not interested*, *Less &lt;field&gt;*,
     *More &lt;field&gt;* and *Report a problem*.
   - **Bottom overlay:** the title, a "New for you" badge on exploration picks, *Why this?* and the attribution link.
     *Why this?* gives the reason: "Because you enjoyed Roman Empire", "Exploring: Mathematics" or "Popular in
     History".
   - Double-tap likes, and long-press opens a zoomable, pannable viewer for dense infographics.
3. **Explore:** a grid of fields with the user's interest meter. A field opens the same feed limited to that topic.
   Signals gathered there count half, because the user chose the context.
4. **Library:** Saved, Liked and History tabs.
5. **You (settings):**
   - "What we think you like" shows a bar per field. This is all the profile is, so it is shown openly.
   - *Change my topics* is a soft reset. *Reset my recommendations* is a hard reset; it asks for confirmation and
     can be undone for 7 days.
   - Hidden topics, data saver (no preloading of upcoming reels) and reduce motion.

**Interaction details**

- **Keyboard:** ↑/↓ or J/K move between reels, ←/→ move between pages, L likes, S saves, X marks Not interested, and
  Esc closes sheets.
- **Accessibility:** alt text is "&lt;title&gt;: &lt;section&gt; (infographic i of n)". All controls are labelled
  buttons. `prefers-reduced-motion` and an in-app toggle are both respected.
- **Performance:** the client keeps 5 reels ahead and refills when 3 remain. It loads all pages of the current reel
  and page 1 of the next two. Only the current reel ±2 is rendered.
- **Offline and empty states:** cached images keep working offline. "You've seen everything in X 🎉" appears when a
  topic runs out, and there is a retry when the API can't be reached.

## 4. Recommendation algorithm (`packages/reco`)

### 4.1 Reward per reel view

The client sends one `ViewEvent` per reel when it leaves the screen, or immediately for *Not interested*. The event
records pages seen, dwell time per page, explicit flags, mode, position and timestamp.

| Signal | Reward | Weight |
|---|---|---|
| Not interested / Less like this topic | −1 | explicit (1.0) |
| Like / Save / Share | +1 | explicit |
| Opened Wikipedia | +0.8 | explicit |
| Instant skip: under 1.5 s, title card only | −0.4 | implicit (0.4) |
| Only the title card (glance) | 0.3·min(q,1) − 0.15 | implicit |
| Otherwise | min(0.9, 0.2 + 0.6·completion + 0.2·min(q,1)) | implicit |

`q` is the median page dwell divided by the expected 5 s per page. The effective reward is reward × weight, halved in
topic mode.

### 4.2 User state (about 10 KB JSON in the UserDO)

- **Topic Betas:** (α, β) per field. Chosen fields start at (3, 1) and the rest at (1, 2).
- **Interests:** up to 5 weighted prototype vectors. There are several because averaging two interests gives an
  irrelevant middle. A positive reel within cosine 0.6 of a prototype moves it by 0.1·eff; otherwise it starts a new
  prototype.
- **Negatives:** up to 5 prototypes from reels with eff < −0.3.
- **Session vector:** an EMA with rate 0.3 over the last 30 minutes, seeded from long-term interests.
- **Other:** decay of 0.995 per event (weights below 0.05 are pruned), a count of interactions, recently liked reels
  (for co-engagement) and the A/B bucket.
- **Less like this topic** also removes the field from the chosen fields and adds β ≥ 3α. It weakens prototypes close
  to the field centroid, pushes the session vector away from it, and keeps the field out of the main feed for the
  next 20 reels.

### 4.3 Score for every eligible reel

```
conf  = 1 − exp(−interactions / 40)
score = (0.35(1−conf) + 0.10)·topicMean(field)
      + (0.30·conf + 0.10)·max_k cos(e, interest_k)·ŵ_k
      + 0.20·cos(e, session)
      + 0.10·coEngagement(e, recent likes)
      + (0.10(1−conf) + 0.02)·popularity(vital level)
      + 0.05·min(1, pages/8)
      − 0.30·max_k cos(e, negative_k)·ŵ_k
```

Eligible means not seen, not queued on the client, has infographics, and is not in a hidden or cooling-down field.
In topic mode, only that field is eligible.

### 4.4 Building a slate

- **Exploration rate:** ε falls from 0.25 to 0.10 as confidence grows. In topic mode it is 0.10 and stays inside the
  field.
- **Explore slot:** Thompson-sample a field from the Betas, then softmax(popularity − 0.5·similarity to interests) at
  T = 0.1 over the top 30 reels. This finds popular reels in a field the user hasn't explored yet.
- **Exploit slot:** MMR (penalty 0.3 × max cosine to reels already picked) over the top 100, then softmax at T = 0.05.
- **Variety:** at most 3 reels in a row from the same field.
- **Logging:** every served reel logs a reason and the probability it was picked. Events join these into D1, so a
  learned ranker can later be trained with inverse propensity weighting.
- **Dropping stale reels:** queued reels are dropped when the profile vector drifts below cosine 0.9 from the vector
  used to pick them. They are also dropped when they are close to a reel the user just rejected (cosine > 0.6), or
  share a field the user just asked to see less of.

### 4.5 Resets

- **Soft (edit topics):** old Beta evidence shrinks to 20% of its strength. New fields are set above anything learned
  before. Interest weights are multiplied by 0.2 and negative weights by 0.5. The seen list is kept.
- **Hard:** the old state is archived (undo is available for 7 days) and onboarding runs again. The seen list is kept,
  so old reels don't repeat.

### 4.6 Collaborative signal and learned ranking

- **Daily cron (live now):** builds item-item co-engagement from users' positive events: cosine × co/(co + 5),
  minimum support 5, top 20 per reel. The result feeds the `cf` term. It helps sooner than user clustering when
  there are few users.
- **Next steps:**
  - A logistic or GBDT ranker trained with IPS on `events` (the logged `prob` makes this possible).
  - Per-bucket A/B tests on `PARAMS`.
  - Optional subfield Betas.

### 4.7 Offline simulator

`npm run sim` uses a synthetic catalog (3000 reels, 11 fields × 6 subtopics) and synthetic users with hidden tastes.
Engagement in the later part of each session:

| Policy | Engagement | Fields per 10 reels |
|---|---|---|
| random | 0.15 | 6.8 |
| popular | 0.14 | 6.9 |
| **reco** | **0.64** | 2.3 |

Engagement starts at about 0.47 and rises to 0.64 within a session, while the feed still covers more than 2 fields per
10 reels. Tests in `packages/reco/test` keep these results from regressing.

## 5. Metrics

- **Live:** Analytics Engine dataset `wiki_reels_events`. Indexed by A/B bucket. Blobs: mode, field, reason, explicit.
  Doubles: reward, completion, dwell, liked, not interested.
- **SQL:** `docs/metrics.sql` holds D1 queries for completion, like rate, Not-interested rate, reels per session,
  fields per session, exploration hit rate, day-1 and day-7 return, and return after a reset.

## 6. Privacy and licensing

- Users are anonymous: a random device UUID in localStorage. The profile is a few vectors and counts, and is shown in
  full on the *You* screen. Sign-in to sync across devices is planned; it would link the device user to an account.
- Wikipedia text is CC BY-SA 4.0, and the infographics are derivative works. Every reel links to the article (at its
  revision when known), and the end card carries the full attribution.
