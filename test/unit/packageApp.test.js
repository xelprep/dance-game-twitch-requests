process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function loadPackageApp() {
  return import("../../scripts/packageApp.mjs");
}

test("buildInfoPlist emits a valid macOS bundle plist", async () => {
  const { buildInfoPlist } = await loadPackageApp();
  const plist = buildInfoPlist({ executable: "dance-game-twitch-requests", version: "1.2.3" });

  assert.match(plist, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(
    plist,
    /<key>CFBundleExecutable<\/key>\s*<string>dance-game-twitch-requests<\/string>/,
  );
  assert.match(
    plist,
    /<key>CFBundleIdentifier<\/key>\s*<string>com\.dancegame\.twitchrequests<\/string>/,
  );
  assert.match(plist, /<key>CFBundlePackageType<\/key>\s*<string>APPL<\/string>/);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>1\.2\.3<\/string>/);
  assert.match(plist, /<key>CFBundleIconName<\/key>\s*<string>AppIcon<\/string>/);
  assert.doesNotMatch(plist, /<key>CFBundleIconFile<\/key>/);
  assert.match(plist, /<key>LSMinimumSystemVersion<\/key>\s*<string>13\.0<\/string>/);
  // CFBundleName and CFBundleDisplayName default to the app name.
  assert.match(plist, /<key>CFBundleName<\/key>\s*<string>Dance Game Twitch Requests<\/string>/);
});

test("compileMacAssetsCar compiles the Icon Composer document", async (t) => {
  const { compileMacAssetsCar } = await loadPackageApp();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dgr-package-icon-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const iconComposerPath = path.join(__dirname, "..", "..", "assets", "AppIcon.icon");
  const appResourcesDir = path.join(tempDir, "Resources");
  let partialPlistPath;
  const run = (command, args, options) => {
    assert.equal(command, "xcrun");
    assert.deepEqual(options, { stdio: "pipe" });
    assert.equal(args[0], "actool");
    assert.equal(args[1], iconComposerPath);
    assert.equal(args[args.indexOf("--compile") + 1], appResourcesDir);
    assert.equal(args[args.indexOf("--platform") + 1], "macosx");
    assert.equal(args[args.indexOf("--target-device") + 1], "mac");
    assert.equal(args[args.indexOf("--minimum-deployment-target") + 1], "13.0");
    assert.equal(args[args.indexOf("--app-icon") + 1], "AppIcon");
    assert.ok(args.includes("--include-all-app-icons"));
    assert.deepEqual(
      args.slice(
        args.indexOf("--enable-on-demand-resources"),
        args.indexOf("--enable-on-demand-resources") + 2,
      ),
      ["--enable-on-demand-resources", "NO"],
    );
    assert.equal(args[args.indexOf("--development-region") + 1], "en");
    assert.ok(
      fs.existsSync(path.join(iconComposerPath, "Assets", "icon.png")),
      "the Icon Composer document includes its image layer",
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(iconComposerPath, "icon.json"), "utf8")).fill,
      { solid: "extended-srgb:0.82745,0.82745,0.82745,1.00000" },
      "the Icon Composer document uses the chosen light-gray background",
    );
    partialPlistPath = args[args.indexOf("--output-partial-info-plist") + 1];
    fs.writeFileSync(partialPlistPath, "partial");
    fs.writeFileSync(path.join(appResourcesDir, "Assets.car"), "compiled");
    return { error: null, status: 0, stderr: Buffer.alloc(0) };
  };

  assert.equal(
    await compileMacAssetsCar({ iconComposerPath, appResourcesDir, platform: "darwin", run }),
    true,
  );
  assert.equal(fs.readFileSync(path.join(appResourcesDir, "Assets.car"), "utf8"), "compiled");
  assert.equal(fs.existsSync(partialPlistPath), false, "temporary plist output is removed");
});

test("compileMacAssetsCar skips actool on non-macOS platforms", async () => {
  const { compileMacAssetsCar } = await loadPackageApp();
  assert.equal(
    await compileMacAssetsCar({
      iconComposerPath: "unused.icon",
      appResourcesDir: "unused",
      platform: "linux",
      run: () => assert.fail("actool should not run outside macOS"),
    }),
    false,
  );
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
  assert.match(
    script,
    /cp "\$SCRIPT_DIR\/icon\.png" "\$HOME\/\.local\/share\/icons\/hicolor\/512x512\/apps\/\$APP_NAME\.png"/,
  );
  assert.match(
    script,
    /cp "\$SCRIPT_DIR\/\$APP_NAME\.desktop" "\$HOME\/\.local\/share\/applications\/\$APP_NAME\.desktop"/,
  );
  // Best-effort desktop database refresh.
  assert.match(script, /update-desktop-database/);
  // No sudo anywhere.
  assert.doesNotMatch(script, /sudo/);
});
