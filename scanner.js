const { installConsoleLogger } = require("./logger");

installConsoleLogger();

const fs = require("fs");
const path = require("path");

function decodeSMValue(raw) {
  return String(raw || "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Meters come through as raw strings; some charts write leading zeros
// (e.g. "06"). Normalize numeric meters so "06" and "6" don't end up as
// two distinct values in the database.
function normalizeMeter(raw) {
  const value = decodeSMValue(raw);
  return /^-?\d+$/.test(value) ? String(Number(value)) : value;
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

// --- BPM / duration extraction ---

// Parse "beat=value" pairs from a #BPMS or #STOPS tag value. For #BPMS the
// value is the tempo; for #STOPS it is the stop length in beats.
function parseBeatValuePairs(raw) {
  const pairs = [];
  const re = /(\d+(?:\.\d+)?)\s*=\s*(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(String(raw || "")))) {
    pairs.push({ beat: Number(m[1]), value: Number(m[2]) });
  }
  pairs.sort((a, b) => a.beat - b.beat);
  return pairs;
}

// #DISPLAYBPM is either a single number ("150") or a range ("120:240").
// Missing, "*", or anything malformed means "not set".
function parseDisplayBpm(raw) {
  const value = decodeSMValue(raw).trim();
  if (!value || value === "*") return null;
  const m = value.match(/^(\d+(?:\.\d+)?)\s*(?::\s*(\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const low = Math.round(Number(m[1]));
  const high = m[2] !== undefined ? Math.round(Number(m[2])) : low;
  return { min: Math.min(low, high), max: Math.max(low, high) };
}

function sscNotedataBlocks(text) {
  const blocks = [];
  const re = /#NOTEDATA\s*:?\s*;([\s\S]*?)(?=#NOTEDATA\s*:?\s*;|$)/gi;
  let m;
  while ((m = re.exec(text))) blocks.push(m[1]);
  return blocks;
}

// File-level tags. For .ssc files only the portion before the first #NOTEDATA
// block is considered, so chart-local tags never shadow the global ones.
function globalTagsFor(text, isSsc) {
  if (!isSsc) return parseTags(text);
  const idx = text.search(/#NOTEDATA/i);
  return parseTags(idx === -1 ? text : text.slice(0, idx));
}

// Canonical BPM range for a song. #DISPLAYBPM (explicit number or range) wins
// outright; otherwise the min/max of every relevant #BPMS value is used.
function extractBpmRange(text, isSsc) {
  const tags = globalTagsFor(text, isSsc);
  const display = parseDisplayBpm(tags.DISPLAYBPM);
  if (display) return display;

  const values = parseBeatValuePairs(tags.BPMS).map((p) => p.value);
  if (isSsc) {
    // Charts with #TIMINGMODE:STEPS carry their own #BPMS.
    for (const block of sscNotedataBlocks(text)) {
      const blockTags = parseTags(block);
      const timingMode = decodeSMValue(blockTags.TIMINGMODE || "").toUpperCase();
      if (timingMode === "STEPS" && blockTags.BPMS) {
        values.push(...parseBeatValuePairs(blockTags.BPMS).map((p) => p.value));
      }
    }
  }
  if (!values.length) return null;
  return {
    min: Math.round(Math.min(...values)),
    max: Math.round(Math.max(...values)),
  };
}

// Total beats of a chart from its note measures. Each note line holds
// (pipes - 1) measures; a measure holds `meter` beats.
function countChartBeats(notesText, meter) {
  const beatsPerMeasure = Number(meter);
  if (!Number.isFinite(beatsPerMeasure) || beatsPerMeasure <= 0) return 0;
  let measures = 0;
  for (const line of String(notesText || "").split(/\r?\n/)) {
    const pipes = (line.match(/\|/g) || []).length;
    if (pipes > 1) measures += pipes - 1;
  }
  return measures * beatsPerMeasure;
}

// Seconds of audio for one chart: the beat-by-beat length under its BPM
// timeline, plus stop lengths, plus the file #OFFSET (seconds of audio before
// beat zero).
function chartDurationSeconds(chart, offsetSeconds) {
  const timeline = parseBeatValuePairs(chart.bpms);
  const bpmAt = (beat) => {
    if (!timeline.length) return 120;
    let bpm = timeline[0].value;
    for (const entry of timeline) {
      if (entry.beat <= beat) bpm = entry.value;
      else break;
    }
    return bpm;
  };

  let seconds = 0;
  for (let beat = 0; beat < chart.lastBeat; beat++) {
    seconds += 60 / bpmAt(beat);
  }
  for (const stop of parseBeatValuePairs(chart.stops)) {
    if (stop.beat > chart.lastBeat) continue;
    seconds += stop.value * (60 / bpmAt(stop.beat));
  }
  return seconds + offsetSeconds;
}

// Maximum duration (whole seconds) across the song's dance charts.
// #LASTSECONDHINT short-circuits everything when present.
function extractDurationSeconds(text, isSsc) {
  const tags = globalTagsFor(text, isSsc);
  if (tags.LASTSECONDHINT) {
    const hint = Number.parseFloat(tags.LASTSECONDHINT);
    if (Number.isFinite(hint) && hint > 0) return Math.round(hint);
  }

  const parsedOffset = Number.parseFloat(tags.OFFSET);
  const offsetSeconds = Number.isFinite(parsedOffset) ? parsedOffset : 0;
  const charts = [];

  if (isSsc) {
    for (const block of sscNotedataBlocks(text)) {
      const blockTags = parseTags(block);
      if (blockTags.STEPSTYPE !== "dance-single" && blockTags.STEPSTYPE !== "dance-double") {
        continue;
      }
      const notesMatch = block.match(/#NOTES\s*;([\s\S]*?);/i);
      charts.push({
        bpms: blockTags.BPMS || tags.BPMS || "",
        stops: blockTags.STOPS || tags.STOPS || "",
        lastBeat: countChartBeats(notesMatch ? notesMatch[1] : "", blockTags.METER),
      });
    }
  } else {
    const re = /#NOTES:\s*([^;]*);([\s\S]*?);/gi;
    let m;
    while ((m = re.exec(text))) {
      const fields = m[1].split(":").map((x) => x.trim());
      if (fields.length < 4) continue;
      if (fields[0] !== "dance-single" && fields[0] !== "dance-double") continue;
      charts.push({
        bpms: tags.BPMS || "",
        stops: tags.STOPS || "",
        lastBeat: countChartBeats(m[2], fields[3]),
      });
    }
  }

  if (!charts.length) return null;
  let max = 0;
  for (const chart of charts) {
    max = Math.max(max, chartDurationSeconds(chart, offsetSeconds));
  }
  return Math.round(max);
}

function parseNotesBlocks(text) {
  const charts = [];

  // Standard .sm #NOTES blocks.
  const smRe = /#NOTES:\s*([\s\S]*?);/gi;
  let m;
  while ((m = smRe.exec(text))) {
    const fields = m[1].split(":").map((x) => x.trim());
    if (fields.length >= 6) {
      const chart = {
        chartType: fields[0],
        difficulty: fields[2],
        meter: normalizeMeter(fields[3]),
        radar: fields[4],
      };
      if (chart.chartType === "dance-single" || chart.chartType === "dance-double") {
        charts.push(chart);
      }
    }
  }

  // .ssc #NOTEDATA blocks.
  const sscRe = /#NOTEDATA\s*:?\s*;([\s\S]*?)(?=#NOTEDATA\s*:?\s*;|$)/gi;
  while ((m = sscRe.exec(text))) {
    const block = m[1];
    const tags = parseTags(block);
    if (tags.STEPSTYPE || tags.DIFFICULTY || tags.METER) {
      const chart = {
        chartType: tags.STEPSTYPE || "",
        difficulty: tags.DIFFICULTY || "",
        meter: normalizeMeter(tags.METER || ""),
        radar: tags.RADARVALUES || "",
      };
      if (chart.chartType === "dance-single" || chart.chartType === "dance-double") {
        charts.push(chart);
      }
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
  const isSsc = /\.ssc$/i.test(filePath);

  const stat = fs.statSync(filePath);
  const pack = packOverride || path.basename(path.dirname(filePath));
  const bpm = extractBpmRange(text, isSsc);

  return {
    filePath,
    title: tags.TITLE || path.basename(filePath, path.extname(filePath)),
    subtitle: tags.SUBTITLE || "",
    artist: tags.ARTIST || "",
    genre: tags.GENRE || "",
    music: tags.MUSIC || "",
    pack,
    lastModified: stat.mtimeMs,
    bpmMin: bpm ? bpm.min : null,
    bpmMax: bpm ? bpm.max : null,
    duration: extractDurationSeconds(text, isSsc),
    charts: parseNotesBlocks(text),
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

      const preferredFile = songFiles.find((file) => /\.ssc$/i.test(file)) || songFiles[0];
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
      (file_path, title, subtitle, artist, genre, pack, music, last_modified, bpm_min, bpm_max, duration)
    VALUES
      (@filePath, @title, @subtitle, @artist, @genre, @pack, @music, @lastModified, @bpmMin, @bpmMax, @duration)
    ON CONFLICT(file_path) DO UPDATE SET
      title = excluded.title,
      subtitle = excluded.subtitle,
      artist = excluded.artist,
      genre = excluded.genre,
      pack = excluded.pack,
      music = excluded.music,
      last_modified = excluded.last_modified,
      bpm_min = excluded.bpm_min,
      bpm_max = excluded.bpm_max,
      duration = excluded.duration
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
      const pack = readPackIniDisplayTitle(packDir) || relativePath.split(path.sep)[0] || "";
      const song = readSongFile(normalizedPath, pack);

      upsertSong.run(song);
      const row = getSong.get(normalizedPath);
      if (!row) continue;

      seen.add(normalizedPath);
      clearCharts.run(row.id);

      for (const chart of song.charts) {
        addChart.run(row.id, chart.chartType, chart.difficulty, chart.meter, chart.radar);
      }
    }

    // Remove files that no longer exist.
    const existing = db.prepare("SELECT id, file_path FROM songs").all();
    const removeRequests = db.prepare("DELETE FROM requests WHERE song_id = ?");
    const removeCharts = db.prepare("DELETE FROM charts WHERE song_id = ?");
    const removeBlocked = db.prepare("DELETE FROM blocked WHERE song_id = ?");
    const removeSong = db.prepare("DELETE FROM songs WHERE id = ?");
    for (const row of existing) {
      if (!seen.has(path.resolve(row.file_path))) {
        removeRequests.run(row.id);
        removeCharts.run(row.id);
        removeBlocked.run(row.id);
        removeSong.run(row.id);
      }
    }
  });

  tx();

  return {
    songs: db.prepare("SELECT COUNT(*) AS n FROM songs").get().n,
    charts: db.prepare("SELECT COUNT(*) AS n FROM charts").get().n,
  };
}

module.exports = { scanSongs, readSongFile };
