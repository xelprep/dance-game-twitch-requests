const $ = (id) => document.getElementById(id);

async function getJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function showCopyStatus(message) {
  const status = $("copy-status");
  if (!status) return;

  status.textContent = message;
  status.classList.add("visible");
  clearTimeout(status.hideTimer);
  status.hideTimer = setTimeout(() => {
    status.classList.remove("visible");
  }, 2200);
}

function fallbackCopyText(value) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  return copied;
}

async function copyRequestCommand(songId) {
  const id = String(songId ?? "").trim();
  if (!id) return;

  const command = `!requestid ${id}`;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(command);
    } else if (!fallbackCopyText(command)) {
      throw new Error("Clipboard fallback failed");
    }

    showCopyStatus(`Copied ${command} to your clipboard.`);
  } catch (e) {
    console.error("Failed to copy request command", e);
    showCopyStatus("Copy failed. Please copy the command manually.");
  }
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

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Accepts "90", "1:30" or "1:02:03"; returns whole seconds or null.
function parseDurationInput(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const parts = v.split(":").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
}

function songCard(song) {
  const charts = formatCharts(song.charts);
  const active = !!song.active;
  const bpmLabel =
    song.bpmMin != null
      ? song.bpmMax > song.bpmMin
        ? `${song.bpmMin}-${song.bpmMax} BPM`
        : `${song.bpmMin} BPM`
      : "";
  const durationLabel = song.duration != null ? formatDuration(song.duration) : "";
  const meta = [bpmLabel, durationLabel].filter(Boolean).join(" • ");

  const article = document.createElement("article");
  article.className = active ? "song dimmed" : "song clickable";
  if (!active) {
    article.tabIndex = 0;
    article.setAttribute("role", "button");
    article.setAttribute("aria-label", `Copy request command for ${song.title}`);
    article.addEventListener("click", () => copyRequestCommand(song.id));
    article.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        copyRequestCommand(song.id);
      }
    });
  } else {
    article.setAttribute("aria-label", `${song.title} is already queued or playing`);
  }
  article.innerHTML = `
    <div class="song-main">
      <div class="song-meta">
        <strong>ID: ${escapeHTML(String(song.id))} - ${escapeHTML(song.title)}</strong>
        ${song.subtitle ? `<span class="song-subtitle">${escapeHTML(song.subtitle)}</span>` : ""}
        <small>${escapeHTML(song.artist)}${song.pack ? " • " + escapeHTML(song.pack) : ""}</small>
        <small>${escapeHTML(charts)}</small>
        ${meta ? `<small>${escapeHTML(meta)}</small>` : ""}
      </div>
    </div>
  `;

  return article;
}

async function search() {
  // use the unified /api/songs endpoint which supports q + filters
  loadSongs(1);
}

async function queue() {
  const container = $("queue");
  container.replaceChildren();

  try {
    const items = await getJSON("/api/queue");
    if (!items.length) {
      container.innerHTML = '<p class="muted">Queue is empty.</p>';
      return;
    }

    container.innerHTML = items
      .map(
        (r, i) => `
      <article class="request">
        <div class="rank">${i + 1}</div>
        <div class="info">
          <strong>${escapeHTML(r.title)}</strong>
          ${r.subtitle ? `<span class="subtitle">${escapeHTML(r.subtitle)}</span>` : ""}
          <span>${escapeHTML(r.artist)}${r.pack ? " • " + escapeHTML(r.pack) : ""}</span>
          <small>${escapeHTML(formatCharts(r.charts))}</small>
          <small>Requested by ${escapeHTML(r.requested_display)}${String(r.requested_by || "").toLowerCase() === "streamer" ? " (Control Panel)" : ""}</small>
        </div>
      </article>
    `,
      )
      .join("");
  } catch (e) {
    container.innerHTML = `<p class="muted">${escapeHTML(e.message)}</p>`;
  }
}

let activeSongsKey = "";
async function refreshSongsIfActiveChanged() {
  // Reload the picker when a song enters or leaves the queue / now playing,
  // so the dimmed "already queued" state stays current without a manual refresh.
  try {
    const [queueItems, nowPlaying] = await Promise.all([
      getJSON("/api/queue"),
      getJSON("/api/now-playing"),
    ]);
    const ids = new Set((queueItems || []).map((r) => r.song_id));
    if (nowPlaying && nowPlaying.song_id != null) ids.add(nowPlaying.song_id);
    const key = [...ids].sort((a, b) => a - b).join(",");
    if (key !== activeSongsKey) {
      activeSongsKey = key;
      loadSongs(currentPage);
    }
  } catch {}
}

async function stats() {
  try {
    const s = await getJSON("/api/stats");
    $("stats").textContent =
      `${s.songs.toLocaleString()} songs • ${s.charts.toLocaleString()} charts • ${s.queued} queued`;
  } catch {}
}

function escapeHTML(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[c],
  );
}

// Browsing / filtering state
let timer;
let currentPage = 1;
let totalPages = 1;
let pageRequestSeq = 0;

function getPerPage() {
  return Number($("per-page").value) || 25;
}

$("search").addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    loadSongs(1);
  }, 180);
});

$("reset-search").addEventListener("click", () => {
  clearTimeout(timer);
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
    "sort-field",
    "sort-order",
  ].forEach((id) => {
    $(id).selectedIndex = 0;
  });
  ["filter-duration-min", "filter-duration-max"].forEach((id) => {
    $(id).value = "";
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
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", () => loadSongs(1));
});

["search-prev", "search-prev-bottom"].forEach((id) => {
  const el = $(id);
  if (el)
    el.addEventListener("click", () => {
      if (currentPage > 1) loadSongs(currentPage - 1);
    });
});
["search-next", "search-next-bottom"].forEach((id) => {
  const el = $(id);
  if (el)
    el.addEventListener("click", () => {
      if (currentPage < totalPages) loadSongs(currentPage + 1);
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

$("refresh").addEventListener("click", queue);

async function getFilters() {
  try {
    const f = await getJSON("/api/song-filters");
    const packSel = $("filter-pack");
    const genreSel = $("filter-genre");
    const diffSel = $("filter-difficulty");
    const meterMinSel = $("filter-meter-min");
    const meterMaxSel = $("filter-meter-max");
    const bpmMinSel = $("filter-bpm-min");
    const bpmMaxSel = $("filter-bpm-max");

    // Clear existing (keep the first "All"/Min option)
    packSel.querySelectorAll('option:not([value=""])').forEach((n) => n.remove());
    genreSel.querySelectorAll('option:not([value=""])').forEach((n) => n.remove());
    diffSel.querySelectorAll('option:not([value=""])').forEach((n) => n.remove());
    meterMinSel.querySelectorAll('option:not([value=""])').forEach((n) => n.remove());
    meterMaxSel.querySelectorAll('option:not([value=""])').forEach((n) => n.remove());
    bpmMinSel.querySelectorAll('option:not([value=""])').forEach((n) => n.remove());
    bpmMaxSel.querySelectorAll('option:not([value=""])').forEach((n) => n.remove());

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

    // meters are returned as {meter, count}
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

    const bpms = (f.bpms || [])
      .map((b) => ({ bpm: Number(b.bpm), count: b.count }))
      .filter((b) => !Number.isNaN(b.bpm))
      .sort((a, b) => a.bpm - b.bpm);

    bpms.forEach((b) => {
      const optMin = document.createElement("option");
      optMin.value = String(b.bpm);
      optMin.textContent = `${b.bpm} (${b.count})`;
      bpmMinSel.appendChild(optMin);

      const optMax = document.createElement("option");
      optMax.value = String(b.bpm);
      optMax.textContent = `${b.bpm} (${b.count})`;
      bpmMaxSel.appendChild(optMax);
    });
  } catch (e) {
    console.error("Failed to load filters", e);
  }
}

async function loadSongs(page = 1) {
  const seq = ++pageRequestSeq;
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
  const durationMin = parseDurationInput($("filter-duration-min").value);
  const durationMax = parseDurationInput($("filter-duration-max").value);
  const sort = $("sort-field").value;
  const order = $("sort-order").value;
  const q = $("search").value.trim();
  const perPage = getPerPage();

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
  if (durationMin !== null) params.set("durationMin", durationMin);
  if (durationMax !== null) params.set("durationMax", durationMax);
  if (sort) params.set("sort", sort);
  if (order) params.set("order", order);
  if (q) params.set("q", q);
  // Flag songs that are already queued or now playing so their rows can be dimmed.
  params.set("markActive", "1");

  try {
    const res = await getJSON(`/api/songs?${params.toString()}`);
    if (seq !== pageRequestSeq) return;
    const songs = res.songs || [];
    const total = res.total || 0;
    currentPage = res.page || page;
    totalPages = Math.max(1, Math.ceil(total / (res.perPage || perPage)));

    if (!songs.length) {
      results.textContent = "No songs.";
      updatePager();
      return;
    }

    songs.forEach((song) => results.appendChild(songCard(song)));
    updatePager();
  } catch (e) {
    if (seq !== pageRequestSeq) return;
    results.textContent = e.message;
    updatePager();
  }
}

function updatePager() {
  ["search-prev", "search-prev-bottom"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = currentPage <= 1;
  });
  ["search-next", "search-next-bottom"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = currentPage >= totalPages;
  });
  ["pageInfo", "pageInfo-bottom"].forEach((id) => {
    const el = $(id);
    if (el) el.textContent = `of ${totalPages}`;
  });
  ["page-input", "page-input-bottom"].forEach((id) => {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = String(currentPage);
  });
}

function commitPageInput(source) {
  const target = parseInt(source.value, 10);
  if (Number.isNaN(target) || target < 1) {
    source.value = String(currentPage);
    return;
  }
  const page = Math.min(target, totalPages);
  source.value = String(page);
  if (page !== currentPage) loadSongs(page);
}

stats();
queue();
getFilters();
loadSongs(1);
setInterval(() => {
  queue();
  stats();
  refreshSongsIfActiveChanged();
}, 5000);
