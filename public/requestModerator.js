const $ = id => document.getElementById(id);

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
}

function toast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("visible");
  setTimeout(() => t.classList.remove("visible"), 2200);
}

function formatCharts(charts) {
  const groups = [...new Set((charts || []).map(c => c.chartType))]
    .sort((a, b) => b.localeCompare(a))
    .map(style => {
      const entries = charts
        .filter(c => c.chartType === style)
        .sort((a, b) => Number(a.meter) - Number(b.meter))
        .map(c => `${c.difficulty || "?"} ${c.meter || ""}`.trim())
        .join(", ");
      const label = style === "dance-single" ? "Single" : style === "dance-double" ? "Double" : style;
      return entries ? `${label}: ${entries}` : "";
    })
    .filter(Boolean);
  return groups.length ? groups.join(" ") : "No chart metadata";
}

function songCard(song) {
  const charts = formatCharts(song.charts);

  const article = document.createElement("article");
  article.className = "song";
  article.innerHTML = `
    <div class="song-main">
      <div class="song-meta">
        <strong>ID: ${esc(song.id)} - ${esc(song.title)}</strong>
        ${song.subtitle ? `<span class="song-subtitle">${esc(song.subtitle)}</span>` : ""}
        <small>${esc(song.artist)}${song.pack ? " • " + esc(song.pack) : ""}</small>
        <small>${esc(charts)}</small>
      </div>
      <div class="song-actions">
        <button type="button" class="song-action" onclick="window.addToQueue(${song.id})">Add to queue</button>
      </div>
    </div>
  `;
  return article;
}

let searchTimer = null;
let searchPage = 1;
let searchTotalPages = 1;

function updateSearchPager() {
  ["search-prev", "search-prev-bottom"].forEach(id => {
    const el = $(id);
    if (el) el.disabled = searchPage <= 1;
  });
  ["search-next", "search-next-bottom"].forEach(id => {
    const el = $(id);
    if (el) el.disabled = searchPage >= searchTotalPages;
  });
  ["pageInfo", "pageInfo-bottom"].forEach(id => {
    const el = $(id);
    if (el) el.textContent = `Page ${searchPage} of ${searchTotalPages}`;
  });
}

async function loadSongs(page = 1) {
  const results = $("results");
  results.replaceChildren();

  const pack = $("filter-pack") ? $("filter-pack").value : "";
  const genre = $("filter-genre") ? $("filter-genre").value : "";
  const style = $("filter-style") ? $("filter-style").value : "";
  const difficulty = $("filter-difficulty") ? $("filter-difficulty").value : "";
  const meterMin = $("filter-meter-min") ? $("filter-meter-min").value : "";
  const meterMax = $("filter-meter-max") ? $("filter-meter-max").value : "";
  const sort = $("sort-field") ? $("sort-field").value : "title";
  const order = $("sort-order") ? $("sort-order").value : "asc";
  const q = $("search") ? $("search").value.trim() : "";
  const perPage = $("per-page") ? Number($("per-page").value) || 25 : 25;

  const params = new URLSearchParams();
  params.set("page", page);
  params.set("perPage", perPage);
  if (pack) params.set("pack", pack);
  if (genre) params.set("genre", genre);
  if (style) params.set("style", style);
  if (difficulty) params.set("difficulty", difficulty);
  if (meterMin) params.set("meterMin", meterMin);
  if (meterMax) params.set("meterMax", meterMax);
  if (sort) params.set("sort", sort);
  if (order) params.set("order", order);
  if (q) params.set("q", q);

  try {
    const res = await api(`/api/songs?${params.toString()}`);
    const songs = res.songs || [];
    const total = res.total || 0;
    searchPage = res.page || page;
    searchTotalPages = Math.max(1, Math.ceil(total / (res.perPage || perPage)));

    if (!songs.length) {
      results.textContent = "No songs.";
      updateSearchPager();
      return;
    }

    songs.forEach(song => results.appendChild(songCard(song)));
    updateSearchPager();
  } catch (e) {
    results.textContent = e.message;
    updateSearchPager();
  }
}

async function render() {
  const results = await Promise.allSettled([
    api("/api/stats"),
    api("/api/now-playing"),
    api("/api/queue"),
    api("/api/moderator/settings")
  ]);
  const [statsResult, nowResult, queueResult, settingsResult] = results;

  if (statsResult.status === "fulfilled") {
    const stats = statsResult.value;
    $("stats").textContent = `${stats.songs.toLocaleString()} songs • ${stats.queued} queued • ${stats.playing} playing`;
  }

  if (nowResult.status === "fulfilled") {
    const now = nowResult.value;
    const completeBtn = $("complete-now");
    if (now) {
      window._nowPlayingId = now.id;
      if (completeBtn) completeBtn.disabled = false;
    } else {
      window._nowPlayingId = null;
      if (completeBtn) completeBtn.disabled = true;
    }
    $("now").innerHTML = now ? `
      <div class="now-card">
        <div>
          <strong>${esc(now.title)}</strong>
          ${now.subtitle ? `<span class="subtitle">${esc(now.subtitle)}</span>` : ""}
          <span>${esc(now.artist)}${now.pack ? " • " + esc(now.pack) : ""}</span>
          <small>${esc(formatCharts(now.charts))}</small>
          <small>requested by ${esc(now.requested_display)}</small>
        </div>
      </div>` : "Nothing playing.";
  } else {
    $("now").textContent = nowResult.reason.message;
  }

  if (queueResult.status === "fulfilled") {
    const queue = queueResult.value;
    $("queue").innerHTML = queue.length ? queue.map((r, i) => `
      <article class="request">
        <div class="rank">${i + 1}</div>
        <div class="info">
          <strong>${esc(r.title)}</strong>
          ${r.subtitle ? `<span class="subtitle">${esc(r.subtitle)}</span>` : ""}
          <span>${esc(r.artist)}${r.pack ? " • " + esc(r.pack) : ""}</span>
          <small>${esc(formatCharts(r.charts))}</small>
          <small>Requested by ${esc(r.requested_display)}${(String(r.requested_by || "").toLowerCase() === "streamer") ? " (Control Panel)" : ""}</small>
        </div>
        <div class="row-actions">
          <button onclick="move(${r.id},'up')">↑</button>
          <button onclick="move(${r.id},'down')">↓</button>
          <button onclick="play(${r.id})">Play</button>
          <button onclick="skip(${r.id})">Skip</button>
        </div>
      </article>
    `).join("") : '<p class="muted">Queue is empty.</p>';
  } else {
    $("queue").textContent = queueResult.reason.message;
  }

  if (settingsResult.status === "fulfilled") {
    const settings = settingsResult.value;
    ["prioritizeViewerRequests", "chatRequestsEnabled", "chatRequestsRequireFollowers", "chatRequestsRequireSubscribers", "chatRequestsRequireModerators"].forEach(key => {
      const el = $(key);
      if (el) el.checked = !!settings[key];
    });
  }
}

window.addToQueue = async songId => {
  try {
    const result = await api("/api/moderator/request", {
      method: "POST",
      body: JSON.stringify({ songId })
    });
    toast(`Added ${result.request.song.title}.`);
    render();
    loadSongs(searchPage);
  } catch (error) {
    toast(error.message);
  }
};

window.play = async id => {
  try {
    await api(`/api/moderator/queue/${id}/play`, { method: "POST" });
    toast("Playing request.");
    render();
  } catch (error) {
    toast(error.message);
  }
};

window.skip = async id => {
  try {
    await api(`/api/moderator/queue/${id}/skip`, { method: "POST" });
    toast("Skipped.");
    render();
  } catch (error) {
    toast(error.message);
  }
};

window.move = async (id, direction) => {
  try {
    await api(`/api/moderator/queue/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ direction })
    });
    render();
  } catch (error) {
    toast(error.message);
  }
};

window.complete = async id => {
  try {
    await api(`/api/moderator/queue/${id}/complete`, { method: "POST" });
    toast("Marked complete.");
    render();
  } catch (error) {
    toast(error.message);
  }
};

$("next").onclick = async () => {
  try {
    await api("/api/moderator/queue/next", { method: "POST" });
    render();
  } catch (error) {
    toast(error.message);
  }
};

$("complete-now").onclick = () => {
  if (window._nowPlayingId != null) window.complete(window._nowPlayingId);
};

$("clear").onclick = async () => {
  if (confirm("Skip every queued request?")) {
    await api("/api/moderator/queue/clear", { method: "POST" });
    render();
  }
};

$("refresh").onclick = render;

["search-prev", "search-prev-bottom"].forEach(id => {
  const el = $(id);
  if (el) el.onclick = () => { if (searchPage > 1) loadSongs(searchPage - 1); };
});

["search-next", "search-next-bottom"].forEach(id => {
  const el = $(id);
  if (el) el.onclick = () => { if (searchPage < searchTotalPages) loadSongs(searchPage + 1); };
});

$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadSongs(1), 180);
};

$("reset-search").onclick = () => {
  $("search").value = "";
  ["filter-pack", "filter-genre", "filter-style", "filter-difficulty", "filter-meter-min", "filter-meter-max", "sort-field", "sort-order"].forEach(id => {
    const el = $(id);
    if (el) el.selectedIndex = 0;
  });
  loadSongs(1);
};

["filter-pack", "filter-genre", "filter-style", "filter-difficulty", "filter-meter-min", "filter-meter-max", "sort-field", "sort-order", "per-page"].forEach(id => {
  const el = $(id);
  if (el) el.onchange = () => loadSongs(1);
});

["prioritizeViewerRequests", "chatRequestsEnabled", "chatRequestsRequireFollowers", "chatRequestsRequireSubscribers", "chatRequestsRequireModerators"].forEach(key => {
  const el = $(key);
  if (el) {
    el.onchange = async () => {
      try {
        await api("/api/moderator/settings", {
          method: "POST",
          body: JSON.stringify({ [key]: el.checked })
        });
        toast("Settings saved");
      } catch (error) {
        toast(error.message);
      }
    };
  }
});

async function getFilters() {
  try {
    const filters = await api("/api/song-filters");
    const packSel = $("filter-pack");
    const genreSel = $("filter-genre");
    const diffSel = $("filter-difficulty");
    const meterMinSel = $("filter-meter-min");
    const meterMaxSel = $("filter-meter-max");

    packSel.querySelectorAll('option:not([value=""])').forEach(option => option.remove());
    genreSel.querySelectorAll('option:not([value=""])').forEach(option => option.remove());
    diffSel.querySelectorAll('option:not([value=""])').forEach(option => option.remove());
    meterMinSel.querySelectorAll('option:not([value=""])').forEach(option => option.remove());
    meterMaxSel.querySelectorAll('option:not([value=""])').forEach(option => option.remove());

    const sortAlpha = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base" });

    [...(filters.packs || [])].sort((a, b) => sortAlpha(a.pack, b.pack)).forEach(p => {
      const option = document.createElement("option");
      option.value = p.pack;
      option.textContent = `${p.pack} (${p.count})`;
      packSel.appendChild(option);
    });

    [...(filters.genres || [])].sort((a, b) => sortAlpha(a.genre, b.genre)).forEach(g => {
      const option = document.createElement("option");
      option.value = g.genre;
      option.textContent = `${g.genre} (${g.count})`;
      genreSel.appendChild(option);
    });

    [...(filters.difficulties || [])].sort((a, b) => sortAlpha(a.difficulty, b.difficulty)).forEach(d => {
      const option = document.createElement("option");
      option.value = d.difficulty;
      option.textContent = `${d.difficulty} (${d.count})`;
      diffSel.appendChild(option);
    });

    const meters = (filters.meters || []).map(m => ({ meter: Number(m.meter), count: m.count }))
      .filter(m => !Number.isNaN(m.meter))
      .sort((a, b) => a.meter - b.meter);

    meters.forEach(m => {
      const optMin = document.createElement("option");
      optMin.value = String(m.meter);
      optMin.textContent = String(m.meter);
      meterMinSel.appendChild(optMin);

      const optMax = document.createElement("option");
      optMax.value = String(m.meter);
      optMax.textContent = String(m.meter);
      meterMaxSel.appendChild(optMax);
    });
  } catch (e) {
    console.error("Failed to load filters", e);
  }
}

getFilters().then(() => { loadSongs(); render(); }).catch(error => toast(error.message));
setInterval(render, 5000);

