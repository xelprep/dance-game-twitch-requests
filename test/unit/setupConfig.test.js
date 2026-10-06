const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dotenv = require("dotenv");
const {
  ADVANCED_OPTIONS,
  ENV_OPTIONS,
  REQUIRED_OPTIONS,
  generateControlPassword,
  isDirectory,
  isSetupComplete,
  isValidControlPassword,
  mergeEnvContents,
  writeEnvFile,
} = require("../../setupConfig.cjs");

test("setup options are complete, tiered, and carry built-in defaults", () => {
  for (const option of ENV_OPTIONS) {
    assert.ok(option.label, `${option.key} needs a label`);
    assert.ok(option.description, `${option.key} needs a description`);
    assert.ok(typeof option.default === "string", `${option.key} needs a string default`);
    assert.ok(["required", "advanced"].includes(option.tier), `${option.key} needs a tier`);
  }
  // The five always-asked settings.
  assert.deepEqual(
    REQUIRED_OPTIONS.map((option) => option.key).sort(),
    [
      "ADDITIONAL_SONGS_DIR",
      "CONTROL_PASSWORD",
      "COURSES_DIR",
      "SONGS_DIR",
      "STREAMER_VANITY_NAME",
    ].sort(),
  );
  // Everything else is advanced.
  assert.deepEqual(
    ADVANCED_OPTIONS.map((option) => option.key).sort(),
    [
      "BOT_PREFIX",
      "DB_DIR",
      "MAX_REQUESTS_PER_USER",
      "PUBLIC_HTTPS",
      "PUBLIC_URL",
      "QUEUE_LIMIT",
      "REQUEST_ID_COMMAND",
      "SCANNER_THREADS",
      "SEARCH_COMMAND",
      "SECURE_MODE",
    ].sort(),
  );
  // The tiers partition the full option list, and APP_DATA_DIR is not an option
  // (the data root is relocated via data_dir.ini instead).
  assert.equal(REQUIRED_OPTIONS.length + ADVANCED_OPTIONS.length, ENV_OPTIONS.length);
  assert.ok(!ENV_OPTIONS.some((option) => option.key === "APP_DATA_DIR"));
});

test("setup completeness validates the Songs directory and rejects the placeholder password", (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dance-setup-"));
  t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
  assert.equal(isDirectory(tempDirectory), true);
  assert.equal(isDirectory(path.join(tempDirectory, "missing")), false);
  assert.equal(isValidControlPassword("a-long-random-password"), false);
  assert.equal(isValidControlPassword("real-password"), true);
  assert.equal(
    isSetupComplete({ SONGS_DIR: tempDirectory, CONTROL_PASSWORD: "real-password" }),
    true,
  );
  assert.equal(
    isSetupComplete({ SONGS_DIR: tempDirectory, CONTROL_PASSWORD: "a-long-random-password" }),
    false,
  );
});

test("generated control passwords are strong URL-safe strings", () => {
  const generated = generateControlPassword();
  assert.match(generated, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(isValidControlPassword(generated), true);
});

test("merging .env updates owned keys and preserves comments and unrelated settings", () => {
  const original = "# user note\nCUSTOM_SETTING=keep-me\nSONGS_DIR=old-path # path note\n";
  const merged = mergeEnvContents(original, {
    SONGS_DIR: "/new/Songs",
    CONTROL_PASSWORD: "secret value",
  });
  const parsed = dotenv.parse(merged);
  assert.equal(parsed.CUSTOM_SETTING, "keep-me");
  assert.equal(parsed.SONGS_DIR, "/new/Songs");
  assert.equal(parsed.CONTROL_PASSWORD, "secret value");
  assert.match(merged, /# user note/);
  assert.match(merged, /SONGS_DIR=\/new\/Songs # path note/);
});

test("merging .env round-trips Windows paths without doubling backslashes", () => {
  const windowsPath = String.raw`C:\Games\DanceGame\Songs`;
  const windowsPathWithSpaces = String.raw`C:\My Songs\Dance Game`;
  const merged = mergeEnvContents("", {
    SONGS_DIR: windowsPath,
    ADDITIONAL_SONGS_DIR: windowsPathWithSpaces,
    CONTROL_PASSWORD: `Here's a "quoted" secret`,
  });
  const parsed = dotenv.parse(merged);
  assert.equal(parsed.SONGS_DIR, windowsPath);
  assert.equal(parsed.ADDITIONAL_SONGS_DIR, windowsPathWithSpaces);
  assert.equal(parsed.CONTROL_PASSWORD, `Here's a "quoted" secret`);
});

test("writing .env creates a backup and applies restrictive permissions", async (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dance-setup-write-"));
  t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
  const envPath = path.join(tempDirectory, ".env");
  const previous = "# keep this comment\nCUSTOM_SETTING=keep\nSONGS_DIR=old\n";
  fs.writeFileSync(envPath, previous, "utf8");

  const result = await writeEnvFile(envPath, { SONGS_DIR: "/new/Songs" });

  assert.ok(result.backupPath);
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), previous);
  assert.equal(dotenv.parse(fs.readFileSync(envPath, "utf8")).SONGS_DIR, "/new/Songs");
  assert.equal(dotenv.parse(fs.readFileSync(envPath, "utf8")).CUSTOM_SETTING, "keep");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  }
});
