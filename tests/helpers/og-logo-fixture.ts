import { createHash } from "node:crypto";

/** Synthetic manifest data exercises the production parser and byte verifier. */
export function logoManifestFixture(
  bytes: ArrayBuffer,
  sourcePath = "cache/x.png",
  sourceHash = "a".repeat(64),
) {
  const outputHash = createHash("sha256")
    .update(new Uint8Array(bytes))
    .digest("hex");
  const sharingPath = `sharing/v1/${sourceHash}-${outputHash}.png`;
  return {
    version: 2,
    format: "webp",
    max_dimension: 96,
    quality: 90,
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
        source_bytes: bytes.byteLength,
        sharing_path: sharingPath,
        sharing_sha256: outputHash,
        sharing_bytes: bytes.byteLength,
        sharing_width: 1,
        sharing_height: 1,
      },
    ],
  };
}
