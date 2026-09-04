const $ = (id) => document.getElementById(id);

// One-click auth: a whisper link carries a signed token (?token=…). Cache it so
// every subsequent /api/moderator call is authorized without a password dialog,
// which is essential on phones where Basic auth prompts are unreliable.
const TOKEN_KEY = "moderatorToken";
function readUrlToken() {
  const t = new URLSearchParams(window.location.search).get("token");
  return t && t.length > 0 ? t : null;
}
function getModeratorToken() {
  let t = readUrlToken();
  if (t) {
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch (_e) {}
    return t;
  }
  try {
    const cached = localStorage.getItem(TOKEN_KEY);
    return cached && cached.length > 0 ? cached : null;
  } catch (_e) {
    return null;
  }
}
function clearModeratorToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (_e) {}
}
// Capture the token from the URL once on load (also leaves it in the bar so it
// survives reloads during the short session).
getModeratorToken();

async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  // Authorize moderator calls with the cached one-click token when present.
  if (typeof url === "string" && url.indexOf("/api/moderator/") === 0) {
    const token = getModeratorToken();
    if (token) headers["Authorization"] = "Bearer " + token;
  }
  const res = await fetch(url, {
    headers,
    ...options,
  });
  // If the token was rejected/expired, drop it so a subsequent action falls back
  // to the username/password (Basic auth) prompt.
  if (res.status === 401 && typeof url === "string" && url.indexOf("/api/moderator/") === 0) {
    clearModeratorToken();
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");

  return data;
}
function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c],
  );
}

function toast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("visible");
  setTimeout(() => t.classList.remove("visible"), 2200);
}

function formatCharts(charts) {
  const groups = [...new Set((charts || []).map((c) => c.chartType))]
    .sort((a, b) => b.localeCompare(a))
    .map((style) => {
      const entries = charts
        .filter((c) => c.chartType === style)
        .sort((a, b) => Number(a.meter) - Number(b.meter))
        .map((c) => `${c.difficulty || "?"} ${c.meter || ""}`.trim())
        .join(", ");
      const label =
        style === "dance-single" ? "Single" : style === "dance-double" ? "Double" : style;
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
let searchRequestSeq = 0;

function updateSearchPager() {
  ["search-prev", "search-prev-bottom"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = searchPage <= 1;
  });
  ["search-next", "search-next-bottom"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = searchPage >= searchTotalPages;
  });
  ["pageInfo", "pageInfo-bottom"].forEach((id) => {
    const el = $(id);
    if (el) el.textContent = `of ${searchTotalPages}`;
  });
  ["page-input", "page-input-bottom"].forEach((id) => {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = String(searchPage);
  });
}

function commitPageInput(source) {
  const target = parseInt(source.value, 10);
  if (Number.isNaN(target) || target < 1) {
    source.value = String(searchPage);
    return;
  }
  const page = Math.min(target, searchTotalPages);
  source.value = String(page);
  if (page !== searchPage) loadSongs(page);
}

async function loadSongs(page = 1) {
  const seq = ++searchRequestSeq;
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
    if (seq !== searchRequestSeq) return;
    const songs = res.songs || [];
    const total = res.total || 0;
    searchPage = res.page || page;
    searchTotalPages = Math.max(1, Math.ceil(total / (res.perPage || perPage)));

    if (!songs.length) {
      results.textContent = "No songs.";
      updateSearchPager();
      return;
    }

    songs.forEach((song) => results.appendChild(songCard(song)));
    updateSearchPager();
  } catch (e) {
    if (seq !== searchRequestSeq) return;
    results.textContent = e.message;
    updateSearchPager();
  }
}

async function render() {
  const results = await Promise.allSettled([
    api("/api/stats"),
    api("/api/now-playing"),
    api("/api/queue"),
    api("/api/moderator/settings"),
  ]);
  const [statsResult, nowResult, queueResult, settingsResult] = results;

  if (statsResult.status === "fulfilled") {
    const stats = statsResult.value;
    $("stats").textContent = `${stats.songs.toLocaleString()} songs • ${stats.queued} queued`;
  }

  if (nowResult.status === "fulfilled") {
    const now = nowResult.value;
    if (now) {
      window._nowPlayingId = now.id;
    } else {
      window._nowPlayingId = null;
    }
    $("now").innerHTML = now
      ? `
      <div class="now-card">
        <div>
          <strong>${esc(now.title)}</strong>
          ${now.subtitle ? `<span class="subtitle">${esc(now.subtitle)}</span>` : ""}
          <span>${esc(now.artist)}${now.pack ? " • " + esc(now.pack) : ""}</span>
          <small>${esc(formatCharts(now.charts))}</small>
          <small>requested by ${esc(now.requested_display)}</small>
        </div>
        <button id="complete-now" type="button" ${now ? "" : "hidden disabled"}>Complete</button>
      </div>`
      : "Nothing playing.";

    const completeBtn = $("complete-now");
    if (completeBtn) {
      completeBtn.disabled = !now;
      completeBtn.hidden = !now;
      completeBtn.onclick = () => {
        if (window._nowPlayingId != null) window.complete(window._nowPlayingId);
      };
    }
  } else {
    $("now").textContent = nowResult.reason.message;
  }

  if (queueResult.status === "fulfilled") {
    const queue = queueResult.value;
    $("queue").innerHTML = queue.length
      ? queue
          .map(
            (r, i) => `
      <article class="request">
        <div class="rank">${i + 1}</div>
        <div class="info">
          <strong>${esc(r.title)}</strong>
          ${r.subtitle ? `<span class="subtitle">${esc(r.subtitle)}</span>` : ""}
          <span>${esc(r.artist)}${r.pack ? " • " + esc(r.pack) : ""}</span>
          <small>${esc(formatCharts(r.charts))}</small>
          <small>Requested by ${esc(r.requested_display)}${String(r.requested_by || "").toLowerCase() === "streamer" ? " (Control Panel)" : ""}</small>
        </div>
        <div class="row-actions">
          <button onclick="move(${r.id},'up')">↑</button>
          <button onclick="move(${r.id},'down')">↓</button>
          <button onclick="play(${r.id})">Play</button>
          <button onclick="skip(${r.id})">Skip</button>
        </div>
      </article>
    `,
          )
          .join("")
      : '<p class="muted">Queue is empty.</p>';
  } else {
    $("queue").textContent = queueResult.reason.message;
  }

  if (settingsResult.status === "fulfilled") {
    const settings = settingsResult.value;
    ["prioritizeViewerRequests", "chatRequestsEnabled"].forEach((key) => {
      const el = $(key);
      if (el) el.checked = !!settings[key];
    });
    const roleEl = $("chatRequestsRequireRole");
    if (roleEl) roleEl.value = settings.chatRequestsRequireRole || "";
    const allowChat = !!settings.chatRequestsEnabled;
    if (roleEl) roleEl.disabled = !allowChat;
  }
}

window.addToQueue = async (songId) => {
  try {
    const result = await api("/api/moderator/request", {
      method: "POST",
      body: JSON.stringify({ songId }),
    });
    toast(`Added ${result.request.song.title}.`);
    render();
    loadSongs(searchPage);
  } catch (error) {
    toast(error.message);
  }
};

window.play = async (id) => {
  try {
    await api(`/api/moderator/queue/${id}/play`, { method: "POST" });
    toast("Playing request.");
    render();
  } catch (error) {
    toast(error.message);
  }
};

window.skip = async (id) => {
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
      body: JSON.stringify({ direction }),
    });
    render();
  } catch (error) {
    toast(error.message);
  }
};

window.complete = async (id) => {
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

$("clear").onclick = async () => {
  if (confirm("Skip every queued request?")) {
    await api("/api/moderator/queue/clear", { method: "POST" });
    render();
  }
};

$("refresh").onclick = render;

const logoutButton = $("logout");
if (logoutButton) {
  const isTempModSession = !!getModeratorToken();
  logoutButton.hidden = !isTempModSession;
  logoutButton.onclick = async () => {
    try {
      const result = await api("/api/moderator/logout", { method: "POST" });
      clearModeratorToken();
      if (result && result.logoutType === "temp") {
        toast("Logged out and temporary moderator session ended.");
      } else {
        toast("Logged out.");
      }
      setTimeout(() => {
        window.location.assign("/requestModerator.html?loggedOut=1");
      }, 150);
    } catch (error) {
      toast(error.message);
    }
  };
}

["search-prev", "search-prev-bottom"].forEach((id) => {
  const el = $(id);
  if (el)
    el.onclick = () => {
      if (searchPage > 1) loadSongs(searchPage - 1);
    };
});

["search-next", "search-next-bottom"].forEach((id) => {
  const el = $(id);
  if (el)
    el.onclick = () => {
      if (searchPage < searchTotalPages) loadSongs(searchPage + 1);
    };
});

["page-input", "page-input-bottom"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.onchange = () => commitPageInput(el);
  el.onkeydown = (e) => {
    if (e.key === "Enter") commitPageInput(el);
  };
});

$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadSongs(1), 180);
};

$("reset-search").onclick = () => {
  $("search").value = "";
  [
    "filter-pack",
    "filter-genre",
    "filter-style",
    "filter-difficulty",
    "filter-meter-min",
    "filter-meter-max",
    "sort-field",
    "sort-order",
  ].forEach((id) => {
    const el = $(id);
    if (el) el.selectedIndex = 0;
  });
  loadSongs(1);
};

[
  "filter-pack",
  "filter-genre",
  "filter-style",
  "filter-difficulty",
  "filter-meter-min",
  "filter-meter-max",
  "sort-field",
  "sort-order",
  "per-page",
].forEach((id) => {
  const el = $(id);
  if (el) el.onchange = () => loadSongs(1);
});

["prioritizeViewerRequests", "chatRequestsEnabled", "chatRequestsRequireRole"].forEach((key) => {
  const el = $(key);
  if (el) {
    el.onchange = async () => {
      try {
        const value = el.type === "checkbox" ? el.checked : el.value;
        await api("/api/moderator/settings", {
          method: "POST",
          body: JSON.stringify({ [key]: value }),
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

    packSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    genreSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    diffSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    meterMinSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    meterMaxSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());

    const sortAlpha = (a, b) =>
      String(a).localeCompare(String(b), undefined, { sensitivity: "base" });

    [...(filters.packs || [])]
      .sort((a, b) => sortAlpha(a.pack, b.pack))
      .forEach((p) => {
        const option = document.createElement("option");
        option.value = p.pack;
        option.textContent = `${p.pack} (${p.count})`;
        packSel.appendChild(option);
      });

    [...(filters.genres || [])]
      .sort((a, b) => sortAlpha(a.genre, b.genre))
      .forEach((g) => {
        const option = document.createElement("option");
        option.value = g.genre;
        option.textContent = `${g.genre} (${g.count})`;
        genreSel.appendChild(option);
      });

    [...(filters.difficulties || [])]
      .sort((a, b) => sortAlpha(a.difficulty, b.difficulty))
      .forEach((d) => {
        const option = document.createElement("option");
        option.value = d.difficulty;
        option.textContent = `${d.difficulty} (${d.count})`;
        diffSel.appendChild(option);
      });

    const meters = (filters.meters || [])
      .map((m) => ({ meter: Number(m.meter), count: m.count }))
      .filter((m) => !Number.isNaN(m.meter))
      .sort((a, b) => a.meter - b.meter);

    meters.forEach((m) => {
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

getFilters()
  .then(() => {
    loadSongs();
    render();
  })
  .catch((error) => toast(error.message));
setInterval(render, 5000);
