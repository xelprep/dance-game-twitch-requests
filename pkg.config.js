// Build configuration for @yao-pkg/pkg (the maintained fork of vercel/pkg).
//
// This file is evaluated on the build host, so we can select the native
// payloads that match the host's platform/arch. The release workflow builds
// every target on a *matched* runner (no cross-compilation), so the host
// platform always equals the target platform and these globs select exactly
// the native binaries the resulting executable needs — no dead weight for
// other platforms.
//
// Why the explicit native globs:
//  - better-sqlite3 resolves its prebuild with a dynamic require() that the
//    static walker cannot see, so the host's prebuild is listed explicitly.
//  - sharp's .node is walker-detected, but its libvips dylib/so/dll is only
//    referenced via require.resolve(); we include the whole host @img package
//    so the dynamic loader (rpath) finds libvips next to the extracted addon.
//
// Why Enhanced SEA mode (sea: true):
//  - The setup wizard (setupTui.mjs) is ESM and is driven from start.js via a
//    dynamic import(). Standard (patched-runtime) mode has no dynamic import
//    callback, so that fails; Enhanced SEA runs on stock Node.js with the real
//    ESM loader, so dynamic import() works on every target.
//  - Stock, signed Node.js binaries (no pkg-fetch patched fork), faster
//    builds, and working cross-compilation. This app is open source, so the
//    one thing SEA gives up (V8 bytecode source protection) is not needed.
const platform = process.platform; // "darwin" | "linux" | "win32"
const arch = process.arch; // "x64" | "arm64"

// sharp and better-sqlite3 both name their per-platform payloads
// "<platform>-<arch>" (using "win32" for Windows), which matches
// `${process.platform}-${process.arch}` directly.
const nativePlatform = `${platform}-${arch}`;

module.exports = {
  // Package with stock Node.js (Single Executable Applications) instead of the
  // patched pkg-fetch runtime. See the note above for why.
  sea: true,
  // Stock Node is a larger base than the patched runtime; per-file GZip
  // compression brings the executable back down to a reasonable download size.
  compress: "Brotli",
  targets: [
    "node24-macos-arm64",
    "node24-macos-x64",
    "node24-win-x64",
    "node24-win-arm64",
    "node24-linux-x64",
    "node24-linux-arm64",
  ],
  assets: [
    // Static web UIs served from the snapshot via __dirname-relative paths.
    "public/**/*",
    "control/**/*",
    // Native payloads for the host platform only.
    `node_modules/better-sqlite3/prebuilds/${nativePlatform}.node`,
    `node_modules/@img/sharp-${nativePlatform}/**/*`,
    `node_modules/@img/sharp-libvips-${nativePlatform}/**/*`,
  ],
  outputPath: "dist",
  ignore: [
    "test/**",
    "localdev/**",
    "docs/**",
    "**/*.md",
    "**/node_modules/*/test/**",
    "**/node_modules/*/tests/**",
    "**/node_modules/*/docs/**",
    "**/node_modules/*/example/**",
    "**/node_modules/*/examples/**",
  ],
};
