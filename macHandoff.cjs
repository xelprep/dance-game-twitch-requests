// macOS .app double-click handoff.
//
// When the compiled binary is launched from Finder (inside a .app bundle, no
// TTY), hand off to a Terminal window so the app runs with a real TTY: logs are
// visible, the setup TUI works on first launch, and closing the window kills the
// app (SIGHUP). We write a freshly-generated .command file and open it with
// `open` (the same LaunchServices path as a user double-clicking a .command),
// which avoids the AppleEvents/TCC automation prompt an osascript handoff would
// trigger. The fresh .command carries no quarantine xattr, so Gatekeeper doesn't
// block it.
//
// start.js calls performMacTerminalHandoff() at the very top of main(); if it
// returns true the caller exits 0 (the Terminal-side instance does the real
// work). Everything here is dependency-injectable so it can be unit-tested.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// True when the executable is the binary inside a macOS .app bundle.
function isMacAppBundleLaunch(execPath = process.execPath, platform = process.platform) {
  return platform === "darwin" && /\.app\/Contents\/MacOS\//.test(execPath);
}

// True when attached to a terminal on either stdin or stdout.
function hasTty(stdin = process.stdin, stdout = process.stdout) {
  return Boolean(stdin && stdin.isTTY) || Boolean(stdout && stdout.isTTY);
}

// Minimal POSIX single-quote escaping for baking argv into the .command script.
function shellQuote(arg) {
  const s = String(arg);
  if (s.length > 0 && /^[A-Za-z0-9_\-./=:]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Returns true if the handoff was performed (the caller should exit 0); false
// otherwise (run normally / headless). All I/O is injectable for testing.
function performMacTerminalHandoff({
  execPath = process.execPath,
  platform = process.platform,
  argv = process.argv,
  stdin = process.stdin,
  stdout = process.stdout,
  spawn = spawnSync,
  write = fs.writeFileSync,
  rm = fs.rmSync,
  tmpdir = os.tmpdir,
  pid = process.pid,
  log = console.log,
  warn = console.error,
} = {}) {
  if (!isMacAppBundleLaunch(execPath, platform) || hasTty(stdin, stdout)) return false;
  const args = argv.slice(2).map(shellQuote).join(" ");
  const commandPath = path.join(tmpdir(), `dance-game-requests-${pid}.command`);
  const script = `#!/bin/sh\nexec "${execPath}" ${args}\n`;
  try {
    write(commandPath, script, { mode: 0o755 });
  } catch (err) {
    warn(`Could not write the terminal handoff script: ${err.message}`);
    return false; // fall back to running headless
  }
  const result = spawn("open", [commandPath], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    warn("Could not open Terminal.app; continuing headless.");
    try {
      rm(commandPath, { force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  log("Opening the app in Terminal…");
  return true;
}

module.exports = {
  isMacAppBundleLaunch,
  hasTty,
  shellQuote,
  performMacTerminalHandoff,
};
