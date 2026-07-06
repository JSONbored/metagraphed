import path from "node:path";
import {
  listJsonFiles,
  loadSubnets,
  readJson,
  repoRoot,
  buildSubnetOverlaysByNetuid,
  stableStringify,
  writeJson,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const decisionsPath = path.join(
  repoRoot,
  "registry/reviews/maintainer-reviewed.json",
);
const decisionsDocument = await readJson(decisionsPath);
const manualOverlayFiles = await listJsonFiles(
  path.join(repoRoot, "registry/subnets"),
);
const manualOverlays = await Promise.all(
  manualOverlayFiles.map(async (filePath) => ({
    filePath,
    overlay: await readJson(filePath),
  })),
);
const allOverlays = await loadSubnets();
const overlaysByNetuid = buildSubnetOverlaysByNetuid({
  allOverlays,
  manualOverlays,
});
const results = [];

for (const decision of decisionsDocument.decisions || []) {
  const entry = overlaysByNetuid.get(decision.netuid);
  if (!entry) {
    results.push({
      netuid: decision.netuid,
      slug: decision.slug,
      status: "missing-overlay",
    });
    continue;
  }

  const nextOverlay = structuredClone(entry.overlay);
  nextOverlay.curation = {
    ...(nextOverlay.curation || {}),
    review_state: decision.decision,
    reviewed_at: decision.reviewed_at,
  };
  if (
    decision.decision === "maintainer-reviewed" &&
    nextOverlay.curation.level === "machine-verified"
  ) {
    nextOverlay.curation.level = "maintainer-reviewed";
  }

  const changed =
    stableStringify(nextOverlay) !== stableStringify(entry.overlay);
  results.push({
    netuid: decision.netuid,
    slug: nextOverlay.slug,
    decision: decision.decision,
    materialized: Boolean(entry.materialized),
    changed,
  });

  if (!dryRun && changed) {
    await writeJson(entry.filePath, nextOverlay);
  }
}

console.log(
  stableStringify({
    mode: dryRun ? "dry-run" : "write",
    decision_count: decisionsDocument.decisions?.length || 0,
    changed_count: results.filter((result) => result.changed).length,
    results,
  }),
);
