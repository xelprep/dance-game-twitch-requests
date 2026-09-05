process.env.NODE_ENV = "test";
process.env.SKIP_APP_STARTUP = "1";
process.env.CONTROL_PASSWORD = "test-control-password";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const {
  announceTempModNomination,
  createApi,
  db,
  formatVisibleUsername,
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
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.moderatorEnabled, true);
  } finally {
    server.close();
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
  const songIds = titles.map((title) =>
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
