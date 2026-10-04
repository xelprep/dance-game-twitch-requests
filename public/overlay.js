// Overlay script: listens for server-sent events with the queue and updates the multi-line display.
const $ = (id) => document.getElementById(id);
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
const isPreview = new URLSearchParams(window.location.search).get("preview") === "1";
let previewParentOrigin = "";
try {
  previewParentOrigin = document.referrer ? new URL(document.referrer).origin : "";
} catch (_error) {
  previewParentOrigin = "";
}
let showSampleData = false;
let showSafeArea = false;
let liveQueue = [];
let liveNowPlaying = null;
let activeOverlayStyle = DEFAULT_OVERLAY_STYLE;

function normalizeOverlayStyle(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const boundedNumber = (key, fallback, min, max, integer = false) => {
    const parsed = Number(input[key]);
    if (!Number.isFinite(parsed)) return fallback;
    const bounded = Math.min(max, Math.max(min, parsed));
    return integer ? Math.round(bounded) : Math.round(bounded * 100) / 100;
  };
  const color = (key, fallback) =>
    typeof input[key] === "string" && /^#[0-9a-f]{6}$/i.test(input[key])
      ? input[key].toLowerCase()
      : fallback;
  const boolean = (key, fallback) => (typeof input[key] === "boolean" ? input[key] : fallback);
  const positions = [
    "top-left",
    "top-center",
    "top-right",
    "middle-left",
    "middle-center",
    "middle-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
  ];
  const sectionDefaults = DEFAULT_OVERLAY_STYLE.sections;
  const sections = {};
  for (const name of Object.keys(sectionDefaults)) {
    const section =
      input.sections && typeof input.sections === "object" ? input.sections[name] || {} : {};
    sections[name] = {
      color: colorValue(section.color, sectionDefaults[name].color),
      fontSize: boundedValue(section.fontSize, sectionDefaults[name].fontSize, 16, 128, true),
    };
  }

  function colorValue(value, fallback) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
      ? value.toLowerCase()
      : fallback;
  }
  function boundedValue(value, fallback, min, max, integer = false) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const bounded = Math.min(max, Math.max(min, parsed));
    return integer ? Math.round(bounded) : Math.round(bounded * 100) / 100;
  }

  return {
    ...DEFAULT_OVERLAY_STYLE,
    font: ["default", "barlow", "oswald", "lora", "space-grotesk", "ibm-plex-mono"].includes(
      input.font,
    )
      ? input.font
      : "default",
    fontSize: boundedNumber("fontSize", 48, 16, 128, true),
    textColor: color("textColor", "#ffffff"),
    textShadow: boolean("textShadow", true),
    shadowStrength: boundedNumber("shadowStrength", 1, 0, 2),
    backgroundEnabled: boolean("backgroundEnabled", false),
    backgroundColor: color("backgroundColor", "#000000"),
    backgroundOpacity: boundedNumber("backgroundOpacity", 0.6, 0, 1),
    maxWidth:
      input.maxWidth === undefined || input.maxWidth === "auto"
        ? DEFAULT_OVERLAY_STYLE.maxWidth
        : boundedNumber("maxWidth", 1920, 320, 3840, true),
    padding: boundedNumber("padding", 0, 0, 48, true),
    position: positions.includes(input.position) ? input.position : "bottom-left",
    margin: boundedNumber("margin", 0, 0, 120, true),
    contentOpacity: boundedNumber("contentOpacity", 1, 0.1, 1),
    safeArea: boundedNumber("safeArea", 5, 2, 15, true),
    canvasWidth: [1080, 1280, 1920, 2560, 3840].includes(Number(input.canvasWidth))
      ? Number(input.canvasWidth)
      : 1920,
    canvasHeight: [720, 1080, 1440, 1920, 2160].includes(Number(input.canvasHeight))
      ? Number(input.canvasHeight)
      : 1080,
    queueEntries: boundedNumber("queueEntries", 3, 1, 3, true),
    sections,
    showLabels: boolean("showLabels", true),
    showNowPlaying: boolean("showNowPlaying", true),
    showArtwork: boolean("showArtwork", true),
  };
}

function applyOverlayStyle(value) {
  const style = normalizeOverlayStyle(value);
  activeOverlayStyle = style;
  const overlay = $("overlay");
  const root = document.documentElement;
  const textShadow = style.textShadow
    ? `0 0 6px rgba(0, 0, 0, ${Math.min(1, 0.9 * style.shadowStrength)}), 0 1px 0 rgba(0, 0, 0, ${Math.min(1, 0.6 * style.shadowStrength)})`
    : "none";
  const [red, green, blue] = style.backgroundColor
    .match(/[\da-f]{2}/gi)
    .map((part) => parseInt(part, 16));
  const background = style.backgroundEnabled
    ? `rgba(${red}, ${green}, ${blue}, ${style.backgroundOpacity})`
    : "transparent";
  const maxWidth = style.maxWidth === "auto" ? "100%" : `${style.maxWidth}px`;
  const fontFamilies = {
    default: 'Inter, "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", system-ui, sans-serif',
    barlow: '"Barlow Condensed", Inter, "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", sans-serif',
    oswald: 'Oswald, Inter, "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", sans-serif',
    lora: 'Lora, Inter, "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", serif',
    "space-grotesk":
      '"Space Grotesk", Inter, "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", sans-serif',
    "ibm-plex-mono":
      '"IBM Plex Mono", Inter, "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", monospace',
  };
  const fontFamily = `${fontFamilies[style.font]}, "Noto Color Emoji"`;

  root.style.setProperty("--overlay-font-family", fontFamily);
  root.style.setProperty("--overlay-font-size", `${style.fontSize}px`);
  root.style.setProperty("--overlay-text-color", style.textColor);
  root.style.setProperty("--overlay-text-shadow", textShadow);
  root.style.setProperty("--overlay-content-opacity", style.contentOpacity);
  root.style.setProperty("--overlay-background", background);
  root.style.setProperty("--overlay-padding", `${style.padding}px`);
  root.style.setProperty("--overlay-margin", `${style.margin}px`);
  root.style.setProperty("--overlay-max-width", maxWidth);
  root.style.setProperty("--overlay-safe-area", `${style.safeArea}%`);
  for (const [name, section] of Object.entries(style.sections)) {
    root.style.setProperty(`--overlay-${name}-color`, section.color);
    root.style.setProperty(`--overlay-${name}-size`, `${section.fontSize}px`);
  }
  overlay.dataset.position = style.position;
  overlay.classList.toggle("compact-queue", style.queueEntries < 3);
  overlay.classList.toggle("hide-labels", !style.showLabels);
  overlay.classList.toggle("hide-now-playing", !style.showNowPlaying);
  overlay.classList.toggle("hide-artwork", !style.showArtwork);
  const guide = $("preview-safe-area");
  if (guide) guide.hidden = !isPreview || !showSafeArea;
  renderOverlayData();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(fitQueueEntries);
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function styleLabel(chartType) {
  if (chartType === "dance-single") return "Single";
  if (chartType === "dance-double") return "Double";
  return chartType || "";
}

function chartText(chart) {
  return [styleLabel(chart.chartType), chart.difficulty, chart.meter].filter(Boolean).join(" ");
}

// One line with the requested chart details (style, difficulty, meter), or "" when
// the request predates chart-level requests.
function chartLine(chart) {
  const text = chart ? chartText(chart) : "";
  return text ? `<div class="queue-line queue-line-chart">${escapeHtml(text)}</div>` : "";
}

function formatNowPlaying(song) {
  if (!song) return "";
  const title = escapeHtml(song.title || "(unknown)");
  const subtitle = escapeHtml((song.subtitle || "").replace(/^\(+|\)+$/g, ""));
  const artist = escapeHtml(song.artist || "(unknown artist)");
  const pack = escapeHtml(song.pack || "Unknown Pack");
  const requester = escapeHtml(song.requested_display || song.requested_by || "unknown");
  const titleLine = subtitle ? `${title} (${subtitle})` : title;
  const artwork = song.artworkUrl
    ? `<img class="now-playing-artwork" src="${escapeHtml(song.artworkUrl)}" alt="${title} artwork" />`
    : "";
  return `
    <div class="now-playing-content">
      ${artwork}
      <div class="queue-lines">
        <div class="queue-line queue-line-title">${titleLine}</div>
        <div class="queue-line queue-line-artist">${artist}</div>
        ${chartLine(song.chart)}
        <div class="queue-line queue-line-pack">${pack}</div>
        <div class="queue-line queue-line-requester">Requested by: @${requester}</div>
      </div>
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
  const visible = queue.slice(0, activeOverlayStyle.queueEntries);
  const remaining = queue.length > visible.length ? queue.length - visible.length : 0;

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
              ${chartLine(r.chart)}
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

function fitQueueEntries() {
  const entries = document.querySelectorAll("#message .queue-entry:not(.queue-entry--more)");
  entries.forEach((entry) => {
    const linesEl = entry.querySelector(".queue-lines");
    const requesterEl = entry.querySelector(".queue-line-requester");
    if (!linesEl || !requesterEl) return;

    linesEl.style.width = "auto";
    linesEl.style.minWidth = "0px";
    linesEl.style.maxWidth = "none";
    requesterEl.style.width = "max-content";
    requesterEl.style.maxWidth = "none";

    let width = 0;
    try {
      const range = document.createRange();
      range.selectNodeContents(requesterEl);
      width = Math.ceil(range.getBoundingClientRect().width);
    } catch (e) {
      width = Math.ceil(requesterEl.scrollWidth);
    }

    if (width > 0) {
      linesEl.style.width = `${width}px`;
      linesEl.style.minWidth = `${width}px`;
      linesEl.style.maxWidth = `${width}px`;
    }
    requesterEl.style.width = "";
    requesterEl.style.maxWidth = "";
  });
}

function updateQueue(queue) {
  const msgEl = $("message");
  const msg = formatQueue(queue);
  msgEl.innerHTML = msg;
  fitQueueEntries();
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

const sampleNowPlaying = {
  title: "Neon Skyline",
  subtitle: "After Hours Mix",
  artist: "Mira Nova",
  pack: "City Lights",
  requested_display: "DJ Example",
  chart: { chartType: "dance-single", difficulty: "Expert", meter: "14" },
};
const sampleQueue = [
  {
    title: "Pulse Driver",
    artist: "Kinetic Form",
    pack: "Arcade Classics",
    requested_display: "StepFan42",
    chart: { chartType: "dance-single", difficulty: "Challenge", meter: "16" },
  },
  {
    title: "Paper Satellites",
    artist: "The Northbound",
    pack: "Blue Shift Phase 2",
    requested_display: "mika_moves",
    chart: { chartType: "dance-double", difficulty: "Expert", meter: "13" },
  },
  {
    title: "Midnight Circuit",
    artist: "Aster & Co.",
    pack: "High Chance of Tech",
    requested_display: "turntable_lee",
    chart: { chartType: "dance-single", difficulty: "Hard", meter: "10" },
  },
];

function renderOverlayData() {
  updateNowPlaying(showSampleData ? sampleNowPlaying : liveNowPlaying);
  updateQueue(showSampleData ? sampleQueue : liveQueue);
}

window.addEventListener("message", (event) => {
  if (
    !isPreview ||
    event.source !== window.parent ||
    (previewParentOrigin && event.origin !== previewParentOrigin) ||
    !event.data
  )
    return;
  if (event.data.type === "overlay-style-preview" && event.data.version === 1) {
    applyOverlayStyle(event.data.style);
  } else if (event.data.type === "overlay-sample-preview" && event.data.version === 1) {
    showSampleData = !!event.data.enabled;
    renderOverlayData();
  } else if (event.data.type === "overlay-safe-area-preview" && event.data.version === 1) {
    showSafeArea = !!event.data.enabled;
    const guide = $("preview-safe-area");
    if (guide) guide.hidden = !showSafeArea;
  }
});

if (isPreview && window.parent !== window) {
  window.parent.postMessage(
    { type: "overlay-preview-ready", version: 1 },
    previewParentOrigin || "*",
  );
}

async function refreshOverlayStyle() {
  try {
    const response = await fetch("/api/overlay/settings", { cache: "no-store" });
    if (!response.ok) throw new Error("Overlay settings unavailable");
    applyOverlayStyle(await response.json());
  } catch (error) {
    if (!isPreview) console.warn("Could not load overlay appearance settings", error);
  }
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
          liveQueue = queue;
        }
        liveNowPlaying = nowPlaying;
        renderOverlayData();
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
    liveQueue = queue;
    liveNowPlaying = nowPlaying;
    renderOverlayData();
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

window.addEventListener("resize", fitQueueEntries);
if (!isPreview) {
  try {
    const stream = new EventSource("/overlay/style/stream");
    stream.addEventListener("message", (event) => {
      try {
        applyOverlayStyle(JSON.parse(event.data));
      } catch (_error) {
        console.warn("Could not parse overlay appearance update");
      }
    });
    stream.addEventListener("error", () => {
      stream.close();
      refreshOverlayStyle();
      setInterval(refreshOverlayStyle, 15000);
    });
  } catch (_error) {
    refreshOverlayStyle();
    setInterval(refreshOverlayStyle, 15000);
  }
}
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(fitQueueEntries);
}
