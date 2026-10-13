process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The icon helpers live in an ESM module; import it lazily so the CJS test can
// use them without loading sharp (the pipeline lazy-loads sharp in main()).
async function loadIcons() {
  return import("../../scripts/generateIcons.mjs");
}

// A solid RGBA buffer (top-down), as sharp's .raw() would produce.
function solidRgba(width, height, r, g, b, a) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

test("buildIco writes a valid ICO header and directory", async () => {
  const { buildIco } = await loadIcons();
  const png256 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const bmp16 = Buffer.alloc(100); // opaque content; only length matters here

  const ico = buildIco([
    { size: 16, data: bmp16 },
    { size: 256, data: png256 },
  ]);

  // ICONDIR header.
  assert.equal(ico.readUInt16LE(0), 0, "reserved must be 0");
  assert.equal(ico.readUInt16LE(2), 1, "type must be 1 (icon)");
  assert.equal(ico.readUInt16LE(4), 2, "image count");

  // Entry 0 (16x16): directory at offset 6.
  assert.equal(ico.readUInt8(6), 16, "width");
  assert.equal(ico.readUInt8(7), 16, "height");
  assert.equal(ico.readUInt8(8), 0, "color count");
  assert.equal(ico.readUInt16LE(10), 1, "planes");
  assert.equal(ico.readUInt16LE(12), 32, "bits per pixel");
  assert.equal(ico.readUInt32LE(14), bmp16.length, "bytes in res");
  const offset0 = ico.readUInt32LE(18);
  assert.equal(offset0, 6 + 2 * 16, "data starts after the directory");

  // Entry 1 (256): 0 in the directory means 256.
  const e1 = 6 + 16;
  assert.equal(ico.readUInt8(e1), 0, "256 width encoded as 0");
  assert.equal(ico.readUInt8(e1 + 1), 0, "256 height encoded as 0");
  const offset1 = ico.readUInt32LE(e1 + 12);
  assert.ok(
    ico.subarray(offset1, offset1 + 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    "256 entry must be PNG-compressed",
  );

  // Total size = header + directory + all image data.
  assert.equal(ico.length, 6 + 2 * 16 + bmp16.length + png256.length);
});

test("rgbaToBmpDib emits a 32-bit BITMAPINFOHEADER with bottom-up BGRA pixels", async () => {
  const { rgbaToBmpDib } = await loadIcons();

  // 2x2 image: top row red, bottom row blue.
  const rgba = Buffer.alloc(2 * 2 * 4);
  const set = (x, y, r, g, b, a) => {
    const i = (y * 2 + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  };
  set(0, 0, 255, 0, 0, 255); // top-left red
  set(1, 0, 255, 0, 0, 255); // top-right red
  set(0, 1, 0, 0, 255, 255); // bottom-left blue
  set(1, 1, 0, 0, 255, 255); // bottom-right blue

  const dib = rgbaToBmpDib(2, 2, rgba);

  // BITMAPINFOHEADER.
  assert.equal(dib.readUInt32LE(0), 40, "biSize");
  assert.equal(dib.readInt32LE(4), 2, "biWidth");
  assert.equal(dib.readInt32LE(8), 4, "biHeight is 2x (XOR + AND mask)");
  assert.equal(dib.readUInt16LE(12), 1, "biPlanes");
  assert.equal(dib.readUInt16LE(14), 32, "biBitCount");
  assert.equal(dib.readUInt32LE(16), 0, "biCompression (BI_RGB)");
  assert.equal(dib.readUInt32LE(20), 16, "biSizeImage (2*2*4)");

  // Pixel data starts at offset 40, bottom-up, BGRA.
  // File row 0 = image bottom row (blue) -> BGRA (255,0,0,255).
  assert.deepEqual([...dib.subarray(40, 44)], [255, 0, 0, 255], "bottom-left blue as BGRA");
  assert.deepEqual([...dib.subarray(44, 48)], [255, 0, 0, 255], "bottom-right blue as BGRA");
  // File row 1 = image top row (red) -> BGRA (0,0,255,255).
  assert.deepEqual([...dib.subarray(48, 52)], [0, 0, 255, 255], "top-left red as BGRA");
  assert.deepEqual([...dib.subarray(52, 56)], [0, 0, 255, 255], "top-right red as BGRA");

  // AND mask: 1 bit/px, rows padded to 4 bytes -> ceil(2/8)=1 -> 4 bytes/row * 2 = 8.
  assert.equal(dib.length, 40 + 16 + 8, "header + pixels + AND mask");
  assert.ok(
    dib.subarray(56).every((b) => b === 0),
    "AND mask is all zero",
  );
});

test("validateMasterPng accepts the 1024x1024 master and rejects bad input", async (t) => {
  const { validateMasterPng } = await loadIcons();
  const sharp = (await import("sharp")).default;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dgr-icon-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // The committed master is a valid 1024x1024 PNG.
  const master = path.join(__dirname, "..", "..", "assets", "icon.png");
  const meta = await validateMasterPng(sharp, master);
  assert.equal(meta.width, 1024);
  assert.equal(meta.height, 1024);

  // Wrong dimensions.
  const small = path.join(tmp, "small.png");
  await sharp({
    create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toFile(small);
  await assert.rejects(() => validateMasterPng(sharp, small), /1024x1024/);

  // Not a PNG.
  const notPng = path.join(tmp, "notpng.png");
  fs.writeFileSync(notPng, "this is not a png", "utf8");
  await assert.rejects(() => validateMasterPng(sharp, notPng), /must be a (readable )?PNG/);

  // Missing file.
  await assert.rejects(() => validateMasterPng(sharp, path.join(tmp, "nope.png")), /not found/);
});
