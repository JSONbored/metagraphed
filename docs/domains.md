# Domain Plan

## Primary

`metagraph.sh`

Use this for the product, docs, static UI, status data, badge data, health JSON, generated registry artifacts, and future API-style static artifact consumption.

Expected backend routes:

- `/metagraph/contracts.json`
- `/metagraph/api-index.json`
- `/metagraph/changelog.json`
- `/metagraph/subnets.json`
- `/metagraph/subnets/{netuid}.json`
- `/metagraph/surfaces.json`
- `/metagraph/endpoints.json`
- `/metagraph/endpoints/{netuid}.json`
- `/metagraph/candidates.json`
- `/metagraph/coverage.json`
- `/metagraph/curation.json`
- `/metagraph/gaps.json`
- `/metagraph/rpc-endpoints.json`
- `/metagraph/rpc/pools.json`
- `/metagraph/endpoint-pools.json`
- `/metagraph/search.json`
- `/metagraph/freshness.json`
- `/metagraph/source-health.json`
- `/metagraph/source-snapshots.json`
- `/metagraph/evidence-ledger.json`
- `/metagraph/r2-manifest.json`
- `/metagraph/health/latest.json`
- `/metagraph/health/summary.json`
- `/metagraph/health/subnets/{netuid}.json`
- `/metagraph/health/badges/{netuid}.json`
- `/metagraph/schema-drift.json`
- `/metagraph/schemas/index.json`
- `/metagraph/adapters/allways.json`
- `/metagraph/adapters/gittensor.json`
- `/metagraph/review/curation.json`
- `/metagraph/review/maintainer-decisions.json`

Expected Worker API routes:

- `/api/v1/subnets`
- `/api/v1/subnets/{netuid}`
- `/api/v1/surfaces`
- `/api/v1/endpoints`
- `/api/v1/subnets/{netuid}/endpoints`
- `/api/v1/candidates`
- `/api/v1/providers`
- `/api/v1/providers/{slug}/endpoints`
- `/api/v1/coverage`
- `/api/v1/curation`
- `/api/v1/gaps`
- `/api/v1/health`
- `/api/v1/freshness`
- `/api/v1/source-health`
- `/api/v1/evidence`
- `/api/v1/changelog`
- `/api/v1/source-snapshots`
- `/api/v1/rpc/endpoints`
- `/api/v1/rpc/pools`
- `/api/v1/endpoint-pools`
- `/api/v1/schemas`
- `/api/v1/adapters/{slug}`
- `/api/v1/search`
- `/api/v1/contracts`
- `/api/v1/build`

## Reserved Domains

Do not use `subnet.health` for Metagraphed v1. It is reserved for a separate future idea and should not appear in registry, health, badge, probe, or status contracts.

## Copy Boundary

Use:

> Metagraphed extends the native Bittensor metagraph with public interface and health metadata.

Avoid:

> Metagraphed is the Bittensor metagraph.

The project is unofficial and must not imply OpenTensor/Bittensor endorsement.
