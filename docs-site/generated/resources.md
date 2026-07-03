---
title: Agent & MCP resources
description: Machine-readable surfaces for AI agents and integrators.
generated: true
source: public/metagraph/api-index.json
---

# Agent & MCP resources

Metagraphed exposes a rich AI-native layer alongside the REST API. Use these URLs from agents, IDE plugins, and automation.

## MCP server

- **Endpoint:** `https://api.metagraph.sh/mcp` (Streamable HTTP)
- **Install:** `claude mcp add --transport http metagraphed https://api.metagraph.sh/mcp`
- **Server card:** [/.well-known/mcp/server-card.json](https://api.metagraph.sh/.well-known/mcp/server-card.json)

**76 tools** (from the committed MCP server — cannot drift from `POST /mcp`):

- `search_subnets` — Search Bittensor subnets
- `list_subnets` — List all Bittensor subnets
- `find_subnets_by_capability` — Find subnets by capability
- `get_subnet` — Get subnet overview
- `get_subnet_health` — Get subnet health
- `get_subnet_health_trends` — Get subnet health trends
- `get_health_trends` — Get all-subnet health trends
- `get_subnet_health_percentiles` — Get subnet latency percentiles
- `get_subnet_health_incidents` — Get subnet downtime incidents
- `get_subnet_economics` — Get subnet economics
- `get_economics` — Get network-wide subnet economics
- `get_subnet_trajectory` — Get subnet trajectory
- `get_economics_trends` — Get network-wide economics trends
- `get_subnet_concentration` — Get subnet stake/emission concentration
- `get_subnet_performance` — Get subnet reward distribution & score spread
- `get_chain_concentration` — Get network-wide stake/emission concentration
- `get_subnet_concentration_history` — Get subnet concentration history
- `get_subnet_turnover` — Get subnet validator turnover
- `get_subnet_yield` — Get subnet emission yield distribution
- `get_subnet_stake_flow` — Get subnet net stake flow
- `get_subnet_movers` — Get cross-subnet momentum leaderboard
- `get_subnet_uptime` — Get subnet uptime history
- `get_registry_leaderboards` — Get registry leaderboards
- `compare_subnets` — Compare subnets side by side
- `get_global_incidents` — Get global probe incidents
- `get_subnet_metagraph` — Get subnet metagraph (per-UID)
- `list_subnet_validators` — List a subnet's validators
- `list_global_validators` — List the network-wide validator leaderboard
- `get_neuron` — Get one neuron by UID
- `get_subnet_history` — Get a subnet's daily history
- `get_subnet_identity_history` — Get a subnet's on-chain identity history
- `get_neuron_history` — Get one neuron's daily history
- `get_subnet_events` — Get a subnet's chain-event stream
- `get_account` — Get a cross-subnet account summary
- `get_account_balance` — Get an account's live TAO balance
- `get_account_events` — Get an account's chain-event history
- `get_account_subnets` — Get an account's cross-subnet footprint
- `get_account_stake_flow` — Get an account's staking flow scorecard
- `get_account_history` — Get an account's daily activity history
- `get_account_extrinsics` — Get an account's signed extrinsics
- `get_account_transfers` — Get an account's native-TAO transfer feed
- `get_account_counterparties` — Rank an account's transfer counterparties
- `list_blocks` — List recent blocks
- `get_block` — Get a block by number or hash
- `list_block_extrinsics` — List extrinsics in one block
- `get_block_events` — Get decoded events in one block
- `list_extrinsics` — List extrinsics with optional filters
- `get_extrinsic` — Get an extrinsic by hash or composite ref
- `get_chain_activity` — Get recent chain-activity aggregate
- `list_chain_events` — List recent chain events
- `get_chain_calls` — Get extrinsic call-mix breakdown
- `get_chain_signers` — Get the most-active account signers
- `get_chain_fees` — Get chain fee and tip market analytics
- `get_chain_transfers` — Get network-wide native-TAO transfer analytics
- `get_network_activity` — Get daily network-activity aggregates
- `list_subnet_apis` — List a subnet's callable services
- `get_api_schema` — Get a surface's API schema
- `get_fixture` — Get a surface's live request/response fixture
- `get_provider_detail` — Get one provider's detail
- `list_fixtures` — List captured live fixtures
- `list_schemas` — List captured API schemas
- `get_lineage` — Get cross-network subnet lineage
- `get_freshness` — Get registry data freshness
- `get_source_health` — Get per-provider source health
- `get_agent_catalog` — Get the agent capability catalog
- `get_rpc_usage` — Get RPC reverse-proxy usage analytics
- `get_best_rpc_endpoint` — Get the best Bittensor RPC endpoint
- `registry_summary` — Get the registry-wide summary
- `list_enrichment_targets` — List ranked enrichment targets
- `get_subnet_gaps` — Get subnet interface gaps
- `find_subnet_opportunities` — Rank subnets by economic opportunity
- `semantic_search` — Semantic search across the registry
- `ask` — Ask a grounded question about the registry
- `find_subnet_for_task` — Find a subnet that can do a task
- `how_do_i_call` — Get concrete call instructions for a subnet
- `verify_integration` — Verify a surface is callable right now

## Contract API routes

Every API URL below is derived from [`public/metagraph/api-index.json`](../../public/metagraph/api-index.json) — the same contract source as the [API reference](./api-reference.md) freshness gate.
For copyable agent prompts, skills, llms.txt, and other discovery URLs, fetch [https://api.metagraph.sh/api/v1/agent-resources](https://api.metagraph.sh/api/v1/agent-resources) (`GET /api/v1/agent-resources`).

| Route | Method | URL |
| --- | --- | --- |
| `/api/v1/agent-catalog` | GET | [https://api.metagraph.sh/api/v1/agent-catalog](https://api.metagraph.sh/api/v1/agent-catalog) |
| `/api/v1/agent-catalog/{netuid}` | GET | [https://api.metagraph.sh/api/v1/agent-catalog/7](https://api.metagraph.sh/api/v1/agent-catalog/7) |
| `/api/v1/agent-resources` | GET | [https://api.metagraph.sh/api/v1/agent-resources](https://api.metagraph.sh/api/v1/agent-resources) |
| `/api/v1/contracts` | GET | [https://api.metagraph.sh/api/v1/contracts](https://api.metagraph.sh/api/v1/contracts) |
| `/api/v1/openapi.json` | GET | [https://api.metagraph.sh/api/v1/openapi.json](https://api.metagraph.sh/api/v1/openapi.json) |
| `/api/v1/search` | GET | [https://api.metagraph.sh/api/v1/search?limit=3](https://api.metagraph.sh/api/v1/search?limit=3) |
| `/api/v1/search-index` | GET | [https://api.metagraph.sh/api/v1/search-index](https://api.metagraph.sh/api/v1/search-index) |

<sub>Auto-generated by `scripts/generate-docs-site.mjs`. MCP tools from `listToolDefinitions()`; API rows from `api-index.json` route ids: agent-catalog, agent-catalog-subnet, agent-resources, contracts, openapi, search, search-index.</sub>
