// Overlay script: listens for server-sent events with the queue and updates the multi-line display.
const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatNowPlaying(song) {
  if (!song) return "";
  const title = escapeHtml(song.title || "(unknown)");
  const subtitle = escapeHtml((song.subtitle || "").replace(/^\(+|\)+$/g, ""));
  const artist = escapeHtml(song.artist || "(unknown artist)");
  const pack = escapeHtml(song.pack || "Unknown Pack");
  const requester = escapeHtml(song.requested_display || song.requested_by || "unknown");
  const titleLine = subtitle ? `${title} (${subtitle})` : title;
  return `
    <div class="queue-lines">
      <div class="queue-line queue-line-title">${titleLine}</div>
      <div class="queue-line queue-line-artist">${artist}</div>
      <div class="queue-line queue-line-pack">${pack}</div>
      <div class="queue-line queue-line-requester">Requested by: @${requester}</div>
    </div>
  `;
}

function formatQueue(queue) {
  if (!queue || !queue.length) {
    return `
      <div class="queue-empty-state">
        <div class="queue-empty-row"></div>
        <div class="queue-empty-row"></div>
        <div class="queue-empty-row queue-empty-row--message">No songs in request queue - Try requesting one in chat (!queue, !search, !requestid)</div>
      </div>
    `;
  }

  // Show at most top 3 entries and optionally a "+ N more" column.
  const visible = queue.slice(0, 3);
  const remaining = queue.length > 3 ? queue.length - 3 : 0;

  return `
    <div class="queue-stack">
      ${visible
        .map((r, index) => {
          const title = escapeHtml(r.title || "(unknown)");
          const subtitle = escapeHtml((r.subtitle || "").replace(/^\(+|\)+$/g, ""));
          const artist = escapeHtml(r.artist || "(unknown artist)");
          const pack = escapeHtml(r.pack || "Unknown Pack");
          const requester = escapeHtml(r.requested_display || r.requested_by || "unknown");
          const titleLine = subtitle ? `${title} (${subtitle})` : `${title}`;
          const entryClass =
            index === 0
              ? "queue-entry queue-entry--primary"
              : index === 1
                ? "queue-entry queue-entry--secondary"
                : "queue-entry queue-entry--tertiary";

          return `
          <div class="${entryClass}">
            <div class="queue-lines">
              <div class="queue-line queue-line-title">${titleLine}</div>
              <div class="queue-line queue-line-artist">${artist}</div>
              <div class="queue-line queue-line-pack">${pack}</div>
              <div class="queue-line queue-line-requester">Requested by: @${requester}</div>
            </div>
            ${index < visible.length - 1 ? '<div class="queue-divider" aria-hidden="true"></div>' : ""}
          </div>
        `;
        })
        .join("")}

      ${
        remaining > 0
          ? `
        <div class="queue-divider" aria-hidden="true"></div>
        <div class="queue-entry queue-entry--more">
          <div class="queue-lines">
            <div class="queue-line">&nbsp;</div>
            <div class="queue-line queue-line-more">+ ${remaining} more</div>
            <div class="queue-line">&nbsp;</div>
            <div class="queue-line">&nbsp;</div>
          </div>
        </div>
      `
          : ""
      }
    </div>
  `;
}

function updateQueue(queue) {
  const msgEl = $("message");
  const msg = formatQueue(queue);
  msgEl.innerHTML = msg;
  msgEl.classList.remove("queue-animate");
  void msgEl.offsetWidth;
  msgEl.classList.add("queue-animate");
}

function updateNowPlaying(data) {
  const npEl = $("now-playing");
  const npSection = $("now-playing-section");
  const divider = $("section-divider");
  if (data) {
    npSection.style.display = "flex";
    divider.style.display = "block";
    npEl.innerHTML = formatNowPlaying(data);
  } else {
    npSection.style.display = "none";
    divider.style.display = "none";
  }
}

function updateUpcomingLabel(tempModDisplayName) {
  const label = document.querySelector(".upcoming-label");
  if (!label) return;

  const defaultText = "Upcoming Requests:";
  if (!tempModDisplayName) {
    label.textContent = defaultText;
    return;
  }

  label.textContent = `@${String(tempModDisplayName)} is in charge of the queue! Upcoming Requests:`;
}

function updateOverlay(nowPlaying, queue) {
  updateNowPlaying(nowPlaying);
  updateQueue(queue);
}

async function pollTempModStatus() {
  try {
    const resp = await fetch("/api/overlay/temp-mod-status");
    if (!resp.ok) throw new Error("Failed");
    const data = await resp.json();
    updateUpcomingLabel(data && data.displayName ? data.displayName : null);
  } catch (e) {
    updateUpcomingLabel(null);
  }
}

// Try EventSource first; fall back to polling if not available.
function startSSE() {
  try {
    const s = new EventSource("/overlay/queue/stream");
    s.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        const queue = Array.isArray(data)
          ? data
          : data && Array.isArray(data.queue)
            ? data.queue
            : null;
        const nowPlaying = data && "nowPlaying" in data ? data.nowPlaying : null;
        const tempModDisplayName =
          data && "tempModDisplayName" in data ? data.tempModDisplayName : null;

        if (queue) {
          updateQueue(queue);
        }
        updateNowPlaying(nowPlaying);
        updateUpcomingLabel(tempModDisplayName);
      } catch (e) {
        console.error("Failed to parse SSE data", e);
      }
    });
    s.addEventListener("error", (e) => {
      // On error, EventSource will retry automatically. If closed, fallback to polling.
      console.warn("SSE error", e);
    });
    return true;
  } catch (e) {
    console.warn("SSE unavailable, falling back to polling", e);
    return false;
  }
}

async function poll() {
  try {
    const [queueResp, nowPlayingResp] = await Promise.all([
      fetch("/api/queue"),
      fetch("/api/now-playing"),
    ]);

    if (!queueResp.ok) throw new Error("Queue fetch failed");
    if (!nowPlayingResp.ok) throw new Error("Now-playing fetch failed");

    const queue = await queueResp.json();
    const nowPlaying = await nowPlayingResp.json();
    updateQueue(queue);
    updateNowPlaying(nowPlaying);
    await pollTempModStatus();
  } catch (e) {
    /* ignore polling errors */
  }
}

updateUpcomingLabel(null);
pollTempModStatus();

if (!startSSE()) {
  poll();
  setInterval(poll, 1000);
}
