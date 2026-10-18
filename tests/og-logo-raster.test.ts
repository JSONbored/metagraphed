import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ReactNode } from "react";
import { Resvg } from "@resvg/resvg-js";
import { build } from "esbuild";
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import satori from "satori";
import { html } from "satori-html";
import sharp from "sharp";
import { afterAll, beforeAll, test } from "vitest";
import { repoRoot } from "../scripts/lib.ts";
import { prepareLogoInput, sharingPng } from "../scripts/logo-sharing-image.ts";
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

// #12119 needs the actual Worker response, not just the Node Satori/Resvg
// analogue above. Native CI compiles the real handler and its lazy workers-og
// WASM modules, with only artifact and outbound asset/font I/O held fixed.
const FONT_SHA256 =
  "8809dcad25318225052f88333e208c5aad4adcb7b2c934c135735ec19aa410b4";
const fontFixture = readFileSync(
  new URL("./fixtures/og-logo/Abel-Regular.ttf", import.meta.url),
);
const fontFaces = [
  "Geist:wght@500",
  "Geist:wght@700",
  "Geist Mono:wght@500",
  "Inter:wght@500",
  "Inter:wght@700",
];
const workerAssets = new Map<string, Buffer>();
const workerOutbound: string[] = [];
const unexpectedOutbound: string[] = [];
let workerOutdir: string;
let workerRuntime: Miniflare;

beforeAll(async () => {
  assert.equal(sha256(fontFixture), FONT_SHA256);
  assert.equal(fontFixture.readUInt32BE(0), 0x00010000, "real TrueType font");
  workerOutdir = await mkdtemp(path.join(tmpdir(), "og-logo-worker-"));
  await build({
    absWorkingDir: repoRoot,
    entryPoints: ["tests/fixtures/og-logo/worker.ts"],
    outdir: workerOutdir,
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    conditions: ["workerd", "worker", "browser"],
    loader: { ".wasm": "copy" },
    external: ["cloudflare:*"],
    plugins: [
      {
        name: "native-node-requires",
        setup(builder) {
          // Match the deployed API build's native Node compatibility seam.
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (!isBuiltin(args.path)) return;
            if (args.kind === "require-call") {
              return {
                path: args.path.replace(/^node:/, ""),
                namespace: "native-node-require",
              };
            }
            return {
              path: args.path.startsWith("node:")
                ? args.path
                : `node:${args.path}`,
              external: true,
            };
          });
          builder.onLoad(
            { filter: /.*/, namespace: "native-node-require" },
            (args) => ({
              contents: `import native from 'node:${args.path}'; module.exports = native;`,
              loader: "js",
            }),
          );
        },
      },
    ],
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const names = (await readdir(workerOutdir, { recursive: true }))
    .filter((name) => name.endsWith(".js") || name.endsWith(".wasm"))
    .sort((a, b) =>
      a === "worker.js" ? -1 : b === "worker.js" ? 1 : a.localeCompare(b),
    );
  assert.ok(names.some((name) => name.endsWith(".wasm")));
  workerRuntime = new Miniflare({
    modules: names.map((name) => ({
      type: name.endsWith(".wasm") ? "CompiledWasm" : "ESModule",
      path: path.join(workerOutdir, name),
    })),
    modulesRoot: workerOutdir,
    compatibilityDate: "2026-06-06",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    host: "127.0.0.1",
    port: 0,
    cf: false,
    outboundService(request) {
      const url = new URL(request.url);
      workerOutbound.push(url.href);
      if (request.method === "GET") {
        const asset = workerAssets.get(url.href);
        if (asset)
          return new MiniflareResponse(asset, {
            headers: {
              "content-type": "image/png",
              "content-length": String(asset.length),
            },
          });
        const face = fontFaces.indexOf(url.searchParams.get("family") ?? "");
        if (
          url.origin === "https://fonts.googleapis.com" &&
          url.pathname === "/css2" &&
          face >= 0 &&
          url.searchParams.get("text") &&
          [...url.searchParams.keys()].sort().join(",") === "family,text"
        )
          return new MiniflareResponse(
            `@font-face { src: url(https://fonts.gstatic.com/s/og-logo-fixture/${face}.ttf); }`,
            { headers: { "content-type": "text/css" } },
          );
        if (
          url.origin === "https://fonts.gstatic.com" &&
          /^\/s\/og-logo-fixture\/[0-4]\.ttf$/.test(url.pathname) &&
          !url.search
        )
          return new MiniflareResponse(fontFixture, {
            headers: { "content-type": "font/ttf" },
          });
      }
      unexpectedOutbound.push(url.href);
      throw new Error(
        `Unexpected Worker fixture outbound request: ${url.href}`,
      );
    },
  });
  await workerRuntime.ready;
}, 60_000);

afterAll(async () => {
  await workerRuntime?.dispose();
  if (workerOutdir) await rm(workerOutdir, { recursive: true, force: true });
});

const workerFormats = [
  "png",
  "jpeg",
  "gif",
  "webp",
  "vector-svg",
  "png-ico",
  "bitmap-svg",
] as const;
type WorkerFormat = (typeof workerFormats)[number];
const samplePoints = [
  [16, 16],
  [48, 16],
  [16, 48],
  [48, 48],
] as const;
const sourceColors = [
  [0, 0, 0, 0],
  [20, 200, 60, 255],
  [240, 40, 20, 128],
  [20, 60, 230, 255],
];

async function workerSource(format: WorkerFormat) {
  const data = Buffer.alloc(64 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const color = [...sourceColors[(y >= 32 ? 2 : 0) + (x >= 32 ? 1 : 0)]];
      if (format === "gif" && y >= 32 && x < 32) color[3] = 255;
      data.set(color, (y * 64 + x) * 4);
    }
  const raster = () =>
    sharp(data, { raw: { width: 64, height: 64, channels: 4 } });
  if (format === "jpeg")
    return raster()
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
      .toBuffer();
  if (format === "gif") return raster().gif({ dither: 0 }).toBuffer();
  if (format === "webp") return raster().webp({ lossless: true }).toBuffer();
  const png = await raster().png().toBuffer();
  if (format === "png") return png;
  if (format === "png-ico") {
    const header = Buffer.alloc(22);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header[6] = 64;
    header[7] = 64;
    header.writeUInt16LE(1, 10);
    header.writeUInt16LE(32, 12);
    header.writeUInt32LE(png.length, 14);
    header.writeUInt32LE(22, 18);
    return Buffer.concat([header, png]);
  }
  const artwork =
    format === "bitmap-svg"
      ? `<image width="64" height="64" href="data:image/png;base64,${png.toString("base64")}"/>`
      : '<rect x="32" width="32" height="32" fill="#14c83c"/>' +
        '<rect y="32" width="32" height="32" fill="#f02814" fill-opacity="0.5019607843137255"/>' +
        '<rect x="32" y="32" width="32" height="32" fill="#143ce6"/>';
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
      artwork +
      "</svg>",
  );
}

function expectedColors(format: WorkerFormat, flattened = false) {
  return sourceColors.map((source, index) => {
    const color = [...source];
    if (format === "gif" && index === 2) color[3] = 255;
    if (flattened || format === "jpeg") {
      for (let channel = 0; channel < 3; channel++)
        color[channel] = Math.round(
          (color[channel] * color[3] + 255 * (255 - color[3])) / 255,
        );
      color[3] = 255;
    }
    return color;
  });
}

function alphaCounts(pixels: Buffer) {
  const counts = { transparent: 0, partial: 0, opaque: 0 };
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] === 0) counts.transparent++;
    else if (pixels[index] === 255) counts.opaque++;
    else counts.partial++;
  }
  return counts;
}

async function pixelEvidence(
  bytes: Buffer,
  format: WorkerFormat,
  card = false,
) {
  const decoded = await rgba(bytes);
  assert.equal(decoded.info.width, card ? 1200 : 64);
  assert.equal(decoded.info.height, card ? 630 : 64);
  const expected = expectedColors(format, card);
  const samples = samplePoints.map(([x, y], index) => {
    // The API layout's 158px img begins at (927, 241). Sample well inside
    // each known quadrant, away from resampling and container edges.
    const left = card ? Math.round(927 + (x / 64) * 158) : x;
    const top = card ? Math.round(241 + (y / 64) * 158) : y;
    const offset = (top * decoded.info.width + left) * 4;
    const observed = [...decoded.data.subarray(offset, offset + 4)];
    for (let channel = 0; channel < 4; channel++) {
      if (!card && expected[index][3] === 0 && channel < 3) continue;
      assert.ok(
        Math.abs(observed[channel] - expected[index][channel]) <=
          (format === "jpeg" ? 8 : 3),
        `${format} ${card ? "Worker" : "fixture"} sample ${index}, channel ${channel}: ${observed} != ${expected[index]}`,
      );
    }
    return { x: left, y: top, rgba: observed, expected: expected[index] };
  });
  const alpha = alphaCounts(decoded.data);
  assert.deepEqual(
    alpha,
    card
      ? { transparent: 0, partial: 0, opaque: 1200 * 630 }
      : format === "jpeg"
        ? { transparent: 0, partial: 0, opaque: 64 * 64 }
        : format === "gif"
          ? { transparent: 1024, partial: 0, opaque: 3072 }
          : { transparent: 1024, partial: 1024, opaque: 2048 },
  );
  return { alpha, samples };
}

function workerPngReceipt(format: string, kind: string, png: Buffer) {
  assert.ok(png.length <= 300_000, "bounded Worker raster receipt");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  const encoded = png.toString("base64");
  const chunks = Math.ceil(encoded.length / 48_000);
  const hash = sha256(png);
  for (let index = 0; index < chunks; index++)
    console.log(
      `OG_LOGO_WORKER_PNG ${format} ${kind} ${hash} ${index + 1}/${chunks} ` +
        encoded.slice(index * 48_000, (index + 1) * 48_000),
    );
  return {
    sha256: hash,
    bytes: png.length,
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bit_depth: png[24],
    color_type: png[25],
    chunks,
  };
}

async function renderWorkerSource(format: WorkerFormat, corrupt = false) {
  const original = await workerSource(format);
  const extension = format.endsWith("svg")
    ? ".svg"
    : format === "png-ico"
      ? ".ico"
      : `.${format}`;
  let sourceRaster = original;
  if (extension === ".ico") {
    assert.equal(original.readUInt32LE(0), 0x00010000);
    assert.equal(original.readUInt16LE(4), 1);
    assert.equal(original.readUInt32LE(14), original.length - 22);
    assert.equal(original.readUInt32LE(18), 22);
    sourceRaster = original.subarray(22);
    assert.equal((await sharp(sourceRaster).metadata()).format, "png");
  } else {
    const decodedFormat = (await sharp(original).metadata()).format;
    assert.equal(decodedFormat, extension === ".svg" ? "svg" : format);
    if (extension === ".svg") {
      assert.equal(
        /<image[\s>]/.test(original.toString()),
        format === "bitmap-svg",
      );
      sourceRaster = Buffer.from(
        new Resvg(original, { font: { loadSystemFonts: false } })
          .render()
          .asPng(),
      );
    }
  }
  const source = await pixelEvidence(sourceRaster, format);
  const sharing = await sharingPng(await prepareLogoInput(original, extension));
  assert.equal((await sharp(sharing.data).metadata()).format, "png");
  const derivative = await pixelEvidence(sharing.data, format);
  const sourceHash = sha256(original);
  const outputHash = corrupt ? "0".repeat(64) : sha256(sharing.data);
  const sourcePath = `worker-${format}${corrupt ? "-corrupt" : ""}${extension}`;
  const sharingPath = `sharing/v1/${sourceHash}-${outputHash}.png`;
  const fixtureManifest = {
    version: 2,
    sharing: {
      version: 1,
      format: "png",
      max_dimension: 256,
      max_bytes: 524288,
    },
    entries: [
      {
        source_path: sourcePath,
        source_sha256: sourceHash,
        source_bytes: original.length,
        sharing_path: sharingPath,
        sharing_sha256: outputHash,
        sharing_bytes: sharing.data.length,
        sharing_width: sharing.width,
        sharing_height: sharing.height,
      },
    ],
  };
  assert.ok(parseLogoManifest(fixtureManifest));
  workerAssets.clear();
  workerOutbound.length = 0;
  unexpectedOutbound.length = 0;
  const assetUrl = `https://metagraph.sh/logos/${sharingPath}`;
  workerAssets.set(assetUrl, sharing.data);
  const response = await workerRuntime.dispatchFetch(
    "https://api.metagraph.sh/og/subnets/65535.png",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        logoManifest: fixtureManifest,
        originalLogoUrl: `https://metagraph.sh/logos/${sourcePath}`,
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(
    response.headers.get("cache-control"),
    corrupt
      ? "public, max-age=60"
      : "public, max-age=86400, stale-while-revalidate=604800",
  );
  assert.deepEqual(unexpectedOutbound, []);
  assert.equal(workerOutbound.filter((url) => url === assetUrl).length, 1);
  assert.equal(
    workerOutbound.filter(
      (url) => new URL(url).hostname === "fonts.googleapis.com",
    ).length,
    5,
  );
  assert.equal(
    workerOutbound.filter(
      (url) => new URL(url).hostname === "fonts.gstatic.com",
    ).length,
    5,
  );
  const png = Buffer.from(await response.arrayBuffer());
  assert.equal((await sharp(png).metadata()).format, "png");
  return { png, original, sharing, source, derivative, assetUrl };
}

test.each(workerFormats)(
  "real Worker renders $0 original via its verified sharing PNG, preserving alpha over white",
  async (format) => {
    const { png, original, sharing, source, derivative, assetUrl } =
      await renderWorkerSource(format);
    const rendered = await pixelEvidence(png, format, true);
    console.log(
      "OG_LOGO_WORKER_RECEIPT " +
        JSON.stringify({
          format,
          source_sha256: sha256(original),
          source_bytes: original.length,
          source_signature_hex: original.subarray(0, 12).toString("hex"),
          source,
          derivative: {
            ...workerPngReceipt(format, "derivative", sharing.data),
            ...derivative,
          },
          rendered: {
            ...workerPngReceipt(format, "card", png),
            ...rendered,
          },
          font_sha256: FONT_SHA256,
          asset_url: assetUrl,
          cache_control:
            "public, max-age=86400, stale-while-revalidate=604800",
        }),
    );
  },
);

test("real Worker rejects same-length valid PNG bytes with the wrong manifest hash", async () => {
  const { png, sharing } = await renderWorkerSource("png", true);
  const decoded = await rgba(png);
  assert.equal(decoded.info.width, 1200);
  assert.equal(decoded.info.height, 630);
  assert.deepEqual(alphaCounts(decoded.data), {
    transparent: 0,
    partial: 0,
    opaque: 1200 * 630,
  });
  const offset = (280 * 1200 + 1045) * 4;
  const observed = [...decoded.data.subarray(offset, offset + 4)];
  assert.ok(
    observed.some(
      (value, index) => Math.abs(value - sourceColors[1][index]) > 8,
    ),
    "a hash mismatch must not paint the expected logo",
  );
  console.log(
    "OG_LOGO_WORKER_NEGATIVE_RECEIPT " +
      JSON.stringify({
        format: "png",
        actual_derivative_sha256: sha256(sharing.data),
        declared_derivative_sha256: "0".repeat(64),
        rendered: workerPngReceipt("wrong-hash", "card", png),
        logo_sample_rgba: observed,
        cache_control: "public, max-age=60",
      }),
  );
});
