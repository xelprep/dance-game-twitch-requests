process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { readSongFile } = require("../../scanner.js");

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const SONGS_DIR = path.join(FIXTURES_DIR, "songs");
const FIXTURES = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "hash-fixtures.json"), "utf8"));

// Read each fixture song once, with the (otherwise off-by-default) BPM-neutral
// hash enabled so we can verify both hashes against the rssp reference values.
const songsByFile = new Map();
function getSong(file) {
  if (!songsByFile.has(file)) {
    songsByFile.set(
      file,
      readSongFile(path.join(SONGS_DIR, file), undefined, undefined, { includeNeutral: true }),
    );
  }
  return songsByFile.get(file);
}

function findChart(song, fixture) {
  const matches = song.charts.filter(
    (c) =>
      c.chartType.toLowerCase() === fixture.chartType.toLowerCase() &&
      c.difficulty.toLowerCase() === fixture.difficulty.toLowerCase() &&
      String(Number(c.meter)) === String(Number(fixture.meter)),
  );
  assert.equal(
    matches.length,
    1,
    `expected exactly 1 chart for ${fixture.file} [${fixture.chartType} ${fixture.difficulty} ${fixture.meter}], found ${matches.length}`,
  );
  return matches[0];
}

test("chart standard hashes match the rssp reference", () => {
  assert.ok(FIXTURES.length > 0, "no hash fixtures were loaded");
  for (const fixture of FIXTURES) {
    const chart = findChart(getSong(fixture.file), fixture);
    assert.equal(
      chart.standardHash,
      fixture.standard,
      `standard hash mismatch for ${fixture.file} [${fixture.chartType} ${fixture.difficulty} ${fixture.meter}]: got ${chart.standardHash}, want ${fixture.standard}`,
    );
  }
});

test("chart BPM-neutral hashes match the rssp reference", () => {
  assert.ok(FIXTURES.length > 0, "no hash fixtures were loaded");
  for (const fixture of FIXTURES) {
    const chart = findChart(getSong(fixture.file), fixture);
    assert.equal(
      chart.bpmNeutralHash,
      fixture.neutral,
      `neutral hash mismatch for ${fixture.file} [${fixture.chartType} ${fixture.difficulty} ${fixture.meter}]: got ${chart.bpmNeutralHash}, want ${fixture.neutral}`,
    );
  }
});
