process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const {
  scanSongs,
  resolveThreadCount,
  readSongFile,
  parseBpm,
  computeCoreBpm,
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

test("readSongFile parses metadata and chart data from multiline .sm header", () => {
  const tmp = tempDir();
  const filePath = path.join(tmp, "song_multiline.sm");
  fs.writeFileSync(
    filePath,
    `#TITLE:Multiline Song;
#SUBTITLE:Test;
#ARTIST:Artist;
#GENRE:Genre;
#MUSIC:music.ogg;
#NOTES:
    dance-single:
    Janus5k:
    Challenge:
    14:
    1.000,1.000,0.157,0.136,1.000:
0000
0000
0000
0000;`,
    "utf8",
  );

  const song = readSongFile(filePath, "Test Pack");

  assert.equal(song.title, "Multiline Song");
  assert.equal(song.charts.length, 1);
  assert.equal(song.charts[0].chartType, "dance-single");
  assert.equal(song.charts[0].difficulty, "Challenge");
  assert.equal(song.charts[0].meter, "14");
  assert.equal(song.charts[0].radar, "1.000,1.000,0.157,0.136,1.000");
});

test("scanSongs prefers .ssc files when both .sm and .ssc exist", async () => {
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
      core_bpm INTEGER,
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

  const result = await scanSongs(tmp, db);

  assert.equal(result.songs, 1);
  const songRow = db.prepare("SELECT title, pack FROM songs").get();
  assert.equal(songRow.title, "Preferred Title");
  assert.equal(songRow.pack, "pack");
});

test("scanSongs deletes stale songs and their related records", async () => {
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
      core_bpm INTEGER,
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

  await scanSongs(tmp, db);
  fs.rmSync(songDir, { recursive: true, force: true });
  await scanSongs(tmp, db);

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

test("scanSongs persists bpm and duration columns", async () => {
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
      core_bpm INTEGER,
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

  const result = await scanSongs(tmp, db);

  assert.equal(result.songs, 1);
  const row = db.prepare("SELECT bpm_min, bpm_max, duration_seconds FROM songs").get();
  assert.equal(row.bpm_min, 120);
  assert.equal(row.bpm_max, 120);
  assert.equal(row.duration_seconds, 2);
});

test("resolveThreadCount handles -1, environment variables, user options, and clamping", () => {
  const cpus = os.cpus()?.length || 1;

  // Default / -1 resolves to all available cpus
  assert.equal(resolveThreadCount("-1"), cpus);
  assert.equal(resolveThreadCount(-1), cpus);
  assert.equal(resolveThreadCount(undefined), cpus);

  // User restriction
  assert.equal(resolveThreadCount("1"), 1);
  assert.equal(resolveThreadCount(1), 1);
  if (cpus > 1) {
    assert.equal(resolveThreadCount(2), 2);
  }

  // Clamped to CPU count
  assert.equal(resolveThreadCount(9999), cpus);

  // Invalid values fall back to cpus
  assert.equal(resolveThreadCount("invalid"), cpus);
  assert.equal(resolveThreadCount(0), cpus);
});

test("scanSongs returns elapsedTimeMs and supports multithreading", async () => {
  const tmp = tempDir();
  for (let i = 1; i <= 4; i++) {
    const songDir = path.join(tmp, "pack", `Song ${i}`);
    writeSongFile(
      songDir,
      `song${i}.sm`,
      `#TITLE:Song ${i};\n#NOTES:dance-single:1:Easy:4:1.0:0.0:0.0;\n`,
    );
  }

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
      core_bpm INTEGER,
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

  const result = await scanSongs(tmp, db, { threads: 2 });
  assert.equal(result.songs, 4);
  assert.equal(typeof result.elapsedTimeMs, "number");
  assert.ok(result.elapsedTimeMs >= 0);
});

test("computeCoreBpm calculates dominant BPM by duration and defers to higher BPM on ties", () => {
  // Constant BPM song
  assert.equal(computeCoreBpm([], { DISPLAYBPM: "150", BPMS: "0=150" }, false), 150);

  // Variable BPM song: 120 BPM for beats 0..4 (2s), 180 BPM for beats 4..20 (5.33s)
  const chartsVar = [
    {
      chartType: "dance-single",
      noteData:
        "0000\n0000\n0000\n0000,\n0000\n0000\n0000\n0000,\n0000\n0000\n0000\n0000,\n0000\n0000\n0000\n0000,\n0000\n0000\n0000\n1000",
      chartTags: { BPMS: "0=120,4=180" },
    },
  ];
  assert.equal(computeCoreBpm(chartsVar, { BPMS: "0=120,4=180" }, true), 180);

  // Equal duration tie: 140 BPM for 4 beats (1.714s) vs 280 BPM for 8 beats (1.714s). Higher BPM (280) wins!
  const chartsTie = [
    {
      chartType: "dance-single",
      noteData: "0000\n0000\n0000\n0000,\n0000\n0000\n0000\n0000,\n0000\n0000\n0000\n0000,\n1000",
      chartTags: { BPMS: "0=140,4=280" },
    },
  ];
  assert.equal(computeCoreBpm(chartsTie, { BPMS: "0=140,4=280" }, true), 280);
});

function createTestDb() {
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
      core_bpm INTEGER,
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
  return db;
}

test("scanSongs merges packs with the same name across songs directories", async () => {
  const main = tempDir();
  const extra = tempDir();

  // Same pack name in both directories with different songs: both songs
  // must appear under the single merged pack.
  writeSongFile(
    path.join(main, "Shared Pack", "Song A"),
    "a.sm",
    "#TITLE:Song A;\n#ARTIST:Artist;\n#MUSIC:a.ogg;\n#NOTES:dance-single:1:Hard:12:1.0:0.0:0.0;\n",
  );
  writeSongFile(
    path.join(extra, "Shared Pack", "Song B"),
    "b.sm",
    "#TITLE:Song B;\n#ARTIST:Artist;\n#MUSIC:b.ogg;\n#NOTES:dance-single:1:Hard:12:1.0:0.0:0.0;\n",
  );

  const db = createTestDb();
  const result = await scanSongs(main, db, { additionalDirs: [extra] });

  assert.equal(result.songs, 2);
  const rows = db.prepare("SELECT title, pack FROM songs ORDER BY title").all();
  assert.deepEqual(rows, [
    { title: "Song A", pack: "Shared Pack" },
    { title: "Song B", pack: "Shared Pack" },
  ]);
});

test("scanSongs merges duplicate songs in the same pack and keeps all charts", async () => {
  const main = tempDir();
  const extra = tempDir();

  const extraFile = path.join(extra, "Pack", "Song X", "x.sm");
  writeSongFile(
    path.join(main, "Pack", "Song X"),
    "x.sm",
    "#TITLE:Song X;\n#ARTIST:Artist;\n#MUSIC:x.ogg;\n" +
      "#NOTES:dance-single:1:Easy:4:1.0:0.0:0.0;\n" +
      "#NOTES:dance-single:1:Hard:8:1.0:0.0:0.0;\n",
  );
  // The additional directory's copy has an extra "Edit" chart.
  writeSongFile(
    path.join(extra, "Pack", "Song X"),
    "x.sm",
    "#TITLE:Song X;\n#ARTIST:Artist;\n#MUSIC:x.ogg;\n" +
      "#NOTES:dance-single:1:Easy:4:1.0:0.0:0.0;\n" +
      "#NOTES:dance-single:1:Hard:8:1.0:0.0:0.0;\n" +
      "#NOTES:dance-single:1:Edit:12:1.0:0.0:0.0;\n",
  );

  const db = createTestDb();
  const result = await scanSongs(main, db, { additionalDirs: [extra] });

  assert.equal(result.songs, 1);
  // The copy with the most charts (in the additional directory) provides
  // the song row, regardless of which directory it lives in.
  assert.equal(db.prepare("SELECT file_path FROM songs").get().file_path, path.resolve(extraFile));
  // The chart list is the union of both copies, so no chart is dropped.
  const charts = db
    .prepare("SELECT chart_type, difficulty, meter FROM charts ORDER BY CAST(meter AS INTEGER)")
    .all();
  assert.deepEqual(charts, [
    { chart_type: "dance-single", difficulty: "Easy", meter: "4" },
    { chart_type: "dance-single", difficulty: "Hard", meter: "8" },
    { chart_type: "dance-single", difficulty: "Edit", meter: "12" },
  ]);
});

test("scanSongs keeps the same song when it exists in different packs", async () => {
  const main = tempDir();
  const extra = tempDir();

  writeSongFile(
    path.join(main, "Pack One", "Song S"),
    "s.sm",
    "#TITLE:Song S;\n#ARTIST:Artist;\n#MUSIC:s.ogg;\n#NOTES:dance-single:1:Hard:12:1.0:0.0:0.0;\n",
  );
  writeSongFile(
    path.join(extra, "Pack Two", "Song S"),
    "s.sm",
    "#TITLE:Song S;\n#ARTIST:Artist;\n#MUSIC:s.ogg;\n#NOTES:dance-single:1:Hard:12:1.0:0.0:0.0;\n",
  );

  const db = createTestDb();
  const result = await scanSongs(main, db, { additionalDirs: [extra] });

  assert.equal(result.songs, 2);
  const rows = db.prepare("SELECT title, pack FROM songs ORDER BY pack").all();
  assert.deepEqual(rows, [
    { title: "Song S", pack: "Pack One" },
    { title: "Song S", pack: "Pack Two" },
  ]);
});

test("scanSongs ignores songs directories listed more than once", async () => {
  const main = tempDir();
  writeSongFile(
    path.join(main, "Pack", "Song A"),
    "a.sm",
    "#TITLE:Song A;\n#ARTIST:Artist;\n#MUSIC:a.ogg;\n#NOTES:dance-single:1:Hard:12:1.0:0.0:0.0;\n",
  );

  const db = createTestDb();
  const result = await scanSongs(main, db, { additionalDirs: [main, main] });

  assert.equal(result.songs, 1);
});

test("scanSongs falls back to song folder name when the music tag is missing", async () => {
  const main = tempDir();
  const extra = tempDir();

  const songSm = "#TITLE:Same Name;\n#ARTIST:Artist;\n#NOTES:dance-single:1:Hard:12:1.0:0.0:0.0;\n";
  writeSongFile(path.join(main, "Pack", "Folder A"), "a.sm", songSm);
  writeSongFile(path.join(main, "Pack", "Folder B"), "b.sm", songSm);
  // Same folder name in the additional directory's copy of the pack.
  writeSongFile(path.join(extra, "Pack", "Folder A"), "a.sm", songSm);

  const db = createTestDb();
  const result = await scanSongs(main, db, { additionalDirs: [extra] });

  // Folder A is merged across directories; Folder B (distinct folder, and no
  // #MUSIC tag to identify the song any other way) is kept separately.
  assert.equal(result.songs, 2);
});
