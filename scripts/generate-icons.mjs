import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

const BACKGROUND = [10, 10, 20];
const MARK = [155, 240, 70];
const WHITE = [255, 255, 255];

const GLYPH = [
  "01100110",
  "11111111",
  "11111111",
  "11111111",
  "01111110",
  "00111100",
  "00011000",
  "00000000"
];

function renderIcon(size, { paddingRatio, background, mark }) {
  const pixels = Buffer.alloc(size * size * 4);
  if (background) {
    for (let i = 0; i < size * size; i += 1) {
      pixels[i * 4] = background[0];
      pixels[i * 4 + 1] = background[1];
      pixels[i * 4 + 2] = background[2];
      pixels[i * 4 + 3] = 255;
    }
  }

  const pad = Math.round(size * paddingRatio);
  const inner = size - pad * 2;
  const cell = inner / GLYPH.length;

  for (let gy = 0; gy < GLYPH.length; gy += 1) {
    for (let gx = 0; gx < GLYPH.length; gx += 1) {
      if (GLYPH[gy][gx] !== "1") {
        continue;
      }

      const x0 = Math.round(pad + gx * cell);
      const x1 = Math.round(pad + (gx + 1) * cell);
      const y0 = Math.round(pad + gy * cell);
      const y1 = Math.round(pad + (gy + 1) * cell);
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const idx = (y * size + x) * 4;
          pixels[idx] = mark[0];
          pixels[idx + 1] = mark[1];
          pixels[idx + 2] = mark[2];
          pixels[idx + 3] = 255;
        }
      }
    }
  }

  return encodePng(size, size, pixels);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

mkdirSync(publicDir, { recursive: true });
writeFileSync(join(publicDir, "icon-192.png"), renderIcon(192, { paddingRatio: 0.12, background: BACKGROUND, mark: MARK }));
writeFileSync(join(publicDir, "icon-512.png"), renderIcon(512, { paddingRatio: 0.12, background: BACKGROUND, mark: MARK }));
writeFileSync(join(publicDir, "icon-maskable-512.png"), renderIcon(512, { paddingRatio: 0.22, background: BACKGROUND, mark: MARK }));
writeFileSync(join(publicDir, "icon-badge.png"), renderIcon(96, { paddingRatio: 0.1, background: null, mark: WHITE }));

console.log("Generated icon-192.png, icon-512.png, icon-maskable-512.png, icon-badge.png in public/");
