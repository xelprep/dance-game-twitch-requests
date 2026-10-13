// Single-instance lock: ensures only one app instance runs at a time.
//
// A lock file (instance.lock) lives in the resolved data root. It is created
// atomically with O_EXCL (atomic on all three platforms). On success the holder
// writes { pid, hostname, startedAt, version }. On startup:
//   - No lock -> create it, continue.
//   - Lock exists -> read it. If the hostname differs, or the recorded PID is
//     not alive (process.kill(pid, 0) throws ESRCH), it is stale: delete it and
//     take over. (Covers crashes, SIGKILL, and power loss, where the release
//     hook never ran.)
//   - Lock held by a live process -> refuse (the caller prints a message).
//
// Release is best-effort (fs.rm) on normal exit and in the signal handlers. A
// leftover lock after a hard kill is always recovered by the stale check above.
//
// Known edge: PID reuse after a crash could in theory make a stale lock look
// live. Mitigated by the hostname check; the residual risk is one confusing
// message, resolved by deleting the lock file — acceptable for a single-user app.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOCK_NAME = "instance.lock";

function lockPathFor(dataDir) {
  return path.join(dataDir, LOCK_NAME);
}

// Liveness probe: signal 0 checks existence without sending a signal. Works on
// Windows too. EPERM means the process exists but we can't signal it (alive).
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function writeLockFile(lockPath, payload) {
  const fd = fs.openSync(
    lockPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o644,
  );
  try {
    fs.writeSync(fd, JSON.stringify(payload, null, 2));
  } finally {
    fs.closeSync(fd);
  }
}

// Try to acquire the lock. Returns:
//   { acquired: true, lockPath, holder, tookOverStale? }  on success
//   { acquired: false, lockPath, holder }                 when a live holder exists
function acquireLock(dataDir, { version = null } = {}) {
  const lockPath = lockPathFor(dataDir);
  const payload = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    version,
  };
  try {
    writeLockFile(lockPath, payload);
    return { acquired: true, lockPath, holder: payload };
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Lock exists: decide stale vs live.
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      holder = null; // unreadable/corrupt -> stale
    }
    const stale =
      !holder ||
      !Number.isInteger(holder.pid) ||
      holder.hostname !== os.hostname() ||
      !isProcessAlive(holder.pid);
    if (!stale) {
      return { acquired: false, lockPath, holder };
    }
    // Stale: remove and take over.
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // ignore; the O_EXCL below fails loudly if it reappears
    }
    try {
      writeLockFile(lockPath, payload);
      return { acquired: true, lockPath, holder: payload, tookOverStale: true };
    } catch (e2) {
      if (e2.code === "EEXIST") {
        // Another instance grabbed it between our rm and create; refuse.
        let newHolder = null;
        try {
          newHolder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        } catch {
          /* keep the old holder */
        }
        return { acquired: false, lockPath, holder: newHolder || holder };
      }
      throw e2;
    }
  }
}

// Best-effort release. Safe to call multiple times.
function releaseLock(dataDir) {
  try {
    fs.rmSync(lockPathFor(dataDir), { force: true });
  } catch {
    // ignore
  }
}

module.exports = {
  LOCK_NAME,
  acquireLock,
  isProcessAlive,
  lockPathFor,
  releaseLock,
};
