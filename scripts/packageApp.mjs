#!/usr/bin/env node
// pkg `postBuild` dispatcher: post-process the just-written binary per platform.
// pkg has no icon or .app support, so this runs once per produced binary (the
// output path arrives in the PKG_OUTPUT env var) and branches on the host
// platform. Every build runs on a *matched* runner (and local builds run on the
// dev's own OS), so the host always has the tools the branch needs.
//
//   - macOS:   wrap the binary in a real .app bundle (Info.plist, PkgInfo,
//              Resources/icon.icns), remove the bare binary, and ad-hoc
//              codesign the bundle.
//   - Windows: delegate to setWindowsVersionInfo.mjs (version info + icon embed
//              + the resedit x SEA boot smoke test).
//   - Linux:   write a freedesktop .desktop entry, icon.png, and install.sh
//              next to the binary.
//
// The pure generators (buildInfoPlist, buildDesktopEntry, buildInstallSh) are
// exported so they can be unit-tested without running the pipeline.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = "Dance Game Twitch Requests";
const BUNDLE_IDENTIFIER = "com.dancegame.twitchrequests";
// Must match the `bin` key in package.json (the name pkg gives the output).
const BINARY_NAME = "dance-game-twitch-requests";
// Oldest macOS the Node 24 runtime supports; shown as the bundle's floor.
const MIN_MACOS = "13.0";

function log(message) {
  console.log(`[packageApp] ${message}`);
}

function fail(message) {
  console.error(`[packageApp] ERROR: ${message}`);
  process.exit(1);
}

// --- Pure generators (unit-testable) ---

// Generate the macOS bundle Info.plist. `executable` must exactly match the
// file name placed in Contents/MacOS/.
export function buildInfoPlist({
  name = APP_NAME,
  executable,
  identifier = BUNDLE_IDENTIFIER,
  version,
  minSystemVersion = MIN_MACOS,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleName</key>
\t<string>${name}</string>
\t<key>CFBundleDisplayName</key>
\t<string>${name}</string>
\t<key>CFBundleExecutable</key>
\t<string>${executable}</string>
\t<key>CFBundleIdentifier</key>
\t<string>${identifier}</string>
\t<key>CFBundlePackageType</key>
\t<string>APPL</string>
\t<key>CFBundleShortVersionString</key>
\t<string>${version}</string>
\t<key>CFBundleVersion</key>
\t<string>${version}</string>
\t<key>CFBundleIconFile</key>
\t<string>icon</string>
\t<key>LSMinimumSystemVersion</key>
\t<string>${minSystemVersion}</string>
</dict>
</plist>
`;
}

// Generate the freedesktop .desktop entry. `Terminal=true` gives Windows-console
// parity: the DE opens the user's terminal and runs the app inside it, so closing
// the window kills the app.
export function buildDesktopEntry({ binaryName = BINARY_NAME, name = APP_NAME }) {
  return `[Desktop Entry]
Type=Application
Name=${name}
Comment=Twitch chat song request bot with web queue
Exec=${binaryName}
Icon=${binaryName}
Terminal=true
Categories=AudioVideo;Network;
`;
}

// Generate the per-user install.sh (no root required; idempotent).
export function buildInstallSh({ binaryName = BINARY_NAME, name = APP_NAME }) {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    `APP_NAME="${binaryName}"`,
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    "",
    `echo "Installing ${name}…"`,
    "",
    "# 1. Binary -> ~/.local/bin",
    'mkdir -p "$HOME/.local/bin"',
    'cp "$SCRIPT_DIR/$APP_NAME" "$HOME/.local/bin/$APP_NAME"',
    'chmod +x "$HOME/.local/bin/$APP_NAME"',
    'case ":$PATH:" in',
    '  *":$HOME/.local/bin:"*) ;;',
    "  *) echo \"Note: add $HOME/.local/bin to your PATH to run '$APP_NAME' from the terminal.\" ;;",
    "esac",
    "",
    "# 2. Icon -> ~/.local/share/icons/hicolor/512x512/apps",
    'mkdir -p "$HOME/.local/share/icons/hicolor/512x512/apps"',
    'cp "$SCRIPT_DIR/icon.png" "$HOME/.local/share/icons/hicolor/512x512/apps/$APP_NAME.png"',
    "",
    "# 3. .desktop -> ~/.local/share/applications",
    'mkdir -p "$HOME/.local/share/applications"',
    'cp "$SCRIPT_DIR/$APP_NAME.desktop" "$HOME/.local/share/applications/$APP_NAME.desktop"',
    "",
    "# 4. update-desktop-database (best-effort)",
    "if command -v update-desktop-database >/dev/null 2>&1; then",
    '  update-desktop-database "$HOME/.local/share/applications" || true',
    "fi",
    "",
    'echo ""',
    'echo "Installed. Next steps:"',
    `echo "  - The app appears in your application menu as '${name}'."`,
    "echo \"  - On GNOME, the first launch may be marked 'Untrusted launcher' — right-click it and choose 'Allow Launching'.\"",
    'echo "  - Double-clicking opens a terminal window running the app; closing it stops the app."',
    "",
  ].join("\n");
}

// --- Platform post-processors ---

// Launch smoke test: run the just-built binary non-interactively against a
// throwaway data dir. With no TTY and no .env, start.js prints "App setup is
// incomplete" to stderr and exits non-zero *before* loading any native module.
// If the binary boots and prints that message, the SEA blob (and, on macOS,
// the executable bit + ad-hoc signature) survived packaging. If packaging
// corrupted it, the binary fails to start. Set SKIP_SMOKE_TEST=1 to skip.
function runLaunchSmokeTest(binaryPath) {
  if (process.env.SKIP_SMOKE_TEST === "1") {
    log("SKIP_SMOKE_TEST=1; skipping the launch smoke test.");
    return;
  }
  const smokeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dgr-smoke-"));
  const smoke = spawnSync(binaryPath, [], {
    env: { ...process.env, APP_DATA_DIR: smokeDataDir },
    encoding: "utf8",
    timeout: 60000,
  });
  fs.rmSync(smokeDataDir, { recursive: true, force: true });
  const smokeOutput = `${smoke.stdout ?? ""}\n${smoke.stderr ?? ""}`;
  if (smoke.error || !smokeOutput.includes("App setup is incomplete")) {
    console.error(
      "[packageApp] ERROR: launch smoke test failed — the built binary did not boot as expected.",
    );
    console.error(`--- binary output ---\n${smokeOutput}\n------------------`);
    if (smoke.error) console.error(`spawn error: ${smoke.error.message}`);
    process.exit(1);
  }
  log("Launch smoke test passed — the built binary boots (SEA blob intact).");
}

function wrapMacApp(binaryPath) {
  const distDir = path.dirname(binaryPath);
  const executableName = path.basename(binaryPath);
  const appPath = path.join(distDir, `${APP_NAME}.app`);
  const contentsDir = path.join(appPath, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");

  fs.rmSync(appPath, { recursive: true, force: true });
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  // Move the bare binary into the bundle (CFBundleExecutable must match this).
  const bundledBinary = path.join(macosDir, executableName);
  fs.renameSync(binaryPath, bundledBinary);

  // Ensure the executable bit is set. pkg does not reliably preserve it on the
  // produced binary, and without it macOS refuses to launch the app (the user
  // has to `chmod +x` the nested binary by hand).
  fs.chmodSync(bundledBinary, 0o755);

  // Copy the icon.
  const iconSrc = path.join(__dirname, "..", "assets", "icon.icns");
  if (fs.existsSync(iconSrc)) fs.copyFileSync(iconSrc, path.join(resourcesDir, "icon.icns"));

  // Info.plist + PkgInfo.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  fs.writeFileSync(
    path.join(contentsDir, "Info.plist"),
    buildInfoPlist({ executable: executableName, version: pkg.version }),
    "utf8",
  );
  fs.writeFileSync(path.join(contentsDir, "PkgInfo"), "APPL????", "utf8");

  // Ad-hoc codesign the bundle (signs the nested binary too; supersedes pkg's
  // earlier ad-hoc signature).
  const result = spawnSync("codesign", ["--force", "--sign", "-", appPath], { stdio: "pipe" });
  if (result.error || result.status !== 0) {
    fail(
      `codesign failed: ${result.stderr ? result.stderr.toString().trim() : result.error.message}`,
    );
  }
  log(`Created ${APP_NAME}.app and ad-hoc signed it.`);

  // Boot the final signed, executable bundle binary to confirm it launches.
  runLaunchSmokeTest(bundledBinary);
}

function writeLinuxDesktop(binaryPath) {
  const distDir = path.dirname(binaryPath);
  const binaryName = path.basename(binaryPath);

  fs.writeFileSync(
    path.join(distDir, `${binaryName}.desktop`),
    buildDesktopEntry({ binaryName }),
    "utf8",
  );

  const iconSrc = path.join(__dirname, "..", "assets", "icon.png");
  if (fs.existsSync(iconSrc)) fs.copyFileSync(iconSrc, path.join(distDir, "icon.png"));

  fs.writeFileSync(path.join(distDir, "install.sh"), buildInstallSh({ binaryName }), {
    mode: 0o755,
  });

  log(`Wrote ${binaryName}.desktop, icon.png, and install.sh.`);

  // Boot the built binary to confirm it launches.
  runLaunchSmokeTest(binaryPath);
}

function runWindowsPostBuild(binaryPath) {
  // Delegate to the Windows-specific script (version info + icon + smoke test).
  const script = path.join(__dirname, "setWindowsVersionInfo.mjs");
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, PKG_OUTPUT: binaryPath },
    stdio: "inherit",
  });
  if (result.error) fail(`failed to run ${script}: ${result.error.message}`);
  if (result.status !== 0) fail(`Windows post-build failed (exit ${result.status})`);
}

// --- Main (only when run directly, not when imported by tests) ---
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const output = process.env.PKG_OUTPUT;
  if (!output) {
    log("PKG_OUTPUT not set; nothing to do.");
    process.exit(0);
  }
  if (process.platform === "darwin") {
    wrapMacApp(output);
  } else if (process.platform === "win32") {
    runWindowsPostBuild(output);
  } else if (process.platform === "linux") {
    writeLinuxDesktop(output);
  } else {
    log(`No post-processing for ${process.platform}.`);
  }
}
