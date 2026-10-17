import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { test } from "vitest";

import {
  checkDerivatives,
  writeDerivatives,
} from "../scripts/build-logo-thumbnails.ts";
import {
  LOGO_PIXEL_LIMIT,
  LOGO_SOURCE_LIMIT,
  prepareLogoInput,
  sharingPng,
} from "../scripts/logo-sharing-image.ts";

const SVG_START = '<svg xmlns="http://www.w3.org/2000/svg"';
const VECTOR =
  `${SVG_START} width="64" height="64" viewBox="0 0 64 64">` +
  '<rect x="16" y="16" width="32" height="32" fill="#ff0000"/></svg>';
const IDENTITY = "sharing-identity.json";

async function readIdentity(root: string) {
  const file = path.join(root, "display", IDENTITY);
  return JSON.parse(await readFile(file, "utf8")) as {
    version: number;
    sha256: string;
  };
}

function sha256(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function rgba(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  let seed = 12345;
  for (let index = 0; index < data.length; index += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[index] = seed & 255;
    data[index + 1] = (seed >>> 8) & 255;
    data[index + 2] = (seed >>> 16) & 255;
    const pixel = index / 4;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    data[index + 3] = x < width / 4 && y < height / 4 ? 0 : 255;
  }
  return data;
}

async function rasterFixture(format: "png" | "jpeg" | "gif" | "webp") {
  const image = sharp(rgba(320, 200), {
    raw: { width: 320, height: 200, channels: 4 },
  });
  return image.toFormat(format).toBuffer();
}

async function redPng(): Promise<Buffer> {
  const image = sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  });
  return image.png().toBuffer();
}

function pngIco(png: Buffer): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 16;
  header[7] = 16;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

function bitmapSvg(data: string, mime = "png"): string {
  return (
    `${SVG_START} width="64" height="64">` +
    '<image x="16" y="16" width="32" height="32" ' +
    `href="data:image/${mime};base64,${data}"/></svg>`
  );
}

async function pixels(data: Uint8Array) {
  const image = sharp(data).ensureAlpha().raw();
  return image.toBuffer({ resolveWithObject: true });
}

for (const format of ["png", "jpeg", "gif", "webp"] as const) {
  test(`sharing PNG converts bounded ${format} originals`, async () => {
    const original = await rasterFixture(format);
    const input = await prepareLogoInput(original, `.${format}`);
    const output = await sharingPng(input);
    const metadata = await sharp(output.data).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(output.width, 256);
    assert.equal(output.height, 160);
    assert.ok(output.data.byteLength <= LOGO_SOURCE_LIMIT);
    if (format !== "jpeg") {
      assert.equal(metadata.hasAlpha, true);
      const decoded = await pixels(output.data);
      assert.equal(decoded.data[3], 0);
    }
  });
}

test("sharing SVG preserves visible vector and embedded bitmap pixels", async () => {
  const embedded = (await redPng()).toString("base64");
  for (const svg of [VECTOR, bitmapSvg(embedded)]) {
    const input = await prepareLogoInput(Buffer.from(svg), ".svg");
    const output = await sharingPng(input);
    const decoded = await pixels(output.data);
    assert.equal(decoded.info.width, 64);
    assert.equal(decoded.info.height, 64);
    assert.equal(decoded.data[3], 0);
    const center = (32 * 64 + 32) * 4;
    assert.deepEqual(
      [...decoded.data.subarray(center, center + 4)],
      [255, 0, 0, 255],
    );
  }
});

test("sharing SVG normalizes raster data MIME and local paint fragments", async () => {
  const png = await redPng();
  const jpeg = await sharp(png).jpeg().toBuffer();
  const input = await prepareLogoInput(
    Buffer.from(bitmapSvg(jpeg.toString("base64"), "jpeg")),
    ".svg",
  );
  assert.ok(input.toString().includes("data:image/png;base64,"));
  assert.ok(!input.toString().includes("data:image/jpeg;base64,"));
  const svg =
    `${SVG_START} viewBox="0 0 16 16"><defs>` +
    '<linearGradient id="paint"><stop stop-color="red"/></linearGradient>' +
    '</defs><rect width="16" height="16" fill="url(#paint)"/></svg>';
  const prepared = await prepareLogoInput(Buffer.from(svg), ".svg");
  assert.equal((await sharingPng(prepared)).width, 16);
});

test("sharing SVG renders numeric-leading local fragment identifiers", async () => {
  const svg =
    `${SVG_START} width="16" height="16"><defs>` +
    '<clipPath id="5a1887327b"><rect x="4" y="4" ' +
    'width="8" height="8"/></clipPath></defs>' +
    '<rect width="16" height="16" fill="#ff0000" ' +
    'clip-path="url(#5a1887327b)"/></svg>';
  const prepared = await prepareLogoInput(Buffer.from(svg), ".svg");
  const output = await sharingPng(prepared);
  const decoded = await pixels(output.data);
  assert.equal(decoded.info.width, 16);
  assert.equal(decoded.info.height, 16);
  assert.equal(decoded.data[3], 0);
  const center = (8 * 16 + 8) * 4;
  assert.deepEqual(
    [...decoded.data.subarray(center, center + 4)],
    [255, 0, 0, 255],
  );
});

test("sharing SVG refuses active and external resources before decoding", async () => {
  const bad = [
    "<script>alert(1)</script>",
    '<foreignObject width="16" height="16"/>',
    '<image width="16" height="16"/>',
    '<image href="https://example.org/logo.png"/>',
    '<image href="file:///etc/passwd"/>',
    '<image href="//example.org/logo.png"/>',
    '<image src="https://example.org/logo.png"/>',
    '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>',
    '<image href="data:image/png;base64,AAAA"/>',
    '<image href="data:image/png;base64,AB=="/>',
    '<image href="&#104;ttps://example.org/logo.png"/>',
    '<image xlink:href="https://example.org/logo.png"/>',
    '<other:image href="https://example.org/logo.png"/>',
    '<rect style="fill:url(https://example.org/logo.svg)"/>',
    '<rect fill="url(https://example.org/logo.svg)"/>',
    '<rect fill="url(https://example.org/logo.svg#5a1887327b)"/>',
    '<rect fill="url/**/(https://example.org/logo.svg)"/>',
    '<rect fill="u\\72l(https://example.org/logo.svg)"/>',
    '<style>@import "https://example.org/style.css";</style>',
    '<rect onload="alert(1)"/>',
    '<rect fill="red" fill="blue"/>',
    "<rect fill=red/>",
    '<svg width="16" height="16"/>',
    '<?xml-stylesheet href="https://example.org/style.css"?>',
    '<![CDATA[<image href="https://example.org/logo.png"/>]]>',
    '<!DOCTYPE svg [<!ENTITY image SYSTEM "file:///etc/passwd">]>',
  ];
  for (const body of bad) {
    const svg = `${SVG_START} width="16" height="16">${body}</svg>`;
    await assert.rejects(prepareLogoInput(Buffer.from(svg), ".svg"));
  }
  const invalidUtf8 = Buffer.concat([
    Buffer.from(VECTOR.replace("</svg>", "")),
    Buffer.from([0xff]),
    Buffer.from("</svg>"),
  ]);
  await assert.rejects(prepareLogoInput(invalidUtf8, ".svg"), TypeError);
  const foreignNamespace = VECTOR.replace(
    "http://www.w3.org/2000/svg",
    "https://example.org/svg",
  );
  await assert.rejects(prepareLogoInput(Buffer.from(foreignNamespace), ".svg"));
});

test("sharing conversion enforces source, raster and SVG pixel bounds", async () => {
  await assert.rejects(prepareLogoInput(Buffer.alloc(0), ".png"));
  await assert.rejects(
    prepareLogoInput(Buffer.alloc(LOGO_SOURCE_LIMIT + 1), ".png"),
  );
  const hugeImage = sharp({
    create: {
      width: 4097,
      height: 4096,
      channels: 3,
      background: "white",
    },
    limitInputPixels: LOGO_PIXEL_LIMIT + 4096,
  });
  const huge = await hugeImage.png().toBuffer();
  await assert.rejects(prepareLogoInput(huge, ".png"));
  await assert.rejects(
    prepareLogoInput(Buffer.from(bitmapSvg(huge.toString("base64"))), ".svg"),
  );
  for (const dimensions of [
    'width="1000000000" height="1"',
    'width="-1" height="1"',
    'width="10%" height="10%"',
    'width="10"',
    'viewBox="0 0 4097 1"',
    'viewBox="0 0 NaN 1"',
  ]) {
    const svg = `${SVG_START} ${dimensions}></svg>`;
    await assert.rejects(prepareLogoInput(Buffer.from(svg), ".svg"));
  }
  const png = await redPng();
  const disguised = await sharp(png).jpeg().toBuffer();
  const normalized = await prepareLogoInput(disguised, ".png");
  assert.equal((await sharp(normalized).metadata()).format, "jpeg");
  await assert.rejects(
    prepareLogoInput(Buffer.from(VECTOR), ".png"),
    /raster signature/,
  );
  const manyImages = bitmapSvg(png.toString("base64"));
  const image = manyImages.match(/<image[^>]+\/>/u)![0];
  const svg = `${SVG_START} width="64" height="64">${image.repeat(33)}</svg>`;
  await assert.rejects(prepareLogoInput(Buffer.from(svg), ".svg"));
});

test("logo build publishes exact sharing identities and retains prior objects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "logo-sharing-build-"));
  try {
    const png = await redPng();
    const sources = new Map<string, Buffer>([
      ["mark.png", await rasterFixture("png")],
      ["legacy-name.png", await rasterFixture("jpeg")],
      ["photo.jpg", await rasterFixture("jpeg")],
      ["motion.gif", await rasterFixture("gif")],
      ["modern.webp", await rasterFixture("webp")],
      ["vector.svg", Buffer.from(VECTOR)],
      ["bitmap.svg", Buffer.from(bitmapSvg(png.toString("base64")))],
      ["favicon.ico", pngIco(png)],
    ]);
    for (const [name, data] of sources) {
      await writeFile(path.join(root, name), data);
    }
    const first = await writeDerivatives(root);
    assert.deepEqual(await checkDerivatives(root), first);
    const firstIdentity = await readIdentity(root);
    assert.equal(firstIdentity.version, 1);
    assert.match(firstIdentity.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(first.version, 2);
    assert.deepEqual(first.sharing, {
      version: 1,
      format: "png",
      max_dimension: 256,
      max_bytes: 524288,
    });
    assert.equal(first.entries.length, sources.size);
    for (const entry of first.entries) {
      const source = sources.get(entry.source_path)!;
      assert.equal(entry.source_sha256, sha256(source));
      assert.equal(entry.source_bytes, source.length);
      const sharing = await readFile(path.join(root, entry.sharing_path));
      assert.equal(entry.sharing_sha256, sha256(sharing));
      assert.equal(entry.sharing_bytes, sharing.length);
      const sourceHash = entry.source_sha256;
      const sharingHash = entry.sharing_sha256;
      const expected = `sharing/v1/${sourceHash}-${sharingHash}.png`;
      assert.equal(entry.sharing_path, expected);
      const decoded = await sharp(sharing).metadata();
      assert.equal(decoded.format, "png");
      assert.equal(decoded.width, entry.sharing_width);
      assert.equal(decoded.height, entry.sharing_height);
    }
    const mark = first.entries.find((row) => row.source_path === "mark.png")!;
    const markFile = path.join(root, mark.sharing_path);
    const retained = await readFile(markFile);
    const before = await stat(markFile, { bigint: true });
    assert.deepEqual(await writeDerivatives(root), first);
    assert.deepEqual(await readIdentity(root), firstIdentity);
    const after = await stat(markFile, { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs);
    const replacementImage = sharp(png).resize(320, 200);
    const replacement = await replacementImage.png().toBuffer();
    await writeFile(path.join(root, "mark.png"), replacement);
    await assert.rejects(checkDerivatives(root), /stale/);
    const second = await writeDerivatives(root);
    const next = second.entries.find((row) => row.source_path === "mark.png")!;
    assert.notEqual(next.source_sha256, mark.source_sha256);
    assert.notEqual(next.sharing_path, mark.sharing_path);
    assert.notEqual((await readIdentity(root)).sha256, firstIdentity.sha256);
    assert.deepEqual(await readFile(markFile), retained);
    assert.deepEqual(await checkDerivatives(root), second);
    const remaining = await readdir(root);
    const stages = remaining.filter((name) => name.startsWith(".display"));
    assert.deepEqual(stages, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed logo build preserves selected manifest and known-good sharing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "logo-sharing-failure-"));
  try {
    await writeFile(path.join(root, "good.png"), await rasterFixture("png"));
    const first = await writeDerivatives(root);
    const manifestFile = path.join(root, "display", "manifest.json");
    const before = await readFile(manifestFile);
    const identityFile = path.join(root, "display", IDENTITY);
    const beforeIdentity = await readFile(identityFile);
    const entry = first.entries[0];
    const sharingFile = path.join(root, entry.sharing_path);
    const sharing = await readFile(sharingFile);
    const displayFile = path.join(root, "display", entry.display_path);
    const display = await readFile(displayFile);
    await writeFile(path.join(root, "broken.svg"), Buffer.from("<svg>"));
    await assert.rejects(writeDerivatives(root));
    assert.deepEqual(await readFile(manifestFile), before);
    assert.deepEqual(await readFile(identityFile), beforeIdentity);
    assert.deepEqual(await readFile(sharingFile), sharing);
    assert.deepEqual(await readFile(displayFile), display);
    await rm(path.join(root, "broken.svg"));
    await mkdir(path.join(root, "sharing", "v1"), { recursive: true });
    await writeFile(path.join(root, "sharing", "v1", "retained.png"), sharing);
    assert.deepEqual(await checkDerivatives(root), first);
    await writeFile(path.join(root, "good.svg"), VECTOR);
    await assert.rejects(writeDerivatives(root), /collide/);
    assert.deepEqual(await readFile(manifestFile), before);
    await rm(path.join(root, "good.svg"));
    for (const unsupported of ["Logo.PNG", "brand_mark.png"]) {
      await writeFile(path.join(root, unsupported), "not an image");
      await assert.rejects(writeDerivatives(root), /source path/);
      assert.deepEqual(await readFile(manifestFile), before);
      await rm(path.join(root, unsupported));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("logo checker rejects altered sharing bytes, identities and dimensions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "logo-sharing-check-"));
  try {
    await writeFile(path.join(root, "good.png"), await rasterFixture("png"));
    const manifest = await writeDerivatives(root);
    const manifestFile = path.join(root, "display", "manifest.json");
    const original = await readFile(manifestFile);
    for (const patch of [
      { sharing_path: "../outside.png" },
      { sharing_sha256: "f".repeat(64) },
      { sharing_bytes: 1 },
      { sharing_width: 0 },
      { sharing_height: 257 },
    ]) {
      const altered = structuredClone(manifest);
      Object.assign(altered.entries[0], patch);
      await writeFile(manifestFile, JSON.stringify(altered));
      await assert.rejects(checkDerivatives(root));
    }
    await writeFile(manifestFile, original);
    await writeFile(path.join(root, manifest.entries[0].sharing_path), "bad");
    await assert.rejects(checkDerivatives(root));
    await assert.rejects(writeDerivatives(root), /immutable/);
    assert.deepEqual(await readFile(manifestFile), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("logo build upgrades a display-only manifest without changing originals", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "logo-sharing-upgrade-"));
  try {
    const source = await rasterFixture("png");
    const sourceFile = path.join(root, "good.png");
    await writeFile(sourceFile, source);
    const first = await writeDerivatives(root);
    const entry = first.entries[0];
    const legacy = {
      version: 1,
      format: "webp",
      max_dimension: 96,
      quality: 90,
      entries: [
        {
          source_path: entry.source_path,
          source_sha256: entry.source_sha256,
          source_bytes: entry.source_bytes,
          display_path: entry.display_path,
          display_sha256: entry.display_sha256,
          display_bytes: entry.display_bytes,
          width: entry.width,
          height: entry.height,
        },
      ],
    };
    const manifestFile = path.join(root, "display", "manifest.json");
    await writeFile(manifestFile, JSON.stringify(legacy));
    await assert.rejects(checkDerivatives(root), /settings/);
    const upgraded = await writeDerivatives(root);
    assert.deepEqual(upgraded, first);
    assert.deepEqual(await readFile(sourceFile), source);
    assert.deepEqual(await checkDerivatives(root), upgraded);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("logo build repairs missing outputs with the same source identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "logo-sharing-repair-"));
  try {
    await writeFile(path.join(root, "good.png"), await rasterFixture("png"));
    const first = await writeDerivatives(root);
    const entry = first.entries[0];
    await rm(path.join(root, entry.sharing_path));
    await rm(path.join(root, "display", entry.display_path));
    await assert.rejects(checkDerivatives(root));
    assert.deepEqual(await writeDerivatives(root), first);
    assert.deepEqual(await checkDerivatives(root), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sharing identity repairs missing indexes and refuses stale or linked indexes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "logo-sharing-identity-"));
  try {
    await writeFile(path.join(root, "good.png"), await rasterFixture("png"));
    const first = await writeDerivatives(root);
    const file = path.join(root, "display", IDENTITY);
    const expected = await readFile(file);
    const manifestFile = path.join(root, "display", "manifest.json");
    const manifest = await readFile(manifestFile);
    await rm(file);
    await assert.rejects(checkDerivatives(root));
    assert.deepEqual(await writeDerivatives(root), first);
    assert.deepEqual(await readFile(file), expected);
    assert.deepEqual(await readFile(manifestFile), manifest);
    const stale = { version: 1, sha256: "0".repeat(64) };
    await writeFile(file, JSON.stringify(stale));
    await assert.rejects(checkDerivatives(root), /identity/);
    const extra = { ...JSON.parse(expected.toString("utf8")), x: 1 };
    await writeFile(file, JSON.stringify(extra));
    await assert.rejects(checkDerivatives(root), /identity/);
    await writeDerivatives(root);
    assert.deepEqual(await readFile(file), expected);
    const sentinel = path.join(root, "sentinel.json");
    await writeFile(sentinel, expected);
    await rm(file);
    await symlink(sentinel, file, "file");
    await assert.rejects(checkDerivatives(root), /symlink/);
    await assert.rejects(writeDerivatives(root), /symlink/);
    assert.deepEqual(await readFile(sentinel), expected);
    assert.deepEqual(await readFile(manifestFile), manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sharing release identity binds verified output bytes with unchanged originals", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "logo-sharing-output-id-"));
  try {
    const original = await rasterFixture("png");
    const source = path.join(root, "good.png");
    await writeFile(source, original);
    const manifest = await writeDerivatives(root);
    const before = await readIdentity(root);
    const entry = manifest.entries[0];
    const file = path.join(root, entry.sharing_path);
    const image = sharp(await readFile(file));
    const alternate = await image.png({ compressionLevel: 0 }).toBuffer();
    const outputHash = sha256(alternate);
    assert.notEqual(outputHash, entry.sharing_sha256);
    entry.sharing_sha256 = outputHash;
    entry.sharing_bytes = alternate.byteLength;
    entry.sharing_path = `sharing/v1/${entry.source_sha256}-${outputHash}.png`;
    await writeFile(path.join(root, entry.sharing_path), alternate);
    const manifestFile = path.join(root, "display", "manifest.json");
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(checkDerivatives(root), /identity/);
    await writeDerivatives(root);
    assert.notEqual((await readIdentity(root)).sha256, before.sha256);
    assert.deepEqual(await readFile(source), original);
    assert.deepEqual(await checkDerivatives(root), manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("logo build refuses generated symlinks without writing outside its root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "logo-sharing-links-"));
  const outside = await mkdtemp(path.join(tmpdir(), "logo-sharing-outside-"));
  try {
    await writeFile(path.join(root, "good.png"), await rasterFixture("png"));
    const manifest = await writeDerivatives(root);
    const manifestFile = path.join(root, "display", "manifest.json");
    const selected = await readFile(manifestFile);
    const sharing = path.join(root, "sharing");
    await rm(sharing, { recursive: true });
    await symlink(outside, sharing, "dir");
    await assert.rejects(writeDerivatives(root), /symlink/);
    assert.deepEqual(await readFile(manifestFile), selected);
    assert.deepEqual(await readdir(outside), []);
    await rm(sharing);
    await mkdir(sharing);
    await symlink(outside, path.join(sharing, "v1"), "dir");
    await assert.rejects(writeDerivatives(root), /symlink/);
    assert.deepEqual(await readFile(manifestFile), selected);
    assert.deepEqual(await readdir(outside), []);
    await rm(path.join(sharing, "v1"));
    await mkdir(path.join(sharing, "v1"));
    const sentinel = path.join(outside, "sentinel.png");
    await writeFile(sentinel, "retained external bytes");
    const output = path.join(root, manifest.entries[0].sharing_path);
    await symlink(sentinel, output, "file");
    await assert.rejects(writeDerivatives(root), /symlink/);
    assert.deepEqual(await readFile(manifestFile), selected);
    assert.equal(await readFile(sentinel, "utf8"), "retained external bytes");
    assert.deepEqual(await readdir(outside), ["sentinel.png"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
