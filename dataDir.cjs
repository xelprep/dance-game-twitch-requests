// Shared resolution/validation/creation logic for the app data root (APP_DATA_DIR).
//
// The data root holds everything the app generates: the song database, artwork
// cache, generated courses, control-panel TLS certificates, Twitch credentials,
// and (now) the .env configuration file. It lives OUTSIDE the app folder so the
// app stays portable.
//
// Resolution precedence:
//   1. data_dir.ini in the project root (optional; the documented way to relocate)
//   2. APP_DATA_DIR environment variable (fallback / back-compat)
//   3. Default: ~/.dance-game-requests
//
// This module is used by start.js, server.js, and setupTui.mjs so they all agree
// on where the data root (and therefore .env) lives.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const DATA_DIR_INI_NAME = "data_dir.ini";
const DEFAULT_DATA_DIR_NAME = ".dance-game-requests";

function isTestMode(env = process.env) {
  return (
    env.NODE_ENV === "test" ||
    env.SKIP_APP_STARTUP === "1" ||
    Boolean(env.NODE_TEST_CONTEXT) ||
    (Array.isArray(process.execArgv) && process.execArgv.includes("--test"))
  );
}

// Expand a leading ~ (or ~/x, ~\x) to the user's home directory.
function expandTilde(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "~") return os.homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

// Read data_dir.ini from the project root if present.
// Accepts a bare path or a KEY=value line; skips blanks and # comments; uses the
// first usable line. Returns { iniPath, found, value, error }.
function readDataDirIni(projectDir) {
  const iniPath = path.join(projectDir, DATA_DIR_INI_NAME);
  let contents;
  try {
    contents = fs.readFileSync(iniPath, "utf8");
  } catch {
    return { iniPath, found: false, value: null, error: null };
  }
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    const raw = eq !== -1 ? trimmed.slice(eq + 1) : trimmed;
    const value = expandTilde(raw);
    if (value) return { iniPath, found: true, value, error: null };
  }
  return { iniPath, found: true, value: null, error: "no path found" };
}

function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Validate a candidate data directory without side effects.
// Returns { ok, exists, writable, reason }.
function checkDataDir(dir) {
  const resolved = path.resolve(dir);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch {
    stat = null;
  }
  if (stat) {
    if (!stat.isDirectory()) {
      return { ok: false, exists: true, writable: false, reason: "exists but is not a directory" };
    }
    const writable = isWritableDir(resolved);
    return { ok: writable, exists: true, writable, reason: writable ? null : "is not writable" };
  }
  // Missing: it is usable only if it could be created (parent exists, is a
  // directory, and is writable).
  const parent = path.dirname(resolved);
  let parentStat = null;
  try {
    parentStat = fs.statSync(parent);
  } catch {
    parentStat = null;
  }
  if (!parentStat) {
    return {
      ok: false,
      exists: false,
      writable: false,
      reason: `its parent directory (${parent}) does not exist`,
    };
  }
  if (!parentStat.isDirectory()) {
    return {
      ok: false,
      exists: false,
      writable: false,
      reason: `its parent path (${parent}) is not a directory`,
    };
  }
  const writable = isWritableDir(parent);
  return {
    ok: writable,
    exists: false,
    writable,
    reason: writable ? null : `its parent directory (${parent}) is not writable`,
  };
}

// Resolve the data root using the precedence described above.
// Returns { dataDir, source, ini } where source is "data_dir.ini" | "environment"
// | "default". dataDir is null when data_dir.ini exists but holds no usable path.
function resolveDataDir(projectDir) {
  const ini = readDataDirIni(projectDir);
  if (ini.found) {
    if (!ini.value) return { dataDir: null, source: "data_dir.ini", ini };
    return { dataDir: path.resolve(ini.value), source: "data_dir.ini", ini };
  }
  const envValue = expandTilde(process.env.APP_DATA_DIR);
  if (envValue) {
    return { dataDir: path.resolve(envValue), source: "environment", ini };
  }
  return {
    dataDir: path.join(os.homedir(), DEFAULT_DATA_DIR_NAME),
    source: "default",
    ini,
  };
}

function failInvalidDataDir({ dataDir, source, ini, check }) {
  const bar = "=".repeat(64);
  console.error(`\n${bar}`);
  console.error("ERROR: The app data directory is not usable.");
  console.error(bar);
  if (source === "data_dir.ini") {
    console.error(`data_dir.ini (${ini.iniPath}) points to:`);
  } else if (source === "environment") {
    console.error("The APP_DATA_DIR environment variable is set to:");
  }
  if (dataDir) console.error(`  ${dataDir}`);
  console.error(`\nProblem: ${check.reason}.`);
  console.error("\nHow to fix this:");
  console.error(
    "  - Edit data_dir.ini in the app folder so it contains a valid, writable path, e.g.:",
  );
  console.error("        ~/Documents/Requests");
  console.error("  - Or delete data_dir.ini to use the default (~/.dance-game-requests).");
  console.error(`${bar}\n`);
  process.exit(1);
}

function failMissingIniPath({ ini }) {
  const bar = "=".repeat(64);
  console.error(`\n${bar}`);
  console.error("ERROR: data_dir.ini does not contain a usable path.");
  console.error(bar);
  console.error(`File: ${ini.iniPath}`);
  console.error("It should contain a single path, e.g. ~/Documents/Requests or C:\\Requests.");
  console.error("Fix the file, or delete it to use the default data location.");
  console.error(`${bar}\n`);
  process.exit(1);
}

function announceDataDirCreation(dataDir) {
  const line = "-".repeat(64);
  console.log(`\n${line}`);
  console.log("The app is about to create its data folder:");
  console.log(`  ${dataDir}`);
  console.log("");
  console.log("This folder holds everything the app generates: the song database,");
  console.log("artwork cache, generated courses, control-panel certificates, Twitch");
  console.log("credentials, and your .env configuration file.");
  console.log("");
  console.log("To use a different location, create a file called data_dir.ini in the");
  console.log("app folder containing the path you want, for example:");
  console.log("  ~/Documents/Requests");
  console.log("or");
  console.log("  C:\\Requests");
  console.log("Then restart the app.");
  console.log(line);
}

// Interactive [Y/n] confirmation. Resolves true on empty/yes, false otherwise.
function confirmDataDirCreation() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Create this folder and continue? [Y/n] ", (answer) => {
      rl.close();
      const a = String(answer || "")
        .trim()
        .toLowerCase();
      resolve(a === "" || a === "y" || a === "yes");
    });
  });
}

// One-time migration: move a legacy app-folder .env into the data root.
// Idempotent. Returns a status object or null when nothing to do.
function migrateLegacyEnvFile(projectDir, dataDir, { testMode = false } = {}) {
  if (testMode) return null;
  const legacyEnv = path.join(projectDir, ".env");
  const newEnv = path.join(dataDir, ".env");
  if (path.resolve(legacyEnv) === path.resolve(newEnv)) return null;
  let legacyExists = false;
  try {
    fs.accessSync(legacyEnv, fs.constants.F_OK);
    legacyExists = true;
  } catch {
    legacyExists = false;
  }
  if (!legacyExists) return null;
  let newExists = false;
  try {
    fs.accessSync(newEnv, fs.constants.F_OK);
    newExists = true;
  } catch {
    newExists = false;
  }
  if (newExists) {
    console.log(
      `\nNote: found both an app-folder .env and ${newEnv}. Using ${newEnv}; the app-folder .env is ignored.\n`,
    );
    return { status: "both-exist" };
  }
  try {
    fs.renameSync(legacyEnv, newEnv);
  } catch {
    // Cross-device fallback: copy then delete.
    fs.copyFileSync(legacyEnv, newEnv);
    fs.rmSync(legacyEnv, { force: true });
  }
  console.log(`\nMoved your existing .env from the app folder to ${newEnv}.\n`);
  return { status: "moved", to: newEnv };
}

// Synchronous variant for server.js, which resolves DATA_ROOT at module top
// level (no interactive prompt possible there). Resolves, validates (exiting
// gracefully on an unusable path), creates the folder if missing (with a log
// line), and migrates a legacy app-folder .env. In test mode it resolves only
// (falling back to the default) without validating, creating, or migrating, so
// the test suite never touches the real home directory or blocks.
function ensureDataDirSync({ projectDir = __dirname, create = true } = {}) {
  const testMode = isTestMode();
  const { dataDir, source, ini } = resolveDataDir(projectDir);
  if (testMode) {
    return dataDir || path.join(os.homedir(), DEFAULT_DATA_DIR_NAME);
  }
  if (source === "data_dir.ini" && !dataDir) {
    failMissingIniPath({ ini });
    return null; // unreachable
  }
  const check = checkDataDir(dataDir);
  if (!check.ok) {
    failInvalidDataDir({ dataDir, source, ini, check });
    return null; // unreachable
  }
  if (!check.exists && create) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      console.log(`Created the app data folder at ${dataDir}.`);
    } catch (err) {
      console.error(`\nERROR: Could not create the data folder at ${dataDir}:\n  ${err.message}\n`);
      process.exit(1);
    }
    if (!isWritableDir(dataDir)) {
      console.error(`\nERROR: The data folder was created but is not writable: ${dataDir}\n`);
      process.exit(1);
    }
  }
  migrateLegacyEnvFile(projectDir, dataDir, { testMode });
  return dataDir;
}

// Orchestrator: resolve -> validate -> (announce + confirm + create) -> migrate.
// Exits the process on hard failures. Returns the resolved data root path.
async function prepareDataDir({ projectDir = __dirname, interactive = false, create = true } = {}) {
  const testMode = isTestMode();
  const { dataDir, source, ini } = resolveDataDir(projectDir);

  if (testMode) {
    // Resolve only: no validation, creation, prompt, or migration, so the test
    // suite never touches the real home directory or blocks on a prompt.
    return dataDir || path.join(os.homedir(), DEFAULT_DATA_DIR_NAME);
  }

  if (source === "data_dir.ini" && !dataDir) {
    failMissingIniPath({ ini });
    return null;
  }

  const check = checkDataDir(dataDir);
  if (!check.ok) {
    failInvalidDataDir({ dataDir, source, ini, check });
    return null; // unreachable
  }

  if (!check.exists && create) {
    announceDataDirCreation(dataDir);
    if (interactive && process.stdin.isTTY && process.stdout.isTTY) {
      const ok = await confirmDataDirCreation();
      if (!ok) {
        console.log(
          "\nExiting without creating the data folder. Edit data_dir.ini to change its location, then run the app again.",
        );
        process.exit(0);
      }
    }
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      console.error(`\nERROR: Could not create the data folder at ${dataDir}:\n  ${err.message}\n`);
      process.exit(1);
    }
    if (!isWritableDir(dataDir)) {
      console.error(`\nERROR: The data folder was created but is not writable: ${dataDir}\n`);
      process.exit(1);
    }
  }

  migrateLegacyEnvFile(projectDir, dataDir, { testMode });
  return dataDir;
}

module.exports = {
  DATA_DIR_INI_NAME,
  DEFAULT_DATA_DIR_NAME,
  confirmDataDirCreation,
  ensureDataDirSync,
  expandTilde,
  failInvalidDataDir,
  failMissingIniPath,
  isTestMode,
  checkDataDir,
  migrateLegacyEnvFile,
  prepareDataDir,
  readDataDirIni,
  resolveDataDir,
};
