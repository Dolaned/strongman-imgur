# strongman-imgur

Static site that lists every Reddit comment containing an imgur link from a curated set of threads.

**Live:** https://akotzias.github.io/strongman-imgur/

Fetching happens **client-side in the visitor's browser** (Reddit returns 403 to GitHub Actions runner IPs), so the data is always live and the page auto-refreshes every 60 seconds while open.

## Layout

- `public/threads.json` — the list of threads to render: `{id, title, url}` per entry.
- `public/app.js` — fetches `https://www.reddit.com/comments/<id>.json` for each thread, walks the comment tree, extracts imgur URLs, renders one section per thread.
- `public/index.html` + `style.css` — the page.
- `.github/workflows/update.yml` — deploys `public/` to GitHub Pages on push.

## Add another thread

Edit `public/threads.json` and append:

```json
{
  "id": "abc123",
  "title": "Some other thread",
  "url": "https://www.reddit.com/r/.../comments/abc123/..."
}
```

The `id` is the alphanumeric segment after `/comments/` in the URL. Push to `main` and Pages redeploys.

## Local

```sh
python3 -m http.server -d public 8080
```

Then open http://localhost:8080. (Opening `public/index.html` via `file://` won't work — `fetch()` blocks `file://` origins.)

## Deploy

Pushing to `main` triggers `.github/workflows/update.yml`, which uploads `public/` to GitHub Pages. Pages source is set to "GitHub Actions" (configured once via `gh api -X POST repos/akotzias/strongman-imgur/pages -f build_type=workflow`).
