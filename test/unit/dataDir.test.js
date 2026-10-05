const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DATA_DIR_INI_NAME,
  DEFAULT_DATA_DIR_NAME,
  checkDataDir,
  ensureDataDirSync,
  expandTilde,
  isTestMode,
  migrateLegacyEnvFile,
  readDataDirIni,
  resolveDataDir,
} = require("../../dataDir.cjs");

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("expandTilde expands ~ forms and passes other paths through", () => {
  const home = os.homedir();
  assert.equal(expandTilde("~"), home);
  assert.equal(expandTilde("~/Documents"), path.join(home, "Documents"));
  assert.equal(expandTilde("~\\Documents"), path.join(home, "Documents"));
  assert.equal(expandTilde("  ~/x  "), path.join(home, "x"));
  assert.equal(expandTilde("/abs/path"), "/abs/path");
  assert.equal(expandTilde("relative/path"), "relative/path");
  assert.equal(expandTilde(""), "");
});

test("readDataDirIni handles missing, bare, KEY=value, comments, and empty files", (t) => {
  const projectDir = makeTemp("dance-ini-");
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const iniPath = path.join(projectDir, DATA_DIR_INI_NAME);

  // Missing file.
  let result = readDataDirIni(projectDir);
  assert.equal(result.found, false);
  assert.equal(result.value, null);
  assert.equal(result.error, null);

  // Bare path with comments and blank lines; ~ is expanded.
  fs.writeFileSync(iniPath, "# comment\n\n~/Documents/Requests\n", "utf8");
  result = readDataDirIni(projectDir);
  assert.equal(result.found, true);
  assert.equal(result.value, path.join(os.homedir(), "Documents", "Requests"));
  assert.equal(result.error, null);

  // KEY=value form.
  fs.writeFileSync(iniPath, "APP_DATA_DIR=C:\\Requests\n", "utf8");
  result = readDataDirIni(projectDir);
  assert.equal(result.found, true);
  assert.equal(result.value, "C:\\Requests");

  // Present but no usable path (only comments/blanks).
  fs.writeFileSync(iniPath, "# nothing here\n\n", "utf8");
  result = readDataDirIni(projectDir);
  assert.equal(result.found, true);
  assert.equal(result.value, null);
  assert.ok(result.error);
});

test("checkDataDir validates existing, missing, and unusable paths", (t) => {
  const base = makeTemp("dance-check-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  // Existing writable directory.
  const existing = path.join(base, "existing");
  fs.mkdirSync(existing);
  let check = checkDataDir(existing);
  assert.equal(check.ok, true);
  assert.equal(check.exists, true);
  assert.equal(check.writable, true);

  // Existing file (not a directory).
  const file = path.join(base, "afile");
  fs.writeFileSync(file, "x", "utf8");
  check = checkDataDir(file);
  assert.equal(check.ok, false);
  assert.equal(check.exists, true);
  assert.match(check.reason, /not a directory/);

  // Missing with a writable parent: creatable.
  check = checkDataDir(path.join(base, "missing"));
  assert.equal(check.ok, true);
  assert.equal(check.exists, false);

  // Missing with a missing parent: not creatable.
  check = checkDataDir(path.join(base, "nope", "deeper"));
  assert.equal(check.ok, false);
  assert.equal(check.exists, false);
  assert.match(check.reason, /parent/);

  // Read-only parent (skip on Windows and for root, where W_OK can lie).
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const roParent = path.join(base, "ro");
    fs.mkdirSync(roParent);
    fs.chmodSync(roParent, 0o555);
    // Restore permissions so cleanup can remove the tree; tolerate the base
    // directory already having been removed by an earlier after hook.
    t.after(() => {
      try {
        fs.chmodSync(roParent, 0o755);
      } catch {
        // Already removed.
      }
    });
    check = checkDataDir(path.join(roParent, "missing"));
    assert.equal(check.ok, false);
    assert.match(check.reason, /not writable/);
  }
});

test("resolveDataDir prefers data_dir.ini over APP_DATA_DIR over the default", (t) => {
  const projectDir = makeTemp("dance-resolve-");
  t.after(() => {
    delete process.env.APP_DATA_DIR;
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
  const iniPath = path.join(projectDir, DATA_DIR_INI_NAME);
  const iniDir = path.join(projectDir, "from-ini");
  const envDir = path.join(projectDir, "from-env");

  // Default: no ini, no env var.
  delete process.env.APP_DATA_DIR;
  let result = resolveDataDir(projectDir);
  assert.equal(result.source, "default");
  assert.equal(result.dataDir, path.join(os.homedir(), DEFAULT_DATA_DIR_NAME));

  // Environment fallback.
  process.env.APP_DATA_DIR = envDir;
  result = resolveDataDir(projectDir);
  assert.equal(result.source, "environment");
  assert.equal(result.dataDir, path.resolve(envDir));

  // The ini file wins over the env var.
  fs.writeFileSync(iniPath, iniDir + "\n", "utf8");
  result = resolveDataDir(projectDir);
  assert.equal(result.source, "data_dir.ini");
  assert.equal(result.dataDir, path.resolve(iniDir));

  // Ini present but unusable -> null dataDir (callers fail gracefully).
  fs.writeFileSync(iniPath, "# only a comment\n", "utf8");
  result = resolveDataDir(projectDir);
  assert.equal(result.source, "data_dir.ini");
  assert.equal(result.dataDir, null);
});

test("migrateLegacyEnvFile moves an app-folder .env into the data root once", (t) => {
  const projectDir = makeTemp("dance-migrate-app-");
  const dataDir = makeTemp("dance-migrate-data-");
  t.after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const legacyEnv = path.join(projectDir, ".env");
  const newEnv = path.join(dataDir, ".env");
  fs.writeFileSync(legacyEnv, "SONGS_DIR=/x\n", "utf8");

  // Moves when the data-root .env is absent.
  let result = migrateLegacyEnvFile(projectDir, dataDir, { testMode: false });
  assert.equal(result.status, "moved");
  assert.equal(fs.existsSync(legacyEnv), false);
  assert.equal(fs.readFileSync(newEnv, "utf8"), "SONGS_DIR=/x\n");

  // Idempotent: nothing left to move.
  result = migrateLegacyEnvFile(projectDir, dataDir, { testMode: false });
  assert.equal(result, null);

  // Both exist -> data-root copy wins, legacy copy untouched.
  fs.writeFileSync(legacyEnv, "SONGS_DIR=/legacy\n", "utf8");
  result = migrateLegacyEnvFile(projectDir, dataDir, { testMode: false });
  assert.equal(result.status, "both-exist");
  assert.equal(fs.existsSync(legacyEnv), true);
  assert.equal(fs.readFileSync(newEnv, "utf8"), "SONGS_DIR=/x\n");

  // Test mode is a no-op.
  result = migrateLegacyEnvFile(projectDir, dataDir, { testMode: true });
  assert.equal(result, null);
});

test("ensureDataDirSync resolves only in test mode (no creation, no migration)", (t) => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    SKIP_APP_STARTUP: process.env.SKIP_APP_STARTUP,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    APP_DATA_DIR: process.env.APP_DATA_DIR,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.NODE_ENV = "test";
  assert.equal(isTestMode(), true);

  const projectDir = makeTemp("dance-testmode-app-");
  const dataDir = path.join(makeTemp("dance-testmode-base-"), "not-created");
  t.after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
  });
  process.env.APP_DATA_DIR = dataDir;
  fs.writeFileSync(path.join(projectDir, ".env"), "SONGS_DIR=/x\n", "utf8");

  const resolved = ensureDataDirSync({ projectDir });
  assert.equal(resolved, path.resolve(dataDir));
  // No creation and no migration in test mode.
  assert.equal(fs.existsSync(dataDir), false);
  assert.equal(fs.existsSync(path.join(projectDir, ".env")), true);
});

test("ensureDataDirSync creates a missing data root and migrates a legacy .env", (t) => {
  // Run in a child process so isTestMode() is false (the test runner marks the
  // in-process environment as test mode via --test / NODE_ENV).
  const projectDir = makeTemp("dance-ensure-app-");
  const base = makeTemp("dance-ensure-base-");
  const dataDir = path.join(base, "data");
  t.after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(projectDir, ".env"), "SONGS_DIR=/x\n", "utf8");

  const script = `
    const { ensureDataDirSync } = require(${JSON.stringify(path.join(__dirname, "..", "..", "dataDir.cjs"))});
    const resolved = ensureDataDirSync({ projectDir: ${JSON.stringify(projectDir)} });
    console.log("RESOLVED=" + resolved);
  `;
  const output = execFileSync(process.execPath, ["-e", script], {
    env: {
      ...process.env,
      APP_DATA_DIR: dataDir,
      NODE_ENV: "",
      SKIP_APP_STARTUP: "",
      NODE_TEST_CONTEXT: "",
    },
    encoding: "utf8",
  });
  assert.match(output, /RESOLVED=/);
  assert.equal(fs.statSync(dataDir).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(projectDir, ".env")), false);
  assert.equal(fs.readFileSync(path.join(dataDir, ".env"), "utf8"), "SONGS_DIR=/x\n");
});
