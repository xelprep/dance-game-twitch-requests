const fs = require("fs");
const path = require("path");

function decodeSMValue(raw) {
  return String(raw || "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTags(text) {
  const tags = {};
  const re = /#([A-Z0-9_]+):([\s\S]*?);/gi;
  let m;
  while ((m = re.exec(text))) {
    tags[m[1].toUpperCase()] = decodeSMValue(m[2]);
  }
  return tags;
}

function parseNotesBlocks(text) {
  const charts = [];

  // Standard .sm #NOTES blocks.
  const smRe = /#NOTES:\s*([\s\S]*?);/gi;
  let m;
  while ((m = smRe.exec(text))) {
    const fields = m[1].split(":").map(x => x.trim());
    if (fields.length >= 6) {
      charts.push({
        chartType: fields[0],
        difficulty: fields[2],
        meter: fields[3],
        radar: fields[4]
      });
    }
  }

  // .ssc #NOTEDATA blocks.
  const sscRe = /#NOTEDATA\s*;([\s\S]*?)(?=#NOTEDATA\s*;|$)/gi;
  while ((m = sscRe.exec(text))) {
    const block = m[1];
    const tags = parseTags(block);
    if (tags.STEPSTYPE || tags.DIFFICULTY || tags.METER) {
      charts.push({
        chartType: tags.STEPSTYPE || "",
        difficulty: tags.DIFFICULTY || "",
        meter: tags.METER || "",
        radar: tags.RADARVALUES || ""
      });
    }
  }

  return charts;
}

function readPackIniDisplayTitle(packDir) {
  const iniNames = ["pack.ini", "Pack.ini"];
  for (const fileName of iniNames) {
    const iniPath = path.join(packDir, fileName);
    if (!fs.existsSync(iniPath)) continue;

    const text = fs.readFileSync(iniPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*DisplayTitle\s*[:=]\s*(.*?)\s*$/i);
      if (!match) continue;

      const value = (match[1] || "").trim();
      return value;
    }
  }

  return "";
}

function readSongFile(filePath, packOverride) {
  const text = fs.readFileSync(filePath, "utf8");
  const tags = parseTags(text);

  const stat = fs.statSync(filePath);
  const pack = packOverride || path.basename(path.dirname(filePath));

  return {
    filePath,
    title: tags.TITLE || path.basename(filePath, path.extname(filePath)),
    subtitle: tags.SUBTITLE || "",
    artist: tags.ARTIST || "",
    genre: tags.GENRE || "",
    music: tags.MUSIC || "",
    pack,
    lastModified: stat.mtimeMs,
    charts: parseNotesBlocks(text)
  };
}

function collectSongFiles(songsDir) {
  const files = [];
  if (!fs.existsSync(songsDir)) return files;

  for (const packEntry of fs.readdirSync(songsDir, { withFileTypes: true })) {
    if (!packEntry.isDirectory()) continue;

    const packDir = path.join(songsDir, packEntry.name);
    for (const songEntry of fs.readdirSync(packDir, { withFileTypes: true })) {
      if (!songEntry.isDirectory()) continue;

      const songDir = path.join(packDir, songEntry.name);
      const songFiles = [];
      for (const fileEntry of fs.readdirSync(songDir, { withFileTypes: true })) {
        if (fileEntry.isFile() && /\.(sm|ssc)$/i.test(fileEntry.name)) {
          songFiles.push(path.join(songDir, fileEntry.name));
        }
      }

      if (!songFiles.length) continue;

      const preferredFile = songFiles.find(file => /\.ssc$/i.test(file)) || songFiles[0];
      files.push(preferredFile);
    }
  }

  return files.sort();
}

function scanSongs(songsDir, db) {
  const files = collectSongFiles(songsDir);
  const seen = new Set();

  const upsertSong = db.prepare(`
    INSERT INTO songs
      (file_path, title, subtitle, artist, genre, pack, music, last_modified)
    VALUES
      (@filePath, @title, @subtitle, @artist, @genre, @pack, @music, @lastModified)
    ON CONFLICT(file_path) DO UPDATE SET
      title = excluded.title,
      subtitle = excluded.subtitle,
      artist = excluded.artist,
      genre = excluded.genre,
      pack = excluded.pack,
      music = excluded.music,
      last_modified = excluded.last_modified
  `);

  const getSong = db.prepare("SELECT id FROM songs WHERE file_path = ?");
  const clearCharts = db.prepare("DELETE FROM charts WHERE song_id = ?");
  const addChart = db.prepare(`
    INSERT OR IGNORE INTO charts
      (song_id, chart_type, difficulty, meter, radar)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const filePath of files) {
      const normalizedPath = path.resolve(filePath);
      const relativePath = path.relative(songsDir, normalizedPath);
      const packDir = path.join(songsDir, relativePath.split(path.sep)[0] || "");
      const pack = readPackIniDisplayTitle(packDir) || (relativePath.split(path.sep)[0] || "");
      const song = readSongFile(normalizedPath, pack);

      upsertSong.run(song);
      const row = getSong.get(normalizedPath);
      if (!row) continue;

      seen.add(normalizedPath);
      clearCharts.run(row.id);

      for (const chart of song.charts) {
        addChart.run(
          row.id,
          chart.chartType,
          chart.difficulty,
          chart.meter,
          chart.radar
        );
      }
    }

    // Remove files that no longer exist.
    const existing = db.prepare("SELECT id, file_path FROM songs").all();
    const removeSong = db.prepare("DELETE FROM songs WHERE id = ?");
    for (const row of existing) {
      if (!seen.has(path.resolve(row.file_path))) {
        removeSong.run(row.id);
      }
    }
  });

  tx();

  return {
    songs: db.prepare("SELECT COUNT(*) AS n FROM songs").get().n,
    charts: db.prepare("SELECT COUNT(*) AS n FROM charts").get().n
  };
}

module.exports = { scanSongs, readSongFile };
