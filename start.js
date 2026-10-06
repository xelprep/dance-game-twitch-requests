#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { isSetupComplete } = require("./setupConfig.cjs");
const { prepareDataDir } = require("./dataDir.cjs");

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

async function main() {
  // `--setup` re-runs the interactive configuration wizard and exits. This is
  // how a packaged binary (where `npm run setup` is unavailable) re-opens setup.
  if (process.argv.includes("--setup")) {
    const dataDir = await prepareDataDir({ projectDir: __dirname, interactive: true });
    if (!dataDir) return; // prepareDataDir already exited on failure
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("Interactive setup needs a terminal (TTY).");
      process.exitCode = 1;
      return;
    }
    const success = await runSetupTui();
    process.exitCode = success ? 0 : 1;
    return;
  }

  // Resolve and prepare the app data root first. This handles the data_dir.ini
  // lookup, validation, the "about to create this folder" announcement with an
  // offer to quit, and one-time migration of a legacy app-folder .env.
  const dataDir = await prepareDataDir({ projectDir: __dirname, interactive: true });
  if (!dataDir) return; // prepareDataDir already exited on failure

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
