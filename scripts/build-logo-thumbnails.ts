import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { repoRoot, stableStringify } from "./lib.ts";

/**
 * Display-sized first-party brand marks (#11740).
 *
 * BrandIcon renders these sources at 20–40 CSS pixels, but many originals are
 * 1,000–2,768px and cost hundreds of kilobytes apiece. Originals remain the
 * canonical registry/social-image assets. This builds a transparent 96px WebP
 * derivative for UI use and records source + output hashes so CI can detect a
 * newly added, changed, missing, or stale derivative without relying on
 * platform-specific encoder byte identity.
 */

const LOGO_ROOT_REL = "apps/ui/public/logos";
const DISPLAY_DIR_NAME = "display";
const MANIFEST_NAME = "manifest.json";
const MAX_DIMENSION = 96;
const WEBP_QUALITY = 90;
const SUPPORTED_EXTENSIONS = new Set([
  ".gif",
  ".ico",
  ".jpg",
  ".jpeg",
  ".png",
  ".svg",
  ".webp",
]);

interface DisplayLogoEntry {
  source_path: string;
  source_sha256: string;
  source_bytes: number;
  display_path: string;
  display_sha256: string;
  display_bytes: number;
  width: number;
  height: number;
}

interface DisplayLogoManifest {
  version: 1;
  format: "webp";
  max_dimension: number;
  quality: number;
  entries: DisplayLogoEntry[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function posixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function collectFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!relative && entry.name === DISPLAY_DIR_NAME) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(root, child)));
    else if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(posixPath(child));
    }
  }
  return files.sort();
}

function displayPathFor(sourcePath: string): string {
  return sourcePath.replace(/\.[^.]+$/u, ".webp");
}

async function buildOne(
  logoRoot: string,
  sourcePath: string,
): Promise<DisplayLogoEntry> {
  const sourceFile = path.join(logoRoot, sourcePath);
  const source = await readFile(sourceFile);
  const displayPath = displayPathFor(sourcePath);
  const displayFile = path.join(logoRoot, DISPLAY_DIR_NAME, displayPath);
  const { data, info } = await sharp(source, {
    animated: false,
    limitInputPixels: 16_777_216,
  })
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({
      quality: WEBP_QUALITY,
      alphaQuality: 100,
      effort: 6,
      smartSubsample: true,
    })
    .toBuffer({ resolveWithObject: true });

  await mkdir(path.dirname(displayFile), { recursive: true });
  await writeFile(displayFile, data);
  return {
    source_path: sourcePath,
    source_sha256: sha256(source),
    source_bytes: source.byteLength,
    display_path: displayPath,
    display_sha256: sha256(data),
    display_bytes: data.byteLength,
    width: info.width,
    height: info.height,
  };
}

async function writeDerivatives(): Promise<void> {
  const logoRoot = path.join(repoRoot, LOGO_ROOT_REL);
  const displayRoot = path.join(logoRoot, DISPLAY_DIR_NAME);
  const sources = await collectFiles(logoRoot);

  // Generated-only and exactly scoped: stale derivatives must not accumulate
  // after a source is renamed or removed.
  await rm(displayRoot, { recursive: true, force: true });
  await mkdir(displayRoot, { recursive: true });

  const entries: DisplayLogoEntry[] = [];
  for (const source of sources) entries.push(await buildOne(logoRoot, source));
  const manifest: DisplayLogoManifest = {
    version: 1,
    format: "webp",
    max_dimension: MAX_DIMENSION,
    quality: WEBP_QUALITY,
    entries,
  };
  await writeFile(
    path.join(displayRoot, MANIFEST_NAME),
    `${stableStringify(manifest)}\n`,
  );

  const sourceBytes = entries.reduce(
    (sum, entry) => sum + entry.source_bytes,
    0,
  );
  const displayBytes = entries.reduce(
    (sum, entry) => sum + entry.display_bytes,
    0,
  );
  console.log(
    `logo thumbnails: ${entries.length} marks, ${sourceBytes} -> ${displayBytes} bytes ` +
      `(${((displayBytes / Math.max(1, sourceBytes)) * 100).toFixed(1)}%)`,
  );
}

function readManifest(manifestFile: string): DisplayLogoManifest {
  return JSON.parse(readFileSync(manifestFile, "utf8")) as DisplayLogoManifest;
}

async function checkDerivatives(): Promise<void> {
  const logoRoot = path.join(repoRoot, LOGO_ROOT_REL);
  const displayRoot = path.join(logoRoot, DISPLAY_DIR_NAME);
  const manifestFile = path.join(displayRoot, MANIFEST_NAME);
  const manifest = readManifest(manifestFile);
  if (
    manifest.version !== 1 ||
    manifest.format !== "webp" ||
    manifest.max_dimension !== MAX_DIMENSION ||
    manifest.quality !== WEBP_QUALITY
  ) {
    throw new Error(
      "logo thumbnail manifest settings do not match the builder",
    );
  }

  const sources = await collectFiles(logoRoot);
  const recordedSources = manifest.entries.map((entry) => entry.source_path);
  if (stableStringify(sources) !== stableStringify(recordedSources)) {
    throw new Error("logo thumbnail manifest source list is stale; rebuild it");
  }

  const recordedOutputs = new Set<string>();
  let sourceBytes = 0;
  let displayBytes = 0;
  for (const entry of manifest.entries) {
    const source = await readFile(path.join(logoRoot, entry.source_path));
    if (
      sha256(source) !== entry.source_sha256 ||
      source.byteLength !== entry.source_bytes
    ) {
      throw new Error(`stale logo thumbnail source: ${entry.source_path}`);
    }

    const expectedDisplayPath = displayPathFor(entry.source_path);
    if (
      entry.display_path !== expectedDisplayPath ||
      recordedOutputs.has(entry.display_path)
    ) {
      throw new Error(`invalid logo thumbnail path: ${entry.display_path}`);
    }
    recordedOutputs.add(entry.display_path);

    const displayFile = path.join(displayRoot, entry.display_path);
    const display = await readFile(displayFile);
    const metadata = await sharp(display).metadata();
    if (
      sha256(display) !== entry.display_sha256 ||
      display.byteLength !== entry.display_bytes ||
      metadata.format !== "webp" ||
      metadata.width !== entry.width ||
      metadata.height !== entry.height ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_DIMENSION ||
      metadata.height > MAX_DIMENSION
    ) {
      throw new Error(`invalid or stale logo thumbnail: ${entry.display_path}`);
    }
    sourceBytes += source.byteLength;
    displayBytes += display.byteLength;
  }

  const actualOutputs = (await collectFiles(displayRoot)).map(displayPathFor);
  if (
    stableStringify([...recordedOutputs].sort()) !==
    stableStringify(actualOutputs)
  ) {
    throw new Error(
      "logo thumbnail output directory contains stale or missing files",
    );
  }
  if (displayBytes >= sourceBytes) {
    throw new Error("logo thumbnails do not reduce aggregate source bytes");
  }

  console.log(
    `logo thumbnails valid: ${manifest.entries.length} marks, ${sourceBytes} -> ${displayBytes} bytes`,
  );
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "--write") await writeDerivatives();
  else if (mode === "--check") await checkDerivatives();
  else throw new Error("usage: build-logo-thumbnails.ts --write|--check");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
