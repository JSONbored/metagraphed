import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { isOgLogoSourcePath } from "../src/og-logo-path.ts";
import { repoRoot, stableStringify } from "./lib.ts";
import {
  LOGO_PIXEL_LIMIT,
  LOGO_SOURCE_LIMIT,
  prepareLogoInput,
  SHARING_BYTE_LIMIT,
  SHARING_DIMENSION,
  sharingPng,
} from "./logo-sharing-image.ts";

/**
 * Display-sized first-party brand marks (#11740).
 *
 * BrandIcon renders these sources at 20–40 CSS pixels, but many originals are
 * 1,000–2,768px and cost hundreds of kilobytes apiece. Originals remain the
 * canonical registry assets. Build transparent 96px WebP display marks and
 * bounded PNG sharing marks, retaining exact source and derivative identities.
 */

const LOGO_ROOT_REL = "apps/ui/public/logos";
const DISPLAY_DIR_NAME = "display";
const MANIFEST_NAME = "manifest.json";
const MAX_DIMENSION = 96;
const WEBP_QUALITY = 90;
const SHARING_POLICY = {
  version: 1,
  format: "png",
  max_dimension: SHARING_DIMENSION,
  max_bytes: SHARING_BYTE_LIMIT,
} as const;
const SUPPORTED_EXTENSIONS = new Set([
  ".gif",
  ".ico",
  ".jpg",
  ".jpeg",
  ".png",
  ".svg",
  ".webp",
]);

class LogoOutputSymlink extends Error {}

export interface DisplayLogoEntry {
  source_path: string;
  source_sha256: string;
  source_bytes: number;
  display_path: string;
  display_sha256: string;
  display_bytes: number;
  width: number;
  height: number;
  sharing_path: string;
  sharing_sha256: string;
  sharing_bytes: number;
  sharing_width: number;
  sharing_height: number;
}

export interface DisplayLogoManifest {
  version: 2;
  format: "webp";
  max_dimension: number;
  quality: number;
  sharing: typeof SHARING_POLICY;
  entries: DisplayLogoEntry[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function posixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function collectFiles(
  root: string,
  relative = "",
  sources = true,
): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error("Logo symlinks are unsupported");
    }
    if (
      sources &&
      !relative &&
      (entry.name === DISPLAY_DIR_NAME ||
        entry.name === "sharing" ||
        entry.name.startsWith(".display-build-"))
    ) {
      continue;
    }
    const child = path.join(relative, entry.name);
    const extension = path.extname(entry.name).toLowerCase();
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, child, sources)));
    } else if (SUPPORTED_EXTENSIONS.has(extension)) {
      const relativePath = posixPath(child);
      if (sources && !isOgLogoSourcePath(relativePath)) {
        throw new Error(`Unsupported logo source path: ${relativePath}`);
      }
      files.push(relativePath);
    }
  }
  return files.sort();
}

function displayPathFor(sourcePath: string): string {
  return sourcePath.replace(/\.[^.]+$/u, ".webp");
}

async function generatedPath(logoRoot: string, relative: string) {
  let target = logoRoot;
  for (const part of relative.split("/")) {
    target = path.join(target, part);
    try {
      if ((await lstat(target)).isSymbolicLink()) {
        throw new LogoOutputSymlink("Logo output symlinks are unsupported");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

async function buildOne(sourcePath: string, source: Buffer) {
  const extension = path.extname(sourcePath).toLowerCase();
  const input = await prepareLogoInput(source, extension);
  const displayPath = displayPathFor(sourcePath);
  const { data, info } = await sharp(input, {
    animated: false,
    limitInputPixels: LOGO_PIXEL_LIMIT,
  })
    .timeout({ seconds: 3 })
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

  const sharing = await sharingPng(input);
  const sourceHash = sha256(source);
  const sharingHash = sha256(sharing.data);
  const entry: DisplayLogoEntry = {
    source_path: sourcePath,
    source_sha256: sourceHash,
    source_bytes: source.byteLength,
    display_path: displayPath,
    display_sha256: sha256(data),
    display_bytes: data.byteLength,
    width: info.width,
    height: info.height,
    sharing_path: `sharing/v1/${sourceHash}-${sharingHash}.png`,
    sharing_sha256: sharingHash,
    sharing_bytes: sharing.data.byteLength,
    sharing_width: sharing.width,
    sharing_height: sharing.height,
  };
  return { entry, display: data, sharing: sharing.data };
}

function currentManifest(value: DisplayLogoManifest): boolean {
  return (
    value.version === 2 &&
    value.format === "webp" &&
    value.max_dimension === MAX_DIMENSION &&
    value.quality === WEBP_QUALITY &&
    stableStringify(value.sharing) === stableStringify(SHARING_POLICY) &&
    Array.isArray(value.entries)
  );
}

async function readManifest(file: string): Promise<DisplayLogoManifest> {
  return JSON.parse(await readFile(file, "utf8")) as DisplayLogoManifest;
}

async function verifiedOutputs(logoRoot: string, entry: DisplayLogoEntry) {
  const hash = /^[0-9a-f]{64}$/u;
  const sourceHash = entry.source_sha256;
  const sharingHash = entry.sharing_sha256;
  const expectedSharing = `sharing/v1/${sourceHash}-${sharingHash}.png`;
  if (
    !hash.test(entry.source_sha256) ||
    !hash.test(entry.display_sha256) ||
    !hash.test(entry.sharing_sha256) ||
    entry.display_path !== displayPathFor(entry.source_path) ||
    entry.sharing_path !== expectedSharing ||
    !Number.isSafeInteger(entry.source_bytes) ||
    entry.source_bytes < 1 ||
    entry.source_bytes > LOGO_SOURCE_LIMIT
  ) {
    throw new Error(`Invalid logo derivative identity: ${entry.source_path}`);
  }
  const displayFile = await generatedPath(
    logoRoot,
    `${DISPLAY_DIR_NAME}/${entry.display_path}`,
  );
  const sharingFile = await generatedPath(logoRoot, entry.sharing_path);
  const display = await readFile(displayFile);
  const sharing = await readFile(sharingFile);
  for (const output of [
    {
      data: display,
      hash: entry.display_sha256,
      bytes: entry.display_bytes,
      width: entry.width,
      height: entry.height,
      format: "webp",
      limit: MAX_DIMENSION,
    },
    {
      data: sharing,
      hash: entry.sharing_sha256,
      bytes: entry.sharing_bytes,
      width: entry.sharing_width,
      height: entry.sharing_height,
      format: "png",
      limit: SHARING_DIMENSION,
    },
  ]) {
    const metadata = await sharp(output.data, {
      limitInputPixels: LOGO_PIXEL_LIMIT,
    }).metadata();
    if (
      sha256(output.data) !== output.hash ||
      output.data.byteLength !== output.bytes ||
      metadata.format !== output.format ||
      metadata.width !== output.width ||
      metadata.height !== output.height ||
      !Number.isSafeInteger(output.width) ||
      !Number.isSafeInteger(output.height) ||
      output.width < 1 ||
      output.height < 1 ||
      output.width > output.limit ||
      output.height > output.limit ||
      (output.format === "png" && output.bytes > SHARING_BYTE_LIMIT)
    ) {
      throw new Error(`Invalid logo derivative bytes: ${entry.source_path}`);
    }
  }
  return { entry, display, sharing };
}

/** Publish immutable PNGs before atomically selecting the display manifest. */
export async function writeDerivatives(
  logoRoot = path.join(repoRoot, LOGO_ROOT_REL),
): Promise<DisplayLogoManifest> {
  const displayRoot = path.join(logoRoot, DISPLAY_DIR_NAME);
  const sources = await collectFiles(logoRoot);
  const paths = sources.map(displayPathFor);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Logo sources collide on a display derivative path");
  }
  const manifestFile = await generatedPath(
    logoRoot,
    `${DISPLAY_DIR_NAME}/${MANIFEST_NAME}`,
  );
  await generatedPath(logoRoot, "sharing/v1");
  let previous: DisplayLogoManifest | undefined;
  try {
    const candidate = await readManifest(manifestFile);
    if (currentManifest(candidate)) previous = candidate;
  } catch {
    // Missing/old manifests are rebuilt; no existing output is removed first.
  }
  const stage = await mkdtemp(path.join(logoRoot, ".display-build-"));
  const stagedDisplay = path.join(stage, "display");
  const backup = path.join(stage, "previous");
  const entries: DisplayLogoEntry[] = [];
  let preserveBackup = false;
  try {
    await mkdir(stagedDisplay);
    const pngs = new Map<string, Buffer>();
    for (const sourcePath of sources) {
      const source = await readFile(path.join(logoRoot, sourcePath));
      const prior = previous?.entries.find(
        (entry) => entry.source_path === sourcePath,
      );
      let built;
      if (
        prior?.source_sha256 === sha256(source) &&
        prior.source_bytes === source.byteLength
      ) {
        try {
          built = await verifiedOutputs(logoRoot, prior);
        } catch (error) {
          if (error instanceof LogoOutputSymlink) throw error;
          // Corrupt/missing derivatives cannot qualify for reuse.
        }
      }
      built ??= await buildOne(sourcePath, source);
      const displayFile = path.join(stagedDisplay, built.entry.display_path);
      await mkdir(path.dirname(displayFile), { recursive: true });
      await writeFile(displayFile, built.display);
      pngs.set(built.entry.sharing_path, built.sharing);
      entries.push(built.entry);
    }
    const manifest: DisplayLogoManifest = {
      version: 2,
      format: "webp",
      max_dimension: MAX_DIMENSION,
      quality: WEBP_QUALITY,
      sharing: SHARING_POLICY,
      entries,
    };
    await writeFile(
      path.join(stagedDisplay, MANIFEST_NAME),
      `${stableStringify(manifest)}\n`,
    );
    for (const [relative, data] of pngs) {
      const target = await generatedPath(logoRoot, relative);
      const temporary = path.join(stage, path.basename(relative));
      await writeFile(temporary, data);
      await mkdir(path.dirname(target), { recursive: true });
      try {
        // Hard-link publication exposes complete bytes without overwriting.
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readFile(target);
        if (!existing.equals(data)) {
          throw new Error(`Conflicting immutable sharing logo: ${relative}`, {
            cause: error,
          });
        }
      }
    }
    let hadDisplay = false;
    try {
      await rename(displayRoot, backup);
      hadDisplay = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(stagedDisplay, displayRoot);
    } catch (error) {
      if (hadDisplay) {
        preserveBackup = true;
        await rename(backup, displayRoot);
        preserveBackup = false;
      }
      throw error;
    }
    return manifest;
  } finally {
    // Preserve a backup after failed rollback; retain prior sharing objects.
    if (!preserveBackup) {
      try {
        await rm(stage, { recursive: true, force: true });
      } catch (error) {
        // Cleanup must not replace a build/publish/rollback failure.
        console.warn(`Logo staging cleanup failed: ${stage}`, error);
      }
    }
  }
}

export async function checkDerivatives(
  logoRoot = path.join(repoRoot, LOGO_ROOT_REL),
): Promise<DisplayLogoManifest> {
  const displayRoot = path.join(logoRoot, DISPLAY_DIR_NAME);
  const manifestFile = await generatedPath(
    logoRoot,
    `${DISPLAY_DIR_NAME}/${MANIFEST_NAME}`,
  );
  const manifest = await readManifest(manifestFile);
  if (!currentManifest(manifest)) {
    throw new Error("Logo thumbnail manifest settings do not match builder");
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

    const { display } = await verifiedOutputs(logoRoot, entry);
    sourceBytes += source.byteLength;
    displayBytes += display.byteLength;
  }

  const actualOutputs = await collectFiles(displayRoot, "", false);
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
  return manifest;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "--write") {
    const manifest = await writeDerivatives();
    const sourceBytes = manifest.entries.reduce(
      (sum, entry) => sum + entry.source_bytes,
      0,
    );
    const displayBytes = manifest.entries.reduce(
      (sum, entry) => sum + entry.display_bytes,
      0,
    );
    console.log(
      `logo thumbnails: ${manifest.entries.length} marks, ` +
        `${sourceBytes} -> ${displayBytes} display bytes`,
    );
  } else if (mode === "--check") await checkDerivatives();
  else throw new Error("usage: build-logo-thumbnails.ts --write|--check");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
