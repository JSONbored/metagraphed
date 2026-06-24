# Releasing

How metagraphed ships. Most of it is automatic — the only steps that need a
manual trigger are the MCP registry listings. This is a reference, not a process
to follow on every change.

## Automatic — no action needed

| Surface                        | Trigger                                | Mechanism                                           |
| ------------------------------ | -------------------------------------- | --------------------------------------------------- |
| Code + bundled assets          | push to `main`                         | Cloudflare Workers Builds (CF git integration)      |
| Data artifacts (R2 / KV)       | push to `registry/**` + daily schedule | `publish-cloudflare.yml`                            |
| Economics / metagraph / health | scheduled crons                        | `refresh-economics.yml`, `refresh-metagraph.yml`, … |

Data is probe- and chain-derived and rebuilt on schedule — it is never
hand-edited (health/uptime/latency especially). See
[ADR 0001](docs/adr/0001-r2-only-data-artifacts.md) for the data architecture.

## Versioned packages — release-please

`@jsonbored/metagraphed` (npm) and `metagraphed` (PyPI) are cut by
**release-please**:

1. Conventional-commit merges to `main` accumulate into a Release PR.
2. Merging the Release PR dispatches `publish-client.yml` (npm) and
   `publish-python.yml` (PyPI) via **OIDC Trusted Publishing** — no tokens.

A bare manual dispatch of either workflow is the override path.

## MCP registry listings — manual

The hosted MCP server (`https://api.metagraph.sh/mcp`, defined in `server.json`)
is listed in three registries. **Run these after changing MCP tools / prompts /
resources or `server.json` metadata** so the listings reflect the live server:

1. **Canonical** — `registry.modelcontextprotocol.io`
   - First **bump `version` in `server.json`** (the registry rejects re-publishing
     an existing version).
   - Actions → **Publish MCP Registry** (`publish-mcp-registry.yml`). GitHub OIDC,
     no secret.
2. **Smithery** — `smithery.ai/servers/metagraphed/metagraphed`
   - Actions → **Publish to Smithery** (`smithery-publish.yml`). Uses the
     `SMITHERY_API_KEY` secret scoped to the `smithery` deployment environment.
3. **mcp.so** — `mcp.so/server/metagraphed---bittensor-subnet-registry/JSONbored`
   - Community directory; manual UI edit, only on notable changes.

Both #1 and #2 are `workflow_dispatch` — run them **together** so the canonical
and Smithery listings stay in sync. (#3 rarely needs touching.) The canonical
endpoint stays `https://api.metagraph.sh/mcp` everywhere — registries are
distribution mirrors, not the source of truth.

## Frontend

The UI lives in [metagraphed-ui](https://github.com/JSONbored/metagraphed-ui) and
deploys via Cloudflare Workers Builds (Bun) on push to its `main`.
