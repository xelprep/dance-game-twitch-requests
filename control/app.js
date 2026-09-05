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

function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 2200);
}

function getSongSearchPerPage() {
  return Number($("per-page").value) || 25;
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
  const active = !!song.active;

  const article = document.createElement("article");
  article.className = active ? "song dimmed" : "song";
  article.innerHTML = `
    <div class="song-main">
      <div class="song-meta">
        <strong>ID: ${esc(song.id)} - ${esc(song.title)}</strong>
        ${song.subtitle ? `<span class="song-subtitle">${esc(song.subtitle)}</span>` : ""}
        <small>${esc(song.artist)}${song.pack ? " • " + esc(song.pack) : ""}</small>
        <small>${esc(charts)}</small>
      </div>
      <div class="song-actions">
        <button type="button" class="song-action" ${active ? "disabled" : `onclick="window.addToQueue(${song.id})"`}>${active ? "Already Queued" : "Add to queue"}</button>
      </div>
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

    packSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    genreSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    diffSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    meterMinSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());
    meterMaxSel.querySelectorAll('option:not([value=""])').forEach((option) => option.remove());

    const sortAlpha = (a, b) =>
      String(a).localeCompare(String(b), undefined, { sensitivity: "base" });

    [...(f.packs || [])]
      .sort((a, b) => sortAlpha(a.pack, b.pack))
      .forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.pack;
        opt.textContent = `${p.pack} (${p.count})`;
        packSel.appendChild(opt);
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
    });
  } catch (e) {
    console.error("Failed to load filters", e);
  }
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

window.addToQueue = async (songId) => {
  try {
    const result = await api("/api/request", {
      method: "POST",
      body: JSON.stringify({
        songId,
        username: "streamer",
        displayName: "Streamer",
      }),
    });
    toast(`Added ${result.request.song.title} to the queue.`);
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

    // Reload the song search when a song enters or leaves the queue / now playing,
    // so the dimmed "already queued" state stays current without a manual refresh.
    {
      const ids = new Set(queue.map((r) => r.song_id));
      if (now && now.song_id != null) ids.add(now.song_id);
      const key = [...ids].sort((a, b) => a - b).join(",");
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
          <small>${esc(formatCharts(now.charts))}</small>
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
          <small>${esc(formatCharts(r.charts))}</small>
          <small>Requested by ${esc(r.requested_display)}${String(r.requested_by.toLowerCase() || "") === "streamer" ? " (Control Panel)" : ""}</small>
        </div>
        <div class="row-actions">
          <button onclick="move(${r.id},'up')">↑</button>
          <button onclick="move(${r.id},'down')">↓</button>
          <button onclick="play(${r.id})">Play</button>
          <button onclick="skip(${r.id})">Skip</button>
          <button onclick="blockSong(${r.song_id})">Block Song</button>
          <button onclick="blockUser('${esc(r.requested_by)}')">Block User</button>
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
      }

      const allowChat = !!(chatRequestsEnabled && chatRequestsEnabled.checked);
      if (chatRequestsRequireRole) chatRequestsRequireRole.disabled = !allowChat;
    } catch (e) {
      /* ignore */
    }
  } catch (e) {
    toast(e.message);
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
        window.location.href = openAt;
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
    // store the secret in sessionStorage temporarily so the callback can complete the exchange
    sessionStorage.setItem("twitch_clientId", clientId);
    sessionStorage.setItem("twitch_clientSecret", clientSecret);
    if (channel) sessionStorage.setItem("twitch_channel", channel);
    const redirectUri = `${location.origin}/twitch-callback.html`;
    const r = await api("/api/twitch/start-auth", {
      method: "POST",
      body: JSON.stringify({
        clientId,
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
        ? `<button class="temp-mod-end-early-btn" onclick="endTempModEarly('${esc(u.username)}')">End Early</button>`
        : "";
      return `
    <div class="temp-mod-user-item${isActive ? " active" : ""}" data-username="${esc(u.username)}">
      <span class="username">@${esc(u.displayName)}</span>
      <div class="temp-mod-user-actions">
        <button class="temp-mod-nominate-btn" onclick="nominateTempMod('${esc(u.username)}')">Nominate</button>
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
    toast(e.message);
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

// Search filter for temp mod users
const tempModSearch = $("tempModSearch");
if (tempModSearch) {
  tempModSearch.addEventListener("input", () => {
    renderTempModUserList(tempModSearch.value.trim());
  });
}

// --- Category navigation ---

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
}

categoryButtons.forEach((button) => {
  button.addEventListener("click", () => setActiveCategory(button.dataset.category));
});

setActiveCategory("songs");

// --- Initialization ---

getFilters();
loadSongs(1);
render();
renderTwitch();
setInterval(render, 2500);
setInterval(renderTwitch, 5000);

// Temp mod polling
renderTempMod();
loadTempModUsers();
setInterval(renderTempMod, 2000);
setInterval(loadTempModUsers, 10000);
