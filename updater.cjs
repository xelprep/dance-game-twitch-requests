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
// Windows is stricter: while a process runs, Windows can refuse to *delete or
// replace* the directory entry of its own executable image outright
// (ACCESS_DENIED -> "EPERM: operation not permitted, rename ..."), which is
// what launched apps hit (e.g. an exe extracted onto the Desktop and
// double-clicked). Two-stage fallback: retry the in-place replace a few times
// with short waits (covers transient handles, e.g. Explorer's), then hand off
// to a restart helper that (1) waits until the parent's Node PID has actually
// exited (Windows can hold the .exe image mapped for longer than a fixed sleep
// once Defender or Explorer's icon cache has touched the file, which is what a
// fixed 750 ms wait kept missing on real machines), (2) retries the move with
// -LiteralPath so paths containing * ? [ ] + ( ) never become PS globs, (3)
// relaunches via Start-Process in a fresh console window, and (4) falls back to
// `explorer.exe <exe>` if Start-Process throws — on Windows 11 that's the
// SmartScreen "Run this app anyway" gate an unsigned downloaded binary hits,
// and Explorer's open path surfaces that prompt for one click-through exactly
// like a manual double-click does.
//
// The helper must NOT be a plain detached child: a process Node spawns on
// Windows inherits the parent's *console*, and when a double-clicked console
// subsystem exe exits Explorer closes that window, which terminates everything
// still attached to it. A detached `powershell.exe` died mid-sleep in that
// window close, so the .tmp binary sat next to an unchanged .exe and nothing
// ever respawned. Instead the helper lives in a generated `.cmd` + `.ps1` pair
// launched with `explorer.exe <path>.cmd` — the same process Explorer starts
// when a user double-clicks a .cmd, so it gets a brand-new console and an
// independent process tree that survives the parent (mirrors what macHandoff
// does with `open <path>.command`).
//
// macOS .app bundles: the binary lives at `<App>.app/Contents/MacOS/<exe>`,
// and the bundle carries metadata that must follow the binary: after a
// successful replace inside a bundle we restamp Contents/Info.plist
// (CFBundleShortVersionString + CFBundleVersion) and re-run the same ad-hoc
// `codesign --force --sign - <App>.app` the build applies, so Finder metadata
// and Gatekeeper state match the new version.
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

// True when the executable is the binary inside a macOS .app bundle
// (`<App>.app/Contents/MacOS/<exe>`); returns the bundle root or null.
function macAppBundlePath(execPath = process.execPath, platform = process.platform) {
  if (platform !== "darwin") return null;
  const match = /^(.*\.app)[\/]Contents[\/]MacOS[\/]/.exec(String(execPath));
  return match ? match[1] : null;
}

// Restamp the version keys in a bundle's Info.plist (CFBundleShortVersionString
// and CFBundleVersion) so Finder metadata matches the replaced binary. Pure —
// the same `<key>...<string>` shapes packageApp.mjs generates.
function patchInfoPlistVersions(plistText, version) {
  const safe = String(version).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let out = String(plistText).replace(
    /<key>CFBundleShortVersionString<\/key>\s*<string>[^<]*<\/string>/,
    `<key>CFBundleShortVersionString</key>\n\t<string>${safe}</string>`,
  );
  out = out.replace(
    /<key>CFBundleVersion<\/key>\s*<string>[^<]*<\/string>/,
    `<key>CFBundleVersion</key>\n\t<string>${safe}</string>`,
  );
  return out;
}

// After replacing the binary *inside* a .app bundle, restamp its metadata and
// re-apply the build's ad-hoc bundle signature. Best-effort: a bundle without
// an Info.plist (or without codesign) still has the updated binary.
function restampMacAppBundle(
  execPath,
  newVersion = null,
  {
    platform = process.platform,
    read = fs.readFileSync,
    write = fs.writeFileSync,
    codesign = childProcess.spawnSync,
  } = {},
) {
  const bundlePath = macAppBundlePath(execPath, platform);
  if (!bundlePath || !newVersion) return;
  const plistPath = path.join(bundlePath, "Contents", "Info.plist");
  try {
    const plist = read(plistPath, "utf8");
    write(plistPath, patchInfoPlistVersions(plist, newVersion), "utf8");
  } catch {
    /* not a built bundle (no Info.plist) — nothing to restamp */
  }
  try {
    // Same command scripts/packageApp.mjs runs after wrapping the binary.
    codesign("codesign", ["--force", "--sign", "-", bundlePath], { stdio: "pipe" });
  } catch {
    /* best effort — a fresh unsigned binary still runs when launched locally */
  }
}

// In-place binary swap: rename the temp file over the target (atomic on POSIX;
// the still-running image keeps the old inode). Windows additionally needs the
// old file unlinked first (rename cannot overwrite an existing file).
function replaceBinaryInPlace(
  execPath,
  tempPath,
  { platform = process.platform, unlink = fs.unlinkSync, rename = fs.renameSync } = {},
) {
  if (platform === "win32") {
    try {
      unlink(execPath);
    } catch {
      /* may not exist */
    }
  }
  rename(tempPath, execPath);
}

// PowerShell single-quote escaping for baking paths/argv into script text.
function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// The PowerShell half of the Windows restart helper: wait until the parent's
// image stops being "in use", retry the move, relaunch in a new console window.
// Lives in a `.ps1` file rather than a `-Command` string so the app's argv never
// passes through cmd's quoting (a `"` or `%` in an argument would otherwise
// mangle or abort the line). The UTF-8 BOM makes PowerShell 5.1 read the file as
// UTF-8 instead of the system codepage, so non-ASCII paths survive.
//
// Notes on the shape that PowerShell 5.1 accepts (the Windows default is still
// 5.1 everywhere except explicit pwsh installs):
//  - The for-increment clause MUST be `$i++` — a bare `i++` parses as a command
//    invocation ("The term 'i++' is not recognized as a name of a cmdlet").
//  - `$ok` stays numeric 0/1 so no bare true/false token can land in command
//    position.
//  - `} catch {` stays on the same line as the try; 5.1 is pickier about catch
//    placement than pwsh 7.
//  - `-ErrorAction Stop` on Move-Item so the access-denied failure actually
//    reaches catch (default is a non-throwing WriteError for file ops).
//  - `-LiteralPath ... -Destination ...` on Move-Item so a path containing
//    `* ? [ ] + ( )` never becomes a PS glob (a `Move-Item -Force src dst`
//    positional form on a Desktop path with parens was silently glob-matching
//    and reporting "not found", which the user's report looked exactly like —
//    retries all failing, .tmp removed, original .exe untouched).
//  - Wait on `Get-Process -Id $parentPid` instead of a fixed sleep, since
//    Defender's on-access scan or Explorer's icon cache can keep the running
//    .exe image mapped for longer than 750 ms after Node exits.
//  - `Start-Process` in try/catch, with `explorer.exe $exe` as the fallback
//    launch: SmartScreen can make CreateProcess fail for a freshly written
//    unsigned binary, and Explorer's open action surfaces the SmartScreen
//    "Windows Protected Your PC / Run anyway" prompt so the user can complete
//    the update with one click-through — the same interaction a manual
//    download already requires.
function buildWindowsHandoffScript(execPath, tempPath, argv, parentPid = process.pid) {
  const quoted = (argv || []).map(powershellQuote);
  const startProcessCall = quoted.length
    ? `Start-Process -FilePath $exe -ArgumentList ${quoted.join(", ")} -ErrorAction Stop`
    : `Start-Process -FilePath $exe -ErrorAction Stop`;
  const launchBlock = `try { ${startProcessCall} } catch { Write-Host "Start-Process failed: $($_.Exception.Message)"; explorer.exe $exe }`;
  const lines = [
    // Bake the paths once as PS variables so every later line stays short and
    // no shell-level quoting is involved; single quotes preserve backslashes
    // literally, and powershellQuote doubles any apostrophe in a path.
    `$parentPid = ${parentPid}`,
    `$exe = ${powershellQuote(execPath)}`,
    `$src = ${powershellQuote(tempPath)}`,
    // Wait for the parent Node PID to actually exit (up to ~20 s), so the
    // retry below does not burn its whole budget against a still-in-use image
    // when Node's cleanup is slow or the OS still holds the mapped image.
    // The Write-Host goes BEFORE the loop so the cmd window is not blank while
    // waiting (the user's 1.1.8/1.1.9 test sat on an empty window for seconds).
    "Write-Host 'Waiting for the app to exit and Windows to release the running .exe image...'",
    "$waited = 0",
    "while (Get-Process -Id $parentPid -ErrorAction Ignore) { Start-Sleep -Milliseconds 200; $waited = $waited + 1; if ($waited -gt 100) { break } }",
    // 60 retries * 500 ms = 30 s of move retries. Windows can hold the .exe
    // image open longer than the earlier 20 * 500 ms covered when Defender or
    // Explorer's icon cache had touched the file after a SmartScreen-flagged
    // download, which is what the user saw as the cmd window sitting open for
    // "a while" and then everything disappearing.
    "$ok = 0",
    "for ($i = 0; $i -lt 60; $i++) {",
    `  try { Move-Item -LiteralPath $src -Destination $exe -Force -ErrorAction Stop; $ok = 1; break } catch { Write-Host "Try $i of 60 failed: $($_.Exception.Message)"; Start-Sleep -Milliseconds 500 }`,
    "}",
    // On Move-Item failure, do NOT delete the downloaded .tmp — leaving the new
    // binary beside the old one so the user can rename it manually is strictly
    // better than losing the update they just paid for, and printing the paths
    // means the message survives a window-close (they can screenshot or scroll
    // back through the visible cmd-window lines above).
    `if ($ok) { Write-Host 'Binary replaced. Relaunching in a new console...'; ${launchBlock} } else { Write-Host "Could not replace the running .exe. Close this window, rename $src to $exe (keep the .exe name), then double-click it; Windows shows the SmartScreen 'Run anyway' prompt if it does not start on its own." }`,
  ];
  // No cleanup here: the .cmd wrapper deletes both helper files only after
  // powershell.exe has exited, which is the safe point to unlink the script.
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

// The cmd wrapper Explorer launches. `%~f0` is the .cmd's own path, so the
// `.ps1` name (its path + ".ps1") and the cleanup lines never bake a possibly
// non-ASCII path into a file cmd reads as ANSI. cmd waits for powershell.exe to
// exit before deleting, so the .ps1 is never pulled out from under the runner.
// The leading echoes print before powershell.exe even cold-starts (~1 s), so
// the window is never blank the moment Explorer opens it — the blank-window
// "hang" the user saw in the 1.1.8/1.1.9 tests came from that cold start.
function buildWindowsHandoffCmd() {
  return [
    "@echo off",
    "echo Dance Game Twitch Requests is updating. Do NOT close this window.",
    "echo It waits for Windows to release the running app, replaces the .exe,",
    "echo then starts the new version in a new window and cleans up after itself.",
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~f0.ps1"',
    'del "%~f0.ps1" >nul 2>&1',
    'del "%~f0" >nul 2>&1',
  ].join("\r\n");
}

// Synchronous wait via PowerShell (only used on the Windows retry path; tests
// inject a fake). `spawnSync` injectable.
function sleepSync(ms, { spawnSync = childProcess.spawnSync } = {}) {
  if (ms <= 0) return;
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Start-Sleep -Milliseconds ${Math.round(ms)}`],
    { stdio: "ignore" },
  );
}

// Windows deferred takeover: the in-place replace was refused while the image
// is running, so hand the move off to a restart helper that (1) waits for the
// parent to exit, (2) retries the move until the image stops being "in use",
// and (3) relaunches the app with the original argv in a fresh console window.
// The helper is staged as a `.cmd` + `.ps1` pair beside the binary (same folder
// we already proved writable, since the downloaded temp binary lives there) and
// started with `explorer.exe`, which detaches it into a new console window.
// Returns 0 — the parent must exit immediately (the old app stops running).
function deferredWindowsTakeover(
  execPath,
  tempPath,
  argv,
  {
    detachedSpawn = childProcess.spawn,
    writeFile = fs.writeFileSync,
    pid = process.pid,
    log = console.log,
    warn = console.error,
  } = {},
) {
  log(
    "Could not replace the running .exe while it was executing; restarting with the new version in a new window…",
  );
  const helperCmdPath = `${execPath}.update-${pid}.cmd`;
  const helperPs1Path = `${helperCmdPath}.ps1`;
  try {
    writeFile(helperPs1Path, buildWindowsHandoffScript(execPath, tempPath, argv, pid));
    writeFile(helperCmdPath, buildWindowsHandoffCmd());
  } catch (err) {
    // Nothing can be spawned; leave the downloaded binary where it is and say
    // so, rather than silently deleting the new version the user asked for.
    warn(
      `Could not stage the Windows restart helper: ${err.message}. The ${tempPath} file holds the new version — close this app, replace ${execPath} with it (keep the .exe name), then start it again.`,
    );
    return 0;
  }
  // explorer.exe, not a direct spawn: the child needs its own console, or
  // Explorer closing the parent's window when the app exits kills it (see the
  // file header). explorer itself exits immediately; the .cmd keeps running.
  detachedSpawn("explorer.exe", [helperCmdPath], { detached: true, stdio: "ignore" });
  return 0;
}

// Replace the running binary with the new bytes, then re-exec it with the
// original argv. Returns the child's exit code (or 0 for the deferred Windows
// takeover, where the detached helper runs the app). All I/O injectable for
// tests.
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
    newVersion = null,
    read = fs.readFileSync,
    write = fs.writeFileSync,
    codesign = childProcess.spawnSync,
    spawnSync = childProcess.spawnSync,
    detachedSpawn = childProcess.spawn,
    log = console.log,
    warn = console.error,
    retries = 3,
    retryDelayMs = 250,
  } = {},
) {
  // Write the new binary to a temp file beside the target, then rename over it
  // (atomic; the still-running image keeps the old inode).
  const tempPath = `${execPath}.update-${pid}.tmp`;
  writeFile(tempPath, newBinaryBuffer);
  try {
    if (platform !== "win32") {
      chmod(tempPath, 0o755);
    }
  } catch {
    /* chmod is a no-op on Windows */
  }

  // POSIX rename-over usually succeeds while running; Windows may outright
  // refuse while the image lives, so retry a few times before the deferred
  // fallback (short waits cover transient handles, e.g. Explorer's).
  let replaced = false;
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) sleepSync(retryDelayMs, { spawnSync });
    try {
      replaceBinaryInPlace(execPath, tempPath, { platform, unlink, rename });
      replaced = true;
      break;
    } catch (err) {
      lastError = err;
      if (platform !== "win32") break;
    }
  }

  if (!replaced) {
    if (platform !== "win32") {
      try {
        rm(tempPath, { force: true });
      } catch {
        /* ignore */
      }
      throw new Error(`Could not replace the app binary: ${lastError.message}`);
    }
    return deferredWindowsTakeover(execPath, tempPath, argv, {
      detachedSpawn: spawn,
      writeFile,
      pid,
      log,
      warn,
    });
  }

  restampMacAppBundle(execPath, newVersion, { platform, read, write, codesign });

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
    platform = process.platform,
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

  if (platform === "win32") {
    // Windows often refuses to replace the .exe of the *running* app, which
    // routes the update through the deferred helper: this app exits, and a
    // separate cmd window does the move + relaunch. Cold PowerShell start and
    // the image-release wait make that window look stuck for several seconds,
    // so warn *before* consent — once the user says Y they must not close it.
    log(
      "Heads-up for Windows: replacing a running .exe is usually refused, so this app may " +
        "exit and a separate command-prompt window will finish the update. That window can " +
        "look blank or stuck for several seconds (it is waiting for Windows to release the " +
        "running copy) - that is normal. Do NOT close it mid-update, or the new binary is " +
        "left half-staged; it relaunches the app in a new window and cleans up after itself.",
    );
  }

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
  const exitCode = await perform(newBinary, execPath, argv, { newVersion: planned.latestVersion });
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
  macAppBundlePath,
  patchInfoPlistVersions,
  restampMacAppBundle,
  replaceBinaryInPlace,
  powershellQuote,
  sleepSync,
  buildWindowsHandoffScript,
  buildWindowsHandoffCmd,
  deferredWindowsTakeover,
  performUpdate,
  planUpdate,
  maybeUpdate,
};
