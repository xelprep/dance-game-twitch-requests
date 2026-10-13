#!/usr/bin/env node
// Regenerates the platform icon files from the single master artwork:
//   assets/icon.png  ->  assets/icon.ico  (Windows, multi-size container)
//   assets/icon.png  ->  assets/icon.icns (macOS, via iconutil; macOS-only)
//
// The master is a 1024x1024 PNG. This script validates it, then:
//   - .ico: pure Node. `sharp` resizes to each target size; a small ICO/BMP
//     container writer (buildIco / rgbaToBmpDib) assembles the file. The 256
//     entry is PNG-compressed per the ICO spec; smaller entries are 32-bit
//     BMP DIBs. Runs on any OS.
//   - .icns: builds an .iconset (16/32/128/256/512 + @2x) with `sharp`, then
//     packs it with `iconutil -c icns`. iconutil is macOS-only, so on other
//     hosts this step prints a note and is skipped (exit 0) — the committed
//     icon.icns is regenerated on a Mac.
//
// Run with: npm run icons   (or: node scripts/generateIcons.mjs)
//
// The pure container helpers (buildIco, rgbaToBmpDib, validateMasterPng) are
// exported so they can be unit-tested without running the full pipeline.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const MASTER_PNG = path.join(ASSETS_DIR, "icon.png");
const ICO_PATH = path.join(ASSETS_DIR, "icon.ico");
const ICNS_PATH = path.join(ASSETS_DIR, "icon.icns");

// Sizes embedded in the .ico container, smallest to largest. The 256 entry is
// stored PNG-compressed; the rest are 32-bit BMP DIBs.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// .iconset entries for macOS. Each maps a filename to the pixel size to render.
const ICONSET_ENTRIES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

function log(message) {
  console.log(`[icons] ${message}`);
}

function fail(message) {
  console.error(`[icons] ERROR: ${message}`);
  process.exit(1);
}

// --- Pure ICO container helpers (unit-testable) ---

// Assemble an ICO container from a list of image entries.
// entries: [{ size, data }] where `data` is the raw image bytes for that size
// (a PNG buffer for the 256 entry, a 32-bit BMP DIB buffer for the others).
// Returns the complete ICO file as a Buffer.
export function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved (must be 0)
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(count, 4); // image count

  const dirOffset = 6;
  const dirSize = 16 * count;
  const dataOffset = dirOffset + dirSize;

  const dir = Buffer.alloc(dirSize);
  const chunks = [];
  let offset = dataOffset;
  for (let i = 0; i < count; i += 1) {
    const { size, data } = entries[i];
    // 0 in the directory means 256.
    const dim = size >= 256 ? 0 : size;
    dir.writeUInt8(dim, i * 16 + 0); // width
    dir.writeUInt8(dim, i * 16 + 1); // height
    dir.writeUInt8(0, i * 16 + 2); // color count (0 = as many as needed)
    dir.writeUInt8(0, i * 16 + 3); // reserved
    dir.writeUInt16LE(1, i * 16 + 4); // color planes
    dir.writeUInt16LE(32, i * 16 + 6); // bits per pixel
    dir.writeUInt32LE(data.length, i * 16 + 8); // size of image data
    dir.writeUInt32LE(offset, i * 16 + 12); // offset of image data
    chunks.push(data);
    offset += data.length;
  }
  return Buffer.concat([header, dir, ...chunks]);
}

// Convert a top-down RGBA buffer (as produced by sharp's .raw()) into a 32-bit
// BMP DIB suitable for an ICO entry: BITMAPINFOHEADER + bottom-up BGRA pixels
// + an all-zero AND mask (the alpha channel carries transparency).
export function rgbaToBmpDib(width, height, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(width, 4); // biWidth
  header.writeInt32LE(height * 2, 8); // biHeight (XOR data + AND mask)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression (BI_RGB)
  const pixelDataSize = width * height * 4;
  header.writeUInt32LE(pixelDataSize, 20); // biSizeImage
  // biXPelsPerMeter / biYPelsPerMeter / biClrUsed / biClrImportant stay 0.

  const pixels = Buffer.alloc(pixelDataSize);
  for (let y = 0; y < height; y += 1) {
    const srcRow = y; // sharp: top-down
    const dstRow = height - 1 - y; // BMP: bottom-up
    for (let x = 0; x < width; x += 1) {
      const si = (srcRow * width + x) * 4;
      const di = (dstRow * width + x) * 4;
      pixels[di + 0] = rgba[si + 2]; // B
      pixels[di + 1] = rgba[si + 1]; // G
      pixels[di + 2] = rgba[si + 0]; // R
      pixels[di + 3] = rgba[si + 3]; // A
    }
  }

  // AND mask: 1 bit per pixel, each row padded to a 4-byte boundary. All zero
  // for 32-bit icons (alpha handles transparency).
  const andRowBytes = Math.ceil(width / 8);
  const andPaddedRow = Math.ceil(andRowBytes / 4) * 4;
  const andMask = Buffer.alloc(andPaddedRow * height);

  return Buffer.concat([header, pixels, andMask]);
}

// Validate the master PNG: must be a PNG and exactly 1024x1024.
// `sharp` is passed in (lazy-loaded) so importing this module never loads it.
export async function validateMasterPng(sharp, pngPath = MASTER_PNG) {
  if (!fs.existsSync(pngPath)) {
    throw new Error(`Master icon not found at ${pngPath}. Add a 1024x1024 PNG there first.`);
  }
  let meta;
  try {
    meta = await sharp(pngPath).metadata();
  } catch (err) {
    throw new Error(`icon.png must be a readable PNG (${err.message}).`);
  }
  if (meta.format !== "png") {
    throw new Error(`icon.png must be a PNG (got ${meta.format}).`);
  }
  if (meta.width !== 1024 || meta.height !== 1024) {
    throw new Error(`icon.png must be 1024x1024 (got ${meta.width}x${meta.height}).`);
  }
  return meta;
}

// --- Pipeline ---

async function buildIcoFile(sharp) {
  const entries = [];
  for (const size of ICO_SIZES) {
    if (size === 256) {
      // PNG-compressed entry (per the ICO spec for 256px images).
      const data = await sharp(MASTER_PNG).resize(256, 256).png().toBuffer();
      entries.push({ size, data });
    } else {
      const { data, info } = await sharp(MASTER_PNG)
        .resize(size, size)
        .raw()
        .toBuffer({ resolveWithObject: true });
      entries.push({ size, data: rgbaToBmpDib(info.width, info.height, data) });
    }
  }
  fs.writeFileSync(ICO_PATH, buildIco(entries));
  log(`Wrote ${ICO_PATH} (${ICO_SIZES.length} sizes: ${ICO_SIZES.join("/")}).`);
}

async function buildIcnsFile(sharp) {
  if (process.platform !== "darwin") {
    log("Skipping icon.icns: iconutil is macOS-only. Run this on a Mac to regenerate it.");
    return;
  }
  // iconutil requires the input directory to be named "*.iconset".
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "dgr-iconset-"));
  const iconset = path.join(tmpBase, "AppIcon.iconset");
  fs.mkdirSync(iconset);
  try {
    for (const [name, size] of ICONSET_ENTRIES) {
      await sharp(MASTER_PNG).resize(size, size).png().toFile(path.join(iconset, name));
    }
    const result = spawnSync("iconutil", ["-c", "icns", iconset, "-o", ICNS_PATH], {
      stdio: "pipe",
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `iconutil failed: ${result.stderr ? result.stderr.toString().trim() : result.error.message}`,
      );
    }
    log(`Wrote ${ICNS_PATH}.`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

async function main() {
  const sharp = (await import("sharp")).default;
  await validateMasterPng(sharp);
  await buildIcoFile(sharp);
  await buildIcnsFile(sharp);
  log("Done.");
}

// Run the pipeline only when executed directly (not when imported by tests).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => fail(err.message));
}
