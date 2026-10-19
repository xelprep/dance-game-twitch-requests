// Built-in updater for the standalone (pkg/SEA) binaries.
//
// When the app is launched as a compiled binary (not `node start.js` from the
// repo), it can offer to pull a newer release for the *current* OS + arch
// straight from GitHub Releases and restart itself using it. The npm/source
// path has no single executable to replace, so the updater is a no-op there —
// the correct update for that path is `git pull`.
//
// Flow (see start.js for the consent prompt that gates it):
//   1. Compare the baked-in app version to the newest release tag (semver).
//   2. Pick the release asset matching this OS + arch
//      (`dance-game-twitch-requests-<version>-<os>-<arch>.zip`).
//   3. Download the zip, extract the single executable entry whose basename
//      matches the running binary, and rename it over process.execPath.
//   4. Re-exec the freshly written binary with the original argv; the parent
//      exits with the child's status.
//
// Why re-exec instead of overwriting the running image in place: a process
// cannot safely overwrite the executable file it is currently running (macOS/
// Linux give EACCES/SIGBUS; Linux requires unlink-before-replace). Renaming a
// new file over the old path is atomic and leaves the still-running image
// mapped to the old inode, so the on-disk path is updated "in place" while the
// takeover happens by spawning the new binary as a child. This is the same
// pattern gh/ripgrep/etc. use for self-update.
//
// The lock is NOT involved: start.js runs the updater *before* acquiring the
// single-instance lock, so the parent never holds a lock and the re-exec'd
// child acquires one cleanly.
//
// Everything I/O (network, fs, spawn, semver, confirm) is injectable so the
// logic is unit-testable without touching a real binary or the network.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const zlib = require("node:zlib");
const childProcess = require("node:child_process");
const readline = require("node:readline");

const DEFAULT_OWNER = "xelprep";
const DEFAULT_REPO = "dance-game-twitch-requests";
const API_BASE = "https://api.github.com";
const UA = "dance-game-twitch-requests-updater";

// Map Node's platform/arch onto the release asset naming used by release.yml
// (os: macos|windows|linux; arch: arm64|x64).
function targetFor(platform = process.platform, arch = process.arch) {
  const osName = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
  const archName = arch === "arm64" ? "arm64" : "x64";
  return { os: osName, arch: archName };
}

// Compare two dotted numeric versions ("1.0.12" vs "1.0.13"). Returns >0 when
// `left` is newer, <0 when older, 0 when equal. Non-numeric segments compare
// as 0. Strips a leading "v" (release tags are "v1.0.13").
function compareVersions(left, right) {
  const parse = (value) =>
    String(value || "")
      .replace(/^v/i, "")
      .split(".")
      .map((part) => parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// True when running as a compiled SEA binary (pkg sets process.pkg). In dev
// (`node start.js`) this is false and the updater must not run.
function isCompiledBinary(processPkg = Boolean(process.pkg)) {
  return processPkg === true;
}

// True when attached to a terminal on either stream (a consent prompt needs one).
function hasTty(stdin = process.stdin, stdout = process.stdout) {
  return Boolean(stdin && stdin.isTTY) || Boolean(stdout && stdout.isTTY);
}

// Interactive [Y/n] confirmation. Resolves true on empty/yes, false otherwise.
// `input`/`output` are injectable for tests.
function parseConfirmAnswer(answer) {
  const normalized = String(answer || "")
    .trim()
    .toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}

function confirmUpdate(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolvePromise) => {
    const rl = readline.createInterface({ input, output });
    rl.question(question, (answer) => {
      rl.close();
      resolvePromise(parseConfirmAnswer(answer));
    });
  });
}

// GET a GitHub API endpoint and return parsed JSON. `get` is injectable for
// tests; the default uses node:https with the required User-Agent header.
async function fetchJson(url, { get = https.get, timeoutMs = 15000 } = {}) {
  return new Promise((resolvePromise) => {
    const request = get(
      url,
      { headers: { "User-Agent": UA, Accept: "application/json" } },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode >= 400) {
            resolvePromise({ error: `HTTP ${response.statusCode} from ${url}` });
            return;
          }
          try {
            resolvePromise({ json: JSON.parse(body) });
          } catch (err) {
            resolvePromise({ error: `Could not parse response: ${err.message}` });
          }
        });
        response.on("error", (err) => resolvePromise({ error: err.message }));
      },
    );
    if (request && typeof request.setTimeout === "function") {
      request.setTimeout(timeoutMs, () => {
        try {
          request.destroy();
        } catch {
          /* ignore */
        }
        resolvePromise({ error: "request timed out" });
      });
    }
    if (request && typeof request.on === "function") request.on("error", () => {});
  });
}

// Download a URL to a Buffer. `get` is injectable for tests.
async function downloadToBuffer(url, { get = https.get, timeoutMs = 60000 } = {}) {
  return new Promise((resolvePromise) => {
    const request = get(url, { headers: { "User-Agent": UA } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // GitHub release browser_download_url 301/302-redirects to a CDN host.
        resolvePromise(downloadToBuffer(response.headers.location, { get, timeoutMs }));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode >= 400) {
          resolvePromise({ error: `HTTP ${response.statusCode} downloading ${url}` });
          return;
        }
        resolvePromise({ buffer: Buffer.concat(chunks) });
      });
      response.on("error", (err) => resolvePromise({ error: err.message }));
    });
    if (request && typeof request.setTimeout === "function") {
      request.setTimeout(timeoutMs, () => {
        try {
          request.destroy();
        } catch {
          /* ignore */
        }
        resolvePromise({ error: "download timed out" });
      });
    }
    if (request && typeof request.on === "function") request.on("error", () => {});
  });
}

// Pick the release asset matching this OS + arch. Asset names look like
// `dance-game-twitch-requests-1.0.13-macos-arm64.zip`.
function pickAsset(assets, target) {
  const wanted = `-${target.os}-${target.arch}`;
  for (const asset of assets || []) {
    const name = String(asset.name || "");
    if (name.endsWith(`${wanted}.zip`) && asset.browser_download_url) {
      return asset;
    }
  }
  return null;
}

// Minimal ZIP reader: return the inflated bytes of the single entry whose
// basename matches `wantedBasename`. Handles "store" and "deflate" methods
// (the two produced by zip/ditto/Compress-Archive for these small binaries)
// using the built-in zlib, so no extra dependency is needed.
function extractZipEntry(zipBuffer, wantedBasename) {
  // Locate End of Central Directory record (scan back for signature 0x504b0506).
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = zipBuffer.length - 22; i >= 0 && i >= zipBuffer.length - 65557; i--) {
    if (
      zipBuffer[i] === eocdSig[0] &&
      zipBuffer[i + 1] === eocdSig[1] &&
      zipBuffer[i + 2] === eocdSig[2] &&
      zipBuffer[i + 3] === eocdSig[3]
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a valid zip archive");

  const entryCount = zipBuffer.readUInt16LE(eocd + 10);
  let offset = zipBuffer.readUInt32LE(eocd + 16);

  for (let n = 0; n < entryCount; n++) {
    if (
      zipBuffer[offset] !== 0x50 ||
      zipBuffer[offset + 1] !== 0x4b ||
      zipBuffer[offset + 2] !== 0x01 ||
      zipBuffer[offset + 3] !== 0x02
    ) {
      break; // central directory entry signature PK\x01\x02
    }
    const method = zipBuffer.readUInt16LE(offset + 10);
    const compressedSize = zipBuffer.readUInt32LE(offset + 20);
    const nameLength = zipBuffer.readUInt16LE(offset + 28);
    const extraLength = zipBuffer.readUInt16LE(offset + 30);
    const commentLength = zipBuffer.readUInt16LE(offset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
    const name = zipBuffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    if (path.basename(name) === wantedBasename) {
      // Read the local file header to find where data actually starts (local
      // extra-field length can differ from the central directory's).
      const lNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const lExtraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lNameLength + lExtraLength;
      const data = zipBuffer.slice(dataStart, dataStart + compressedSize);
      if (method === 0) {
        return data; // stored
      }
      if (method === 8) {
        return zlib.inflateRawSync(data); // deflate
      }
      throw new Error(`unsupported zip method ${method} for ${name}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

// Replace the running binary with the new bytes, then re-exec it with the
// original argv. Returns the child's exit code. All I/O injectable for tests.
async function performUpdate(
  newBinaryBuffer,
  execPath,
  argv,
  {
    spawn = childProcess.spawn,
    writeFile = fs.writeFileSync,
    rename = fs.renameSync,
    chmod = fs.chmodSync,
    unlink = fs.unlinkSync,
    rm = fs.rmSync,
    platform = process.platform,
    pid = process.pid,
  } = {},
) {
  // Write the new binary to a temp file beside the target, then rename over it
  // (atomic; the still-running image keeps the old inode). On Windows, rename
  // cannot overwrite an existing file, so unlink first.
  const tempPath = `${execPath}.update-${pid}.tmp`;
  writeFile(tempPath, newBinaryBuffer);
  try {
    if (platform !== "win32") {
      chmod(tempPath, 0o755);
    }
  } catch {
    /* chmod is a no-op on Windows */
  }
  try {
    if (platform === "win32") {
      try {
        unlink(execPath);
      } catch {
        /* may not exist */
      }
    }
    rename(tempPath, execPath);
  } catch (err) {
    try {
      rm(tempPath, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`Could not replace the app binary: ${err.message}`);
  }

  const child = spawn(execPath, argv, { stdio: "inherit" });
  const code = await childPromiseExit(child, spawn);
  return code;
}

// Await a spawned child's 'exit' event as a number. `spawn` is injectable, so
// tests can hand back a fake child that already carries an exit code.
function childPromiseExit(child, spawn) {
  if (typeof child.on !== "function") {
    return Promise.resolve(Number(child.exitCode ?? child.code ?? 0));
  }
  return new Promise((resolvePromise) => {
    child.on("exit", (code) => resolvePromise(Number(code ?? 0)));
    child.on("error", () => resolvePromise(1));
  });
}

// High-level plan: gather everything needed to decide whether an update is
// available. Pure-ish (network injectable). Returns
//   { currentVersion, latestVersion, asset, target, updateAvailable }
async function planUpdate(
  currentVersion,
  { owner = DEFAULT_OWNER, repo = DEFAULT_REPO, fetch = fetchJson, targetOverride = null } = {},
) {
  const target = targetOverride || targetFor();
  const releaseUrl = `${API_BASE}/repos/${owner}/${repo}/releases/latest`;
  const fetched = await fetch(releaseUrl);
  if (fetched.error) return { error: fetched.error };
  const release = fetched.json;
  const latestVersion = String(release.tag_name || "").replace(/^v/i, "");
  const asset = pickAsset(release.assets, target);
  return {
    currentVersion,
    latestVersion,
    target,
    asset,
    updateAvailable: Boolean(asset) && compareVersions(latestVersion, currentVersion) > 0,
  };
}

// Top-level entry used by start.js. Decides whether to update, gets consent
// (unless forced with --update), downloads the matching asset, replaces the
// running binary, and re-execs it. Returns a status object; on a successful
// takeover it never returns (the child replaces the process and the parent
// exits with the child's code via process.exit).
async function maybeUpdate(
  currentVersion,
  {
    force = false,
    owner = DEFAULT_OWNER,
    repo = DEFAULT_REPO,
    execPath = process.execPath,
    argv = process.argv.slice(2),
    compiled = isCompiledBinary(),
    tty = hasTty(),
    plan = planUpdate,
    download = downloadToBuffer,
    extract = extractZipEntry,
    perform = performUpdate,
    confirm = confirmUpdate,
    log = console.log,
    warn = console.error,
  } = {},
) {
  if (!compiled) {
    // Running from source (`node start.js`): there is no single binary to
    // replace. Point the user at the right update path instead.
    if (force) {
      warn(
        "Built-in update is only available for the standalone binary. " +
          "For the source/npm copy, update by pulling the latest release from git.",
      );
      return { skipped: "not-compiled", exitCode: 1 };
    }
    return { skipped: "not-compiled" };
  }

  // A consent-driven startup check needs a terminal; without one (and without
  // an explicit --update), skip the network round-trip entirely so headless
  // launches stay fast and offline-safe.
  if (!force && !tty) {
    return { skipped: "no-tty" };
  }

  const planned = await plan(currentVersion, { owner, repo });
  if (planned.error) {
    warn(`Could not check for a newer version: ${planned.error}`);
    return { skipped: "check-failed", error: planned.error };
  }
  if (!planned.updateAvailable) {
    log(`Already on the latest version (${planned.currentVersion}).`);
    return { skipped: "up-to-date", latestVersion: planned.latestVersion };
  }

  log(
    `A newer version is available: ${planned.latestVersion} (you are on ${planned.currentVersion}). ` +
      `Target: ${planned.target.os}-${planned.target.arch}.`,
  );

  if (!force) {
    const ok = await confirm(`Update to ${planned.latestVersion} now? [Y/n] `, {
      input: process.stdin,
      output: process.stdout,
    });
    if (!ok) {
      log("Update declined. Continuing with the current version.");
      return { skipped: "declined" };
    }
  }

  log(`Downloading ${planned.latestVersion}…`);
  const downloaded = await download(planned.asset.browser_download_url);
  if (downloaded.error) {
    warn(`Update failed: ${downloaded.error}`);
    return { skipped: "download-failed", error: downloaded.error };
  }

  let newBinary;
  try {
    newBinary = extract(downloaded.buffer, path.basename(execPath));
  } catch (err) {
    warn(`Update failed: ${err.message}`);
    return { skipped: "extract-failed", error: err.message };
  }
  if (!newBinary) {
    warn("Update failed: the release archive does not contain the running executable.");
    return { skipped: "extract-failed", error: "missing executable in archive" };
  }

  log(`Replacing the app binary and restarting as ${planned.latestVersion}…`);
  const exitCode = await perform(newBinary, execPath, argv);
  return { updated: true, latestVersion: planned.latestVersion, exitCode };
}

module.exports = {
  DEFAULT_OWNER,
  DEFAULT_REPO,
  API_BASE,
  targetFor,
  compareVersions,
  isCompiledBinary,
  hasTty,
  confirmUpdate,
  parseConfirmAnswer,
  fetchJson,
  downloadToBuffer,
  pickAsset,
  extractZipEntry,
  childPromiseExit,
  performUpdate,
  planUpdate,
  maybeUpdate,
};
