#!/usr/bin/env node
// Post-build hook for the Windows executable: rewrite the PE "Version Info"
// resource so the file-properties dialog shows the app's name and version
// instead of the stock Node.js values, and embed the app icon (assets/icon.ico)
// so it stops looking like a generic Node executable.
//
// Why a hook and not pkg config: we build in Enhanced SEA mode (sea: true), so
// pkg wraps the *stock* node.exe and postject-injects the app into it. pkg has
// no option to set the Windows version info or icon, so we post-process the
// produced .exe with resedit (a pure-JS PE editor; the rcedit alternative is
// deprecated and Electron now recommends resedit).
//
// This is invoked by scripts/packageApp.mjs (the pkg `postBuild` dispatcher) on
// Windows, and can also be run directly with the output path in PKG_OUTPUT. It
// is a no-op for non-Windows outputs, so the same hook is safe on the
// macOS/Linux build jobs.
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
import { fileURLToPath } from "node:url";
import * as PELibrary from "pe-library";
import * as ResEdit from "resedit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LANG = 1033; // en-US
const CODEPAGE = 1200; // Unicode
const ICON_PATH = path.join(__dirname, "..", "assets", "icon.ico");

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

// Embed the app icon (assets/icon.ico) into the PE resource section, replacing
// the stock Node icon group in place (matching its id + lang) so the exe shows
// our icon in Explorer. resedit writes both the RT_ICON_GROUP directory and the
// individual RT_ICON entries.
let iconCount = 0;
if (fs.existsSync(ICON_PATH)) {
  const icoFile = ResEdit.Data.IconFile.from(fs.readFileSync(ICON_PATH));
  const icons = icoFile.icons.map((item) => item.data);
  const existingGroups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const existing = existingGroups[0];
  const iconGroupID = existing ? existing.id : 1;
  const iconLang = existing ? existing.lang : LANG;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    iconGroupID,
    iconLang,
    icons,
  );
  iconCount = icons.length;
} else {
  log(`No ${ICON_PATH} found; skipping the icon embed.`);
}

// Commit the modified resource entries back into the exe object so that
// exe.generate() serializes them (without this, generate() emits the original
// resources and the round-trip below reads back the stock "Node.js" values).
res.outputResource(exe);

// Write the modified exe to a temp file in the same directory, verify it
// round-trips, then copy it over the original output path.
const tmp = path.join(path.dirname(output), `${path.basename(output)}.tmp`);
fs.writeFileSync(tmp, Buffer.from(exe.generate()));

// --- 2. Round-trip: confirm the version strings were written ---
const checkExe = PELibrary.NtExecutable.from(fs.readFileSync(tmp), { ignoreCert: true });
const checkRes = PELibrary.NtExecutableResource.from(checkExe);
const checkVi = ResEdit.Resource.VersionInfo.fromEntries(checkRes.entries)[0];
const written = checkVi.getStringValues({ lang: LANG, codepage: CODEPAGE });
if (written.ProductName !== productName || written.FileDescription !== fileDescription) {
  fs.rmSync(tmp, { force: true });
  fail(`round-trip verification failed (got ProductName=${JSON.stringify(written.ProductName)})`);
}
if (iconCount > 0) {
  const checkGroups = ResEdit.Resource.IconGroupEntry.fromEntries(checkRes.entries);
  const checkGroup = checkGroups.find((group) => group.icons.length > 0);
  if (!checkGroup || checkGroup.icons.length !== iconCount) {
    fs.rmSync(tmp, { force: true });
    fail(`icon round-trip verification failed (expected ${iconCount} icons)`);
  }
}

fs.copyFileSync(tmp, output);
fs.rmSync(tmp, { force: true });
const after = fs.statSync(output).size;
log(
  `Set version ${pkg.version} + product "${productName}"` +
    (iconCount ? ` + ${iconCount}-size icon` : "") +
    ` on ${path.basename(output)} (${before} -> ${after} bytes).`,
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
