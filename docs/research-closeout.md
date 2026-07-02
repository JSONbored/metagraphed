# Research Plan Closeout

This tracks the original Bittensor public-infra research plan against the current Metagraphed backend.

## Handled

- Chain-first all-subnet registry for active Finney netuids.
- Generated native snapshot and per-subnet public artifacts.
- Curated overlays for every active netuid.
- Candidate discovery from TaoMarketCap, Tensorplex subnet-docs, Taopedia articles, GitHub, READMEs, and public websites.
- Candidate verification with safe read-only probes and classification metadata.
- Public health artifacts under `metagraph.sh/metagraph/health/*`.
- Root/system base-layer RPC/WSS surfaces for official and public provider endpoints.
- RPC probes for `chain_getHeader`, `system_health`, `rpc_methods`, and safe archive capability.
- OpenAPI snapshot/drift support, currently schema-backed for Allways.
- Allways and Gittensor adapter-backed pilot artifacts.
- Cloudflare Worker API routes over canonical artifacts.
- R2 manifest generation plus dry-run upload/download tooling for versioned artifact history.
- KV latest pointer, feature-flag, endpoint-pool, and source-freshness publish tooling.
- Search, changelog, freshness, source-health, source-snapshots, evidence-ledger, and endpoint-pool artifacts.
- Maintainer review decision ledger and promotion command.
- Community intake dry-run validation path.
- Scheduled sync workflow that opens PRs instead of direct-pushing generated changes.
- Default-disabled read-only RPC proxy prototype with write/unsafe method blocking.
- Public-safety scan for secrets, wallet/PAT/private URL risks, and unsafe local/private data.
- `metagraph.sh` as the only v1 domain.

## Partial

- Base-layer RPC/provider landscape now has root/system provider manifests and public endpoint probes, but more providers should be promoted only when exact public-safe endpoint URLs are verified.
- Allways adapter captures response shape, hashes, counts, SSE shape, and freshness metadata; deeper protocol analytics such as swap lifecycle rates and crown history rollups are later adapter work.
- Gittensor adapter captures public repository config, emission/maintainer-cut aggregates, GitHub repo metadata, and docs-only bounty/contribution status; no unauthenticated bounty API has been verified yet.
- Sync PR summaries now compute artifact diffs and include Cloudflare artifact summaries, but future summaries can add richer historical health recovery/failure comparisons.

## Deferred

- UI, pages, styling, and visual badge rendering.
- `subnet.health`; it is not used for v1.
- Historical/deregistered/testnet subnet archives.
- Publishing owner keys, hotkeys, coldkeys, wallet data, PATs, credentialed GitHub flows, validator-local state, or private dashboards.
- Owned Bittensor lite/archive nodes and other recurring node OPEX services.
- Public read-only RPC load balancing; endpoint pool artifacts and a disabled proxy prototype exist, but public proxying remains off until Cloudflare WAF/rate limits and funding/OPEX constraints are settled.
- Grant/budget proposal packaging for hosted infrastructure milestones.

## Current Product Line

Metagraphed is registry/status/indexer first. Generic RPC hosting is not the wedge; RPC endpoint health is listed as operational metadata for builders.
