const { createHash } = require("crypto");
const { normalizeFloatDigits } = require("./bpmNormalize");

/**
 * Returns lane count for supported step types, matching rssp:
 * dance-single: 4, dance-double: 8, pump-single: 5, pump-double: 10
 */
function getLaneCount(chartType) {
  const norm = String(chartType || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  switch (norm) {
    case "dance-single":
      return 4;
    case "dance-double":
      return 8;
    case "pump-single":
      return 5;
    case "pump-double":
      return 10;
    default:
      return 4;
  }
}

function isAllZero(rowStr) {
  for (let i = 0; i < rowStr.length; i++) {
    if (rowStr.charCodeAt(i) !== 48 /* '0' */) return false;
  }
  return true;
}

/**
 * Calculates reduction shift for a measure, mirroring rssp's measure_reduce_shift:
 * Checks if odd-positioned rows at power-of-2 divisions are all zeros ('0').
 */
function measureReduceShift(measureRows) {
  const n = measureRows.length;
  if (n < 2) return 0;

  // trailing_zeros of n
  let tz = 0;
  let temp = n;
  while ((temp & 1) === 0 && temp > 0) {
    tz++;
    temp >>= 1;
  }

  let shift = 0;
  let step = 2;
  for (let s = 0; s < tz; s++) {
    let i = step >> 1;
    let allZeros = true;
    while (i < n) {
      if (!isAllZero(measureRows[i])) {
        allZeros = false;
        break;
      }
      i += step;
    }
    if (!allZeros) return shift;
    shift++;
    step <<= 1;
  }
  return shift;
}

function reduceMeasure(measureRows) {
  const shift = measureReduceShift(measureRows);
  if (shift === 0) return measureRows;
  const step = 1 << shift;
  const newLen = measureRows.length >> shift;
  const reduced = new Array(newLen);
  for (let i = 0; i < newLen; i++) {
    reduced[i] = measureRows[i * step];
  }
  return reduced;
}

/**
 * Minimizes chart note data exactly as rssp's `minimize_chart_for_hash`.
 * Strips comments, whitespace, handles `,` measure separators and `;` chart terminator,
 * reduces redundant rows in each measure, and strips trailing newline.
 */
function minimizeChartForHash(noteData, lanes) {
  const lines = String(noteData || "").split("\n");
  let measure = [];
  const outputParts = [];
  let done = false;

  for (let idx = 0; idx < lines.length; idx++) {
    let line = lines[idx].replace(/^[\s\r\n\t]+/, ""); // skip leading whitespace
    if (!line || line.startsWith("/")) continue; // skip empty or // comment

    const first = line.charAt(0);
    if (first === ",") {
      const reduced = reduceMeasure(measure);
      for (let r = 0; r < reduced.length; r++) {
        outputParts.push(reduced[r], "\n");
      }
      outputParts.push(",\n");
      measure = [];
    } else if (first === ";") {
      const reduced = reduceMeasure(measure);
      for (let r = 0; r < reduced.length; r++) {
        outputParts.push(reduced[r], "\n");
      }
      done = true;
      break;
    } else if (line.length >= lanes) {
      measure.push(line.slice(0, lanes));
    }
  }

  if (!done && measure.length > 0) {
    const reduced = reduceMeasure(measure);
    for (let r = 0; r < reduced.length; r++) {
      outputParts.push(reduced[r], "\n");
    }
  }

  let outStr = outputParts.join("");
  if (outStr.endsWith("\n")) {
    outStr = outStr.slice(0, -1);
  }
  return Buffer.from(outStr, "utf8");
}

/**
 * Short hex encoding (first 8 bytes = 16 hex chars)
 */
function shortHex(digestBuf) {
  return digestBuf.slice(0, 8).toString("hex");
}

/**
 * Computes the pair of (standardHash, bpmNeutralHash) identical to rssp.
 *
 * @param {string|Buffer} noteData - raw chart note data
 * @param {string} rawBpm - BPM map string (song or chart-level)
 * @param {string} chartType - "dance-single", "dance-double", etc.
 */
function computeChartHashPair(noteData, rawBpm, chartType = "dance-single", options = {}) {
  const { includeNeutral = false } = options;
  const lanes = getLaneCount(chartType);
  const minimizedBytes = minimizeChartForHash(noteData, lanes);
  const normalizedBpm = normalizeFloatDigits(rawBpm);

  const hashDigest = createHash("sha1")
    .update(minimizedBytes)
    .update(Buffer.from(normalizedBpm, "utf8"))
    .digest();

  // The BPM-neutral hash is optional (off by default) so folder scans don't
  // spend cycles computing it. Pass { includeNeutral: true } to compute it —
  // the parity test suite uses this to verify the neutral hash stays correct.
  let neutralHash = null;
  if (includeNeutral) {
    const neutralDigest = createHash("sha1")
      .update(minimizedBytes)
      .update(Buffer.from("0.000=0.000", "utf8"))
      .digest();
    neutralHash = shortHex(neutralDigest);
  }

  return {
    shortHash: shortHex(hashDigest),
    neutralHash,
    normalizedBpm,
  };
}

module.exports = {
  getLaneCount,
  minimizeChartForHash,
  computeChartHashPair,
  normalizeFloatDigits,
};
