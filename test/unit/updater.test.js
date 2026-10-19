process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const path = require("node:path");
const {
  targetFor,
  compareVersions,
  isCompiledBinary,
  hasTty,
  parseConfirmAnswer,
  confirmUpdate,
  pickAsset,
  extractZipEntry,
  performUpdate,
  planUpdate,
  maybeUpdate,
} = require("../../updater.cjs");

function makeStoredZip(name, contents) {
  const nameBuffer = Buffer.from(name, "utf8");
  const dataBuffer = Buffer.from(contents, "utf8");
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt16LE(0x4b4b, 0);
  localHeader.writeUInt16LE(0x0403, 2);
  localHeader[4] = 0x14;
  localHeader[5] = 0x00;
  localHeader.writeUInt32LE(0, 6);
  localHeader.writeUInt32LE(0, 10);
  localHeader.writeUInt32LE(dataBuffer.length, 18);
  localHeader.writeUInt32LE(dataBuffer.length, 22);
  localHeader.writeUInt16LE(nameBuffer.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt16LE(0x4b4b, 0);
  centralHeader.writeUInt16LE(0x0201, 2);
  centralHeader[4] = 0x14;
  centralHeader[5] = 0x00;
  centralHeader.writeUInt32LE(0, 6);
  centralHeader.writeUInt32LE(0, 10);
  centralHeader.writeUInt32LE(0, 14);
  centralHeader.writeUInt16LE(0, 22);
  centralHeader.writeUInt32LE(dataBuffer.length, 20);
  centralHeader.writeUInt32LE(dataBuffer.length, 24);
  centralHeader.writeUInt16LE(nameBuffer.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt16LE(0x4b4b, 0);
  eocd.writeUInt16LE(0x0605, 2);
  eocd[4] = 0x00;
  eocd[5] = 0x00;
  eocd[6] = 0x00;
  eocd[7] = 0x00;
  eocd[8] = 0x01;
  eocd[9] = 0x00;
  eocd.writeUInt16LE(46, 10);
  eocd.writeUInt32LE(30 + nameBuffer.length + dataBuffer.length, 12);
  eocd[20] = 0x00;
  eocd[21] = 0x00;

  return Buffer.concat([localHeader, nameBuffer, dataBuffer, centralHeader, nameBuffer, eocd]);
}

function makeDeflateZip(name, contents) {
  const nameBuffer = Buffer.from(name, "utf8");
  const contentsBuffer = Buffer.from(contents, "utf8");
  const dataBuffer = zlib.deflateRawSync(contentsBuffer);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt16LE(0x4b4b, 0);
  localHeader.writeUInt16LE(0x0403, 2);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(8, 10);
  localHeader.writeUInt32LE(0, 12);
  localHeader.writeUInt32LE(dataBuffer.length, 18);
  localHeader.writeUInt32LE(contentsBuffer.length, 22);
  localHeader.writeUInt16LE(nameBuffer.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt16LE(0x4b4b, 0);
  centralHeader.writeUInt16LE(0x0201, 2);
  centralHeader[4] = 0x14;
  centralHeader[5] = 0x00;
  centralHeader.writeUInt32LE(0, 6);
  centralHeader.writeUInt32LE(0, 10);
  centralHeader.writeUInt32LE(0, 14);
  centralHeader.writeUInt16LE(0, 22);
  centralHeader.writeUInt32LE(dataBuffer.length, 20);
  centralHeader.writeUInt32LE(contentsBuffer.length, 24);
  centralHeader.writeUInt16LE(nameBuffer.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt16LE(0x4b4b, 0);
  eocd.writeUInt16LE(0x0605, 2);
  eocd[4] = 0x00;
  eocd[5] = 0x00;
  eocd[6] = 0x00;
  eocd[7] = 0x00;
  eocd[8] = 0x01;
  eocd[9] = 0x00;
  eocd.writeUInt16LE(46, 10);
  eocd.writeUInt32LE(30 + nameBuffer.length + dataBuffer.length, 12);
  eocd[20] = 0x00;
  eocd[21] = 0x00;

  return Buffer.concat([localHeader, nameBuffer, dataBuffer, centralHeader, nameBuffer, eocd]);
}

test("targetFor maps platform/arch to release asset targets", () => {
  assert.deepEqual(targetFor("darwin", "arm64"), { os: "macos", arch: "arm64" });
  assert.deepEqual(targetFor("win32", "x64"), { os: "windows", arch: "x64" });
  assert.deepEqual(targetFor("linux", "ia32"), { os: "linux", arch: "x64" });
});

test("compareVersions handles v prefixes, missing parts, and ordering", () => {
  assert.equal(compareVersions("v1.0.12", "1.0.13"), -1);
  assert.equal(compareVersions("1.10.0", "1.2.9"), 1);
  assert.equal(compareVersions("v2.0", "2.0.0"), 0);
});

test("compiled and tty gates expose their injectable conditions", () => {
  assert.equal(isCompiledBinary(false), false);
  assert.equal(isCompiledBinary(true), true);
  assert.equal(hasTty({ isTTY: false }, { isTTY: false }), false);
  assert.equal(hasTty({ isTTY: false }, { isTTY: true }), true);
});

test("parseConfirmAnswer accepts empty, yes, and yes-case variants only", () => {
  assert.equal(parseConfirmAnswer(""), true);
  assert.equal(parseConfirmAnswer("Y"), true);
  assert.equal(parseConfirmAnswer("yes"), true);
  assert.equal(parseConfirmAnswer("no"), false);
  assert.equal(parseConfirmAnswer("maybe"), false);
});

test("confirmUpdate is covered through parseConfirmAnswer", () => {
  assert.equal(parseConfirmAnswer("YES"), true);
});

test("pickAsset chooses the current platform/arch asset", () => {
  const target = targetFor("darwin", "arm64");
  const asset = pickAsset(
    [
      {
        name: "dance-game-twitch-requests-1.0.13-windows-x64.zip",
        browser_download_url: "https://windows",
      },
      {
        name: "dance-game-twitch-requests-1.0.13-macos-arm64.zip",
        browser_download_url: "https://macos",
      },
    ],
    target,
  );
  assert.equal(asset.name, "dance-game-twitch-requests-1.0.13-macos-arm64.zip");
  assert.equal(asset.browser_download_url, "https://macos");
});

test("extractZipEntry rejects invalid archives", () => {
  try {
    extractZipEntry(Buffer.from("no zip"), "dance-game-twitch-requests");
    throw new Error("should have thrown");
  } catch (err) {
    assert.match(err.message, /not a valid zip archive/);
  }
});

test("extractZipEntry handles real zip archives", async () => {
  const childProcess = require("node:child_process");
  const os = require("node:os");
  const fs = require("node:fs");
  const tmp = fs.mkdtempSync(`${os.tmpdir()}/dgr-zip-`);
  try {
    const songDir = `${tmp}/bin`;
    fs.mkdirSync(songDir);
    fs.writeFileSync(`${songDir}/dance-game-twitch-requests`, "new-binary");
    const zipPath = `${tmp}/archive.zip`;
    const zip = childProcess.spawnSync("zip", ["-r", zipPath, "bin/dance-game-twitch-requests"], {
      cwd: tmp,
    });
    assert.equal(zip.status, 0);
    assert.equal(zip.signal, null);
    const archive = fs.readFileSync(zipPath);
    const extracted = extractZipEntry(archive, "dance-game-twitch-requests");
    assert.equal(Buffer.compare(extracted, Buffer.from("new-binary")), 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("planUpdate compares releases and selects current assets", async () => {
  const result = await planUpdate("1.0.13", {
    owner: "xelprep",
    repo: "dance-game-twitch-requests",
    fetch: () => ({
      json: {
        tag_name: "v1.0.14",
        assets: [
          {
            name: "dance-game-twitch-requests-1.0.14-macos-arm64.zip",
            browser_download_url: "https://download",
          },
        ],
      },
    }),
    targetOverride: { os: "macos", arch: "arm64" },
  });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latestVersion, "1.0.14");
  assert.equal(result.asset.browser_download_url, "https://download");
});

test("planUpdate reports no update when already current", async () => {
  const result = await planUpdate("1.0.14", {
    owner: "xelprep",
    repo: "dance-game-twitch-requests",
    fetch: () => ({
      json: {
        tag_name: "v1.0.14",
        assets: [
          {
            name: "dance-game-twitch-requests-1.0.14-macos-arm64.zip",
            browser_download_url: "https://download",
          },
        ],
      },
    }),
    targetOverride: { os: "macos", arch: "arm64" },
  });
  assert.equal(result.updateAvailable, false);
});

test("performUpdate renames a temp binary and spawns the new executable", async () => {
  const calls = [];
  const exitCode = await performUpdate(
    Buffer.from("new-binary"),
    "/app/dance-game-twitch-requests",
    ["--no-scan"],
    {
      platform: "linux",
      pid: 123,
      writeFile(path, buffer) {
        calls.push({ type: "write", path, buffer });
      },
      chmod(path, mode) {
        calls.push({ type: "chmod", path, mode });
      },
      rename(path) {
        calls.push({ type: "rename", path });
      },
      spawn(execPath, args) {
        calls.push({ type: "spawn", execPath, args });
        return { exitCode: 7 };
      },
    },
  );

  assert.equal(exitCode, 7);
  assert.equal(calls[0].type, "write");
  assert.equal(calls[0].path, "/app/dance-game-twitch-requests.update-123.tmp");
  assert.equal(Buffer.compare(calls[0].buffer, Buffer.from("new-binary")), 0);
  assert.equal(calls[1].type, "chmod");
  assert.equal(calls[1].mode, 0o755);
  assert.equal(calls[2].type, "rename");
  assert.equal(calls[2].path, "/app/dance-game-twitch-requests.update-123.tmp");
  assert.deepEqual(calls[3].args, ["--no-scan"]);
});

test("maybeUpdate skips non-compiled source runs without forcing", async () => {
  const result = await maybeUpdate("1.0.13", { compiled: false });
  assert.deepEqual(result, { skipped: "not-compiled" });
});

test("maybeUpdate forces git guidance for source runs", async () => {
  const warnings = [];
  const result = await maybeUpdate("1.0.13", {
    compiled: false,
    force: true,
    warn(message) {
      warnings.push(message);
    },
  });
  assert.equal(result.skipped, "not-compiled");
  assert.equal(result.exitCode, 1);
  assert.match(warnings[0], /only available for the standalone binary/);
});

test("maybeUpdate skips headless non-forced updates without contacting GitHub", async () => {
  let contacted = false;
  const result = await maybeUpdate("1.0.13", {
    compiled: true,
    force: false,
    tty: false,
    plan() {
      contacted = true;
      return { error: "should not run" };
    },
  });
  assert.deepEqual(result, { skipped: "no-tty" });
  assert.equal(contacted, false);
});

test("maybeUpdate continues app startup when no newer release exists", async () => {
  const logs = [];
  const result = await maybeUpdate("1.0.14", {
    compiled: true,
    force: true,
    tty: true,
    plan: () => ({
      currentVersion: "1.0.14",
      latestVersion: "1.0.14",
      target: { os: "macos", arch: "arm64" },
      asset: null,
      updateAvailable: false,
    }),
    log(message) {
      logs.push(message);
    },
  });
  assert.deepEqual(result, { skipped: "up-to-date", latestVersion: "1.0.14" });
  assert.match(logs.join("\n"), /Already on the latest version/);
});

function makeRealZip() {
  const childProcess = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const tmp = fs.mkdtempSync(`${os.tmpdir()}/dgr-maybe-update-zip-`);
  try {
    fs.mkdirSync(`${tmp}/bin`);
    fs.writeFileSync(`${tmp}/bin/dance-game-twitch-requests`, "new-binary");
    const zipPath = `${tmp}/archive.zip`;
    const zip = childProcess.spawnSync("zip", ["-r", zipPath, "bin/dance-game-twitch-requests"], {
      cwd: tmp,
    });
    assert.equal(zip.status, 0);
    assert.equal(zip.signal, null);
    return fs.readFileSync(zipPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("maybeUpdate downloads, extracts, replaces, and restarts a binary", async () => {
  const zip = makeRealZip();
  let wrotePath = null;
  let renamedPath = null;
  let spawnedPath = null;
  const result = await maybeUpdate("1.0.13", {
    compiled: true,
    force: true,
    tty: true,
    execPath: "/app/dance-game-twitch-requests",
    argv: ["--no-scan"],
    pid: 123,
    plan: () => ({
      currentVersion: "1.0.13",
      latestVersion: "1.0.14",
      target: { os: "linux", arch: "x64" },
      asset: { browser_download_url: "https://download" },
      updateAvailable: true,
    }),
    download: () => ({ buffer: zip }),
    extract: (archive, basename) => extractZipEntry(archive, basename),
    perform: async (newBinary, execPath, args) => {
      const exitCode = await performUpdate(newBinary, execPath, args, {
        platform: "linux",
        pid: 123,
        writeFile(path, buffer) {
          wrotePath = path;
        },
        chmod() {},
        unlink() {},
        rm() {},
        rename(path) {
          renamedPath = path;
        },
        spawn(exec, childArgs) {
          spawnedPath = exec;
          return { exitCode: 0 };
        },
      });
      return exitCode;
    },
  });

  assert.deepEqual(result, { updated: true, latestVersion: "1.0.14", exitCode: 0 });
  assert.equal(wrotePath, "/app/dance-game-twitch-requests.update-123.tmp");
  assert.equal(renamedPath, "/app/dance-game-twitch-requests.update-123.tmp");
  assert.equal(spawnedPath, "/app/dance-game-twitch-requests");
});
