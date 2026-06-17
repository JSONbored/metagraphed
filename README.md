<div align="center">

<a href="https://metagraph.sh"><img src="https://raw.githubusercontent.com/JSONbored/metagraphed/main/public/brand/banner-readme-mint.png" alt="Metagraphed — Bittensor subnet operational layer · data hub · API" width="820"></a>

### Every subnet, metagraphed.

The Bittensor subnet integration registry. For every subnet it answers: **what does it expose** (public APIs, docs, schemas), **is it healthy**, and **how do I call it** — machine-readable, for AI agents and developers alike.

[![Website](https://img.shields.io/badge/website-metagraph.sh-111?logo=cloudflare&logoColor=white)](https://metagraph.sh)
[![MCP](https://img.shields.io/badge/MCP-api.metagraph.sh%2Fmcp-7c3aed)](https://api.metagraph.sh/mcp)
[![npm](https://img.shields.io/npm/v/@jsonbored/metagraphed?logo=npm&label=npm)](https://www.npmjs.com/package/@jsonbored/metagraphed)
[![PyPI](https://img.shields.io/pypi/v/metagraphed?logo=pypi&logoColor=white&label=PyPI)](https://pypi.org/project/metagraphed/)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

**[Website](https://metagraph.sh)** &nbsp;·&nbsp; [API](https://api.metagraph.sh) &nbsp;·&nbsp; [OpenAPI](https://api.metagraph.sh/metagraph/openapi.json) &nbsp;·&nbsp; [MCP](https://api.metagraph.sh/mcp) &nbsp;·&nbsp; [Agent docs](https://api.metagraph.sh/llms.txt) &nbsp;·&nbsp; [Feeds](https://api.metagraph.sh/api/v1/feeds/registry) &nbsp;·&nbsp; [npm](https://www.npmjs.com/package/@jsonbored/metagraphed) &nbsp;·&nbsp; [PyPI](https://pypi.org/project/metagraphed/)

</div>

---

## What it is

The native Bittensor metagraph tells you what's happening at the protocol layer. Metagraphed adds the **builder-facing layer it lacks** — a registry of public subnet interfaces, endpoint health, and machine-readable schemas, built for **integration developers** (often reached through their AI agents) who need to discover and call subnet APIs.

> **Not** an official OpenTensor/Bittensor project · **not** a replacement for the native metagraph · **not** an alpha/price dashboard · **not** a wallet, validator, or credential tool.

The web UI lives at **[metagraph.sh](https://metagraph.sh)**. The API is served from **`https://api.metagraph.sh`** (REST under `/api/v1`, artifacts under `/metagraph`).

## Quickstart

Three ways to use Metagraphed. Pick one.

#### 🤖 AI agent (MCP)

Agent-native, public, read-only, Streamable-HTTP. 14 tools to discover a subnet, check if it's up, and learn how to call it.

```bash
claude mcp add --transport http metagraphed https://api.metagraph.sh/mcp
```

> Cursor / other clients: add an MCP server with url `https://api.metagraph.sh/mcp`, transport `streamable-http`.
>
> Tools: `search_subnets` · `find_subnets_by_capability` · `get_subnet` · `get_subnet_health` · `list_subnet_apis` · `get_api_schema` · `get_fixture` · `get_agent_catalog` · `get_best_rpc_endpoint` · `registry_summary` · `semantic_search` · `ask` · `find_subnet_for_task` · `how_do_i_call`

#### 📦 Typed client

Generated from the OpenAPI contract, published with provenance.

```bash
npm i @jsonbored/metagraphed   # JS/TS
pip install metagraphed        # Python
```

#### 🌐 REST

Stable JSON envelope `{ ok, data, meta, error }`. OpenAPI at [`/metagraph/openapi.json`](https://api.metagraph.sh/metagraph/openapi.json).

```bash
curl https://api.metagraph.sh/api/v1/subnets
```

## For agents

| Resource              | URL                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copyable agent prompt | [`/agent.md`](https://api.metagraph.sh/agent.md)                                                                                                                                      |
| Machine index         | [`/llms.txt`](https://api.metagraph.sh/llms.txt)                                                                                                                                      |
| Drop-in skill         | [`/skills/bittensor/SKILL.md`](https://api.metagraph.sh/skills/bittensor/SKILL.md)                                                                                                    |
| Resources index       | [`/metagraph/agent-resources.json`](https://api.metagraph.sh/metagraph/agent-resources.json)                                                                                          |
| Content feeds         | [`/api/v1/feeds/registry`](https://api.metagraph.sh/api/v1/feeds/registry) — registry changes + incidents, as RSS / Atom / JSON Feed (per-subnet at `/api/v1/feeds/subnets/{netuid}`) |
| Readiness badge       | `![metagraphed](https://api.metagraph.sh/api/v1/subnets/{netuid}/badge.svg)` — embeddable SVG (also `/providers/{slug}/badge.svg`)                                                    |

## This repo

Cloudflare Worker API + Node build scripts. **Schema-first**: JSON Schema is the canonical contract → OpenAPI → types/clients. Artifacts are deterministic JSON; data refreshes on a schedule to R2/KV.

```text
docs/              product + operating notes (start here)
registry/          subnet overlays, candidates, community submissions
schemas/           canonical JSON Schema components
scripts/           validation, generation, probe, safety
workers/           Cloudflare Worker API routes
public/metagraph/  compact generated artifacts + contracts
generated/         generated TypeScript types + client
```

Deeper docs: [`docs/api-stability.md`](docs/api-stability.md) (the `/api/v1` contract), [`docs/submission-gate.md`](docs/submission-gate.md), [`docs/curation-playbook.md`](docs/curation-playbook.md).

## Contributing

Issues are labeled `good first issue` and `help wanted` — start there.

- **Schema-first edits** require `npm run build` (regenerates `openapi.json` + types).
- **Community submissions** are PR-first: touch exactly one `registry/candidates/community/*.json` file, no generated artifacts.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/submission-gate.md`](docs/submission-gate.md).

## Related

- **Frontend** — [JSONbored/metagraphed-ui](https://github.com/JSONbored/metagraphed-ui): the web app at [metagraph.sh](https://metagraph.sh). Vite + React 19 + TanStack Start, deployed as a Cloudflare Worker. Holds no subnet data — it renders what this backend serves.

## License

The backend (Cloudflare Worker + build pipeline) is **[AGPL-3.0](./LICENSE)**. The
published client SDKs are permissively licensed so you can embed them freely —
[`packages/client`](./packages/client) (npm) and [`python/`](./python) (PyPI) are
**[Apache-2.0](./packages/client/LICENSE)**.

© 2026 JSONbored
