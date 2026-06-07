# Metagraphed Backend Operations

## Source Of Truth

GitHub-reviewed registry source, compact generated indexes, and compact release manifests are canonical for v1. High-churn generated detail is staged under `dist/metagraph-r2/metagraph` and published to R2; Cloudflare serves and stores artifacts, but it does not become the registry truth source.

## Routine Validation

```bash
npm run pipeline:check
```

This performs dry-run sync/discovery/verification, contract validation, Worker runtime checks, workflow validation, public-safety scanning, and tests.

The contract checks include schema bundle drift, schema/query enum parity, OpenAPI example validation, generated TypeScript freshness, and generated client freshness.

## Refreshing Artifacts

```bash
npm run pipeline:refresh
```

This updates native subnet data, candidates, verification, baseline curation, adapter snapshots, generated artifacts, schema snapshots, R2 manifest, and validation outputs.

The refresh keeps Git reviewable: compact artifacts remain in `public/metagraph`, while per-subnet candidates, verification details, health detail/history, adapter snapshots, schema snapshots, and provider detail outputs are staged for R2 and should not be committed.

Live health probes are only written when explicitly enabled:

```bash
METAGRAPH_WRITE_PROBE_RESULTS=1 npm run pipeline:refresh
```

## Cloudflare Publish

Before publishing:

```bash
npm run cloudflare:verify:dry-run
npm run r2:upload:dry-run
npm run kv:publish:dry-run
npm run worker:deploy:dry-run
```

Actual writes require explicit environment gates:

- `METAGRAPH_ALLOW_R2_UPLOAD=1`
- `METAGRAPH_R2_UPLOAD_HISTORY=1` when the publish job should also write run-prefix history copies for changed artifacts and control files.
- `METAGRAPH_R2_UPLOAD_FORCE=1` when a publish job should ignore the remote `latest/r2-manifest.json` comparison and republish every planned artifact.
- `METAGRAPH_R2_UPLOAD_LIMIT` for smoke-only uploads against a small artifact subset. Limited smoke uploads skip control files so `latest/r2-manifest.json` continues to describe only a complete latest artifact set.
- `METAGRAPH_ALLOW_KV_WRITE=1`
- `METAGRAPH_KV_NAMESPACE_ID`
- Cloudflare account/API credentials

Normal R2 publishes are delta-based. The uploader reads `latest/r2-manifest.json`, compares artifact SHA-256 values, reads R2-tier files from the staging tree, skips unchanged artifact files, and refreshes `latest/r2-manifest.json` plus `latest/build-summary.json` on full uploads so Worker fallback and operator summaries stay current.

## Restore From R2

Dry-run:

```bash
npm run r2:download:dry-run
```

Write mode verifies downloaded SHA-256 hashes against `public/metagraph/r2-manifest.json`.

```bash
METAGRAPH_ALLOW_R2_DOWNLOAD=1 npm run r2:download
```

## Rollback

Rollback is pointer-first:

- point KV `metagraph:latest` at a known-good R2 run prefix;
- verify `/api/v1/build`, `/api/v1/contracts`, `/api/v1/health`, `/api/v1/endpoint-pools`, and `/api/v1/rpc/pools`;
- disable `METAGRAPH_ENABLE_RPC_PROXY` immediately if proxy behavior is suspect.

## Known Non-Blocking Drift

`sync:subnets:dry-run` can report chain metadata changes, such as subnet names. These should become reviewed sync PRs, not silent direct pushes.
