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
