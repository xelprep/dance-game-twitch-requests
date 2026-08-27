const $ = id => document.getElementById(id);

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: {"Content-Type": "application/json", ...(options.headers || {})},
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"})[c]);
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

async function getFilters() {
  try {
    const f = await api('/api/song-filters');
    const packSel = $('filter-pack');
    const genreSel = $('filter-genre');
    const diffSel = $('filter-difficulty');
    const meterMinSel = $('filter-meter-min');
    const meterMaxSel = $('filter-meter-max');

    packSel.querySelectorAll('option:not([value=""])').forEach(option => option.remove());
    genreSel.querySelectorAll('option:not([value=""])').forEach(option => option.remove());
    diffSel.querySelectorAll('option:not([value=""])').forEach(option => option.remove());
    meterMinSel.querySelectorAll('option:not([value=""])').forEach(option => option.remove());
    meterMaxSel.querySelectorAll('option:not([value=""])').forEach(option => option.remove());

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

    const meters = (f.meters || []).map(m => ({ meter: Number(m.meter), count: m.count }))
      .filter(m => !Number.isNaN(m.meter))
      .sort((a, b) => a.meter - b.meter);

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

let searchTimer = null;
let searchPage = 1;
let searchTotalPages = 1;

function updateSearchPager() {
  ['search-prev', 'search-prev-bottom'].forEach(id => {
    $(id).disabled = searchPage <= 1;
  });
  ['search-next', 'search-next-bottom'].forEach(id => {
    $(id).disabled = searchPage >= searchTotalPages;
  });
  ['pageInfo', 'pageInfo-bottom'].forEach(id => {
    $(id).textContent = `Page ${searchPage} of ${searchTotalPages}`;
  });
}

async function loadSongs(page = 1) {
  const results = $('results');
  results.replaceChildren();

  const pack = $('filter-pack').value;
  const genre = $('filter-genre').value;
  const style = $('filter-style').value;
  const difficulty = $('filter-difficulty').value;
  const meterMin = $('filter-meter-min').value;
  const meterMax = $('filter-meter-max').value;
  const sort = $('sort-field').value;
  const order = $('sort-order').value;
  const q = $('search').value.trim();
  const perPage = getSongSearchPerPage();

  const params = new URLSearchParams();
  params.set('page', page);
  params.set('perPage', perPage);
  if (pack) params.set('pack', pack);
  if (genre) params.set('genre', genre);
  if (style) params.set('style', style);
  if (difficulty) params.set('difficulty', difficulty);
  if (meterMin) params.set('meterMin', meterMin);
  if (meterMax) params.set('meterMax', meterMax);
  if (sort) params.set('sort', sort);
  if (order) params.set('order', order);
  if (q) params.set('q', q);

  try {
    const res = await api(`/api/songs?${params.toString()}`);
    const songs = res.songs || [];
    const total = res.total || 0;
    searchPage = res.page || page;
    searchTotalPages = Math.max(1, Math.ceil(total / (res.perPage || perPage)));

    if (!songs.length) {
      results.textContent = 'No songs.';
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

window.addToQueue = async songId => {
  try {
    const result = await api('/api/request', {
      method: 'POST',
      body: JSON.stringify({
        songId,
        username: 'streamer',
        displayName: 'Streamer'
      })
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
    const [stats, now, queue, blacklist, settings] = await Promise.all([
      api("/api/stats"), api("/api/now-playing"),
      api("/api/queue"), api("/api/blacklist"),
      // Control settings endpoint
      (async () => { try { return await api('/api/control/settings'); } catch (e) { return { prioritizeViewerRequests: true }; } })()
    ]);

    $("stats").textContent =
      `${stats.songs.toLocaleString()} songs • ${stats.queued} queued • ${stats.playing} playing`;

    $("now").innerHTML = now ? `
      <div class="now-card">
        <div>
          <strong>${esc(now.title)}</strong>
          ${now.subtitle ? `<span class="subtitle">${esc(now.subtitle)}</span>` : ""}
          <span>${esc(now.artist)}${now.pack ? " • " + esc(now.pack) : ""}</span>
          <small>${esc(formatCharts(now.charts))}</small>
          <small>requested by ${esc(now.requested_display)}</small>
        </div>
        <button onclick="complete(${now.id})">Complete</button>
      </div>` : "Nothing playing.";

    $("queue").innerHTML = queue.length ? queue.map((r, i) => `
      <article class="request">
        <div class="rank">${i + 1}</div>
        <div class="info">
          <strong>${esc(r.title)}</strong>
          ${r.subtitle ? `<span class="subtitle">${esc(r.subtitle)}</span>` : ""}
          <span>${esc(r.artist)}${r.pack ? " • " + esc(r.pack) : ""}</span>
          <small>${esc(formatCharts(r.charts))}</small>
          <small>Requested by ${esc(r.requested_display)}${(String(r.requested_by.toLowerCase() || "") === "streamer") ? " (Control Panel)" : ""}</small>
        </div>
        <div class="row-actions">
          <button onclick="move(${r.id},'up')">↑</button>
          <button onclick="move(${r.id},'down')">↓</button>
          <button onclick="play(${r.id})">Play</button>
          <button onclick="skip(${r.id})">Skip</button>
          <button onclick="blackSong(${r.song_id})">Block Song</button>
          <button onclick="blackUser('${esc(r.requested_by)}')">Block User</button>
        </div>
      </article>
    `).join("") : `<p class="muted">Queue is empty.</p>`;

    $("blacklist").innerHTML = blacklist.length ? blacklist.map(b => `
      <div class="black-item">
        <span>${b.username ? "User: " + esc(b.username) : "Song #" + b.songId}</span>
        <small>${esc(b.reason)}</small>
        <button onclick="removeBlacklist(${b.id})">Remove</button>
      </div>
    `).join("") : `<p class="muted">Nothing blacklisted.</p>`;

    // Apply settings (if present) to UI
    try {
      const chatRequestsEnabled = $('chatRequestsEnabled');
      const chatRequestsRequireFollowers = $('chatRequestsRequireFollowers');
      const chatRequestsRequireSubscribers = $('chatRequestsRequireSubscribers');
      const chatRequestsRequireModerators = $('chatRequestsRequireModerators');
      if (typeof settings !== 'undefined') {
        const prioritizeElLocal = $('prioritizeViewerRequests');
        if (prioritizeElLocal) prioritizeElLocal.checked = !!(settings && settings.prioritizeViewerRequests);
        if (chatRequestsEnabled) chatRequestsEnabled.checked = !!(settings && settings.chatRequestsEnabled);
        if (chatRequestsRequireFollowers) chatRequestsRequireFollowers.checked = !!(settings && settings.chatRequestsRequireFollowers);
        if (chatRequestsRequireSubscribers) chatRequestsRequireSubscribers.checked = !!(settings && settings.chatRequestsRequireSubscribers);
        if (chatRequestsRequireModerators) chatRequestsRequireModerators.checked = !!(settings && settings.chatRequestsRequireModerators);
        const moderatorEnabled = $('moderatorEnabled');
        const moderatorUsername = $('moderatorUsername');
        if (moderatorEnabled) moderatorEnabled.checked = !!(settings && settings.moderatorEnabled);
        if (moderatorUsername && document.activeElement !== moderatorUsername) moderatorUsername.value = settings && settings.moderatorUsername || '';
      }

      const allowChat = !!(chatRequestsEnabled && chatRequestsEnabled.checked);
      if (chatRequestsRequireFollowers) chatRequestsRequireFollowers.disabled = !allowChat;
      if (chatRequestsRequireSubscribers) chatRequestsRequireSubscribers.disabled = !allowChat;
      if (chatRequestsRequireModerators) chatRequestsRequireModerators.disabled = !allowChat;
    } catch (e) { /* ignore */ }

  } catch (e) {
    toast(e.message);
  }
}

async function saveControlSettings(patch) {
  try {
    const current = await api('/api/control/settings');
    const next = { ...current, ...patch };
    await api('/api/control/settings', { method: 'POST', body: JSON.stringify(next) });
    toast('Settings saved');
    render();
  } catch (err) {
    toast(err.message);
  }
}

// Wire up settings UI: toggle to prioritize viewer requests above streamer requests
const prioritizeEl = $('prioritizeViewerRequests');
if (prioritizeEl) {
  prioritizeEl.addEventListener('change', () => saveControlSettings({ prioritizeViewerRequests: prioritizeEl.checked }));
}

const chatRequestsEnabledEl = $('chatRequestsEnabled');
if (chatRequestsEnabledEl) {
  chatRequestsEnabledEl.addEventListener('change', () => saveControlSettings({ chatRequestsEnabled: chatRequestsEnabledEl.checked }));
}

const chatRequestsRequireFollowersEl = $('chatRequestsRequireFollowers');
if (chatRequestsRequireFollowersEl) {
  chatRequestsRequireFollowersEl.addEventListener('change', () => saveControlSettings({ chatRequestsRequireFollowers: chatRequestsRequireFollowersEl.checked }));
}

const chatRequestsRequireSubscribersEl = $('chatRequestsRequireSubscribers');
if (chatRequestsRequireSubscribersEl) {
  chatRequestsRequireSubscribersEl.addEventListener('change', () => saveControlSettings({ chatRequestsRequireSubscribers: chatRequestsRequireSubscribersEl.checked }));
}

const chatRequestsRequireModeratorsEl = $('chatRequestsRequireModerators');
if (chatRequestsRequireModeratorsEl) {
  chatRequestsRequireModeratorsEl.addEventListener('change', () => saveControlSettings({ chatRequestsRequireModerators: chatRequestsRequireModeratorsEl.checked }));
}

const moderatorEnabledEl = $('moderatorEnabled');
const moderatorUsernameEl = $('moderatorUsername');
const moderatorPasswordEl = $('moderatorPassword');
if (moderatorEnabledEl) {
  moderatorEnabledEl.addEventListener('change', () => saveControlSettings({
    moderatorEnabled: moderatorEnabledEl.checked,
    moderatorUsername: moderatorUsernameEl.value.trim(),
    moderatorPassword: moderatorPasswordEl.value
  }).then(() => { moderatorPasswordEl.value = ''; }));
}
if (moderatorUsernameEl) {
  moderatorUsernameEl.addEventListener('change', () => saveControlSettings({ moderatorUsername: moderatorUsernameEl.value.trim() }));
}
if (moderatorPasswordEl) {
  moderatorPasswordEl.addEventListener('change', () => {
    if (!moderatorPasswordEl.value) return;
    saveControlSettings({ moderatorPassword: moderatorPasswordEl.value }).then(() => { moderatorPasswordEl.value = ''; });
  });
}

window.play = async id => { try { await api(`/api/queue/${id}/play`, {method:"POST"}); toast("Playing request."); render(); } catch(e){toast(e.message)} };
window.complete = async id => { try { await api(`/api/queue/${id}/complete`, {method:"POST"}); toast("Marked complete."); render(); } catch(e){toast(e.message)} };
window.skip = async id => { try { await api(`/api/queue/${id}/skip`, {method:"POST"}); toast("Skipped."); render(); } catch(e){toast(e.message)} };
const movingRequests = new Set();
window.move = async (id,direction) => {
  if (movingRequests.has(id)) return;
  movingRequests.add(id);
  try {
    await api(`/api/queue/${id}/move`, {method:"POST",body:JSON.stringify({direction})});
    await render();
  } catch(e){toast(e.message)}
  finally { movingRequests.delete(id); }
};
window.blackSong = async songId => { try { await api("/api/blacklist/song",{method:"POST",body:JSON.stringify({songId})}); toast("Song blacklisted."); render(); } catch(e){toast(e.message)} };
window.blackUser = async username => {
  try { await api("/api/blacklist/user",{method:"POST",body:JSON.stringify({username})}); toast("User blacklisted."); render(); }
  catch(e){toast(e.message)}
};
window.removeBlacklist = async id => { try { await api(`/api/blacklist/${id}`,{method:"DELETE"}); render(); } catch(e){toast(e.message)} };

$("next").onclick = async () => {
  try { await api("/api/queue/next",{method:"POST"}); toast("Moved next request to Now Playing."); render(); }
  catch(e){toast(e.message)}
};

$("clear").onclick = async () => {
  if (!confirm("Skip every queued request?")) return;
  try { await api("/api/queue/clear",{method:"POST"}); toast("Queue cleared."); render(); }
  catch(e){toast(e.message)}
};

$("rescan").onclick = async () => {
  try { const r = await api("/api/rescan",{method:"POST"}); toast(`Scanned ${r.songs} songs.`); render(); }
  catch(e){toast(e.message)}
};

$("addUser").onclick = () => blackUser($("blackUser").value.trim());
$("refresh").onclick = render;

$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadSongs(1), 180);
});

$("reset-search").addEventListener("click", () => {
  clearTimeout(searchTimer);
  $("search").value = "";
  ['filter-pack','filter-genre','filter-style','filter-difficulty','filter-meter-min','filter-meter-max','sort-field','sort-order']
    .forEach(id => { $(id).selectedIndex = 0; });
  loadSongs(1);
});

['filter-pack','filter-genre','filter-style','filter-difficulty','filter-meter-min','filter-meter-max','sort-field','sort-order','per-page'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('change', () => loadSongs(1));
});

['search-prev', 'search-prev-bottom'].forEach(id => {
  $(id).addEventListener('click', () => { if (searchPage > 1) loadSongs(searchPage - 1); });
});
['search-next', 'search-next-bottom'].forEach(id => {
  $(id).addEventListener('click', () => { if (searchPage < searchTotalPages) loadSongs(searchPage + 1); });
});

async function renderTwitch() {
  try {
    const status = await api('/api/twitch/status');
    if (status.configured) {
      $("twitchStatus").textContent = (status.connected ? `Connected as ${status.username} to #${status.channel}` : `Configured for ${status.clientId}${status.username ? ' (' + status.username + ')' : ''}`);
    } else {
      $("twitchStatus").textContent = 'Not connected';
    }
  } catch (e) {
    $("twitchStatus").textContent = 'Twitch status unavailable';
  }
}

$("checkTwitch").onclick = async () => { try { await renderTwitch(); toast('Checked Twitch status.'); } catch(e){toast(e.message)} };

$("connectTwitch").onclick = async () => {
  const clientId = $("twitchClientId").value.trim();
  const clientSecret = $("twitchClientSecret").value.trim();
  const channel = $("twitchChannel").value.trim();
  if (!clientId || !clientSecret) { toast('Client ID and secret required'); return; }
  try {
    // store the secret in sessionStorage temporarily so the callback can complete the exchange
    sessionStorage.setItem('twitch_clientId', clientId);
    sessionStorage.setItem('twitch_clientSecret', clientSecret);
    if (channel) sessionStorage.setItem('twitch_channel', channel);
    const redirectUri = `${location.origin}/twitch-callback.html`;
    const r = await api('/api/twitch/start-auth', { method: 'POST', body: JSON.stringify({ clientId, redirectUri, scopes: 'chat:read chat:edit' }) });
    if (r && r.url) window.location = r.url;
  } catch (e) { toast(e.message); }
};

$("disconnectTwitch").onclick = async () => {
  if (!confirm('Disconnect the Twitch bot and remove stored credentials?')) return;
  try { await api('/api/twitch/disconnect', { method: 'POST' }); toast('Disconnected.'); render(); renderTwitch(); }
  catch(e){toast(e.message)}
};

getFilters();
loadSongs(1);
render();
renderTwitch();
setInterval(render, 2500);
setInterval(renderTwitch, 5000);
