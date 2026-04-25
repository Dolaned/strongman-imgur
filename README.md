# strongman-imgur

Static site that lists every Reddit comment containing an imgur link from a curated set of threads.

## How it works

- `threads.json` — list of Reddit threads to scrape (id, title, url).
- `scripts/build.js` — fetches each thread's `.json`, walks all comments, extracts imgur URLs, writes `public/data.json`.
- `public/` — the GitHub Pages site. Loads `data.json` on page load and renders one section per thread.
- `.github/workflows/update.yml` — runs the build on push, on a 30-min cron, and on manual dispatch, then deploys `public/` to Pages.

## Add another thread

Append an entry to `threads.json`:

```json
{
  "id": "abc123",
  "title": "Some other thread",
  "url": "https://www.reddit.com/r/.../comments/abc123/..."
}
```

The `id` is the alphanumeric segment after `/comments/` in the URL. Push to `main` and the Action rebuilds.

## Local

```sh
node scripts/build.js
python3 -m http.server -d public 8080
```

## Setup notes

After pushing the repo to GitHub: **Settings → Pages → Source: GitHub Actions**. The first push (or a manual `workflow_dispatch`) deploys.
