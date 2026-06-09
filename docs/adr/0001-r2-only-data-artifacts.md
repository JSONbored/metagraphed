# ADR 0001 — R2-only data artifacts, committed inputs + contract, self-sufficient publish

- **Status:** Accepted — phased migration in progress.
- **Date:** 2026-06-09
- **Supersedes:** the implicit "dual-tier everything" model.

## Context

The backend is schema-driven and deterministic: hand-curated registry inputs
plus live enrichment (probes, adapter snapshots) are transformed by a
reproducible build into a set of artifacts, served by one Cloudflare Worker from
git static assets (ASSETS) and/or R2.

Artifacts are classified by `src/artifact-storage.mjs` into:

- **`dual`** — committed to git **and** uploaded to R2 (~22 files, ~5.2 MB).
- **`r2`** — R2-only, gitignored (~1,250 detail files).
- **`git`** — local-only support artifacts.

This created three coupled problems, all observed in production:

1. **Generated-artifact churn.** Every data change re-commits all ~22 dual
   artifacts — including `surfaces.json` (1.1 MB), `evidence-ledger.json`
   (858 KB), `search.json`, `profiles.json` — and the digests (`r2-manifest`,
   `build-summary`, `changelog`) churn on *every* build. The UGC import bot
   (`intake-import-pr.yml`) re-commits the whole set for a single 2 KB
   community submission. Git size grows with data volume and contribution rate,
   not curation effort.
2. **A fragile reproducibility gate.** Because data artifacts are committed,
   `scripts/ci-verify-submitted-artifacts.mjs` runs `git diff --exit-code` on
   them. Run mid-`pipeline:refresh` (before the workflow commits), it
   self-fails the sync job whenever a refresh changes a diff-checked artifact.
3. **A freshness/merge race.** The publish gate requires fresh probe-derived
   health *and* fresh adapter snapshots, but the production build only re-probed
   health — adapters came from committed data that ages past the block window,
   so the publish depended on a recently-merged sync PR racing a 12 h window.

Investigation confirmed the committed data artifacts are **not load-bearing for
correctness**: they already exist in R2 (dual), the Worker falls back to R2, the
build is deterministic from committed inputs, and R2 keeps versioned `runs/`
history. Their only roles — fast ASSETS edge path, PR-diff review, and
reproducibility — are respectively a marginal optimization (R2 + 300 s edge
cache is comparable), low value (review belongs on inputs; contributors are
*blocked* from editing generated files), and redundant (outputs are a pure
function of committed inputs).

## Decision

**Commit the source of truth and the public contract; derive and serve
everything else from R2.**

1. **Commit:** registry **inputs** (`registry/**`) and the low-churn,
   consumer-facing **API contract** — `openapi.json`, `types.d.ts`,
   `contracts.json`, `api-index.json`, `schemas/index.json` (+ `coverage.json`
   as a small git "shop window").
2. **R2-only:** all high-churn data and digests — `surfaces`, `profiles`,
   `search`, `evidence-ledger`, `curation`, `gaps`, `subnets`, `providers`,
   `freshness`, `changelog`, `review/*`, `build-summary`, `r2-manifest`,
   `schema-drift`, `profile-completeness`.
3. **Self-sufficient publish:** the production build re-snapshots adapters (it
   already re-probes health), so all freshness-gated data is fresh *by
   construction*; the gate verifies rather than blocks, and any push publishes.
4. **UGC = a one-file commit:** the import bot commits only the source candidate;
   artifacts are rebuilt and published to R2 by the publish workflow.

Verifiability of "trustworthy, complete coverage" shifts from *diffing committed
outputs* to **reviewable committed inputs + a deterministic reproducible build +
the published, versioned R2 evidence-ledger** — a cleaner provenance story.

## Consequences

- **Zero generated-artifact churn** on data changes; git size tracks curation
  effort, not data volume or contributor count. Scales with Bittensor growth.
- The fragile reproducibility gate disappears for data artifacts (it still
  guards the small committed contract set), fixing the sync self-fail.
- Worker serves the moved artifacts from R2 + edge cache (first-hit ~ms, then
  cached; the existing 5 s R2 timeout / 504 handling applies).
- **Hard sequencing constraint:** R2 must be populated by a successful publish
  *before* an artifact is made R2-only, or production 404s. Phase 2 therefore
  depends on Phase 1 shipping a green publish first.
- Local development must `npm run build` to serve the data locally (already the
  case).

## Phased migration

1. **Self-sufficient publish** — re-snapshot adapters in `productionSteps`; pass
   token + `METAGRAPH_REQUIRE_ADAPTER_AUTH`; align adapter freshness 12h→24h.
   *(Closes the publish blocker; no churn change.)*
2. **R2-only data** — reclassify in `artifact-storage.mjs`; `git rm` the
   committed copies; make R2 primary in the Worker; shift the R2 delta-upload
   baseline to R2 state; retarget the reproducibility gate to the contract set.
   *(Gated on Phase 1 populating R2.)*
3. **Decouple UGC + sync** — import bot and sync commit inputs only; drop
   `npm test` from the commit path; fix the test-order bug.
4. **Docs/provenance** — this ADR; update `backend-artifact-contracts.md`,
   README serving notes, and the roadmap.
5. **Optional** — collapse the two-job publish into one `build → validate →
   deploy`.
