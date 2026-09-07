process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const {
  scanSongs,
  readSongFile,
  parseBpm,
  parseTimeSignatures,
  findLastBeat,
  buildTimingStates,
  timeAtBeat,
  computeDuration,
} = require("../../scanner.js");

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
      last_modified INTEGER NOT NULL,
      bpm_min INTEGER,
      bpm_max INTEGER,
      duration_seconds INTEGER
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
      last_modified INTEGER NOT NULL,
      bpm_min INTEGER,
      bpm_max INTEGER,
      duration_seconds INTEGER
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

test("parseBpm prefers a valid DISPLAYBPM over BPMS", () => {
  assert.deepEqual(parseBpm({ DISPLAYBPM: "120", BPMS: "0=90,32=110" }), {
    bpmMin: 120,
    bpmMax: 120,
  });
  assert.deepEqual(parseBpm({ DISPLAYBPM: "110-130" }), { bpmMin: 110, bpmMax: 130 });
  assert.deepEqual(parseBpm({ DISPLAYBPM: "119.6" }), { bpmMin: 120, bpmMax: 120 });
});

test("parseBpm falls back to BPMS when DISPLAYBPM is * or invalid", () => {
  assert.deepEqual(parseBpm({ DISPLAYBPM: "*", BPMS: "0=90,32=110" }), {
    bpmMin: 90,
    bpmMax: 110,
  });
  assert.deepEqual(parseBpm({ DISPLAYBPM: "abc", BPMS: "0=95" }), {
    bpmMin: 95,
    bpmMax: 95,
  });
  assert.deepEqual(parseBpm({ DISPLAYBPM: "*" }), { bpmMin: null, bpmMax: null });
  assert.deepEqual(parseBpm({}), { bpmMin: null, bpmMax: null });
});

test("findLastBeat maps note rows to beats using the active time signature", () => {
  // 4/4, 8 rows per measure: row l sits at l * 0.5 beats.
  const fourFour = "00000000\n00000000\n00000000\n00000000\n00000000\n00000000\n00000000\n10000000";
  assert.equal(findLastBeat(fourFour, []), 3.5);

  // 3/4, 6 rows per measure: row l sits at l * 0.5 beats.
  const threeFour = parseTimeSignatures("0=3=4");
  assert.equal(findLastBeat("000000\n000000\n000000\n000000\n000000\n100000", threeFour), 2.5);

  // Measures are comma-separated; beats accumulate across measures.
  assert.equal(
    findLastBeat(
      fourFour +
        ",\n00000000\n00000000\n00000000\n00000000\n00000000\n00000000\n00000000\n20000000",
      [],
    ),
    7.5,
  );

  // Trailing `;` and `//` comment lines are not note rows.
  assert.equal(findLastBeat(fourFour + "\n;\n// made with StepMania", []), 3.5);

  // Keysound suffixes do not count as notes.
  assert.equal(
    findLastBeat(
      "00000000\n00000000\n00000000\n00000000\n00000000\n00000000\n00000000\n00000000[3]",
      [],
    ),
    null,
  );

  // All-zero note data has no last beat.
  assert.equal(findLastBeat("00000000\n00000000", []), null);
});

test("buildTimingStates and timeAtBeat model stops, delays, and warps", () => {
  // Stop: 2s stop starting at beat 4 at 120 BPM.
  const stopped = buildTimingStates({
    bpms: [{ beat: 0, value: 120 }],
    stops: [{ beat: 4, value: 2 }],
    delays: [],
    warps: [],
    offset: 0,
    timeSignatures: [],
  });
  assert.equal(timeAtBeat(stopped, 4), 2); // note on the stop beat plays at stop start
  assert.equal(timeAtBeat(stopped, 8), 6); // 2s before stop + 2s stop + 2s after

  // Delay: 1s delay starting at beat 4.
  const delayed = buildTimingStates({
    bpms: [{ beat: 0, value: 120 }],
    stops: [],
    delays: [{ beat: 4, value: 1 }],
    warps: [],
    offset: 0,
    timeSignatures: [],
  });
  assert.equal(timeAtBeat(delayed, 8), 5);

  // Warp: beats 4..8 elapse no wall-clock time.
  const warped = buildTimingStates({
    bpms: [{ beat: 0, value: 120 }],
    stops: [],
    delays: [],
    warps: [{ beat: 4, value: 4 }],
    offset: 0,
    timeSignatures: [],
  });
  assert.equal(timeAtBeat(warped, 6), 2);
  assert.equal(timeAtBeat(warped, 10), 3);

  // BPM change: 120 -> 240 at beat 4.
  const shifted = buildTimingStates({
    bpms: [
      { beat: 0, value: 120 },
      { beat: 4, value: 240 },
    ],
    stops: [],
    delays: [],
    warps: [],
    offset: 0,
    timeSignatures: [],
  });
  assert.equal(timeAtBeat(shifted, 8), 3); // 2s at 120 + 4 beats at 240

  // No BPM data -> null.
  assert.equal(
    buildTimingStates({
      bpms: [],
      stops: [],
      delays: [],
      warps: [],
      offset: 0,
      timeSignatures: [],
    }),
    null,
  );
});

test("computeDuration prefers a valid LASTSECONDHINT over computed timing", () => {
  const charts = [
    {
      chartType: "dance-single",
      noteData: "00000000\n00000000\n00000000\n00000000\n00000000\n00000000\n00000000\n10000000",
    },
  ];
  const songTags = { BPMS: "0=120", OFFSET: "0" };

  assert.equal(computeDuration(charts, { ...songTags, LASTSECONDHINT: "95.5" }, false), 96);
  // Invalid hints (0 / garbage) fall back to computed timing: beat 3.5 at 120 BPM = 1.75s.
  assert.equal(computeDuration(charts, { ...songTags, LASTSECONDHINT: "0.000000" }, false), 2);
  assert.equal(computeDuration(charts, { ...songTags, LASTSECONDHINT: "abc" }, false), 2);
  // No hint at all: computed timing.
  assert.equal(computeDuration(charts, songTags, false), 2);
  // No timing and no notes: null.
  assert.equal(computeDuration([], {}, false), null);
});

test("computeDuration uses chart-level LASTSECONDHINT in .ssc charts", () => {
  const charts = [
    {
      chartType: "dance-single",
      noteData: "00000000",
      chartTags: { LASTSECONDHINT: "60.2" },
    },
  ];
  assert.equal(computeDuration(charts, { BPMS: "0=120" }, true), 60);
});

test("readSongFile extracts bpm and duration from .sm timing data", () => {
  const tmp = tempDir();
  const filePath = path.join(tmp, "timing.sm");
  fs.writeFileSync(
    filePath,
    [
      "#TITLE:Timing Song;",
      "#ARTIST:Tester;",
      "#DISPLAYBPM:120;",
      "#BPMS:0=120;",
      "#NOTES:dance-single:1:Easy:4:1.000000:0.000000:0.000000:",
      "00000000",
      "00000000",
      "00000000",
      "00000000",
      "00000000",
      "00000000",
      "00000000",
      "10000000",
      ";",
      "",
    ].join("\n"),
    "utf8",
  );

  const song = readSongFile(filePath, "Test Pack");
  assert.equal(song.bpmMin, 120);
  assert.equal(song.bpmMax, 120);
  // Last note at beat 3.5, 120 BPM -> 1.75s -> rounds to 2.
  assert.equal(song.durationSeconds, 2);
});

test("readSongFile uses LASTSECONDHINT and BPMS fallback for .ssc files", () => {
  const tmp = tempDir();
  const filePath = path.join(tmp, "hint.ssc");
  fs.writeFileSync(
    filePath,
    [
      "#TITLE:Hint Song;",
      "#ARTIST:Tester;",
      "#DISPLAYBPM:*;",
      "#LASTSECONDHINT:95.5;",
      "#BPMS:0=150;",
      "#NOTEDATA:;",
      "#STEPSTYPE:dance-single;",
      "#DIFFICULTY:Easy;",
      "#METER:5;",
      "#RADARVALUES:1.0;",
      "#NOTES:",
      "00000000",
      ";",
      "",
    ].join("\n"),
    "utf8",
  );

  const song = readSongFile(filePath, "Test Pack");
  assert.equal(song.charts.length, 1);
  // DISPLAYBPM is * -> falls back to BPMS.
  assert.equal(song.bpmMin, 150);
  assert.equal(song.bpmMax, 150);
  // LASTSECONDHINT 95.5 -> 96.
  assert.equal(song.durationSeconds, 96);
});

test("scanSongs persists bpm and duration columns", () => {
  const tmp = tempDir();
  const songDir = path.join(tmp, "pack", "Timing Song");
  writeSongFile(
    songDir,
    "timing.sm",
    [
      "#TITLE:Timing Song;",
      "#ARTIST:Tester;",
      "#DISPLAYBPM:120;",
      "#BPMS:0=120;",
      "#NOTES:dance-single:1:Easy:4:1.000000:0.000000:0.000000:",
      "00000000",
      "00000000",
      "00000000",
      "00000000",
      "00000000",
      "00000000",
      "00000000",
      "10000000",
      ";",
      "",
    ].join("\n"),
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
      last_modified INTEGER NOT NULL,
      bpm_min INTEGER,
      bpm_max INTEGER,
      duration_seconds INTEGER
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
  const row = db.prepare("SELECT bpm_min, bpm_max, duration_seconds FROM songs").get();
  assert.equal(row.bpm_min, 120);
  assert.equal(row.bpm_max, 120);
  assert.equal(row.duration_seconds, 2);
});
