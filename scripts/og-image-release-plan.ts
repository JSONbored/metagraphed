import { CARD_VERSION, OG_IMAGE_FILE_NAMES } from "../src/og-card-version.ts";
import { inflateSync } from "node:zlib";
import { CARD_FONT_FACES } from "../src/og-card-fonts.ts";
import { hashJson, sha256Hex } from "./lib.ts";
import {
  jsonObject,
  type ReleaseOperation,
  type ReleasePointer,
} from "./artifact-release-commit.ts";

export type JsonRecord = Record<string, unknown>;
export interface ImageArtifact extends JsonRecord {
  path: string;
  key: string;
  latest_key: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  storage_tier: string;
}
export interface ImageSource {
  pointer: ReleasePointer;
  full: Uint8Array;
  compact: Uint8Array;
  buildSummary: Uint8Array;
  summary: Uint8Array;
}
export interface ImageRenderReceipt {
  status: "rendered";
  renderer_version: string;
  renderer_revision: string;
  source_sha256: string;
  fonts: { name: string; weight: number; sha256: string; size_bytes: number }[];
  artifacts: {
    path: string;
    sha256: string;
    size_bytes: number;
    content_type: "image/png";
    width: 1200;
    height: 630;
  }[];
}
export const IMAGE_PATHS = OG_IMAGE_FILE_NAMES.map(
  (name) => `/metagraph/${name}`,
);
export function parseRecord(
  bytes: Uint8Array,
  limit: number,
  label: string,
): JsonRecord {
  if (!bytes.length || bytes.length > limit)
    throw new Error(`${label} size out of bounds.`);
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}
export function manifestArtifacts(manifest: JsonRecord): ImageArtifact[] {
  if (!Array.isArray(manifest.artifacts))
    throw new Error("Manifest artifact list missing.");
  const seen = new Set<string>();
  for (const value of manifest.artifacts) {
    const entry = value as ImageArtifact;
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith("/metagraph/") ||
      seen.has(entry.path) ||
      !Number.isSafeInteger(entry.size_bytes) ||
      entry.size_bytes < 0 ||
      typeof entry.storage_tier !== "string"
    )
      throw new Error("Invalid or duplicate manifest artifact.");
    seen.add(entry.path);
  }
  return manifest.artifacts as ImageArtifact[];
}
export function verifyPng(bytes: Uint8Array): void {
  const b = Buffer.from(bytes);
  if (
    b.length < 33 ||
    b.length > 2 * 1024 * 1024 ||
    b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    b.toString("ascii", 12, 16) !== "IHDR" ||
    b.readUInt32BE(16) !== 1200 ||
    b.readUInt32BE(20) !== 630
  )
    throw new Error("Expected a bounded 1200×630 PNG.");
  const crc = (chunk: Uint8Array) => {
    let value = 0xffffffff;
    for (const byte of chunk) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[
    b[25]
  ];
  if (b[24] !== 8 || !channels || b[26] !== 0 || b[27] !== 0 || b[28] !== 0)
    throw new Error("Unsupported PNG encoding.");
  const data: Buffer[] = [];
  let offset = 8;
  let ended = false;
  while (offset + 12 <= b.length) {
    const size = b.readUInt32BE(offset);
    if (
      offset + size + 12 > b.length ||
      crc(b.subarray(offset + 4, offset + 8 + size)) !==
        b.readUInt32BE(offset + 8 + size)
    )
      throw new Error("Corrupt PNG chunk.");
    const type = b.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") data.push(b.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== b.length || !data.length)
    throw new Error("Incomplete PNG.");
  const rowSize = 1200 * channels + 1;
  const pixels = inflateSync(Buffer.concat(data), {
    maxOutputLength: rowSize * 630,
  });
  if (pixels.length !== rowSize * 630)
    throw new Error("Invalid PNG pixel extent.");
  for (let row = 0; row < 630; row++)
    if (pixels[row * rowSize] > 4) throw new Error("Invalid PNG row filter.");
}
export function verifyArtifact(entry: ImageArtifact, bytes: Uint8Array): void {
  if (
    !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    entry.key !== `by-hash/${entry.sha256}` ||
    entry.size_bytes !== bytes.length ||
    entry.sha256 !== sha256Hex(bytes)
  )
    throw new Error(`Content-addressed artifact mismatch: ${entry.path}`);
}
export function verifyImageSource(source: ImageSource) {
  const full = parseRecord(source.full, 8 * 1024 * 1024, "Full manifest");
  const compact = parseRecord(
    source.compact,
    8 * 1024 * 1024,
    "Compact manifest",
  );
  parseRecord(source.buildSummary, 1024 * 1024, "Build summary");
  const summary = parseRecord(source.summary, 1024 * 1024, "Registry summary");
  const pointer = source.pointer;
  if (
    typeof pointer.run_prefix !== "string" ||
    !/^runs\/[A-Za-z0-9_-]+\/$/.test(pointer.run_prefix) ||
    pointer.full_manifest_run_key !== `${pointer.run_prefix}r2-manifest.json` ||
    compact.full_manifest_run_key !== pointer.full_manifest_run_key ||
    compact.run_prefix !== pointer.run_prefix ||
    full.run_prefix !== pointer.run_prefix ||
    hashJson(compact) !== pointer.manifest_hash ||
    full.contract_version !== pointer.contract_version ||
    compact.contract_version !== pointer.contract_version
  )
    throw new Error("Source controls do not bind the identified base pointer.");
  const entries = manifestArtifacts(full);
  manifestArtifacts(compact);
  const entry = entries.find(
    (item) => item.path === "/metagraph/registry-summary.json",
  );
  if (!entry)
    throw new Error("Active source summary is absent from the full manifest.");
  verifyArtifact(entry, source.summary);
  // A partial, malformed or absent summary must not become a successful image-only render.
  const counts = summary.counts as JsonRecord | undefined;
  const values = {
    subnet_count: summary.subnet_count,
    endpoints: counts?.endpoints,
    providers: counts?.providers,
  };
  for (const [key, value] of Object.entries(values))
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || (value as number) < 0)
    )
      throw new Error(`Invalid source count: ${key}`);
  const coverage = (summary.coverage as JsonRecord | undefined)?.average_score;
  if (
    coverage !== undefined &&
    (!Number.isInteger(coverage) ||
      (coverage as number) < 0 ||
      (coverage as number) > 100)
  )
    throw new Error("Invalid source coverage score.");
  if (
    !Number.isSafeInteger(summary.subnet_count) ||
    (summary.subnet_count as number) < 0
  )
    throw new Error("Source subnet_count is required.");
  return { full, compact, summary, entries };
}
export function verifyImageRender(
  receipt: ImageRenderReceipt,
  pngs: Record<string, Uint8Array>,
  sourceSha: string,
): void {
  if (
    receipt.status !== "rendered" ||
    receipt.renderer_version !== CARD_VERSION ||
    !/^[a-f0-9]{40}$/.test(receipt.renderer_revision) ||
    receipt.source_sha256 !== sourceSha ||
    !Array.isArray(receipt.fonts) ||
    receipt.fonts.length !== CARD_FONT_FACES.length ||
    receipt.fonts.some(
      (font) =>
        !/^[a-f0-9]{64}$/.test(font.sha256) ||
        !Number.isSafeInteger(font.size_bytes) ||
        font.size_bytes <= 0 ||
        font.size_bytes > 1024 * 1024,
    )
  )
    throw new Error(
      "Successful current renderer/source/font receipt required.",
    );
  if (
    receipt.fonts.some(
      (font, i) =>
        font.name !== CARD_FONT_FACES[i].name ||
        font.weight !== CARD_FONT_FACES[i].weight,
    )
  )
    throw new Error(
      "Render receipt font identities differ from approved faces.",
    );
  if (
    JSON.stringify(Object.keys(pngs).sort()) !==
      JSON.stringify([...IMAGE_PATHS].sort()) ||
    receipt.artifacts.length !== IMAGE_PATHS.length ||
    new Set(receipt.artifacts.map((entry) => entry.path)).size !==
      IMAGE_PATHS.length
  )
    throw new Error(
      "Image publication requires exactly the approved root paths.",
    );
  for (const entry of receipt.artifacts) {
    const png = pngs[entry.path];
    if (
      !png ||
      !IMAGE_PATHS.includes(entry.path) ||
      entry.content_type !== "image/png" ||
      entry.width !== 1200 ||
      entry.height !== 630 ||
      png.length !== entry.size_bytes ||
      sha256Hex(png) !== entry.sha256
    )
      throw new Error("Image bytes do not match the complete render receipt.");
    verifyPng(png);
  }
}

/** Pure overlay: every field outside the release/image allowlist is copied. */
export function planImageRelease(
  source: ImageSource,
  receipt: ImageRenderReceipt,
  pngs: Record<string, Uint8Array>,
): ReleaseOperation {
  const { full, compact, entries } = verifyImageSource(source);
  verifyImageRender(receipt, pngs, sha256Hex(source.summary));
  const id = hashJson({
    base: hashJson(source.pointer),
    full: sha256Hex(source.full),
    source: sha256Hex(source.summary),
    renderer: receipt,
  });
  const runPrefix = `runs/image-${id}/`;
  const images = receipt.artifacts.map((image): ImageArtifact => ({
    path: image.path,
    key: `by-hash/${image.sha256}`,
    latest_key: `latest/${image.path.slice("/metagraph/".length)}`,
    sha256: image.sha256,
    size_bytes: image.size_bytes,
    content_type: "image/png",
    storage_tier: "r2",
    artwork_receipt_key: `${runPrefix}og-image-release.json`,
  }));
  const untouched = entries.filter(
    (entry) => !IMAGE_PATHS.includes(entry.path),
  );
  const artifacts = [...untouched, ...images].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const counts: Record<string, number> = {};
  const sizes: Record<string, number> = {};
  for (const entry of artifacts) {
    counts[entry.storage_tier] = (counts[entry.storage_tier] ?? 0) + 1;
    sizes[entry.storage_tier] =
      (sizes[entry.storage_tier] ?? 0) + entry.size_bytes;
  }
  const totalBytes = artifacts.reduce(
    (sum, entry) => sum + entry.size_bytes,
    0,
  );
  const nextFull = {
    ...full,
    run_prefix: runPrefix,
    artifact_count: artifacts.length,
    artifact_size_bytes: totalBytes,
    artifacts,
  };
  const nextCompact = {
    ...compact,
    run_prefix: runPrefix,
    full_manifest_run_key: `${runPrefix}r2-manifest.json`,
    full_artifact_count: artifacts.length,
    full_artifact_size_bytes: totalBytes,
    storage_tier_counts: counts,
    storage_tier_size_bytes: sizes,
  };
  const target = {
    ...source.pointer,
    run_prefix: runPrefix,
    full_manifest_run_key: `${runPrefix}r2-manifest.json`,
    manifest_hash: hashJson(nextCompact),
  };
  const releaseReceipt = {
    schema_version: 1,
    id,
    kind: "image",
    base_pointer_hash: hashJson(source.pointer),
    base_full_manifest_sha256: sha256Hex(source.full),
    source_summary_sha256: sha256Hex(source.summary),
    renderer: receipt,
    preserved_artifact_count: untouched.length,
    data_generated_at: source.pointer.generated_at,
    data_published_at: source.pointer.published_at,
  };
  const objects = images.map((entry) => ({
    key: entry.key,
    bytes: pngs[entry.path],
    contentType: "image/png",
  }));
  return {
    id,
    kind: "image",
    base: source.pointer,
    target,
    objects: [
      ...new Map(objects.map((object) => [object.key, object])).values(),
      jsonObject(`${runPrefix}r2-manifest.json`, nextFull),
      jsonObject(`${runPrefix}r2-manifest.compact.json`, nextCompact),
      {
        key: `${runPrefix}build-summary.json`,
        bytes: source.buildSummary,
        contentType: "application/json; charset=utf-8",
      },
      jsonObject(`${runPrefix}og-image-release.json`, releaseReceipt),
    ],
  };
}
