#!/usr/bin/env node
/**
 * Dev-only fixture generator for the chart-hash parity test.
 *
 * Regenerates `test/unit/fixtures/hash-fixtures.json` by running the compiled
 * `rssp` CLI over the committed fixture songs in `test/unit/fixtures/songs/`.
 *
 * This is NOT part of the automated test suite (`npm test`). It requires a
 * built rssp binary and is only needed when the hash algorithm changes or new
 * fixture songs are added. The committed fixtures JSON is the source of truth
 * that `test/unit/hash.test.js` compares against, so the real test runs without
 * rssp installed.
 *
 * Usage:
 *   node scripts/generate-hash-fixtures.js
 *   RSSP_BIN=/path/to/rssp node scripts/generate-hash-fixtures.js
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FIXTURES_DIR = path.join(ROOT, "test", "unit", "fixtures");
const SONGS_DIR = path.join(FIXTURES_DIR, "songs");
const OUT_FILE = path.join(FIXTURES_DIR, "hash-fixtures.json");

const RSSP_BIN =
  process.env.RSSP_BIN || path.join(ROOT, "localdev", "rssp_repo", "target", "release", "rssp");

if (!fs.existsSync(RSSP_BIN)) {
  console.error(`rssp binary not found at: ${RSSP_BIN}`);
  console.error("Build it with `cargo build --release` in localdev/rssp_repo, or set RSSP_BIN.");
  process.exit(1);
}

const songFiles = fs
  .readdirSync(SONGS_DIR)
  .filter((f) => /\.(sm|ssc)$/i.test(f))
  .sort();

if (songFiles.length === 0) {
  console.error(`No .sm/.ssc fixture songs found in ${SONGS_DIR}`);
  process.exit(1);
}

const fixtures = [];
for (const name of songFiles) {
  const file = path.join(SONGS_DIR, name);
  let json;
  try {
    const output = execFileSync(RSSP_BIN, [file, "--json"], { encoding: "utf8" });
    json = JSON.parse(output);
  } catch (err) {
    console.warn(`Skipping ${name}: rssp failed (${err.message})`);
    continue;
  }
  for (const chart of json.charts || []) {
    const info = chart.chart_info;
    fixtures.push({
      file: name,
      chartType: info.step_type,
      difficulty: info.difficulty,
      meter: String(info.rating),
      standard: info.sha1,
      neutral: info.bpm_neutral_sha1,
    });
  }
}

fs.writeFileSync(OUT_FILE, `${JSON.stringify(fixtures, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${fixtures.length} chart fixtures from ${songFiles.length} songs -> ${path.relative(ROOT, OUT_FILE)}`,
);
