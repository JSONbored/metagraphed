# Metagraphed Backend Operations

## Source Of Truth

GitHub-reviewed registry source and generated JSON artifacts are canonical for v1. Cloudflare serves and stores artifacts; it does not become the registry truth source.

## Routine Validation

```bash
npm run pipeline:check
```

This performs dry-run sync/discovery/verification, contract validation, Worker runtime checks, workflow validation, public-safety scanning, and tests.

## Refreshing Artifacts

```bash
npm run pipeline:refresh
```

This updates native subnet data, candidates, verification, baseline curation, adapter snapshots, generated artifacts, schema snapshots, R2 manifest, and validation outputs.

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
- `METAGRAPH_ALLOW_KV_WRITE=1`
- `METAGRAPH_KV_NAMESPACE_ID`
- Cloudflare account/API credentials

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
