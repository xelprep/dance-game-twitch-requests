process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

async function loadPackageApp() {
  return import("../../scripts/packageApp.mjs");
}

test("buildInfoPlist emits a valid macOS bundle plist", async () => {
  const { buildInfoPlist } = await loadPackageApp();
  const plist = buildInfoPlist({ executable: "dance-game-twitch-requests", version: "1.2.3" });

  assert.match(plist, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>dance-game-twitch-requests<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>com\.dancegame\.twitchrequests<\/string>/);
  assert.match(plist, /<key>CFBundlePackageType<\/key>\s*<string>APPL<\/string>/);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>1\.2\.3<\/string>/);
  assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>icon<\/string>/);
  assert.match(plist, /<key>LSMinimumSystemVersion<\/key>\s*<string>13\.0<\/string>/);
  // CFBundleName and CFBundleDisplayName default to the app name.
  assert.match(plist, /<key>CFBundleName<\/key>\s*<string>Dance Game Twitch Requests<\/string>/);
});

test("buildDesktopEntry emits a freedesktop entry with Terminal=true", async () => {
  const { buildDesktopEntry } = await loadPackageApp();
  const entry = buildDesktopEntry({ binaryName: "dance-game-twitch-requests" });

  assert.match(entry, /^\[Desktop Entry\]/m);
  assert.match(entry, /^Type=Application$/m);
  assert.match(entry, /^Name=Dance Game Twitch Requests$/m);
  assert.match(entry, /^Exec=dance-game-twitch-requests$/m);
  assert.match(entry, /^Icon=dance-game-twitch-requests$/m);
  assert.match(entry, /^Terminal=true$/m);
  assert.match(entry, /^Categories=AudioVideo;Network;$/m);
});

test("buildInstallSh installs to per-user locations without root", async () => {
  const { buildInstallSh } = await loadPackageApp();
  const script = buildInstallSh({ binaryName: "dance-game-twitch-requests" });

  assert.match(script, /^#!\/usr\/bin\/env bash/m);
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /APP_NAME="dance-game-twitch-requests"/);
  // Copies the binary, icon, and .desktop to the standard per-user locations.
  assert.match(script, /cp "\$SCRIPT_DIR\/\$APP_NAME" "\$HOME\/\.local\/bin\/\$APP_NAME"/);
  assert.match(script, /cp "\$SCRIPT_DIR\/icon\.png" "\$HOME\/\.local\/share\/icons\/hicolor\/512x512\/apps\/\$APP_NAME\.png"/);
  assert.match(script, /cp "\$SCRIPT_DIR\/\$APP_NAME\.desktop" "\$HOME\/\.local\/share\/applications\/\$APP_NAME\.desktop"/);
  // Best-effort desktop database refresh.
  assert.match(script, /update-desktop-database/);
  // No sudo anywhere.
  assert.doesNotMatch(script, /sudo/);
});
