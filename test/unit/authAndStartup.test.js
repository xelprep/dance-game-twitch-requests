process.env.NODE_ENV = "test";
process.env.SKIP_APP_STARTUP = "1";
process.env.CONTROL_PASSWORD = "test-control-password";
// Pin the default so a local .env vanity name (loaded via dotenv) cannot leak in.
process.env.STREAMER_VANITY_NAME = "Streamer";

const test = require("node:test");
const assert = require("node:assert/strict");

const path = require("node:path");
const os = require("node:os");

const {
  db,
  DB_PATH,
  resolveDatabasePath,
  hashModeratorPassword,
  verifyModeratorPassword,
  verifyStreamerAuth,
  sanitizeCourseName,
  generateRandomPassword,
  normalizeEventSubUrl,
  getModeratorCredentialsList,
  setSetting,
  getTwitchRefreshRetryDelay,
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
  assert.equal(verifyStreamerAuth("Basic", "test-control-password"), false);
  assert.equal(verifyStreamerAuth("Basic    ", "test-control-password"), false);
  assert.equal(
    verifyStreamerAuth(
      `Basic ${Buffer.from("streamer:test-control-password").toString("base64")} extra`,
      "test-control-password",
    ),
    false,
  );
  assert.equal(verifyStreamerAuth(`Basic ${"A".repeat(1025)}`, "test-control-password"), false);
});

test("streamer auth accepts the vanity name username case-insensitively and rejects other usernames", () => {
  // STREAMER_VANITY_NAME is unset in this test, so the vanity name defaults to "Streamer".
  const header = (username) =>
    "Basic " + Buffer.from(`${username}:test-control-password`).toString("base64");
  assert.equal(verifyStreamerAuth(header("Streamer"), "test-control-password"), true);
  assert.equal(verifyStreamerAuth(header("STREAMER"), "test-control-password"), true);
  assert.equal(verifyStreamerAuth(header("viewer"), "test-control-password"), false);
  assert.equal(verifyStreamerAuth(header("streamer"), "wrong-password"), false);
});

test("course names remove arbitrarily long trailing periods without regex backtracking", () => {
  assert.equal(sanitizeCourseName(`Course${".".repeat(20_000)}`), "Course");
  assert.equal(sanitizeCourseName("  Course Name...  "), "Course Name");
});

test("temporary moderator passwords preserve their format", () => {
  const password = generateRandomPassword(32);
  assert.equal(password.length, 32);
  assert.match(password, /^[A-HJ-NP-Z2-9]+$/);
});

test("EventSub reconnect URLs are restricted to Twitch's WebSocket endpoint", () => {
  assert.equal(
    normalizeEventSubUrl("wss://eventsub.wss.twitch.tv/ws?session_id=abc"),
    "wss://eventsub.wss.twitch.tv/ws?session_id=abc",
  );
  for (const url of [
    "http://eventsub.wss.twitch.tv/ws",
    "wss://127.0.0.1/ws",
    "wss://attacker.example/ws",
    "wss://user@eventsub.wss.twitch.tv/ws",
    "wss://eventsub.wss.twitch.tv:444/ws",
    "wss://eventsub.wss.twitch.tv/other",
    "not a URL",
  ]) {
    assert.equal(normalizeEventSubUrl(url), null, url);
  }
});

test("getModeratorCredentialsList rehydrates stored multi-moderator credentials and drops invalid entries", () => {
  resetSettings();
  setSetting("moderatorCredentials", [
    { username: "alice", passwordHash: hashModeratorPassword("hunter2") },
    { username: "bob", passwordHash: hashModeratorPassword("hunter3") },
    { username: "alice", passwordHash: "duplicate-should-be-dropped" },
    { username: "", passwordHash: "missing-username" },
    { username: "missing-hash" },
    "not-an-object",
  ]);

  const list = getModeratorCredentialsList();
  assert.equal(list.length, 2);
  assert.equal(list[0].username, "alice");
  assert.equal(list[1].username, "bob");
  assert.equal(verifyModeratorPassword("hunter2", list[0].passwordHash), true);
  assert.equal(verifyModeratorPassword("hunter3", list[1].passwordHash), true);
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

test("Twitch token refresh retry delay uses capped exponential backoff", () => {
  assert.equal(getTwitchRefreshRetryDelay(0), 30_000);
  assert.equal(getTwitchRefreshRetryDelay(1), 60_000);
  assert.equal(getTwitchRefreshRetryDelay(2), 120_000);
  assert.equal(getTwitchRefreshRetryDelay(4), 300_000);
  assert.equal(getTwitchRefreshRetryDelay(20), 300_000);
  assert.equal(getTwitchRefreshRetryDelay(-1), 30_000);
});

test("resolveDatabasePath properly prioritizes test mode and custom environment variables", () => {
  const defaultDevPath = path.join(os.homedir(), ".dance-game-requests", "songs.db");

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
  assert.equal(
    resolveDatabasePath({ NODE_ENV: "production", DB_DIR: "/custom/db" }),
    path.resolve("/custom/db", "songs.db"),
  );
  // A full file path takes precedence over DB_DIR
  assert.equal(
    resolveDatabasePath({
      NODE_ENV: "production",
      DATABASE_PATH: "/custom/dev.db",
      DB_DIR: "/custom/db",
    }),
    "/custom/dev.db",
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
