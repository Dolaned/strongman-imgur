const fmtDate = (utc) => new Date(utc * 1000).toLocaleString();

function linkify(body, imgurLinks) {
  const set = new Set(imgurLinks);
  const escaped = body.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  return escaped.replace(/https?:\/\/[^\s)]+/g, (url) => {
    const clean = url.replace(/[).,]+$/, "");
    if (set.has(clean)) return `<a href="${clean}" target="_blank" rel="noopener">${clean}</a>`;
    return url;
  });
}

function renderEntry(e) {
  const div = document.createElement("div");
  div.className = "entry";
  div.innerHTML = `
    <div class="meta">
      <strong>${e.author}</strong> · ${fmtDate(e.created_utc)} ·
      <a href="${e.permalink}" target="_blank" rel="noopener">on reddit</a>
    </div>
    <div class="body">${linkify(e.body, e.links)}</div>
  `;
  return div;
}

async function main() {
  const res = await fetch("./data.json", { cache: "no-cache" });
  if (!res.ok) {
    document.getElementById("threads").innerHTML =
      `<p class="empty">No data yet — run the build script.</p>`;
    return;
  }
  const data = await res.json();
  document.getElementById("generated").textContent =
    `Last updated: ${new Date(data.generated_at).toLocaleString()}`;

  const root = document.getElementById("threads");
  for (const t of data.threads) {
    const section = document.createElement("section");
    const h2 = document.createElement("h2");
    h2.innerHTML = `<a href="${t.url}" target="_blank" rel="noopener">${t.title}</a>`;
    section.appendChild(h2);
    if (!t.entries.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No imgur links found in comments.";
      section.appendChild(p);
    } else {
      for (const e of t.entries) section.appendChild(renderEntry(e));
    }
    root.appendChild(section);
  }
}

main();
