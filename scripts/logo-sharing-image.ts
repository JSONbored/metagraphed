import sharp from "sharp";

import { icoPngFrame } from "./logo-sharing-ico.ts";

export const LOGO_SOURCE_LIMIT = 524_288;
export const LOGO_PIXEL_LIMIT = 16_777_216;
export const SHARING_DIMENSION = 256;
export const SHARING_BYTE_LIMIT = 524_288;

const SVG_TAGS = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "pattern",
  "image",
  "title",
  "desc",
]);
const SVG_ATTRIBUTES = new Set([
  "xmlns",
  "xmlns:xlink",
  "version",
  "id",
  "role",
  "aria-label",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "fill",
  "fill-rule",
  "fill-opacity",
  "clip-rule",
  "clip-path",
  "mask",
  "opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "transform",
  "gradientTransform",
  "gradientUnits",
  "spreadMethod",
  "offset",
  "stop-color",
  "stop-opacity",
  "preserveAspectRatio",
  "zoomAndPan",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "maskUnits",
  "maskContentUnits",
  "clipPathUnits",
  "href",
  "xlink:href",
]);
const RASTER_FORMATS = new Set(["png", "jpeg", "gif", "webp"]);
const SVG_TAG = /^\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)\b([\s\S]*?)\/?\s*$/u;
const SVG_ATTRIBUTE = /^\s+([A-Za-z][A-Za-z0-9:-]*)\s*=\s*(["'])([^"'<>]*)\2/u;
const URI = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/u;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

function invalidSvg(): Error {
  return new Error("Unsupported or unsafe sharing SVG");
}

function svgDimensions(attributes: Map<string, string>): void {
  const rawViewBox = attributes.get("viewBox")?.trim();
  const viewBox = rawViewBox?.split(/[\s,]+/u);
  const numeric = (value: string | undefined) => {
    if (!value || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/u.test(value)) {
      throw invalidSvg();
    }
    return Number(value.replace(/px$/u, ""));
  };
  const width = attributes.get("width");
  const height = attributes.get("height");
  let dimensions: number[];
  if (width !== undefined || height !== undefined) {
    dimensions = [numeric(width), numeric(height)];
  } else {
    if (!viewBox || viewBox.length !== 4) throw invalidSvg();
    if (!viewBox.every((value) => Number.isFinite(Number(value)))) {
      throw invalidSvg();
    }
    dimensions = [numeric(viewBox[2]), numeric(viewBox[3])];
  }
  if (dimensions.some((value) => value <= 0 || value > 4096)) {
    throw invalidSvg();
  }
}

function raster(source: Uint8Array) {
  return sharp(source, {
    animated: false,
    limitInputPixels: LOGO_PIXEL_LIMIT,
  }).timeout({ seconds: 3 });
}

function rasterFormat(source: Uint8Array): string {
  const bytes = Buffer.from(source);
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.every((value, index) => source[index] === value)) return "png";
  if (source[0] === 255 && source[1] === 216 && source[2] === 255) {
    return "jpeg";
  }
  if (["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6))) {
    return "gif";
  }
  if (
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  throw new Error("Unsupported sharing raster signature");
}

async function boundedRaster(source: Uint8Array, expected?: string) {
  // Reject disguised XML before Sharp can enter its SVG loader.
  const format = rasterFormat(source);
  if (expected !== undefined && format !== expected) throw invalidSvg();
  const image = raster(source);
  const metadata = await image.metadata();
  if (
    !metadata.format ||
    !RASTER_FORMATS.has(metadata.format) ||
    metadata.format !== format ||
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > LOGO_PIXEL_LIMIT
  ) {
    throw new Error("Unsupported or oversized sharing raster");
  }
  return { image, metadata };
}

/** Refuse active/resource-bearing XML before invoking the SVG decoder. */
async function prepareSvg(source: Uint8Array): Promise<Buffer> {
  let text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  text = text.replace(/^\s*<\?xml\s+[^?]*\?>/u, "");
  text = text.replace(/<!--[\s\S]*?-->/gu, "");
  if (/[&\\]/u.test(text) || /<!|<\?/u.test(text)) throw invalidSvg();

  const tags = [...text.matchAll(/<([^<>]*)>/gu)];
  if (tags.length === 0 || text.replace(/<[^<>]*>/gu, "").includes("<")) {
    throw invalidSvg();
  }
  let first = true;
  let images = 0;
  let pixels = 0;
  let normalizedBytes = source.byteLength;
  const replacements: Array<[string, string]> = [];
  for (const tag of tags) {
    const parsed = SVG_TAG.exec(tag[1]);
    if (!parsed || !SVG_TAGS.has(parsed[2])) throw invalidSvg();
    const [, closing, name, rawAttributes] = parsed;
    const root = first;
    if (root && (closing || name !== "svg")) throw invalidSvg();
    if (!root && !closing && name === "svg") throw invalidSvg();
    first = false;
    if (closing && rawAttributes.trim()) throw invalidSvg();
    const attributes = new Map<string, string>();
    let rest = rawAttributes;
    while (rest.trim()) {
      const attribute = SVG_ATTRIBUTE.exec(rest);
      if (!attribute) throw invalidSvg();
      const [, key, , value] = attribute;
      if (!SVG_ATTRIBUTES.has(key) || attributes.has(key)) throw invalidSvg();
      attributes.set(key, value);
      if (value.includes("/*") || value.includes("*/")) throw invalidSvg();
      rest = rest.slice(attribute[0].length);
      if (key === "xmlns" || key === "xmlns:xlink") {
        const expected = key === "xmlns" ? SVG_NAMESPACE : XLINK_NAMESPACE;
        if (value !== expected) throw invalidSvg();
        continue;
      }
      if (/url\s*\(/iu.test(value)) {
        if (!/^url\(#[A-Za-z0-9_][A-Za-z0-9_.:-]*\)$/u.test(value)) {
          throw invalidSvg();
        }
      }
      if (key !== "href" && key !== "xlink:href") continue;
      if (name !== "image" || images >= 32) throw invalidSvg();
      images++;
      const data = URI.exec(value);
      if (!data || data[2].length === 0) throw invalidSvg();
      const bytes = Buffer.from(data[2], "base64");
      if (
        bytes.byteLength > LOGO_SOURCE_LIMIT ||
        bytes.toString("base64") !== data[2]
      ) {
        throw invalidSvg();
      }
      const { image, metadata } = await boundedRaster(bytes, data[1]);
      pixels += metadata.width! * metadata.height!;
      if (pixels > LOGO_PIXEL_LIMIT) throw invalidSvg();
      // Decode embedded pixels independently; only bounded PNGs reach librsvg.
      const normalized = await image.png().toBuffer();
      if (normalized.byteLength > LOGO_SOURCE_LIMIT) throw invalidSvg();
      const base64 = normalized.toString("base64");
      const replacement = `data:image/png;base64,${base64}`;
      normalizedBytes += replacement.length - value.length;
      if (normalizedBytes > LOGO_SOURCE_LIMIT) throw invalidSvg();
      replacements.push([value, replacement]);
    }
    if (name === "image" && !closing) {
      const href = attributes.has("href");
      const xlink = attributes.has("xlink:href");
      if (href === xlink) throw invalidSvg();
    }
    if (root) svgDimensions(attributes);
  }
  for (const [original, normalized] of replacements) {
    text = text.replaceAll(original, normalized);
  }
  const prepared = Buffer.from(text);
  if (prepared.byteLength > LOGO_SOURCE_LIMIT) throw invalidSvg();
  return prepared;
}

/** Normalize supported originals without granting SVG file/network access. */
export async function prepareLogoInput(
  source: Uint8Array,
  extension: string,
): Promise<Buffer> {
  if (source.byteLength < 1 || source.byteLength > LOGO_SOURCE_LIMIT) {
    throw new Error("Sharing logo source exceeds its byte limit");
  }
  if (extension === ".svg") return prepareSvg(source);
  const input = extension === ".ico" ? icoPngFrame(source) : source;
  await boundedRaster(input, extension === ".ico" ? "png" : undefined);
  return Buffer.from(input);
}

export async function sharingPng(input: Uint8Array) {
  const { data, info } = await raster(input)
    .rotate()
    .resize({
      width: SHARING_DIMENSION,
      height: SHARING_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  if (
    info.format !== "png" ||
    info.width < 1 ||
    info.height < 1 ||
    info.width > SHARING_DIMENSION ||
    info.height > SHARING_DIMENSION ||
    data.byteLength > SHARING_BYTE_LIMIT
  ) {
    throw new Error("Sharing PNG exceeds its output bounds");
  }
  return { data, width: info.width, height: info.height };
}
