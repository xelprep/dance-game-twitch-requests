#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { isSetupComplete } = require("./setupConfig.cjs");
const { prepareDataDir } = require("./dataDir.cjs");
const { acquireLock, releaseLock } = require("./instanceLock.cjs");
const { performMacTerminalHandoff } = require("./macHandoff.cjs");
const { maybeUpdate } = require("./updater.cjs");

function readConfiguredValues(envPath) {
  let fileValues = {};
  try {
    fileValues = dotenv.parse(fs.readFileSync(envPath, "utf8"));
  } catch {
    // Missing .env is a normal first-launch state.
  }
  return { ...fileValues, ...process.env };
}

// Run the interactive setup wizard in-process. A pkg-packaged binary cannot
// spawn a second copy of itself to run a different script (it always re-runs
// the entry point), so we import the ESM wizard and drive it directly. This
// behaves identically under `node` and inside the packaged executable.
async function runSetupTui() {
  const { runSetup } = await import("./setupTui.mjs");
  return runSetup();
}

function readVersion() {
  try {
    return require("./package.json").version;
  } catch {
    return null;
  }
}

function printUsage() {
  console.log(
    "Dance Game Twitch Requests - song database, Twitch chat request bot and web queue.\n" +
      "\nUsage: dance-game-twitch-requests [options]\n" +
      "\nOptions:\n" +
      "  -h, -?, --help     Show this help and exit.\n" +
      "  -v, --version      Show the app version and exit.\n" +
      "  --setup            Re-run the interactive setup wizard, then exit.\n" +
      "  --no-scan          Skip the initial song scan when a viable database\n" +
      "                     already exists.\n" +
      "  --update           Check GitHub for a newer standalone-binary release\n" +
      "                     for this OS/arch and update in place (no prompt).\n" +
      "\nConfiguration lives in a .env file inside the app data root\n" +
      "(~/.dance-game-requests by default): SONGS_DIR, CONTROL_PASSWORD,\n" +
      "and optional overrides (PORT, ARTWORK_CACHE_DIR, SCANNER_THREADS, ...).",
  );
}

async function main() {
  // macOS .app double-click: hand off to Terminal before doing anything else.
  // This never touches the data dir or the lock; the Terminal-side instance
  // (with a real TTY) does the real work.
  if (performMacTerminalHandoff()) {
    process.exit(0);
  }

  // Informational flags first: help/version need no data dir, instance lock,
  // or setup, so they work even on an unconfigured app launched from a CLI.
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("-?") || argv.includes("--help")) {
    printUsage();
    return;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    const version = readVersion();
    if (!version) {
      console.error("App version could not be determined.");
      process.exitCode = 1;
    } else {
      console.log(`Dance Game Twitch Requests ${version}`);
    }
    return;
  }

  // Built-in updater: for the standalone binary only, offer to pull a newer
  // release for this OS/arch from GitHub and restart using it. Runs BEFORE the
  // data dir is prepared and the instance lock is acquired, so the parent never
  // holds a lock the re-exec'd child would collide with. On a successful
  // takeover the child runs the app and the parent exits with its code.
  const updateResult = await maybeUpdate(readVersion(), { force: argv.includes("--update") });
  if (updateResult.updated) {
    process.exitCode = updateResult.exitCode;
    return;
  }
  // `--update` requested but this is the source/npm copy: maybeUpdate already
  // explained the right update path; stop rather than start the app.
  if (updateResult.exitCode) {
    process.exitCode = updateResult.exitCode;
    return;
  }

  // Resolve and prepare the app data root first. This handles the data_dir.ini
  // lookup, validation, the "about to create this folder" announcement with an
  // offer to quit, and one-time migration of a legacy app-folder .env.
  const dataDir = await prepareDataDir({ projectDir: __dirname, interactive: true });
  if (!dataDir) return; // prepareDataDir already exited on failure

  // Single-instance lock: only one app instance at a time. Acquired on both the
  // --setup and server paths (setup rewrites the config a live server reads).
  // Released on any exit via the handler below (covers normal exit, errors, and
  // the graceful-shutdown path in server.js).
  const lock = acquireLock(dataDir, { version: readVersion() });
  if (!lock.acquired) {
    console.error(
      `Dance Game Twitch Requests is already running (PID ${lock.holder.pid}, started ${lock.holder.startedAt}).`,
    );
    console.error("Stop the running instance before starting another.");
    process.exit(1);
  }
  if (lock.tookOverStale) {
    console.log("Removed a stale instance lock from a previous run.");
  }
  let lockReleased = false;
  process.on("exit", () => {
    if (lockReleased) return;
    lockReleased = true;
    releaseLock(dataDir);
  });

  // `--setup` re-runs the interactive configuration wizard and exits. This is
  // how a packaged binary (where `npm run setup` is unavailable) re-opens setup.
  if (process.argv.includes("--setup")) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("Interactive setup needs a terminal (TTY).");
      process.exitCode = 1;
      return;
    }
    const success = await runSetupTui();
    process.exitCode = success ? 0 : 1;
    return;
  }

  // .env lives inside the data root (not beside the app), so a portable/installed
  // copy keeps its config in one place regardless of where it is launched from.
  const envPath = path.join(dataDir, ".env");
  if (!isSetupComplete(readConfiguredValues(envPath))) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(
        `App setup is incomplete. Run the app with \`--setup\` in a terminal, or configure SONGS_DIR and CONTROL_PASSWORD in ${envPath}.`,
      );
      process.exitCode = 1;
      return;
    }
    const success = await runSetupTui();
    if (!success) {
      process.exitCode = 1;
      return;
    }
    if (!isSetupComplete(readConfiguredValues(envPath))) {
      console.error(
        "Setup did not produce a valid Songs directory and control-panel password; app startup canceled.",
      );
      process.exitCode = 1;
      return;
    }
  }
  process.argv = [process.argv[0], path.join(__dirname, "server.js"), ...process.argv.slice(2)];
  require("./server.js");
}

main().catch((error) => {
  console.error(`Unable to start the app: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { readConfiguredValues };
