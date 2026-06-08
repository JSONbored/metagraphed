# All-Subnet Registry Model

Metagraphed covers every active Finney subnet through chain-native data plus curated public-interface overlays.

## Current Coverage

- `129` active Finney netuids.
- `1` root/system entry at netuid `0`.
- `128` application subnets.
- `129` curated overlays.
- `0` native-only entries.
- Allways SN7 and Gittensor SN74 are adapter-backed.
- Root netuid `0` carries Bittensor base-layer Subtensor RPC/WSS surfaces.

## Native Snapshot

`registry/native/finney-subnets.json` is generated from decoded Bittensor SDK data.

It is canonical for:

- active netuid existence;
- root/system versus application subnet classification;
- raw chain subnet name, symbol, and name-quality classification;
- participant count;
- tempo;
- registration block;
- mechanism count;
- capture block and source metadata.

It is not the place for docs URLs, dashboards, public APIs, or probe rules.

Native subnet names can degrade to placeholders such as `unknown` when the upstream chain/RPC source cannot provide a meaningful label. In that case, public registry artifacts preserve the raw native value through `native_name` and `native_name_quality`, while builder-facing `name` stays sourced from the reviewed overlay when available.

## Curated Overlays

`registry/subnets/*.json` contains reviewed subnet overlays. Machine-generated baseline overlays are derived from the native snapshot, candidate bundle, and compact verification snapshot during validation/build.

Overlays are canonical for:

- public APIs;
- OpenAPI/Swagger surfaces;
- SSE/event streams;
- dashboards;
- docs;
- repositories;
- data artifacts;
- Subtensor RPC/WSS endpoints on root/system;
- read-only probe rules.

Endpoint resources are generated from these curated surfaces. For Bittensor,
that means:

- root/system: Subtensor RPC/WSS/archive-capability endpoints;
- subnet app layer: public APIs, OpenAPI, SSE, dashboards, SDKs, examples, and
  data artifacts;
- docs/data provider layer: docs, websites, repositories, and published data
  files.

Subnets are not treated as independent Cosmos-style chains, so Metagraphed does
not invent RPC/API/gRPC/seed-node fields for every subnet.

An overlay must reference a netuid that exists in the native snapshot unless it is explicitly marked pending.

Curation levels:

- `native`: chain-derived only;
- `candidate-discovered`: public candidates exist but are not verified;
- `machine-verified`: safe public probes verified promoted surfaces;
- `maintainer-reviewed`: a human reviewed the overlay;
- `adapter-backed`: subnet-specific public data dimensions are modeled.

## Candidate Queue

`registry/candidates` is for unverified public interface candidates from community submissions or third-party discovery.

Candidates are never treated as verified surfaces. They must pass verification and maintainer review before being treated as reviewed registry truth.

`npm run discover:candidates` generates a public-source candidate bundle from enrichment sources such as TaoMarketCap, Tensorplex subnet-docs, Taopedia articles, Backprop Finance dashboard routes, Taostats metagraph dashboard routes, GitHub README links, and public websites. Third-party directories and dashboards are enrichment only; native chain data remains canonical for active subnet existence and curated overlays remain canonical for reviewed public interfaces.

`npm run verify:candidates` writes a compact Git-reviewed promotion snapshot to `registry/verification/promotions.json` and stages the full volatile verification run for R2. Classification values include live, redirected, auth-required, dead, unsafe, unsupported, rate-limited, transient, timeout, and content-mismatch.

`npm run curate:baseline` promotes only live/redirected public-safe candidates into derived generated baseline overlays. It does not overwrite hand-curated overlays. Git stores a compact generated-overlay checksum summary, while the expanded generated overlay bundle is staged outside Git for R2.

## Review Workflow

`registry/reviews/maintainer-reviewed.json` stores public-safe maintainer decisions.

`npm run review:promote` applies those decisions to overlays. Review data is limited to netuid, slug, decision, reviewed timestamp, confidence, public source URLs, and notes.

Generated artifacts expose review state through:

- `/metagraph/review/curation.json`
- `/metagraph/review/gap-priorities.json`
- `/metagraph/review/adapter-candidates.json`
- `/metagraph/review/maintainer-decisions.json`

## Generated Artifacts

`/metagraph/*` is the public path contract. Compact indexes are checked into `public/metagraph`; volatile detail artifacts are generated into the ignored R2 staging tree and served through the same public paths after upload.

`public/metagraph/subnets.json` lists every active chain subnet.

`public/metagraph/surfaces.json` lists only curated/verified public interface surfaces.

`/metagraph/rpc-endpoints.json` lists Bittensor base-layer RPC/WSS endpoints and live probe metadata. It is R2-backed because endpoint health, block height, and latency are volatile.

`public/metagraph/rpc/pools.json` scores RPC/WSS endpoints for future read-only endpoint routing.

`/metagraph/endpoints.json` lists generalized endpoint resources derived from curated surfaces plus probe-derived health. It is R2-backed for the same reason.

`/metagraph/endpoints/{netuid}.json` exposes R2-backed endpoint resources for one subnet.

`/metagraph/providers/{slug}/endpoints.json` exposes R2-backed endpoint resources for one provider/operator.

`/metagraph/endpoint-pools.json` scores monitored endpoint pools. In v1, only root/system RPC/WSS/archive-capable endpoints are candidates for future routing. It is R2-backed because scores change with each probe run.

`public/metagraph/coverage.json` summarizes chain coverage, curated overlays, native-only stubs, probed subnets, surfaces, and candidate counts.

`/metagraph/candidates.json` lists unverified candidate surfaces with source provenance. It is R2-backed because candidate discovery is high-churn generated data.

`/metagraph/review-queue.json` lists candidate surfaces that need maintainer review. It is R2-backed for the same reason and should not be committed under `public/metagraph`.

`public/metagraph/curation.json` lists curation level, review state, source count, and gaps for every active subnet.

`public/metagraph/gaps.json` lists missing docs/repo/site/dashboard/API/OpenAPI/SSE/data-artifact facets by subnet.

`/metagraph/verification/latest.json` exposes the latest R2-backed candidate verification snapshot.

`/metagraph/subnets/{netuid}.json` exposes R2-backed per-subnet detail artifacts for app and API consumers.

`/metagraph/health/*` exposes surface health, per-subnet health, history, and badge-input data under `metagraph.sh`. Health status is probe-derived only; submissions can trigger review or re-probes, not set uptime.

`/metagraph/adapters/*` exposes R2-backed safe subnet-specific public metrics for adapter-backed pilots.

`public/metagraph/search.json` exposes a compact search index for subnets, surfaces, and providers.

`public/metagraph/freshness.json`, `source-health.json`, `source-snapshots.json`, `changelog.json`, and `evidence-ledger.json` expose backend freshness, upstream source health, source-input hashes, generated change summaries, and public evidence records.

`public/metagraph/r2-manifest.json` is the compact committed upload manifest. The full manifest for R2-only detail artifacts is generated under `dist/metagraph-r2/metagraph/r2-manifest.json` and uploaded to R2.

Worker API routes under `/api/v1/*` wrap these artifacts without replacing them as canonical truth. The Worker reads static assets first, can fall back to R2, and can use an optional KV latest pointer when configured.
