const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const { parseSecureMode, applySecureModeDefaults } = require("../../secureMode.js");

test("parseSecureMode accepts common truthy and falsy values", () => {
  assert.equal(parseSecureMode(true), true);
  assert.equal(parseSecureMode("TRUE"), true);
  assert.equal(parseSecureMode("1"), true);
  assert.equal(parseSecureMode("off"), false);
  assert.equal(parseSecureMode("0"), false);
  assert.equal(parseSecureMode("nope"), false);
});

test("applySecureModeDefaults clears moderator settings when secure mode is enabled", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.prepare("INSERT INTO settings(key, value) VALUES('moderatorEnabled', 'true')").run();
  db.prepare("INSERT INTO settings(key, value) VALUES('moderatorUsername', 'alice')").run();
  db.prepare("INSERT INTO settings(key, value) VALUES('moderatorPasswordHash', 'hash')").run();
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(\'moderatorCredentials\', \'[{"username":"alice","passwordHash":"hash"}]\')',
  ).run();

  const result = applySecureModeDefaults(db, { secureMode: true });

  assert.equal(result.secureMode, true);
  assert.equal(
    db.prepare("SELECT value FROM settings WHERE key = 'moderatorEnabled'").get().value,
    "false",
  );
  assert.equal(
    db.prepare("SELECT value FROM settings WHERE key = 'moderatorUsername'").get().value,
    '""',
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'moderatorPasswordHash'").get().n,
    0,
  );
  assert.deepEqual(
    JSON.parse(
      db.prepare("SELECT value FROM settings WHERE key = 'moderatorCredentials'").get().value,
    ),
    [],
  );
});
