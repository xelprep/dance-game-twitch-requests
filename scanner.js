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

function parseNotesBlocks(text) {
  const charts = [];

  // Standard .sm #NOTES blocks.
  const smRe = /#NOTES:\s*([\s\S]*?);/gi;
  let m;
  while ((m = smRe.exec(text))) {
    const hm = m[1].match(/^\s*([^:\n]*):([^:\n]*):([^:\n]*):([^:\n]*):([^:\n]*):([\s\S]*)$/);
    if (hm) {
      const chart = {
        chartType: hm[1].trim(),
        difficulty: hm[3].trim(),
        meter: normalizeMeter(hm[4]),
        radar: hm[5].trim(),
        noteData: hm[6] || "",
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
    // The #NOTES line may be `#NOTES:;` or a bare `#NOTES:` with the note
    // data starting on the following line.
    const notesMatch = /#NOTES\s*:[^\n;]*(;|\r?\n|$)/i.exec(block);
    const tagText = notesMatch ? block.slice(0, notesMatch.index) : block;
    const noteData = notesMatch ? block.slice(notesMatch.index + notesMatch[0].length) : "";
    const tags = parseTags(tagText);
    if (tags.STEPSTYPE || tags.DIFFICULTY || tags.METER) {
      const chart = {
        chartType: tags.STEPSTYPE || "",
        difficulty: tags.DIFFICULTY || "",
        meter: normalizeMeter(tags.METER || ""),
        radar: tags.RADARVALUES || "",
        noteData,
        chartTags: tags,
      };
      if (chart.chartType === "dance-single" || chart.chartType === "dance-double") {
        charts.push(chart);
      }
    }
  }

  return charts;
}

// ---------------------------------------------------------------------------
// BPM & duration parsing
//
// Timing semantics follow the StepMania MSD format:
//   - note data is comma-separated measures; the rows in a measure are
//     subdivisions of the measure's beats (4 rows = quarter notes, 8 = 8ths,
//     16 = 16ths), so row `l` of a measure is worth `numerator / rowCount`
//     beats where `numerator` is the active time signature's beats per
//     measure (default 4);
//   - `#TIMESIGNATURES` entries are `beat=numerator=denominator`; the
//     numerator is what affects timing (1 beat = quarter note always);
//   - beat/value lists (`#BPMS`, `#STOPS`, `#DELAYS`, `#WARPS`, ...) are
//     comma-separated `beat=value` pairs terminated by a semicolon (the
//     semicolon may sit on its own line);
//   - the beat->time state machine matches the reference TimingEngine:
//     initial state is beat 0 at time `-offset` at the first BPM; warped
//     segments elapse no wall-clock time; stop/delay seconds are added when
//     the stop/delay ends.
// ---------------------------------------------------------------------------

// Event tag ordering (subset of the reference engine; fakes never affect
// wall-clock time, so they are not modeled).
const TAG_WARP = 0;
const TAG_WARP_END = 1;
const TAG_BPM = 2;
const TAG_DELAY = 3;
const TAG_DELAY_END = 4;
const TAG_STOP = 5;
const TAG_STOP_END = 6;

// Parse a comma-separated `beat=value[, beat=value...]` list.
function parseBeatValues(raw) {
  const out = [];
  if (!raw) return out;
  for (const token of String(raw).split(",")) {
    const t = token.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const beat = parseFloat(t.slice(0, eq));
    const value = parseFloat(t.slice(eq + 1));
    if (Number.isFinite(beat) && Number.isFinite(value)) {
      out.push({ beat, value });
    }
  }
  out.sort((a, b) => a.beat - b.beat);
  return out;
}

// Parse a comma-separated `beat=numerator=denominator[...]` list.
function parseTimeSignatures(raw) {
  const out = [];
  if (!raw) return out;
  for (const token of String(raw).split(",")) {
    const t = token.trim();
    if (!t) continue;
    const parts = t.split("=").map((p) => p.trim());
    if (parts.length < 2) continue;
    const beat = parseFloat(parts[0]);
    const numerator = parseInt(parts[1], 10);
    if (Number.isFinite(beat) && Number.isFinite(numerator) && numerator > 0) {
      out.push({ beat, numerator });
    }
  }
  out.sort((a, b) => a.beat - b.beat);
  return out;
}

// Round the BPM range for a song. `#DISPLAYBPM` wins when present and
// usable; `*` (random) or invalid values fall back to `#BPMS`.
function parseBpm(songTags) {
  const display = songTags.DISPLAYBPM;
  if (display && display !== "*") {
    // Ranges are written `min-max`; a leading `-` would parse the second
    // value as negative, so only match unsigned numbers.
    const values = (display.match(/\d+(?:\.\d+)?/g) || [])
      .map(Number)
      .filter((v) => Number.isFinite(v) && v > 0);
    if (values.length) {
      return {
        bpmMin: Math.round(Math.min(...values)),
        bpmMax: Math.round(Math.max(...values)),
      };
    }
  }
  const bpms = parseBeatValues(songTags.BPMS).filter((e) => e.value > 0);
  if (bpms.length) {
    return {
      bpmMin: Math.round(Math.min(...bpms.map((e) => e.value))),
      bpmMax: Math.round(Math.max(...bpms.map((e) => e.value))),
    };
  }
  return { bpmMin: null, bpmMax: null };
}

// The song header is everything before the first chart block; timing tags
// parsed from it are the song-level values (chart-level tags in .ssc files
// must not shadow them).
function songHeader(text) {
  const m = /#(NOTEDATA|NOTES)\s*:/i.exec(text);
  return m ? text.slice(0, m.index) : text;
}

function parseOffset(raw) {
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : 0;
}

// Resolve the timing data used by one chart. .ssc charts that define their
// own `#BPMS` act as their own timing source (StepMania >= 0.7), with
// per-field fallback to the song-level values for anything the chart does
// not define.
function chartTiming(chart, songTags, isSSC) {
  const song = {
    bpms: parseBeatValues(songTags.BPMS),
    stops: parseBeatValues(songTags.STOPS),
    delays: parseBeatValues(songTags.DELAYS),
    warps: parseBeatValues(songTags.WARPS),
    offset: parseOffset(songTags.OFFSET),
    timeSignatures: parseTimeSignatures(songTags.TIMESIGNATURES),
  };
  const ct = isSSC ? chart.chartTags : null;
  if (!ct || !ct.BPMS) return song;
  return {
    bpms: parseBeatValues(ct.BPMS),
    stops: ct.STOPS !== undefined ? parseBeatValues(ct.STOPS) : song.stops,
    delays: ct.DELAYS !== undefined ? parseBeatValues(ct.DELAYS) : song.delays,
    warps: ct.WARPS !== undefined ? parseBeatValues(ct.WARPS) : song.warps,
    offset: ct.OFFSET !== undefined && ct.OFFSET !== "" ? parseOffset(ct.OFFSET) : song.offset,
    timeSignatures:
      ct.TIMESIGNATURES !== undefined
        ? parseTimeSignatures(ct.TIMESIGNATURES)
        : song.timeSignatures,
  };
}

// Build the beat->time state machine for a set of timing data. Returns an
// array of states (each with the song time at that event), or null when no
// BPM data is available.
function buildTimingStates(timing) {
  const bpms = timing.bpms || [];
  if (!bpms.length) return null;

  const events = [];
  for (const e of bpms) events.push({ beat: e.beat, tag: TAG_BPM, value: e.value });
  for (const e of timing.stops || []) {
    events.push({ beat: e.beat, tag: TAG_STOP, value: e.value });
    events.push({ beat: e.beat, tag: TAG_STOP_END, value: 0 });
  }
  for (const e of timing.delays || []) {
    events.push({ beat: e.beat, tag: TAG_DELAY, value: e.value });
    events.push({ beat: e.beat, tag: TAG_DELAY_END, value: 0 });
  }

  // Merge overlapping warp intervals into clean start/end pairs.
  const intervals = (timing.warps || [])
    .map((w) => [w.beat, w.beat + w.value])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of intervals) {
    if (merged.length && start <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], end);
    } else {
      merged.push([start, end]);
    }
  }
  for (const [start, end] of merged) {
    events.push({ beat: start, tag: TAG_WARP, value: 0 });
    events.push({ beat: end, tag: TAG_WARP_END, value: 0 });
  }

  events.sort((a, b) => a.beat - b.beat || a.tag - b.tag);

  const states = [
    {
      beat: 0,
      tag: TAG_BPM,
      value: bpms[0].value,
      time: -timing.offset,
      bpm: bpms[0].value,
      warp: false,
    },
  ];

  for (const ev of events) {
    const last = states[states.length - 1];
    let dt = last.warp ? 0 : ((ev.beat - last.beat) * 60) / last.bpm;
    if (
      (last.tag === TAG_STOP || last.tag === TAG_DELAY) &&
      (ev.tag === TAG_STOP_END || ev.tag === TAG_DELAY_END)
    ) {
      dt += last.value;
    }
    states.push({
      beat: ev.beat,
      tag: ev.tag,
      value: ev.value,
      time: last.time + dt,
      bpm: ev.tag === TAG_BPM ? ev.value : last.bpm,
      warp: ev.tag === TAG_WARP ? true : ev.tag === TAG_WARP_END ? false : last.warp,
    });
  }

  return states;
}

// Song time at a beat, using "note hit" semantics: a note on the same beat
// as a stop plays at the moment the stop begins.
function timeAtBeat(states, beat) {
  let prior = states[0];
  for (const s of states) {
    if (s.beat < beat || (s.beat === beat && s.tag <= TAG_STOP)) {
      prior = s;
    } else {
      break;
    }
  }
  const dt = prior.warp ? 0 : ((beat - prior.beat) * 60) / prior.bpm;
  return prior.time + dt;
}

function activeNumerator(timeSignatures, beat) {
  let numerator = 4;
  for (const ts of timeSignatures || []) {
    if (ts.beat <= beat) numerator = ts.numerator;
    else break;
  }
  return numerator;
}

// A valid note row contains only lane/mines/rolls and optional `[n]` keysounds.
// This excludes the terminating `;` line and `//` comments that some editors
// leave inside the final measure of a chart.
function isNoteRow(raw) {
  return /^[0-9XOMAM][0-9XOMAM\[\]0-9]*$/.test(raw);
}

// Beat of the last row in the note data that contains a note. Rows are
// subdivisions of the measure: row `l` of a measure worth `N` beats across
// `R` rows sits at `currentBeat + l * N / R`.
function findLastBeat(noteData, timeSignatures) {
  if (!noteData) return null;
  let lastBeat = null;
  let currentBeat = 0;
  for (const rawMeasure of noteData.split(",")) {
    const rows = rawMeasure
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter((r) => isNoteRow(r));
    const numerator = activeNumerator(timeSignatures, currentBeat);
    if (rows.length) {
      const beatsPerRow = numerator / rows.length;
      for (let l = 0; l < rows.length; l++) {
        // Keysounds are `[n]` suffixes; strip them before checking for notes.
        const stripped = rows[l].replace(/\[\d+\]/g, "").replace(/\s+/g, "");
        if (/[^0]/.test(stripped)) {
          const beat = currentBeat + l * beatsPerRow;
          if (lastBeat === null || beat > lastBeat) lastBeat = beat;
        }
      }
    }
    currentBeat += numerator;
  }
  return lastBeat;
}

// Duration in whole seconds for a song. `#LASTSECONDHINT` is canonical when
// present and valid; otherwise the duration is computed from timing data as
// the latest note time across the dance charts.
function computeDuration(charts, songTags, isSSC) {
  // `#LASTSECONDHINT` is canonical when present and valid. It is usually a
  // song-level tag, but timing-split .ssc charts may carry it per chart.
  let hint = parseFloat(songTags.LASTSECONDHINT);
  if (!Number.isFinite(hint) || hint <= 0) {
    hint = NaN;
    for (const chart of charts || []) {
      if (!chart.chartTags) continue;
      const chartHint = parseFloat(chart.chartTags.LASTSECONDHINT);
      if (
        Number.isFinite(chartHint) &&
        chartHint > 0 &&
        (!Number.isFinite(hint) || chartHint > hint)
      ) {
        hint = chartHint;
      }
    }
  }
  if (Number.isFinite(hint) && hint > 0) return Math.round(hint);

  let maxTime = null;
  for (const chart of charts || []) {
    if (!chart.noteData) continue;
    const timing = chartTiming(chart, songTags, isSSC);
    if (!timing.bpms.length) continue;
    const lastBeat = findLastBeat(chart.noteData, timing.timeSignatures);
    if (lastBeat === null) continue;
    const states = buildTimingStates(timing);
    if (!states) continue;
    const t = timeAtBeat(states, lastBeat);
    if (maxTime === null || t > maxTime) maxTime = t;
  }
  return maxTime === null ? null : Math.round(maxTime);
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
  const headerTags = parseTags(songHeader(text));
  const isSSC = /\.ssc$/i.test(filePath);

  const stat = fs.statSync(filePath);
  const pack = packOverride || path.basename(path.dirname(filePath));

  const charts = parseNotesBlocks(text);
  const { bpmMin, bpmMax } = parseBpm(headerTags);

  return {
    filePath,
    title: tags.TITLE || path.basename(filePath, path.extname(filePath)),
    subtitle: tags.SUBTITLE || "",
    artist: tags.ARTIST || "",
    genre: tags.GENRE || "",
    music: tags.MUSIC || "",
    pack,
    lastModified: stat.mtimeMs,
    bpmMin,
    bpmMax,
    durationSeconds: computeDuration(charts, headerTags, isSSC),
    charts,
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
      (file_path, title, subtitle, artist, genre, pack, music, last_modified,
       bpm_min, bpm_max, duration_seconds)
    VALUES
      (@filePath, @title, @subtitle, @artist, @genre, @pack, @music, @lastModified,
       @bpmMin, @bpmMax, @durationSeconds)
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
      duration_seconds = excluded.duration_seconds
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

module.exports = {
  scanSongs,
  readSongFile,
  parseBpm,
  parseBeatValues,
  parseTimeSignatures,
  findLastBeat,
  buildTimingStates,
  timeAtBeat,
  computeDuration,
};
