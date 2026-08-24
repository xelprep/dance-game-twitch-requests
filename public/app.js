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
      <strong>ID: ${escapeHTML(String(song.id))} - ${escapeHTML(song.title)}</strong>
      ${song.subtitle ? `<span>${escapeHTML(song.subtitle)}</span>` : ""}
      <small>${escapeHTML(song.artist)} ${song.pack ? "• " + escapeHTML(song.pack) : ""}</small>
      <small>${escapeHTML(charts)}</small>
    </div>
  `;
  return div;
}

async function search() {
  // use the unified /api/songs endpoint which supports q + filters
  loadSongs(1);
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

// Browsing / filtering state
let timer;
let currentPage = 1;
let totalPages = 1;

function getPerPage() {
  return Number($('per-page').value) || 25;
}

$("search").addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    loadSongs(1);
  }, 180);
});

['filter-pack','filter-genre','filter-difficulty','filter-meter-min','filter-meter-max','sort-field','sort-order','per-page'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => loadSongs(1));
});

$('prev').addEventListener('click', () => { if (currentPage > 1) loadSongs(currentPage - 1); });
$('next').addEventListener('click', () => { if (currentPage < totalPages) loadSongs(currentPage + 1); });

$("refresh").addEventListener("click", queue);

async function getFilters() {
  try {
    const f = await getJSON('/api/song-filters');
    const packSel = $('filter-pack');
    const genreSel = $('filter-genre');
    const diffSel = $('filter-difficulty');
    const meterMinSel = $('filter-meter-min');
    const meterMaxSel = $('filter-meter-max');

    // Clear existing (keep the first "All"/Min option)
    packSel.querySelectorAll('option:not([value=""])').forEach(n => n.remove());
    genreSel.querySelectorAll('option:not([value=""])').forEach(n => n.remove());
    diffSel.querySelectorAll('option:not([value=""])').forEach(n => n.remove());
    meterMinSel.querySelectorAll('option:not([value=""])').forEach(n => n.remove());
    meterMaxSel.querySelectorAll('option:not([value=""])').forEach(n => n.remove());

    const sortAlpha = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });

    [...(f.packs || [])].sort((a, b) => sortAlpha(a.pack, b.pack)).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.pack;
      opt.textContent = `${p.pack} (${p.count})`;
      packSel.appendChild(opt);
    });

    [...(f.genres || [])].sort((a, b) => sortAlpha(a.genre, b.genre)).forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.genre;
      opt.textContent = `${g.genre} (${g.count})`;
      genreSel.appendChild(opt);
    });

    [...(f.difficulties || [])].sort((a, b) => sortAlpha(a.difficulty, b.difficulty)).forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.difficulty;
      opt.textContent = `${d.difficulty} (${d.count})`;
      diffSel.appendChild(opt);
    });

    // meters are returned as {meter, count}
    const meters = (f.meters || []).map(m => ({ meter: Number(m.meter), count: m.count }))
      .filter(m => !Number.isNaN(m.meter))
      .sort((a,b) => a.meter - b.meter);

    meters.forEach(m => {
      const optMin = document.createElement('option');
      optMin.value = String(m.meter);
      optMin.textContent = String(m.meter);
      meterMinSel.appendChild(optMin);

      const optMax = document.createElement('option');
      optMax.value = String(m.meter);
      optMax.textContent = String(m.meter);
      meterMaxSel.appendChild(optMax);
    });
  } catch (e) {
    console.error('Failed to load filters', e);
  }
}

async function loadSongs(page = 1) {
  const results = $('results');
  results.replaceChildren();

  const pack = $('filter-pack').value;
  const genre = $('filter-genre').value;
  const difficulty = $('filter-difficulty').value;
  const meterMin = $('filter-meter-min').value;
  const meterMax = $('filter-meter-max').value;
  const sort = $('sort-field').value;
  const order = $('sort-order').value;
  const q = $('search').value.trim();
  const perPage = getPerPage();

  const params = new URLSearchParams();
  params.set('page', page);
  params.set('perPage', perPage);
  if (pack) params.set('pack', pack);
  if (genre) params.set('genre', genre);
  if (difficulty) params.set('difficulty', difficulty);
  if (meterMin) params.set('meterMin', meterMin);
  if (meterMax) params.set('meterMax', meterMax);
  if (sort) params.set('sort', sort);
  if (order) params.set('order', order);
  if (q) params.set('q', q);

  try {
    const res = await getJSON(`/api/songs?${params.toString()}`);
    const songs = res.songs || [];
    const total = res.total || 0;
    currentPage = res.page || page;
    totalPages = Math.max(1, Math.ceil(total / (res.perPage || perPage)));

    if (!songs.length) {
      results.textContent = 'No songs.';
      updatePager();
      return;
    }

    songs.forEach(song => results.appendChild(songCard(song)));
    updatePager();
  } catch (e) {
    results.textContent = e.message;
    updatePager();
  }
}

function updatePager() {
  const prev = $('prev');
  const next = $('next');
  const info = $('pageInfo');
  prev.disabled = currentPage <= 1;
  next.disabled = currentPage >= totalPages;
  info.textContent = `Page ${currentPage} of ${totalPages}`;
}

stats();
queue();
getFilters();
loadSongs(1);
setInterval(() => {
  queue();
  stats();
}, 5000);
