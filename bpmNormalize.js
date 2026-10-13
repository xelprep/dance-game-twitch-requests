/**
 * Mirrors rssp's `push_dec3_half_up` and `normalize_float_digits` (crates/rssp-core/src/bpm.rs & math.rs)
 */

function pushDec3HalfUp(val) {
  const scaled = Math.floor(val * 1000.0 + 0.5);
  const neg = scaled < 0;
  const absVal = Math.abs(scaled);
  const whole = Math.floor(absVal / 1000);
  const frac = absVal % 1000;
  const sign = neg ? "-" : "";
  return `${sign}${whole}.${String(frac).padStart(3, "0")}`;
}

/**
 * Normalises a BPM map string exactly as rssp's `normalize_float_digits`.
 * Example: "0.000=180.000000" -> "0.000=180.000"
 */
function normalizeFloatDigits(raw) {
  if (!raw) return "";
  const out = [];
  for (const entry of String(raw).split(",")) {
    const t = entry.trim();
    if (!t) continue;
    const parts = t.split("=");
    if (parts.length !== 2) continue;
    const b = parseFloat(parts[0].trim());
    const v = parseFloat(parts[1].trim());
    if (Number.isFinite(b) && Number.isFinite(v)) {
      out.push(`${pushDec3HalfUp(b)}=${pushDec3HalfUp(v)}`);
    }
  }
  return out.join(",");
}

module.exports = {
  pushDec3HalfUp,
  normalizeFloatDigits,
};
