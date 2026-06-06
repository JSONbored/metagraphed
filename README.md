# Metagraphed

Every subnet, metagraphed.

Metagraphed is an unofficial operational registry for Bittensor subnet interfaces, health, schemas, and public access metadata.

The native Bittensor metagraph tells you what is happening at the subnet protocol layer. Metagraphed adds the missing builder-facing layer around it: public APIs, OpenAPI/Swagger surfaces, dashboards, repositories, endpoint health, probe history, schema drift, and access notes.

## Domains

- `metagraph.sh` is the main product and public artifact surface.
- `subnet.health` is reserved for status pages, probe output, badges, and health-focused redirects.

Example future routes:

- `https://metagraph.sh/subnets/7`
- `https://metagraph.sh/metagraph/subnets.json`
- `https://subnet.health/7`
- `https://subnet.health/badge/7.svg`

## What This Is

- a registry of public subnet interfaces;
- a deterministic JSON artifact generator;
- a probe surface for safe public endpoints;
- a status layer for APIs, schemas, and public data surfaces;
- a foundation for future hosted/cache/load-balanced subnet access.

## What This Is Not

- not an official OpenTensor or Bittensor project;
- not a replacement for the native Bittensor metagraph;
- not another alpha dashboard, docs encyclopedia, or generic RPC provider;
- not a validator credential, wallet, or private scoring mirror.

## Registry Coverage

Metagraphed is chain-first:

- every active Finney netuid gets a native stub entry from decoded Bittensor/Subtensor data;
- root `netuid: 0` is included and labeled as root/system;
- curated overlays add public interface metadata only after review;
- third-party APIs are enrichment/candidate sources, not canonical existence sources.
- generated candidates capture public-source leads, but only reviewed overlays become verified surfaces.

Coverage levels:

- `native-only`: chain-derived subnet entry, no verified public interface metadata yet;
- `manifested`: curated interface metadata exists, but no default probe is enabled;
- `probed`: curated interface metadata exists and at least one safe read-only probe is configured.

## Pilot Overlays

The initial rich overlays track:

- Allways SN7: API health, protocol state, network overview, miners, leaderboard, reliability, events, crown data, and SSE.
- Gittensor SN74: public docs, repository registration surfaces, bounty/contribution metadata concepts, maintainer-cut metadata concepts, and public-safe aggregate registry surfaces.

Credentialed flows, wallet paths, validator-sensitive internals, private dashboards, and token-gated data are intentionally out of scope.

## Artifact Contract

Generated public artifacts live under `public/metagraph`:

- `subnets.json`
- `surfaces.json`
- `candidates.json`
- `review-queue.json`
- `providers.json`
- `metagraph/latest.json`
- `health/latest.json`
- `coverage.json`
- `subnets/{netuid}.json`
- `adapters/allways.json`
- `adapters/gittensor.json`
- `build-summary.json`

The generated files are deterministic and suitable for static hosting, CI review, and downstream consumption.

## Local Commands

```bash
npm run validate
npm test
npm run build
npm run scan:public-safety
npm run sync:subnets:dry-run
npm run discover:candidates:dry-run
npm run probes:smoke
```

`sync:subnets` uses the Bittensor Python SDK through `uvx` to fetch decoded native Finney subnet metadata without committing Python dependencies to this repo.

`discover:candidates` reads public enrichment sources and writes unverified candidate surfaces into `registry/candidates/generated/public-sources.json`.

`probes:smoke` performs read-only checks against public surfaces. It does not submit transactions, mutate subnet state, send wallet data, or use credentials.

## Repository Layout

```text
docs/                 product and operating notes
registry/native/      generated chain-derived subnet snapshots
registry/candidates/  unverified interface candidates pending review
registry/providers/   provider metadata
registry/subnets/     curated subnet interface overlays
schemas/              public JSON schema contracts
scripts/              validation, artifact generation, probe, and safety scripts
public/metagraph/     generated public JSON artifacts
tests/                node test runner checks
```

## License

MIT
