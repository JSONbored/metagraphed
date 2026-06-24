import path from "node:path";
import {
  buildProvenanceReviewQueue,
  loadCandidates,
  loadNativeSnapshot,
  loadSubnets,
  loadVerification,
  repoRoot,
  stableStringify,
  writeRepositoryJson,
} from "./lib.mjs";

// Provenance review queue (Move A as promotion-by-exception). Regenerates
// registry/reviews/review-queue.json: a short, high-signal list of subnets whose
// callable API is live AND hosted on their own on-chain-asserted domain, but that
// are NOT yet at the maintainer-reviewed/adapter-backed trust tier. These are the
// elevations a maintainer should make next — the machine proposes (strong
// provenance: chain-asserted domain + live probe), the human disposes by moving an
// entry into maintainer-reviewed.json. Replaces blind hunting through the 2k-row
// candidate pool. Pure transform of committed data (no network) → deterministic and
// drift-checkable; validate.mjs fails if the committed queue is stale.

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = !shouldWrite;
const outputPath = path.join(repoRoot, "registry/reviews/review-queue.json");

const [candidates, nativeSnapshot, verification, subnets] = await Promise.all([
  loadCandidates(),
  loadNativeSnapshot(),
  loadVerification({ preferDetailed: false }),
  loadSubnets(),
]);

const document = buildProvenanceReviewQueue({
  candidates,
  nativeSubnets: nativeSnapshot.subnets,
  verificationResults: verification.results || [],
  subnets,
});

if (dryRun) {
  console.log(stableStringify({ mode: "dry-run", ...document }));
} else {
  await writeRepositoryJson(outputPath, document);
  console.log(
    stableStringify({ mode: "write", queued: document.queue.length }),
  );
}
