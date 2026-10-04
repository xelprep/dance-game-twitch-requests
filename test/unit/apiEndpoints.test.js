process.env.NODE_ENV = "test";
process.env.SKIP_APP_STARTUP = "1";
process.env.CONTROL_PASSWORD = "test-control-password";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const sharp = require("sharp");
process.env.ARTWORK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dance-artwork-api-cache-"));

const {
  announceTempModNomination,
  createApi,
  createTwitchAuthTransaction,
  consumeTwitchAuthTransaction,
  db,
  formatVisibleUsername,
  getQueue,
  hashModeratorPassword,
  setSetting,
} = require("../../server.js");

function resetSettings() {
  db.prepare("DELETE FROM settings").run();
}

function startPublicModeratorApp() {
  const app = express();
  createApi(app, { moderator: true });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function startControlApp() {
  const app = express();
  createApi(app, { control: true });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test("rate limiter returns 429 and retry headers after the configured allowance", async () => {
  const app = express();
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 1,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Please slow down." },
    }),
  );
  app.get("/limited", (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });

  try {
    const url = `http://127.0.0.1:${server.address().port}/limited`;
    const allowed = await fetch(url);
    const limited = await fetch(url);
    assert.equal(allowed.status, 200);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
    assert.ok(limited.headers.get("ratelimit"));
    assert.deepEqual(await limited.json(), { error: "Too many requests. Please slow down." });
  } finally {
    server.close();
  }
});

test("Twitch OAuth transactions retain credentials only server-side and are one-time/expiring", () => {
  const credentials = {
    clientId: "client-id",
    clientSecret: "client-secret",
    channel: "channel-name",
    redirectUri: "https://localhost:3001/twitch-callback.html",
  };
  const state = createTwitchAuthTransaction(credentials, 1000);
  assert.notEqual(state, "client-secret");
  assert.deepEqual(consumeTwitchAuthTransaction(state, 1001), {
    ...credentials,
    expiresAt: 601_000,
  });
  assert.equal(consumeTwitchAuthTransaction(state, 1002), null);

  const expiredState = createTwitchAuthTransaction(credentials, 1000);
  assert.equal(consumeTwitchAuthTransaction(expiredState, 601_000), null);
});

test("Twitch browser flow never stores the client secret in Web Storage", () => {
  const fs = require("node:fs");
  const controlApp = fs.readFileSync(path.join(__dirname, "../../control/app.js"), "utf8");
  const callback = fs.readFileSync(
    path.join(__dirname, "../../control/twitch-callback.html"),
    "utf8",
  );
  assert.doesNotMatch(controlApp, /sessionStorage\.setItem\([^\n]*clientSecret/i);
  assert.doesNotMatch(callback, /sessionStorage\.(?:getItem|setItem)\([^\n]*clientSecret/i);
});

test("public API search returns song rows and supports basic filtering", async () => {
  resetSettings();
  const server = await startPublicModeratorApp();
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/search?q=queue`, {
      headers: { Accept: "application/json" },
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(json));
  } finally {
    server.close();
  }
});

test("song search exposes only generated artwork URL metadata", async () => {
  resetSettings();
  const artworkKey = `v1-${"a".repeat(64)}`;
  const insert = db.prepare(
    "INSERT INTO songs (file_path, title, last_modified, artwork_key, artwork_kind) VALUES (?, ?, 0, ?, ?)",
  );
  const info = insert.run("artwork-api-test.sm", "Artwork Metadata Test", artworkKey, "banner");
  const server = await startPublicModeratorApp();

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/search?q=Artwork%20Metadata%20Test`,
    );
    const songs = await response.json();
    assert.equal(response.status, 200);
    assert.equal(songs[0].artworkUrl, `/artwork/${artworkKey}.webp`);
    assert.equal(songs[0].artworkKind, "banner");
  } finally {
    server.close();
    db.prepare("DELETE FROM songs WHERE id = ?").run(info.lastInsertRowid);
  }
});

test("queue rows expose artwork URLs for the request overlay", () => {
  const artworkKey = `v1-${"c".repeat(64)}`;
  const song = db
    .prepare(
      "INSERT INTO songs (file_path, title, last_modified, artwork_key, artwork_kind) VALUES (?, ?, 0, ?, ?)",
    )
    .run("artwork-queue-test.sm", "Artwork Queue Test", artworkKey, "pack");
  const request = db
    .prepare(
      "INSERT INTO requests (song_id, requested_by, requested_display, status, created_at) VALUES (?, ?, ?, 'queued', ?)",
    )
    .run(song.lastInsertRowid, "viewer", "Viewer", Date.now());

  try {
    const queueRow = getQueue(10000).find((row) => row.id === request.lastInsertRowid);
    assert.equal(queueRow.artworkUrl, `/artwork/${artworkKey}.webp`);
    assert.equal(queueRow.artworkKind, "pack");
    assert.equal(Object.hasOwn(queueRow, "artwork_key"), false);
  } finally {
    db.prepare("DELETE FROM requests WHERE id = ?").run(request.lastInsertRowid);
    db.prepare("DELETE FROM songs WHERE id = ?").run(song.lastInsertRowid);
  }
});

test("now-playing still includes chart difficulty and meter", async () => {
  const song = db
    .prepare("INSERT INTO songs (file_path, title, last_modified) VALUES (?, ?, 0)")
    .run("overlay-chart-test.sm", "Overlay Chart Test");
  const chart = db
    .prepare("INSERT INTO charts (song_id, chart_type, difficulty, meter) VALUES (?, ?, ?, ?)")
    .run(song.lastInsertRowid, "dance-single", "Expert", "12");
  const request = db
    .prepare(
      "INSERT INTO requests (song_id, chart_id, requested_by, requested_display, status, created_at, started_at) VALUES (?, ?, ?, ?, 'playing', ?, ?)",
    )
    .run(song.lastInsertRowid, chart.lastInsertRowid, "viewer", "Viewer", Date.now(), Date.now());
  const server = await startPublicModeratorApp();

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/now-playing`);
    const nowPlaying = await response.json();
    assert.equal(response.status, 200);
    assert.equal(nowPlaying.chart.difficulty, "Expert");
    assert.equal(nowPlaying.chart.meter, "12");
  } finally {
    server.close();
    db.prepare("DELETE FROM requests WHERE id = ?").run(request.lastInsertRowid);
    db.prepare("DELETE FROM songs WHERE id = ?").run(song.lastInsertRowid);
  }
});

test("artwork controls are disabled by default and reject processing until enabled", async () => {
  resetSettings();
  const server = await startControlApp();
  const headers = {
    Authorization: "Basic " + Buffer.from("streamer:test-control-password").toString("base64"),
    "Content-Type": "application/json",
  };

  try {
    const settingsResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/control/settings`,
      {
        headers,
      },
    );
    const settings = await settingsResponse.json();
    assert.equal(settings.artworkEnabled, false);

    const processResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/control/artwork/process`,
      { method: "POST", headers, body: JSON.stringify({ force: false }) },
    );
    assert.equal(processResponse.status, 409);
  } finally {
    server.close();
  }
});

test("enabled artwork control starts a job and exposes its status", async () => {
  resetSettings();
  setSetting("artworkEnabled", true);
  const server = await startControlApp();
  const headers = {
    Authorization: "Basic " + Buffer.from("streamer:test-control-password").toString("base64"),
    "Content-Type": "application/json",
  };

  try {
    const startResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/control/artwork/process`,
      { method: "POST", headers, body: JSON.stringify({ force: false }) },
    );
    assert.equal(startResponse.status, 200);
    assert.equal((await startResponse.json()).started, true);

    const statusResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/control/artwork/status`,
      { headers },
    );
    assert.equal(statusResponse.status, 200);
    assert.equal(typeof (await statusResponse.json()).running, "boolean");
  } finally {
    server.close();
  }
});

test("artwork route rejects invalid cache keys", async () => {
  const server = await startPublicModeratorApp();
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/artwork/not-a-key.webp`,
    );
    assert.equal(response.status, 404);
  } finally {
    server.close();
  }
});

test("artwork route serves only generated WebP assets with immutable caching", async () => {
  const artworkKey = `v1-${"b".repeat(64)}`;
  const imagePath = path.join(process.env.ARTWORK_CACHE_DIR, `${artworkKey}.webp`);
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  await sharp({ create: { width: 2, height: 2, channels: 3, background: "#336699" } })
    .webp()
    .toFile(imagePath);
  const server = await startPublicModeratorApp();

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/artwork/${artworkKey}.webp`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/webp/);
    assert.match(response.headers.get("cache-control"), /immutable/);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  } finally {
    server.close();
  }
});

test("moderator settings API rejects invalid auth and accepts valid moderator auth", async () => {
  resetSettings();
  setSetting("moderatorEnabled", true);
  setSetting("moderatorCredentials", [
    { username: "alice", passwordHash: hashModeratorPassword("hunter2") },
  ]);

  const server = await startPublicModeratorApp();
  const port = server.address().port;

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/moderator/settings`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/api/moderator/settings`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Basic " + Buffer.from("alice:hunter2").toString("base64"),
      },
    });

    assert.equal(authorized.status, 200);
    const payload = await authorized.json();
    assert.ok(payload && typeof payload === "object");
  } finally {
    server.close();
  }
});

test("control settings API stores valid streamer credentials and updates settings", async () => {
  resetSettings();
  const server = await startControlApp();
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/control/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from("streamer:test-control-password").toString("base64"),
      },
      body: JSON.stringify({
        prioritizeViewerRequests: true,
        chatRequestsEnabled: true,
        chatRequestsRequireRole: "follower",
        moderatorEnabled: true,
        moderatorUsername: "alice",
        moderatorCredentials: [{ username: "alice", password: "hunter2" }],
        instructionsMinutes: 10,
        artworkEnabled: true,
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.moderatorEnabled, true);
    assert.equal(payload.artworkEnabled, true);
  } finally {
    server.close();
  }
});

test("control settings validate and persist overlay style without changing other settings", async () => {
  resetSettings();
  setSetting("artworkEnabled", true);
  const server = await startControlApp();
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Basic " + Buffer.from("streamer:test-control-password").toString("base64"),
  };

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/control/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        overlayStyle: {
          font: "url(https://example.com/font)",
          fontSize: 999,
          textColor: "red",
          position: "not-a-position",
          backgroundOpacity: -1,
          margin: 999,
          arbitraryCss: "body { display: none }",
        },
      }),
    });

    assert.equal(response.status, 200);
    const settings = await response.json();
    assert.equal(settings.artworkEnabled, true);
    assert.equal(settings.overlayStyle.font, "default");
    assert.equal(settings.overlayStyle.fontSize, 128);
    assert.equal(settings.overlayStyle.textColor, "#ffffff");
    assert.equal(settings.overlayStyle.position, "bottom-left");
    assert.equal(settings.overlayStyle.maxWidth, "auto");
    assert.equal(settings.overlayStyle.backgroundOpacity, 0);
    assert.equal(settings.overlayStyle.margin, 120);
    assert.equal(Object.hasOwn(settings.overlayStyle, "arbitraryCss"), false);
  } finally {
    server.close();
  }
});

test("overlay settings normalize v2 fonts, canvas, density, and section styles", async () => {
  resetSettings();
  const server = await startControlApp();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/control/settings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from("streamer:test-control-password").toString("base64"),
    },
    body: JSON.stringify({
      overlayStyle: {
        font: "lora",
        canvasWidth: 1080,
        canvasHeight: 1920,
        queueEntries: 8,
        safeArea: 12,
        sections: {
          title: { color: "#12ABEF", fontSize: 140 },
          requester: { color: "invalid", fontSize: 8 },
        },
      },
    }),
  });

  try {
    assert.equal(response.status, 200);
    const settings = await response.json();
    assert.equal(settings.overlayStyle.font, "lora");
    assert.equal(settings.overlayStyle.canvasWidth, 1080);
    assert.equal(settings.overlayStyle.canvasHeight, 1920);
    assert.equal(settings.overlayStyle.queueEntries, 8);
    assert.equal(settings.overlayStyle.safeArea, 12);
    assert.equal(settings.overlayStyle.sections.title.color, "#12abef");
    assert.equal(settings.overlayStyle.sections.title.fontSize, 128);
    assert.equal(settings.overlayStyle.sections.requester.color, "#ffffff");
    assert.equal(settings.overlayStyle.sections.requester.fontSize, 16);
  } finally {
    server.close();
  }
});

test("public overlay settings expose only the normalized style", async () => {
  resetSettings();
  setSetting("moderatorCredentials", [{ username: "private-user", passwordHash: "private-hash" }]);
  setSetting("host", "192.168.1.20");
  setSetting("overlayStyle", { fontSize: 36, textColor: "#12ABEF" });
  const server = await startPublicModeratorApp();

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/overlay/settings`);
    const style = await response.json();
    assert.equal(response.status, 200);
    assert.equal(style.fontSize, 36);
    assert.equal(style.textColor, "#12abef");
    assert.equal(style.position, "bottom-left");
    assert.equal(Object.hasOwn(style, "moderatorCredentials"), false);
    assert.equal(Object.hasOwn(style, "host"), false);
  } finally {
    server.close();
  }
});

test("public overlay settings preserve the existing appearance when no style is stored", async () => {
  resetSettings();
  const server = await startPublicModeratorApp();

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/overlay/settings`);
    const style = await response.json();
    assert.equal(response.status, 200);
    assert.equal(style.font, "default");
    assert.equal(style.fontSize, 48);
    assert.equal(style.textColor, "#ffffff");
    assert.equal(style.backgroundEnabled, false);
    assert.equal(style.padding, 0);
    assert.equal(style.margin, 0);
    assert.equal(style.position, "bottom-left");
  } finally {
    server.close();
  }
});

test("overlay profiles are authenticated, bounded, and normalized", async () => {
  resetSettings();
  const server = await startControlApp();
  const publicServer = await startPublicModeratorApp();
  const url = `http://127.0.0.1:${server.address().port}/api/control/overlay/profiles`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Basic " + Buffer.from("streamer:test-control-password").toString("base64"),
  };

  try {
    const publicResponse = await fetch(
      `http://127.0.0.1:${publicServer.address().port}/api/control/overlay/profiles`,
    );
    assert.equal(publicResponse.status, 404);

    const unauthorized = await fetch(url);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        profiles: [
          { id: "neon", name: "Neon", style: { font: "lora", fontSize: 40 } },
          { id: "duplicate", name: " neon ", style: { fontSize: 72 } },
        ],
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.profiles.length, 1);
    assert.equal(result.profiles[0].style.font, "lora");
    assert.equal(result.profiles[0].style.fontSize, 40);
    assert.equal(result.profiles[0].style.canvasWidth, 1920);

    const tooMany = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        profiles: Array.from({ length: 21 }, (_, index) => ({ name: `p${index}` })),
      }),
    });
    assert.equal(tooMany.status, 400);
  } finally {
    server.close();
    publicServer.close();
  }
});

test("saved overlay styles are pushed on the dedicated SSE stream", async () => {
  resetSettings();
  const publicServer = await startPublicModeratorApp();
  const controlServer = await startControlApp();
  const streamUrl = `http://127.0.0.1:${publicServer.address().port}/overlay/style/stream`;
  let reader;

  try {
    const stream = await fetch(streamUrl);
    reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const initial = decoder.decode((await reader.read()).value);
    assert.match(initial, /"fontSize":48/);

    const response = await fetch(
      `http://127.0.0.1:${controlServer.address().port}/api/control/settings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Basic " + Buffer.from("streamer:test-control-password").toString("base64"),
        },
        body: JSON.stringify({ overlayStyle: { fontSize: 64 } }),
      },
    );
    assert.equal(response.status, 200);
    const updated = decoder.decode((await reader.read()).value);
    assert.match(updated, /"fontSize":64/);
  } finally {
    if (reader) await reader.cancel();
    publicServer.close();
    controlServer.close();
  }
});

test("announceTempModNomination sends a chat reminder with the username and duration", async () => {
  const calls = [];

  await announceTempModNomination({
    username: "alice",
    displayName: "Alice",
    tempModTime: 12,
    client: {
      say: async (channel, message) => {
        calls.push({ channel, message });
      },
    },
    channel: "#testchannel",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, "testchannel");
  assert.match(
    calls[0].message,
    /^!\s*@Alice, you have been nominated to moderate the request queue for 12 minutes/i,
  );
  assert.match(calls[0].message, /please check your Twitch whispers for details/i);
});

test("formatVisibleUsername prefers a chat user's chosen capitalization when present", () => {
  assert.equal(formatVisibleUsername("willyj", "WillyJ"), "WillyJ");
  assert.equal(formatVisibleUsername("willyj", "willyj"), "willyj");
  assert.equal(formatVisibleUsername("willyj", ""), "willyj");
});

test("song-filters meters dedupe leading-zero variants of the same meter", async () => {
  resetSettings();
  const titles = ["Zero Meter Song", "Plain Meter Song"];
  const insertSong = (title, meter) => {
    const song = db
      .prepare("INSERT INTO songs (file_path, title, last_modified) VALUES (?, ?, 0)")
      .run(`${title}.sm`, title);
    db.prepare(
      "INSERT INTO charts (song_id, chart_type, difficulty, meter) VALUES (?, 'dance-single', 'Easy', ?)",
    ).run(song.lastInsertRowid, meter);
  };
  insertSong(titles[0], "06");
  insertSong(titles[1], "6");

  const server = await startPublicModeratorApp();
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/song-filters`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    const meterEntries = json.meters.filter((entry) => entry.meter === 6);
    assert.equal(meterEntries.length, 1);
    assert.equal(meterEntries[0].count, 2);
  } finally {
    server.close();
    db.prepare(
      "DELETE FROM charts WHERE song_id IN (SELECT id FROM songs WHERE title IN (?, ?))",
    ).run(...titles);
    db.prepare("DELETE FROM songs WHERE title IN (?, ?)").run(...titles);
  }
});

test("songs API marks queued and playing songs when markActive is set", async () => {
  resetSettings();
  const titles = ["Mark Queued Song", "Mark Playing Song", "Plain Song"];
  const songIds = titles.map(
    (title) =>
      db
        .prepare("INSERT INTO songs (file_path, title, last_modified) VALUES (?, ?, 0)")
        .run(`${title}.sm`, title).lastInsertRowid,
  );
  const insertRequest = (songId, status) =>
    db
      .prepare(
        "INSERT INTO requests (song_id, requested_by, requested_display, status, created_at) VALUES (?, 'tester', 'Tester', ?, 0)",
      )
      .run(songId, status);
  insertRequest(songIds[0], "queued");
  insertRequest(songIds[1], "playing");

  const server = await startPublicModeratorApp();
  const port = server.address().port;

  try {
    const all = await (
      await fetch(`http://127.0.0.1:${port}/api/songs?perPage=100`, {
        headers: { Accept: "application/json" },
      })
    ).json();
    assert.ok(titles.every((title) => all.songs.some((song) => song.title === title)));

    const res = await fetch(`http://127.0.0.1:${port}/api/songs?perPage=100&markActive=1`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    const byTitle = Object.fromEntries(json.songs.map((song) => [song.title, song]));
    // All songs remain visible; queued/playing ones are flagged as active.
    assert.ok(titles.every((title) => title in byTitle));
    assert.equal(byTitle[titles[0]].active, true);
    assert.equal(byTitle[titles[1]].active, true);
    assert.equal(byTitle[titles[2]].active, false);
    assert.equal(json.total, all.total);
  } finally {
    server.close();
    db.prepare("DELETE FROM requests WHERE song_id IN (?, ?, ?)").run(...songIds);
    db.prepare("DELETE FROM songs WHERE id IN (?, ?, ?)").run(...songIds);
  }
});

test("songs API filters by BPM range and duration range", async () => {
  resetSettings();
  const insertSong = (title, bpmMin, bpmMax, coreBpm, duration) =>
    db
      .prepare(
        "INSERT INTO songs (file_path, title, last_modified, bpm_min, bpm_max, core_bpm, duration_seconds) VALUES (?, ?, 0, ?, ?, ?, ?)",
      )
      .run(`${title}.sm`, title, bpmMin, bpmMax, coreBpm, duration).lastInsertRowid;

  const songIds = [
    insertSong("Bpm Filter 100", 100, 100, 100, 120),
    insertSong("Bpm Filter 140", 120, 150, 140, 300),
    insertSong("Bpm Filter No Data", null, null, null, null),
  ];
  const titles = ["Bpm Filter 100", "Bpm Filter 140", "Bpm Filter No Data"];

  const server = await startPublicModeratorApp();
  const port = server.address().port;
  const getTitles = async (query) => {
    const url = new URL(`http://127.0.0.1:${port}/api/songs`);
    url.searchParams.set("perPage", "100");
    for (const [key, value] of new URLSearchParams(query.replace(/^\?/, ""))) {
      url.searchParams.set(key, value);
    }
    const json = await (
      await fetch(url, {
        headers: { Accept: "application/json" },
      })
    ).json();
    return {
      titles: json.songs.map((song) => song.title),
      songs: Object.fromEntries(json.songs.map((song) => [song.title, song])),
    };
  };

  try {
    const all = await getTitles("");
    assert.ok(titles.every((title) => all.titles.includes(title)));
    assert.equal(all.songs[titles[0]].bpmMin, 100);
    assert.equal(all.songs[titles[1]].coreBpm, 140);
    assert.equal(all.songs[titles[2]].durationSeconds, null);

    // Core BPM filter: core_bpm=140 is matched by [110, 160].
    assert.deepEqual((await getTitles("?bpmMin=110&bpmMax=160")).titles, [titles[1]]);
    // One-sided windows keep both 100 and 140, never the NULL row.
    assert.deepEqual((await getTitles("?bpmMin=100")).titles, [titles[0], titles[1]]);
    assert.deepEqual((await getTitles("?bpmMax=100")).titles, [titles[0]]);

    // Duration range filters exclude NULL durations.
    assert.deepEqual((await getTitles("?durationMin=100&durationMax=200")).titles, [titles[0]]);
    assert.deepEqual((await getTitles("?durationMin=200")).titles, [titles[1]]);
    assert.deepEqual((await getTitles("?durationMax=100")).titles, []);
  } finally {
    server.close();
    db.prepare("DELETE FROM songs WHERE id IN (?, ?, ?)").run(...songIds);
  }
});

test("control API can generate a valid course for a same-style queue and rejects mixed-style queues", async () => {
  resetSettings();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "course-generation-"));
  const originalCoursesDir = process.env.COURSES_DIR;
  process.env.COURSES_DIR = tempRoot;

  try {
    const songIds = [
      db
        .prepare(
          "INSERT INTO songs (file_path, title, pack, last_modified, bpm_min, bpm_max, duration_seconds) VALUES (?, ?, ?, 0, 140, 140, 120)",
        )
        .run("single-song.sm", "Single Song", "Single Pack").lastInsertRowid,
      db
        .prepare(
          "INSERT INTO songs (file_path, title, pack, last_modified, bpm_min, bpm_max, duration_seconds) VALUES (?, ?, ?, 0, 150, 150, 130)",
        )
        .run("single-song-2.sm", "Second Song", "Single Pack").lastInsertRowid,
    ];
    const chartIds = [
      db
        .prepare(
          "INSERT INTO charts (song_id, chart_type, difficulty, meter, difficulty_raw) VALUES (?, 'dance-single', 'Challenge', '10', 'challenge')",
        )
        .run(songIds[0]).lastInsertRowid,
      db
        .prepare(
          "INSERT INTO charts (song_id, chart_type, difficulty, meter, difficulty_raw) VALUES (?, 'dance-single', 'Challenge', '11', 'challenge')",
        )
        .run(songIds[1]).lastInsertRowid,
    ];

    db.prepare(
      "INSERT INTO requests (song_id, chart_id, requested_by, requested_display, status, created_at) VALUES (?, ?, 'tester', 'Tester', 'queued', 1)",
    ).run(songIds[0], chartIds[0]);
    db.prepare(
      "INSERT INTO requests (song_id, chart_id, requested_by, requested_display, status, created_at) VALUES (?, ?, 'tester', 'Tester', 'queued', 2)",
    ).run(songIds[1], chartIds[1]);

    const server = await startControlApp();
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/control/course/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Basic " + Buffer.from("streamer:test-control-password").toString("base64"),
        },
        body: JSON.stringify({ courseName: "Generated Course" }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.ok(json.filePath.endsWith("Generated Course.crs"));
      assert.ok(fs.existsSync(json.filePath));
      const text = fs.readFileSync(json.filePath, "utf8");
      assert.match(text, /^#COURSE:Generated Course;/m);
      assert.match(
        text,
        /#SONGSELECT:GROUP=Single Pack:TITLE=Single Song:DIFFICULTY=challenge:METER=10;/i,
      );

      const mixedSong = db
        .prepare(
          "INSERT INTO songs (file_path, title, pack, last_modified, bpm_min, bpm_max, duration_seconds) VALUES (?, ?, ?, 0, 140, 140, 120)",
        )
        .run("double-song.sm", "Double Song", "Double Pack").lastInsertRowid;
      const mixedChart = db
        .prepare(
          "INSERT INTO charts (song_id, chart_type, difficulty, meter, difficulty_raw) VALUES (?, 'dance-double', 'Hard', '18', 'hard')",
        )
        .run(mixedSong).lastInsertRowid;
      db.prepare(
        "INSERT INTO requests (song_id, chart_id, requested_by, requested_display, status, created_at) VALUES (?, ?, 'tester', 'Tester', 'queued', 3)",
      ).run(mixedSong, mixedChart);

      const badRes = await fetch(`http://127.0.0.1:${port}/api/control/course/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Basic " + Buffer.from("streamer:test-control-password").toString("base64"),
        },
        body: JSON.stringify({ courseName: "Bad Course" }),
      });
      assert.equal(badRes.status, 400);
      const badJson = await badRes.json();
      assert.match(String(badJson.error), /single|double|style/i);
    } finally {
      server.close();
    }
  } finally {
    if (originalCoursesDir === undefined) delete process.env.COURSES_DIR;
    else process.env.COURSES_DIR = originalCoursesDir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
    db.prepare("DELETE FROM requests WHERE requested_by = 'tester'").run();
    db.prepare(
      "DELETE FROM charts WHERE song_id IN (SELECT id FROM songs WHERE title IN (?, ?, ?, ?))",
    ).run("Single Song", "Second Song", "Double Song", "Mixing");
    db.prepare("DELETE FROM songs WHERE title IN (?, ?, ?, ?)").run(
      "Single Song",
      "Second Song",
      "Double Song",
      "Mixing",
    );
  }
});

test("song-filters returns 10-BPM buckets and 15-second duration buckets", async () => {
  resetSettings();
  const insertSong = (title, bpmMin, bpmMax, coreBpm, duration) =>
    db
      .prepare(
        "INSERT INTO songs (file_path, title, last_modified, bpm_min, bpm_max, core_bpm, duration_seconds) VALUES (?, ?, 0, ?, ?, ?, ?)",
      )
      .run(`${title}.sm`, title, bpmMin, bpmMax, coreBpm, duration).lastInsertRowid;

  const songIds = [
    insertSong("Bpm Bucket 100", 100, 100, 100, 122),
    insertSong("Bpm Bucket 140 A", 120, 150, 140, 307),
    insertSong("Bpm Bucket 140 B", 120, 150, 140, 310),
  ];

  const server = await startPublicModeratorApp();
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/song-filters`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(res.status, 200);
    const json = await res.json();

    const bucket100 = json.bpms.find((entry) => entry.bpm === 100);
    assert.ok(bucket100);
    assert.equal(bucket100.count, 1);

    const bucket140 = json.bpms.find((entry) => entry.bpm === 140);
    assert.ok(bucket140);
    assert.equal(bucket140.count, 2);

    // 122s -> 120 bucket; 307s and 310s -> 300 bucket.
    const bucket120 = json.durations.find((entry) => entry.seconds === 120);
    assert.ok(bucket120);
    assert.equal(bucket120.count, 1);
    const bucket300 = json.durations.find((entry) => entry.seconds === 300);
    assert.ok(bucket300);
    assert.equal(bucket300.count, 2);
  } finally {
    server.close();
    db.prepare("DELETE FROM songs WHERE id IN (?, ?, ?)").run(...songIds);
  }
});
