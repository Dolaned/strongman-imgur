const REDDIT_BASE = "https://www.reddit.com";
const UA = "strongman-imgur-cf/1.0 (+https://github.com/akotzias/strongman-imgur)";
const IMGUR_RE = /https?:\/\/(?:i\.|m\.)?imgur\.com\/[A-Za-z0-9./?=#&_-]+/gi;
const MORECHILDREN_BATCH = 100;
const KV_KEY = "data";
const THREADS_URL = "https://akotzias.github.io/strongman-imgur/threads.json";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { "user-agent": UA }, cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function collectInto(listing, comments, moreQueue) {
  if (!listing || listing.kind !== "Listing") return;
  for (const c of listing.data.children) {
    if (c.kind === "t1") {
      comments.push(c.data);
      if (c.data.replies) collectInto(c.data.replies, comments, moreQueue);
    } else if (c.kind === "more") {
      if (c.data.children?.length) moreQueue.push({ kind: "ids", ids: [...c.data.children] });
      else if (c.data.parent_id) moreQueue.push({ kind: "continue", parentId: c.data.parent_id });
    }
  }
}

async function fetchAllComments(threadId) {
  const data = await fetchJSON(`${REDDIT_BASE}/comments/${threadId}.json?raw_json=1&limit=500`);
  const totalReported = data[0]?.data?.children?.[0]?.data?.num_comments ?? null;

  const comments = [];
  const moreQueue = [];
  collectInto(data[1], comments, moreQueue);

  while (moreQueue.length) {
    const item = moreQueue.shift();
    try {
      const things = [];
      if (item.kind === "ids") {
        for (let j = 0; j < item.ids.length; j += MORECHILDREN_BATCH) {
          const slice = item.ids.slice(j, j + MORECHILDREN_BATCH);
          const u =
            `${REDDIT_BASE}/api/morechildren.json?api_type=json&raw_json=1` +
            `&link_id=t3_${threadId}&children=${slice.join(",")}`;
          const j2 = await fetchJSON(u);
          things.push(...(j2.json?.data?.things || []));
        }
      } else if (item.kind === "continue") {
        const parentBase = item.parentId.replace(/^t1_/, "");
        const u = `${REDDIT_BASE}/comments/${threadId}/_/${parentBase}.json?raw_json=1&limit=500`;
        const j2 = await fetchJSON(u);
        const root = j2[1]?.data?.children?.[0];
        if (root?.kind === "t1") {
          comments.push(root.data);
          if (root.data.replies) collectInto(root.data.replies, comments, moreQueue);
        }
      }
      for (const t of things) {
        if (t.kind === "t1") {
          comments.push(t.data);
          if (t.data.replies) collectInto(t.data.replies, comments, moreQueue);
        } else if (t.kind === "more") {
          if (t.data.children?.length) moreQueue.push({ kind: "ids", ids: [...t.data.children] });
          else if (t.data.parent_id) moreQueue.push({ kind: "continue", parentId: t.data.parent_id });
        }
      }
    } catch (e) {
      console.warn("expand failed", e.message);
    }
  }

  const byId = new Map();
  for (const c of comments) byId.set(c.id, c);
  return { comments: [...byId.values()], totalReported };
}

function extractEntries(comments) {
  const entries = [];
  for (const c of comments) {
    if (!c.body) continue;
    const found = c.body.match(IMGUR_RE) || [];
    if (!found.length) continue;
    const links = [...new Set(found.map((u) => u.replace(/[).,]+$/, "")))];
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

async function rebuild() {
  const threads = await fetchJSON(THREADS_URL);
  const out = { generated_at: new Date().toISOString(), threads: [] };
  for (const t of threads) {
    const { comments, totalReported } = await fetchAllComments(t.id);
    const entries = extractEntries(comments);
    out.threads.push({
      ...t,
      total_comments_loaded: comments.length,
      total_comments_reported: totalReported,
      entries,
    });
  }
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    if (url.pathname === "/data.json") {
      const cached = await env.IMGUR_KV.get(KV_KEY);
      if (!cached) {
        return new Response(JSON.stringify({ error: "no data yet — wait for cron or hit /trigger" }), {
          status: 503,
          headers: { "content-type": "application/json", ...cors },
        });
      }
      return new Response(cached, {
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=30",
          ...cors,
        },
      });
    }

    if (url.pathname === "/trigger") {
      const data = await rebuild();
      await env.IMGUR_KV.put(KV_KEY, JSON.stringify(data));
      return new Response(JSON.stringify({ ok: true, generated_at: data.generated_at, threads: data.threads.map(t => ({ id: t.id, entries: t.entries.length, loaded: t.total_comments_loaded })) }), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    return new Response("strongman-imgur worker — see /data.json", { headers: cors });
  },

  async scheduled(_event, env, _ctx) {
    const data = await rebuild();
    await env.IMGUR_KV.put(KV_KEY, JSON.stringify(data));
  },
};
