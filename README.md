# Wiki Reels

Learn something in 60 seconds. Wiki Reels is a mobile-first PWA that serves swipeable infographic reels made from
Wikipedia's Vital Articles. The feed learns what each user enjoys from how they watch, and picks the next reels.

Reels are produced by [wiki-reels-generator](https://github.com/florencetsang/wiki-reels-generator) and stored in
Cloudflare R2. This repo is the app that serves them: a React PWA, a Cloudflare Worker API with one Durable Object per
user, and a recommender in plain TypeScript.

👉 **Design (UI/UX, architecture, algorithm, metrics): [docs/DESIGN.md](docs/DESIGN.md)**

```
apps/web         React + Vite PWA: onboarding, feed (vertical reels × horizontal pages), explore, library, settings
apps/api         Cloudflare Worker (Hono): sessions, /v1/feed, UserDO, event queue → D1, daily co-engagement cron
packages/reco    The recommender (reward, profile updates, scoring, slates) and an offline simulator
packages/shared  API types, zod schemas, the 11 Vital Articles fields
scripts/         build-catalog (generator output → R2 catalog snapshot), seed-local (synthetic dev data)
docs/            DESIGN.md, metrics.sql
```

## Quick start (local, no Cloudflare account needed)

Requires Node ≥ 22.18; scripts are run as TypeScript directly.

```bash
npm install
npm run seed:local                               # 132 synthetic reels with placeholder SVG infographics → local R2
cp apps/api/.dev.vars.example apps/api/.dev.vars
npm run db:migrate:local -w @wiki-reels/api
npm run dev:api                                  # Worker on http://127.0.0.1:8787
npm run dev:web                                  # PWA on http://localhost:5173 (proxies /v1 and /img to the Worker)
```

Until the web app is built, `dev:api` serves a placeholder page at http://127.0.0.1:8787.
To get production-like single-origin serving, run `npm run build` and then open http://127.0.0.1:8787. The Worker
serves `apps/web/dist` as static assets.

## Using real reels

The generator writes `reels/<pageid>.json` and the infographics to R2. Build the catalog snapshot (all reel metadata
plus int8 embeddings) from either source:

```bash
# From the generator's local progress database
npm run catalog:build -- --progress-db ../wiki-reels-generator/progress.sqlite --upload remote
# Or from a directory of downloaded reels/<pageid>.json files
npm run catalog:build -- --reels-dir ./reels --upload remote
```

This writes `catalog/<version>/{meta.json,vecs.i8}` and then switches `catalog/current.json` to the new version.
Running Workers pick it up within a minute. Re-run the script whenever the generator adds reels.

Field labels come from the generator's `vital_field`, which was added in the generator follow-up PR. For older reels
the script falls back to category keywords, and then to the nearest field centroid.
To label reels that are already generated without paying for generation again, run the generator with
`--backfill-labels` first. It makes no Gemini calls and does no re-embedding.

## Deploy

```bash
cd apps/api
npx wrangler d1 create wiki-reels-app            # put the database_id into wrangler.jsonc
npx wrangler queues create wiki-reels-events
npx wrangler secret put TOKEN_SECRET             # any long random string
npm run db:migrate
cd ../.. && npm run build && npm run deploy -w @wiki-reels/api
```

- `REELS` is bound to the generator's bucket (`wikiinfo`). If the bucket is served on a public custom domain, set
  `IMAGE_BASE` to that domain so images skip the Worker. Otherwise `/img/*` proxies them.
- Uncomment the `vectorize` binding to answer `/v1/related` from the generator's index. Without it, related reels
  come from the in-memory catalog.
- The Queue and Analytics Engine bindings are optional. Without the Queue, events go straight to D1.

## Development

```bash
npm test           # recommender, API (FeedService, auth, co-engagement) and web (view tracker) tests
npm run typecheck
npm run sim        # offline simulator: random vs popular vs reco policies
```

## Licensing

The code is MIT-licensed. Reel content is derived from Wikipedia and is available under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); every reel links to its source article. This project
is not affiliated with the Wikimedia Foundation.
