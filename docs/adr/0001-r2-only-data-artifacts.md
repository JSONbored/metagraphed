# ADR 0001 — R2-only data artifacts, committed inputs + contract, self-sufficient publish

- **Status:** Accepted — implemented (see "Outcome" below).
- **Date:** 2026-06-09
- **Supersedes:** the implicit "dual-tier everything" model and the
  push-triggered `publish-cloudflare.yml` full-publish.

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

1. ✅ **Self-sufficient publish** (#203) — re-snapshot adapters in
   `productionSteps`; pass token + `METAGRAPH_REQUIRE_ADAPTER_AUTH`; align adapter
   freshness 12h→24h. Freshness is fresh by construction at publish time.
2. ✅ **R2-only data** (#206, #209) — reclassified ~4.3 MB of high-churn data
   (`surfaces`, `evidence-ledger`, `search`, `profiles`, `curation`, `gaps`,
   `providers`, `freshness`, `schema-drift`, `review/*`) from dual → r2 in
   `artifact-storage.mjs`; `git rm`'d the committed copies; the Worker serves
   them R2-first via the existing tier system. Blocking readers made tier-aware
   (`kv-publish-pointer` via `artifactFilePath`); `validate.yml` excludes
   deletions from ci-verify (`--diff-filter=d`); the `gitBuffer` exit-128 crash
   fixed. **Kept committed:** the API contract (`api-index`, `contracts`,
   `openapi`, `schemas/index`, `types.d.ts`), `coverage`, `subnets` (changelog
   baseline), and the small digests (`build-summary`, `changelog`, `r2-manifest`).
3. ✅ **Decouple deploy from data** (#207, #208) — this is the bigger structural
   win than the originally-planned "collapse the two-job publish". See "Outcome".
4. ✅ **Docs/provenance** — this ADR + the roadmap. Follow-up: refresh
   `backend-artifact-contracts.md` + README serving notes.

## Outcome — deploy architecture

The push-triggered, all-in-one `publish-cloudflare.yml` is replaced by two
decoupled mechanisms, because code is change-driven while data freshness is
time-driven (and the Worker reads data from R2/KV at request time, so it does
not need redeploying when data changes):

- **Worker code + committed assets → Cloudflare Workers Builds.** The repo is
  connected to the Worker; every push to `main` runs `npm run build` then
  `npx wrangler deploy` in Cloudflare's environment (native R2/KV/deploy creds —
  no GitHub secrets). `wrangler.jsonc` carries 100% logs+traces observability and
  Smart Placement.
- **Data → scheduled refresh** (`publish-cloudflare.yml`, repurposed). On a 6h
  cron (and `workflow_dispatch`): production build (probes + adapters) → validate
  (freshness/probe-health gate) → `r2:upload` (versioned + `latest/`) →
  `kv:publish` (the `metagraph:latest` pointer) → `smoke:live`. No worker deploy
  (Cloudflare Builds owns it); the redundant Cloudflare dry-runs removed.

Net: a docs commit no longer re-probes 1k+ surfaces; data refreshes on its own
cadence; git size tracks curation effort, not data volume.
