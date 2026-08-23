require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const https = require("https");
const Database = require("better-sqlite3");
const selfsigned = require("selfsigned");
const tmi = require("tmi.js");
const { scanSongs } = require("./scanner");

const PORT = Number(process.env.PORT || 3000);
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";
const CONTROL_HOST = process.env.CONTROL_HOST || "0.0.0.0";
const SONGS_DIR = path.resolve(process.env.SONGS_DIR || "./Songs");
const PREFIX = process.env.BOT_PREFIX || "!";
const REQUEST_COMMAND = (process.env.REQUEST_COMMAND || "request").toLowerCase();
const MAX_REQUESTS_PER_USER = Number(process.env.MAX_REQUESTS_PER_USER || 2);
const QUEUE_LIMIT = Number(process.env.QUEUE_LIMIT || 25);
const ALLOW_WEB_REQUESTS = String(process.env.ALLOW_WEB_REQUESTS).toLowerCase() === "true";
const CONTROL_PASSWORD = process.env.CONTROL_PASSWORD || "";
const CONTROL_TLS_DIR = path.resolve("./data/control-panel");
const CONTROL_TLS_KEY_PATH = path.join(CONTROL_TLS_DIR, "key.pem");
const CONTROL_TLS_CERT_PATH = path.join(CONTROL_TLS_DIR, "cert.pem");

fs.mkdirSync(path.resolve("./data"), { recursive: true });

function getControlTlsOptions() {
  fs.mkdirSync(CONTROL_TLS_DIR, { recursive: true });
  if (fs.existsSync(CONTROL_TLS_KEY_PATH) && fs.existsSync(CONTROL_TLS_CERT_PATH)) {
    return {
      key: fs.readFileSync(CONTROL_TLS_KEY_PATH, "utf8"),
      cert: fs.readFileSync(CONTROL_TLS_CERT_PATH, "utf8")
    };
  }

  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    { type: 7, ip: "::1" },
    { type: 2, value: "0.0.0.0" },
    { type: 2, value: "127.0.0.1" }
  ];
  if (CONTROL_HOST && CONTROL_HOST !== "0.0.0.0") {
    const ipLike = /^\d+(?:\.\d+){3}$/.test(CONTROL_HOST);
    altNames.push(ipLike ? { type: 7, ip: CONTROL_HOST } : { type: 2, value: CONTROL_HOST });
  }
  if (HOST && HOST !== "0.0.0.0") {
    const ipLike = /^\d+(?:\.\d+){3}$/.test(HOST);
    altNames.push(ipLike ? { type: 7, ip: HOST } : { type: 2, value: HOST });
  }

  const cert = selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    {
      algorithm: "sha256",
      keySize: 2048,
      days: 365,
      extensions: [{ name: "subjectAltName", altNames }]
    }
  );

  fs.writeFileSync(CONTROL_TLS_KEY_PATH, cert.private);
  fs.writeFileSync(CONTROL_TLS_CERT_PATH, cert.cert);

  return { key: cert.private, cert: cert.cert };
}
const db = new Database(path.resolve("./data/stepmania.db"));
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
  song_id INTEGER NOT NULL REFERENCES songs(id),
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
`);

function refreshDatabase() {
  console.log(`Scanning StepMania songs: ${SONGS_DIR}`);
  const result = scanSongs(SONGS_DIR, db);
  console.log(`Scan complete: ${result.songs} songs, ${result.charts} charts.`);
  return result;
}
refreshDatabase();

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
    .replace(/[ÆŒØÞ]/g, ch => ({
      "Æ": "AE",
      "Œ": "OE",
      "Ø": "O",
      "Þ": "TH"
    }[ch]))
    .replace(/[\u00A0]/g, " ");
}

function normalize(s) {
  return transliterateLatin(s)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function levenshteinDistance(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function fuzzyTokenMatches(queryToken, valueToken) {
  if (!queryToken || !valueToken) return false;
  if (valueToken.includes(queryToken)) return true;
  if (queryToken.includes(valueToken) || valueToken.includes(queryToken)) return true;
  const distance = levenshteinDistance(queryToken, valueToken);
  const allowedDistance = Math.max(1, Math.min(2, Math.floor(queryToken.length * 0.25), Math.floor(valueToken.length * 0.25)));
  return distance <= allowedDistance;
}

function songMatchesQuery(song, query) {
  const q = normalize(query);
  if (!q) return true;

  const candidateFields = [
    song.title,
    song.subtitle,
    song.artist,
    song.pack,
    [song.title, song.subtitle, song.artist, song.pack].join(" ")
  ].map((value) => normalize(value));

  const qString = q.trim();
  if (candidateFields.some((field) => field.includes(qString))) {
    return true;
  }

  const qTokens = qString.split(/\s+/).filter(Boolean);
  if (!qTokens.length) return true;

  return qTokens.every((token) => {
    return candidateFields.some((field) => {
      const fieldTokens = field.split(/\s+/).filter(Boolean);
      if (!fieldTokens.length) return false;
      if (fieldTokens.some((fieldToken) => fuzzyTokenMatches(token, fieldToken))) return true;
      return fieldTokens.some((fieldToken) => fieldToken.startsWith(token.slice(0, 2)) && levenshteinDistance(token, fieldToken) <= 2);
    });
  });
}

function getSongSearchRows(limit = 25, query = "") {
  const rows = db.prepare(`SELECT * FROM songs ORDER BY title COLLATE NOCASE`).all();
  const filtered = query ? rows.filter((row) => songMatchesQuery(row, query)) : rows;
  return filtered.slice(0, Math.max(1, limit));
}

function getQueue(limit = QUEUE_LIMIT) {
  return db.prepare(`
    SELECT r.id, r.requested_by, r.requested_display, r.status, r.created_at,
           r.started_at, r.completed_at,
           s.id AS song_id, s.title, s.subtitle, s.artist, s.pack, s.music
    FROM requests r JOIN songs s ON s.id = r.song_id
    WHERE r.status = 'queued'
    ORDER BY r.created_at ASC
    LIMIT ?
  `).all(limit);
}

function getNowPlaying() {
  return db.prepare(`
    SELECT r.id, r.requested_by, r.requested_display, r.status,
           r.started_at, s.id AS song_id, s.title, s.subtitle, s.artist, s.pack, s.music
    FROM requests r JOIN songs s ON s.id = r.song_id
    WHERE r.status = 'playing'
    ORDER BY r.started_at DESC LIMIT 1
  `).get() || null;
}

function getStats() {
  return {
    songs: db.prepare("SELECT COUNT(*) n FROM songs").get().n,
    charts: db.prepare("SELECT COUNT(*) n FROM charts").get().n,
    queued: db.prepare("SELECT COUNT(*) n FROM requests WHERE status='queued'").get().n,
    playing: db.prepare("SELECT COUNT(*) n FROM requests WHERE status='playing'").get().n
  };
}

function isBlacklisted(songId, username) {
  return !!db.prepare(`
    SELECT id FROM blacklist
    WHERE (song_id = ? AND song_id IS NOT NULL)
       OR (username = ? AND username IS NOT NULL)
    LIMIT 1
  `).get(songId, username);
}

function canRequest(username) {
  const active = db.prepare(`
    SELECT COUNT(*) n FROM requests
    WHERE requested_by = ? AND status IN ('queued','playing')
  `).get(username).n;
  return active < MAX_REQUESTS_PER_USER;
}

function addRequest(songId, username, displayName) {
  const song = db.prepare("SELECT * FROM songs WHERE id=?").get(songId);
  if (!song) throw new Error("Song not found.");

  if (isBlacklisted(songId, username)) {
    throw new Error("That song or viewer is currently blacklisted.");
  }

  const totalQueued = db.prepare(
    "SELECT COUNT(*) n FROM requests WHERE status='queued'"
  ).get().n;
  if (totalQueued >= QUEUE_LIMIT) throw new Error("The request queue is full.");

  if (!canRequest(username)) {
    throw new Error(`You already have the maximum of ${MAX_REQUESTS_PER_USER} active request(s).`);
  }

  const duplicate = db.prepare(`
    SELECT id FROM requests
    WHERE song_id=? AND status IN ('queued','playing')
    LIMIT 1
  `).get(songId);
  if (duplicate) throw new Error("That song is already queued or playing.");

  const info = db.prepare(`
    INSERT INTO requests
      (song_id, requested_by, requested_display, status, created_at)
    VALUES (?, ?, ?, 'queued', ?)
  `).run(songId, username, displayName, Date.now());

  return { id: Number(info.lastInsertRowid), song };
}

function setRequestStatus(id, status) {
  const now = Date.now();
  if (status === "playing") {
    // Only one request may be playing.
    db.prepare(`
      UPDATE requests SET status='completed', completed_at=?
      WHERE status='playing'
    `).run(now);

    const result = db.prepare(`
      UPDATE requests SET status='playing', started_at=?
      WHERE id=? AND status='queued'
    `).run(now, id);
    return result.changes > 0;
  }

  const result = db.prepare(`
    UPDATE requests SET status=?, completed_at=?
    WHERE id=? AND status IN ('queued','playing')
  `).run(status, now, id);
  return result.changes > 0;
}

function nextRequest() {
  const next = db.prepare(`
    SELECT id FROM requests
    WHERE status='queued'
    ORDER BY created_at ASC LIMIT 1
  `).get();
  if (!next) return null;
  setRequestStatus(next.id, "playing");
  return getNowPlaying();
}

function songRow(row) {
  return {
    id: row.id, title: row.title, subtitle: row.subtitle,
    artist: row.artist, genre: row.genre, pack: row.pack,
    music: row.music, filePath: row.file_path,
    charts: db.prepare(`
      SELECT id, chart_type chartType, difficulty, meter
      FROM charts WHERE song_id=? ORDER BY id
    `).all(row.id)
  };
}

function createApi(app, options = {}) {
  app.use(express.json({ limit: "32kb" }));
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

    // Chart-based filters: difficulty, meter range
    const chartWhere = [];
    if (req.query.difficulty) {
      chartWhere.push("difficulty = @difficulty");
      params.difficulty = String(req.query.difficulty);
    }
    const meterMin = (typeof req.query.meterMin !== 'undefined' && req.query.meterMin !== '') ? Number(req.query.meterMin) : null;
    const meterMax = (typeof req.query.meterMax !== 'undefined' && req.query.meterMax !== '') ? Number(req.query.meterMax) : null;
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

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const sort = (new Set(["title","artist","pack","last_modified"]).has(req.query.sort)) ? req.query.sort : "title";
    const order = (String(req.query.order || "asc").toLowerCase() === "desc") ? "DESC" : "ASC";
    const orderSql = (sort === "last_modified") ? `ORDER BY ${sort} ${order}` : `ORDER BY ${sort} COLLATE NOCASE ${order}`;

    const baseRows = db.prepare(`SELECT * FROM songs ${whereSql} ${orderSql}`).all(params);
    const q = String(req.query.q || "").trim();
    const rows = q ? baseRows.filter((row) => songMatchesQuery(row, q)) : baseRows;
    const total = rows.length;
    const pageRows = rows.slice(offset, offset + perPage);

    res.json({ songs: pageRows.map(songRow), total, page, perPage });
  });

  app.get("/api/song-filters", (_req, res) => {
    const packs = db.prepare(`
      SELECT pack, COUNT(*) count FROM songs
      WHERE pack IS NOT NULL AND pack != ''
      GROUP BY pack ORDER BY pack COLLATE NOCASE ASC
      LIMIT 200
    `).all();
    const genres = db.prepare(`
      SELECT genre, COUNT(*) count FROM songs
      WHERE genre IS NOT NULL AND genre != ''
      GROUP BY genre ORDER BY genre COLLATE NOCASE ASC
      LIMIT 200
    `).all();

    const difficulties = db.prepare(`
      SELECT difficulty, COUNT(DISTINCT song_id) count FROM charts
      WHERE difficulty IS NOT NULL AND difficulty != ''
      GROUP BY difficulty ORDER BY difficulty COLLATE NOCASE ASC LIMIT 200
    `).all();

    const meters = db.prepare(`
      SELECT CAST(meter AS INTEGER) meter, COUNT(DISTINCT song_id) count FROM charts
      WHERE meter IS NOT NULL AND trim(meter) != ''
      GROUP BY meter ORDER BY meter ASC LIMIT 200
    `).all();

    res.json({ packs, genres, difficulties, meters });
  });

  app.get("/api/queue", (_req, res) => res.json(getQueue()));
  app.get("/api/now-playing", (_req, res) => res.json(getNowPlaying()));

  app.post("/api/request", (req, res) => {
    if (!ALLOW_WEB_REQUESTS && !options.control) {
      return res.status(403).json({ error: "Web requests are disabled. Use Twitch chat." });
    }
    try {
      const r = addRequest(
        Number(req.body.songId),
        String(req.body.username || "web-user").slice(0, 50),
        String(req.body.displayName || req.body.username || "web-user").slice(0, 50)
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
      const auth = String(req.headers.authorization || "");
      const expected = "Basic " + Buffer.from("streamer:" + CONTROL_PASSWORD).toString("base64");
      if (auth !== expected) return res.status(401).set("WWW-Authenticate", 'Basic realm="StepMania Streamer Control"').json({ error: "Authentication required." });
      next();
    });

    app.post("/api/control-login", (_req, res) => res.json({ ok: true }));

    app.post("/api/queue/:id/play", (req, res) => {
      const ok = setRequestStatus(Number(req.params.id), "playing");
      res.json({ ok, nowPlaying: getNowPlaying() });
    });

    app.post("/api/queue/:id/complete", (req, res) => {
      const ok = setRequestStatus(Number(req.params.id), "completed");
      res.json({ ok });
    });

    app.post("/api/queue/:id/skip", (req, res) => {
      const ok = setRequestStatus(Number(req.params.id), "skipped");
      res.json({ ok });
    });

    app.post("/api/queue/next", (_req, res) => {
      res.json({ ok: true, nowPlaying: nextRequest() });
    });

    app.post("/api/queue/clear", (_req, res) => {
      const info = db.prepare(`
        UPDATE requests SET status='skipped', completed_at=?
        WHERE status='queued'
      `).run(Date.now());
      res.json({ ok: true, changed: info.changes });
    });

    app.post("/api/queue/:id/move", (req, res) => {
      // Move within the queue by swapping created_at timestamps.
      const id = Number(req.params.id);
      const direction = req.body.direction === "up" ? -1 : 1;
      const current = db.prepare("SELECT id, created_at FROM requests WHERE id=? AND status='queued'").get(id);
      if (!current) return res.status(404).json({ error: "Queued request not found." });

      const neighbor = direction < 0
        ? db.prepare(`
            SELECT id, created_at FROM requests
            WHERE status='queued' AND created_at < ?
            ORDER BY created_at DESC LIMIT 1
          `).get(current.created_at)
        : db.prepare(`
            SELECT id, created_at FROM requests
            WHERE status='queued' AND created_at > ?
            ORDER BY created_at ASC LIMIT 1
          `).get(current.created_at);

      if (!neighbor) return res.json({ ok: true });

      const tx = db.transaction(() => {
        db.prepare("UPDATE requests SET created_at=? WHERE id=?").run(neighbor.created_at, current.id);
        db.prepare("UPDATE requests SET created_at=? WHERE id=?").run(current.created_at, neighbor.id);
      });
      tx();
      res.json({ ok: true });
    });

    app.post("/api/blacklist/song", (req, res) => {
      const songId = Number(req.body.songId);
      const reason = String(req.body.reason || "Streamer blacklist").slice(0, 200);
      db.prepare(`
        INSERT OR IGNORE INTO blacklist(song_id, username, reason, created_at)
        VALUES (?, NULL, ?, ?)
      `).run(songId, reason, Date.now());
      res.json({ ok: true });
    });

    app.post("/api/blacklist/user", (req, res) => {
      const username = String(req.body.username || "").trim().toLowerCase();
      if (!username) return res.status(400).json({ error: "Username required." });
      const reason = String(req.body.reason || "Streamer blacklist").slice(0, 200);
      db.prepare(`
        INSERT OR IGNORE INTO blacklist(song_id, username, reason, created_at)
        VALUES (NULL, ?, ?, ?)
      `).run(username, reason, Date.now());
      res.json({ ok: true });
    });

    app.get("/api/blacklist", (_req, res) => {
      res.json(db.prepare(`
        SELECT id, song_id songId, username, reason, created_at createdAt
        FROM blacklist ORDER BY created_at DESC
      `).all());
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
        clientId: cfg ? cfg.clientId : null
      });
    });

    app.post("/api/twitch/start-auth", (req, res) => {
      const clientId = String(req.body.clientId || (twitchConfig && twitchConfig.clientId) || "").trim();
      const redirectUri = String(req.body.redirectUri || req.body.redirect || `https://localhost:${CONTROL_PORT}/twitch-callback.html`).trim();
      const scopes = String(req.body.scopes || "chat:read chat:edit");
      if (!clientId || !redirectUri) return res.status(400).json({ error: "clientId and redirectUri are required" });
      const state = Math.random().toString(36).slice(2);
      twitchAuthStates.add(state);
      const url = `https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}`;
      res.json({ url, state });
    });

    app.post("/api/twitch/exchange", async (req, res) => {
      const code = String(req.body.code || "").trim();
      const clientId = String(req.body.clientId || "").trim();
      const clientSecret = String(req.body.clientSecret || "").trim();
      const redirectUri = String(req.body.redirectUri || `https://localhost:${CONTROL_PORT}/twitch-callback.html`).trim();
      const channel = String(req.body.channel || "").trim();
      if (!code || !clientId || !clientSecret) return res.status(400).json({ error: "code, clientId and clientSecret are required" });
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
          body: params
        });
        const tokenJson = await tokenResp.json();
        if (!tokenJson.access_token) return res.status(400).json({ error: "Token exchange failed", details: tokenJson });

        // Fetch user info
        const userResp = await globalThis.fetch("https://api.twitch.tv/helix/users", {
          headers: { Authorization: `Bearer ${tokenJson.access_token}`, "Client-Id": clientId }
        });
        const userJson = await userResp.json();
        const login = (userJson && userJson.data && userJson.data[0] && userJson.data[0].login) || null;
        const finalChannel = channel || login;

        const cfg = {
          clientId,
          clientSecret,
          accessToken: tokenJson.access_token,
          refreshToken: tokenJson.refresh_token,
          expiresAt: tokenJson.expires_in ? Date.now() + (Number(tokenJson.expires_in) * 1000) : null,
          username: login,
          channel: finalChannel
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
publicApp.use(express.static(path.join(__dirname, "public")));
createApi(publicApp);
publicApp.listen(PORT, HOST, () => {
  console.log(`Public request site: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});

const controlApp = express();
controlApp.use(express.static(path.join(__dirname, "control")));
createApi(controlApp, { control: true });
const controlTlsOptions = getControlTlsOptions();
https.createServer(controlTlsOptions, controlApp).listen(CONTROL_PORT, CONTROL_HOST, () => {
  const hostLabel = CONTROL_HOST === "0.0.0.0" ? "localhost" : CONTROL_HOST;
  console.log(`Streamer control panel: https://${hostLabel}:${CONTROL_PORT}`);
});

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

function clearTwitchRefreshTimer() {
  if (twitchRefreshTimer) {
    clearTimeout(twitchRefreshTimer);
    twitchRefreshTimer = null;
  }
}

async function refreshTwitchToken() {
  const cfg = twitchConfig || loadTwitchConfig();
  if (!cfg || !cfg.refreshToken || !cfg.clientId || !cfg.clientSecret) {
    console.warn('Twitch token refresh skipped: missing refresh token or client credentials.');
    return false;
  }

  try {
    console.log('Refreshing Twitch access token...');
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', cfg.refreshToken);
    params.append('client_id', cfg.clientId);
    params.append('client_secret', cfg.clientSecret);

    const resp = await globalThis.fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const json = await resp.json();
    if (!json.access_token) {
      console.error('Twitch refresh failed:', json);
      return false;
    }

    cfg.accessToken = json.access_token;
    if (json.refresh_token) cfg.refreshToken = json.refresh_token;
    cfg.expiresAt = json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : null;
    saveTwitchConfig(cfg);

    // restart client with new token
    await startTmiClient(cfg);
    scheduleTwitchRefresh();
    console.log('Twitch access token refreshed.');
    return true;
  } catch (e) {
    console.error('Error refreshing Twitch token:', e.message || e);
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
    refreshTwitchToken().catch(err => console.error('Scheduled refresh failed:', err));
  }, refreshIn);
}

async function startTmiClient(cfg) {
  if (!cfg || !cfg.accessToken || !cfg.channel) {
    console.warn("Twitch client not started: missing config.");
    return;
  }

  if (twitchClient) {
    try { await twitchClient.disconnect(); } catch (e) {}
    twitchClient = null;
  }

  const identityPassword = String(cfg.accessToken).startsWith("oauth:") ? cfg.accessToken : `oauth:${cfg.accessToken}`;
  const client = new tmi.Client({
    options: { debug: false },
    identity: { username: cfg.username || (cfg.channel || "").replace(/^#/, ""), password: identityPassword },
    channels: [cfg.channel]
  });

  twitchClient = client;
  client.connect().then(() => console.log(`Twitch bot connected to #${cfg.channel}`))
    .catch(err => console.error("Twitch connection failed:", err.message));

  client.on("message", async (_channel, tags, message, self) => {
    if (self || !message.startsWith(PREFIX)) return;

    const body = message.slice(PREFIX.length).trim();
    const space = body.indexOf(" ");
    const command = (space === -1 ? body : body.slice(0, space)).toLowerCase();
    const arg = space === -1 ? "" : body.slice(space + 1).trim();
    const display = tags["display-name"] || tags.username;

    if (command !== REQUEST_COMMAND) return;
    if (!arg) {
      await client.say(cfg.channel, `@${display}, usage: ${PREFIX}${REQUEST_COMMAND} <song title or artist>`);
      return;
    }
    if (!canRequest(tags.username)) {
      await client.say(cfg.channel, `@${display}, you already have the maximum number of active requests.`);
      return;
    }

    const tokens = normalize(arg).split(/\s+/).filter(Boolean);
    const clauses = [];
    const params = {};
    tokens.forEach((token, i) => {
      const key = `q${i}`;
      params[key] = `%${token}%`;
      clauses.push(`(
        lower(title) LIKE @${key} OR lower(artist) LIKE @${key}
        OR lower(subtitle) LIKE @${key} OR lower(pack) LIKE @${key}
      )`);
    });

    const matches = db.prepare(`
      SELECT * FROM songs WHERE ${clauses.join(" AND ")}
      ORDER BY CASE WHEN lower(title)=lower(@exact) THEN 0 ELSE 1 END,
               title COLLATE NOCASE
      LIMIT 5
    `).all({ ...params, exact: arg });

    if (!matches.length) {
      await client.say(cfg.channel, `@${display}, no song matched "${arg}".`);
      return;
    }
    if (matches.length > 1) {
      const names = matches.slice(0, 3).map(s => `"${s.title}"`).join(", ");
      await client.say(cfg.channel, `@${display}, multiple matches: ${names}. Be more specific.`);
      return;
    }

    try {
      const r = addRequest(matches[0].id, tags.username, display);
      await client.say(cfg.channel, `@${display}, added "${r.song.title}" to the request queue!`);
    } catch (e) {
      await client.say(cfg.channel, `@${display}, ${e.message}`);
    }
  });
  // Schedule a refresh if we have expiry information
  scheduleTwitchRefresh();
}

async function stopTmiClient() {
  if (twitchClient) {
    try { await twitchClient.disconnect(); } catch (e) { /* ignore */ }
    twitchClient = null;
  }
  clearTwitchRefreshTimer();
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
    saveTwitchConfig({ username: envUsername, accessToken: String(envOauth).replace(/^oauth:/, ""), channel: envChannel, clientId: envClientId, clientSecret: envClientSecret });
  }

  const cfg = loadTwitchConfig();
  if (cfg && cfg.accessToken && cfg.channel) {
    startTmiClient(cfg);
    scheduleTwitchRefresh();
  } else {
    console.warn("Twitch bot disabled: set TWITCH_USERNAME, TWITCH_OAUTH_TOKEN and TWITCH_CHANNEL, or use the control panel to connect.");
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
