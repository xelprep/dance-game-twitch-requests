const $ = (id) => document.getElementById(id);

async function getJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function songCard(song) {
  const charts = song.charts.length
    ? song.charts.map(c => `${c.difficulty || "?"} ${c.meter || ""}`).join(" • ")
    : "No chart metadata";

  const div = document.createElement("article");
  div.className = "song";
  div.innerHTML = `
    <div>
      <strong>${escapeHTML(song.title)}</strong>
      ${song.subtitle ? `<span>${escapeHTML(song.subtitle)}</span>` : ""}
      <small>${escapeHTML(song.artist)} ${song.pack ? "• " + escapeHTML(song.pack) : ""}</small>
      <small>${escapeHTML(charts)}</small>
    </div>
  `;
  return div;
}

async function search() {
  const q = $("search").value.trim();
  const results = $("results");
  results.replaceChildren();

  if (!q) return;

  try {
    const songs = await getJSON(`/api/search?q=${encodeURIComponent(q)}&limit=25`);
    if (!songs.length) {
      results.textContent = "No matches.";
      return;
    }
    songs.forEach(song => results.appendChild(songCard(song)));
  } catch (e) {
    results.textContent = e.message;
  }
}

async function queue() {
  const list = $("queue");
  list.replaceChildren();

  try {
    const items = await getJSON("/api/queue");
    if (!items.length) {
      const li = document.createElement("li");
      li.textContent = "Queue is empty.";
      list.appendChild(li);
      return;
    }

    items.forEach((item, i) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <strong>${i + 1}. ${escapeHTML(item.title)}</strong>
          <span>${escapeHTML(item.artist)}</span>
        </div>
        <small>requested by ${escapeHTML(item.requested_display)}</small>
      `;
      list.appendChild(li);
    });
  } catch (e) {
    const li = document.createElement("li");
    li.textContent = e.message;
    list.appendChild(li);
  }
}

async function stats() {
  try {
    const s = await getJSON("/api/stats");
    $("stats").textContent = `${s.songs.toLocaleString()} songs • ${s.charts.toLocaleString()} charts • ${s.queued} queued`;
  } catch {}
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

let timer;
$("search").addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(search, 180);
});

$("refresh").addEventListener("click", queue);

stats();
queue();
setInterval(() => {
  queue();
  stats();
}, 5000);
