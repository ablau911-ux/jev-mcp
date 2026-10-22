import { randomUUID } from "node:crypto";
import { Image } from "@typesafe-ai/sdk";
import type { ApiLimits } from "../config/defaults.js";
import { EntryWalker } from "../core/EntryWalker.js";
import { JevError } from "../core/JevError.js";
import type { Entry, ImageInfo, ImageSpec, Questions, WireAsset } from "../core/types.js";
import type { PathGuard } from "../files/PathGuard.js";
import { ExifStripper } from "./ExifStripper.js";
import { ImageInspector } from "./ImageInspector.js";
import { PngResizer } from "./PngResizer.js";

export const IMAGE_NAME = /^<[A-Za-z0-9_.-]{1,64}>$/;

export interface PackInput {
  state: Entry;
  questions: Questions;
  images?: Record<string, ImageSpec>;
}

export interface Packed {
  state: Entry;
  questions: Questions;
  assets?: Record<string, WireAsset>;
  images: ImageInfo[];
  needsImagesHeader: boolean;
  warnings: string[];
}

/**
 * Turns agent-friendly image placeholders (`<photo>`) into the wire format of `/images.md`:
 * each name becomes a fresh UUID reference (in string values only, never object keys), the
 * bytes go into `assets` as base64, and unreferenced images are refused before sending.
 */
export class AssetPacker {
  private readonly inspector: ImageInspector;

  constructor(
    private readonly limits: ApiLimits,
    private readonly guard: PathGuard,
    private readonly uuid: () => string = randomUUID,
  ) {
    this.inspector = new ImageInspector(limits);
  }

  async pack(input: PackInput): Promise<Packed> {
    const hasBox = Object.values(input.questions).some((q) => q.type === "box");
    const specs = input.images ?? {};
    if (Object.keys(specs).length === 0) {
      return { state: input.state, questions: input.questions, images: [], needsImagesHeader: hasBox, warnings: [] };
    }
    const warnings: string[] = [];
    const images = await this.loadAll(specs, warnings);
    const refs = new Map(images.map((img) => [img.name, this.uuid()]));
    const counts = new Map<string, number>(images.map((img) => [img.name, 0]));
    const rewritten = EntryWalker.mapRequestStrings(input.state, input.questions, (s) => this.replace(s, refs, counts));
    this.checkReferences(counts, refs);
    return {
      ...rewritten,
      assets: this.buildAssets(images, refs),
      images,
      needsImagesHeader: true,
      warnings,
    };
  }

  /** Loads and inspects every image; enforces the combined-size limit. */
  async loadAll(specs: Record<string, ImageSpec>, warnings: string[]): Promise<ImageInfo[]> {
    const images: ImageInfo[] = [];
    let total = 0;
    for (const [name, spec] of Object.entries(specs)) {
      if (!IMAGE_NAME.test(name)) {
        throw JevError.invalid(`Image name ${name} must match ${IMAGE_NAME.source}, for example "<photo>".`);
      }
      const info = this.inspector.inspect(name, this.normalize(name, await this.bytes(name, spec, warnings), warnings));
      warnings.push(...info.warnings);
      const declared = spec.format === "jpeg" ? "jpg" : spec.format;
      if (declared && declared !== info.format) {
        warnings.push(`Image ${name}: format ${spec.format} declared but bytes are ${info.format}; using ${info.format}.`);
      }
      total += info.bytes.length;
      images.push({ name, format: info.format, width: info.width, height: info.height, bytes: info.bytes, sha256: info.sha256 });
    }
    if (total > this.limits.imagesTotalBytes) {
      throw JevError.invalid(`All images total ${total} bytes; the limit is ${this.limits.imagesTotalBytes}.`);
    }
    return images;
  }

  /** Strips EXIF and rescales an out-of-range PNG into the API limits. */
  normalize(name: string, raw: Buffer, warnings: string[]): Buffer {
    const { bytes, stripped } = ExifStripper.strip(raw);
    if (stripped) warnings.push(`Image ${name}: EXIF/text metadata removed before sending.`);
    if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return bytes;
    const fit = PngResizer.fit(bytes, this.limits);
    if (fit.scaled) warnings.push(`Image ${name}: resized to ${fit.width}x${fit.height} to fit the API limits.`);
    return fit.bytes;
  }

  private async bytes(name: string, spec: ImageSpec, warnings: string[]): Promise<Buffer> {
    if (spec.path && spec.data_base64) throw JevError.invalid(`Image ${name}: give path or data_base64, not both.`);
    if (spec.path) return this.guard.readBytes(spec.path, this.limits.imageBytes);
    if (!spec.data_base64) throw JevError.invalid(`Image ${name}: path or data_base64 is required.`);
    let b64 = spec.data_base64;
    if (/^data:/i.test(b64) || /\s/.test(b64)) {
      warnings.push(`Image ${name}: removed data: prefix / whitespace from data_base64.`);
      b64 = b64.replace(/^data:[^,]*,/i, "").replace(/\s+/g, "");
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
      throw JevError.invalid(`Image ${name}: data_base64 is not standard padded base64.`);
    }
    return Buffer.from(b64, "base64");
  }

  private replace(s: string, refs: Map<string, string>, counts: Map<string, number>): string {
    let out = s;
    for (const [name, ref] of refs) {
      if (!out.includes(name)) continue;
      const parts = out.split(name);
      counts.set(name, (counts.get(name) ?? 0) + parts.length - 1);
      out = parts.join(ref);
    }
    return out;
  }

  private checkReferences(counts: Map<string, number>, refs: Map<string, string>): void {
    const unused = [...counts].filter(([, n]) => n === 0).map(([name]) => name);
    if (unused.length > 0) {
      throw JevError.invalid(
        `Images not referenced in state, instructions or criteria: ${unused.join(", ")}. The API returns 400 for unreferenced assets.`,
      );
    }
    let total = 0;
    for (const ref of refs.values()) {
      const bytes = Buffer.byteLength(ref, "utf8");
      if (bytes > this.limits.referenceBytes) throw JevError.invalid(`Asset reference over ${this.limits.referenceBytes} bytes.`);
      total += bytes;
    }
    if (total > this.limits.referencesTotalBytes) throw JevError.invalid("Asset references exceed the combined byte limit.");
  }

  private buildAssets(images: ImageInfo[], refs: Map<string, string>): Record<string, WireAsset> {
    const assets: Record<string, WireAsset> = {};
    for (const img of images) {
      const ref = refs.get(img.name);
      if (ref) assets[ref] = new Image(new Uint8Array(img.bytes));
    }
    return assets;
  }
}
