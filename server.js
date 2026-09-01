require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");
const Database = require("better-sqlite3");
const selfsigned = require("selfsigned");
const tmi = require("tmi.js");
const WebSocket = require("ws");
const { parseSecureMode, applySecureModeDefaults } = require("./secureMode");
const { scanSongs } = require("./scanner");

const PORT = Number(process.env.PORT || 3000);
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";
const CONTROL_HOST = process.env.CONTROL_HOST || "0.0.0.0";
const SONGS_DIR = path.resolve(process.env.SONGS_DIR || "./Songs");
const PREFIX = process.env.BOT_PREFIX || "!";
const SEARCH_COMMAND = (process.env.SEARCH_COMMAND || "search").toLowerCase();
const REQUEST_ID_COMMAND = (process.env.REQUEST_ID_COMMAND || "requestid").toLowerCase();
const MAX_REQUESTS_PER_USER = Number(process.env.MAX_REQUESTS_PER_USER || 2);
const QUEUE_LIMIT = Number(process.env.QUEUE_LIMIT || 25);
const TWITCH_MAX_MESSAGE_LENGTH = 500;
const HELP_COOLDOWN_MS = 30 * 1000;
const ALLOW_WEB_REQUESTS = String(process.env.ALLOW_WEB_REQUESTS).toLowerCase() === "true";
const SECURE_MODE = parseSecureMode(process.env.SECURE_MODE);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim();
// Streamer vanity name shown when adding requests from the control panel. Defaults to "Streamer".
const STREAMER_VANITY_NAME = String(process.env.STREAMER_VANITY_NAME || "Streamer").slice(0, 50);
const DEFAULT_INSTRUCTIONS_MINUTES = 10;

// Legacy env support: if a value is set in .env it acts as the startup default value.
// The runtime value can be overridden via the control panel and stored in the settings DB.
const _INSTRUCTIONS_MINUTES_RAW = Object.prototype.hasOwnProperty.call(
  process.env,
  "INSTRUCTIONS_MINUTES",
)
  ? process.env.INSTRUCTIONS_MINUTES
  : undefined;

function parseInstructionsMinutes(rawValue) {
  if (typeof rawValue === "undefined") return DEFAULT_INSTRUCTIONS_MINUTES;
  if (rawValue === "") return 0;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : DEFAULT_INSTRUCTIONS_MINUTES;
}

function getRuntimeInstructionsMinutes() {
  const saved = getSetting("instructionsMinutes", null);
  if (saved !== null && saved !== undefined && saved !== "") {
    const value = Number(saved);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_INSTRUCTIONS_MINUTES;
  }
  return parseInstructionsMinutes(_INSTRUCTIONS_MINUTES_RAW);
}

const CONTROL_PASSWORD = String(process.env.CONTROL_PASSWORD || "").trim();

if (!CONTROL_PASSWORD || CONTROL_PASSWORD === "a-long-random-password") {
  console.error("\n==================================================================");
  console.error("ERROR: CONTROL_PASSWORD is not properly configured in your .env file.");
  console.error("The streamer control panel requires a secure, non-default password.");
  console.error("Please set CONTROL_PASSWORD to a secure random password in .env and restart.");
  console.error("Example in .env:");
  console.error("  CONTROL_PASSWORD=your-secure-custom-password-here");
  console.error("==================================================================\n");
  process.exit(1);
}

const CONTROL_TLS_DIR = path.resolve("./data/control-panel");
const CONTROL_TLS_KEY_PATH = path.join(CONTROL_TLS_DIR, "key.pem");
const CONTROL_TLS_CERT_PATH = path.join(CONTROL_TLS_DIR, "cert.pem");

fs.mkdirSync(path.resolve("./data"), { recursive: true });

async function getControlTlsOptions() {
  fs.mkdirSync(CONTROL_TLS_DIR, { recursive: true });
  if (fs.existsSync(CONTROL_TLS_KEY_PATH) && fs.existsSync(CONTROL_TLS_CERT_PATH)) {
    return {
      key: fs.readFileSync(CONTROL_TLS_KEY_PATH, "utf8"),
      cert: fs.readFileSync(CONTROL_TLS_CERT_PATH, "utf8"),
    };
  }

  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    { type: 7, ip: "::1" },
    { type: 2, value: "0.0.0.0" },
    { type: 2, value: "127.0.0.1" },
  ];
  if (CONTROL_HOST && CONTROL_HOST !== "0.0.0.0") {
    const ipLike = /^\d+(?:\.\d+){3}$/.test(CONTROL_HOST);
    altNames.push(ipLike ? { type: 7, ip: CONTROL_HOST } : { type: 2, value: CONTROL_HOST });
  }
  if (HOST && HOST !== "0.0.0.0") {
    const ipLike = /^\d+(?:\.\d+){3}$/.test(HOST);
    altNames.push(ipLike ? { type: 7, ip: HOST } : { type: 2, value: HOST });
  }

  // selfsigned.generate may return the certificate synchronously or as a Promise (in newer versions).
  // Call it and await if it returns a Promise.
  const generated = selfsigned.generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256",
    keySize: 2048,
    days: 365,
    extensions: [{ name: "subjectAltName", altNames }],
  });

  const cert = generated && typeof generated.then === "function" ? await generated : generated;

  // Support different shapes that various versions of the library may return.
  const privateKey =
    cert && (cert.private || cert.privateKey || cert.key || cert.private_key || cert.pem);
  const certificate =
    cert && (cert.cert || cert.public || cert.certificate || cert.cert_pem || cert.pem);

  if (!privateKey || !certificate) {
    throw new Error("Failed to generate TLS certificate: unexpected selfsigned output");
  }

  fs.writeFileSync(CONTROL_TLS_KEY_PATH, privateKey);
  fs.writeFileSync(CONTROL_TLS_CERT_PATH, certificate);

  return { key: privateKey, cert: certificate };
}
const db = new Database(path.resolve("./data/songs.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  subtitle TEXT DEFAULT '',
  artist TEXT DEFAULT '',
  genre TEXT DEFAULT '',
  pack TEXT DEFAULT '',
  music TEXT DEFAULT '',
  last_modified INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS charts (
  id INTEGER PRIMARY KEY,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  chart_type TEXT DEFAULT '',
  difficulty TEXT DEFAULT '',
  meter TEXT DEFAULT '',
  radar TEXT DEFAULT '',
  UNIQUE(song_id, chart_type, difficulty, meter)
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  requested_display TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS blacklist (
  id INTEGER PRIMARY KEY,
  song_id INTEGER REFERENCES songs(id) ON DELETE CASCADE,
  username TEXT,
  reason TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(song_id, username)
);

CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title);
CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist);
CREATE INDEX IF NOT EXISTS idx_requests_status_created ON requests(status, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

function refreshDatabase() {
  console.log(`Scanning songs: ${SONGS_DIR}`);
  const result = scanSongs(SONGS_DIR, db);
  console.log(`Scan complete: ${result.songs} songs, ${result.charts} charts.`);
  return result;
}

const secureModeResult = applySecureModeDefaults(db, { secureMode: SECURE_MODE });
if (secureModeResult.secureMode) {
  console.warn(
    "SECURE_MODE is enabled: moderator access has been disabled and any stored moderator credentials were cleared for this startup.",
  );
}

const result = refreshDatabase();

if (result.songs === 0) {
  console.error(`
====================================================================
ERROR: No songs found in ${SONGS_DIR}
====================================================================

The application cannot start without a song library. Please check:

  1. SONGS_DIR is set correctly in your .env file.
     Current value: ${SONGS_DIR}
     Does this directory exist on your system?

  2. The directory contains subdirectories with .sm or .ssc files.
     The scanner looks for dance game SimFiles (.sm / .ssc) inside
     nested folders (pack > song).

  3. If you are using a Docker container, make sure your Songs
     directory is mounted as a volume.

Fix the path or add songs, then restart the application.
====================================================================
`);
  process.exit(1);
}

function transliterateLatin(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ß]/g, "ss")
    .replace(/[æ]/g, "ae")
    .replace(/[œ]/g, "oe")
    .replace(/[ø]/g, "o")
    .replace(/[ð]/g, "d")
    .replace(/[þ]/g, "th")
    .replace(/[ł]/g, "l")
    .replace(/[đ]/g, "d")
    .replace(/[ħ]/g, "h")
    .replace(/[ı]/g, "i")
    .replace(/[ĸ]/g, "k")
    .replace(/[ŋ]/g, "ng")
    .replace(/[ŧ]/g, "t")
    .replace(
      /[ÆŒØÞ]/g,
      (ch) =>
        ({
          Æ: "AE",
          Œ: "OE",
          Ø: "O",
          Þ: "TH",
        })[ch],
    )
    .replace(/[\u00A0]/g, " ");
}

function normalize(s) {
  return transliterateLatin(s)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

db.function("match_query", { deterministic: true }, (text, query) => {
  if (!query) return 1;
  const q = normalize(query);
  if (!q) return 1;
  return normalize(text).includes(q) ? 1 : 0;
});

function songMatchesQuery(song, query, allowedFields = ["title"]) {
  const q = normalize(query);
  if (!q) return true;

  const fieldsMap = {
    title: song.title || "",
    subtitle: song.subtitle || "",
    artist: song.artist || "",
    pack: song.pack || "",
  };

  const candidateFields = allowedFields
    .filter((field) => Object.prototype.hasOwnProperty.call(fieldsMap, field))
    .map((field) => normalize(fieldsMap[field] || ""));

  return candidateFields.some((field) => field.includes(q));
}

function getSongSearchRows(limit = 25, query = "") {
  const q = String(query || "").trim();
  const maxLimit = Math.max(1, limit);
  if (q) {
    return db
      .prepare(
        `SELECT * FROM songs WHERE match_query(title, @q) = 1 ORDER BY title COLLATE NOCASE LIMIT @limit`,
      )
      .all({ q, limit: maxLimit });
  }
  return db
    .prepare(`SELECT * FROM songs ORDER BY title COLLATE NOCASE LIMIT @limit`)
    .all({ limit: maxLimit });
}

function getQueue(limit = QUEUE_LIMIT) {
  const rows = db
    .prepare(
      `
    SELECT r.id, r.requested_by, r.requested_display, r.status, r.created_at,
           r.started_at, r.completed_at,
           s.id AS song_id, s.title, s.subtitle, s.artist, s.pack, s.music
    FROM requests r JOIN songs s ON s.id = r.song_id
    WHERE r.status = 'queued'
    ORDER BY r.created_at ASC, r.id ASC
    LIMIT ?
  `,
    )
    .all(limit);
  return rows.map((row) => ({ ...row, charts: getSongCharts(row.song_id) }));
}

function getNowPlaying() {
  const row = db
    .prepare(
      `
   SELECT r.id, r.requested_by, r.requested_display, r.status,
           r.started_at, s.id AS song_id, s.title, s.subtitle, s.artist, s.pack, s.music
    FROM requests r JOIN songs s ON s.id = r.song_id
    WHERE r.status = 'playing'
    ORDER BY r.started_at DESC LIMIT 1
  `,
    )
    .get();
  return row ? { ...row, charts: getSongCharts(row.song_id) } : null;
}

function getStats() {
  return {
    songs: db.prepare("SELECT COUNT(*) n FROM songs").get().n,
    charts: db.prepare("SELECT COUNT(*) n FROM charts").get().n,
    queued: db.prepare("SELECT COUNT(*) n FROM requests WHERE status='queued'").get().n,
    playing: db.prepare("SELECT COUNT(*) n FROM requests WHERE status='playing'").get().n,
  };
}

function isBlacklisted(songId, username) {
  return !!db
    .prepare(
      `
    SELECT id FROM blacklist
    WHERE (song_id = ? AND song_id IS NOT NULL)
       OR (username = ? AND username IS NOT NULL)
    LIMIT 1
  `,
    )
    .get(songId, username);
}

function canRequest(username) {
  const active = db
    .prepare(
      `
    SELECT COUNT(*) n FROM requests
    WHERE requested_by = ? AND status IN ('queued','playing')
  `,
    )
    .get(username).n;
  return active < MAX_REQUESTS_PER_USER;
}

// Settings helpers
function getSetting(key, defaultValue) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) return defaultValue;
    try {
      return JSON.parse(row.value);
    } catch (e) {
      return row.value;
    }
  } catch (e) {
    return defaultValue;
  }
}
function setSetting(key, value) {
  const val = typeof value === "string" ? value : JSON.stringify(value);
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)").run(key, val);
}

function getControlSettings() {
  // Migrate legacy boolean settings to the new single role setting
  const legacyFollowers = getSetting("chatRequestsRequireFollowers", false);
  const legacySubscribers = getSetting("chatRequestsRequireSubscribers", false);
  const legacyModerators = getSetting("chatRequestsRequireModerators", false);
  let role = getSetting("chatRequestsRequireRole", "");
  if (!role && (legacyFollowers || legacySubscribers || legacyModerators)) {
    // Migrate: highest priority wins
    if (legacyFollowers) role = "follower";
    else if (legacySubscribers) role = "subscriber";
    else if (legacyModerators) role = "moderator";
    // Persist the migrated value
    setSetting("chatRequestsRequireRole", role);
    // Clean up legacy keys
    const db2 = db;
    db2
      .prepare(
        "DELETE FROM settings WHERE key IN ('chatRequestsRequireFollowers','chatRequestsRequireSubscribers','chatRequestsRequireModerators')",
      )
      .run();
  }
  return {
    prioritizeViewerRequests: !!getSetting("prioritizeViewerRequests", true),
    chatRequestsEnabled: !!getSetting("chatRequestsEnabled", true),
    chatRequestsRequireRole: role,
    moderatorEnabled: !!getSetting("moderatorEnabled", false),
    moderatorUsername: String(getSetting("moderatorUsername", "")),
    moderatorPasswordConfigured: !!getSetting("moderatorPasswordHash", ""),
    instructionsMinutes: Number(getRuntimeInstructionsMinutes()),
  };
}

function hashModeratorPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyModeratorPassword(password, encoded) {
  const [saltHex, hashHex] = String(encoded || "").split(":");
  if (!saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_error) {
    return false;
  }
}

function verifyStreamerAuth(authHeader, expectedPassword) {
  if (!expectedPassword) return true;
  const match = String(authHeader || "").match(/^Basic\s+(.+)$/i);
  if (!match) return false;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    const expectedUserHash = crypto.createHash("sha256").update("streamer").digest();
    const actualUserHash = crypto.createHash("sha256").update(username).digest();
    const userMatch = crypto.timingSafeEqual(expectedUserHash, actualUserHash);

    const expectedPassHash = crypto.createHash("sha256").update(expectedPassword).digest();
    const actualPassHash = crypto.createHash("sha256").update(password).digest();
    const passMatch = crypto.timingSafeEqual(expectedPassHash, actualPassHash);

    return userMatch && passMatch;
  } catch (_error) {
    return false;
  }
}

// --- Temp moderator single-sign-on tokens (one-click auto-auth) ---
// A short-lived, server-signed token embedded in the link we whisper to a
// nominated user, so a single tap on their phone both opens the moderator page
// and authenticates them without a password dialog. The token is an HMAC-SHA256
// signed, URL-safe credential: base64url(payload) + "." + base64url(hmac).
// payload = { u: <temp mod login>, exp: <epoch ms> }.
const MODERATOR_TOKEN_SECRET = crypto.randomBytes(32);
const MODERATOR_TOKEN_TTL_MS = 60 * 60 * 1000; // hard cap; also bounded by the session

function createTempModeratorToken(username, expiresAtMs) {
  const exp = Number.isFinite(expiresAtMs)
    ? Number(expiresAtMs)
    : Date.now() + MODERATOR_TOKEN_TTL_MS;
  const payload = {
    u: String(username || "")
      .trim()
      .toLowerCase(),
    exp,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", MODERATOR_TOKEN_SECRET)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

// Returns the temp-mod login encoded in a valid, unexpired token, or null.
function verifyTempModeratorToken(token) {
  const raw = String(token || "").trim();
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expectedSig = crypto
    .createHmac("sha256", MODERATOR_TOKEN_SECRET)
    .update(payloadB64)
    .digest("base64url");
  let sigOk = false;
  try {
    const a = Buffer.from(sig, "base64url");
    const b = Buffer.from(expectedSig, "base64url");
    if (a.length === b.length) sigOk = crypto.timingSafeEqual(a, b);
  } catch (_error) {
    sigOk = false;
  }
  if (!sigOk) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch (_error) {
    return null;
  }
  if (!payload || typeof payload.u !== "string" || !payload.u) return null;
  if (Number.isFinite(payload.exp) && Date.now() > payload.exp) return null;
  return payload.u.toLowerCase();
}

// Pull a single-sign-on token from either a Bearer auth header (API calls) or a
// ?token= query parameter (top-level page navigation on mobile, where the
// browser cannot attach an auth header).
function extractModeratorToken(req) {
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && m[1]) return m[1];
  const q = req.query && req.query.token;
  if (typeof q === "string") return q;
  return null;
}

function getModeratorCredentials() {
  const settings = getControlSettings();
  return {
    enabled: settings.moderatorEnabled,
    username: settings.moderatorUsername,
    passwordHash: String(getSetting("moderatorPasswordHash", "")),
  };
}

function authenticateModerator(req, res, next) {
  const credentials = getModeratorCredentials();
  const auth = String(req.headers.authorization || "");
  const match = auth.match(/^Basic\s+(.+)$/i);
  let username = "";
  let password = "";
  if (match) {
    try {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        username = decoded.slice(0, separator);
        password = decoded.slice(separator + 1);
      }
    } catch (_error) {
      // Treat malformed credentials as unauthenticated.
    }
  }

  // Check permanent moderator credentials
  if (
    credentials.enabled &&
    username === credentials.username &&
    verifyModeratorPassword(password, credentials.passwordHash)
  ) {
    req.moderatorUsername = credentials.username;
    return next();
  }

  // Check active temp mod credentials
  if (
    activeTempMod &&
    username.toLowerCase() === activeTempMod.username &&
    verifyModeratorPassword(password, activeTempMod.passwordHash)
  ) {
    // Check expiration
    if (Date.now() >= activeTempMod.expiresAt) {
      activeTempMod = null;
    } else {
      req.moderatorUsername = activeTempMod.username;
      return next();
    }
  }

  // Check a signed single-sign-on token (one-click auto-auth from the whisper).
  // The token encodes the temp-mod login and an expiry, so it authenticates both
  // the page load and subsequent API calls without a password.
  const tokenUsername = verifyTempModeratorToken(extractModeratorToken(req));
  if (
    tokenUsername &&
    activeTempMod &&
    tokenUsername === activeTempMod.username.toLowerCase() &&
    Date.now() < activeTempMod.expiresAt
  ) {
    req.moderatorUsername = activeTempMod.username;
    return next();
  }

  return res
    .status(401)
    .set("WWW-Authenticate", 'Basic realm="Moderator Access"')
    .json({
      error: credentials.enabled ? "Authentication required." : "Moderator access is disabled.",
    });
}

function createRateLimiter({ windowMs = 60 * 1000, max = 120 } = {}) {
  const hits = new Map();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of hits.entries()) {
      if (now - data.startTime > windowMs) {
        hits.delete(ip);
      }
    }
  }, windowMs);
  if (cleanupTimer.unref) cleanupTimer.unref();

  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || "127.0.0.1";
    const now = Date.now();
    let record = hits.get(ip);

    if (!record || now - record.startTime > windowMs) {
      record = { count: 0, startTime: now };
    }

    record.count++;
    hits.set(ip, record);

    const remaining = Math.max(0, max - record.count);
    const resetTime = Math.ceil((record.startTime + windowMs) / 1000);

    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetTime);

    if (record.count > max) {
      console.warn(
        `[rate-limit] IP ${ip} exceeded ${max} requests in ${windowMs / 1000}s window (count: ${record.count})`,
      );
      res.setHeader("Retry-After", Math.ceil((record.startTime + windowMs - now) / 1000));
      return res.status(429).json({ error: "Too many requests. Please slow down." });
    }

    next();
  };
}

function parseBadgeString(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "object") return Object.keys(value).map(String);
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasTwitchBadge(badges, badgeName) {
  const badgeKey = String(badgeName || "").toLowerCase();
  const pieces = parseBadgeString(badges);
  return pieces.some(
    (piece) => piece.toLowerCase().startsWith(`${badgeKey}/`) || piece.toLowerCase() === badgeKey,
  );
}

function isTwitchModerator(tags = {}) {
  return tags.mod === "1" || hasTwitchBadge(tags.badges, "moderator");
}

function isTwitchSubscriber(tags = {}) {
  return tags.subscriber === "1" || hasTwitchBadge(tags.badges, "subscriber");
}

async function userIsFollowingChannel(username, channel) {
  const actorLogin = String(username || "").trim();
  const channelLogin = String(channel || "")
    .replace(/^#/, "")
    .trim();
  if (!actorLogin || !channelLogin) return false;
  if (actorLogin.toLowerCase() === channelLogin.toLowerCase()) return true;

  const cfg = twitchConfig || loadTwitchConfig();
  if (!cfg || !cfg.accessToken || !cfg.clientId) return false;

  try {
    const actorResp = await fetch(
      `https://api.twitch.tv/helix/users?logins=${encodeURIComponent(actorLogin)}`,
      {
        headers: {
          "Client-Id": cfg.clientId,
          Authorization: `Bearer ${cfg.accessToken}`,
        },
      },
    );
    const actorJson = await actorResp.json();
    const actorId = actorJson && actorJson.data && actorJson.data[0] && actorJson.data[0].id;
    if (!actorId) return false;

    const channelResp = await fetch(
      `https://api.twitch.tv/helix/users?logins=${encodeURIComponent(channelLogin)}`,
      {
        headers: {
          "Client-Id": cfg.clientId,
          Authorization: `Bearer ${cfg.accessToken}`,
        },
      },
    );
    const channelJson = await channelResp.json();
    const channelId =
      channelJson && channelJson.data && channelJson.data[0] && channelJson.data[0].id;
    if (!channelId) return false;

    const followResp = await fetch(
      `https://api.twitch.tv/helix/users/follows?from_id=${encodeURIComponent(actorId)}&to_id=${encodeURIComponent(channelId)}`,
      {
        headers: {
          "Client-Id": cfg.clientId,
          Authorization: `Bearer ${cfg.accessToken}`,
        },
      },
    );
    const followJson = await followResp.json();
    return !!(followJson && followJson.data && followJson.data.length);
  } catch (e) {
    console.warn("Failed to check follow status for chat request:", e && e.message ? e.message : e);
    return false;
  }
}

async function getChatRequestPermission(username, tags = {}) {
  const settings = getControlSettings();
  if (!settings.chatRequestsEnabled) {
    return {
      allowed: false,
      reason:
        "Chat requests are currently disabled by the streamer. The streamer can still add requests from the control panel.",
    };
  }

  const role = settings.chatRequestsRequireRole;
  if (role === "moderator" && !isTwitchModerator(tags)) {
    return { allowed: false, reason: "Only moderators can request songs via chat right now." };
  }

  if (role === "subscriber" && !isTwitchSubscriber(tags)) {
    return {
      allowed: false,
      reason: "Only subscribers and moderators can request songs via chat right now.",
    };
  }

  if (role === "follower") {
    const channelName = (twitchConfig && twitchConfig.channel) || "";
    const allowed = await userIsFollowingChannel(username, channelName);
    if (!allowed) {
      return {
        allowed: false,
        reason: "Only followers, subscribers, and moderators can request songs via chat right now.",
      };
    }
  }

  return { allowed: true, reason: "" };
}

async function announceChatRequestStatus(enabled, role) {
  if (!twitchClient || !twitchConfig || !twitchConfig.channel) return;
  const channel = String(twitchConfig.channel).replace(/^#/, "");
  let message;
  if (enabled) {
    const roleLabels = {
      moderator: "Moderators only",
      subscriber: "Subscribers & moderators only",
      follower: "Followers, subscribers & moderators only",
    };
    const restriction = roleLabels[role] || "Anyone";
    message = `Chat requests are now enabled (${restriction}).`;
  } else {
    message =
      "Chat requests are now disabled. The streamer can still add requests from the control panel.";
  }
  try {
    await sendChatMessage(twitchClient, channel, message);
  } catch (error) {
    console.error(
      "Failed to announce chat request status:",
      error && error.message ? error.message : error,
    );
  }
}

// Accept an optional options object as 4th argument: { skipLimit: boolean, prioritizeViewerInsertion: boolean }
function addRequest(songId, username, displayName, options = {}) {
  const skipLimit = !!options.skipLimit;
  const prioritizeViewerInsertion = !!options.prioritizeViewerInsertion;

  const song = db.prepare("SELECT * FROM songs WHERE id=?").get(songId);
  if (!song) throw new Error("Song not found.");

  if (isBlacklisted(songId, username)) {
    throw new Error("That song or viewer is currently blacklisted.");
  }

  const totalQueued = db.prepare("SELECT COUNT(*) n FROM requests WHERE status='queued'").get().n;
  if (totalQueued >= QUEUE_LIMIT) throw new Error("The request queue is full.");

  if (!skipLimit && !canRequest(username)) {
    throw new Error(`You already have the maximum of ${MAX_REQUESTS_PER_USER} active request(s).`);
  }

  const duplicate = db
    .prepare(
      `
    SELECT id FROM requests
    WHERE song_id=? AND status IN ('queued','playing')
    LIMIT 1
  `,
    )
    .get(songId);
  if (duplicate) throw new Error("That song is already queued or playing.");

  const isViewerRequest = String(username).toLowerCase() !== "streamer";
  const prioritize = getSetting("prioritizeViewerRequests", true);
  const insertRequest = db.transaction(() => {
    const queued = db
      .prepare(
        `
      SELECT id, created_at, requested_by
      FROM requests
      WHERE status='queued'
      ORDER BY created_at ASC, id ASC
    `,
      )
      .all();
    let insertIndex = queued.length;
    if (prioritize && prioritizeViewerInsertion && isViewerRequest) {
      const lastViewerIndex = queued.reduce(
        (lastIndex, request, index) =>
          request.requested_by.toLowerCase() === "streamer" ? lastIndex : index,
        -1,
      );
      insertIndex = lastViewerIndex + 1;
    }

    const baseTimestamp = queued.length
      ? Math.min(...queued.map((request) => Number(request.created_at)))
      : Date.now();
    const update = db.prepare("UPDATE requests SET created_at=? WHERE id=?");
    queued.forEach((request, index) => {
      update.run(baseTimestamp + index + (index >= insertIndex ? 1 : 0), request.id);
    });
    return db
      .prepare(
        `
      INSERT INTO requests
        (song_id, requested_by, requested_display, status, created_at)
      VALUES (?, ?, ?, 'queued', ?)
    `,
      )
      .run(songId, username, displayName, baseTimestamp + insertIndex);
  });
  const info = insertRequest();

  const result = { id: Number(info.lastInsertRowid), song };
  try {
    if (typeof broadcastQueueUpdate === "function") broadcastQueueUpdate();
  } catch (e) {
    /* ignore */
  }
  return result;
}

function setRequestStatus(id, status) {
  const now = Date.now();
  if (status === "playing") {
    // Only one request may be playing.
    db.prepare(
      `
      UPDATE requests SET status='completed', completed_at=?
      WHERE status='playing'
    `,
    ).run(now);

    const result = db
      .prepare(
        `
      UPDATE requests SET status='playing', started_at=?
      WHERE id=? AND status='queued'
    `,
      )
      .run(now, id);
    const ok = result.changes > 0;
    try {
      if (ok && typeof broadcastQueueUpdate === "function") broadcastQueueUpdate();
    } catch (e) {
      /* ignore */
    }
    return ok;
  }

  const result = db
    .prepare(
      `
    UPDATE requests SET status=?, completed_at=?
    WHERE id=? AND status IN ('queued','playing')
  `,
    )
    .run(status, now, id);
  const ok = result.changes > 0;
  try {
    if (ok && typeof broadcastQueueUpdate === "function") broadcastQueueUpdate();
  } catch (e) {
    /* ignore */
  }
  return ok;
}

function nextRequest() {
  const next = db
    .prepare(
      `
    SELECT r.id FROM requests r
    WHERE r.status='queued'
    ORDER BY r.created_at ASC, r.id ASC
    LIMIT 1
  `,
    )
    .get();
  if (!next) return null;
  setRequestStatus(next.id, "playing");
  return getNowPlaying();
}

function songRow(row) {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    artist: row.artist,
    genre: row.genre,
    pack: row.pack,
    music: row.music,
    filePath: row.file_path,
    charts: getSongCharts(row.id),
  };
}

function getSongCharts(songId) {
  return db
    .prepare(
      `
    SELECT id, chart_type chartType, difficulty, meter
    FROM charts WHERE song_id=? ORDER BY id
  `,
    )
    .all(songId);
}

function formatSongRequestLabel(song) {
  const id = song.song_id ?? song.id;
  const title = song.title || "";
  const artist = song.artist || "";
  const pack = song.pack || "";
  return `ID:${id} Title:${title} Artist:${artist} Pack:${pack}`;
}

function truncateMessage(message, maxLength) {
  const characters = Array.from(String(message ?? ""));
  if (characters.length <= maxLength) return characters.join("");

  const suffix = "...";
  return characters.slice(0, Math.max(0, maxLength - suffix.length)).join("") + suffix;
}

async function sendChatMessage(targetClient, channel, message, options = {}) {
  const { skipPrefix = false, maxLength = TWITCH_MAX_MESSAGE_LENGTH } = options;
  const text = String(message ?? "");
  const payload = skipPrefix ? text : `! ${text}`;
  const boundedPayload =
    Number.isInteger(maxLength) && maxLength > 0 ? truncateMessage(payload, maxLength) : payload;
  await targetClient.say(channel, boundedPayload);
}

function getRequestById(id) {
  return (
    db
      .prepare(
        `
    SELECT r.id, r.requested_by, r.requested_display, s.id AS song_id, s.title, s.artist, s.pack
    FROM requests r JOIN songs s ON s.id = r.song_id
    WHERE r.id = ?
  `,
      )
      .get(id) || null
  );
}

function getRequestBySongId(songId) {
  return (
    db
      .prepare(
        `
    SELECT r.id, r.requested_by, r.requested_display, s.id AS song_id, s.title, s.artist, s.pack
    FROM requests r JOIN songs s ON s.id = r.song_id
    WHERE s.id = ? AND r.status IN ('queued', 'playing')
    ORDER BY r.created_at DESC
    LIMIT 1
  `,
      )
      .get(songId) || null
  );
}

async function announceRequestAction(action, request) {
  if (!request || !twitchClient || !twitchConfig || !twitchConfig.channel) return;
  const channel = String(twitchConfig.channel).replace(/^#/, "");
  const label = formatSongRequestLabel(request);

  let message = "";
  if (action === "playing") {
    const requester = request.requested_display || request.requested_by || "requester";
    message = `@${requester}, your request for ${label} is playing next.`;
  } else if (action === "skipped") {
    message = `The request for ${label} was skipped.`;
  } else if (action === "blacklisted") {
    message = `The song ${label} has been blacklisted.`;
  }

  if (!message) return;

  try {
    await sendChatMessage(twitchClient, channel, message);
  } catch (error) {
    console.error("Failed to announce request action:", error);
  }
}

// --- Temp mod nomination helpers ---

function cleanupChatUsers() {
  const now = Date.now();
  for (const [username, data] of chatUsers.entries()) {
    const isActiveTempMod =
      activeTempMod && username.toLowerCase() === activeTempMod.username.toLowerCase();
    if (isActiveTempMod) {
      const keepUntil = Math.max(activeTempMod.expiresAt, data.lastSeen + CHAT_USER_TIMEOUT_MS);
      if (now >= keepUntil) {
        chatUsers.delete(username);
      }
      continue;
    }
    if (now - data.lastSeen > CHAT_USER_TIMEOUT_MS) {
      chatUsers.delete(username);
    }
  }
}

function updateChatUser(username, displayName) {
  const key = username.toLowerCase();
  chatUsers.set(key, { displayName: displayName || username, lastSeen: Date.now() });
}

function getOnlineUsers() {
  cleanupChatUsers();
  const users = [];
  for (const [username, data] of chatUsers.entries()) {
    users.push({ username, displayName: data.displayName });
  }
  if (activeTempMod) {
    const activeKey = activeTempMod.username.toLowerCase();
    const activeEntry = users.find((u) => u.username === activeKey);
    const lastSeen = chatUsers.get(activeKey)?.lastSeen ?? Date.now();
    const keepUntil = Math.max(activeTempMod.expiresAt, lastSeen + CHAT_USER_TIMEOUT_MS);
    if (!activeEntry && Date.now() < keepUntil) {
      users.push({ username: activeKey, displayName: activeTempMod.displayname });
    }
  }
  users.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return users;
}

function generateRandomPassword(length = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ambiguous chars omitted
  const bytes = crypto.randomBytes(length);
  let password = "";
  for (let i = 0; i < length; i++) {
    password += chars[bytes[i] % chars.length];
  }
  return password;
}

// Interpret a user's whisper reply to a temp-mod nomination. Returns:
//   'yes'   - affirmative (accept the nomination)
//   'no'    - negative (decline the nomination)
//   'none'  - unrecognized / no decision (leave the nomination pending)
// The first meaningful token of the message is used, so "yes please",
// "yep", "n no", etc. all resolve correctly.
function extractWhisperText(message) {
  if (typeof message === "string") return message;
  if (message == null) return "";
  if (typeof message === "object") {
    if (typeof message.text === "string") return message.text;
    if (typeof message.message === "string") return message.message;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.fragments)) {
      return message.fragments
        .map((fragment) => {
          if (typeof fragment === "string") return fragment;
          if (fragment && typeof fragment.text === "string") return fragment.text;
          return "";
        })
        .join("");
    }
  }
  return String(message || "");
}

function classifyWhisperReply(message) {
  const text = extractWhisperText(message)
    .trim()
    .toLowerCase();
  const token = text.split(/\s+/)[0];
  if (!token) return "none";
  if (
    [
      "y",
      "yes",
      "yeah",
      "yep",
      "yup",
      "sure",
      "ok",
      "okay",
      "accepted",
      "accept",
      "accepting",
    ].includes(token)
  ) {
    return "yes";
  }
  if (["n", "no", "nope", "nah", "not", "decline", "declined", "declining"].includes(token)) {
    return "no";
  }
  return "none";
}

// Cache of Twitch login -> numeric user id, so repeated whispers to the same user
// only call the Helix Users endpoint once.
const twitchUserIds = new Map();

// Resolve a Twitch login (username) to its numeric user id via the Helix Users
// endpoint. Results are cached so repeated whispers to the same user only hit the
// API once. Returns null if the user cannot be resolved.
async function resolveTwitchUserId(login, cfg) {
  const key = String(login || "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  if (twitchUserIds.has(key)) return twitchUserIds.get(key);
  // NOTE: the Get Users endpoint uses the singular `login` query parameter.
  // Using `logins` (an unrecognized param) makes Twitch fall back to returning
  // the user in the access token (the bot itself), so every lookup resolved to
  // the bot's id and triggered "a user cannot whisper themself".
  const resp = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(key)}`, {
    headers: {
      "Client-Id": cfg.clientId,
      Authorization: `Bearer ${cfg.accessToken}`,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(
      `[whisper] Failed to resolve user id for "${login}" (status ${resp.status}): ${body}`,
    );
    return null;
  }
  const json = await resp.json();
  const id = json && json.data && json.data[0] && json.data[0].id;
  if (!id) return null;
  twitchUserIds.set(key, id);
  return id;
}

// Send a Twitch whisper using the Helix API. Twitch no longer supports sending
// nomination whispers over IRC, so outbound whispers use POST /helix/whispers,
// which requires the "user:manage:whispers" scope on the user access token.
// Incoming temp-mod Y/N responses arrive through EventSub user.whisper.message.
async function sendWhisper(username, message) {
  const cfg = twitchConfig || loadTwitchConfig();
  if (!cfg || !cfg.accessToken || !cfg.clientId) {
    console.error(
      `[whisper] Attempt to send whisper to ${username} FAILED: Twitch not configured (missing access token or client id)`,
    );
    throw new Error("Twitch not configured");
  }

  const senderId = await resolveTwitchUserId(cfg.username, cfg);
  if (!senderId) {
    console.error(`[whisper] Could not resolve sender id for ${cfg.username}; aborting whisper.`);
    throw new Error("Could not resolve sender user id");
  }
  const recipientId = await resolveTwitchUserId(username, cfg);
  if (!recipientId) {
    console.error(`[whisper] Could not resolve recipient id for ${username}; aborting whisper.`);
    throw new Error(`Could not resolve recipient user id for ${username}`);
  }

  // Helix rejects a self-whisper with 400; guard against nominating the bot's own
  // account (it also posts chat announcements, so it could appear in the list).
  if (String(senderId) === String(recipientId)) {
    console.error(
      `[whisper] Refusing to whisper ${username}: it resolves to the bot's own user id (${recipientId}).`,
    );
    throw new Error("Cannot whisper the bot's own account.");
  }

  const preview = String(message).replace(/\s+/g, " ").trim().slice(0, 60);
  console.log(`[whisper] Sending whisper to ${username} (id ${recipientId}) via Helix: ${preview}`);

  try {
    const resp = await fetch(
      `https://api.twitch.tv/helix/whispers?from_user_id=${encodeURIComponent(senderId)}&to_user_id=${encodeURIComponent(recipientId)}`,
      {
        method: "POST",
        headers: {
          "Client-Id": cfg.clientId,
          Authorization: `Bearer ${cfg.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: String(message) }),
      },
    );
    // 204 = accepted (or silently dropped by Twitch). 204 has no body.
    if (resp.status === 204) {
      console.log(
        `[whisper] Whisper to ${username} accepted by Helix (status 204). Note: a 204 does not confirm delivery; Twitch can silently drop whispers that violate its policies.`,
      );
      return { status: 204, ok: true };
    }
    const body = await resp.text().catch(() => "");
    console.error(
      `[whisper] Whisper to ${username} REJECTED by Helix (status ${resp.status}): ${body}`,
    );
    throw new Error(`Twitch whisper rejected (status ${resp.status})`);
  } catch (e) {
    // Re-throw so callers (which set pendingNomination = null on failure) behave
    // as before. Network errors are already logged above.
    throw e;
  }
}

function clearTempModExpirationTimer() {
  if (tempModExpirationTimer) {
    clearTimeout(tempModExpirationTimer);
    tempModExpirationTimer = null;
  }
}

function scheduleTempModExpiration() {
  clearTempModExpirationTimer();
  if (!activeTempMod) return;

  const msUntilExpiry = activeTempMod.expiresAt - Date.now();
  if (msUntilExpiry <= 0) {
    expireTempMod();
    return;
  }

  tempModExpirationTimer = setTimeout(() => {
    expireTempMod();
  }, msUntilExpiry);
  if (tempModExpirationTimer.unref) tempModExpirationTimer.unref();
}

async function expireTempMod(options = {}) {
  const { manual = false } = options;
  clearTempModExpirationTimer();
  if (!activeTempMod) return;

  const displayname = activeTempMod.displayname;
  const username = activeTempMod.username;
  activeTempMod = null;

  // Restore the original moderator password to invalidate the temp mod's credentials
  if (originalModeratorPasswordHash) {
    setSetting("moderatorPasswordHash", originalModeratorPasswordHash);
  }

  try {
    await sendChatMessage(
      twitchClient,
      twitchConfig.channel,
      manual
        ? `@${displayname}'s temporary moderator session has ended early.`
        : `@${displayname} is no longer moderating the request queue.`,
    );
  } catch (e) {
    console.error("Failed to announce temp mod expiration:", e && e.message ? e.message : e);
  }
  try {
    if (typeof broadcastQueueUpdate === "function") broadcastQueueUpdate();
  } catch (e) {}

  console.log(
    `[temp-mod] ${displayname}'s temporary moderator session ${manual ? "ended early" : "has expired"}.`,
  );

  return { username, displayname, manual };
}

// Clear pending nomination if it's past the cooldown window
function cleanupPendingNomination() {
  if (!pendingNomination) return;
  const elapsed = Date.now() - pendingNomination.nominatedAt;
  if (elapsed > NOMINATION_COOLDOWN_MS) {
    console.log(`[temp-mod] Pending nomination for ${pendingNomination.username} timed out.`);
    pendingNomination = null;
  }
}

// Start periodic cleanup of chat users
function startChatUsersCleanup() {
  if (chatUsersCleanupTimer) return;
  chatUsersCleanupTimer = setInterval(() => {
    cleanupChatUsers();
    cleanupPendingNomination();
  }, 60 * 1000);
  if (chatUsersCleanupTimer.unref) chatUsersCleanupTimer.unref();
}

function stopChatUsersCleanup() {
  if (chatUsersCleanupTimer) {
    clearInterval(chatUsersCleanupTimer);
    chatUsersCleanupTimer = null;
  }
}

function createApi(app, options = {}) {
  app.use(express.json({ limit: "32kb" }));
  if (options.moderator) {
    app.use("/api/moderator", authenticateModerator);
    app.get("/api/moderator/settings", (_req, res) => res.json(getControlSettings()));
    app.post("/api/moderator/settings", async (req, res) => {
      const current = getControlSettings();
      const settings = {
        prioritizeViewerRequests: Object.prototype.hasOwnProperty.call(
          req.body,
          "prioritizeViewerRequests",
        )
          ? !!req.body.prioritizeViewerRequests
          : current.prioritizeViewerRequests,
        chatRequestsEnabled: Object.prototype.hasOwnProperty.call(req.body, "chatRequestsEnabled")
          ? !!req.body.chatRequestsEnabled
          : current.chatRequestsEnabled,
        chatRequestsRequireRole: Object.prototype.hasOwnProperty.call(
          req.body,
          "chatRequestsRequireRole",
        )
          ? String(req.body.chatRequestsRequireRole)
          : current.chatRequestsRequireRole,
      };
      Object.entries(settings).forEach(([key, value]) => setSetting(key, value));

      if (
        current.chatRequestsEnabled !== settings.chatRequestsEnabled ||
        current.chatRequestsRequireRole !== settings.chatRequestsRequireRole
      ) {
        await announceChatRequestStatus(
          settings.chatRequestsEnabled,
          settings.chatRequestsRequireRole,
        );
      }
      res.json({ ok: true, ...settings });
    });
    app.post("/api/moderator/request", (req, res) => {
      try {
        const r = addRequest(
          Number(req.body.songId),
          req.moderatorUsername,
          req.moderatorUsername,
          { skipLimit: true },
        );
        res.json({ ok: true, request: r });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });
    app.post("/api/moderator/queue/:id/play", async (req, res) => {
      const id = Number(req.params.id);
      const request = getRequestById(id);
      const ok = setRequestStatus(id, "playing");
      if (ok) await announceRequestAction("playing", request);
      res.json({ ok, nowPlaying: getNowPlaying() });
    });
    app.post("/api/moderator/queue/:id/skip", async (req, res) => {
      const id = Number(req.params.id);
      const request = getRequestById(id);
      const ok = setRequestStatus(id, "skipped");
      if (ok) await announceRequestAction("skipped", request);
      res.json({ ok });
    });
    app.post("/api/moderator/queue/next", async (_req, res) => {
      const next = db
        .prepare(
          `
        SELECT r.id FROM requests r
        WHERE r.status='queued'
        ORDER BY r.created_at ASC, r.id ASC
        LIMIT 1
      `,
        )
        .get();
      if (!next) return res.json({ ok: true, nowPlaying: null });
      const request = getRequestById(next.id);
      const nowPlaying = nextRequest();
      if (request) await announceRequestAction("playing", request);
      res.json({ ok: true, nowPlaying });
    });
    app.post("/api/moderator/queue/clear", (_req, res) => {
      const info = db
        .prepare("UPDATE requests SET status='skipped', completed_at=? WHERE status='queued'")
        .run(Date.now());
      try {
        if (typeof broadcastQueueUpdate === "function") broadcastQueueUpdate();
      } catch (_error) {}
      res.json({ ok: true, changed: info.changes });
    });
    app.post("/api/moderator/queue/:id/move", (req, res) => {
      const id = Number(req.params.id);
      const direction = req.body.direction === "up" ? -1 : 1;
      const tx = db.transaction(() => {
        const queued = db
          .prepare(
            "SELECT id, created_at FROM requests WHERE status='queued' ORDER BY created_at ASC, id ASC",
          )
          .all();
        const index = queued.findIndex((request) => request.id === id);
        const neighborIndex = index + direction;
        if (index < 0) return false;
        if (neighborIndex < 0 || neighborIndex >= queued.length) return true;
        [queued[index], queued[neighborIndex]] = [queued[neighborIndex], queued[index]];
        const baseTimestamp = Math.min(...queued.map((request) => request.created_at));
        const update = db.prepare("UPDATE requests SET created_at=? WHERE id=?");
        queued.forEach((request, queueIndex) => update.run(baseTimestamp + queueIndex, request.id));
        return true;
      });
      if (!tx()) return res.status(404).json({ error: "Queued request not found." });
      try {
        if (typeof broadcastQueueUpdate === "function") broadcastQueueUpdate();
      } catch (_error) {}
      res.json({ ok: true });
    });
    app.post("/api/moderator/queue/:id/complete", (req, res) => {
      const ok = setRequestStatus(Number(req.params.id), "completed");
      res.json({ ok });
    });
  }
  app.get("/api/stats", (_req, res) => res.json(getStats()));

  app.get("/api/search", (req, res) => {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
    if (!q) return res.json([]);

    const rows = getSongSearchRows(limit, q);
    res.json(rows.map(songRow));
  });

  // Browse songs with pagination and optional filters
  app.get("/api/songs", (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage || 25)));
    const offset = (page - 1) * perPage;
    const where = [];
    const params = {};

    if (req.query.pack) {
      where.push("pack = @pack");
      params.pack = String(req.query.pack);
    }
    if (req.query.genre) {
      where.push("genre = @genre");
      params.genre = String(req.query.genre);
    }

    // Chart-based filters: style, difficulty, meter range
    const chartWhere = [];
    if (req.query.style) {
      const style = String(req.query.style);
      if (style === "dance-single" || style === "dance-double") {
        chartWhere.push("chart_type = @style");
        params.style = style;
      }
    }
    if (req.query.difficulty) {
      chartWhere.push("difficulty = @difficulty");
      params.difficulty = String(req.query.difficulty);
    }
    const meterMin =
      typeof req.query.meterMin !== "undefined" && req.query.meterMin !== ""
        ? Number(req.query.meterMin)
        : null;
    const meterMax =
      typeof req.query.meterMax !== "undefined" && req.query.meterMax !== ""
        ? Number(req.query.meterMax)
        : null;
    if (meterMin !== null && meterMax !== null) {
      chartWhere.push("CAST(meter AS INTEGER) BETWEEN @meterMin AND @meterMax");
      params.meterMin = meterMin;
      params.meterMax = meterMax;
    } else if (meterMin !== null) {
      chartWhere.push("CAST(meter AS INTEGER) >= @meterMin");
      params.meterMin = meterMin;
    } else if (meterMax !== null) {
      chartWhere.push("CAST(meter AS INTEGER) <= @meterMax");
      params.meterMax = meterMax;
    }

    if (chartWhere.length) {
      where.push(`id IN (SELECT song_id FROM charts WHERE ${chartWhere.join(" AND ")})`);
    }

    const q = String(req.query.q || "").trim();
    if (q) {
      where.push("match_query(title, @q) = 1");
      params.q = q;
    }

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const sort = new Set(["title", "artist", "pack", "last_modified"]).has(req.query.sort)
      ? req.query.sort
      : "title";
    const order = String(req.query.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
    const orderSql =
      sort === "last_modified"
        ? `ORDER BY ${sort} ${order}`
        : `ORDER BY ${sort} COLLATE NOCASE ${order}`;

    const total = db.prepare(`SELECT COUNT(*) AS count FROM songs ${whereSql}`).get(params).count;
    const pageRows = db
      .prepare(`SELECT * FROM songs ${whereSql} ${orderSql} LIMIT @perPage OFFSET @offset`)
      .all({
        ...params,
        perPage,
        offset,
      });

    res.json({ songs: pageRows.map(songRow), total, page, perPage });
  });

  app.get("/api/song-filters", (_req, res) => {
    const packs = db
      .prepare(
        `
      SELECT pack, COUNT(*) count FROM songs
      WHERE pack IS NOT NULL AND pack != ''
      GROUP BY pack ORDER BY pack COLLATE NOCASE ASC
    `,
      )
      .all();
    const genres = db
      .prepare(
        `
      SELECT genre, COUNT(*) count FROM songs
      WHERE genre IS NOT NULL AND genre != ''
      GROUP BY genre ORDER BY genre COLLATE NOCASE ASC
    `,
      )
      .all();

    const difficulties = db
      .prepare(
        `
      SELECT difficulty, COUNT(DISTINCT song_id) count FROM charts
      WHERE difficulty IS NOT NULL AND difficulty != ''
      GROUP BY difficulty ORDER BY difficulty COLLATE NOCASE ASC
    `,
      )
      .all();
    const styles = db
      .prepare(
        `
      SELECT chart_type style, COUNT(DISTINCT song_id) count FROM charts
      WHERE chart_type IN ('dance-single', 'dance-double')
      GROUP BY chart_type ORDER BY chart_type
    `,
      )
      .all();

    const meters = db
      .prepare(
        `
      SELECT CAST(meter AS INTEGER) meter, COUNT(DISTINCT song_id) count FROM charts
      WHERE meter IS NOT NULL AND trim(meter) != ''
      GROUP BY meter ORDER BY meter ASC
    `,
      )
      .all();

    res.json({ packs, genres, difficulties, meters, styles });
  });

  app.get("/api/queue", (_req, res) => res.json(getQueue()));
  app.get("/api/now-playing", (_req, res) => res.json(getNowPlaying()));

  app.post("/api/request", (req, res) => {
    if (!ALLOW_WEB_REQUESTS && !options.control) {
      return res.status(403).json({ error: "Web requests are disabled. Use Twitch chat." });
    }
    try {
      const rawUsername = String(req.body.username || "web-user").slice(0, 50);
      const username = rawUsername;

      // Default display name provided by client; may be overridden for control-panel streamer requests.
      let displayName = String(req.body.displayName || req.body.username || "web-user").slice(
        0,
        50,
      );

      // If this API is mounted as the control panel (options.control === true) and the
      // control client is submitting a request as the special 'streamer' sentinel username,
      // treat it as the streamer and bypass MAX_REQUESTS_PER_USER. Also use the configured
      // STREAMER_VANITY_NAME for the displayed name so overlays show the streamer's chosen name.
      const isControlStreamer = !!(
        options.control && String(username || "").toLowerCase() === "streamer"
      );

      const r = addRequest(
        Number(req.body.songId),
        username,
        isControlStreamer ? STREAMER_VANITY_NAME : displayName,
        { skipLimit: isControlStreamer },
      );
      res.json({ ok: true, request: r });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  if (options.control) {
    app.use((req, res, next) => {
      if (!CONTROL_PASSWORD) return next();
      if (req.path === "/api/control-login") return next();
      if (!verifyStreamerAuth(req.headers.authorization, CONTROL_PASSWORD)) {
        return res
          .status(401)
          .set("WWW-Authenticate", 'Basic realm="Streamer Control Panel"')
          .json({ error: "Authentication required." });
      }
      next();
    });

    app.post("/api/control-login", (_req, res) => res.json({ ok: true }));

    // Control panel settings endpoints
    app.get("/api/control/settings", (_req, res) => {
      res.json(getControlSettings());
    });
    app.post("/api/control/settings", async (req, res) => {
      const current = getControlSettings();
      const next = {
        prioritizeViewerRequests: !!req.body.prioritizeViewerRequests,
        chatRequestsEnabled: !!req.body.chatRequestsEnabled,
        chatRequestsRequireRole: String(req.body.chatRequestsRequireRole || ""),
        moderatorEnabled: !!req.body.moderatorEnabled,
        moderatorUsername: String(req.body.moderatorUsername || "")
          .trim()
          .slice(0, 50),
        instructionsMinutes: Number(req.body.instructionsMinutes),
      };

      const settings = {
        prioritizeViewerRequests: Object.prototype.hasOwnProperty.call(
          req.body,
          "prioritizeViewerRequests",
        )
          ? next.prioritizeViewerRequests
          : current.prioritizeViewerRequests,
        chatRequestsEnabled: Object.prototype.hasOwnProperty.call(req.body, "chatRequestsEnabled")
          ? next.chatRequestsEnabled
          : current.chatRequestsEnabled,
        chatRequestsRequireRole: Object.prototype.hasOwnProperty.call(
          req.body,
          "chatRequestsRequireRole",
        )
          ? next.chatRequestsRequireRole
          : current.chatRequestsRequireRole,
        moderatorEnabled: Object.prototype.hasOwnProperty.call(req.body, "moderatorEnabled")
          ? next.moderatorEnabled
          : current.moderatorEnabled,
        moderatorUsername: Object.prototype.hasOwnProperty.call(req.body, "moderatorUsername")
          ? next.moderatorUsername
          : current.moderatorUsername,
        moderatorPasswordConfigured: current.moderatorPasswordConfigured,
        instructionsMinutes: Object.prototype.hasOwnProperty.call(req.body, "instructionsMinutes")
          ? Number.isFinite(Number(req.body.instructionsMinutes)) &&
            Number(req.body.instructionsMinutes) >= 0
            ? Number(req.body.instructionsMinutes)
            : current.instructionsMinutes
          : current.instructionsMinutes,
      };

      const password = Object.prototype.hasOwnProperty.call(req.body, "moderatorPassword")
        ? String(req.body.moderatorPassword || "")
        : "";
      if (settings.moderatorEnabled && !settings.moderatorUsername) {
        return res
          .status(400)
          .json({ error: "Moderator username is required before enabling access." });
      }
      if (settings.moderatorEnabled && !settings.moderatorPasswordConfigured && !password) {
        return res.status(400).json({
          error: "Moderator password must be set before enabling access for the first time.",
        });
      }

      setSetting("prioritizeViewerRequests", settings.prioritizeViewerRequests);
      setSetting("chatRequestsEnabled", settings.chatRequestsEnabled);
      setSetting("chatRequestsRequireRole", settings.chatRequestsRequireRole);
      setSetting("moderatorEnabled", settings.moderatorEnabled);
      setSetting("moderatorUsername", settings.moderatorUsername);
      setSetting("instructionsMinutes", settings.instructionsMinutes);
      if (password) {
        setSetting("moderatorPasswordHash", hashModeratorPassword(password));
        settings.moderatorPasswordConfigured = true;
      }

      if (current.instructionsMinutes !== settings.instructionsMinutes) {
        clearInstructionsTimer();
        scheduleInstructions();
      }

      if (
        current.chatRequestsEnabled !== settings.chatRequestsEnabled ||
        current.chatRequestsRequireRole !== settings.chatRequestsRequireRole
      ) {
        await announceChatRequestStatus(
          settings.chatRequestsEnabled,
          settings.chatRequestsRequireRole,
        );
      }
      try {
        if (typeof broadcastQueueUpdate === "function") broadcastQueueUpdate();
      } catch (e) {}
      res.json({ ok: true, ...settings });
    });

    // --- Temp mod nomination endpoints ---

    app.get("/api/control/temp-mod/status", (_req, res) => {
      cleanupPendingNomination();
      const now = Date.now();
      let tempMod = null;
      let tempModRemaining = 0;
      if (activeTempMod && now < activeTempMod.expiresAt) {
        tempMod = {
          username: activeTempMod.username,
          displayName: activeTempMod.displayname,
          expiresAt: activeTempMod.expiresAt,
        };
        tempModRemaining = Math.max(0, activeTempMod.expiresAt - now);
      } else if (activeTempMod && now >= activeTempMod.expiresAt) {
        // Expired but timer hasn't fired yet — expire it now
        expireTempMod().catch((e) => console.error("[temp-mod] Error expiring:", e));
      }

      let nominationCooldown = 0;
      if (pendingNomination) {
        nominationCooldown = Math.max(
          0,
          NOMINATION_COOLDOWN_MS - (now - pendingNomination.nominatedAt),
        );
      }

      res.json({
        tempMod,
        tempModRemaining,
        hasPendingNomination: !!pendingNomination,
        nominationCooldown,
        publicUrl: PUBLIC_URL,
      });
    });

    app.get("/api/control/chat-users", (_req, res) => {
      const users = getOnlineUsers();
      res.json(users);
    });

    app.post("/api/control/temp-mod/end-early", async (req, res) => {
      const username = String(req.body && req.body.username ? req.body.username : "")
        .trim()
        .toLowerCase();

      if (!activeTempMod) {
        return res.status(409).json({ error: "No active temporary moderator to end early." });
      }

      if (username && username !== activeTempMod.username.toLowerCase()) {
        return res.status(409).json({
          error: `Active temp mod is ${activeTempMod.displayname}; cannot end ${username} early.`,
        });
      }

      try {
        const result = await expireTempMod({ manual: true });
        res.json({ ok: true, ...result });
      } catch (e) {
        console.error("[temp-mod] Failed to end temp mod early:", e && e.message ? e.message : e);
        res.status(500).json({ error: "Failed to end temp moderator session." });
      }
    });

    app.post("/api/control/temp-mod/nominate", async (req, res) => {
      const { username, tempModTime } = req.body;
      const modTime = Math.min(60, Math.max(1, Number(tempModTime) || 15));

      if (!username || !username.trim()) {
        return res.status(400).json({ error: "Username is required" });
      }

      if (!PUBLIC_URL) {
        return res.status(400).json({ error: "PUBLIC_URL is not configured" });
      }

      // Check for valid external URL (not localhost/127.0.0.1)
      try {
        const url = new URL(PUBLIC_URL);
        if (
          url.hostname === "localhost" ||
          url.hostname === "127.0.0.1" ||
          url.hostname === "::1"
        ) {
          return res
            .status(400)
            .json({ error: "PUBLIC_URL must be a publicly accessible URL (not localhost)" });
        }
      } catch (e) {
        return res.status(400).json({ error: "PUBLIC_URL is not a valid URL" });
      }

      if (pendingNomination) {
        const remaining = Math.ceil(
          (NOMINATION_COOLDOWN_MS - (Date.now() - pendingNomination.nominatedAt)) / 1000,
        );
        return res.status(429).json({ error: `Nomination pending. Cooldown: ${remaining}s` });
      }
      if (activeTempMod) {
        const remaining = Math.ceil((activeTempMod.expiresAt - Date.now()) / 1000);
        return res.status(409).json({
          error: `Temp mod ${activeTempMod.displayname} is active (${remaining}s remaining)`,
        });
      }
      if (!twitchClient) {
        return res.status(503).json({ error: "Twitch client not connected" });
      }

      const userKey = username.trim().toLowerCase();
      const botLogin = String(twitchConfig.username || "")
        .trim()
        .toLowerCase();
      if (!botLogin || userKey === botLogin) {
        return res
          .status(400)
          .json({ error: "Cannot nominate the bot's own account as a temp moderator." });
      }
      const chatUser = chatUsers.get(userKey);
      const displayname = chatUser ? chatUser.displayName : username.trim();

      pendingNomination = {
        username: userKey,
        displayname,
        nominatedAt: Date.now(),
        tempModTime: modTime,
      };

      try {
        await sendWhisper(
          userKey,
          `${twitchConfig.username} wants to know if you would like to moderate the request queue. Please reply Y or N`,
        );
        res.json({ ok: true, username: userKey, displayname, tempModTime: modTime });
      } catch (e) {
        pendingNomination = null;
        res.status(500).json({ error: `Failed to send whisper: ${e.message}` });
      }
    });

    app.post("/api/queue/:id/play", async (req, res) => {
      const id = Number(req.params.id);
      const request = getRequestById(id);
      const ok = setRequestStatus(id, "playing");
      if (ok) await announceRequestAction("playing", request);
      res.json({ ok, nowPlaying: getNowPlaying() });
    });

    app.post("/api/queue/:id/complete", (req, res) => {
      const ok = setRequestStatus(Number(req.params.id), "completed");
      res.json({ ok });
    });

    app.post("/api/queue/:id/skip", async (req, res) => {
      const id = Number(req.params.id);
      const request = getRequestById(id);
      const ok = setRequestStatus(id, "skipped");
      if (ok) await announceRequestAction("skipped", request);
      res.json({ ok });
    });

    app.post("/api/queue/next", async (_req, res) => {
      const next = db
        .prepare(
          `
        SELECT r.id FROM requests r
        WHERE r.status='queued'
        ORDER BY r.created_at ASC, r.id ASC
        LIMIT 1
      `,
        )
        .get();
      if (!next) return res.json({ ok: true, nowPlaying: null });
      const request = getRequestById(next.id);
      const nowPlaying = nextRequest();
      if (request) await announceRequestAction("playing", request);
      res.json({ ok: true, nowPlaying });
    });

    app.post("/api/queue/clear", (_req, res) => {
      const info = db
        .prepare(
          `
        UPDATE requests SET status='skipped', completed_at=?
        WHERE status='queued'
      `,
        )
        .run(Date.now());
      try {
        if (typeof broadcastQueueUpdate === "function") broadcastQueueUpdate();
      } catch (e) {}
      res.json({ ok: true, changed: info.changes });
    });

    app.post("/api/queue/:id/move", (req, res) => {
      const id = Number(req.params.id);
      const direction = req.body.direction === "up" ? -1 : 1;
      const tx = db.transaction(() => {
        const queued = db
          .prepare(
            "SELECT id, created_at FROM requests WHERE status='queued' ORDER BY created_at ASC, id ASC",
          )
          .all();
        const index = queued.findIndex((request) => request.id === id);
        const neighborIndex = index + direction;
        if (index < 0) return false;
        if (neighborIndex < 0 || neighborIndex >= queued.length) return true;
        [queued[index], queued[neighborIndex]] = [queued[neighborIndex], queued[index]];
        const baseTimestamp = Math.min(...queued.map((request) => request.created_at));
        const update = db.prepare("UPDATE requests SET created_at=? WHERE id=?");
        queued.forEach((request, queueIndex) => update.run(baseTimestamp + queueIndex, request.id));
        return true;
      });
      if (!tx()) return res.status(404).json({ error: "Queued request not found." });
      try {
        if (typeof broadcastQueueUpdate === "function") broadcastQueueUpdate();
      } catch (e) {}
      res.json({ ok: true });
    });

    app.post("/api/blacklist/song", async (req, res) => {
      const songId = Number(req.body.songId);
      const reason = String(req.body.reason || "Streamer blacklist").slice(0, 200);
      const request = getRequestBySongId(songId);
      db.prepare(
        `
        INSERT OR IGNORE INTO blacklist(song_id, username, reason, created_at)
        VALUES (?, NULL, ?, ?)
      `,
      ).run(songId, reason, Date.now());
      if (request) await announceRequestAction("blacklisted", request);
      res.json({ ok: true });
    });

    app.post("/api/blacklist/user", (req, res) => {
      const username = String(req.body.username || "")
        .trim()
        .toLowerCase();
      if (!username) return res.status(400).json({ error: "Username required." });
      const reason = String(req.body.reason || "Streamer blacklist").slice(0, 200);
      db.prepare(
        `
        INSERT OR IGNORE INTO blacklist(song_id, username, reason, created_at)
        VALUES (NULL, ?, ?, ?)
      `,
      ).run(username, reason, Date.now());
      res.json({ ok: true });
    });

    app.get("/api/blacklist", (_req, res) => {
      res.json(
        db
          .prepare(
            `
        SELECT id, song_id songId, username, reason, created_at createdAt
        FROM blacklist ORDER BY created_at DESC
      `,
          )
          .all(),
      );
    });

    app.delete("/api/blacklist/:id", (req, res) => {
      const info = db.prepare("DELETE FROM blacklist WHERE id=?").run(Number(req.params.id));
      res.json({ ok: info.changes > 0 });
    });

    app.post("/api/rescan", (_req, res) => {
      try {
        const result = refreshDatabase();
        res.json({ ok: true, ...result });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Twitch control endpoints for the control panel OAuth flow.
    app.get("/api/twitch/status", (_req, res) => {
      const cfg = twitchConfig || loadTwitchConfig();
      res.json({
        configured: !!cfg,
        connected: !!twitchClient,
        channel: cfg ? cfg.channel : null,
        username: cfg ? cfg.username : null,
        clientId: cfg ? cfg.clientId : null,
      });
    });

    app.post("/api/twitch/start-auth", (req, res) => {
      const clientId = String(
        req.body.clientId || (twitchConfig && twitchConfig.clientId) || "",
      ).trim();
      const redirectUri = String(
        req.body.redirectUri ||
          req.body.redirect ||
          `https://localhost:${CONTROL_PORT}/twitch-callback.html`,
      ).trim();
      const scopes = String(req.body.scopes || "chat:read chat:edit user:manage:whispers");
      if (!clientId || !redirectUri)
        return res.status(400).json({ error: "clientId and redirectUri are required" });
      const state = Math.random().toString(36).slice(2);
      twitchAuthStates.add(state);
      const url = `https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}`;
      res.json({ url, state });
    });

    app.post("/api/twitch/exchange", async (req, res) => {
      const code = String(req.body.code || "").trim();
      const clientId = String(req.body.clientId || "").trim();
      const clientSecret = String(req.body.clientSecret || "").trim();
      const redirectUri = String(
        req.body.redirectUri || `https://localhost:${CONTROL_PORT}/twitch-callback.html`,
      ).trim();
      const channel = String(req.body.channel || "").trim();
      if (!code || !clientId || !clientSecret)
        return res.status(400).json({ error: "code, clientId and clientSecret are required" });
      try {
        // Exchange code for token
        const params = new URLSearchParams();
        params.append("client_id", clientId);
        params.append("client_secret", clientSecret);
        params.append("code", code);
        params.append("grant_type", "authorization_code");
        params.append("redirect_uri", redirectUri);

        const tokenResp = await globalThis.fetch("https://id.twitch.tv/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params,
        });
        const tokenJson = await tokenResp.json();
        if (!tokenJson.access_token)
          return res.status(400).json({ error: "Token exchange failed", details: tokenJson });

        // Fetch user info
        const userResp = await globalThis.fetch("https://api.twitch.tv/helix/users", {
          headers: { Authorization: `Bearer ${tokenJson.access_token}`, "Client-Id": clientId },
        });
        const userJson = await userResp.json();
        const login =
          (userJson && userJson.data && userJson.data[0] && userJson.data[0].login) || null;
        const finalChannel = channel || login;

        const cfg = {
          clientId,
          clientSecret,
          accessToken: tokenJson.access_token,
          refreshToken: tokenJson.refresh_token,
          expiresAt: tokenJson.expires_in ? Date.now() + Number(tokenJson.expires_in) * 1000 : null,
          username: login,
          channel: finalChannel,
        };
        saveTwitchConfig(cfg);
        await startTmiClient(cfg);
        // Schedule automatic token refresh if supported
        scheduleTwitchRefresh();
        res.json({ ok: true, cfg: { username: cfg.username, channel: cfg.channel } });
      } catch (e) {
        console.error("Twitch exchange error:", e);
        res.status(500).json({ error: e.message });
      }
    });

    app.post("/api/twitch/disconnect", async (_req, res) => {
      try {
        await stopTmiClient();
        if (fs.existsSync(TWITCH_DATA_FILE)) fs.unlinkSync(TWITCH_DATA_FILE);
        twitchConfig = null;
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }
}

const publicApp = express();
publicApp.set("trust proxy", true);
publicApp.use("/api/", createRateLimiter({ windowMs: 60 * 1000, max: 120 }));
publicApp.get("/requestModerator.html", authenticateModerator, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "requestModerator.html"));
});
publicApp.use(express.static(path.join(__dirname, "public")));
createApi(publicApp, { moderator: true });

// Server-Sent Events (SSE) endpoint for OBS overlay to receive real-time queue updates.
// Clients should connect to /overlay/queue/stream and will receive JSON array payloads in `message` events.
const sseQueueClients = new Set();
function broadcastQueueUpdate() {
  try {
    const payload = `data: ${JSON.stringify(getQueue())}\n\n`;
    for (const res of Array.from(sseQueueClients)) {
      try {
        res.write(payload);
      } catch (e) {
        sseQueueClients.delete(res);
      }
    }
  } catch (e) {
    /* ignore */
  }
}

publicApp.get("/overlay/queue/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders && res.flushHeaders();
  sseQueueClients.add(res);
  req.on("close", () => sseQueueClients.delete(res));
  // Send initial state
  res.write(`data: ${JSON.stringify(getQueue())}\n\n`);
});

// Expose a small helper name used by patched functions above.
const broadcastQueueUpdateRef = broadcastQueueUpdate; // no-op to keep reference semantics

const controlApp = express();
controlApp.use(express.static(path.join(__dirname, "control")));
createApi(controlApp, { control: true });

// Create HTTPS servers for both public viewer site and streamer control panel.
(async () => {
  try {
    const tlsOptions = await getControlTlsOptions();
    https.createServer(tlsOptions, publicApp).listen(PORT, HOST, () => {
      const hostLabel = HOST === "0.0.0.0" ? "localhost" : HOST;
      console.log(`Public request site: https://${hostLabel}:${PORT}`);
    });
    https.createServer(tlsOptions, controlApp).listen(CONTROL_PORT, CONTROL_HOST, () => {
      const hostLabel = CONTROL_HOST === "0.0.0.0" ? "localhost" : CONTROL_HOST;
      console.log(`Streamer control panel: https://${hostLabel}:${CONTROL_PORT}`);
    });
  } catch (e) {
    console.error("Failed to start HTTPS servers:", e);
    process.exitCode = 1;
  }
})();

// Twitch connection and OAuth helper support.
const TWITCH_DATA_FILE = path.resolve("./data/twitch.json");
let twitchClient = null;
let twitchConfig = null; // loaded config (clientId, clientSecret, username, channel, accessToken...)
const twitchAuthStates = new Set();

function saveTwitchConfig(cfg) {
  fs.mkdirSync(path.dirname(TWITCH_DATA_FILE), { recursive: true });
  fs.writeFileSync(TWITCH_DATA_FILE, JSON.stringify(cfg, null, 2));
  twitchConfig = cfg;
}

function loadTwitchConfig() {
  try {
    if (fs.existsSync(TWITCH_DATA_FILE)) {
      twitchConfig = JSON.parse(fs.readFileSync(TWITCH_DATA_FILE, "utf8"));
      return twitchConfig;
    }
  } catch (e) {
    console.error("Failed to load twitch config:", e.message);
  }
  twitchConfig = null;
  return null;
}

let twitchRefreshTimer = null;
let chatUsersCleanupTimer = null;

// Track recent chat users for temp mod nomination (username -> { displayName, lastSeen })
const chatUsers = new Map();
const CHAT_USER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Temp mod nomination state
let pendingNomination = null; // { username, displayname, nominatedAt, tempModTime }
const NOMINATION_COOLDOWN_MS = 60 * 1000; // 60 seconds

// Active temp mod session
let activeTempMod = null; // { username, displayname, passwordHash, expiresAt }
let tempModExpirationTimer = null;

// Store the original moderator password hash so we can restore it after temp mod expires
let originalModeratorPasswordHash = null;

function clearTwitchRefreshTimer() {
  if (twitchRefreshTimer) {
    clearTimeout(twitchRefreshTimer);
    twitchRefreshTimer = null;
  }
}

async function refreshTwitchToken() {
  const cfg = twitchConfig || loadTwitchConfig();
  if (!cfg || !cfg.refreshToken || !cfg.clientId || !cfg.clientSecret) {
    console.warn("Twitch token refresh skipped: missing refresh token or client credentials.");
    return false;
  }

  try {
    console.log("Refreshing Twitch access token...");
    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", cfg.refreshToken);
    params.append("client_id", cfg.clientId);
    params.append("client_secret", cfg.clientSecret);

    const resp = await globalThis.fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const json = await resp.json();
    if (!json.access_token) {
      console.error("Twitch refresh failed:", json);
      return false;
    }

    cfg.accessToken = json.access_token;
    if (json.refresh_token) cfg.refreshToken = json.refresh_token;
    cfg.expiresAt = json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : null;
    saveTwitchConfig(cfg);

    // restart client with new token
    await startTmiClient(cfg);
    scheduleTwitchRefresh();
    console.log("Twitch access token refreshed.");
    return true;
  } catch (e) {
    console.error("Error refreshing Twitch token:", e.message || e);
    return false;
  }
}

function scheduleTwitchRefresh() {
  clearTwitchRefreshTimer();
  const cfg = twitchConfig || loadTwitchConfig();
  if (!cfg || !cfg.expiresAt) return;
  const msUntilExpiry = cfg.expiresAt - Date.now();
  // Refresh 60s before expiry or in 1s if already expired
  const refreshIn = Math.max(1000, msUntilExpiry - 60000);
  twitchRefreshTimer = setTimeout(() => {
    refreshTwitchToken().catch((err) => console.error("Scheduled refresh failed:", err));
  }, refreshIn);
}

let instructionsTimer = null;
let helpLastSentAt = 0;

function clearInstructionsTimer() {
  if (instructionsTimer) {
    clearInterval(instructionsTimer);
    instructionsTimer = null;
  }
}

function getInstructionsEnabled() {
  return getRuntimeInstructionsMinutes() > 0;
}

function getInstructionsMessage() {
  const parts = [];
  parts.push(`Use "${PREFIX}${SEARCH_COMMAND} <title>" to search available song titles.`);
  parts.push(`Use "${PREFIX}${REQUEST_ID_COMMAND} <songID>" to request a song.`);
  parts.push(`Use "${PREFIX}queue" to view the next 5 songs in the request queue.`);
  parts.push(`Use "${PREFIX}help" to display these usage instructions.`);
  if (PUBLIC_URL)
    parts.push(`Visit ${PUBLIC_URL} for a more robust song browse and search experience.`);
  return parts.join(" ");
}

async function postInstructionsOnce() {
  if (!twitchClient || !twitchConfig || !twitchConfig.channel) return;
  if (!getInstructionsEnabled()) return;
  const channel = String(twitchConfig.channel).replace(/^#/, "");
  try {
    await sendChatMessage(twitchClient, channel, getInstructionsMessage());
  } catch (e) {
    console.error("Failed to post instructions:", e && e.message ? e.message : e);
  }
}

async function postHelpMessage(client, channel) {
  const now = Date.now();
  if (now - helpLastSentAt < HELP_COOLDOWN_MS) return;
  helpLastSentAt = now;
  await sendChatMessage(client, String(channel).replace(/^#/, ""), getInstructionsMessage());
}

function scheduleInstructions() {
  clearInstructionsTimer();
  const minutes = getRuntimeInstructionsMinutes();
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  // Post immediately once, then schedule repeating posts every N minutes.
  postInstructionsOnce().catch(() => {});
  instructionsTimer = setInterval(
    () => {
      postInstructionsOnce().catch(() => {});
    },
    minutes * 60 * 1000,
  );
}

// ---------------------------------------------------------------------------
// EventSub WebSocket client (user.whisper.message v1)
// ---------------------------------------------------------------------------
// Twitch deprecated whisper delivery over IRC, so incoming temp-mod Y/N
// replies now arrive over the EventSub WebSocket. The client connects to
// wss://eventsub.wss.twitch.tv/ws (no token in the URL), receives a
// session_welcome, then creates the whisper subscription over REST
// (POST /helix/eventsub/subscriptions, transport method "websocket"). The
// server prohibits any inbound traffic other than RFC6455 pong frames
// (close code 4001), so all control (subscribe/unsubscribe) goes over REST
// with the user access token.
//
// Delivery is at-least-once: handleTempModWhisper is idempotent because it
// clears pendingNomination before doing any async work.

let eventSubSocket = null;
let eventSubSessionId = null;
let eventSubSubscriptionId = null;
let eventSubKeepaliveTimer = null;
let eventSubReconnectTimer = null;
let eventSubKeepaliveTimeoutSeconds = null;
let eventSubReconnectAttempts = 0;
let eventSubBotUserId = null; // numeric id of the account owning the whisper inbox
let eventSubStopping = false;

function clearEventSubTimers() {
  if (eventSubKeepaliveTimer) {
    clearTimeout(eventSubKeepaliveTimer);
    eventSubKeepaliveTimer = null;
  }
  if (eventSubReconnectTimer) {
    clearTimeout(eventSubReconnectTimer);
    eventSubReconnectTimer = null;
  }
}

// Watchdog: if no message (keepalive or event) arrives within the timeout
// advertised at session_welcome, the session is dead — terminate the socket
// so its close handler triggers a full reconnect. Re-armed on every inbound
// message.
function armEventSubKeepalive(socket) {
  if (eventSubKeepaliveTimer) {
    clearTimeout(eventSubKeepaliveTimer);
    eventSubKeepaliveTimer = null;
  }
  const seconds = Number(eventSubKeepaliveTimeoutSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  eventSubKeepaliveTimer = setTimeout(() => {
    console.error(
      "[eventsub] Keepalive timeout: no messages received, terminating socket and reconnecting.",
    );
    try {
      socket.terminate();
    } catch (e) {}
  }, seconds * 1000);
}

// Create the user.whisper.message subscription over REST, bound to the given
// EventSub WebSocket session. Returns true on success (202, or a benign 409
// when an identical subscription already exists).
async function createWhisperSubscription(cfg, sessionId) {
  const userId = await resolveTwitchUserId(cfg.username, cfg);
  if (!userId) {
    console.error("[eventsub] Could not resolve the bot's user id; whisper subscription skipped.");
    return false;
  }
  eventSubBotUserId = String(userId);
  const resp = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
    method: "POST",
    headers: {
      "Client-Id": cfg.clientId,
      Authorization: `Bearer ${cfg.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "user.whisper.message",
      version: "1",
      condition: { user_id: String(userId) },
      transport: { method: "websocket", session_id: String(sessionId) },
    }),
  });
  const body = await resp.text().catch(() => "");
  if (resp.status === 202) {
    let json = null;
    try {
      json = JSON.parse(body);
    } catch (e) {}
    eventSubSubscriptionId = json && json.data && json.data[0] ? String(json.data[0].id) : null;
    console.log(
      `[eventsub] Whisper subscription active for user ${userId} (subscription ${
        eventSubSubscriptionId || "id unknown"
      }).`,
    );
    return true;
  }
  if (resp.status === 409) {
    // An identical subscription already exists (e.g. a leftover that outlived
    // the previous socket). Harmless for delivery.
    console.warn("[eventsub] Whisper subscription already exists (409); continuing.");
    return true;
  }
  console.error(
    `[eventsub] Failed to create whisper subscription (status ${resp.status}): ${body}`,
  );
  return false;
}

// Best-effort deletion of the tracked subscription (used on teardown so a
// restart doesn't hit 409 or leave a subscription bound to a dead session).
async function deleteWhisperSubscription(cfg) {
  if (!eventSubSubscriptionId) return;
  const id = eventSubSubscriptionId;
  eventSubSubscriptionId = null;
  try {
    const resp = await fetch(
      `https://api.twitch.tv/helix/eventsub/subscriptions?id=${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: {
          "Client-Id": cfg.clientId,
          Authorization: `Bearer ${cfg.accessToken}`,
        },
      },
    );
    const body = await resp.text().catch(() => "");
    if (!resp.ok) {
      console.warn(
        `[eventsub] Could not delete whisper subscription ${id} (status ${resp.status}): ${body}`,
      );
    }
  } catch (e) {
    console.warn(
      `[eventsub] Could not delete whisper subscription ${id}: ${e && e.message ? e.message : e}`,
    );
  }
}

// Shared temp-mod whisper decision logic. Fed only by the EventSub
// user.whisper.message notification. At-least-once delivery is safe: the
// pending nomination is cleared before any async work, so a duplicate
// notification is ignored.
async function handleTempModWhisper(fromUsername, message) {
  if (!pendingNomination) return;
  const fromKey = String(fromUsername || "").toLowerCase();
  if (fromKey !== pendingNomination.username) return;

  const decision = classifyWhisperReply(message);

  if (decision === "yes") {
    const wasPending = pendingNomination;
    pendingNomination = null;

    // Generate temp credentials
    const password = generateRandomPassword(12);
    const passwordHash = hashModeratorPassword(password);
    const expiresAt = Date.now() + wasPending.tempModTime * 60 * 1000;

    // Store original password hash so we can restore it on expiration
    originalModeratorPasswordHash = String(getSetting("moderatorPasswordHash", ""));

    // One-click single-sign-on token so the whisper link auto-authenticates on
    // both page load and API calls (no password prompt, phone-friendly).
    const ssoToken = createTempModeratorToken(wasPending.username, expiresAt);

    activeTempMod = {
      username: wasPending.username,
      displayname: wasPending.displayname,
      passwordHash,
      expiresAt,
      token: ssoToken,
    };

    // Enable moderator access if not already enabled
    if (!getControlSettings().moderatorEnabled) {
      setSetting("moderatorEnabled", true);
    }

    try {
      const moderatorLink = `${PUBLIC_URL}/requestModerator.html?token=${encodeURIComponent(ssoToken)}`;
      await sendWhisper(
        wasPending.username,
        `Welcome! You're now a temporary moderator for ${wasPending.tempModTime} minutes. Tap the link to open the queue:\n\n${moderatorLink}\n\n(If the link doesn't work, open ${PUBLIC_URL}/requestModerator.html and log in with:\nUsername: ${wasPending.username}\nPassword: ${password})`,
      );
      // Announce to chat
      await sendChatMessage(
        twitchClient,
        twitchConfig.channel,
        `@${wasPending.displayname} is now moderating the request queue for ${wasPending.tempModTime} minutes!`,
      );
    } catch (e) {
      console.error(
        `[temp-mod] Failed to send credentials to ${wasPending.username}:`,
        e && e.message ? e.message : e,
      );
      // Rollback on failure
      activeTempMod = null;
      if (originalModeratorPasswordHash) {
        setSetting("moderatorPasswordHash", originalModeratorPasswordHash);
        originalModeratorPasswordHash = null;
      }
      return;
    }

    // Schedule expiration
    scheduleTempModExpiration();

    console.log(
      `[temp-mod] ${wasPending.displayname} accepted temp mod nomination for ${wasPending.tempModTime} minutes.`,
    );
  } else if (decision === "no") {
    const wasPending = pendingNomination;
    pendingNomination = null;
    try {
      await sendWhisper(wasPending.username, `No problem!`);
    } catch (e) {
      console.error(
        `[temp-mod] Failed to send rejection reply to ${wasPending.username}:`,
        e && e.message ? e.message : e,
      );
    }
    console.log(`[temp-mod] ${wasPending.displayname} declined temp mod nomination.`);
  } else {
    // Unrecognized reply: keep the nomination pending and nudge the user.
    console.log(
      `[temp-mod] ${pendingNomination.displayname} sent an unrecognized whisper reply: "${message}" (nomination kept pending).`,
    );
    try {
      await sendWhisper(
        pendingNomination.username,
        `Please reply **Y** to accept or **N** to decline.`,
      );
    } catch (e) {
      console.error(
        `[temp-mod] Failed to send nudge to ${pendingNomination.username}:`,
        e && e.message ? e.message : e,
      );
    }
  }
}

// Connect to the EventSub WebSocket endpoint. Reconnects transparently:
// server-requested reconnects use the provided reconnect_url (subscriptions
// carry over), and unexpected closes fall back to a fresh session with
// exponential backoff.
async function connectEventSub(cfg, opts = {}) {
  if (eventSubStopping) return;
  const url = opts.reconnectUrl || "wss://eventsub.wss.twitch.tv/ws";
  const socket = new WebSocket(url);
  eventSubSocket = socket;

  socket.on("open", () => {
    console.log(
      `[eventsub] Socket open (${
        opts.reconnectUrl ? "server-provided reconnect URL" : "fresh session"
      }); awaiting session_welcome.`,
    );
  });

  socket.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      console.error(
        "[eventsub] Failed to parse inbound message:",
        raw && raw.toString ? raw.toString().slice(0, 200) : raw,
      );
      return;
    }
    const messageType = data && data.metadata ? data.metadata.message_type : null;
    const payload = data && data.payload ? data.payload : {};

    if (messageType === "session_welcome") {
      const session = payload.session || {};
      eventSubSessionId = String(session.id || "");
      eventSubKeepaliveTimeoutSeconds = session.keepalive_timeout_seconds;
      eventSubReconnectAttempts = 0;
      armEventSubKeepalive(socket);
      if (opts.isReconnect) {
        // Subscriptions carry over automatically on a reconnect URL — do NOT
        // re-subscribe. The old socket can now be closed; delivery continues
        // on this one.
        console.log(
          `[eventsub] Reconnected (session ${eventSubSessionId}); existing subscriptions carried over.`,
        );
        if (opts.fromSocket && opts.fromSocket !== socket) {
          if (eventSubSocket === opts.fromSocket) eventSubSocket = socket;
          try {
            opts.fromSocket.removeAllListeners();
            opts.fromSocket.close();
          } catch (e) {}
        }
      } else {
        console.log(
          `[eventsub] Session welcome received (session ${eventSubSessionId}); creating whisper subscription.`,
        );
        try {
          await createWhisperSubscription(cfg, eventSubSessionId);
        } catch (e) {
          console.error("[eventsub] Whisper subscription error:", e && e.message ? e.message : e);
        }
      }
      // Re-arm the watchdog now that the welcome handling has completed.
      armEventSubKeepalive(socket);
      return;
    }

    if (messageType === "session_keepalive") {
      // Proves the session is alive; re-arm the watchdog.
      armEventSubKeepalive(socket);
      return;
    }

    if (messageType === "session_reconnect") {
      // The server is migrating us to a new endpoint. Open the replacement
      // socket immediately; the old one stays open until the new session
      // welcomes (30s grace, subscriptions carry over). If the new socket
      // never welcomes, the old one is closed with 4004 and we fall back to
      // a fresh reconnect via its close handler.
      const session = payload.session || {};
      console.log(
        `[eventsub] Server requested reconnect to a new endpoint (status: ${
          session.status || "unknown"
        }).`,
      );
      if (!session.reconnect_url) {
        try {
          socket.terminate();
        } catch (e) {}
        return;
      }
      connectEventSub(cfg, {
        isReconnect: true,
        fromSocket: socket,
        reconnectUrl: session.reconnect_url,
      }).catch((e) => {
        console.error(
          "[eventsub] Server-requested reconnect failed:",
          e && e.message ? e.message : e,
        );
      });
      return;
    }

    if (messageType === "revocation") {
      const revoked = payload.subscription || {};
      console.warn(`[eventsub] Subscription ${revoked.id} revoked (status: ${revoked.status}).`);
      if (String(revoked.id || "") === String(eventSubSubscriptionId || "")) {
        eventSubSubscriptionId = null;
      }
      if (revoked.status === "authorization_revoked") {
        // The token no longer authorizes this subscription; retrying is
        // pointless. The token refresh / re-authorization flow re-runs
        // startTmiClient, which restarts this client.
        console.warn(
          "[eventsub] Authorization revoked; stopping EventSub client until the token flow re-establishes it.",
        );
        stopEventSubClient().catch((e) => {
          console.error("[eventsub] Teardown error:", e && e.message ? e.message : e);
        });
        return;
      }
      // The subscription was removed server-side (user_removed /
      // version_removed); re-subscribe once on the live session.
      if (eventSubSessionId) {
        createWhisperSubscription(cfg, eventSubSessionId).catch((e) => {
          console.error("[eventsub] Re-subscription error:", e && e.message ? e.message : e);
        });
      }
      return;
    }

    if (messageType === "notification") {
      // Any inbound message proves the session is alive; re-arm the watchdog.
      armEventSubKeepalive(socket);
      const subscription = payload.subscription || {};
      if (subscription.type !== "user.whisper.message") return;
      const event = payload.event || {};
      if (eventSubBotUserId && String(event.from_user_id) === eventSubBotUserId) {
        // The account whispering itself — we never send self-whispers, so
        // this is purely defensive.
        return;
      }
      console.log(
        `[eventsub] Whisper received from ${event.from_user_login || "unknown"}: ${String(
          event.message || "",
        ).slice(0, 80)}`,
      );
      handleTempModWhisper(event.from_user_login, event.message).catch((e) => {
        console.error("[eventsub] Whisper handler error:", e && e.message ? e.message : e);
      });
      return;
    }
  });

  socket.on("error", (err) => {
    console.error(`[eventsub] Socket error: ${err && err.message ? err.message : err}`);
  });

  socket.on("close", (code, reason) => {
    const why = reason && reason.toString().trim() ? `: ${reason.toString().trim()}` : "";
    console.log(`[eventsub] Socket closed (code ${code}${why}).`);
    // A stale socket (already replaced by a server-requested reconnect
    // handover) must not touch shared state.
    if (socket !== eventSubSocket) return;
    eventSubSocket = null;
    eventSubSessionId = null;
    clearEventSubTimers();
    if (eventSubStopping) return;
    scheduleEventSubReconnect(cfg);
  });
}

// Schedule a fresh-session reconnect with exponential backoff (1s base, 30s cap).
function scheduleEventSubReconnect(cfg) {
  if (eventSubStopping || eventSubReconnectTimer) return;
  eventSubReconnectAttempts += 1;
  const backoffMs = Math.min(30000, 1000 * 2 ** Math.min(eventSubReconnectAttempts - 1, 5));
  console.log(
    `[eventsub] Scheduling fresh reconnect in ${(backoffMs / 1000).toFixed(0)}s (attempt ${eventSubReconnectAttempts}).`,
  );
  eventSubReconnectTimer = setTimeout(() => {
    eventSubReconnectTimer = null;
    connectEventSub(twitchConfig || cfg).catch((e) => {
      console.error("[eventsub] Reconnect failed:", e && e.message ? e.message : e);
    });
  }, backoffMs);
}

// (Re)start the EventSub client, tearing down any previous instance first.
async function startEventSubClient(cfg) {
  if (!cfg || !cfg.accessToken || !cfg.clientId) {
    console.warn("[eventsub] Not started: missing access token or client id.");
    return;
  }
  await stopEventSubClient();
  eventSubReconnectAttempts = 0;
  await connectEventSub(cfg);
}

// Tear down the EventSub client: stop timers, close the socket, and delete
// the tracked subscription so a restart can re-subscribe cleanly.
async function stopEventSubClient() {
  eventSubStopping = true;
  clearEventSubTimers();
  const socket = eventSubSocket;
  eventSubSocket = null;
  eventSubSessionId = null;
  const cfg = twitchConfig;
  if (cfg && cfg.clientId && cfg.accessToken) {
    await deleteWhisperSubscription(cfg);
  }
  eventSubStopping = false;
  if (socket) {
    try {
      socket.removeAllListeners();
      socket.terminate();
    } catch (e) {}
  }
}

async function startTmiClient(cfg) {
  if (!cfg || !cfg.accessToken || !cfg.channel) {
    console.warn("Twitch client not started: missing config.");
    return;
  }

  if (twitchClient) {
    try {
      await twitchClient.disconnect();
    } catch (e) {}
    twitchClient = null;
  }

  const identityPassword = String(cfg.accessToken).startsWith("oauth:")
    ? cfg.accessToken
    : `oauth:${cfg.accessToken}`;
  const client = new tmi.Client({
    options: { debug: false },
    identity: {
      username: cfg.username || (cfg.channel || "").replace(/^#/, ""),
      password: identityPassword,
    },
    channels: [cfg.channel],
  });

  twitchClient = client;
  const expectedChannel = `#${String(cfg.channel).replace(/^#/, "").toLowerCase()}`;
  client.once("roomstate", (channel) => {
    if (String(channel).toLowerCase() === expectedChannel) {
      console.log(
        `Twitch channel join confirmed for ${channel}; any nearby "No response from Twitch." message can probably be safely ignored.`,
      );
    }
  });
  try {
    await client.connect();
    client.on("error", (context, error) => {
      const text = error instanceof Error ? error.message : String(error);
      console.error(`[tmi] Client error${context ? ` (${context})` : ""}: ${text}`);
    });

    // We no longer send whispers over IRC; outbound whispers use the Helix API.
    // This notice handler remains only as a diagnostic log for IRC notices.
    client.on("notice", (channel, msgid, msg) => {
      console.log(`[tmi] Notice ${msgid} on ${channel}: ${msg}`);
    });
    console.log(`Twitch bot connected to #${cfg.channel}`);
    // Post instructions once at startup and schedule recurring posts if configured
    try {
      scheduleInstructions();
    } catch (e) {
      console.error("Failed to schedule instructions:", e && e.message ? e.message : e);
    }
  } catch (err) {
    console.error("Twitch connection failed:", err && err.message ? err.message : err);
  }

  client.on("message", async (_channel, tags, message, self) => {
    // Track real chatters for temp mod nomination. Skip the bot's own messages
    // (self): the bot logs in as the channel account, so including self would list
    // the bot itself and a nomination would resolve to a self-whisper (Helix 400).
    if (self) {
      if (!message.startsWith(PREFIX)) return;
    } else {
      const display = tags["display-name"] || tags.username;
      updateChatUser(tags.username, display);
    }

    if (!message.startsWith(PREFIX)) return;
    const body = message.slice(PREFIX.length).trim();
    const space = body.indexOf(" ");
    const command = (space === -1 ? body : body.slice(0, space)).toLowerCase();
    const arg = space === -1 ? "" : body.slice(space + 1).trim();

    if (command === "help") {
      await postHelpMessage(client, cfg.channel);
      return;
    }

    // Support requesting by numeric ID: !requestid <id>
    if (command === REQUEST_ID_COMMAND) {
      if (!arg) {
        await sendChatMessage(
          client,
          cfg.channel,
          `@${display}, usage: ${PREFIX}${REQUEST_ID_COMMAND} <song id>`,
        );
        return;
      }
      const id = Number(arg);
      if (!Number.isInteger(id)) {
        await sendChatMessage(client, cfg.channel, `@${display}, "${arg}" is not a valid song id.`);
        return;
      }

      const chatPermission = await getChatRequestPermission(tags.username, tags);
      if (!chatPermission.allowed) {
        await sendChatMessage(client, cfg.channel, `@${display}, ${chatPermission.reason}`);
        return;
      }

      if (!canRequest(tags.username)) {
        await sendChatMessage(
          client,
          cfg.channel,
          `@${display}, you already have the maximum number of active requests.`,
        );
        return;
      }
      try {
        // Mark this as a chat-made viewer request so prioritization logic can apply.
        const r = addRequest(id, tags.username, display, { prioritizeViewerInsertion: true });
        await sendChatMessage(
          client,
          cfg.channel,
          `@${display}, added "${r.song.title}" to the request queue!`,
          { skipPrefix: true },
        );
      } catch (e) {
        await sendChatMessage(client, cfg.channel, `@${display}, ${e.message}`);
      }
      return;
    }

    // Add a !queue command that lists up to 5 songs from the top of the request queue.
    if (command === "queue") {
      const queued = getQueue(5);
      if (!queued || !queued.length) {
        await sendChatMessage(
          client,
          cfg.channel,
          `@${display}, the request queue is currently empty.`,
        );
        return;
      }
      const top = queued.slice(0, 5);
      const reply = top
        .map(
          (req) =>
            `ID:${req.song_id} Title:${req.title} Artist:${req.artist || ""} Pack:${req.pack || ""}`,
        )
        .join(" | ");
      await sendChatMessage(client, cfg.channel, `@${display}, ${reply}`);
      return;
    }

    if (command !== SEARCH_COMMAND) return;
    if (!arg) {
      await sendChatMessage(
        client,
        cfg.channel,
        `@${display}, usage: ${PREFIX}${SEARCH_COMMAND} <song title>`,
      );
      return;
    }
    // Perform the search and present results (do not auto-request on unique match).
    const matches = getSongSearchRows(100, arg);

    if (!matches.length) {
      await sendChatMessage(client, cfg.channel, `@${display}, no song matched "${arg}".`);
      return;
    }

    // Present the top 5 matches in the requested compact format.
    const top = matches.slice(0, 5);
    const reply = top
      .map(
        (song) =>
          `ID:${song.id} Title:${song.title} Artist:${song.artist || ""} Pack:${song.pack || ""}`,
      )
      .join(" | ");

    await sendChatMessage(client, cfg.channel, `@${display}, ${reply}`, {
      maxLength: TWITCH_MAX_MESSAGE_LENGTH,
    });
  });

  // Incoming temp-mod nomination replies are handled exclusively through the
  // EventSub user.whisper.message subscription; IRC whisper delivery is no
  // longer used by Twitch.

  // Start the EventSub WebSocket client so incoming whisper replies
  // (temp-mod Y/N) keep arriving. Non-blocking: the client reconnects
  // independently of the chat client, and it is restarted automatically on
  // token refresh (which re-runs this function).
  startEventSubClient(cfg).catch((e) => {
    console.error("Failed to start EventSub client:", e && e.message ? e.message : e);
  });

  // Start periodic cleanup of chat users and pending nominations
  startChatUsersCleanup();

  // Schedule a refresh if we have expiry information
  scheduleTwitchRefresh();
}

async function stopTmiClient() {
  try {
    await stopEventSubClient();
  } catch (e) {
    console.error("Failed to stop EventSub client:", e && e.message ? e.message : e);
  }
  if (twitchClient) {
    try {
      await twitchClient.disconnect();
    } catch (e) {
      /* ignore */
    }
    twitchClient = null;
  }
  clearInstructionsTimer();
  clearTwitchRefreshTimer();
  clearTempModExpirationTimer();
  stopChatUsersCleanup();
}

// Load config from disk or environment and start client if present.
(function initializeTwitch() {
  // Environment variables take precedence; if present write them to persistent config.
  const envUsername = process.env.TWITCH_USERNAME;
  const envOauth = process.env.TWITCH_OAUTH_TOKEN;
  const envChannel = (process.env.TWITCH_CHANNEL || "").replace(/^#/, "");
  const envClientId = process.env.TWITCH_CLIENT_ID || null;
  const envClientSecret = process.env.TWITCH_CLIENT_SECRET || null;

  if (envUsername && envOauth && envChannel) {
    saveTwitchConfig({
      username: envUsername,
      accessToken: String(envOauth).replace(/^oauth:/, ""),
      channel: envChannel,
      clientId: envClientId,
      clientSecret: envClientSecret,
    });
  }

  const cfg = loadTwitchConfig();
  if (cfg && cfg.accessToken && cfg.channel) {
    startTmiClient(cfg);
    scheduleTwitchRefresh();
  } else {
    console.warn(
      "Twitch bot disabled: set TWITCH_USERNAME, TWITCH_OAUTH_TOKEN and TWITCH_CHANNEL, or use the control panel to connect.",
    );
  }
})();

// Control-panel API endpoints for OAuth flow.
if (true) {
  // These endpoints are registered inside createApi when options.control is true.
  // We'll attach handlers below by decorating createApi's control block. To do this,
  // monkey-patch createApi by re-opening the control-app handlers earlier is not necessary;
  // instead, re-register routes on a new express.Router when control app is created.
  // However, for simplicity, add a middleware that will be used in the control app.
}

// Attach control-specific Twitch endpoints when control mode is initialized.
// Find place where createApi registers control routes and add more routes there.
(function augmentControlApi() {
  // We will patch the createApi function's behavior by adding routes to controlApp after it's created.
  // The actual controlApp is created later; expose a small helper on exports to allow adding routes then.
  // Instead, monkey-patch express.static stack by adding a small property so we can find controlApp.
})();

// Note: The control API endpoints will be attached directly below when the control app is available.

// End of Twitch section
