const $ = id => document.getElementById(id);
async function api(url, options = {}) {
  const res = await fetch(url, { headers: {"Content-Type": "application/json", ...(options.headers || {})}, ...options });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"})[c]);
const charts = list => (list || []).map(c => `${c.difficulty || "?"} ${c.meter || ""}`.trim()).join(", ");
function toast(message) { $("toast").textContent = message; $("toast").classList.add("visible"); setTimeout(() => $("toast").classList.remove("visible"), 2200); }
let page = 1, totalPages = 1, searchTimer;
async function loadSongs(nextPage = 1) {
  const params = new URLSearchParams({ page: nextPage, perPage: $("per-page").value });
  ["pack", "genre", "style", "difficulty"].forEach(key => { const value = $(`filter-${key}`).value; if (value) params.set(key, value); });
  const meterMin = $("filter-meter-min").value;
  if (meterMin) params.set("meterMin", meterMin);
  params.set("sort", $("sort-field").value);
  params.set("order", $("sort-order").value);
  if ($("search").value.trim()) params.set("q", $("search").value.trim());
  try {
    const result = await api(`/api/songs?${params}`);
    page = result.page; totalPages = Math.max(1, Math.ceil(result.total / result.perPage));
    $("results").innerHTML = result.songs.length ? result.songs.map(song => `<article class="song"><div class="song-main"><div class="song-meta"><strong>${esc(song.title)}</strong><small>ID ${esc(song.id)} • ${esc(song.artist)}${song.pack ? ` • ${esc(song.pack)}` : ""}</small><small>${esc(charts(song.charts))}</small></div><button onclick="addToQueue(${song.id})">Add to queue</button></div></article>`).join("") : "No songs.";
    $("pageInfo").textContent = `Page ${page} of ${totalPages}`; $("prev").disabled = page <= 1; $("next-page").disabled = page >= totalPages;
  } catch (error) { $("results").textContent = error.message; }
}
async function render() {
  try {
    const [stats, now, queue, settings] = await Promise.all([api("/api/stats"), api("/api/now-playing"), api("/api/queue"), api("/api/moderator/settings")]);
    $("stats").textContent = `${stats.songs.toLocaleString()} songs • ${stats.queued} queued • ${stats.playing} playing`;
    $("now").innerHTML = now ? `<div class="now-card"><div><strong>${esc(now.title)}</strong><span>${esc(now.artist)}</span><small>requested by ${esc(now.requested_display)}</small></div></div>` : "Nothing playing.";
    $("queue").innerHTML = queue.length ? queue.map((item, index) => `<article class="request"><div class="rank">${index + 1}</div><div class="info"><strong>${esc(item.title)}</strong><span>${esc(item.artist)}</span><small>Requested by ${esc(item.requested_display)}</small></div><div class="row-actions"><button onclick="move(${item.id},'up')">↑</button><button onclick="move(${item.id},'down')">↓</button><button onclick="play(${item.id})">Play</button><button onclick="skip(${item.id})">Skip</button></div></article>`).join("") : '<p class="muted">Queue is empty.</p>';
    ["prioritizeViewerRequests","chatRequestsEnabled","chatRequestsRequireFollowers","chatRequestsRequireSubscribers","chatRequestsRequireModerators"].forEach(key => $(key).checked = !!settings[key]);
  } catch (error) { toast(error.message); }
}
window.addToQueue = async songId => { try { const result = await api("/api/moderator/request", { method:"POST", body: JSON.stringify({ songId }) }); toast(`Added ${result.request.song.title}.`); render(); } catch (error) { toast(error.message); } };
window.play = async id => { try { await api(`/api/moderator/queue/${id}/play`, {method:"POST"}); render(); } catch (error) { toast(error.message); } };
window.skip = async id => { try { await api(`/api/moderator/queue/${id}/skip`, {method:"POST"}); render(); } catch (error) { toast(error.message); } };
window.move = async (id, direction) => { try { await api(`/api/moderator/queue/${id}/move`, {method:"POST", body:JSON.stringify({direction})}); render(); } catch (error) { toast(error.message); } };
$("next").onclick = async () => { try { await api("/api/moderator/queue/next", {method:"POST"}); render(); } catch (error) { toast(error.message); } };
$("clear").onclick = async () => { if (confirm("Skip every queued request?")) { await api("/api/moderator/queue/clear", {method:"POST"}); render(); } };
$("refresh").onclick = render; $("prev").onclick = () => loadSongs(page - 1); $("next-page").onclick = () => loadSongs(page + 1);
$("search").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadSongs(1), 180); };
$("reset-search").onclick = () => { $("search").value = ""; loadSongs(1); };
["pack","genre","style","difficulty","meter-min","sort-field","sort-order","per-page"].forEach(key => $(key === "sort-field" || key === "sort-order" ? key : `filter-${key}`).onchange = () => loadSongs(1));
["prioritizeViewerRequests","chatRequestsEnabled","chatRequestsRequireFollowers","chatRequestsRequireSubscribers","chatRequestsRequireModerators"].forEach(key => $(key).onchange = async () => { try { await api("/api/moderator/settings", {method:"POST", body:JSON.stringify({[key]: $(key).checked})}); } catch (error) { toast(error.message); } });
async function getFilters() {
  const filters = await api("/api/song-filters");
  [["pack","pack"],["genre","genre"],["difficulty","difficulty"]].forEach(([id, field]) => (filters[`${field}s`] || []).forEach(item => {
    const option = document.createElement("option"); option.value = item[field]; option.textContent = `${item[field]} (${item.count})`; $(`filter-${id}`).appendChild(option);
  }));
  (filters.meters || []).forEach(item => {
    const option = document.createElement("option"); option.value = item.meter; option.textContent = item.meter; $("filter-meter-min").appendChild(option);
  });
}
getFilters().then(() => { loadSongs(); render(); }).catch(error => toast(error.message));
