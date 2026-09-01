function parseSecureMode(rawValue) {
  if (typeof rawValue === "boolean") return rawValue;
  if (rawValue === undefined || rawValue === null || rawValue === "") return false;

  const normalized = String(rawValue).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  return false;
}

function applySecureModeDefaults(db, { secureMode = false } = {}) {
  if (!secureMode) {
    return { changed: false, secureMode: false };
  }

  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A SQLite database instance with prepare() is required.");
  }

  const rows = [
    { key: "moderatorEnabled", value: false },
    { key: "moderatorUsername", value: "" },
    { key: "moderatorPasswordHash", value: null, remove: true },
  ];

  let changed = false;

  for (const row of rows) {
    const current = db.prepare("SELECT value FROM settings WHERE key = ?").get(row.key);

    if (row.remove) {
      if (current !== undefined) {
        db.prepare("DELETE FROM settings WHERE key = ?").run(row.key);
        changed = true;
      }
      continue;
    }

    const expected = JSON.stringify(row.value);
    if (current === undefined) {
      db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)").run(row.key, expected);
      changed = true;
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(current.value);
    } catch (_error) {
      parsed = current.value;
    }

    if (parsed !== row.value) {
      db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)").run(
        row.key,
        expected,
      );
      changed = true;
    }
  }

  return { changed, secureMode: true };
}

module.exports = {
  parseSecureMode,
  applySecureModeDefaults,
};
