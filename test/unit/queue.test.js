process.env.NODE_ENV = "test";
process.env.SKIP_APP_STARTUP = "1";
process.env.CONTROL_PASSWORD = "test-control-password";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const tmpSongsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dance-game-queue-"));
const songDir = path.join(tmpSongsDir, "pack", "Queue Song");
fs.mkdirSync(songDir, { recursive: true });
fs.writeFileSync(
  path.join(songDir, "queue-song.sm"),
  "#TITLE:Queue Song;\n#ARTIST:Test Artist;\n#GENRE:Electronic;\n#NOTES:dance-single:1:Hard:12:1.000000:0.000000:0.000000;\n",
  "utf8",
);
process.env.SONGS_DIR = tmpSongsDir;

const {
  db,
  addRequest,
  getQueue,
  setRequestStatus,
  getSongSearchRows,
  scanSongs,
} = require("../../server.js");

// Scan the seed songs directory to populate the database
scanSongs(tmpSongsDir, db);

function resetRequests() {
  db.prepare("DELETE FROM requests").run();
}

test("addRequest appends a valid song to the queue and prevents duplicates", () => {
  resetRequests();
  const song = getSongSearchRows(10, "")[0];
  assert.ok(song, "expected at least one seed song to exist");

  const before = getQueue().length;
  const first = addRequest(song.id, `queue-user-${Date.now()}-a`, "Alice", {
    prioritizeViewerInsertion: true,
  });
  const after = getQueue().length;

  assert.equal(after, before + 1);
  assert.equal(first.song.id, song.id);

  const duplicateMessage = /already queued or playing/i;
  assert.throws(() => addRequest(song.id, "queue-user-duplicate", "Bob"), duplicateMessage);
});

test("setRequestStatus moves a queued request into playing and then completed", () => {
  resetRequests();
  const song = getSongSearchRows(10, "")[0];
  const username = `queue-user-${Date.now()}-b`;
  const request = addRequest(song.id, username, "Bob", { prioritizeViewerInsertion: true });

  const playing = setRequestStatus(request.id, "playing");
  assert.equal(playing, true);
  assert.ok(getQueue().some((entry) => entry.id === request.id) === false);

  const completed = setRequestStatus(request.id, "completed");
  assert.equal(completed, true);
});
