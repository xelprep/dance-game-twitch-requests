process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  LOCK_NAME,
  acquireLock,
  isProcessAlive,
  lockPathFor,
  releaseLock,
} = require("../../instanceLock.cjs");

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A PID that is definitely dead: run a child that exits immediately, then reuse
// its (now-dead) pid.
function getDeadPid() {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  return result.pid;
}

test("isProcessAlive reports the current process alive and a dead pid not", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(getDeadPid()), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive("nope"), false);
});

test("acquireLock creates a fresh lock and writes the holder", (t) => {
  const dataDir = makeTemp("dgr-lock-fresh-");
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const result = acquireLock(dataDir, { version: "1.0.0" });
  assert.equal(result.acquired, true);
  assert.equal(result.tookOverStale, undefined);
  assert.equal(result.lockPath, lockPathFor(dataDir));
  assert.equal(result.holder.pid, process.pid);
  assert.equal(result.holder.hostname, os.hostname());
  assert.equal(result.holder.version, "1.0.0");

  const onDisk = JSON.parse(fs.readFileSync(result.lockPath, "utf8"));
  assert.equal(onDisk.pid, process.pid);
  assert.equal(onDisk.hostname, os.hostname());
});

test("acquireLock refuses when a live process holds the lock", (t) => {
  const dataDir = makeTemp("dgr-lock-live-");
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  // A live holder: the current process (alive) on this host.
  fs.writeFileSync(
    lockPathFor(dataDir),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }),
    "utf8",
  );

  const result = acquireLock(dataDir);
  assert.equal(result.acquired, false);
  assert.equal(result.holder.pid, process.pid);
  // The existing lock is left untouched.
  assert.ok(fs.existsSync(result.lockPath));
});

test("acquireLock takes over a stale lock (dead pid / other host / corrupt)", (t) => {
  const dataDir = makeTemp("dgr-lock-stale-");
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  // Dead pid on this host.
  fs.writeFileSync(
    lockPathFor(dataDir),
    JSON.stringify({ pid: getDeadPid(), hostname: os.hostname(), startedAt: new Date().toISOString() }),
    "utf8",
  );
  let result = acquireLock(dataDir);
  assert.equal(result.acquired, true);
  assert.equal(result.tookOverStale, true);
  assert.equal(result.holder.pid, process.pid);
  releaseLock(dataDir);

  // Different hostname (even with a live pid) is treated as stale.
  fs.writeFileSync(
    lockPathFor(dataDir),
    JSON.stringify({ pid: process.pid, hostname: "some-other-host", startedAt: new Date().toISOString() }),
    "utf8",
  );
  result = acquireLock(dataDir);
  assert.equal(result.acquired, true);
  assert.equal(result.tookOverStale, true);
  releaseLock(dataDir);

  // Corrupt (unreadable) lock is treated as stale.
  fs.writeFileSync(lockPathFor(dataDir), "not json", "utf8");
  result = acquireLock(dataDir);
  assert.equal(result.acquired, true);
  assert.equal(result.tookOverStale, true);
});

test("releaseLock removes the lock file and is idempotent", (t) => {
  const dataDir = makeTemp("dgr-lock-release-");
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const result = acquireLock(dataDir);
  assert.equal(result.acquired, true);
  assert.ok(fs.existsSync(result.lockPath));

  releaseLock(dataDir);
  assert.equal(fs.existsSync(result.lockPath), false);
  // Second release is a no-op (no throw).
  releaseLock(dataDir);
  assert.equal(fs.existsSync(result.lockPath), false);
});

test("LOCK_NAME is instance.lock", () => {
  assert.equal(LOCK_NAME, "instance.lock");
});
