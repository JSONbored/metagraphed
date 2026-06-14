# Changelog

All notable, contributor-visible changes to the **metagraphed backend** (the
Cloudflare Worker + registry build) are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

A few things this project versions differently:

- The **hosted API + artifacts** are continuously deployed and identified by the
  date-based `CONTRACT_VERSION` in `src/contracts.mjs` (e.g. `2026-06-06.1`) —
  there are no semantic "platform" releases.
- The **published client SDKs** are versioned independently: npm
  [`@jsonbored/metagraphed`](https://www.npmjs.com/package/@jsonbored/metagraphed)
  and PyPI [`metagraphed`](https://pypi.org/project/metagraphed/).
- **Registry data enrichments** (new/updated subnets, providers, surfaces) are
  not listed here — they show up in the live `/api/v1/changelog` feed.

This file tracks notable changes to the API surface, contracts, MCP server, and
contributor experience.

## [Unreleased]

### Added

- Static agent tool specs for OpenAI + Anthropic at
  `/.well-known/agent-tools/{index,openai,anthropic}.json`, projected from the
  MCP tool list.
- Per-subnet / per-endpoint reliability score (0–100 + grade) over the durable
  uptime history, surfaced on `/api/v1/subnets/{netuid}/uptime` and MCP
  `get_subnet_health`.
- Global cross-subnet incident ledger at `GET /api/v1/incidents` (7d/30d window).
- A worked, schema-valid `example` on every OpenAPI operation, enforced in CI.
- Bidirectional MCP Registry backlink in the served server-card, `mcp.json`, and
  the live `initialize` result.
- The MCP server is listed in the canonical MCP Registry as
  `io.github.JSONbored/metagraphed`.
- `good first issue` / `help wanted` labels on the enrichment queue;
  `CHANGELOG.md`, `FUNDING.yml`.

### Changed

- Deepened the previously-shallow OpenAPI response schemas to be fully typed
  down to the leaf fields.

### Fixed

- Bounded the `/api/v1/incidents` source query so it can't be used as a database
  load generator; adapter `extensions` values now type as open maps.
