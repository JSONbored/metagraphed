import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { artifactFilePath, repoRoot, stableStringify } from "./lib.ts";
import {
  jsonBytes,
  releaseJournalActive,
  settleReleaseBeforePrepare,
} from "./artifact-release-commit.ts";
import { createReleaseStore } from "./artifact-release-store.ts";
import { reconcileDataReleaseImages } from "./og-image-carry-forward.ts";
import {
  IMAGE_PATHS,
  type ImageRenderReceipt,
} from "./og-image-release-plan.ts";

const store = createReleaseStore(true);
const active = await releaseJournalActive(
  store,
  process.env.METAGRAPH_RELEASE_MIGRATION === "pending",
);
if (!active) {
  console.log(
    stableStringify({
      status: "migration-pending",
      detail:
        "Image-only publication remains disabled until explicit journal activation.",
    }),
  );
} else {
  await settleReleaseBeforePrepare(store);
  let rendered = null;
  const receiptBytes = await readFile(
    artifactFilePath("og-image-render.json"),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (receiptBytes) {
    const receipt = JSON.parse(receiptBytes.toString()) as ImageRenderReceipt;
    if (receipt.status === "rendered") {
      const revision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
      if (receipt.renderer_revision !== revision)
        throw new Error(
          "Normal render receipt belongs to a different checkout.",
        );
      const pngs: Record<string, Uint8Array> = {};
      for (const imagePath of IMAGE_PATHS)
        pngs[imagePath] = await readFile(
          artifactFilePath(path.basename(imagePath)),
        );
      rendered = {
        receipt,
        pngs,
        summary: await readFile(artifactFilePath("registry-summary.json")),
      };
    }
  }
  const result = await reconcileDataReleaseImages(store, rendered);
  // Remove partial local outputs before restoring the exact active allowlist.
  for (const imagePath of IMAGE_PATHS)
    await rm(artifactFilePath(path.basename(imagePath)), { force: true });
  for (const [imagePath, bytes] of Object.entries(result.pngs))
    await writeFile(artifactFilePath(path.basename(imagePath)), bytes);
  await writeFile(
    path.join(repoRoot, "dist/og-image-provenance.json"),
    jsonBytes(result.provenance),
  );
  console.log(
    stableStringify({
      status: result.status,
      artifact_paths: Object.keys(result.pngs),
    }),
  );
}
