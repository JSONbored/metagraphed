import { lstat, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  jsonBytes,
  readReleaseJournal,
  RELEASE_JOURNAL_KEY,
  type ReleaseStore,
} from "./artifact-release-commit.ts";
import { hashJson, sha256Hex } from "./lib.ts";
import {
  IMAGE_PATHS,
  manifestArtifacts,
  parseRecord,
  verifyImageSource,
  type ImageSource,
  type ImageRenderReceipt,
} from "./og-image-release-plan.ts";

export async function captureImageSource(
  store: ReleaseStore,
): Promise<ImageSource> {
  const pointer = await store.getPointer();
  if (await store.get(RELEASE_JOURNAL_KEY)) {
    const journal = await readReleaseJournal(store);
    if (
      journal.state !== "committed" ||
      journal.head_hash !== hashJson(pointer)
    )
      throw new Error(
        "Source capture requires a settled journal and matching visible pointer.",
      );
  }
  if (
    typeof pointer.run_prefix !== "string" ||
    !/^runs\/[A-Za-z0-9_-]+\/$/.test(pointer.run_prefix) ||
    pointer.full_manifest_run_key !== `${pointer.run_prefix}r2-manifest.json`
  )
    throw new Error("Invalid source release prefix.");
  const get = async (key: string) => {
    const object = await store.get(key);
    if (!object) throw new Error(`Source object missing: ${key}`);
    return object.bytes;
  };
  const full = await get(pointer.full_manifest_run_key as string);
  const compact = await get(`${pointer.run_prefix}r2-manifest.compact.json`);
  const buildSummary = await get(`${pointer.run_prefix}build-summary.json`);
  const summaryEntry = manifestArtifacts(
    parseRecord(full, 8 * 1024 * 1024, "Full manifest"),
  ).find((entry) => entry.path === "/metagraph/registry-summary.json");
  if (!summaryEntry || !/^by-hash\/[a-f0-9]{64}$/.test(summaryEntry.key))
    throw new Error("Source summary must be content-addressed.");
  const summary = await get(summaryEntry.key);
  const source = { pointer, full, compact, buildSummary, summary };
  verifyImageSource(source);
  return source;
}

const SOURCE_FILES = {
  full: "full-manifest.json",
  compact: "compact-manifest.json",
  buildSummary: "build-summary.json",
  summary: "registry-summary.json",
} as const;
export async function writeImageSource(
  directory: string,
  source: ImageSource,
): Promise<void> {
  await mkdir(directory, { recursive: false });
  const digests: Record<string, string> = {};
  for (const [field, name] of Object.entries(SOURCE_FILES)) {
    const bytes = source[field as keyof typeof SOURCE_FILES];
    await writeFile(path.join(directory, name), bytes, { flag: "wx" });
    digests[field] = sha256Hex(bytes);
  }
  await writeFile(
    path.join(directory, "source.json"),
    jsonBytes({ schema_version: 1, pointer: source.pointer, sha256: digests }),
    { flag: "wx" },
  );
}
export async function readLocalFile(
  directory: string,
  name: string,
  limit = 8 * 1024 * 1024,
): Promise<Buffer> {
  const file = path.join(directory, name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error(`Unsafe or oversized release input: ${name}`);
  return readFile(file);
}
export async function readImageSource(directory: string): Promise<ImageSource> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Release input directory must not be a symlink.");
  const receipt = parseRecord(
    await readLocalFile(directory, "source.json", 64 * 1024),
    64 * 1024,
    "Source receipt",
  );
  const fields: Record<string, Uint8Array> = {};
  for (const [field, name] of Object.entries(SOURCE_FILES)) {
    const bytes = await readLocalFile(directory, name);
    if (
      sha256Hex(bytes) !== (receipt.sha256 as Record<string, string>)?.[field]
    )
      throw new Error(`Source receipt digest mismatch: ${field}`);
    fields[field] = bytes;
  }
  const source = { pointer: receipt.pointer, ...fields } as ImageSource;
  verifyImageSource(source);
  return source;
}
export async function readImageRender(directory: string) {
  const files = await readdir(directory, { withFileTypes: true });
  if (
    files.some(
      (entry) =>
        entry.isSymbolicLink() ||
        entry.isDirectory() ||
        (entry.name.includes(".png") &&
          !IMAGE_PATHS.some((allowed) => allowed.endsWith("/" + entry.name))),
    )
  )
    throw new Error(
      "Unexpected image file, nested directory or symlink in release bundle.",
    );
  const receipt = JSON.parse(
    (await readLocalFile(directory, "render.json", 64 * 1024)).toString(),
  ) as ImageRenderReceipt;
  const pngs: Record<string, Uint8Array> = {};
  for (const imagePath of IMAGE_PATHS)
    pngs[imagePath] = await readLocalFile(
      directory,
      path.basename(imagePath),
      2 * 1024 * 1024,
    );
  return { receipt, pngs };
}
