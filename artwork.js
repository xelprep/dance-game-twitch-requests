const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { resolveThreadCount } = require("./scanner");

const ARTWORK_PROCESSOR_VERSION = "webp-320-v1";
const MAX_IMAGE_DIMENSION = 320;
const WEBP_QUALITY = 80;
const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"]);

function isPathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function resolveRealPath(candidatePath, roots) {
  if (!candidatePath || !SUPPORTED_EXTENSIONS.has(path.extname(candidatePath).toLowerCase())) {
    return null;
  }

  try {
    const realPath = fs.realpathSync(candidatePath);
    if (!fs.statSync(realPath).isFile()) return null;
    const realRoots = roots
      .map((root) => {
        try {
          return fs.realpathSync(root);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return realRoots.some((root) => isPathWithin(realPath, root)) ? realPath : null;
  } catch {
    return null;
  }
}

function firstNamedImage(directory, stems, roots) {
  let entries;
  try {
    entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return null;
  }

  for (const stem of stems) {
    const match = entries.find((entry) => {
      if (!entry.isFile()) return false;
      const extension = path.extname(entry.name).toLowerCase();
      return (
        SUPPORTED_EXTENSIONS.has(extension) &&
        path.basename(entry.name, path.extname(entry.name)).toLowerCase() === stem
      );
    });
    if (match) {
      const candidate = resolveRealPath(path.join(directory, match.name), roots);
      if (candidate) return candidate;
    }
  }
  return null;
}

function readTag(text, name) {
  const match = String(text || "").match(new RegExp(`#${name}\\s*:\\s*([^;]*);`, "i"));
  return match ? match[1].replace(/[\r\n]/g, " ").trim() : "";
}

function readPackBanner(packDirectory) {
  for (const fileName of ["pack.ini", "Pack.ini"]) {
    let text;
    try {
      text = fs.readFileSync(path.join(packDirectory, fileName), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*Banner\s*[:=]\s*(.*?)\s*$/i);
      if (match && match[1].trim()) return match[1].trim();
    }
  }
  return "";
}

function resolveSongArtworkCandidates(songFilePath, roots, simfileText = null) {
  const absoluteSongPath = path.resolve(songFilePath);
  const songDirectory = path.dirname(absoluteSongPath);
  const packDirectory = path.dirname(songDirectory);
  let text = simfileText;
  if (text === null) {
    try {
      text = fs.readFileSync(absoluteSongPath, "utf8");
    } catch {
      text = "";
    }
  }

  const explicitBanner = readTag(text, "BANNER");
  const explicitJacket = readTag(text, "JACKET");
  const candidates = [];
  if (explicitBanner)
    candidates.push({ kind: "banner", path: path.resolve(songDirectory, explicitBanner) });
  candidates.push({
    kind: "banner",
    path: firstNamedImage(songDirectory, ["banner", "bn"], roots),
  });
  if (explicitJacket)
    candidates.push({ kind: "jacket", path: path.resolve(songDirectory, explicitJacket) });
  candidates.push({ kind: "jacket", path: firstNamedImage(songDirectory, ["jacket"], roots) });

  const packBanner = readPackBanner(packDirectory);
  if (packBanner) candidates.push({ kind: "pack", path: path.resolve(packDirectory, packBanner) });
  candidates.push({
    kind: "pack",
    path: firstNamedImage(packDirectory, ["group", "banner"], roots),
  });

  const resolvedCandidates = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const sourcePath = candidate.path && resolveRealPath(candidate.path, roots);
    if (sourcePath && !seen.has(sourcePath)) {
      resolvedCandidates.push({ sourcePath, kind: candidate.kind });
      seen.add(sourcePath);
    }
  }
  return resolvedCandidates;
}

function resolveSongArtwork(songFilePath, roots, simfileText = null) {
  return resolveSongArtworkCandidates(songFilePath, roots, simfileText)[0] || null;
}

function ensureArtworkSchema(db) {
  const songColumns = db
    .prepare("PRAGMA table_info(songs)")
    .all()
    .map((row) => row.name);
  if (!songColumns.includes("artwork_key"))
    db.exec("ALTER TABLE songs ADD COLUMN artwork_key TEXT");
  if (!songColumns.includes("artwork_kind"))
    db.exec("ALTER TABLE songs ADD COLUMN artwork_kind TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS artwork_cache (
      source_path TEXT PRIMARY KEY,
      source_size INTEGER NOT NULL,
      source_mtime_ms REAL NOT NULL,
      processor_version TEXT NOT NULL,
      artwork_key TEXT NOT NULL,
      processed_at INTEGER NOT NULL
    );
  `);
}

function artworkFilePath(cacheDirectory, artworkKey) {
  if (typeof artworkKey !== "string" || !/^v[0-9]+-[a-f0-9]{64}$/.test(artworkKey)) return null;
  return path.join(cacheDirectory, `${artworkKey}.webp`);
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function processArtworkSource(db, sourcePath, cacheDirectory, { force = false } = {}) {
  const realPath = fs.realpathSync(sourcePath);
  const stat = fs.statSync(realPath);
  const previous = db.prepare("SELECT * FROM artwork_cache WHERE source_path = ?").get(realPath);
  const cachedOutput = previous && artworkFilePath(cacheDirectory, previous.artwork_key);

  if (
    !force &&
    previous &&
    previous.source_size === stat.size &&
    previous.source_mtime_ms === stat.mtimeMs &&
    previous.processor_version === ARTWORK_PROCESSOR_VERSION &&
    cachedOutput &&
    fs.existsSync(cachedOutput)
  ) {
    return { artworkKey: previous.artwork_key, reused: true };
  }

  const contentHash = await hashFile(realPath);
  const artworkKey = `v1-${crypto
    .createHash("sha256")
    .update(`${ARTWORK_PROCESSOR_VERSION}:${contentHash}`)
    .digest("hex")}`;
  const outputPath = artworkFilePath(cacheDirectory, artworkKey);
  const outputExists = fs.existsSync(outputPath);
  fs.mkdirSync(cacheDirectory, { recursive: true });

  if (force || !outputExists) {
    const tempPath = `${outputPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await sharp(realPath, { limitInputPixels: 40000000, failOn: "warning" })
        .rotate()
        .resize({
          width: MAX_IMAGE_DIMENSION,
          height: MAX_IMAGE_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: WEBP_QUALITY })
        .toFile(tempPath);
      fs.renameSync(tempPath, outputPath);
    } catch (error) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
      throw error;
    }
  }

  db.prepare(
    `
    INSERT INTO artwork_cache
      (source_path, source_size, source_mtime_ms, processor_version, artwork_key, processed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      source_size = excluded.source_size,
      source_mtime_ms = excluded.source_mtime_ms,
      processor_version = excluded.processor_version,
      artwork_key = excluded.artwork_key,
      processed_at = excluded.processed_at
  `,
  ).run(realPath, stat.size, stat.mtimeMs, ARTWORK_PROCESSOR_VERSION, artworkKey, Date.now());

  return { artworkKey, reused: outputExists && !force };
}

async function processSongArtwork(
  db,
  { songsRoots, cacheDirectory, force = false, threads, onProgress } = {},
) {
  ensureArtworkSchema(db);
  // Match the concurrency the user configured for the song scanner. An
  // explicit `threads` option wins; otherwise fall back to SCANNER_THREADS
  // (or all cores), the same value `scanSongs` uses.
  const numThreads = resolveThreadCount(threads);
  const roots = [...new Set((songsRoots || []).map((root) => path.resolve(root)))];
  if (
    !roots.length ||
    roots.some((root) => !fs.existsSync(root) || !fs.statSync(root).isDirectory())
  ) {
    throw new Error("All configured Songs directories must be available to process artwork.");
  }
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const songs = db.prepare("SELECT id, file_path FROM songs ORDER BY id").all();
  const result = {
    total: songs.length,
    processed: 0,
    reused: 0,
    missing: 0,
    failed: 0,
    threads: numThreads,
    errors: [],
  };
  let completed = 0;

  // In-flight dedup: several songs can resolve to the same source image
  // (e.g. a shared pack banner). Only the first caller does the actual
  // hash/encode work; the rest await the same promise and are reported as
  // reuses. A settled entry is dropped on success so a later song takes the
  // fast cache path; a failed entry is kept so later callers fail fast
  // instead of repeating the same failed work.
  const inFlight = new Map();
  const processSource = (sourcePath) => {
    const pending = inFlight.get(sourcePath);
    if (pending) {
      return pending.then((processed) => ({ ...processed, reused: true }));
    }
    const promise = processArtworkSource(db, sourcePath, cacheDirectory, { force });
    inFlight.set(sourcePath, promise);
    promise.then(
      () => inFlight.delete(sourcePath),
      () => {},
    );
    return promise;
  };

  const processOne = async (song) => {
    try {
      const candidates = resolveSongArtworkCandidates(song.file_path, roots);
      if (!candidates.length) {
        db.prepare("UPDATE songs SET artwork_key = NULL, artwork_kind = NULL WHERE id = ?").run(
          song.id,
        );
        result.missing++;
      } else {
        let resolved = null;
        let candidateError = null;
        for (const candidate of candidates) {
          try {
            const processed = await processSource(candidate.sourcePath);
            resolved = { ...candidate, ...processed };
            break;
          } catch (error) {
            candidateError = error;
          }
        }
        if (!resolved) throw candidateError || new Error("No usable artwork image found.");
        db.prepare("UPDATE songs SET artwork_key = ?, artwork_kind = ? WHERE id = ?").run(
          resolved.artworkKey,
          resolved.kind,
          song.id,
        );
        result[resolved.reused ? "reused" : "processed"]++;
      }
    } catch (error) {
      db.prepare("UPDATE songs SET artwork_key = NULL, artwork_kind = NULL WHERE id = ?").run(
        song.id,
      );
      result.failed++;
      if (result.errors.length < 20) {
        result.errors.push({
          songFile: path.basename(song.file_path),
          error: error.message || String(error),
        });
      }
    }
    completed++;
    if (onProgress) onProgress(completed, songs.length, result);
  };

  // Bounded concurrency: at most `numThreads` songs are in flight at once.
  // A shared cursor hands each worker the next unfinished song, so a slow
  // image never idles a worker (dynamic work stealing). Sharp's async API
  // keeps the CPU work off the event loop, so the SQLite writes above stay
  // serialized on the main thread.
  let nextSongIndex = 0;
  const workerCount = Math.min(numThreads, songs.length);
  const workers = Array.from({ length: workerCount }, () =>
    (async () => {
      for (;;) {
        const index = nextSongIndex++;
        if (index >= songs.length) break;
        await processOne(songs[index]);
      }
    })(),
  );
  await Promise.all(workers);

  if (result.failed === 0) {
    const referencedKeys = new Set(
      db
        .prepare("SELECT DISTINCT artwork_key FROM songs WHERE artwork_key IS NOT NULL")
        .all()
        .map((row) => row.artwork_key),
    );
    for (const entry of db.prepare("SELECT source_path, artwork_key FROM artwork_cache").all()) {
      if (referencedKeys.has(entry.artwork_key)) continue;
      db.prepare("DELETE FROM artwork_cache WHERE source_path = ?").run(entry.source_path);
    }
    for (const entry of fs.readdirSync(cacheDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".webp")) continue;
      const artworkKey = entry.name.slice(0, -5);
      if (!referencedKeys.has(artworkKey))
        fs.rmSync(path.join(cacheDirectory, entry.name), { force: true });
    }
  }

  return result;
}

module.exports = {
  ARTWORK_PROCESSOR_VERSION,
  artworkFilePath,
  ensureArtworkSchema,
  processArtworkSource,
  processSongArtwork,
  readPackBanner,
  resolveSongArtwork,
  resolveSongArtworkCandidates,
};
