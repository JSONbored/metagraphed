import path from "node:path";
import {
  listJsonFiles,
  loadSubnets,
  readJson,
  repoRoot,
  buildSubnetOverlaysByNetuid,
  promoteCurationLevel,
  stableStringify,
  writeJson,
} from "./lib.mjs";

type Row = Record<string, unknown>;

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const decisionsPath = path.join(
  repoRoot,
  "registry/reviews/maintainer-reviewed.json",
);
const decisionsDocument: Row = await readJson(decisionsPath);
const manualOverlayFiles: string[] = await listJsonFiles(
  path.join(repoRoot, "registry/subnets"),
);
const manualOverlays = await Promise.all(
  manualOverlayFiles.map(async (filePath) => ({
    filePath,
    overlay: (await readJson(filePath)) as Row,
  })),
);
const allOverlays: Row[] = await loadSubnets();
const overlaysByNetuid: Map<unknown, Row> = buildSubnetOverlaysByNetuid({
  allOverlays,
  manualOverlays,
});
const results: Row[] = [];

for (const decision of (decisionsDocument.decisions as Row[] | undefined) ||
  []) {
  const entry = overlaysByNetuid.get(decision.netuid);
  if (!entry) {
    results.push({
      netuid: decision.netuid,
      slug: decision.slug,
      status: "missing-overlay",
    });
    continue;
  }

  const nextOverlay = structuredClone(entry.overlay) as Row;
  nextOverlay.curation = {
    ...((nextOverlay.curation as Row | undefined) || {}),
    review_state: decision.decision,
    reviewed_at: decision.reviewed_at,
  };
  // Materialize the decision onto curation.level via the shared contract:
  // promote any lower pre-tier to maintainer-reviewed, leave a ceiling tier
  // (adapter-backed / already maintainer-reviewed) untouched. Previously only a
  // machine-verified starting level was promoted, so a decision recorded against
  // any other pre-tier silently updated review_state/reviewed_at without ever
  // bumping the level -- the SN59/SN107 drift class (#5992).
  (nextOverlay.curation as Row).level = promoteCurationLevel(
    (nextOverlay.curation as Row).level,
    decision.decision,
  );

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
    await writeJson(entry.filePath as string, nextOverlay);
  }
}

console.log(
  stableStringify({
    mode: dryRun ? "dry-run" : "write",
    decision_count:
      (decisionsDocument.decisions as Row[] | undefined)?.length || 0,
    changed_count: results.filter((result) => result.changed).length,
    results,
  }),
);
