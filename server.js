require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
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

fs.mkdirSync(path.resolve("./data"), { recursive: true });
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

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

    const tokens = normalize(q).split(/\s+/).filter(Boolean);
    const where = [];
    const params = {};
    tokens.forEach((token, i) => {
      const key = `q${i}`;
      params[key] = `%${token}%`;
      where.push(`(
        lower(title) LIKE @${key} OR lower(artist) LIKE @${key}
        OR lower(subtitle) LIKE @${key} OR lower(pack) LIKE @${key}
      )`);
    });

    const rows = db.prepare(`
      SELECT * FROM songs
      WHERE ${where.join(" AND ")}
      ORDER BY title COLLATE NOCASE
      LIMIT ${limit}
    `).all(params);
    res.json(rows.map(songRow));
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
controlApp.listen(CONTROL_PORT, CONTROL_HOST, () => {
  console.log(`Streamer control panel: http://${CONTROL_HOST === "0.0.0.0" ? "localhost" : CONTROL_HOST}:${CONTROL_PORT}`);
});

const twitchUsername = process.env.TWITCH_USERNAME;
const oauthToken = process.env.TWITCH_OAUTH_TOKEN;
const channel = (process.env.TWITCH_CHANNEL || "").replace(/^#/, "");

if (twitchUsername && oauthToken && channel) {
  const client = new tmi.Client({
    options: { debug: false },
    identity: { username: twitchUsername, password: oauthToken },
    channels: [channel]
  });

  client.connect().then(() => console.log(`Twitch bot connected to #${channel}`))
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
      await client.say(channel, `@${display}, usage: ${PREFIX}${REQUEST_COMMAND} <song title or artist>`);
      return;
    }
    if (!canRequest(tags.username)) {
      await client.say(channel, `@${display}, you already have the maximum number of active requests.`);
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
      await client.say(channel, `@${display}, no song matched "${arg}".`);
      return;
    }
    if (matches.length > 1) {
      const names = matches.slice(0, 3).map(s => `"${s.title}"`).join(", ");
      await client.say(channel, `@${display}, multiple matches: ${names}. Be more specific.`);
      return;
    }

    try {
      const r = addRequest(matches[0].id, tags.username, display);
      await client.say(channel, `@${display}, added "${r.song.title}" to the request queue!`);
    } catch (e) {
      await client.say(channel, `@${display}, ${e.message}`);
    }
  });
} else {
  console.warn("Twitch bot disabled: set TWITCH_USERNAME, TWITCH_OAUTH_TOKEN and TWITCH_CHANNEL.");
}
