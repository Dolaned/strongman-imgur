#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const THREADS_FILE = resolve(ROOT, "threads.json");
const OUT_FILE = resolve(ROOT, "public", "data.json");

const IMGUR_RE = /https?:\/\/(?:i\.|m\.)?imgur\.com\/[A-Za-z0-9./?=#&_-]+/gi;
const UA = "strongman-imgur-list/1.0 (github pages aggregator)";

async function fetchThread(id) {
  const url = `https://www.reddit.com/comments/${id}.json?raw_json=1&limit=500`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`reddit ${id}: ${res.status} ${res.statusText}`);
  return res.json();
}

function* walkComments(listing) {
  if (!listing || listing.kind !== "Listing") return;
  for (const child of listing.data.children) {
    if (child.kind !== "t1") continue;
    yield child.data;
    if (child.data.replies) yield* walkComments(child.data.replies);
  }
}

function extractFromBody(body) {
  if (!body) return [];
  const found = body.match(IMGUR_RE) || [];
  return [...new Set(found.map((u) => u.replace(/[).,]+$/, "")))];
}

function buildEntries(redditJson) {
  const commentsListing = redditJson[1];
  const entries = [];
  for (const c of walkComments(commentsListing)) {
    const links = extractFromBody(c.body);
    if (!links.length) continue;
    entries.push({
      author: c.author,
      created_utc: c.created_utc,
      permalink: `https://www.reddit.com${c.permalink}`,
      body: c.body,
      links,
    });
  }
  entries.sort((a, b) => a.created_utc - b.created_utc);
  return entries;
}

async function main() {
  const threads = JSON.parse(await readFile(THREADS_FILE, "utf8"));
  const out = { generated_at: new Date().toISOString(), threads: [] };

  for (const t of threads) {
    process.stderr.write(`fetching ${t.id}...\n`);
    const json = await fetchThread(t.id);
    const entries = buildEntries(json);
    out.threads.push({ ...t, entry_count: entries.length, entries });
    process.stderr.write(`  ${entries.length} comments with imgur links\n`);
  }

  await writeFile(OUT_FILE, JSON.stringify(out, null, 2));
  process.stderr.write(`wrote ${OUT_FILE}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
