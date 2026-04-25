const REDDIT_BASE = "https://www.reddit.com";
const UA = "strongman-imgur-cf/1.0 (+https://github.com/akotzias/strongman-imgur)";
const IMGUR_RE = /https?:\/\/(?:i\.|m\.)?imgur\.com\/[A-Za-z0-9./?=#&_-]+/gi;
const MORECHILDREN_BATCH = 100;
const STATE_KEY = "state";
const DATA_KEY = "data";
const THREADS_URL = "https://akotzias.github.io/strongman-imgur/threads.json";
const TIME_BUDGET_MS = 25_000;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { "user-agent": UA }, cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.slice(0, 80)}`);
  return res.json();
}

function extractLinks(body) {
  if (!body) return null;
  const found = body.match(IMGUR_RE);
  if (!found || !found.length) return null;
  return [...new Set(found.map((u) => u.replace(/[).,]+$/, "")))];
}

function entryFromComment(c) {
  const links = extractLinks(c.body);
  if (!links) return null;
  return {
    id: c.id,
    author: c.author,
    created_utc: c.created_utc,
    permalink: `https://www.reddit.com${c.permalink}`,
    body: c.body,
    links,
  };
}

function walkListing(listing, seenSet, onComment, onMore) {
  if (!listing || listing.kind !== "Listing") return;
  for (const c of listing.data.children) {
    if (c.kind === "t1") {
      if (!seenSet.has(c.data.id)) {
        seenSet.add(c.data.id);
        onComment(c.data);
      }
      if (c.data.replies) walkListing(c.data.replies, seenSet, onComment, onMore);
    } else if (c.kind === "more") {
      if (c.data.children?.length) onMore({ kind: "ids", ids: [...c.data.children] });
      else if (c.data.parent_id) onMore({ kind: "continue", parentId: c.data.parent_id });
    }
  }
}

function processThings(things, seenSet, onComment, onMore) {
  for (const t of things) {
    if (t.kind === "t1") {
      if (!seenSet.has(t.data.id)) {
        seenSet.add(t.data.id);
        onComment(t.data);
      }
      if (t.data.replies) walkListing(t.data.replies, seenSet, onComment, onMore);
    } else if (t.kind === "more") {
      if (t.data.children?.length) onMore({ kind: "ids", ids: [...t.data.children] });
      else if (t.data.parent_id) onMore({ kind: "continue", parentId: t.data.parent_id });
    }
  }
}

async function fetchListing(threadId, sort) {
  const sortParam = sort ? `&sort=${sort}` : "";
  const data = await fetchJSON(
    `${REDDIT_BASE}/comments/${threadId}.json?raw_json=1&limit=500${sortParam}`
  );
  return {
    listing: data[1],
    totalReported: data[0]?.data?.children?.[0]?.data?.num_comments ?? null,
  };
}

async function expandIds(threadId, ids) {
  const things = [];
  for (let j = 0; j < ids.length; j += MORECHILDREN_BATCH) {
    const slice = ids.slice(j, j + MORECHILDREN_BATCH);
    const u =
      `${REDDIT_BASE}/api/morechildren.json?api_type=json&raw_json=1` +
      `&link_id=t3_${threadId}&children=${slice.join(",")}`;
    const j2 = await fetchJSON(u);
    things.push(...(j2.json?.data?.things || []));
  }
  return things;
}

async function expandContinue(threadId, parentId) {
  const parentBase = parentId.replace(/^t1_/, "");
  const u = `${REDDIT_BASE}/comments/${threadId}/_/${parentBase}.json?raw_json=1&limit=500`;
  const j2 = await fetchJSON(u);
  const root = j2[1]?.data?.children?.[0];
  if (!root || root.kind !== "t1") return null;
  return root;
}

async function tickThread(threadConfig, threadState, deadlineMs) {
  const { id } = threadConfig;
  const seen = new Set(threadState.seen_ids || []);
  const entriesById = new Map((threadState.entries || []).map((e) => [e.id, e]));
  const queue = threadState.expansion_queue ? [...threadState.expansion_queue] : [];
  let totalReported = threadState.total_comments_reported ?? null;
  const isFirstRun = seen.size === 0;

  const onComment = (c) => {
    const e = entryFromComment(c);
    if (e) entriesById.set(e.id, e);
  };
  const onMore = (m) => queue.push(m);

  try {
    const { listing, totalReported: nr } = await fetchListing(
      id,
      isFirstRun ? null : "new"
    );
    if (nr !== null) totalReported = nr;
    walkListing(listing, seen, onComment, onMore);
  } catch (e) {
    console.warn(`listing ${id} failed: ${e.message}`);
  }

  while (queue.length && Date.now() < deadlineMs) {
    const item = queue.shift();
    try {
      if (item.kind === "ids") {
        const things = await expandIds(id, item.ids);
        processThings(things, seen, onComment, onMore);
      } else if (item.kind === "continue") {
        const root = await expandContinue(id, item.parentId);
        if (root) {
          if (!seen.has(root.data.id)) {
            seen.add(root.data.id);
            onComment(root.data);
          }
          if (root.data.replies) walkListing(root.data.replies, seen, onComment, onMore);
        }
      }
    } catch (e) {
      console.warn(`expand ${id} failed: ${e.message}`);
      queue.unshift(item);
      break;
    }
  }

  const entries = [...entriesById.values()].sort(
    (a, b) => a.created_utc - b.created_utc
  );
  return {
    seen_ids: [...seen],
    entries,
    expansion_queue: queue,
    total_comments_reported: totalReported,
    last_tick_utc: Math.floor(Date.now() / 1000),
  };
}

async function tick(env) {
  const threadConfigs = await fetchJSON(THREADS_URL);
  const stateRaw = await env.IMGUR_KV.get(STATE_KEY);
  const state = stateRaw ? JSON.parse(stateRaw) : { threads: {} };
  const start = Date.now();
  const n = Math.max(threadConfigs.length, 1);

  for (let i = 0; i < threadConfigs.length; i++) {
    const tc = threadConfigs[i];
    const prior = state.threads[tc.id] || {
      seen_ids: [],
      entries: [],
      expansion_queue: [],
      total_comments_reported: null,
    };
    const deadline = start + (TIME_BUDGET_MS * (i + 1)) / n;
    state.threads[tc.id] = await tickThread(tc, prior, deadline);
  }

  state.generated_at = new Date().toISOString();

  const dataView = {
    generated_at: state.generated_at,
    threads: threadConfigs.map((tc) => {
      const s = state.threads[tc.id];
      return {
        id: tc.id,
        title: tc.title,
        url: tc.url,
        total_comments_loaded: s.seen_ids.length,
        total_comments_reported: s.total_comments_reported,
        backfill_pending: s.expansion_queue.length,
        entries: s.entries,
      };
    }),
  };

  await env.IMGUR_KV.put(STATE_KEY, JSON.stringify(state));
  await env.IMGUR_KV.put(DATA_KEY, JSON.stringify(dataView));
  return dataView;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    if (url.pathname === "/data.json") {
      const cached = await env.IMGUR_KV.get(DATA_KEY);
      if (!cached) {
        return new Response(
          JSON.stringify({ error: "no data yet — wait for cron or hit /trigger" }),
          { status: 503, headers: { "content-type": "application/json", ...cors } }
        );
      }
      return new Response(cached, {
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=30",
          ...cors,
        },
      });
    }

    if (url.pathname === "/state.json") {
      const raw = await env.IMGUR_KV.get(STATE_KEY);
      if (!raw) {
        return new Response(JSON.stringify({ error: "no state yet" }), {
          status: 503,
          headers: { "content-type": "application/json", ...cors },
        });
      }
      return new Response(raw, {
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=30",
          ...cors,
        },
      });
    }

    if (url.pathname === "/trigger") {
      const data = await tick(env);
      return new Response(
        JSON.stringify({
          ok: true,
          generated_at: data.generated_at,
          threads: data.threads.map((t) => ({
            id: t.id,
            entries: t.entries.length,
            loaded: t.total_comments_loaded,
            reported: t.total_comments_reported,
            backfill_pending: t.backfill_pending,
          })),
        }),
        { headers: { "content-type": "application/json", ...cors } }
      );
    }

    if (url.pathname === "/reset") {
      await env.IMGUR_KV.delete(STATE_KEY);
      await env.IMGUR_KV.delete(DATA_KEY);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    return new Response(
      "strongman-imgur worker — see /data.json, /state.json, /trigger, /reset",
      { headers: cors }
    );
  },

  async scheduled(_event, env, _ctx) {
    await tick(env);
  },
};
