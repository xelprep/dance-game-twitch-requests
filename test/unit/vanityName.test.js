process.env.NODE_ENV = "test";
process.env.SKIP_APP_STARTUP = "1";
process.env.CONTROL_PASSWORD = "test-control-password";
// Must be set before requiring server.js: the vanity name is read at module load.
process.env.STREAMER_VANITY_NAME = "Manblingo";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const tmpSongsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dance-game-vanity-"));
const songDir = path.join(tmpSongsDir, "pack", "Vanity Song");
fs.mkdirSync(songDir, { recursive: true });
fs.writeFileSync(
  path.join(songDir, "vanity-song.sm"),
  [
    "#TITLE:Vanity Song;",
    "#ARTIST:Test Artist;",
    "#GENRE:Electronic;",
    "#NOTES:dance-single:1:Hard:12:1.000000:0.000000:0.000000;",
    "#NOTES:dance-single:2:Medium:8:1.000000:0.000000:0.000000;",
    "#NOTES:dance-single:3:Easy:4:1.000000:0.000000:0.000000;",
    "",
  ].join("\n"),
  "utf8",
);
process.env.SONGS_DIR = tmpSongsDir;

const {
  db,
  addRequest,
  getQueue,
  isStreamerUsername,
  verifyStreamerAuth,
  scanSongs,
} = require("../../server.js");

test.before(async () => {
  await scanSongs(tmpSongsDir, db);
});

function resetRequests() {
  db.prepare("DELETE FROM requests").run();
}

function getChartIds(songId) {
  const charts = db.prepare("SELECT id FROM charts WHERE song_id = ?").all(songId);
  assert.ok(charts.length >= 3, "expected the seed song to have at least three charts");
  return charts.map((chart) => chart.id);
}

test("streamer auth only accepts the configured vanity name", () => {
  const header = (username) =>
    "Basic " + Buffer.from(`${username}:test-control-password`).toString("base64");
  assert.equal(verifyStreamerAuth(header("Manblingo"), "test-control-password"), true);
  assert.equal(verifyStreamerAuth(header("manblingo"), "test-control-password"), true);
  // The legacy "streamer" sentinel is no longer accepted once a custom name is set.
  assert.equal(verifyStreamerAuth(header("streamer"), "test-control-password"), false);
  assert.equal(verifyStreamerAuth(header("Manblingo"), "wrong-password"), false);
});

test("isStreamerUsername matches only the configured vanity name", () => {
  assert.equal(isStreamerUsername("Manblingo"), true);
  assert.equal(isStreamerUsername("manblingo"), true);
  assert.equal(isStreamerUsername("streamer"), false);
  assert.equal(isStreamerUsername("viewer"), false);
  assert.equal(isStreamerUsername(""), false);
});

test("viewer requests are queued ahead of streamer requests with a custom vanity name", () => {
  resetRequests();
  const song = db.prepare("SELECT id FROM songs LIMIT 1").get();
  assert.ok(song, "expected the seed song to exist");
  const [chartA, chartB, chartC] = getChartIds(song.id);

  // Streamer (control panel) request first: appended to the (empty) queue.
  addRequest(song.id, "Manblingo", "Manblingo", { chartId: chartA });
  // Viewer request: inserted ahead of the streamer's request.
  addRequest(song.id, "dave", "Dave", {
    prioritizeViewerInsertion: true,
    chartId: chartB,
  });
  // Second viewer request: after the first viewer, still ahead of the streamer.
  addRequest(song.id, "kim", "Kim", {
    prioritizeViewerInsertion: true,
    chartId: chartC,
  });

  const queue = getQueue();
  assert.deepEqual(
    queue.map((entry) => entry.requested_by),
    ["dave", "kim", "Manblingo"],
  );
  assert.deepEqual(
    queue.map((entry) => entry.viaControlPanel),
    [false, false, true],
  );
});
