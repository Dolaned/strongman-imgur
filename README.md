# strongman-imgur

Static site that lists every Reddit comment containing an imgur link from a curated set of threads.

**Live:** https://akotzias.github.io/strongman-imgur/

## Architecture

```
threads.json  ──►  Cloudflare Worker  ──►  Workers KV  ──►  GitHub Pages site
                   (cron every 5 min)      (data + state)    (polls every 60s)
```

Three moving parts:

1. **GitHub Pages site** (`public/`) — a static page that fetches `data.json` from the Worker and renders the entries. No build step; deployed via `.github/workflows/update.yml` on every push.
2. **Cloudflare Worker** (`worker/`) — runs a 5-minute cron, scrapes Reddit, stores results in KV, serves them as a CORS-enabled JSON endpoint.
3. **Workers KV** — Cloudflare's edge key-value store; this is where the data actually lives between cron ticks.

### Why a Worker (and not just GitHub Actions)

Reddit returns HTTP 403 to GitHub Actions runner IPs, so anonymous fetches from there don't work. Cloudflare's edge IPs aren't blocked. A Worker also gives us persistent state between runs, so we can scan a 4,000-comment thread incrementally instead of trying to fit it inside a single 30-second window.

### Where the data is saved

In Cloudflare Workers KV, namespace `IMGUR_KV` (id `8dbddb7408e543828a0fad2ff2e99339`), under two keys:

- **`state`** — internal: per-thread `seen_ids`, the imgur entries collected so far, the queue of unfinished `morechildren` batches, and the last-tick timestamp. The cron reads this, augments it, writes it back.
- **`data`** — public-facing: stripped-down JSON the page reads from `GET /data.json`. Contains entries, comment counts, and `backfill_pending`.

KV values are replicated across Cloudflare's edge and survive restarts/deploys. Free tier comfortably covers our usage (~288 writes/day, well under the 1k/day limit).

### How a cron tick works

For each thread in `public/threads.json`:

1. **Incremental fetch** — `GET /comments/<id>.json?sort=new&limit=500`. Walk the listing; for any comment id not in `seen_ids`, extract imgur links and add to entries. New `more` stubs go into the expansion queue.
2. **Drain backfill** — pop items off `expansion_queue` and call `morechildren` (or fetch the parent subtree for "continue this thread" stubs) until ~25s of wall time is used. Whatever's left stays in the queue for next tick.
3. Save `state` and `data` back to KV.

Net effect: a fresh thread converges to 100% comment coverage over ~1 hour of cron ticks. Once converged, each tick is essentially free — just the incremental check.

## Repo layout

```
strongman-imgur/
├── public/                    GitHub Pages root
│   ├── index.html
│   ├── style.css
│   ├── app.js                 fetches WORKER_URL/data.json, renders
│   └── threads.json           curated list of threads to scrape
├── worker/                    Cloudflare Worker source
│   ├── src/index.js           cron + HTTP handlers
│   └── wrangler.toml          worker config (cron, KV binding)
└── .github/workflows/
    └── update.yml             GH Pages deploy on push to main
```

## Worker endpoints

- `GET /data.json` — returns the cached output for the page. CORS open. Cached at the edge for 30s.
- `GET /trigger` — runs a tick immediately (manual seed/refresh). Useful after deploying changes.
- `GET /reset` — wipes both KV keys. Use only for debugging.
- `GET /` — friendly status banner.

## Operations

### Add a thread

Edit `public/threads.json` and append:

```json
{
  "id": "abc123",
  "title": "Some other thread",
  "url": "https://www.reddit.com/r/.../comments/abc123/..."
}
```

The `id` is the alphanumeric segment after `/comments/` in the URL. Push to `main`. The Worker fetches `threads.json` from the live Pages URL on every cron tick, so the next tick (≤5 min later) will start scanning the new thread. No Worker redeploy needed.

### Update the Worker

```sh
cd worker
wrangler deploy
```

If the schema of the persisted `state` changes, hit `https://strongman-imgur.akotzias-dev.workers.dev/reset` once and then `/trigger` to seed fresh.

### Local site preview

```sh
python3 -m http.server -d public 8080
```

Then open http://localhost:8080. The page will hit the live Worker for data — no local Worker needed for UI work.

### Local Worker development

```sh
cd worker
wrangler dev
```

Spins up a local edge runtime with KV emulation. Hit `http://localhost:8787/trigger` to test.

## Deploy

- **Page**: pushing to `main` triggers `.github/workflows/update.yml`, which uploads `public/` to GitHub Pages.
- **Worker**: deployed manually with `wrangler deploy` from `worker/`. Cron tick is `*/5 * * * *`. Cloudflare account: `akotzias-dev`.
