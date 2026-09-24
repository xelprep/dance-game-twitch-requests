process.env.NODE_ENV = "test";
process.env.SKIP_APP_STARTUP = "1";
process.env.CONTROL_PASSWORD = "test-control-password";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const tmpSongsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dance-game-constraints-"));

function writeSong(pack, songFolder, fileName, lines) {
  const dir = path.join(tmpSongsDir, pack, songFolder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), lines.join("\n") + "\n", "utf8");
}

// One song with a spread of charts (meters 7/12/15 single, 10 double) and a second
// song in a different pack, so each constraint dimension can be exercised.
writeSong("Alpha Pack", "Constraint Song", "constraint-song.sm", [
  "#TITLE:Constraint Song;",
  "#ARTIST:Test Artist;",
  "#GENRE:Electronic;",
  "#BPM:140;",
  "#NOTES:dance-single:0:Easy:7:1.000000:0.000000:0.000000;",
  "#NOTES:dance-single:1:Hard:12:1.000000:0.000000:0.000000;",
  "#NOTES:dance-single:2:Insane:15:1.000000:0.000000:0.000000;",
  "#NOTES:dance-double:1:Medium:10:1.000000:0.000000:0.000000;",
]);
writeSong("Beta Pack", "Other Pack Song", "other-pack-song.sm", [
  "#TITLE:Other Pack Song;",
  "#ARTIST:Test Artist;",
  "#GENRE:Electronic;",
  "#BPM:90;",
  "#NOTES:dance-single:1:Hard:12:1.000000:0.000000:0.000000;",
]);
process.env.SONGS_DIR = tmpSongsDir;

const { db, addRequest, scanSongs, setSetting, createApi } = require("../../server.js");

test.before(async () => {
  await scanSongs(tmpSongsDir, db);
  // Deterministic BPM / duration values for the range checks.
  db.prepare("UPDATE songs SET core_bpm = 140, duration_seconds = 210 WHERE title = ?").run(
    "Constraint Song",
  );
  db.prepare("UPDATE songs SET core_bpm = 90, duration_seconds = 400 WHERE title = ?").run(
    "Other Pack Song",
  );
});

function resetState() {
  db.prepare("DELETE FROM requests").run();
  db.prepare("DELETE FROM settings").run();
}

function getSongByTitle(title) {
  const row = db.prepare("SELECT * FROM songs WHERE title = ?").get(title);
  assert.ok(row, `expected seed song "${title}" to exist`);
  return row;
}

function getChart(songId, chartType, meter) {
  const chart = db
    .prepare("SELECT * FROM charts WHERE song_id = ? AND chart_type = ? AND meter = ?")
    .get(songId, chartType, String(meter));
  assert.ok(chart, `expected a ${chartType} meter-${meter} chart`);
  return chart;
}

function startApp(options = { moderator: true }) {
  const app = express();
  createApi(app, options);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test("addRequest succeeds when no request constraints are set", () => {
  resetState();
  const song = getSongByTitle("Constraint Song");
  const request = addRequest(song.id, "no-constraint-user", "User", {
    chartId: getChart(song.id, "dance-single", 12).id,
  });
  assert.equal(request.song.id, song.id);
});

test("addRequest enforces the style constraint", () => {
  resetState();
  const song = getSongByTitle("Constraint Song");
  const single = getChart(song.id, "dance-single", 12);
  const double = getChart(song.id, "dance-double", 10);

  setSetting("requestConstraintStyle", "single");
  assert.throws(
    () => addRequest(song.id, "style-user-a", "A", { chartId: double.id }),
    /Only Single style charts can be requested right now\./,
  );
  const ok = addRequest(song.id, "style-user-b", "B", { chartId: single.id });
  assert.equal(ok.chart.id, single.id);

  setSetting("requestConstraintStyle", "double");
  assert.throws(
    () => addRequest(song.id, "style-user-c", "C", { chartId: single.id }),
    /Only Double style charts can be requested right now\./,
  );
});

test("addRequest enforces the meter range constraint", () => {
  resetState();
  const song = getSongByTitle("Constraint Song");
  setSetting("requestConstraintMeterMin", 10);
  setSetting("requestConstraintMeterMax", 14);

  assert.throws(
    () =>
      addRequest(song.id, "meter-user-a", "A", {
        chartId: getChart(song.id, "dance-single", 7).id,
      }),
    /Charts below meter 10 can't be requested right now\./,
  );
  assert.throws(
    () =>
      addRequest(song.id, "meter-user-b", "B", {
        chartId: getChart(song.id, "dance-single", 15).id,
      }),
    /Charts above meter 14 can't be requested right now\./,
  );
  const ok = addRequest(song.id, "meter-user-c", "C", {
    chartId: getChart(song.id, "dance-single", 12).id,
  });
  assert.equal(ok.song.id, song.id);
});

test("addRequest enforces the pack constraint", () => {
  resetState();
  const alpha = getSongByTitle("Constraint Song");
  const beta = getSongByTitle("Other Pack Song");
  assert.ok(alpha.pack, "expected the seed song to have a pack");

  setSetting("requestConstraintPack", alpha.pack);
  assert.throws(
    () =>
      addRequest(beta.id, "pack-user-a", "A", {
        chartId: getChart(beta.id, "dance-single", 12).id,
      }),
    new RegExp(`Only songs from the "${alpha.pack}" pack can be requested right now\\.`),
  );
  const ok = addRequest(alpha.id, "pack-user-b", "B", {
    chartId: getChart(alpha.id, "dance-single", 12).id,
  });
  assert.equal(ok.song.id, alpha.id);
});

test("addRequest enforces the BPM range constraint", () => {
  resetState();
  const alpha = getSongByTitle("Constraint Song"); // 140 BPM
  const beta = getSongByTitle("Other Pack Song"); // 90 BPM
  setSetting("requestConstraintBpmMin", 100);
  setSetting("requestConstraintBpmMax", 150);

  assert.throws(
    () =>
      addRequest(beta.id, "bpm-user-a", "A", {
        chartId: getChart(beta.id, "dance-single", 12).id,
      }),
    /Songs below 100 BPM can't be requested right now\./,
  );
  const ok = addRequest(alpha.id, "bpm-user-b", "B", {
    chartId: getChart(alpha.id, "dance-single", 12).id,
  });
  assert.equal(ok.song.id, alpha.id);

  setSetting("requestConstraintBpmMax", 100);
  assert.throws(
    () =>
      addRequest(alpha.id, "bpm-user-c", "C", {
        chartId: getChart(alpha.id, "dance-single", 7).id,
      }),
    /Songs above 100 BPM can't be requested right now\./,
  );
});

test("addRequest enforces the duration range constraint", () => {
  resetState();
  const song = getSongByTitle("Constraint Song"); // 210s (3m 30s)
  const chartId = getChart(song.id, "dance-single", 12).id;

  setSetting("requestConstraintDurationMin", 300);
  assert.throws(
    () => addRequest(song.id, "duration-user-a", "A", { chartId }),
    /Songs shorter than 5m can't be requested right now\./,
  );

  resetState();
  setSetting("requestConstraintDurationMax", 200);
  assert.throws(
    () => addRequest(song.id, "duration-user-b", "B", { chartId }),
    /Songs longer than 3m 20s can't be requested right now\./,
  );
});

test("GET /api/request-constraints reflects the stored constraints", async () => {
  resetState();
  setSetting("requestConstraintStyle", "double");
  setSetting("requestConstraintMeterMin", 8);

  const server = await startApp();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/request-constraints`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, {
      style: "double",
      pack: "",
      meterMin: 8,
      meterMax: null,
      bpmMin: null,
      bpmMax: null,
      durationMin: null,
      durationMax: null,
    });
  } finally {
    server.close();
  }
});

test("GET /api/songs annotates charts that violate the request constraints", async () => {
  resetState();
  setSetting("requestConstraintMeterMin", 10);
  setSetting("requestConstraintMeterMax", 14);

  const server = await startApp();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/songs?perPage=100`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    const song = json.songs.find((s) => s.title === "Constraint Song");
    assert.ok(song, "expected the seed song in the song list");
    const byMeter = (meter) => song.charts.find((c) => Number(c.meter) === meter);

    assert.equal(byMeter(7).disallowed, true);
    assert.match(byMeter(7).disallowReason, /Charts below meter 10/);
    assert.equal(byMeter(15).disallowed, true);
    assert.match(byMeter(15).disallowReason, /Charts above meter 14/);
    assert.equal(byMeter(12).disallowed, undefined);
    assert.equal(byMeter(10).disallowed, undefined);

    // With no constraints active, no chart is annotated.
    resetState();
    const clearRes = await fetch(`http://127.0.0.1:${port}/api/songs?perPage=100`, {
      headers: { Accept: "application/json" },
    });
    const clearJson = await clearRes.json();
    const clearSong = clearJson.songs.find((s) => s.title === "Constraint Song");
    assert.ok(clearSong.charts.every((c) => !c.disallowed));
  } finally {
    server.close();
  }
});

test("control settings API persists request constraint fields", async () => {
  resetState();
  const server = await startApp({ control: true });
  const port = server.address().port;
  const auth = {
    "Content-Type": "application/json",
    Authorization: "Basic " + Buffer.from("streamer:test-control-password").toString("base64"),
  };

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/control/settings`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        requestConstraintStyle: "single",
        requestConstraintPack: "Alpha Pack",
        requestConstraintMeterMin: 7,
        requestConstraintMeterMax: 10,
        requestConstraintBpmMin: 100,
        requestConstraintBpmMax: 160,
        requestConstraintDurationMin: 120,
        requestConstraintDurationMax: 300,
      }),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.requestConstraintStyle, "single");
    assert.equal(payload.requestConstraintPack, "Alpha Pack");
    assert.equal(payload.requestConstraintMeterMin, 7);
    assert.equal(payload.requestConstraintMeterMax, 10);
    assert.equal(payload.requestConstraintBpmMin, 100);
    assert.equal(payload.requestConstraintBpmMax, 160);
    assert.equal(payload.requestConstraintDurationMin, 120);
    assert.equal(payload.requestConstraintDurationMax, 300);

    // Empty bounds clear the constraint back to null.
    const clearRes = await fetch(`http://127.0.0.1:${port}/api/control/settings`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        requestConstraintStyle: "any",
        requestConstraintPack: "",
        requestConstraintMeterMin: "",
        requestConstraintMeterMax: "",
        requestConstraintBpmMin: "",
        requestConstraintBpmMax: "",
        requestConstraintDurationMin: "",
        requestConstraintDurationMax: "",
      }),
    });
    assert.equal(clearRes.status, 200);
    const clearPayload = await clearRes.json();
    assert.equal(clearPayload.requestConstraintStyle, "any");
    assert.equal(clearPayload.requestConstraintPack, "");
    assert.equal(clearPayload.requestConstraintMeterMin, null);
    assert.equal(clearPayload.requestConstraintDurationMax, null);
  } finally {
    server.close();
  }
});
