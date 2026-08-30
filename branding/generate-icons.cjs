// Regenerates all raster assets (PNG sizes + Windows .ico) from sparkii-icon.svg.
// Requires `sharp` to be resolvable (run with NODE_PATH pointing at a node_modules
// that contains sharp, or install sharp locally).
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const dir = __dirname;
const svgPath = path.join(dir, 'sparkii-icon.svg');

const PNG_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 180, 192, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function icoHeader(count) {
  const b = Buffer.alloc(6);
  b.writeUInt16LE(0, 0); // reserved
  b.writeUInt16LE(1, 2); // type: icon
  b.writeUInt16LE(count, 4);
  return b;
}

function icoEntry(width, height, size, offset) {
  const b = Buffer.alloc(16);
  b.writeUInt8(width >= 256 ? 0 : width, 0);
  b.writeUInt8(height >= 256 ? 0 : height, 1);
  b.writeUInt8(0, 2); // color count
  b.writeUInt8(0, 3); // reserved
  b.writeUInt16LE(1, 4); // planes
  b.writeUInt16LE(32, 6); // bit count
  b.writeUInt32LE(size, 8);
  b.writeUInt32LE(offset, 12);
  return b;
}

async function main() {
  const svg = fs.readFileSync(svgPath);
  // Rasterize the 512-unit viewBox at 2048px so every smaller size is a downscale.
  const master = await sharp(svg, { density: 288 }).resize(2048, 2048).png().toBuffer();

  const pngByName = new Map();
  for (const size of PNG_SIZES) {
    const buf = await sharp(master).resize(size, size).png().toBuffer();
    const file = path.join(dir, `sparkii-icon-${size}.png`);
    fs.writeFileSync(file, buf);
    pngByName.set(size, buf);
    console.log(`wrote ${path.basename(file)}`);
  }

  const entries = [];
  let offset = 6 + ICO_SIZES.length * 16;
  for (const size of ICO_SIZES) {
    const buf = pngByName.get(size);
    entries.push({ size, entry: icoEntry(size, size, buf.length, offset), buf });
    offset += buf.length;
  }

  const ico = Buffer.concat([
    icoHeader(ICO_SIZES.length),
    ...entries.map((e) => e.entry),
    ...entries.map((e) => e.buf),
  ]);
  const icoFile = path.join(dir, 'sparkii.ico');
  fs.writeFileSync(icoFile, ico);
  console.log(`wrote sparkii.ico (${ICO_SIZES.join(', ')}px)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
