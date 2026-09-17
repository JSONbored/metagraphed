import {
  IMAGE_PATHS,
  manifestArtifacts,
  parseRecord,
  verifyArtifact,
  verifyImageRender,
  verifyPng,
  type ImageRenderReceipt,
} from "./og-image-release-plan.ts";
import {
  jsonBytes,
  readReleaseJournal,
  type ReleaseStore,
} from "./artifact-release-commit.ts";
import { sha256Hex } from "./lib.ts";

/** Called before normal manifest/upload, while the common release owner is held. */
export async function reconcileDataReleaseImages(
  store: ReleaseStore,
  rendered: {
    receipt: ImageRenderReceipt;
    pngs: Record<string, Uint8Array>;
    summary: Uint8Array;
  } | null,
) {
  const journal = await readReleaseJournal(store);
  if (journal.state !== "committed")
    throw new Error(
      "Prior publication unresolved; resume it before uploading data.",
    );
  const fullKey = journal.head.full_manifest_run_key;
  if (
    typeof fullKey !== "string" ||
    !/^runs\/[A-Za-z0-9_-]+\/r2-manifest.json$/.test(fullKey)
  )
    throw new Error("Active immutable manifest key missing.");
  const object = await store.get(fullKey);
  if (!object) throw new Error("Active full manifest missing.");
  const entries = manifestArtifacts(
    parseRecord(object.bytes, 8 * 1024 * 1024, "Active full manifest"),
  );
  // A checkout predating a new renderer must never remove its active path.
  const currentVersion = Number(IMAGE_PATHS[1].match(/-v(\d+)\.png$/)![1]);
  if (
    entries.some(
      (entry) =>
        Number(
          entry.path.match(/^\/metagraph\/og-image-v(\d+)\.png$/)?.[1] ?? 0,
        ) > currentVersion,
    )
  )
    throw new Error(
      "Stale renderer checkout would remove a newer active image version.",
    );
  if (rendered) {
    verifyImageRender(
      rendered.receipt,
      rendered.pngs,
      sha256Hex(rendered.summary),
    );
    return {
      status: "rendered" as const,
      pngs: rendered.pngs,
      provenance: Object.fromEntries(
        IMAGE_PATHS.map((imagePath) => [
          imagePath,
          {
            renderer_version: rendered.receipt.renderer_version,
            source_sha256: rendered.receipt.source_sha256,
            artwork_receipt_key: `by-hash/${sha256Hex(jsonBytes(rendered.receipt))}`,
          },
        ]),
      ),
    };
  }
  const pngs: Record<string, Uint8Array> = {};
  const provenance: Record<string, Record<string, unknown>> = {};
  const fetched = new Map<string, Uint8Array>();
  for (const entry of entries.filter((artifact) =>
    IMAGE_PATHS.includes(artifact.path),
  )) {
    let bytes = fetched.get(entry.key);
    if (!bytes) {
      const image = await store.get(entry.key);
      if (!image || image.contentType.split(";")[0] !== "image/png")
        throw new Error(
          "Active approved artwork unavailable; no replacement publish permitted.",
        );
      bytes = image.bytes;
      fetched.set(entry.key, bytes);
    }
    verifyArtifact(entry, bytes);
    verifyPng(bytes);
    pngs[entry.path] = bytes;
    // Copy all image-specific forward-compatible metadata, not data timestamps.
    const {
      path: _path,
      key: _key,
      latest_key: _latest,
      sha256: _sha,
      size_bytes: _size,
      content_type: _mime,
      storage_tier: _tier,
      ...metadata
    } = entry;
    provenance[entry.path] = metadata;
  }
  return { status: "carried-forward" as const, pngs, provenance };
}
