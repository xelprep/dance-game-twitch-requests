process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const sharp = require("sharp");
const {
  artworkFilePath,
  ensureArtworkSchema,
  processArtworkSource,
  processSongArtwork,
  resolveSongArtwork,
} = require("../../artwork.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dance-artwork-tests-"));
}

async function writeImage(filePath, color = "#336699", width = 640, height = 320) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toFile(filePath);
}

function createDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE songs (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL
    );
  `);
  ensureArtworkSchema(db);
  return db;
}

test("song artwork follows banner, jacket, then pack fallback order", async () => {
  const root = tempDir();
  const pack = path.join(root, "Pack");
  const song = path.join(pack, "Song");
  const filePath = path.join(song, "chart.ssc");
  fs.mkdirSync(song, { recursive: true });
  fs.writeFileSync(filePath, "#BANNER:missing.png;\n#JACKET:custom jacket.PNG;\n", "utf8");
  await writeImage(path.join(song, "banner.JPG"), "#cc3344");
  await writeImage(path.join(song, "custom jacket.PNG"), "#33aa66");
  await writeImage(path.join(pack, "group.png"), "#6633cc");

  assert.deepEqual(resolveSongArtwork(filePath, [root]), {
    sourcePath: fs.realpathSync(path.join(song, "banner.JPG")),
    kind: "banner",
  });

  fs.rmSync(path.join(song, "banner.JPG"));
  assert.deepEqual(resolveSongArtwork(filePath, [root]), {
    sourcePath: fs.realpathSync(path.join(song, "custom jacket.PNG")),
    kind: "jacket",
  });

  fs.rmSync(path.join(song, "custom jacket.PNG"));
  assert.deepEqual(resolveSongArtwork(filePath, [root]), {
    sourcePath: fs.realpathSync(path.join(pack, "group.png")),
    kind: "pack",
  });
});

test("bn.png is treated as a banner fallback when no explicit banner or banner.* exists", async () => {
  const root = tempDir();
  const pack = path.join(root, "Pack");
  const song = path.join(pack, "Song");
  const filePath = path.join(song, "chart.ssc");
  fs.mkdirSync(song, { recursive: true });
  fs.writeFileSync(filePath, "#TITLE:Song;", "utf8");
  await writeImage(path.join(song, "bn.png"), "#ff9900");
  await writeImage(path.join(pack, "group.png"), "#336699");

  assert.deepEqual(resolveSongArtwork(filePath, [root]), {
    sourcePath: fs.realpathSync(path.join(song, "bn.png")),
    kind: "banner",
  });
});

test("pack.ini Banner takes priority over conventional pack images", async () => {
  const root = tempDir();
  const pack = path.join(root, "Pack");
  const song = path.join(pack, "Song");
  const filePath = path.join(song, "chart.sm");
  fs.mkdirSync(song, { recursive: true });
  fs.writeFileSync(filePath, "#TITLE:Song;", "utf8");
  fs.writeFileSync(path.join(pack, "pack.ini"), "[Group]\nBanner=preferred art.png\n", "utf8");
  await writeImage(path.join(pack, "preferred art.png"), "#cc3344");
  await writeImage(path.join(pack, "group.png"), "#336699");

  assert.deepEqual(resolveSongArtwork(filePath, [root]), {
    sourcePath: fs.realpathSync(path.join(pack, "preferred art.png")),
    kind: "pack",
  });
});

test("artwork resolver rejects paths outside configured Songs roots", async () => {
  const root = tempDir();
  const outside = tempDir();
  const pack = path.join(root, "Pack");
  const song = path.join(pack, "Song");
  const filePath = path.join(song, "chart.ssc");
  fs.mkdirSync(song, { recursive: true });
  fs.writeFileSync(filePath, "#BANNER:../../../../outside.png;", "utf8");
  await writeImage(path.join(outside, "outside.png"));
  await writeImage(path.join(pack, "group.png"));

  assert.equal(resolveSongArtwork(filePath, [root]).kind, "pack");
});

test("artwork processor reuses derivatives for unchanged input", async () => {
  const root = tempDir();
  const sourcePath = path.join(root, "banner.png");
  const cacheDirectory = path.join(root, "cache");
  await writeImage(sourcePath, "#336699", 1200, 600);
  const db = createDb();

  const first = await processArtworkSource(db, sourcePath, cacheDirectory);
  const second = await processArtworkSource(db, sourcePath, cacheDirectory);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.artworkKey, first.artworkKey);
  assert.ok(fs.existsSync(artworkFilePath(cacheDirectory, first.artworkKey)));
  fs.writeFileSync(artworkFilePath(cacheDirectory, first.artworkKey), "corrupt");
  const refreshed = await processArtworkSource(db, sourcePath, cacheDirectory, { force: true });
  assert.equal(refreshed.reused, false);
  const previousMtime = fs.statSync(sourcePath).mtime;
  fs.utimesSync(sourcePath, new Date(previousMtime.getTime() + 5000), new Date());
  const sameContentNewTimestamp = await processArtworkSource(db, sourcePath, cacheDirectory);
  assert.equal(sameContentNewTimestamp.reused, true);
  const metadata = await sharp(artworkFilePath(cacheDirectory, first.artworkKey)).metadata();
  assert.deepEqual([metadata.width, metadata.height], [320, 160]);
  assert.equal(metadata.format, "webp");
  db.close();
});

test("processing falls through a corrupt declared banner to pack artwork", async () => {
  const root = tempDir();
  const pack = path.join(root, "Pack");
  const song = path.join(pack, "Song");
  const songFile = path.join(song, "chart.ssc");
  const cacheDirectory = path.join(root, "cache");
  fs.mkdirSync(song, { recursive: true });
  fs.writeFileSync(songFile, "#BANNER:broken.png;", "utf8");
  fs.writeFileSync(path.join(song, "broken.png"), "not an image");
  await writeImage(path.join(pack, "group.png"));
  const db = createDb();
  db.prepare("INSERT INTO songs (file_path, title) VALUES (?, ?)").run(songFile, "Fallback");

  const result = await processSongArtwork(db, { songsRoots: [root], cacheDirectory });
  const row = db.prepare("SELECT artwork_key, artwork_kind FROM songs").get();
  assert.equal(result.failed, 0);
  assert.equal(result.processed, 1);
  assert.equal(row.artwork_kind, "pack");
  db.close();
});

test("processing preserves artwork when configured Songs roots are unavailable", async () => {
  const db = createDb();
  const artworkKey = `v1-${"d".repeat(64)}`;
  db.prepare("INSERT INTO songs (file_path, title, artwork_key) VALUES (?, ?, ?)").run(
    "missing-root/song.sm",
    "Preserve artwork",
    artworkKey,
  );

  await assert.rejects(
    processSongArtwork(db, { songsRoots: [], cacheDirectory: tempDir() }),
    /Songs directories must be available/,
  );
  assert.equal(db.prepare("SELECT artwork_key FROM songs").get().artwork_key, artworkKey);
  db.close();
});
