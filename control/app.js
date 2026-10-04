const $ = (id) => document.getElementById(id);

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
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

let _toastTimer = null;
function toast(msg, type) {
  clearTimeout(_toastTimer);
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("show", "toast-error");
  if (type === "error") el.classList.add("toast-error");
  // Force a reflow so the transition restarts even if already visible.
  void el.offsetWidth;
  el.classList.add("show");
  _toastTimer = setTimeout(
    () => el.classList.remove("show", "toast-error"),
    type === "error" ? 5000 : 2200,
  );
}

function getSongSearchPerPage() {
  return Number($("per-page").value) || 25;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function styleLabel(chartType) {
  return chartType === "dance-double" ? "Double" : "Single";
}

function chartText(chart) {
  return `${styleLabel(chart.chartType)} ${chart.difficulty || "?"} ${chart.meter || ""}`.trim();
}

function songCard(song) {
  const activeCharts = new Set(song.activeCharts || []);
  const bpmLabel =
    song.bpmMin != null && song.bpmMax != null
      ? song.bpmMin === song.bpmMax
        ? `BPM: ${song.bpmMin}`
        : `BPM: ${song.bpmMin}\u2013${song.bpmMax}`
      : "";
  const durationLabel = song.durationSeconds != null ? formatDuration(song.durationSeconds) : "";
  const coreBpmLabel = song.coreBpm != null ? `Core BPM: ${song.coreBpm}` : "";
  const statsLabel = [bpmLabel, coreBpmLabel, durationLabel].filter(Boolean).join(" \u2022 ");

  const charts = [...(song.charts || [])].sort((a, b) =>
    a.chartType === b.chartType
      ? Number(a.meter) - Number(b.meter)
      : a.chartType.localeCompare(b.chartType),
  );
  const chartRows = charts.length
    ? charts
        .map((chart) => {
          const isActive = activeCharts.has(chart.id);
          const isRestricted = !isActive && !!chart.disallowed;
          const disabledTitle = isActive
            ? "Already queued or playing"
            : chart.disallowReason || "Not allowed right now";
          return `
        <div class="song-chart-row${isActive || isRestricted ? " dimmed" : ""}">
          <span class="song-chart-label">${esc(chartText(chart))}</span>
          <button type="button" class="song-action song-chart-add" ${
            isActive || isRestricted
              ? `disabled title="${esc(disabledTitle)}"`
              : `onclick="window.addToQueue(${song.id}, ${chart.id})"`
          }>${isActive ? "Queued" : isRestricted ? "Restricted" : "Add"}</button>
        </div>`;
        })
        .join("")
    : `<small>No chart metadata</small>`;

  const article = document.createElement("article");
  article.className = "song";
  article.innerHTML = `
    <div class="song-main">
      ${song.artworkUrl ? `<img class="song-artwork" src="${esc(song.artworkUrl)}" alt="${esc(song.title)} artwork" loading="lazy" decoding="async" />` : ""}
      <div class="song-meta">
        <strong>ID: ${esc(song.id)} - ${esc(song.title)}</strong>
        ${song.subtitle ? `<span class="song-subtitle">${esc(song.subtitle)}</span>` : ""}
        <small>${esc(song.artist)}${song.pack ? " • " + esc(song.pack) : ""}</small>
        ${statsLabel ? `<small>${esc(statsLabel)}</small>` : ""}
      </div>
      <div class="song-charts">${chartRows}</div>
    </div>
  `;
  return article;
}

async function getFilters() {
  try {
    const f = await api("/api/song-filters");
    const packSel = $("filter-pack");
    const genreSel = $("filter-genre");
    const diffSel = $("filter-difficulty");
    const meterMinSel = $("filter-meter-min");
    const meterMaxSel = $("filter-meter-max");
    const bpmMinSel = $("filter-bpm-min");
    const bpmMaxSel = $("filter-bpm-max");
    const durationMinSel = $("filter-duration-min");
    const durationMaxSel = $("filter-duration-max");
    const constraintPackSel = $("requestConstraintPack");
    const constraintMeterMinSel = $("requestConstraintMeterMin");
    const constraintMeterMaxSel = $("requestConstraintMeterMax");
    const constraintBpmMinSel = $("requestConstraintBpmMin");
    const constraintBpmMaxSel = $("requestConstraintBpmMax");
    const constraintDurationMinSel = $("requestConstraintDurationMin");
    const constraintDurationMaxSel = $("requestConstraintDurationMax");

    packSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    genreSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    diffSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    meterMinSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    meterMaxSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    bpmMinSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    bpmMaxSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    durationMinSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    durationMaxSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    constraintPackSel
      .querySelectorAll('option:not([value=""])')
      .forEach((option) => option.remove());
    constraintMeterMinSel
      .querySelectorAll('option:not([value=""])')
      .forEach((option) => option.remove());
    constraintMeterMaxSel
      .querySelectorAll('option:not([value=""])')
      .forEach((option) => option.remove());
    constraintBpmMinSel
      .querySelectorAll('option:not([value=""])')
      .forEach((option) => option.remove());
    constraintBpmMaxSel
      .querySelectorAll('option:not([value=""])')
      .forEach((option) => option.remove());
    constraintDurationMinSel
      .querySelectorAll('option:not([value=""])')
      .forEach((option) => option.remove());
    constraintDurationMaxSel
      .querySelectorAll('option:not([value=""])')
      .forEach((option) => option.remove());

    const sortAlpha = (a, b) =>
      String(a).localeCompare(String(b), undefined, { sensitivity: "base" });

    [...(f.packs || [])]
      .sort((a, b) => sortAlpha(a.pack, b.pack))
      .forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.pack;
        opt.textContent = `${p.pack} (${p.count})`;
        packSel.appendChild(opt);

        const constraintOpt = document.createElement("option");
        constraintOpt.value = p.pack;
        constraintOpt.textContent = p.pack;
        constraintPackSel.appendChild(constraintOpt);
      });

    [...(f.genres || [])]
      .sort((a, b) => sortAlpha(a.genre, b.genre))
      .forEach((g) => {
        const opt = document.createElement("option");
        opt.value = g.genre;
        opt.textContent = `${g.genre} (${g.count})`;
        genreSel.appendChild(opt);
      });

    [...(f.difficulties || [])]
      .sort((a, b) => sortAlpha(a.difficulty, b.difficulty))
      .forEach((d) => {
        const opt = document.createElement("option");
        opt.value = d.difficulty;
        opt.textContent = `${d.difficulty} (${d.count})`;
        diffSel.appendChild(opt);
      });

    const meters = (f.meters || [])
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

      const cMin = document.createElement("option");
      cMin.value = String(m.meter);
      cMin.textContent = String(m.meter);
      constraintMeterMinSel.appendChild(cMin);

      const cMax = document.createElement("option");
      cMax.value = String(m.meter);
      cMax.textContent = String(m.meter);
      constraintMeterMaxSel.appendChild(cMax);
    });

    const bpms = [...(f.bpms || [])].sort((a, b) => (a.bpm ?? a.bpm_min) - (b.bpm ?? b.bpm_min));
    bpms.forEach((b) => {
      const val = b.bpm ?? b.bpm_min;
      const label = `${val} BPM`;
      const optMin = document.createElement("option");
      optMin.value = String(val);
      optMin.textContent = `${label} (${b.count})`;
      bpmMinSel.appendChild(optMin);

      const optMax = document.createElement("option");
      optMax.value = String(val);
      optMax.textContent = `${label} (${b.count})`;
      bpmMaxSel.appendChild(optMax);

      const cMin = document.createElement("option");
      cMin.value = String(val);
      cMin.textContent = label;
      constraintBpmMinSel.appendChild(cMin);

      const cMax = document.createElement("option");
      cMax.value = String(val);
      cMax.textContent = label;
      constraintBpmMaxSel.appendChild(cMax);
    });

    const durations = [...(f.durations || [])].sort((a, b) => a.seconds - b.seconds);
    durations.forEach((d) => {
      const label = formatDuration(d.seconds);
      const optMin = document.createElement("option");
      optMin.value = String(d.seconds);
      optMin.textContent = `${label} (${d.count})`;
      durationMinSel.appendChild(optMin);

      const optMax = document.createElement("option");
      optMax.value = String(d.seconds);
      optMax.textContent = `${label} (${d.count})`;
      durationMaxSel.appendChild(optMax);

      const cMin = document.createElement("option");
      cMin.value = String(d.seconds);
      cMin.textContent = label;
      constraintDurationMinSel.appendChild(cMin);

      const cMax = document.createElement("option");
      cMax.value = String(d.seconds);
      cMax.textContent = label;
      constraintDurationMaxSel.appendChild(cMax);
    });
  } catch (e) {
    console.error("Failed to load filters", e);
  }
}

// Set a constraint select's value, adding the option first if it's missing (e.g. the
// constrained pack no longer exists in the library).
function applyConstraintSelect(id, value) {
  const el = $(id);
  if (!el) return;
  value = String(value ?? "");
  if (value && ![...el.options].some((option) => option.value === value)) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    el.appendChild(opt);
  }
  el.value = value;
}

function renderRequestConstraints(settings) {
  if (!settings) return;
  applyConstraintSelect("requestConstraintStyle", settings.requestConstraintStyle || "any");
  applyConstraintSelect("requestConstraintPack", settings.requestConstraintPack || "");
  applyConstraintSelect(
    "requestConstraintMeterMin",
    settings.requestConstraintMeterMin != null ? String(settings.requestConstraintMeterMin) : "",
  );
  applyConstraintSelect(
    "requestConstraintMeterMax",
    settings.requestConstraintMeterMax != null ? String(settings.requestConstraintMeterMax) : "",
  );
  applyConstraintSelect(
    "requestConstraintBpmMin",
    settings.requestConstraintBpmMin != null ? String(settings.requestConstraintBpmMin) : "",
  );
  applyConstraintSelect(
    "requestConstraintBpmMax",
    settings.requestConstraintBpmMax != null ? String(settings.requestConstraintBpmMax) : "",
  );
  applyConstraintSelect(
    "requestConstraintDurationMin",
    settings.requestConstraintDurationMin != null
      ? String(settings.requestConstraintDurationMin)
      : "",
  );
  applyConstraintSelect(
    "requestConstraintDurationMax",
    settings.requestConstraintDurationMax != null
      ? String(settings.requestConstraintDurationMax)
      : "",
  );
}

let searchTimer = null;
let searchPage = 1;
let searchTotalPages = 1;
let searchRequestSeq = 0;
let activeSongsKey = "";
let moderatorDraftRows = [];

function updateSearchPager() {
  ["search-prev", "search-prev-bottom"].forEach((id) => {
    $(id).disabled = searchPage <= 1;
  });
  ["search-next", "search-next-bottom"].forEach((id) => {
    $(id).disabled = searchPage >= searchTotalPages;
  });
  ["pageInfo", "pageInfo-bottom"].forEach((id) => {
    $(id).textContent = `of ${searchTotalPages}`;
  });
  ["page-input", "page-input-bottom"].forEach((id) => {
    const input = $(id);
    if (document.activeElement !== input) input.value = String(searchPage);
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

  const pack = $("filter-pack").value;
  const genre = $("filter-genre").value;
  const style = $("filter-style").value;
  const difficulty = $("filter-difficulty").value;
  const meterMin = $("filter-meter-min").value;
  const meterMax = $("filter-meter-max").value;
  const bpmMin = $("filter-bpm-min").value;
  const bpmMax = $("filter-bpm-max").value;
  const durationMin = $("filter-duration-min").value;
  const durationMax = $("filter-duration-max").value;
  const sort = $("sort-field").value;
  const order = $("sort-order").value;
  const q = $("search").value.trim();
  const perPage = getSongSearchPerPage();

  const params = new URLSearchParams();
  params.set("page", page);
  params.set("perPage", perPage);
  if (pack) params.set("pack", pack);
  if (genre) params.set("genre", genre);
  if (style) params.set("style", style);
  if (difficulty) params.set("difficulty", difficulty);
  if (meterMin) params.set("meterMin", meterMin);
  if (meterMax) params.set("meterMax", meterMax);
  if (bpmMin) params.set("bpmMin", bpmMin);
  if (bpmMax) params.set("bpmMax", bpmMax);
  if (durationMin) params.set("durationMin", durationMin);
  if (durationMax) params.set("durationMax", durationMax);
  if (sort) params.set("sort", sort);
  if (order) params.set("order", order);
  if (q) params.set("q", q);
  // Flag songs that are already queued or now playing so their rows can be dimmed.
  params.set("markActive", "1");

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

window.addToQueue = async (songId, chartId) => {
  try {
    const result = await api("/api/request", {
      method: "POST",
      body: JSON.stringify({
        songId,
        chartId,
        username: "streamer",
        displayName: "Streamer",
      }),
    });
    const chart = result.request.chart;
    toast(
      `Added ${result.request.song.title}${chart ? ` (${chartText(chart)})` : ""} to the queue.`,
    );
    render();
    loadSongs(searchPage);
  } catch (e) {
    toast(e.message);
  }
};

async function render() {
  try {
    const [stats, now, queue, blocked, settings] = await Promise.all([
      api("/api/stats"),
      api("/api/now-playing"),
      api("/api/queue"),
      api("/api/blocked"),
      // Control settings endpoint
      (async () => {
        try {
          return await api("/api/control/settings");
        } catch (e) {
          return { prioritizeViewerRequests: true };
        }
      })(),
    ]);

    $("stats").textContent = `${stats.songs.toLocaleString()} songs • ${stats.queued} queued`;

    // Reload the song search when a chart enters or leaves the queue / now playing,
    // so the dimmed "already queued" state stays current without a manual refresh.
    {
      const ids = new Set(queue.map((r) => (r.chart ? r.chart.id : `song:${r.song_id}`)));
      if (now && now.chart) ids.add(now.chart.id);
      const key = [...ids].sort((a, b) => String(a).localeCompare(String(b))).join(",");
      if (key !== activeSongsKey) {
        activeSongsKey = key;
        loadSongs(searchPage);
      }
    }

    $("now").innerHTML = now
      ? `
      <div class="now-card">
        <div>
          <strong>${esc(now.title)}</strong>
          ${now.subtitle ? `<span class="subtitle">${esc(now.subtitle)}</span>` : ""}
          <span>${esc(now.artist)}${now.pack ? " • " + esc(now.pack) : ""}</span>
          ${now.chart ? `<small class="request-chart">${esc(chartText(now.chart))}</small>` : ""}
          <small>requested by ${esc(now.requested_display)}</small>
        </div>
        <button onclick="complete(${now.id})">Complete</button>
      </div>`
      : "Nothing playing.";

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
          ${r.chart ? `<small class="request-chart">${esc(chartText(r.chart))}</small>` : ""}
          <small>Requested by ${esc(r.requested_display)}${String(r.requested_by.toLowerCase() || "") === "streamer" ? " (Control Panel)" : ""}</small>
        </div>
        <div class="row-actions">
          <button onclick="move(${r.id},'up')">↑</button>
          <button onclick="move(${r.id},'down')">↓</button>
          <button onclick="play(${r.id})">Play</button>
          <button onclick="skip(${r.id})">Skip</button>
          <button onclick="blockSong(${r.song_id})">Block Song</button>
          <button data-control-action="block-user" data-username="${esc(r.requested_by)}">Block User</button>
        </div>
      </article>
    `,
          )
          .join("")
      : `<p class="muted">Queue is empty.</p>`;

    $("blocked").innerHTML = blocked.length
      ? blocked
          .map(
            (b) => `
      <div class="black-item">
        <span>${b.username ? "User: " + esc(b.username) : "Song #" + b.songId}</span>
        <small>${esc(b.reason)}</small>
        <button onclick="removeBlocked(${b.id})">Remove</button>
      </div>
    `,
          )
          .join("")
      : `<p class="muted">No blocked songs or users.</p>`;

    // Apply settings (if present) to UI
    try {
      const chatRequestsEnabled = $("chatRequestsEnabled");
      const chatRequestsRequireRole = $("chatRequestsRequireRole");
      if (typeof settings !== "undefined") {
        const artworkEnabled = $("artworkEnabled");
        if (artworkEnabled) artworkEnabled.checked = !!(settings && settings.artworkEnabled);
        updateArtworkControls(!!(settings && settings.artworkEnabled));
        const prioritizeElLocal = $("prioritizeViewerRequests");
        if (prioritizeElLocal)
          prioritizeElLocal.checked = !!(settings && settings.prioritizeViewerRequests);
        if (chatRequestsEnabled)
          chatRequestsEnabled.checked = !!(settings && settings.chatRequestsEnabled);
        if (chatRequestsRequireRole)
          chatRequestsRequireRole.value = (settings && settings.chatRequestsRequireRole) || "";
        const instructionsMinutesEl = $("twitchInstructionsMinutes");
        if (instructionsMinutesEl && document.activeElement !== instructionsMinutesEl) {
          instructionsMinutesEl.value =
            settings && Number.isFinite(Number(settings.instructionsMinutes))
              ? Number(settings.instructionsMinutes)
              : 10;
        }
        const moderatorEnabled = $("moderatorEnabled");
        if (moderatorEnabled) moderatorEnabled.checked = !!(settings && settings.moderatorEnabled);
        renderModeratorCredentials(settings);
        renderNetworkSettings(settings);
        renderRequestConstraints(settings);
        renderOverlaySettings(settings);
      }

      const allowChat = !!(chatRequestsEnabled && chatRequestsEnabled.checked);
      if (chatRequestsRequireRole) chatRequestsRequireRole.disabled = !allowChat;
      refreshArtworkJobStatus();
    } catch (e) {
      /* ignore */
    }
  } catch (e) {
    toast(e.message);
  }
}

function updateArtworkControls(enabled) {
  const buildButton = $("buildArtwork");
  const forceButton = $("forceArtwork");
  if (buildButton) buildButton.disabled = !enabled;
  if (forceButton) forceButton.disabled = !enabled;
}

let artworkStatusTimer = null;
async function refreshArtworkJobStatus() {
  const statusEl = $("artworkJobStatus");
  if (!statusEl) return;
  try {
    const state = await api("/api/control/artwork/status");
    if (state.running) {
      statusEl.textContent = `Processing artwork: ${state.completed}/${state.total}`;
      if (!artworkStatusTimer) {
        artworkStatusTimer = setInterval(() => refreshArtworkJobStatus(), 1000);
      }
    } else {
      clearInterval(artworkStatusTimer);
      artworkStatusTimer = null;
      if (state.error) {
        statusEl.textContent = `Artwork processing failed: ${state.error}`;
      } else if (state.result) {
        const result = state.result;
        statusEl.textContent = `Artwork: ${result.processed} processed, ${result.reused} reused, ${result.missing} missing, ${result.failed} failed`;
      } else {
        statusEl.textContent = "";
      }
    }
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

async function startArtworkProcessing(force) {
  try {
    await api("/api/control/artwork/process", {
      method: "POST",
      body: JSON.stringify({ force }),
    });
    await refreshArtworkJobStatus();
  } catch (error) {
    toast(error.message, "error");
  }
}

function describeBindHost(value) {
  if (value === "0.0.0.0") return "0.0.0.0 — all interfaces (default)";
  if (value === "127.0.0.1") return "127.0.0.1 — this computer only";
  return `${value} — this computer (LAN address)`;
}

function renderNetworkSettings(settings) {
  try {
    const bindHostEl = $("bindHost");
    if (!bindHostEl || !settings) return;
    const desiredHost =
      typeof settings.host === "string" && settings.host ? settings.host : "0.0.0.0";
    const options = ["0.0.0.0", "127.0.0.1"];
    for (const ip of Array.isArray(settings.lanIPs) ? settings.lanIPs : []) {
      if (ip && !options.includes(ip)) options.push(ip);
    }
    if (!options.includes(desiredHost)) options.push(desiredHost);
    const currentValues = Array.from(bindHostEl.options).map((o) => o.value);
    const needsRebuild =
      currentValues.length !== options.length || currentValues.some((v, i) => v !== options[i]);
    if (needsRebuild) {
      bindHostEl.textContent = "";
      for (const value of options) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = describeBindHost(value);
        bindHostEl.appendChild(opt);
      }
    }
    if (bindHostEl.value !== desiredHost) bindHostEl.value = desiredHost;

    const publicPortEl = $("publicPort");
    if (publicPortEl && document.activeElement !== publicPortEl) {
      const port = Number(settings.publicPort);
      publicPortEl.value = Number.isFinite(port) && port > 0 ? port : 3000;
    }
    const controlPortEl = $("controlPort");
    if (controlPortEl && document.activeElement !== controlPortEl) {
      const port = Number(settings.controlPort);
      controlPortEl.value = Number.isFinite(port) && port > 0 ? port : 3001;
    }
  } catch (e) {
    /* ignore */
  }
}

function getModeratorDraftRowsFromSettings(settings) {
  if (
    Array.isArray(settings && settings.moderatorCredentials) &&
    settings.moderatorCredentials.length
  ) {
    return settings.moderatorCredentials.map((entry) => ({
      username: String(entry.username || ""),
      password: "",
    }));
  }
  if (settings && settings.moderatorUsername) {
    return [{ username: String(settings.moderatorUsername || ""), password: "" }];
  }
  return [{ username: "", password: "" }];
}

function syncModeratorDraft(settings) {
  moderatorDraftRows = getModeratorDraftRowsFromSettings(settings);
  return moderatorDraftRows;
}

function normalizeModeratorRows(rows) {
  const nonEmptyRows = (rows || [])
    .filter((row) => row && (String(row.username || "").trim() || String(row.password || "")))
    .map((row) => ({
      username: String(row.username || "").trim(),
      password: String(row.password || ""),
    }));

  if (!nonEmptyRows.length) {
    return [{ username: "", password: "" }];
  }

  const withTrailingBlank = [...nonEmptyRows, { username: "", password: "" }];
  return withTrailingBlank;
}

function updateModeratorDraftFromUI() {
  const list = $("moderatorCredentialsList");
  if (!list) return;

  const rows = Array.from(list.querySelectorAll(".moderator-credential-row"));
  const nextRows = rows.map((row) => {
    const usernameInput = row.querySelector(".moderator-username-input");
    const passwordInput = row.querySelector(".moderator-password-input");
    return {
      username: usernameInput ? usernameInput.value.trim() : "",
      password: passwordInput ? passwordInput.value : "",
    };
  });

  moderatorDraftRows = normalizeModeratorRows(nextRows);
}

function createModeratorCredentialRow(entry = {}, index = 0) {
  const row = document.createElement("div");
  row.className = "moderator-credential-row";

  const usernameInput = document.createElement("input");
  usernameInput.type = "text";
  usernameInput.autocomplete = "off";
  usernameInput.placeholder = "Trusted username";
  usernameInput.value = String(entry.username || "");
  usernameInput.dataset.index = String(index);
  usernameInput.className = "moderator-username-input";
  usernameInput.addEventListener("input", () => updateModeratorDraftFromUI());
  usernameInput.addEventListener("change", () => saveModeratorCredentialDraft());

  const passwordInput = document.createElement("input");
  passwordInput.type = "password";
  passwordInput.autocomplete = "new-password";
  passwordInput.placeholder = "Password";
  passwordInput.value = String(entry.password || "");
  passwordInput.className = "moderator-password-input";
  passwordInput.addEventListener("input", () => updateModeratorDraftFromUI());
  passwordInput.addEventListener("change", () => saveModeratorCredentialDraft());

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "+";
  addBtn.title = "Add moderator";
  addBtn.className = "moderator-add-button";
  addBtn.addEventListener("click", () => {
    const list = $("moderatorCredentialsList");
    if (!list) return;
    const rows = Array.from(list.querySelectorAll(".moderator-credential-row"));
    const lastRow = rows[rows.length - 1];
    const lastUsername = lastRow
      ? lastRow.querySelector(".moderator-username-input")?.value.trim() || ""
      : "";
    const lastPassword = lastRow
      ? lastRow.querySelector(".moderator-password-input")?.value || ""
      : "";
    if (lastUsername || lastPassword) {
      list.appendChild(createModeratorCredentialRow({}, rows.length));
      updateModeratorDraftFromUI();
      saveModeratorCredentialDraft();
    } else {
      toast("Fill in the current moderator row before adding another.");
      const focused =
        lastRow?.querySelector(".moderator-username-input") ||
        lastRow?.querySelector(".moderator-password-input");
      if (focused) focused.focus();
    }
  });

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "-";
  removeBtn.title = "Remove moderator";
  removeBtn.className = "moderator-remove-button";
  removeBtn.disabled = rowCount() <= 1;
  removeBtn.addEventListener("click", () => {
    const list = $("moderatorCredentialsList");
    if (!list) return;
    const rows = Array.from(list.querySelectorAll(".moderator-credential-row"));
    if (rows.length <= 1) return;
    const target = rows[rows.findIndex((item) => item === row)];
    if (target) target.remove();
    updateModeratorDraftFromUI();
    updateModeratorRowButtons();
    saveModeratorCredentialDraft();
  });

  row.append(usernameInput, passwordInput, addBtn, removeBtn);
  return row;
}

function rowCount() {
  const list = $("moderatorCredentialsList");
  if (!list) return 1;
  return list.querySelectorAll(".moderator-credential-row").length || 1;
}

function updateModeratorRowButtons() {
  const list = $("moderatorCredentialsList");
  if (!list) return;
  const rows = Array.from(list.querySelectorAll(".moderator-credential-row"));
  rows.forEach((item) => {
    const removeBtn = item.querySelector(".moderator-remove-button");
    if (removeBtn) removeBtn.disabled = rows.length <= 1;
  });
}

function renderModeratorCredentials(settings) {
  const list = $("moderatorCredentialsList");
  if (!list) return;

  const activeInsideList = list.contains(document.activeElement);
  if (activeInsideList) {
    updateModeratorDraftFromUI();
    return;
  }

  const rows = moderatorDraftRows.length ? moderatorDraftRows : syncModeratorDraft(settings);
  const normalizedRows = normalizeModeratorRows(rows);
  list.innerHTML = "";
  normalizedRows.forEach((entry, index) =>
    list.appendChild(createModeratorCredentialRow(entry, index)),
  );
  updateModeratorRowButtons();
}

function getModeratorCredentialsFromUI() {
  const list = $("moderatorCredentialsList");
  if (!list) return [];
  const rows = Array.from(list.querySelectorAll(".moderator-credential-row"));
  const credentials = [];
  for (const row of rows) {
    const usernameInput = row.querySelector(".moderator-username-input");
    const passwordInput = row.querySelector(".moderator-password-input");
    const username = String(usernameInput ? usernameInput.value.trim() : "");
    const password = String(passwordInput ? passwordInput.value : "");
    if (!username && !password) continue;
    credentials.push({ username, password });
  }
  return credentials;
}

function saveModeratorCredentialDraft() {
  const list = $("moderatorCredentialsList");
  if (!list) return;
  const moderatorEnabled = $("moderatorEnabled");
  const nextDraft = getModeratorCredentialsFromUI();
  if (moderatorEnabled) {
    saveControlSettings({
      moderatorEnabled: moderatorEnabled.checked,
      moderatorCredentials: nextDraft,
    });
    return;
  }
  saveControlSettings({ moderatorCredentials: nextDraft });
}

async function saveControlSettings(patch) {
  try {
    const current = await api("/api/control/settings");
    const next = { ...current, ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, "moderatorCredentials")) {
      delete next.moderatorUsername;
      delete next.moderatorPasswordConfigured;
    }
    await api("/api/control/settings", { method: "POST", body: JSON.stringify(next) });
    toast("Settings saved");
    render();
  } catch (err) {
    toast(err.message);
    render();
  }
}

// Wire up settings UI: toggle to prioritize viewer requests above streamer requests
const prioritizeEl = $("prioritizeViewerRequests");
if (prioritizeEl) {
  prioritizeEl.addEventListener("change", () =>
    saveControlSettings({ prioritizeViewerRequests: prioritizeEl.checked }),
  );
}

const chatRequestsEnabledEl = $("chatRequestsEnabled");
if (chatRequestsEnabledEl) {
  chatRequestsEnabledEl.addEventListener("change", () =>
    saveControlSettings({ chatRequestsEnabled: chatRequestsEnabledEl.checked }),
  );
}

const chatRequestsRequireRoleEl = $("chatRequestsRequireRole");
if (chatRequestsRequireRoleEl) {
  chatRequestsRequireRoleEl.addEventListener("change", () =>
    saveControlSettings({ chatRequestsRequireRole: chatRequestsRequireRoleEl.value }),
  );
}

const artworkEnabledEl = $("artworkEnabled");
if (artworkEnabledEl) {
  artworkEnabledEl.addEventListener("change", () => {
    updateArtworkControls(artworkEnabledEl.checked);
    saveControlSettings({ artworkEnabled: artworkEnabledEl.checked });
  });
}

$("buildArtwork")?.addEventListener("click", () => startArtworkProcessing(false));
$("forceArtwork")?.addEventListener("click", () => startArtworkProcessing(true));

// Request constraints: each select saves itself on change (empty bound = no limit).
[
  "requestConstraintStyle",
  "requestConstraintPack",
  "requestConstraintMeterMin",
  "requestConstraintMeterMax",
  "requestConstraintBpmMin",
  "requestConstraintBpmMax",
  "requestConstraintDurationMin",
  "requestConstraintDurationMax",
].forEach((id) => {
  const el = $(id);
  if (el) {
    el.addEventListener("change", () => saveControlSettings({ [id]: el.value }));
  }
});

// --- Network settings (bind address + ports) ---

function setNetworkStatus(message, isError) {
  const el = $("networkStatus");
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("error", !!isError);
}

function clearNetworkStatus() {
  setNetworkStatus("");
}

const bindHostEl = $("bindHost");
if (bindHostEl) {
  bindHostEl.addEventListener("change", () => {
    clearNetworkStatus();
    saveControlSettings({ host: bindHostEl.value });
  });
}

const publicPortEl = $("publicPort");
const controlPortEl = $("controlPort");

function validateNetworkPort(el, label, otherEl) {
  const value = Number(el.value);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    toast(`${label} must be a whole number between 1 and 65535.`);
    render();
    return null;
  }
  if (otherEl && Number(otherEl.value) === value) {
    toast("The public and control ports must be different.");
    render();
    return null;
  }
  return value;
}

if (publicPortEl) {
  publicPortEl.addEventListener("change", () => {
    const value = validateNetworkPort(publicPortEl, "Public port", controlPortEl);
    if (value === null) return;
    clearNetworkStatus();
    saveControlSettings({ publicPort: value });
  });
}

if (controlPortEl) {
  controlPortEl.addEventListener("change", () => {
    const value = validateNetworkPort(controlPortEl, "Control port", publicPortEl);
    if (value === null) return;
    clearNetworkStatus();
    saveControlSettings({ controlPort: value });
  });
}

const restartServerEl = $("restartServer");
if (restartServerEl) {
  restartServerEl.addEventListener("click", startServerRestart);
}

function startServerRestart() {
  if (!restartServerEl || restartServerEl.disabled) return;
  // The inputs mirror the saved settings (render keeps them in sync), so the
  // redirect target is computed up front — the server may be unreachable for a
  // few seconds while it re-binds.
  const host = bindHostEl && bindHostEl.value ? bindHostEl.value : "0.0.0.0";
  const port =
    controlPortEl && Number.isFinite(Number(controlPortEl.value))
      ? Number(controlPortEl.value)
      : 3001;
  const label = host === "0.0.0.0" ? "localhost" : host;
  const target = `https://${label}:${port}`;

  restartServerEl.disabled = true;
  setNetworkStatus("Restarting servers…");

  (async () => {
    let result = null;
    try {
      // Raw fetch (not api()): the server answers before it re-binds, and if
      // the control port changed this request may die mid-response — which
      // still counts as a successful restart.
      const res = await fetch("/api/control/restart", { method: "POST" });
      let body = null;
      try {
        body = await res.json();
      } catch (e) {
        body = null;
      }
      if (res.ok && (!body || body.ok !== false)) {
        result = body || {};
      } else {
        setNetworkStatus(
          (body && body.error) || "Restart failed. Check the server logs for details.",
          true,
        );
        restartServerEl.disabled = false;
        return;
      }
    } catch (e) {
      result = {}; // socket closed by the restart — assume it is coming back.
    }

    if (result.alreadyRunning) {
      setNetworkStatus(`Servers already run on ${result.controlUrl || target}.`);
      restartServerEl.disabled = false;
      return;
    }

    const openAt = result.controlUrl || target;
    let delay = 5;
    setNetworkStatus(`Restarting… opening ${openAt} in ${delay}s`);
    const timer = setInterval(() => {
      delay -= 1;
      if (delay <= 0) {
        clearInterval(timer);
        // Only navigate to http/https URLs to guard against javascript: injection.
        try {
          const dest = new URL(openAt);
          if (dest.protocol === "http:" || dest.protocol === "https:") {
            window.location.href = dest.href;
          }
        } catch (_) {
          // openAt is not a parseable URL — do not navigate.
        }
        return;
      }
      setNetworkStatus(`Restarting… opening ${openAt} in ${delay}s`);
    }, 1000);
  })();
}

const instructionsMinutesEl = $("twitchInstructionsMinutes");
if (instructionsMinutesEl) {
  instructionsMinutesEl.addEventListener("change", () => {
    const value = Number(instructionsMinutesEl.value);
    if (!Number.isFinite(value) || value < 0) {
      toast("Instructions timeout must be 0 or greater.");
      instructionsMinutesEl.value = 10;
      return;
    }
    saveControlSettings({ instructionsMinutes: value });
  });
}

const moderatorEnabledEl = $("moderatorEnabled");
if (moderatorEnabledEl) {
  moderatorEnabledEl.addEventListener("change", async () => {
    if (moderatorEnabledEl.checked) {
      const moderatorRows = getModeratorCredentialsFromUI();
      const validRows = moderatorRows.filter(
        (row) =>
          String(row.username || "").trim() &&
          (String(row.password || "").length > 0 || row.username),
      );
      try {
        const current = await api("/api/control/settings");
        if (!validRows.length) {
          moderatorEnabledEl.checked = false;
          toast("Please enter at least one moderator username before enabling access.");
          const firstRow = $("moderatorCredentialsList")?.querySelector(
            ".moderator-username-input",
          );
          if (firstRow) firstRow.focus();
          return;
        }
        const hasAnyPasswordInput = moderatorRows.some(
          (row) => String(row.password || "").length > 0,
        );
        if (!current.moderatorPasswordConfigured && !hasAnyPasswordInput) {
          moderatorEnabledEl.checked = false;
          toast("Please set a moderator password before enabling access for the first time.");
          const firstPassword = $("moderatorCredentialsList")?.querySelector(
            ".moderator-password-input",
          );
          if (firstPassword) firstPassword.focus();
          return;
        }
      } catch (_e) {}
    }
    saveControlSettings({
      moderatorEnabled: moderatorEnabledEl.checked,
      moderatorCredentials: getModeratorCredentialsFromUI(),
    });
  });
}

window.play = async (id) => {
  try {
    await api(`/api/queue/${id}/play`, { method: "POST" });
    toast("Playing request.");
    render();
  } catch (e) {
    toast(e.message);
  }
};
window.complete = async (id) => {
  try {
    await api(`/api/queue/${id}/complete`, { method: "POST" });
    toast("Marked complete.");
    render();
  } catch (e) {
    toast(e.message);
  }
};
window.skip = async (id) => {
  try {
    await api(`/api/queue/${id}/skip`, { method: "POST" });
    toast("Skipped.");
    render();
  } catch (e) {
    toast(e.message);
  }
};
const movingRequests = new Set();
window.move = async (id, direction) => {
  if (movingRequests.has(id)) return;
  movingRequests.add(id);
  try {
    await api(`/api/queue/${id}/move`, { method: "POST", body: JSON.stringify({ direction }) });
    await render();
  } catch (e) {
    toast(e.message);
  } finally {
    movingRequests.delete(id);
  }
};
window.blockSong = async (songId) => {
  try {
    await api("/api/blocked/song", { method: "POST", body: JSON.stringify({ songId }) });
    toast("Song blocked.");
    render();
  } catch (e) {
    toast(e.message);
  }
};
window.blockUser = async (username) => {
  try {
    await api("/api/blocked/user", { method: "POST", body: JSON.stringify({ username }) });
    toast("User blocked.");
    render();
  } catch (e) {
    toast(e.message);
  }
};
window.removeBlocked = async (id) => {
  try {
    await api(`/api/blocked/${id}`, { method: "DELETE" });
    render();
  } catch (e) {
    toast(e.message);
  }
};

$("next").onclick = async () => {
  try {
    await api("/api/queue/next", { method: "POST" });
    toast("Moved next request to Now Playing.");
    render();
  } catch (e) {
    toast(e.message);
  }
};

$("clear").onclick = async () => {
  if (!confirm("Skip every queued request?")) return;
  try {
    await api("/api/queue/clear", { method: "POST" });
    toast("Queue cleared.");
    render();
  } catch (e) {
    toast(e.message);
  }
};

$("generate-course").onclick = async () => {
  const defaultName = (() => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `RequestQueue-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
  })();

  const input = window.prompt("Course name", defaultName);
  if (input === null) return;

  try {
    const result = await api("/api/control/course/generate", {
      method: "POST",
      body: JSON.stringify({ courseName: input.trim() || defaultName }),
    });
    const message = result.message || `Course generated: ${result.courseName}.crs`;
    toast(message, result.reloadRequired ? undefined : "error");
    if (result.reloadRequired) {
      console.log(`[course] Reload requested in-game after generating ${result.courseName}.crs`);
    }
  } catch (e) {
    console.error("[course] Generate course failed:", e);
    toast(e.message, "error");
  }
};

$("rescan").onclick = async () => {
  try {
    const r = await api("/api/rescan", { method: "POST" });
    toast(`Scanned ${r.songs} songs.`);
    render();
  } catch (e) {
    toast(e.message);
  }
};

$("addUser").onclick = () => blockUser($("blockUser").value.trim());
$("refresh").onclick = render;

$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadSongs(1), 180);
});

$("reset-search").addEventListener("click", () => {
  clearTimeout(searchTimer);
  $("search").value = "";
  [
    "filter-pack",
    "filter-genre",
    "filter-style",
    "filter-difficulty",
    "filter-meter-min",
    "filter-meter-max",
    "filter-bpm-min",
    "filter-bpm-max",
    "filter-duration-min",
    "filter-duration-max",
    "sort-field",
    "sort-order",
  ].forEach((id) => {
    $(id).selectedIndex = 0;
  });
  loadSongs(1);
});

[
  "filter-pack",
  "filter-genre",
  "filter-style",
  "filter-difficulty",
  "filter-meter-min",
  "filter-meter-max",
  "filter-bpm-min",
  "filter-bpm-max",
  "filter-duration-min",
  "filter-duration-max",
  "sort-field",
  "sort-order",
  "per-page",
].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("change", () => loadSongs(1));
});

["search-prev", "search-prev-bottom"].forEach((id) => {
  $(id).addEventListener("click", () => {
    if (searchPage > 1) loadSongs(searchPage - 1);
  });
});
["search-next", "search-next-bottom"].forEach((id) => {
  $(id).addEventListener("click", () => {
    if (searchPage < searchTotalPages) loadSongs(searchPage + 1);
  });
});
["page-input", "page-input-bottom"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("change", () => commitPageInput(el));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitPageInput(el);
  });
});

async function renderTwitch() {
  try {
    const status = await api("/api/twitch/status");
    if (status.configured) {
      $("twitchStatus").textContent = status.connected
        ? `Connected as ${status.username} to #${status.channel}`
        : `Configured for ${status.clientId}${status.username ? " (" + status.username + ")" : ""}`;
    } else {
      $("twitchStatus").textContent = "Not connected";
    }
  } catch (e) {
    $("twitchStatus").textContent = "Twitch status unavailable";
  }
}

$("checkTwitch").onclick = async () => {
  try {
    await renderTwitch();
    toast("Checked Twitch status.");
  } catch (e) {
    toast(e.message);
  }
};

$("connectTwitch").onclick = async () => {
  const clientId = $("twitchClientId").value.trim();
  const clientSecret = $("twitchClientSecret").value.trim();
  const channel = $("twitchChannel").value.trim();
  if (!clientId || !clientSecret) {
    toast("Client ID and secret required");
    return;
  }
  try {
    const redirectUri = `${location.origin}/twitch-callback.html`;
    const r = await api("/api/twitch/start-auth", {
      method: "POST",
      body: JSON.stringify({
        clientId,
        clientSecret,
        channel,
        redirectUri,
        scopes: "chat:read chat:edit user:manage:whispers",
      }),
    });
    if (r && r.url) window.location = r.url;
  } catch (e) {
    toast(e.message);
  }
};

$("disconnectTwitch").onclick = async () => {
  if (!confirm("Disconnect the Twitch bot and remove stored credentials?")) return;
  try {
    await api("/api/twitch/disconnect", { method: "POST" });
    toast("Disconnected.");
    render();
    renderTwitch();
  } catch (e) {
    toast(e.message);
  }
};

// --- Temporary Moderator nomination ---

let tempModPollTimer = null;
let tempModUsers = [];
let activeTempModUsername = null;

function isPublicUrlValid(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname !== "localhost" && u.hostname !== "127.0.0.1" && u.hostname !== "::1";
  } catch (e) {
    return false;
  }
}

async function renderTempMod() {
  const section = $("tempModSection");
  if (!section) return;

  try {
    const status = await api("/api/control/temp-mod/status");

    // Only show the section if PUBLIC_URL is valid
    if (!isPublicUrlValid(status.publicUrl)) {
      section.style.display = "none";
      return;
    }

    section.style.display = "";
    const statusDiv = $("tempModStatus");
    const activeDiv = $("tempModActive");
    const cooldownDiv = $("tempModCooldown");
    const userList = $("tempModUserList");
    const noUsers = $("tempModNoUsers");

    // Update status
    if (status.tempMod) {
      activeTempModUsername = status.tempMod.username;
      statusDiv.style.display = "";
      activeDiv.style.display = "";
      cooldownDiv.style.display = "none";
      const remaining = Math.ceil(status.tempModRemaining / 1000);
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      activeDiv.textContent = `🟢 ${status.tempMod.displayName} is moderating (${mins}:${secs.toString().padStart(2, "0")} remaining)`;
      document.querySelectorAll(".temp-mod-nominate-btn").forEach((btn) => {
        btn.disabled = true;
      });
    } else if (status.hasPendingNomination) {
      activeTempModUsername = null;
      statusDiv.style.display = "";
      activeDiv.style.display = "none";
      cooldownDiv.style.display = "";
      const secs = Math.ceil(status.nominationCooldown / 1000);
      cooldownDiv.textContent = `⏳ Awaiting response… (${secs}s cooldown)`;
      document.querySelectorAll(".temp-mod-nominate-btn").forEach((btn) => {
        btn.disabled = true;
      });
    } else {
      activeTempModUsername = null;
      statusDiv.style.display = "none";
      document.querySelectorAll(".temp-mod-nominate-btn").forEach((btn) => {
        btn.disabled = false;
      });
      document.querySelectorAll(".temp-mod-user-item.disabled").forEach((item) => {
        item.classList.remove("disabled");
      });
    }
  } catch (e) {
    // If endpoint doesn't exist (old server), hide the section
    section.style.display = "none";
  }
}

async function loadTempModUsers() {
  try {
    tempModUsers = await api("/api/control/chat-users");
    renderTempModUserList();
  } catch (e) {
    // Ignore errors
  }
}

function renderTempModUserList(filter = "") {
  const userList = $("tempModUserList");
  const noUsers = $("tempModNoUsers");
  if (!userList) return;

  const filtered = filter
    ? tempModUsers.filter(
        (u) =>
          u.displayName.toLowerCase().includes(filter.toLowerCase()) ||
          u.username.toLowerCase().includes(filter.toLowerCase()),
      )
    : tempModUsers;

  if (filtered.length === 0) {
    userList.style.display = "none";
    noUsers.style.display = "";
    return;
  }

  userList.style.display = "";
  noUsers.style.display = "none";

  userList.innerHTML = filtered
    .map((u) => {
      const isActive =
        activeTempModUsername && u.username.toLowerCase() === activeTempModUsername.toLowerCase();
      const endEarlyButton = isActive
        ? `<button class="temp-mod-end-early-btn" data-control-action="temp-mod-end" data-username="${esc(u.username)}">End Early</button>`
        : "";
      return `
    <div class="temp-mod-user-item${isActive ? " active" : ""}" data-username="${esc(u.username)}">
      <span class="username">@${esc(u.displayName)}</span>
      <div class="temp-mod-user-actions">
        <button class="temp-mod-nominate-btn" data-control-action="temp-mod-nominate" data-username="${esc(u.username)}">Nominate</button>
        ${endEarlyButton}
      </div>
    </div>
  `;
    })
    .join("");
}

async function nominateTempMod(username) {
  const tempModTime = Math.min(60, Math.max(1, Number($("tempModTime").value) || 15));
  try {
    const result = await api("/api/control/temp-mod/nominate", {
      method: "POST",
      body: JSON.stringify({ username, tempModTime }),
    });
    toast(`Nomination sent to ${result.displayname} (${result.tempModTime} min)`);
    renderTempMod();
  } catch (e) {
    toast(e.message, "error");
    renderTempMod();
  }
}

async function endTempModEarly(username) {
  const target = username || activeTempModUsername;
  if (!target) return;
  if (!confirm("End this temporary moderator session early?")) return;

  try {
    await api("/api/control/temp-mod/end-early", {
      method: "POST",
      body: JSON.stringify({ username: target }),
    });
    toast("Temporary moderator session ended.");
    renderTempMod();
    loadTempModUsers();
  } catch (e) {
    toast(e.message);
  }
}

// Make nominateTempMod available globally for onclick
window.nominateTempMod = nominateTempMod;
window.endTempModEarly = endTempModEarly;

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-control-action]");
  if (!button) return;
  const username = button.dataset.username || "";
  if (button.dataset.controlAction === "block-user") window.blockUser(username);
  if (button.dataset.controlAction === "temp-mod-nominate") window.nominateTempMod(username);
  if (button.dataset.controlAction === "temp-mod-end") window.endTempModEarly(username);
});

// Search filter for temp mod users
const tempModSearch = $("tempModSearch");
if (tempModSearch) {
  tempModSearch.addEventListener("input", () => {
    renderTempModUserList(tempModSearch.value.trim());
  });
}

// --- Category navigation ---

const DEFAULT_OVERLAY_STYLE = {
  version: 1,
  font: "default",
  fontSize: 48,
  textColor: "#ffffff",
  textShadow: true,
  shadowStrength: 1,
  backgroundEnabled: false,
  backgroundColor: "#000000",
  backgroundOpacity: 0.6,
  maxWidth: "auto",
  padding: 0,
  position: "bottom-left",
  margin: 0,
  contentOpacity: 1,
  safeArea: 5,
  canvasWidth: 1920,
  canvasHeight: 1080,
  queueEntries: 3,
  safeArea: 5,
  sections: {
    labels: { color: "#ffffff", fontSize: 48 },
    title: { color: "#ffffff", fontSize: 48 },
    metadata: { color: "#ffffff", fontSize: 48 },
    requester: { color: "#ffffff", fontSize: 48 },
  },
  showLabels: true,
  showNowPlaying: true,
  showArtwork: true,
};
let overlaySavedStyle = { ...DEFAULT_OVERLAY_STYLE };
let overlayDraftStyle = { ...DEFAULT_OVERLAY_STYLE };
let overlayStyleDirty = false;
let currentControlSettings = null;
let overlayPreviewStarted = false;
let selectedOverlayPreset = "custom";
let overlayProfiles = [];
let selectedOverlayProfileId = "";
const OVERLAY_PRESETS = {
  default: { ...DEFAULT_OVERLAY_STYLE },
  compact: {
    ...DEFAULT_OVERLAY_STYLE,
    fontSize: 36,
    canvasWidth: 1920,
    canvasHeight: 1080,
    queueEntries: 2,
    sections: {
      labels: { color: "#ffffff", fontSize: 36 },
      title: { color: "#ffffff", fontSize: 36 },
      metadata: { color: "#ffffff", fontSize: 36 },
      requester: { color: "#ffffff", fontSize: 36 },
    },
    backgroundEnabled: true,
    backgroundOpacity: 0.76,
    maxWidth: 1100,
    padding: 14,
    margin: 12,
  },
  "high-contrast": {
    ...DEFAULT_OVERLAY_STYLE,
    fontSize: 52,
    textColor: "#fff200",
    backgroundEnabled: true,
    backgroundOpacity: 0.9,
    maxWidth: 1440,
    padding: 18,
    shadowStrength: 1.5,
    sections: {
      labels: { color: "#fff200", fontSize: 52 },
      title: { color: "#fff200", fontSize: 52 },
      metadata: { color: "#ffffff", fontSize: 42 },
      requester: { color: "#ffffff", fontSize: 38 },
    },
  },
};

function setOverlayEditorStatus(message, isDirty = false) {
  const status = $("overlaySaveState");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("overlay-unsaved", isDirty);
}

function renderOverlaySettings(settings) {
  currentControlSettings = settings;
  if (overlayStyleDirty || !settings.overlayStyle) return;
  overlaySavedStyle = { ...DEFAULT_OVERLAY_STYLE, ...settings.overlayStyle };
  overlayDraftStyle = { ...overlaySavedStyle };
  overlayDraftStyle.sections = {
    ...DEFAULT_OVERLAY_STYLE.sections,
    ...settings.overlayStyle.sections,
  };
  selectedOverlayPreset =
    JSON.stringify(overlaySavedStyle) === JSON.stringify(DEFAULT_OVERLAY_STYLE)
      ? "default"
      : "custom";
  syncOverlayStyleControls();
  updateOverlayReadabilityWarning(overlayDraftStyle);
  selectedOverlayProfileId =
    overlayProfiles.find(
      (profile) => JSON.stringify(profile.style) === JSON.stringify(overlayDraftStyle),
    )?.id || "";
  renderOverlayProfileSelect();
  setOverlayEditorStatus("Saved", false);
  postOverlayPreview("overlay-style-preview", { style: overlayDraftStyle });
  if (document.querySelector('.category-group[data-category="overlay"]:not([hidden])')) {
    ensureOverlayPreview();
  }
}

function syncOverlayStyleControls() {
  const style = overlayDraftStyle;
  const values = {
    overlayFont: style.font,
    overlayFontSize: style.fontSize,
    overlayCanvas: `${style.canvasWidth}x${style.canvasHeight}`,
    overlayQueueEntries: style.queueEntries,
    overlaySafeAreaPercent: style.safeArea,
    overlayShadowStrength: Math.round(style.shadowStrength * 100),
    overlayPosition: style.position,
    overlayMargin: style.margin,
    overlayMaxWidth: String(style.maxWidth),
    overlayPadding: style.padding,
    overlayOpacity: Math.round(style.contentOpacity * 100),
    overlayBackgroundColor: style.backgroundColor,
    overlayBackgroundOpacity: Math.round(style.backgroundOpacity * 100),
    overlayBackgroundEnabled: style.backgroundEnabled,
    overlayTextShadow: style.textShadow,
    overlayShowLabels: style.showLabels,
    overlayShowNowPlaying: style.showNowPlaying,
    overlayShowArtwork: style.showArtwork,
    overlayPreset: selectedOverlayProfileId || selectedOverlayPreset || "default",
  };
  for (const section of ["labels", "title", "metadata", "requester"]) {
    values[`overlay${section[0].toUpperCase()}${section.slice(1)}Color`] =
      style.sections[section].color;
    values[`overlay${section[0].toUpperCase()}${section.slice(1)}Size`] =
      style.sections[section].fontSize;
  }
  Object.entries(values).forEach(([id, value]) => {
    const input = $(id);
    if (input) input.type === "checkbox" ? (input.checked = value) : (input.value = value);
  });
  $("overlayFontSizeValue").value = `${style.fontSize} px`;
  $("overlayShadowStrengthValue").value = `${Math.round(style.shadowStrength * 100)}%`;
  $("overlayMarginValue").value = `${style.margin} px`;
  $("overlayPaddingValue").value = `${style.padding} px`;
  $("overlayOpacityValue").value = `${Math.round(style.contentOpacity * 100)}%`;
  $("overlayBackgroundOpacityValue").value = `${Math.round(style.backgroundOpacity * 100)}%`;
  $("overlaySafeAreaValue").value = `${style.safeArea}%`;
  $("saveOverlayStyle").disabled = !overlayStyleDirty;
  $("discardOverlayStyle").disabled = !overlayStyleDirty;
  const isCustomProfileSelected = !!selectedOverlayProfileId;
  const renameBtn = $("renameOverlayPreset");
  const deleteBtn = $("deleteOverlayPreset");
  if (renameBtn) renameBtn.disabled = !isCustomProfileSelected;
  if (deleteBtn) deleteBtn.disabled = !isCustomProfileSelected;
}

function readOverlayStyleControls() {
  const titleColor = $("overlayTitleColor") ? $("overlayTitleColor").value : "#ffffff";
  return {
    version: 1,
    font: $("overlayFont").value,
    fontSize: Number($("overlayFontSize").value),
    textColor: titleColor,
    textShadow: $("overlayTextShadow").checked,
    shadowStrength: Number($("overlayShadowStrength").value) / 100,
    backgroundEnabled: $("overlayBackgroundEnabled").checked,
    backgroundColor: $("overlayBackgroundColor").value,
    backgroundOpacity: Number($("overlayBackgroundOpacity").value) / 100,
    maxWidth: $("overlayMaxWidth").value === "auto" ? "auto" : Number($("overlayMaxWidth").value),
    padding: Number($("overlayPadding").value),
    position: $("overlayPosition").value,
    margin: Number($("overlayMargin").value),
    contentOpacity: Number($("overlayOpacity").value) / 100,
    canvasWidth: Number($("overlayCanvas").value.split("x")[0]),
    canvasHeight: Number($("overlayCanvas").value.split("x")[1]),
    queueEntries: Number($("overlayQueueEntries").value),
    safeArea: Number($("overlaySafeAreaPercent").value),
    sections: {
      labels: {
        color: $("overlayLabelsColor").value,
        fontSize: Number($("overlayLabelsSize").value),
      },
      title: { color: $("overlayTitleColor").value, fontSize: Number($("overlayTitleSize").value) },
      metadata: {
        color: $("overlayMetadataColor").value,
        fontSize: Number($("overlayMetadataSize").value),
      },
      requester: {
        color: $("overlayRequesterColor").value,
        fontSize: Number($("overlayRequesterSize").value),
      },
    },
    showLabels: $("overlayShowLabels").checked,
    showNowPlaying: $("overlayShowNowPlaying").checked,
    showArtwork: $("overlayShowArtwork").checked,
  };
}

function updateOverlayDraft(options = {}) {
  overlayDraftStyle = readOverlayStyleControls();
  if (!options.preservePreset) selectedOverlayPreset = "custom";
  overlayStyleDirty = JSON.stringify(overlayDraftStyle) !== JSON.stringify(overlaySavedStyle);
  syncOverlayStyleControls();
  setOverlayEditorStatus(overlayStyleDirty ? "Unsaved changes" : "Saved", overlayStyleDirty);
  postOverlayPreview("overlay-style-preview", { style: overlayDraftStyle });
  updateOverlayReadabilityWarning(overlayDraftStyle);
  scaleOverlayPreview();
}

function postOverlayPreview(type, payload) {
  const frame = $("overlayPreview");
  if (!frame || !frame.contentWindow || !frame.src) return;
  try {
    frame.contentWindow.postMessage({ type, version: 1, ...payload }, new URL(frame.src).origin);
  } catch (_error) {
    // Preview may not have been initialized or loaded yet.
  }
}

function scaleOverlayPreview() {
  const stage = $("overlayPreview")?.parentElement;
  const frame = $("overlayPreview");
  if (!stage || !frame) return;
  const width = overlayDraftStyle.canvasWidth || 1920;
  const height = overlayDraftStyle.canvasHeight || 1080;
  const scale = stage.clientWidth / width;
  frame.width = width;
  frame.height = height;
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  frame.style.transform = `scale(${scale})`;
  stage.style.aspectRatio = `${width} / ${height}`;
  const label = document.querySelector(".overlay-preview-heading .small");
  if (label) label.textContent = `${width} × ${height}`;
}

function ensureOverlayPreview() {
  if (overlayPreviewStarted || !currentControlSettings) return;
  const frame = $("overlayPreview");
  const status = $("overlayPreviewStatus");
  if (!frame || !status) return;
  overlayPreviewStarted = true;
  const protocol = currentControlSettings.publicHttps ? "https" : "http";
  const url = new URL(
    `${protocol}://${location.hostname}:${currentControlSettings.publicPort}/overlay.html`,
  );
  url.searchParams.set("preview", "1");
  frame.addEventListener("load", () => {
    scaleOverlayPreview();
  });
  window.addEventListener("message", (event) => {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== url.origin ||
      event.data?.type !== "overlay-preview-ready"
    )
      return;
    status.hidden = true;
    postOverlayPreview("overlay-style-preview", { style: overlayDraftStyle });
    postOverlayPreview("overlay-sample-preview", { enabled: $("overlaySampleData").checked });
  });
  frame.src = url.toString();
  scaleOverlayPreview();
  setTimeout(() => {
    if (status.hidden) return;
    status.textContent =
      "Preview unavailable. Check that the public site is reachable and its certificate is trusted.";
  }, 10000);
}

const overlayStyleInputs = [
  "overlayFont",
  "overlayShadowStrength",
  "overlayPosition",
  "overlayMargin",
  "overlayMaxWidth",
  "overlayPadding",
  "overlayOpacity",
  "overlayBackgroundColor",
  "overlayBackgroundOpacity",
  "overlayBackgroundEnabled",
  "overlayTextShadow",
  "overlayShowLabels",
  "overlayShowNowPlaying",
  "overlayShowArtwork",
  "overlaySafeAreaPercent",
  "overlayQueueEntries",
  "overlayLabelsColor",
  "overlayLabelsSize",
  "overlayTitleColor",
  "overlayTitleSize",
  "overlayMetadataColor",
  "overlayMetadataSize",
  "overlayRequesterColor",
  "overlayRequesterSize",
];
overlayStyleInputs.forEach((id) => {
  const input = $(id);
  input.addEventListener(
    input.type === "range" || input.type === "color" ? "input" : "change",
    () => updateOverlayDraft(),
  );
});

function updateAllOverlaySections(field, value) {
  for (const section of ["labels", "title", "metadata", "requester"]) {
    $(`overlay${section[0].toUpperCase()}${section.slice(1)}${field}`).value = value;
  }
  updateOverlayDraft();
}

$("overlayFontSize").addEventListener("input", (event) =>
  updateAllOverlaySections("Size", Number(event.target.value)),
);

$("overlayPreset").addEventListener("change", (event) => {
  const val = event.target.value;
  const preset = OVERLAY_PRESETS[val];
  if (preset) {
    selectedOverlayProfileId = "";
    selectedOverlayPreset = val;
    overlayDraftStyle = { ...preset };
    const nameInput = $("overlayPresetName");
    if (nameInput && document.activeElement !== nameInput) {
      nameInput.value = "";
    }
    syncOverlayStyleControls();
    updateOverlayDraft({ preservePreset: true });
  } else {
    const profile = overlayProfiles.find((item) => item.id === val);
    if (profile) {
      selectedOverlayProfileId = profile.id;
      selectedOverlayPreset = "custom";
      overlayDraftStyle = {
        ...DEFAULT_OVERLAY_STYLE,
        ...profile.style,
      };
      overlayDraftStyle.sections = {
        ...DEFAULT_OVERLAY_STYLE.sections,
        ...profile.style.sections,
      };
      const nameInput = $("overlayPresetName");
      if (nameInput && document.activeElement !== nameInput) {
        nameInput.value = profile.name;
      }
      syncOverlayStyleControls();
      updateOverlayDraft({ preservePreset: true });
    }
  }
});

$("saveOverlayStyle").addEventListener("click", async () => {
  try {
    const response = await api("/api/control/settings", {
      method: "POST",
      body: JSON.stringify({ overlayStyle: overlayDraftStyle }),
    });
    overlaySavedStyle = { ...response.overlayStyle };
    overlayDraftStyle = { ...response.overlayStyle };
    overlayStyleDirty = false;
    syncOverlayStyleControls();
    setOverlayEditorStatus("Saved", false);
    postOverlayPreview("overlay-style-preview", { style: overlayDraftStyle });
    toast("Overlay appearance saved");
  } catch (error) {
    setOverlayEditorStatus("Save failed; your draft is still here", true);
    toast(error.message, "error");
  }
});

$("discardOverlayStyle").addEventListener("click", () => {
  overlayDraftStyle = { ...overlaySavedStyle };
  overlayStyleDirty = false;
  syncOverlayStyleControls();
  setOverlayEditorStatus("Saved", false);
  postOverlayPreview("overlay-style-preview", { style: overlayDraftStyle });
});

$("resetOverlayStyle").addEventListener("click", () => {
  selectedOverlayProfileId = "";
  const nameInput = $("overlayPresetName");
  if (nameInput && document.activeElement !== nameInput) {
    nameInput.value = "";
  }
  selectedOverlayPreset = "default";
  overlayDraftStyle = { ...DEFAULT_OVERLAY_STYLE };
  syncOverlayStyleControls();
  updateOverlayDraft({ preservePreset: true });
});

$("overlaySampleData").addEventListener("change", (event) => {
  postOverlayPreview("overlay-sample-preview", { enabled: event.target.checked });
});
$("overlaySafeArea").addEventListener("change", (event) => {
  postOverlayPreview("overlay-safe-area-preview", { enabled: event.target.checked });
});
$("overlayCanvas").addEventListener("change", () => updateOverlayDraft());
new ResizeObserver(scaleOverlayPreview).observe($("overlayPreview").parentElement);

function initOverlayPreviewBackground() {
  const bgTypeSelect = $("overlayPreviewBgType");
  const bgColorInput = $("overlayPreviewBgColor");
  const bgFitSelect = $("overlayPreviewBgFit");
  const bgFileInput = $("overlayPreviewBgFile");
  const uploadBtn = $("uploadOverlayPreviewBg");
  const clearBtn = $("clearOverlayPreviewBg");
  const stage = $("overlayPreview")?.parentElement;
  if (!stage || !bgTypeSelect) return;

  let bgType = localStorage.getItem("overlay_preview_bg_type") || "checkerboard";
  let bgColor = localStorage.getItem("overlay_preview_bg_color") || "#1a1d24";
  let bgImage = localStorage.getItem("overlay_preview_bg_image") || "";
  let bgFit = localStorage.getItem("overlay_preview_bg_fit") || "stretch";

  function applyBg() {
    stage.classList.remove("bg-solid", "bg-image-stretch", "bg-image-zoom");
    stage.style.backgroundColor = "";
    stage.style.backgroundImage = "";

    bgTypeSelect.value = bgType;
    bgColorInput.value = bgColor;
    bgFitSelect.value = bgFit;

    const colorContainer = $("overlayPreviewBgColorContainer");
    const fitContainer = $("overlayPreviewBgFitContainer");
    const imageActions = $("overlayPreviewBgImageActions");

    if (colorContainer) colorContainer.hidden = bgType !== "solid";
    if (fitContainer) fitContainer.hidden = bgType !== "image";
    if (imageActions) imageActions.hidden = bgType !== "image";

    if (bgType === "solid") {
      stage.classList.add("bg-solid");
      stage.style.backgroundColor = bgColor;
    } else if (bgType === "image" && bgImage) {
      stage.classList.add(bgFit === "zoom" ? "bg-image-zoom" : "bg-image-stretch");
      stage.style.backgroundImage = `url(${bgImage})`;
    }

    localStorage.setItem("overlay_preview_bg_type", bgType);
    localStorage.setItem("overlay_preview_bg_color", bgColor);
    if (bgImage) localStorage.setItem("overlay_preview_bg_image", bgImage);
    else localStorage.removeItem("overlay_preview_bg_image");
    localStorage.setItem("overlay_preview_bg_fit", bgFit);
  }

  bgTypeSelect.addEventListener("change", (e) => {
    bgType = e.target.value;
    applyBg();
  });
  bgColorInput.addEventListener("input", (e) => {
    bgColor = e.target.value;
    applyBg();
  });
  bgFitSelect.addEventListener("change", (e) => {
    bgFit = e.target.value;
    applyBg();
  });

  if (uploadBtn) uploadBtn.addEventListener("click", () => bgFileInput?.click());
  if (bgFileInput) {
    bgFileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) return toast("Image must be smaller than 5MB", "error");
      const reader = new FileReader();
      reader.onload = (ev) => {
        bgImage = ev.target.result;
        bgType = "image";
        applyBg();
        toast("Preview background image set");
      };
      reader.readAsDataURL(file);
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      bgImage = "";
      bgType = "checkerboard";
      applyBg();
      toast("Preview background image cleared");
    });
  }

  applyBg();
}

function renderOverlayProfileSelect() {
  const select = $("overlayPreset");
  const customGroup = $("overlayCustomPresetsGroup");
  if (!select || !customGroup) return;

  customGroup.innerHTML = "";
  overlayProfiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    customGroup.append(option);
  });

  const selectedValue = selectedOverlayProfileId || selectedOverlayPreset || "default";
  select.value = selectedValue;

  const selectedProfile = overlayProfiles.find(
    (profile) => profile.id === selectedOverlayProfileId,
  );
  const nameInput = $("overlayPresetName");
  if (nameInput && document.activeElement !== nameInput) {
    nameInput.value = selectedProfile ? selectedProfile.name : "";
  }

  const isCustomProfileSelected = !!selectedOverlayProfileId;
  const renameBtn = $("renameOverlayPreset");
  const deleteBtn = $("deleteOverlayPreset");
  if (renameBtn) renameBtn.disabled = !isCustomProfileSelected;
  if (deleteBtn) deleteBtn.disabled = !isCustomProfileSelected;
}

async function loadOverlayProfiles() {
  try {
    overlayProfiles = await api("/api/control/overlay/profiles");
    if (!overlayProfiles.some((profile) => profile.id === selectedOverlayProfileId)) {
      selectedOverlayProfileId =
        overlayProfiles.find(
          (profile) => JSON.stringify(profile.style) === JSON.stringify(overlaySavedStyle),
        )?.id || "";
    }
    renderOverlayProfileSelect();
  } catch (_error) {
    overlayProfiles = [];
  }
}

async function persistOverlayProfiles(nextProfiles) {
  const response = await api("/api/control/overlay/profiles", {
    method: "POST",
    body: JSON.stringify({ profiles: nextProfiles }),
  });
  overlayProfiles = response.profiles;
  renderOverlayProfileSelect();
  return overlayProfiles;
}

const savePresetBtn = $("saveOverlayPreset");
if (savePresetBtn) {
  savePresetBtn.addEventListener("click", async () => {
    const nameInput = $("overlayPresetName");
    const name = nameInput ? nameInput.value.trim() : "";
    if (!name) return toast("Enter a preset name", "error");

    const selectedProfile = overlayProfiles.find(
      (profile) => profile.id === selectedOverlayProfileId,
    );
    if (overlayProfiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
      if (!selectedProfile || selectedProfile.name.toLowerCase() !== name.toLowerCase()) {
        return toast("A preset with that name already exists", "error");
      }
    }
    try {
      const profile = selectedProfile
        ? { ...selectedProfile, name: name.trim(), style: overlayDraftStyle }
        : { id: crypto.randomUUID().slice(0, 36), name: name.trim(), style: overlayDraftStyle };
      const nextProfiles = selectedProfile
        ? overlayProfiles.map((item) => (item.id === profile.id ? profile : item))
        : [...overlayProfiles, profile];
      await persistOverlayProfiles(nextProfiles);
      selectedOverlayProfileId = profile.id;
      renderOverlayProfileSelect();
      toast("Preset saved");
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

const renamePresetBtn = $("renameOverlayPreset");
if (renamePresetBtn) {
  renamePresetBtn.addEventListener("click", async () => {
    const profile = overlayProfiles.find((item) => item.id === selectedOverlayProfileId);
    if (!profile) return;
    const nameInput = $("overlayPresetName");
    const name = nameInput ? nameInput.value.trim() : "";
    if (!name) return toast("Enter a preset name", "error");
    if (
      overlayProfiles.some(
        (item) => item.id !== profile.id && item.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return toast("A preset with that name already exists", "error");
    }
    try {
      await persistOverlayProfiles(
        overlayProfiles.map((item) =>
          item.id === profile.id ? { ...item, name: name.trim() } : item,
        ),
      );
      toast("Preset renamed");
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

const deletePresetBtn = $("deleteOverlayPreset");
if (deletePresetBtn) {
  deletePresetBtn.addEventListener("click", async () => {
    if (!selectedOverlayProfileId) return;
    try {
      await persistOverlayProfiles(
        overlayProfiles.filter((item) => item.id !== selectedOverlayProfileId),
      );
      selectedOverlayProfileId = "";
      renderOverlayProfileSelect();
      toast("Preset deleted");
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

const exportPresetsBtn = $("exportOverlayPresets");
if (exportPresetsBtn) {
  exportPresetsBtn.addEventListener("click", () => {
    const blob = new Blob(
      [
        JSON.stringify(
          { format: "dance-game-overlay-profiles", version: 1, profiles: overlayProfiles },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "overlay-presets.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

const importPresetsBtn = $("importOverlayPresets");
if (importPresetsBtn) {
  importPresetsBtn.addEventListener("click", () => $("overlayProfilesFile")?.click());
}

const profilesFileInput = $("overlayProfilesFile");
if (profilesFileInput) {
  profilesFileInput.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 128 * 1024) return toast("Preset file is too large", "error");
    try {
      const imported = JSON.parse(await file.text());
      if (
        imported.format !== "dance-game-overlay-profiles" ||
        imported.version !== 1 ||
        !Array.isArray(imported.profiles) ||
        imported.profiles.length > 20
      ) {
        throw new Error("Unsupported overlay preset file");
      }
      const names = new Set(overlayProfiles.map((profile) => profile.name.toLowerCase()));
      const additions = [];
      for (const profile of imported.profiles) {
        const name = String(profile && profile.name ? profile.name : "").trim();
        const nameKey = name.toLowerCase();
        if (!name || names.has(nameKey)) continue;
        names.add(nameKey);
        additions.push({ ...profile, id: crypto.randomUUID().slice(0, 36), name });
      }
      if (overlayProfiles.length + additions.length > 20) {
        throw new Error("Import would exceed the 20-preset limit");
      }
      await persistOverlayProfiles([...overlayProfiles, ...additions]);
      toast(`Imported ${additions.length} preset${additions.length === 1 ? "" : "s"}`);
    } catch (error) {
      toast(error.message || "Could not read preset file", "error");
    }
  });
}

initOverlayPreviewBackground();

function relativeLuminance(hex) {
  const channels = hex.match(/[\da-f]{2}/gi).map((part) => parseInt(part, 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function blendColor(foreground, background, alpha) {
  const fg = foreground.match(/[\da-f]{2}/gi).map((part) => parseInt(part, 16));
  const bg = background.match(/[\da-f]{2}/gi).map((part) => parseInt(part, 16));
  return `#${fg
    .map((value, index) =>
      Math.round(value * alpha + bg[index] * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function contrastRatio(first, second) {
  const luminances = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

function updateOverlayReadabilityWarning(style) {
  const warning = $("overlayReadabilityWarning");
  const background = style.backgroundEnabled
    ? blendColor(style.backgroundColor, "#808080", style.backgroundOpacity)
    : null;
  const ratios = Object.values(style.sections).map((section) => {
    if (background)
      return contrastRatio(blendColor(section.color, background, style.contentOpacity), background);
    return Math.min(
      contrastRatio(blendColor(section.color, "#000000", style.contentOpacity), "#000000"),
      contrastRatio(blendColor(section.color, "#ffffff", style.contentOpacity), "#ffffff"),
    );
  });
  const lowContrast = ratios.some((ratio) => ratio < 4.5);
  const smallText = Object.values(style.sections).some((section) => section.fontSize < 24);
  warning.textContent = [
    lowContrast ? "Some text may be hard to read against light or dark scenes." : "",
    smallText ? "Text below 24 px may be difficult to read at stream scale." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

const categoryButtons = document.querySelectorAll(".category-button");
const categoryGroups = document.querySelectorAll(".category-group");
const categoryActions = document.querySelectorAll(".category-action");

function setActiveCategory(category) {
  categoryButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.category === category);
  });
  categoryGroups.forEach((group) => {
    const isVisible = group.dataset.category === category;
    group.hidden = !isVisible;
  });
  categoryActions.forEach((button) => {
    const visible = button.dataset.visibleCategory === category;
    button.hidden = !visible;
  });
  if (category === "overlay") ensureOverlayPreview();
}

categoryButtons.forEach((button) => {
  button.addEventListener("click", () => setActiveCategory(button.dataset.category));
});

setActiveCategory("songs");

// --- Initialization ---

getFilters();
loadSongs(1);
render();
loadOverlayProfiles();
renderTwitch();
setInterval(render, 2500);
setInterval(renderTwitch, 5000);

// Temp mod polling
renderTempMod();
loadTempModUsers();
setInterval(renderTempMod, 2000);
setInterval(loadTempModUsers, 10000);
