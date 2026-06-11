# ADR 0003 — AI-native layer (agent catalog, llms.txt, remote MCP server)

- **Status:** Accepted — implementing. AI-1 (agent catalog + llms.txt) and AI-2 (MCP server) shipped; AI-3 (semantic search + `/ask`) planned.
- **Date:** 2026-06-10
- **Relates to:** ADR 0001 (R2-only data artifacts), ADR 0002 (live operational health).

## Context

metagraphed owns a unique niche: the **operational + integration layer** of
Bittensor — what each of the ~129 subnets exposes (APIs, docs, schemas), whether
those surfaces are healthy, and how to call them. Until now that data was
**REST-only**: a human or program had to know the route shape, and there was no
machine-first way for an AI agent or LLM to discover and integrate a subnet's
services. The chain-data tools (taostats, the Bittensor SDK, RPC providers) do
not cover this layer, and none of them are agent-consumable for _application_
discovery.

The registry is already generated, validated, and served as a stable artifact
contract. The opportunity is to project that same data into the three shapes an
AI consumer needs — a machine capability catalog, an `llms.txt` discovery file,
and a Model Context Protocol server — **without** adding a second source of
truth or touching the REST/RPC hot path.

## Decision

Add an AI-native layer as thin projections/wrappers over the existing artifact
contract. No new authority, no new pipeline.

1. **Agent capability catalog** (AI-1). `scripts/build-artifacts.mjs` joins
   curated surfaces (`kind ∈ subnet-api/openapi/sse`) with the schema index and
   endpoint health to emit `/metagraph/agent-catalog.json` (compact, committed
   index of the subnets exposing callable services) and per-subnet
   `/metagraph/agent-catalog/{netuid}.json` (R2; each service = capability, base
   URL, auth, machine-readable schema URL/artifact, health, and
   `eligibility.callable`). Served at `GET /api/v1/agent-catalog[/{netuid}]`
   through the normal artifact-backed route harness.

2. **`llms.txt`** (AI-1). The build emits `public/llms.txt`,
   `public/llms-full.txt`, and `public/.well-known/llms.txt` from
   `mergedSubnets` + `API_ROUTES`, served by ASSETS at the API root. Short index
   plus an expanded per-subnet/route index so any LLM that ingests them answers
   accurately about the ecosystem and links to the machine entrypoints
   (OpenAPI, agent catalog, MCP).

3. **Remote MCP server** (AI-2). `POST /mcp` is a **stateless** Model Context
   Protocol server (Streamable HTTP, JSON-RPC 2.0) in `src/mcp-server.mjs`. It
   exposes nine read-only tools (`search_subnets`,
   `find_subnets_by_capability`, `get_subnet`, `get_subnet_health`,
   `list_subnet_apis`, `get_api_schema`, `get_agent_catalog`,
   `get_best_rpc_endpoint`, `registry_summary`) that are thin wrappers over the
   same artifact/KV readers the REST routes use (injected as dependencies, so
   the module stays pure and the resolution is identical).

## Rationale for the key choices

- **Hand-rolled MCP, not `@modelcontextprotocol/sdk` + a Durable Object.** The
  registry is read-only and stateless, so the full Agents/MCP SDK (and the
  Durable Object it implies for session state) is unjustified weight on a Worker
  whose hot path is REST/RPC. JSON-RPC 2.0 over a single POST is small and fully
  testable; we keep the bundle lean and the cold path unaffected. (If a future
  tool needs server-initiated streaming or sessions, revisit.)
- **Dependency-injected readers instead of extracting `readArtifact`.** The plan
  considered moving `readArtifact`/`readHealthKv` into a shared
  `src/artifact-reader.mjs`. That cluster pulls in `readR2`/`readAsset`/
  `latestR2Key`/timeouts/logging and sits on the hot path; extracting it is a
  large, risky refactor for no functional gain. Instead `handleMcpRequest`
  receives `{ readArtifact, readHealthKv }` from `workers/api.mjs`. Same reuse,
  zero hot-path churn, and the MCP module is unit-testable with stub deps.
- **Catalog/llms.txt as build artifacts, MCP as a wrapper.** Both reuse the
  generation and serving spine, inherit subset-commit discipline and the
  artifact budgets, and add no new freshness class.

## Validation

- Agent-catalog routes go through the standard `validate-api` per-route harness
  (+2 checks); the new schema components are AJV-validated, including the
  per-subnet templated artifact.
- The MCP server has its own contract validator, `npm run validate:mcp`
  (lifecycle + one `tools/call` per tool against a cold local env), kept out of
  the `validate-api` `checks.length === API_ROUTES.length` invariant because
  `/mcp` is not artifact-backed.
- `tests/mcp-server.test.mjs` unit-tests every tool and the JSON-RPC envelope
  (notifications, batch, parse/transport errors, isError degradation) under the
  ≥98%-line coverage gate.
- `scripts/smoke-live-api.mjs` exercises the live MCP handshake + a `tools/call`
  post-deploy.

## Consequences

- AI agents and LLM crawlers can discover and integrate Bittensor subnet
  services directly; `/mcp` makes every MCP-capable assistant Bittensor-aware
  with no custom code.
- One more set of generated artifacts to keep reproducible (covered by
  `ci-verify-submitted-artifacts` + subset-commit discipline).
- `get_best_rpc_endpoint` depends on the live health KV (ADR 0002); with no live
  snapshot it degrades to the build-time pool eligibility rather than failing.
- AI-3 (semantic search + `/ask` via Vectorize + Workers AI) will add the only
  pieces that need new bindings and a kill-switch; it is intentionally deferred
  so the zero-binding agent surface ships first.
