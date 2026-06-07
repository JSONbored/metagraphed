# Metagraphed

Every subnet, metagraphed.

Metagraphed is an unofficial operational registry for Bittensor subnet interfaces, health, schemas, and public access metadata.

The native Bittensor metagraph tells you what is happening at the subnet protocol layer. Metagraphed adds the missing builder-facing layer around it: public APIs, OpenAPI/Swagger surfaces, dashboards, repositories, endpoint health, probe history, schema drift, and access notes.

## Domains

- `metagraph.sh` is the main product and public artifact surface.
- `subnet.health` is not used for Metagraphed v1.

Example routes:

- `https://metagraph.sh/subnets/7`
- `https://metagraph.sh/metagraph/subnets.json`
- `https://metagraph.sh/metagraph/health/subnets/7.json`
- `https://metagraph.sh/metagraph/health/badges/7.json`

## What This Is

- a registry of public subnet interfaces;
- a deterministic JSON artifact generator;
- a probe surface for safe public endpoints;
- a status layer for APIs, schemas, and public data surfaces;
- a Cloudflare-backed API/cache/history layer;
- a foundation for future hosted/cache/load-balanced subnet access.

## What This Is Not

- not an official OpenTensor or Bittensor project;
- not a replacement for the native Bittensor metagraph;
- not another alpha dashboard, docs encyclopedia, or generic RPC provider;
- not a validator credential, wallet, or private scoring mirror.

## Registry Coverage

Metagraphed is chain-first:

- every active Finney netuid gets a native chain entry from decoded Bittensor/Subtensor data;
- root `netuid: 0` is included and labeled as root/system;
- root `netuid: 0` carries Bittensor base-layer RPC/WSS endpoint surfaces;
- generalized endpoint resources normalize base-layer RPC/WSS and subnet-app/API/docs/data surfaces without pretending every subnet has Cosmos-style RPC/API/gRPC/seed endpoints;
- curated overlays add public interface metadata after machine verification or maintainer review;
- third-party APIs are enrichment/candidate sources, not canonical existence sources.
- generated candidates capture public-source leads, but only live/redirected public-safe candidates become promoted surfaces.

Coverage levels:

- `native-only`: chain-derived subnet entry, no verified public interface metadata yet;
- `manifested`: curated interface metadata exists, but no default probe is enabled;
- `probed`: curated interface metadata exists and at least one safe read-only probe is configured.

Curation levels:

- `native`: chain-derived only;
- `candidate-discovered`: public-source leads exist but are not verified;
- `machine-verified`: live public surfaces were safely probed and promoted;
- `maintainer-reviewed`: a human reviewed the overlay;
- `adapter-backed`: subnet-specific public data dimensions are modeled.

## Pilot Overlays

The initial rich overlays track:

- Allways SN7: API health, protocol state, network overview, miners, leaderboard, reliability, events, crown data, and SSE.
- Gittensor SN74: public docs, repository registration surfaces, public master repository weights, bounty/contribution metadata concepts, maintainer-cut metadata, and public-safe aggregate registry surfaces.

Credentialed flows, wallet paths, validator-sensitive internals, private dashboards, and token-gated data are intentionally out of scope.

## Artifact Contract

Generated public artifacts live under `public/metagraph`:

- `/metagraph/contracts.json`
- `/metagraph/providers.json`
- `/metagraph/providers/{slug}.json`
- `/metagraph/providers/{slug}/endpoints.json`
- `/metagraph/api-index.json`
- `/metagraph/openapi.json`
- `/metagraph/types.d.ts`
- `/metagraph/changelog.json`
- `/metagraph/subnets.json`
- `/metagraph/subnets/{netuid}.json`
- `/metagraph/surfaces.json`
- `/metagraph/surfaces/{netuid}.json`
- `/metagraph/endpoints.json`
- `/metagraph/endpoints/{netuid}.json`
- `/metagraph/candidates.json`
- `/metagraph/candidates/{netuid}.json`
- `/metagraph/review-queue.json`
- `/metagraph/search.json`
- `/metagraph/coverage.json`
- `/metagraph/curation.json`
- `/metagraph/gaps.json`
- `/metagraph/verification/latest.json`
- `/metagraph/verification/subnets/{netuid}.json`
- `/metagraph/freshness.json`
- `/metagraph/source-health.json`
- `/metagraph/source-snapshots.json`
- `/metagraph/evidence-ledger.json`
- `/metagraph/health/latest.json`
- `/metagraph/health/summary.json`
- `/metagraph/health/history/{date}.json`
- `/metagraph/health/subnets/{netuid}.json`
- `/metagraph/health/badges/{netuid}.json`
- `/metagraph/rpc-endpoints.json`
- `/metagraph/rpc/pools.json`
- `/metagraph/endpoint-pools.json`
- `/metagraph/schema-drift.json`
- `/metagraph/schemas/index.json`
- `/metagraph/adapters/{slug}.json`
- `/metagraph/r2-manifest.json`
- `/metagraph/review/curation.json`
- `/metagraph/review/gap-priorities.json`
- `/metagraph/review/adapter-candidates.json`
- `/metagraph/review/maintainer-decisions.json`
- `/metagraph/build-summary.json`

The generated files are deterministic and suitable for static hosting, CI review, and downstream consumption.

## Contract Source Of Truth

Metagraphed uses JSON Schema as the canonical public/runtime contract. Contributors should edit modular schemas under `schemas/components/*.schema.json`, then run `npm run schemas:bundle` and `npm run build`.

The contract chain is:

- modular JSON Schema components are canonical;
- `schemas/api-components.schema.json` is a generated bundle;
- `/metagraph/openapi.json` is generated from the schema bundle plus route metadata;
- `/metagraph/types.d.ts` and `generated/metagraphed-api.d.ts` are generated from OpenAPI;
- `generated/metagraphed-client.ts` is a generated TypeScript frontend handoff helper.

Zod is not the backend source of truth in v1. If Zod helpers are added later, they should be generated consumer tooling for frontend/runtime form validation, not canonical registry authority.

Worker API routes expose stable envelopes over the same canonical artifacts:

- `/api/v1`
- `/api/v1/subnets`
- `/api/v1/subnets/{netuid}`
- `/api/v1/surfaces`
- `/api/v1/subnets/{netuid}/surfaces`
- `/api/v1/endpoints`
- `/api/v1/subnets/{netuid}/endpoints`
- `/api/v1/candidates`
- `/api/v1/subnets/{netuid}/candidates`
- `/api/v1/providers`
- `/api/v1/providers/{slug}`
- `/api/v1/providers/{slug}/endpoints`
- `/api/v1/coverage`
- `/api/v1/curation`
- `/api/v1/gaps`
- `/api/v1/health`
- `/api/v1/health/history/{date}`
- `/api/v1/subnets/{netuid}/health`
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
- `/api/v1/openapi.json`
- `/api/v1/build`

## Local Commands

```bash
npm run validate
npm test
npm run build
npm run scan:public-safety
npm run sync:subnets:dry-run
npm run discover:candidates:dry-run
npm run verify:candidates:dry-run
npm run curate:baseline:dry-run
npm run review:promote:dry-run
npm run schemas:snapshot:dry-run
npm run schemas:bundle
npm run adapters:snapshot:dry-run
npm run validate:schemas
npm run validate:api
npm run validate:contract-drift
npm run validate:schema-enums
npm run validate:openapi-examples
npm run validate:generated-client
npm run contract:summary
npm run validate:docs
npm run validate:intake
npm run validate:workflows
npm run submission:pr -- --changed-files changed-files.txt
npm run r2:manifest:dry-run
npm run r2:download:dry-run
npm run kv:publish:dry-run
npm run worker:deploy:dry-run
npm run probes:smoke
```

`sync:subnets` uses the Bittensor Python SDK through `uvx` to fetch decoded native Finney subnet metadata without committing Python dependencies to this repo.

`discover:candidates` reads public enrichment sources and writes unverified candidate surfaces into `registry/candidates/generated/public-sources.json`.

`verify:candidates` safely checks candidate URLs and writes live/dead/auth/unsupported classifications into `registry/verification/latest.json`.

`curate:baseline` promotes verified public-safe candidates into generated baseline overlays for every active netuid that does not already have a hand-curated overlay.

`review:promote` applies public-safe maintainer review decisions from `registry/reviews/maintainer-reviewed.json`.

`schemas:snapshot` captures machine-readable OpenAPI/Swagger schema summaries and drift state.

`schemas:bundle` bundles canonical modular JSON Schema components into `schemas/api-components.schema.json`.

`validate:contract-drift`, `validate:schema-enums`, `validate:openapi-examples`, and `validate:generated-client` enforce schema/OpenAPI/type/client parity.

`contract:summary` compares the bundled schema against a base ref and classifies contract changes as additive, risky, or breaking for PR review.

`adapters:snapshot` captures safe Allways/Gittensor public adapter summaries without raw wallet, miner, PAT, or validator-local payloads.

`probes:smoke` performs read-only checks against public surfaces. It does not submit transactions, mutate subnet state, send wallet data, or use credentials.

`r2:manifest` generates the Cloudflare R2 upload manifest for the current artifact tree. `r2:upload` is delta-based by default, using `latest/r2-manifest.json` to skip unchanged artifacts while refreshing R2 control files on full uploads. Smoke uploads with `METAGRAPH_R2_UPLOAD_LIMIT` upload only the limited artifact subset and intentionally skip control files so `latest/r2-manifest.json` never advertises artifacts that were not uploaded. `r2:upload`, `r2:download`, and `kv:publish` require explicit write flags so local validation cannot accidentally publish or restore.

## Community Submissions

Metagraphed supports PR-first and issue-first UGC for public subnet interface corrections. Direct UGC PRs must change exactly one `registry/candidates/community/*.json` file and no generated artifacts. Public preflight returns broad states (`submit_pr`, `fix_required`, `route_away`, `manual_review`); private gate scoring and merge heuristics are intentionally not committed.

See `docs/submission-gate.md` and `CONTRIBUTING.md` for the submission contract.

## Repository Layout

```text
docs/                 product and operating notes
registry/native/      generated chain-derived subnet snapshots
registry/candidates/  unverified interface candidates pending review
registry/providers/   provider metadata
registry/reviews/     public-safe maintainer review decisions
registry/subnets/     curated subnet interface overlays
registry/verification/ generated candidate verification snapshots
schemas/              public JSON schema contracts
scripts/              validation, artifact generation, probe, and safety scripts
generated/            generated TypeScript handoff types and client helpers
workers/              Cloudflare Worker API routes over static artifacts
public/metagraph/     generated public JSON artifacts
tests/                node test runner checks
```

## License

MIT
