const WORKER_URL = "https://strongman-imgur.akotzias-dev.workers.dev/data.json";
const POLL_MS = 60_000;

const fmtDate = (utc) => new Date(utc * 1000).toLocaleString();
const escapeHTML = (s) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const escapeAttr = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function linkify(body) {
  // Single pass: match markdown [text](url) OR a bare URL, walk the body
  // emitting escaped text between matches and an <a> tag for each match.
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|https?:\/\/[^\s\])]+/g;
  const out = [];
  let i = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.push(escapeHTML(body.slice(i, m.index)));
    let text, url;
    if (m[1] !== undefined) {
      text = m[1];
      url = m[2].replace(/[).,]+$/, "");
    } else {
      url = m[0].replace(/[).,]+$/, "");
      text = url;
    }
    out.push(
      `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHTML(text)}</a>`
    );
    i = m.index + m[0].length;
  }
  out.push(escapeHTML(body.slice(i)));
  return out.join("");
}

function renderEntry(e) {
  const div = document.createElement("div");
  div.className = "entry";
  div.innerHTML = `
    <div class="meta">
      <strong>${escapeHTML(e.author)}</strong> · ${fmtDate(e.created_utc)} ·
      <a href="${e.permalink}" target="_blank" rel="noopener">on reddit</a>
    </div>
    <div class="body">${linkify(e.body)}</div>
  `;
  return div;
}

async function refresh() {
  const root = document.getElementById("threads");
  const generated = document.getElementById("generated");
  const res = await fetch(WORKER_URL, { cache: "no-cache" });
  if (!res.ok) {
    if (res.status === 503) {
      generated.textContent = "Worker is warming up — retrying in 60s.";
    } else {
      generated.textContent = `Worker error: ${res.status} ${res.statusText}`;
    }
    return;
  }
  const data = await res.json();
  generated.textContent =
    `Last server update: ${new Date(data.generated_at).toLocaleString()} · ` +
    `client refreshes every 60s.`;

  root.innerHTML = "";
  for (const t of data.threads) {
    const section = document.createElement("section");
    const h2 = document.createElement("h2");
    h2.innerHTML = `<a href="${t.url}" target="_blank" rel="noopener">${escapeHTML(t.title)}</a>`;
    section.appendChild(h2);
    const summary = document.createElement("p");
    summary.className = "empty";
    const reported = t.total_comments_reported ?? "?";
    const backlog = t.backfill_pending
      ? ` · ${t.backfill_pending} backfill batches still queued`
      : "";
    summary.textContent = `${t.entries.length} imgur posts · ${t.total_comments_loaded} / ${reported} comments scanned${backlog}.`;
    section.appendChild(summary);
    for (const e of t.entries) section.appendChild(renderEntry(e));
    root.appendChild(section);
  }
}

async function main() {
  await refresh();
  setInterval(refresh, POLL_MS);
}

main();
