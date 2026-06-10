// Generate app/favicon.ico from the brand source app/icon.svg.
//
// App Router already auto-serves app/icon.svg (modern browsers, crisp SVG) and
// app/apple-icon.png. But browsers — and bookmarks, history entries, and some
// embedded contexts — request /favicon.ico by default; without app/favicon.ico
// that 404s and they fall back to the generic globe icon (and the dev server
// logs a GET /favicon.ico 404 on every start). This packs the same brand glyph
// into a legacy .ico so /favicon.ico returns 200 everywhere.
//
// icon.svg is the single source of truth; re-run this after editing it:
//   (cd board && npm run gen:favicon)
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app");
const svg = readFileSync(join(appDir, "icon.svg"));

// The classic favicon sizes. Render the 28-unit SVG at high density first so each
// downscale is crisp, then emit one PNG per size.
const sizes = [16, 32, 48];
const pngs = await Promise.all(
  sizes.map((s) =>
    sharp(svg, { density: 384 }).resize(s, s, { fit: "contain" }).png().toBuffer(),
  ),
);

// ICO container = 6-byte ICONDIR header + one 16-byte ICONDIRENTRY per image +
// the (PNG-encoded) image data. PNG-in-ICO is supported by every modern browser.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = icon
header.writeUInt16LE(sizes.length, 4); // image count

const dir = Buffer.alloc(16 * sizes.length);
let offset = header.length + dir.length;
pngs.forEach((png, i) => {
  const s = sizes[i];
  const e = i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, e + 0); // width  (0 means 256)
  dir.writeUInt8(s >= 256 ? 0 : s, e + 1); // height (0 means 256)
  dir.writeUInt8(0, e + 2); // color palette (0 = none)
  dir.writeUInt8(0, e + 3); // reserved
  dir.writeUInt16LE(1, e + 4); // color planes
  dir.writeUInt16LE(32, e + 6); // bits per pixel
  dir.writeUInt32LE(png.length, e + 8); // image data size
  dir.writeUInt32LE(offset, e + 12); // image data offset
  offset += png.length;
});

const out = join(appDir, "favicon.ico");
writeFileSync(out, Buffer.concat([header, dir, ...pngs]));
console.log(`wrote ${out} (${sizes.join("/")}px, ${offset} bytes)`);
