import {
  generateBaselineOverlaySet,
  printGeneratedOverlaySummary,
  writeGeneratedOverlayArtifacts,
} from "./generated-overlays.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;

const overlaySet = await generateBaselineOverlaySet();
const summary = {
  ...overlaySet.summary,
  mode: dryRun ? "dry-run" : "write",
};

if (!dryRun) {
  await writeGeneratedOverlayArtifacts(overlaySet);
}

printGeneratedOverlaySummary(summary);
