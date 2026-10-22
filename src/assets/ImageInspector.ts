import { createHash } from "node:crypto";
import type { ApiLimits } from "../config/defaults.js";
import { JevError } from "../core/JevError.js";
import type { ImageInfo } from "../core/types.js";

interface Header {
  format: "png" | "jpg";
  width: number;
  height: number;
  warnings: string[];
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SOF_SKIP = new Set([0xc4, 0xc8, 0xcc]);

/**
 * Reads PNG/JPEG headers (magic bytes, dimensions, animation, EXIF presence) and enforces
 * the `/images.md` limits locally so a bad image never costs a request.
 */
export class ImageInspector {
  constructor(private readonly limits: ApiLimits) {}

  inspect(name: string, bytes: Buffer): ImageInfo & { warnings: string[] } {
    if (bytes.length > this.limits.imageBytes) {
      throw JevError.invalid(`Image ${name} is ${bytes.length} bytes; the limit is ${this.limits.imageBytes}.`);
    }
    const header = this.readHeader(name, bytes);
    this.checkDimensions(name, header.width, header.height);
    return {
      name,
      format: header.format,
      width: header.width,
      height: header.height,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      warnings: header.warnings,
    };
  }

  private readHeader(name: string, bytes: Buffer): Header {
    if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIG)) return this.readPng(name, bytes);
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return this.readJpeg(name, bytes);
    throw JevError.invalid(`Image ${name} is not PNG or JPEG (magic bytes). Convert GIF/WebP/HEIC first.`);
  }

  private readPng(name: string, bytes: Buffer): Header {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("latin1", offset + 4, offset + 8);
      if (type === "acTL") throw JevError.invalid(`Image ${name} is an animated PNG; send a still frame.`);
      if (type === "IDAT" || type === "IEND") break;
      offset += 12 + length;
    }
    return { format: "png", width, height, warnings: [] };
  }

  private readJpeg(name: string, bytes: Buffer): Header {
    const warnings: string[] = [];
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (marker === 0xe1 && bytes.toString("latin1", offset + 4, offset + 8) === "Exif") {
        warnings.push(`Image ${name} has EXIF data; the API ignores EXIF orientation, so rotate pixels upright.`);
      }
      if (marker >= 0xc0 && marker <= 0xcf && !SOF_SKIP.has(marker)) {
        if (marker !== 0xc0 && marker !== 0xc1) warnings.push(`Image ${name} is not baseline JPEG; baseline is preferred.`);
        if (offset + 9 > bytes.length) break;
        const height = bytes.readUInt16BE(offset + 5);
        const width = bytes.readUInt16BE(offset + 7);
        return { format: "jpg", width, height, warnings };
      }
      offset += 2 + length;
    }
    throw JevError.invalid(`Image ${name}: JPEG has no frame header (damaged or incomplete).`);
  }

  private checkDimensions(name: string, width: number, height: number): void {
    const l = this.limits;
    const sides = [width, height];
    if (sides.some((s) => s < l.imageSideMin || s > l.imageSideMax)) {
      throw JevError.invalid(
        `Image ${name} is ${width}x${height}; each side must be ${l.imageSideMin}-${l.imageSideMax} px. Resize or pad first.`,
      );
    }
    const pixels = width * height;
    if (pixels < l.imagePixelsMin || pixels > l.imagePixelsMax) {
      throw JevError.invalid(`Image ${name} has ${pixels} pixels; allowed ${l.imagePixelsMin}-${l.imagePixelsMax}.`);
    }
  }
}
