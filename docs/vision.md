# Metagraphed Vision

Metagraphed starts as a registry, status, and indexer layer, not a generic node-ops business.

The wedge is simple: Bittensor has a native metagraph for subnet state, but builders still need to know how to consume subnet interfaces in practice. That means public APIs, OpenAPI/Swagger surfaces, dashboards, docs, repositories, endpoint health, schema drift, freshness, and access metadata.

## Positioning

Metagraphed extends the native Bittensor metagraph with public interface and health metadata.

It does not replace protocol state, explorer analytics, subnet docs, validator dashboards, or RPC providers. It sits beside them as an operational interface registry.

## Current Backend State

The backend currently covers all active Finney netuids:

- `129` active netuids: root `0` plus `128` application subnets.
- `0` native-only entries.
- Every active netuid has a curated overlay.
- Allways SN7 and Gittensor SN74 are adapter-backed pilots.
- Root netuid `0` is the home for Bittensor base-layer Subtensor RPC/WSS endpoints.
- Health, badge, status, adapter, review, schema, RPC, search, freshness, evidence, and R2 manifest artifacts all live under `metagraph.sh/metagraph/*`.
- Generalized endpoint resources and endpoint pools are generated under `metagraph.sh/metagraph/*` from curated surfaces and probe-derived observations.
- Worker API routes under `metagraph.sh/api/v1/*` expose stable envelopes over those canonical artifacts.
- JSON Schema is the canonical public contract source. OpenAPI, TypeScript definitions, and frontend handoff helpers are generated projections.

## Product Layers

### Native Metagraph Layer

Universal Bittensor state for every active subnet:

- netuid;
- subnet identity;
- symbol;
- participant counts;
- registration block;
- mechanism count;
- tempo and block timing.

The MVP intentionally avoids publishing owner keys or validator-sensitive details even when they are chain-public.

### Interface Metagraph Layer

Declarative metadata for public interfaces:

- APIs;
- OpenAPI/Swagger;
- SSE/event streams;
- dashboards;
- source repositories;
- docs;
- JSON-RPC/WSS endpoints;
- archive-capability signals for base-layer endpoints;
- public data artifacts;
- rate-limit and auth notes.

This adapts the Cosmos Directory endpoint idea to Bittensor instead of copying it literally. Root/system carries Bittensor RPC/WSS/archive-capability endpoints. Subnet entries carry heterogeneous subnet-app resources such as APIs, OpenAPI, SSE, dashboards, SDKs, examples, docs, repos, and data artifacts.

### Health Metagraph Layer

Observed status metadata:

- uptime samples;
- latency;
- status code;
- schema hash;
- schema drift;
- JSON-RPC method support;
- archive probe support;
- freshness;
- error class;
- probe history.

## Pilot

Allways SN7 provides a concrete public API surface: swaps, events, crown data, miners, leaderboard, reliability, protocol state, OpenAPI, and SSE.

Gittensor SN74 provides a different operational shape: repositories, bounties, contribution rules, emissions metadata, maintainer-cut metadata, mirror freshness, and public-safe aggregate metrics.

## Funding Path

Gittensor emissions should fund software stewardship, review, registry maintenance, and contributor coordination.

Recurring infra costs should be separate milestones: hosted mirrors, cache layers, load-balanced public subnet access, Bittensor lite/archive nodes, and other OPEX-heavy work.

Cloudflare is now part of the backend path while available: Workers serve API routes, R2 stores artifact history, and KV can store latest pointers, feature flags, endpoint-pool status, and source-freshness summaries. GitHub-reviewed artifacts remain canonical.

## Public-Safety Boundary

Metagraphed must not ingest or publish:

- secrets;
- wallet paths;
- private keys;
- private dashboards;
- validator-only flows;
- token-gated data;
- credentialed GitHub flows;
- user-specific operational state.

Everything in the MVP should be public, read-only, and safe to probe.

## Intake Boundary

Community submissions and third-party discovery go into a candidate queue first.

Schema-valid means the submission can be reviewed. It does not mean the interface is verified or published. Promotion into a curated overlay requires maintainer review of source support, public accessibility, auth/rate-limit labels, and probe safety.

Endpoint/status reports can trigger review or re-probes, but they cannot directly set uptime, latency, health status, or pool eligibility. Those fields are generated only from scheduled probes and adapter checks.
