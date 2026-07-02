# ADR 0003 — AI-native layer (agent catalog, llms.txt, remote MCP server)

- **Status:** Accepted — implemented. AI-1 (agent catalog + llms.txt), AI-2 (MCP server), and AI-3 (semantic search + `/ask`) all shipped; the remote MCP server is now listed in the canonical MCP Registry, Smithery, and mcp.so. Later AI-native phases are tracked in issues, not this ADR.
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
   exposes thirteen read-only tools (`search_subnets`,
   `find_subnets_by_capability`, `get_subnet`, `get_subnet_health`,
   `list_subnet_apis`, `get_api_schema`, `get_agent_catalog`,
   `get_best_rpc_endpoint`, `registry_summary`, `semantic_search`, `ask`,
   `find_subnet_for_task`, `how_do_i_call`) that are thin wrappers over the same
   artifact/KV readers (and, for the AI ones, the AI search/RAG layer) the REST
   routes use (injected as dependencies, so the module stays pure and the
   resolution is identical). `semantic_search` and `ask` require the AI
   bindings; they degrade to a graceful `isError` result (pointing at the
   keyword tools) when the AI layer is unavailable. The goal-shaped pair —
   `find_subnet_for_task` (plain-language task → callable subnets) and
   `how_do_i_call` (one subnet → concrete call instructions) — works with or
   without AI, using semantic ranking when present and keyword fallback
   otherwise.

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
- The MCP tool surface is versioned by its own SemVer (`MCP_SERVER_VERSION`,
  `serverInfo.version`), separate from the date-based `CONTRACT_VERSION` (#393):
  add a tool/additive field → minor; change/remove a tool's I/O → major;
  behavioral-only fix → patch. `validate:mcp` asserts it is SemVer.
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

## AI-3 — semantic search + `/ask`

`GET /api/v1/search/semantic` and `POST /api/v1/ask` (`src/ai-search.mjs`) are
the only pieces that need new bindings (`AI` + `VECTORIZE`). They are
**out-of-contract dynamic routes** — special-handled like `/api/v1/events`, not
in `API_ROUTES`/OpenAPI/the `validate-api` count invariant — so the contract
spine and the count invariant are untouched. Semantic search embeds the query
(`@cf/qwen/qwen3-embedding-0.6b`, 1024-dim — tops MTEB English) and queries the
Vectorize index `metagraphed-registry-v2` (1024-dim/cosine); `/ask` is grounded
RAG over the top-k with a cite-only prompt to
`@cf/meta/llama-4-scout-17b-16e-instruct` (131k ctx, non-reasoning, so the
cite-only `completion.response` path is unchanged). These are the best free
Workers AI models verified available on the account; Vectorize is included on
the Workers Paid plan and the ~1.4M stored dimensions sit well inside the 10M
free allowance.

Three gates bound cost/abuse: the `METAGRAPH_ENABLE_AI` kill-switch, binding
presence (absent in local/CI → `503 ai_unavailable`, so CI never calls Workers
AI), and the `AI_RATE_LIMITER` native rate-limit binding (20/60s per IP; absent
→ allow), plus hard result/context/question caps. A daily embedding-sync cron
(`37 3 * * *`, Worker-runtime) diffs `search.json` against a KV content-hash
manifest and re-embeds only deltas, so embeddings stay ≤24h fresh while
structural data stays fresh on the existing path. The KV-based rate limiter from
the original plan was replaced by the native binding already used by the RPC
proxy (zero KV cost, same config shape). Validated by `npm run validate:ai`
against standalone `schemas/ai/*.schema.json`.
