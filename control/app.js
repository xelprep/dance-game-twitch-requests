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

async function render() {
  try {
    const [stats, now, queue, blacklist] = await Promise.all([
      api("/api/stats"), api("/api/now-playing"),
      api("/api/queue"), api("/api/blacklist")
    ]);

    $("stats").textContent =
      `${stats.songs.toLocaleString()} songs • ${stats.queued} queued • ${stats.playing} playing`;

    $("now").innerHTML = now ? `
      <div class="now-card">
        <div>
          <strong>${esc(now.title)}</strong>
          <span>${esc(now.artist)}${now.pack ? " • " + esc(now.pack) : ""}</span>
          <small>requested by ${esc(now.requested_display)}</small>
        </div>
        <button onclick="complete(${now.id})">Complete</button>
      </div>` : "Nothing playing.";

    $("queue").innerHTML = queue.length ? queue.map((r, i) => `
      <article class="request">
        <div class="rank">${i + 1}</div>
        <div class="info">
          <strong>${esc(r.title)}</strong>
          <span>${esc(r.artist)}${r.pack ? " • " + esc(r.pack) : ""}</span>
          <small>requested by ${esc(r.requested_display)}</small>
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
  } catch (e) {
    toast(e.message);
  }
}

window.play = async id => { try { await api(`/api/queue/${id}/play`, {method:"POST"}); toast("Playing request."); render(); } catch(e){toast(e.message)} };
window.complete = async id => { try { await api(`/api/queue/${id}/complete`, {method:"POST"}); toast("Marked complete."); render(); } catch(e){toast(e.message)} };
window.skip = async id => { try { await api(`/api/queue/${id}/skip`, {method:"POST"}); toast("Skipped."); render(); } catch(e){toast(e.message)} };
window.move = async (id,direction) => { try { await api(`/api/queue/${id}/move`, {method:"POST",body:JSON.stringify({direction})}); render(); } catch(e){toast(e.message)} };
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

render();
renderTwitch();
setInterval(render, 2500);
setInterval(renderTwitch, 5000);
