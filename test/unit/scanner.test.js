process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const { scanSongs, readSongFile } = require("../../scanner.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dance-game-tests-"));
}

function writeSongFile(songDir, fileName, contents) {
  fs.mkdirSync(songDir, { recursive: true });
  fs.writeFileSync(path.join(songDir, fileName), contents, "utf8");
}

test("readSongFile parses metadata and chart data from .sm files", () => {
  const tmp = tempDir();
  const filePath = path.join(tmp, "song.sm");
  fs.writeFileSync(
    filePath,
    `#TITLE:Test Song;\n#SUBTITLE:Dark Mode;\n#ARTIST:Example Artist;\n#GENRE:Techno;\n#MUSIC:music.ogg;\n#NOTES:dance-single:1:Expert:10:1.000000:0.000000:0.000000;\n`,
    "utf8",
  );

  const song = readSongFile(filePath, "Test Pack");

  assert.equal(song.title, "Test Song");
  assert.equal(song.subtitle, "Dark Mode");
  assert.equal(song.artist, "Example Artist");
  assert.equal(song.genre, "Techno");
  assert.equal(song.pack, "Test Pack");
  assert.equal(song.charts.length, 1);
  assert.equal(song.charts[0].chartType, "dance-single");
  assert.equal(song.charts[0].difficulty, "Expert");
  assert.equal(song.charts[0].meter, "10");
});

test("scanSongs prefers .ssc files when both .sm and .ssc exist", () => {
  const tmp = tempDir();
  const base = path.join(tmp, "pack", "Song A");
  fs.mkdirSync(base, { recursive: true });

  writeSongFile(base, "song.sm", "#TITLE:Old Title;\n#NOTES: dance-single:Hard:12:1.0;\n");
  writeSongFile(
    base,
    "song.ssc",
    "#TITLE:Preferred Title;\n#NOTEDATA:;\n#STEPSTYPE:dance-single;\n#DIFFICULTY:Hard;\n#METER:12;\n#RADARVALUES:1.0;\n",
  );

  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE songs (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      subtitle TEXT DEFAULT '',
      artist TEXT DEFAULT '',
      genre TEXT DEFAULT '',
      pack TEXT DEFAULT '',
      music TEXT DEFAULT '',
      bpm_min INTEGER,
      bpm_max INTEGER,
      duration INTEGER,
      last_modified INTEGER NOT NULL
    );
    CREATE TABLE charts (
      id INTEGER PRIMARY KEY,
      song_id INTEGER NOT NULL,
      chart_type TEXT DEFAULT '',
      difficulty TEXT DEFAULT '',
      meter TEXT DEFAULT '',
      radar TEXT DEFAULT ''
    );
    CREATE TABLE requests (
      id INTEGER PRIMARY KEY,
      song_id INTEGER NOT NULL,
      requested_by TEXT NOT NULL,
      requested_display TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE TABLE blocked (
      id INTEGER PRIMARY KEY,
      song_id INTEGER REFERENCES songs(id),
      username TEXT,
      reason TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(song_id, username)
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const result = scanSongs(tmp, db);

  assert.equal(result.songs, 1);
  const songRow = db.prepare("SELECT title, pack FROM songs").get();
  assert.equal(songRow.title, "Preferred Title");
  assert.equal(songRow.pack, "pack");
});

test("scanSongs deletes stale songs and their related records", () => {
  const tmp = tempDir();
  const packDir = path.join(tmp, "pack");
  const songDir = path.join(packDir, "Song 1");
  fs.mkdirSync(songDir, { recursive: true });
  fs.writeFileSync(
    path.join(songDir, "song.sm"),
    "#TITLE:Song 1;\n#NOTES: dance-single:Hard:12:1.0;\n",
    "utf8",
  );

  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE songs (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      subtitle TEXT DEFAULT '',
      artist TEXT DEFAULT '',
      genre TEXT DEFAULT '',
      pack TEXT DEFAULT '',
      music TEXT DEFAULT '',
      bpm_min INTEGER,
      bpm_max INTEGER,
      duration INTEGER,
      last_modified INTEGER NOT NULL
    );
    CREATE TABLE charts (
      id INTEGER PRIMARY KEY,
      song_id INTEGER NOT NULL,
      chart_type TEXT DEFAULT '',
      difficulty TEXT DEFAULT '',
      meter TEXT DEFAULT '',
      radar TEXT DEFAULT ''
    );
    CREATE TABLE requests (
      id INTEGER PRIMARY KEY,
      song_id INTEGER NOT NULL,
      requested_by TEXT NOT NULL,
      requested_display TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE TABLE blocked (
      id INTEGER PRIMARY KEY,
      song_id INTEGER REFERENCES songs(id),
      username TEXT,
      reason TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(song_id, username)
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  scanSongs(tmp, db);
  fs.rmSync(songDir, { recursive: true, force: true });
  scanSongs(tmp, db);

  const count = db.prepare("SELECT COUNT(*) AS n FROM songs").get().n;
  assert.equal(count, 0);
});

test("readSongFile normalizes leading-zero meters", () => {
  const tmp = tempDir();

  const smPath = path.join(tmp, "leading-zero.sm");
  fs.writeFileSync(
    smPath,
    "#TITLE:Zero Meter Song;\n#NOTES:dance-single:1:Easy:06:1.000000:0.000000:0.000000;\n",
    "utf8",
  );

  const smSong = readSongFile(smPath, "Test Pack");
  assert.equal(smSong.charts.length, 1);
  assert.equal(smSong.charts[0].meter, "6");

  const sscPath = path.join(tmp, "leading-zero.ssc");
  fs.writeFileSync(
    sscPath,
    "#TITLE:Zero Meter Song;\n#NOTEDATA:;\n#STEPSTYPE:dance-single;\n#DIFFICULTY:Easy;\n#METER:06;\n#RADARVALUES:1.0;\n",
    "utf8",
  );

  const sscSong = readSongFile(sscPath, "Test Pack");
  assert.equal(sscSong.charts.length, 1);
  assert.equal(sscSong.charts[0].meter, "6");
});

test("readSongFile extracts BPM from #DISPLAYBPM (single value and range)", () => {
  const tmp = tempDir();

  const singlePath = path.join(tmp, "single.sm");
  fs.writeFileSync(singlePath, "#TITLE:Single BPM;\n#DISPLAYBPM:150;\n#BPMS:0=100;\n", "utf8");
  const single = readSongFile(singlePath, "Test Pack");
  assert.equal(single.bpmMin, 150);
  assert.equal(single.bpmMax, 150);

  const rangePath = path.join(tmp, "range.sm");
  fs.writeFileSync(rangePath, "#TITLE:Range BPM;\n#DISPLAYBPM:120:240;\n#BPMS:0=100;\n", "utf8");
  const range = readSongFile(rangePath, "Test Pack");
  assert.equal(range.bpmMin, 120);
  assert.equal(range.bpmMax, 240);
});

test("readSongFile falls back to #BPMS when #DISPLAYBPM is missing or *", () => {
  const tmp = tempDir();

  const missingPath = path.join(tmp, "missing.sm");
  fs.writeFileSync(missingPath, "#TITLE:No Display BPM;\n#BPMS:0=100,16=150,32=125.5;\n", "utf8");
  const missing = readSongFile(missingPath, "Test Pack");
  assert.equal(missing.bpmMin, 100);
  assert.equal(missing.bpmMax, 150);

  const wildcardPath = path.join(tmp, "wildcard.sm");
  fs.writeFileSync(
    wildcardPath,
    "#TITLE:Wildcard Display BPM;\n#DISPLAYBPM:*;\n#BPMS:0=90;\n",
    "utf8",
  );
  const wildcard = readSongFile(wildcardPath, "Test Pack");
  assert.equal(wildcard.bpmMin, 90);
  assert.equal(wildcard.bpmMax, 90);
});

test("readSongFile includes SSC chart-level #BPMS only for #TIMINGMODE:STEPS charts", () => {
  const tmp = tempDir();
  const sscPath = path.join(tmp, "charts.ssc");
  fs.writeFileSync(
    sscPath,
    [
      "#TITLE:SSC BPM;",
      "#DISPLAYBPM:*;",
      "#BPMS:0=100;",
      "#NOTEDATA:;",
      "#STEPSTYPE:dance-single;",
      "#DIFFICULTY:Easy;",
      "#METER:4;",
      "#TIMINGMODE:STEPS;",
      "#BPMS:0=150;",
      "#NOTES;",
      "| | | | |",
      ";",
      "#NOTEDATA:;",
      "#STEPSTYPE:dance-double;",
      "#DIFFICULTY:Hard;",
      "#METER:4;",
      "#NOTES;",
      "| | | | |",
      ";",
    ].join("\n"),
    "utf8",
  );

  const song = readSongFile(sscPath, "Test Pack");
  assert.equal(song.bpmMin, 100);
  assert.equal(song.bpmMax, 150);
});

test("readSongFile computes duration from notes, #BPMS, #STOPS and #OFFSET", () => {
  const tmp = tempDir();

  // 8 measures x 4 beats = 32 beats @120bpm = 16s, plus 0.25s offset -> 16s.
  const basicPath = path.join(tmp, "basic.sm");
  fs.writeFileSync(
    basicPath,
    [
      "#TITLE:Basic Duration;",
      "#OFFSET:0.25;",
      "#BPMS:0=120;",
      "#NOTES:dance-single:1:Easy:4:1.000000:0.000000:0.000000;",
      "| | | | |",
      "| | | | |",
      ";",
    ].join("\n"),
    "utf8",
  );
  const basic = readSongFile(basicPath, "Test Pack");
  assert.equal(basic.duration, 16);

  // 32 beats: 16 @60bpm (16s) + 16 @120bpm (8s) + stop of 2 beats @60bpm (2s) = 26s.
  const stopPath = path.join(tmp, "stop.sm");
  fs.writeFileSync(
    stopPath,
    [
      "#TITLE:Stop Duration;",
      "#BPMS:0=60,16=120;",
      "#STOPS:8=2;",
      "#NOTES:dance-single:1:Easy:4:1.000000:0.000000:0.000000;",
      "| | | | |",
      "| | | | |",
      ";",
    ].join("\n"),
    "utf8",
  );
  const stop = readSongFile(stopPath, "Test Pack");
  assert.equal(stop.duration, 26);
});

test("readSongFile uses the longest SSC chart for duration", () => {
  const tmp = tempDir();
  const sscPath = path.join(tmp, "duration.ssc");
  fs.writeFileSync(
    sscPath,
    [
      "#TITLE:SSC Duration;",
      "#BPMS:0=100;",
      "#NOTEDATA:;",
      "#STEPSTYPE:dance-single;",
      "#DIFFICULTY:Easy;",
      "#METER:4;",
      "#TIMINGMODE:STEPS;",
      "#BPMS:0=150;",
      "#NOTES;",
      "| | | | |",
      ";",
      "#NOTEDATA:;",
      "#STEPSTYPE:dance-double;",
      "#DIFFICULTY:Hard;",
      "#METER:4;",
      "#NOTES;",
      "| | | | |",
      ";",
    ].join("\n"),
    "utf8",
  );

  // Chart 1: 16 beats @150bpm = 6.4s. Chart 2: 16 beats @100bpm = 9.6s -> 10s.
  const song = readSongFile(sscPath, "Test Pack");
  assert.equal(song.duration, 10);
});

test("readSongFile honors #LASTSECONDHINT for duration", () => {
  const tmp = tempDir();
  const hintPath = path.join(tmp, "hint.sm");
  fs.writeFileSync(
    hintPath,
    [
      "#TITLE:Hint Duration;",
      "#LASTSECONDHINT:213.4;",
      "#BPMS:0=120;",
      "#NOTES:dance-single:1:Easy:4:1.000000:0.000000:0.000000;",
      "| | | | |",
      ";",
    ].join("\n"),
    "utf8",
  );

  const song = readSongFile(hintPath, "Test Pack");
  assert.equal(song.duration, 213);
});
