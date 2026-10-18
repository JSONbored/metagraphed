import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ReactNode } from "react";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { html } from "satori-html";
import sharp from "sharp";
import { test } from "vitest";
import { parseLogoManifest } from "../src/og-logo-manifest.ts";

interface SharingEntry {
  source_path: string;
  source_sha256: string;
  sharing_path: string;
  sharing_sha256: string;
  sharing_bytes: number;
  sharing_width: number;
  sharing_height: number;
}

const logoRoot = fileURLToPath(
  new URL("../apps/ui/public/logos/", import.meta.url),
);
const manifest = JSON.parse(
  readFileSync(path.join(logoRoot, "display/manifest.json"), "utf8"),
) as { version: number; entries: SharingEntry[] };
assert.equal(manifest.version, 2);
assert.ok(
  parseLogoManifest(manifest),
  "raster qualification needs a valid manifest",
);
assert.ok(manifest.entries.length > 0);
const unique = new Map(
  manifest.entries.map((entry) => [entry.sharing_path, entry]),
);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readLogo(relative: string): Buffer {
  return readFileSync(path.join(logoRoot, relative));
}

async function rgba(bytes: Uint8Array) {
  return sharp(bytes)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function composite(
  bytes: Uint8Array,
  background: string,
  sample = false,
) {
  let image = sharp(bytes).rotate().toColourspace("srgb");
  // The original comparison uses a separate fixed observation size, rather
  // than reproducing the builder's input normalization or 256px resize.
  if (sample) {
    image = image.resize(64, 64, { fit: "contain", background });
  }
  return image.flatten({ background }).removeAlpha().raw().toBuffer();
}

async function sameAppearance(
  reference: Uint8Array,
  actual: Uint8Array,
  label: string,
  sample = false,
) {
  for (const background of ["#000000", "#ffffff"]) {
    const expected = await composite(reference, background, sample);
    const observed = await composite(actual, background, sample);
    assert.equal(observed.length, expected.length, label);
    let error = 0;
    let outliers = 0;
    for (let index = 0; index < expected.length; index++) {
      const difference = Math.abs(expected[index] - observed[index]);
      error += difference;
      if (difference > (sample ? 48 : 16)) outliers++;
    }
    // Transparent-edge premultiplication can round by one intensity level.
    // Source comparisons additionally allow independent downsampling kernels.
    const mean = error / expected.length;
    assert.ok(mean <= (sample ? 6 : 1.5), `${label}: mean error ${mean}`);
    const fraction = outliers / expected.length;
    assert.ok(
      fraction <= (sample ? 0.1 : 0.01),
      `${label}: outlier fraction ${fraction}`,
    );
  }
}

function resvgImage(bytes: Uint8Array, width: number, height: number): Buffer {
  const uri = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" ` +
    `href="${uri}"/></svg>`;
  return Buffer.from(new Resvg(svg).render().asPng());
}

test.each([...unique.values()])(
  "native Resvg preserves committed sharing PNG pixels: $source_path",
  async (entry) => {
    const png = readLogo(entry.sharing_path);
    assert.equal(sha256(png), entry.sharing_sha256);
    assert.equal(png.length, entry.sharing_bytes);
    const source = await rgba(png);
    assert.equal(source.info.width, entry.sharing_width);
    assert.equal(source.info.height, entry.sharing_height);
    assert.equal(source.info.channels, 4);
    let visible = 0;
    for (let index = 3; index < source.data.length; index += 4)
      if (source.data[index] > 0) visible++;
    assert.ok(visible > 0, `${entry.source_path}: transparent artwork`);
    const rendered = resvgImage(png, source.info.width, source.info.height);
    const output = await rgba(rendered);
    assert.equal(output.info.width, source.info.width);
    assert.equal(output.info.height, source.info.height);
    let renderedVisible = 0;
    for (let index = 3; index < output.data.length; index += 4)
      if (output.data[index] > 0) renderedVisible++;
    assert.ok(
      renderedVisible >= visible * 0.99,
      `${entry.source_path}: native renderer lost visible artwork`,
    );
    await sameAppearance(png, rendered, entry.source_path);
  },
);

const representatives = [
  { format: "png", suffix: ".png" },
  { format: "jpeg", suffix: ".jpg" },
  { format: "webp", suffix: ".webp" },
].map(({ format, suffix }) => {
  const entry = manifest.entries.find((candidate) =>
    candidate.source_path.endsWith(suffix),
  );
  assert.ok(entry, `missing committed ${format} representative`);
  return { format, entry };
});
const embedded = manifest.entries.find(
  (entry) => entry.source_path === "blockmachine.svg",
);
assert.ok(embedded, "missing committed embedded-bitmap SVG representative");
representatives.push({ format: "embedded-svg", entry: embedded });

function receipt(entry: SharingEntry, png: Buffer) {
  assert.ok(png.length <= 300_000, "bounded 256px raster receipt");
  const encoded = png.toString("base64");
  const chunks = Math.ceil(encoded.length / 48_000);
  const hash = sha256(png);
  console.log(
    "OG_LOGO_RASTER_RECEIPT " +
      JSON.stringify({
        source: entry.source_path,
        source_sha256: entry.source_sha256,
        sharing_sha256: entry.sharing_sha256,
        rendered_sha256: hash,
        rendered_bytes: png.length,
        width: entry.sharing_width,
        height: entry.sharing_height,
        chunks,
      }),
  );
  for (let index = 0; index < chunks; index++)
    console.log(
      `OG_LOGO_RASTER_PNG ${hash} ${index + 1}/${chunks} ` +
        encoded.slice(index * 48_000, (index + 1) * 48_000),
    );
}

test.each(representatives)(
  "actual Satori/Resvg accepts $format artwork and retains its original appearance",
  async ({ format, entry }) => {
    const original = readLogo(entry.source_path);
    assert.equal(sha256(original), entry.source_sha256);
    const png = readLogo(entry.sharing_path);
    const width = entry.sharing_width;
    const height = entry.sharing_height;
    const uri = `data:image/png;base64,${png.toString("base64")}`;
    // Production card markup supplies CSS pixel dimensions: satori-html keeps
    // HTML width/height attributes as strings, which Satori rejects.
    const markup =
      `<div style="display:flex;width:${width}px;height:${height}px">` +
      `<img src="${uri}" style="width:${width}px;height:${height}px;object-fit:contain;"/></div>`;
    const svg = await satori(html(markup) as ReactNode, {
      width,
      height,
      fonts: [],
    });
    const rendered = Buffer.from(new Resvg(svg).render().asPng());
    await sameAppearance(png, rendered, `${format}: renderer pixels`);
    let reference = original;
    if (format === "embedded-svg") {
      assert.match(original.toString("utf8"), /<image[\s>]/i);
      reference = Buffer.from(
        new Resvg(original, {
          fitTo: { mode: "width", value: 256 },
          font: { loadSystemFonts: false },
        })
          .render()
          .asPng(),
      );
    } else {
      assert.equal((await sharp(original).metadata()).format, format);
    }
    const label = `${format}: original pixels`;
    await sameAppearance(reference, rendered, label, true);
    if (format === "webp" || format === "embedded-svg") {
      receipt(entry, rendered);
    }
  },
);
