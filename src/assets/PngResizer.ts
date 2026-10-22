import * as zlib from "node:zlib";
import { JevError } from "../core/JevError.js";

export interface SizeLimits {
  imageSideMin: number;
  imageSideMax: number;
  imagePixelsMin: number;
  imagePixelsMax: number;
  /** Largest declared source the resizer decodes (no huge allocations). */
  resizeSourcePixelsMax: number;
}

interface Decoded {
  width: number;
  height: number;
  channels: number;
  colorType: number;
  pixels: Buffer;
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Client-side resize: the API rejects images outside 280-1568 px per side
 * or 78,400-2,458,624 pixels and never resizes. 8-bit, non-interlaced PNGs (gray, RGB,
 * gray+alpha, RGBA) are rescaled with nearest-neighbour sampling to fit; other PNGs and all
 * JPEGs out of range are refused with a fix, since no image library is bundled.
 */
export class PngResizer {
  /** Scale factor that brings w x h inside the limits, 1 when already inside, or null when impossible. */
  static scaleFor(w: number, h: number, l: SizeLimits): number | null {
    const inside = (s: number) => {
      const W = Math.round(w * s), H = Math.round(h * s);
      return Math.min(W, H) >= l.imageSideMin && Math.max(W, H) <= l.imageSideMax && W * H >= l.imagePixelsMin && W * H <= l.imagePixelsMax;
    };
    if (inside(1)) return 1;
    const down = Math.min(l.imageSideMax / Math.max(w, h), Math.sqrt(l.imagePixelsMax / (w * h)));
    const up = Math.max(l.imageSideMin / Math.min(w, h), Math.sqrt(l.imagePixelsMin / (w * h)));
    const s = down < 1 ? down * 0.999 : up * 1.001;
    return inside(s) ? s : null;
  }

  static fit(bytes: Buffer, l: SizeLimits): { bytes: Buffer; width: number; height: number; scaled: boolean } {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIG)) throw JevError.invalid("Not a PNG.");
    const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
    const s = PngResizer.scaleFor(w, h, l);
    if (s === 1) return { bytes, width: w, height: h, scaled: false };
    if (s === null) throw JevError.invalid(`Image ${w}x${h} cannot be scaled into ${l.imageSideMin}-${l.imageSideMax} px per side.`, undefined, "Crop or pad it to a less extreme aspect ratio.");
    if (w === 0 || h === 0 || w * h > l.resizeSourcePixelsMax) {
      throw JevError.invalid(`Image ${w}x${h} is too large to resize here (over ${l.resizeSourcePixelsMax} pixels).`, undefined, "Resize it to 280-1568 px per side before sending.");
    }
    const img = PngResizer.decode(bytes);
    const W = Math.round(img.width * s), H = Math.round(img.height * s);
    return { bytes: PngResizer.encode(PngResizer.sample(img, W, H), W, H, img.colorType), width: W, height: H, scaled: true };
  }

  static decode(bytes: Buffer): Decoded {
    if (!bytes.subarray(0, 8).equals(SIG)) throw JevError.invalid("Not a PNG.");
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    const depth = bytes[24], colorType = bytes[25] ?? -1, interlace = bytes[28];
    const channels = CHANNELS[colorType];
    if (depth !== 8 || interlace !== 0 || channels === undefined) {
      throw JevError.invalid("This PNG cannot be resized here (needs 8-bit, non-interlaced, non-palette).", undefined, "Resize it to 280-1568 px per side before sending.");
    }
    const idat: Buffer[] = [];
    for (let o = 8; o + 12 <= bytes.length; o += 12 + bytes.readUInt32BE(o)) {
      if (bytes.toString("latin1", o + 4, o + 8) === "IDAT") idat.push(bytes.subarray(o + 8, o + 8 + bytes.readUInt32BE(o)));
    }
    return { width, height, channels, colorType, pixels: PngResizer.unfilter(PngResizer.inflate(Buffer.concat(idat), (width * channels + 1) * height), width, height, channels) };
  }

  /** Inflates IDAT, refusing anything that decompresses past (bomb) or short of (no pixel data) the size the header declares. */
  private static inflate(data: Buffer, expected: number): Buffer {
    let raw: Buffer | null = null;
    try {
      raw = zlib.inflateSync(data, { maxOutputLength: Math.max(1, expected) });
    } catch {
      // Reported below, with the short case.
    }
    if (raw === null || raw.length !== expected) throw JevError.invalid("PNG image data is corrupt or does not match its declared size.", undefined, "Re-export the image as a normal PNG.");
    return raw;
  }

  private static unfilter(raw: Buffer, w: number, h: number, bpp: number): Buffer {
    const stride = w * bpp;
    const out = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
      const type = raw[y * (stride + 1)] ?? 0;
      for (let x = 0; x < stride; x++) {
        const v = raw[y * (stride + 1) + 1 + x] ?? 0;
        const a = x >= bpp ? (out[y * stride + x - bpp] ?? 0) : 0;
        const b = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
        const c = x >= bpp && y > 0 ? (out[(y - 1) * stride + x - bpp] ?? 0) : 0;
        out[y * stride + x] = (v + PngResizer.predict(type, a, b, c)) & 0xff;
      }
    }
    return out;
  }

  private static predict(type: number, a: number, b: number, c: number): number {
    if (type === 1) return a;
    if (type === 2) return b;
    if (type === 3) return (a + b) >> 1;
    if (type === 4) {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    return 0;
  }

  private static sample(img: Decoded, W: number, H: number): Buffer {
    const out = Buffer.alloc(W * H * img.channels);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(img.height - 1, Math.floor((y * img.height) / H));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(img.width - 1, Math.floor((x * img.width) / W));
        img.pixels.copy(out, (y * W + x) * img.channels, (sy * img.width + sx) * img.channels, (sy * img.width + sx + 1) * img.channels);
      }
    }
    return out;
  }

  static encode(pixels: Buffer, W: number, H: number, colorType: number): Buffer {
    const bpp = CHANNELS[colorType] ?? 1;
    const raw = Buffer.alloc((W * bpp + 1) * H);
    for (let y = 0; y < H; y++) pixels.copy(raw, y * (W * bpp + 1) + 1, y * W * bpp, (y + 1) * W * bpp);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    return Buffer.concat([SIG, PngResizer.chunk("IHDR", ihdr), PngResizer.chunk("IDAT", zlib.deflateSync(raw)), PngResizer.chunk("IEND", Buffer.alloc(0))]);
  }

  private static chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  }
}
