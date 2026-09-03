process.env.NODE_ENV = "test";
process.env.SKIP_APP_STARTUP = "1";
process.env.CONTROL_PASSWORD = "test-control-password";

const test = require("node:test");
const assert = require("node:assert/strict");

const path = require("node:path");

const {
  db,
  DB_PATH,
  resolveDatabasePath,
  hashModeratorPassword,
  verifyModeratorPassword,
  verifyStreamerAuth,
  getModeratorCredentialsList,
  persistModeratorCredentials,
} = require("../../server.js");

function resetSettings() {
  db.prepare("DELETE FROM settings").run();
}

test("moderator password hashing and verification round-trip correctly", () => {
  resetSettings();
  const password = "super-secret-password";
  const encoded = hashModeratorPassword(password);
  assert.equal(verifyModeratorPassword(password, encoded), true);
  assert.equal(verifyModeratorPassword("wrong-password", encoded), false);
});

test("streamer auth accepts the expected basic auth credentials", () => {
  const header = "Basic " + Buffer.from("streamer:test-control-password").toString("base64");
  assert.equal(verifyStreamerAuth(header, "test-control-password"), true);
  assert.equal(
    verifyStreamerAuth(
      "Basic " + Buffer.from("streamer:wrong-password").toString("base64"),
      "test-control-password",
    ),
    false,
  );
  assert.equal(verifyStreamerAuth("", "test-control-password"), false);
});

test("persistModeratorCredentials stores moderator credentials and rehydrates them", () => {
  resetSettings();
  const entries = [
    { username: "alice", password: "hunter2" },
    { username: "bob", password: "hunter3" },
  ];

  const stored = persistModeratorCredentials(entries);
  assert.equal(stored.length, 2);
  assert.equal(getModeratorCredentialsList().length, 2);
  assert.equal(getModeratorCredentialsList()[0].username, "alice");
  assert.equal(
    verifyModeratorPassword("hunter2", getModeratorCredentialsList()[0].passwordHash),
    true,
  );
});

test("startup smoke check: the app can initialize a minimal settings table without crashing", () => {
  resetSettings();
  const rowCount = db.prepare("SELECT COUNT(*) AS n FROM settings").get().n;
  assert.equal(typeof rowCount, "number");
  assert.equal(rowCount >= 0, true);
});

test("test environment uses a temporary in-memory database and avoids dev db", () => {
  assert.equal(DB_PATH, ":memory:");
  assert.equal(db.name, ":memory:");
});

test("resolveDatabasePath properly prioritizes test mode and custom environment variables", () => {
  const defaultDevPath = path.resolve("./data/songs.db");

  // In production/normal mode:
  assert.equal(resolveDatabasePath({ NODE_ENV: "production" }), defaultDevPath);
  assert.equal(
    resolveDatabasePath({ NODE_ENV: "production", DATABASE_PATH: "/custom/dev.db" }),
    "/custom/dev.db",
  );
  assert.equal(
    resolveDatabasePath({ NODE_ENV: "production", DB_PATH: "/custom/alt-dev.db" }),
    "/custom/alt-dev.db",
  );

  // In test mode: defaults to :memory: even if DATABASE_PATH is present in .env
  assert.equal(
    resolveDatabasePath({ NODE_ENV: "test", DATABASE_PATH: defaultDevPath }),
    ":memory:",
  );
  assert.equal(
    resolveDatabasePath({ SKIP_APP_STARTUP: "1", DATABASE_PATH: defaultDevPath }),
    ":memory:",
  );

  // In test mode: can still be overridden by TEST_DATABASE_PATH or TEST_DB_PATH
  assert.equal(
    resolveDatabasePath({ NODE_ENV: "test", TEST_DATABASE_PATH: "/tmp/test.db" }),
    "/tmp/test.db",
  );
  assert.equal(
    resolveDatabasePath({ NODE_ENV: "test", TEST_DB_PATH: "/tmp/alt-test.db" }),
    "/tmp/alt-test.db",
  );
});
