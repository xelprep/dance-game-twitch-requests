// Chat overlay: mirrors the Twitch channel chat for OBS via SSE.
// Every message from the channel is shown (no filtering), newest at the
// bottom, with older messages fading out.
const MAX_MESSAGES = 10;
const MIN_OPACITY = 0.35;
// Usernames with very dark Twitch chat colors disappear on dark stream
// backgrounds. Colors lighter than this HSL lightness pass through
// unchanged; darker ones are lifted to this lightness with hue and
// saturation preserved.
const MIN_LIGHTNESS = 0.4;

const chatEl = document.getElementById("chat");

function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l };
}

function hslToHex(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (v) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Returns a CSS color guaranteed to be legible on dark backgrounds, or null
// when the input is not a valid hex color (the CSS fallback applies).
function legibleColor(hex) {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;
  if (hsl.l >= MIN_LIGHTNESS) return String(hex).trim();
  return hslToHex(hsl.h, hsl.s, MIN_LIGHTNESS);
}

function refreshOpacities() {
  const lines = chatEl.children;
  const count = lines.length;
  for (let i = 0; i < count; i++) {
    // Newest line (last child) is fully opaque; older lines fade toward MIN_OPACITY.
    const ageFromNewest = count - 1 - i;
    const fade = count > 1 ? ageFromNewest / (count - 1) : 0;
    lines[i].style.opacity = String(Math.max(MIN_OPACITY, 1 - fade * (1 - MIN_OPACITY)));
  }
}

function addMessage(entry) {
  const line = document.createElement("div");
  line.className = "chat-line";

  const user = document.createElement("span");
  user.className = "chat-user";
  user.textContent = `@${entry.username || "unknown"}: `;
  const color = legibleColor(entry.color);
  if (color) user.style.color = color;

  const text = document.createElement("span");
  text.className = "chat-text";
  text.textContent = entry.message || "";

  line.appendChild(user);
  line.appendChild(text);
  chatEl.appendChild(line);

  while (chatEl.children.length > MAX_MESSAGES) {
    chatEl.removeChild(chatEl.firstChild);
  }
  refreshOpacities();
}

function startSSE() {
  const s = new EventSource("/overlay/chat/stream");
  s.addEventListener("message", (ev) => {
    try {
      addMessage(JSON.parse(ev.data));
    } catch (e) {
      console.error("Failed to parse chat SSE data", e);
    }
  });
  s.addEventListener("error", (e) => {
    // EventSource retries automatically.
    console.warn("Chat SSE error", e);
  });
}

startSSE();
