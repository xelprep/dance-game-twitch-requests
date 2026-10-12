#!/usr/bin/env node
// Post-build hook for the Windows executable: rewrite the PE "Version Info"
// resource so the file-properties dialog shows the app's name and version
// instead of the stock Node.js values ("Node.js JavaScript Runtime" and Node's
// own version number).
//
// Why a hook and not pkg config: we build in Enhanced SEA mode (sea: true), so
// pkg wraps the *stock* node.exe and postject-injects the app into it. pkg has
// no option to set the Windows version info, so we post-process the produced
// .exe with resedit (a pure-JS PE editor; the rcedit alternative is deprecated
// and Electron now recommends resedit).
//
// This runs once per produced binary via pkg's `postBuild` (shell form, so the
// just-written path arrives in the PKG_OUTPUT env var). It is a no-op for
// non-Windows outputs, so the same hook is safe on the macOS/Linux build jobs.
//
// Two verifications run after the rewrite:
//   1. Round-trip: re-parse the modified exe and confirm the version strings
//      were actually written.
//   2. Smoke test: actually run the modified exe. Non-interactive (no TTY) with
//      no .env, the app prints "App setup is incomplete" and exits 1 *before*
//      loading any native module. If the SEA blob (the postject-injected
//      resource) survived resedit, the exe boots and prints that message; if
//      resedit corrupted it, the exe fails to start. This is the resedit x SEA
//      gate from the app-bundles plan. Set SKIP_SMOKE_TEST=1 to skip it.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as PELibrary from "pe-library";
import * as ResEdit from "resedit";

const LANG = 1033; // en-US
const CODEPAGE = 1200; // Unicode

function log(message) {
  console.log(`[windows-version-info] ${message}`);
}

function fail(message) {
  console.error(`[windows-version-info] ERROR: ${message}`);
  process.exit(1);
}

const output = process.env.PKG_OUTPUT;
if (!output) {
  log("PKG_OUTPUT not set; nothing to do.");
  process.exit(0);
}
if (!output.toLowerCase().endsWith(".exe")) {
  log(`Not a Windows .exe (${path.basename(output)}); skipping.`);
  process.exit(0);
}

// --- App version + identity (single source of truth: package.json) ---
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const versionParts = String(pkg.version)
  .split(".")
  .map((part) => parseInt(part, 10) || 0);
const version = {
  major: versionParts[0] ?? 0,
  minor: versionParts[1] ?? 0,
  micro: versionParts[2] ?? 0,
  revision: 0,
};
const productName = "Dance Game Twitch Requests";
const fileDescription = "Dance Game Twitch Requests";
const legalCopyright = `Copyright (c) ${new Date().getFullYear()} Dance Game Twitch Requests`;

// --- 1. Rewrite the version info resource with resedit ---
// ignoreCert: the stock node.exe is Authenticode-signed; postject already
// invalidated that signature, and resedit emits an unsigned binary either way.
const before = fs.statSync(output).size;
const exe = PELibrary.NtExecutable.from(fs.readFileSync(output), { ignoreCert: true });
const res = PELibrary.NtExecutableResource.from(exe);
const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (viList.length === 0) fail("no version-info resource found in the executable");
const vi = viList[0];
vi.setFileVersion(version.major, version.minor, version.micro, version.revision, LANG);
vi.setProductVersion(version.major, version.minor, version.micro, version.revision, LANG);
vi.setStringValues(
  { lang: LANG, codepage: CODEPAGE },
  { FileDescription: fileDescription, ProductName: productName, LegalCopyright: legalCopyright },
);
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);

// resedit recommends writing to a different file than the source, so emit to a
// temp file and copy it over the original.
const tmp = `${output}.tmp`;
fs.writeFileSync(tmp, Buffer.from(exe.generate()));

// --- 2. Round-trip: confirm the version strings were written ---
const checkExe = PELibrary.NtExecutable.from(fs.readFileSync(tmp), { ignoreCert: true });
const checkVi = ResEdit.Resource.VersionInfo.fromEntries(
  PELibrary.NtExecutableResource.from(checkExe).entries,
)[0];
const written = checkVi.getStringValues({ lang: LANG, codepage: CODEPAGE });
if (written.ProductName !== productName || written.FileDescription !== fileDescription) {
  fs.rmSync(tmp, { force: true });
  fail(`round-trip verification failed (got ProductName=${JSON.stringify(written.ProductName)})`);
}

fs.copyFileSync(tmp, output);
fs.rmSync(tmp, { force: true });
const after = fs.statSync(output).size;
log(
  `Set version ${pkg.version} + product "${productName}" on ${path.basename(output)} ` +
    `(${before} -> ${after} bytes).`,
);

// --- 3. Smoke test: run the modified exe to confirm the SEA blob survived ---
if (process.env.SKIP_SMOKE_TEST === "1") {
  log("SKIP_SMOKE_TEST=1; skipping the boot smoke test.");
  process.exit(0);
}
// Point APP_DATA_DIR at a throwaway temp dir so the test never touches the real
// home directory. The exe creates nothing else on this path and exits before
// loading native modules, so startup is fast.
const smokeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dgr-smoke-"));
const smoke = spawnSync(output, [], {
  env: { ...process.env, APP_DATA_DIR: smokeDataDir },
  encoding: "utf8",
  timeout: 60000,
  windowsHide: true,
});
fs.rmSync(smokeDataDir, { recursive: true, force: true });
const smokeOutput = `${smoke.stdout ?? ""}\n${smoke.stderr ?? ""}`;
if (smoke.error || !smokeOutput.includes("App setup is incomplete")) {
  console.error(
    "[windows-version-info] ERROR: smoke test failed — the modified exe did not boot as expected.",
  );
  console.error(`--- exe output ---\n${smokeOutput}\n------------------`);
  if (smoke.error) console.error(`spawn error: ${smoke.error.message}`);
  process.exit(1);
}
log("Smoke test passed — the modified exe boots (SEA blob intact).");
