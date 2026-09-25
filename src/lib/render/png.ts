import { deflateSync, inflateSync } from 'node:zlib';
import { crc32 } from './crc32';
import { glyph } from './font5x7';

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode an 8-bit grayscale bitmap as PNG, with optional tEXt chunks. */
export function encodeGrayPng(width: number, height: number, pixels: Uint8Array, text: Record<string, string> = {}): Buffer {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const texts = Object.entries(text).map(([k, v]) => chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...texts,
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Read tEXt chunks and dimensions from a PNG. Returns null if it is not a PNG. */
export function readPngText(buf: Buffer): { width: number; height: number; text: Record<string, string> } | null {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const text: Record<string, string> = {};
  let width = 0;
  let height = 0;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === 'tEXt' || type === 'zTXt') {
      const nul = data.indexOf(0);
      const key = data.toString('latin1', 0, nul);
      text[key] = type === 'tEXt' ? data.toString('latin1', nul + 1) : inflateSync(data.subarray(nul + 2)).toString('latin1');
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return { width, height, text };
}

export interface RasterLine { text: string; invert?: boolean; rule?: boolean }

/**
 * Draw lines of text like a thermal printer would. Each character is the 5x7
 * glyph scaled up, on off-white paper with a little noise so it does not
 * look like a screenshot.
 */
export function rasterizeReceipt(lines: RasterLine[], opts: { cols?: number; scale?: number; seed?: number } = {}): { width: number; height: number; pixels: Uint8Array } {
  const cols = opts.cols ?? 34;
  const scale = opts.scale ?? 2;
  const cw = 6 * scale;
  const lh = 11 * scale;
  const pad = 14 * scale;
  const width = cols * cw + pad * 2;
  const height = lines.length * lh + pad * 2;
  const px = new Uint8Array(width * height);
  let seed = opts.seed ?? 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < px.length; i += 1) px[i] = 246 + Math.floor(rnd() * 8);

  const ink = (x: number, y: number, v: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) px[y * width + x] = v;
  };

  lines.forEach((line, row) => {
    const top = pad + row * lh;
    if (line.invert) {
      for (let y = top - 2 * scale; y < top + 9 * scale; y += 1) for (let x = pad - 4 * scale; x < width - pad + 4 * scale; x += 1) ink(x, y, 34);
    }
    if (line.rule) {
      for (let x = pad; x < width - pad; x += 1) if (Math.floor(x / (3 * scale)) % 2 === 0) for (let t = 0; t < scale; t += 1) ink(x, top + 4 * scale + t, 90);
      return;
    }
    const text = line.text.slice(0, cols);
    [...text].forEach((ch, i) => {
      const g = glyph(ch);
      const left = pad + i * cw;
      for (let gy = 0; gy < 7; gy += 1) {
        for (let gx = 0; gx < 5; gx += 1) {
          if (!g[gy][gx]) continue;
          const shade = line.invert ? 250 : 28 + Math.floor(rnd() * 40);
          for (let sy = 0; sy < scale; sy += 1) for (let sx = 0; sx < scale; sx += 1) ink(left + gx * scale + sx, top + gy * scale + sy, shade);
        }
      }
    });
  });
  return { width, height, pixels: px };
}
