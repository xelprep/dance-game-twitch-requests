process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isMacAppBundleLaunch,
  hasTty,
  shellQuote,
  performMacTerminalHandoff,
} = require("../../macHandoff.cjs");

const APP_EXEC =
  "/Applications/Dance Game Twitch Requests.app/Contents/MacOS/dance-game-twitch-requests";

test("isMacAppBundleLaunch detects the .app binary on macOS only", () => {
  assert.equal(isMacAppBundleLaunch(APP_EXEC, "darwin"), true);
  assert.equal(isMacAppBundleLaunch("/opt/app/dance-game-twitch-requests", "darwin"), false);
  assert.equal(isMacAppBundleLaunch(APP_EXEC, "linux"), false);
  assert.equal(isMacAppBundleLaunch(APP_EXEC, "win32"), false);
});

test("hasTty is true when either stream is a TTY", () => {
  assert.equal(hasTty({ isTTY: true }, { isTTY: false }), true);
  assert.equal(hasTty({ isTTY: false }, { isTTY: true }), true);
  assert.equal(hasTty({ isTTY: false }, { isTTY: false }), false);
  assert.equal(hasTty(null, null), false);
});

test("shellQuote passes safe strings and quotes unsafe ones", () => {
  assert.equal(shellQuote("--no-scan"), "--no-scan");
  assert.equal(shellQuote("a=b/c.d"), "a=b/c.d");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("performMacTerminalHandoff skips when not a .app launch or when a TTY exists", () => {
  const base = {
    execPath: APP_EXEC,
    platform: "darwin",
    argv: ["/x", "/y"],
    stdin: { isTTY: false },
    stdout: { isTTY: false },
    spawn: () => {
      throw new Error("should not spawn");
    },
    write: () => {
      throw new Error("should not write");
    },
  };
  assert.equal(performMacTerminalHandoff({ ...base, execPath: "/opt/app/bin" }), false);
  assert.equal(performMacTerminalHandoff({ ...base, stdout: { isTTY: true } }), false);
});

test("performMacTerminalHandoff writes a .command and opens it on success", () => {
  let written = null;
  let opened = null;
  const result = performMacTerminalHandoff({
    execPath: APP_EXEC,
    platform: "darwin",
    argv: ["/x", "/y", "--no-scan"],
    stdin: { isTTY: false },
    stdout: { isTTY: false },
    spawn: (cmd, args) => {
      opened = { cmd, args };
      return { status: 0 };
    },
    write: (p, contents) => {
      written = { p, contents };
    },
    tmpdir: () => "/tmp",
    pid: 4242,
    log: () => {},
    warn: () => {
      throw new Error("should not warn");
    },
  });
  assert.equal(result, true);
  assert.equal(opened.cmd, "open");
  assert.equal(opened.args[0], "/tmp/dance-game-requests-4242.command");
  assert.ok(written.contents.startsWith("#!/bin/sh\n"));
  assert.ok(written.contents.includes(`exec "${APP_EXEC}" --no-scan`));
});

test("performMacTerminalHandoff falls back to headless when open fails", () => {
  let removed = null;
  const result = performMacTerminalHandoff({
    execPath: APP_EXEC,
    platform: "darwin",
    argv: ["/x", "/y"],
    stdin: { isTTY: false },
    stdout: { isTTY: false },
    spawn: () => ({ status: 1 }),
    write: () => {},
    rm: (p) => {
      removed = p;
    },
    tmpdir: () => "/tmp",
    pid: 4242,
    log: () => {
      throw new Error("should not log success");
    },
    warn: () => {},
  });
  assert.equal(result, false);
  assert.equal(removed, "/tmp/dance-game-requests-4242.command");
});
