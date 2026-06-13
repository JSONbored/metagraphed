# MCP Registry submission

metagraphed's hosted MCP server is listed in the canonical
[MCP Registry](https://registry.modelcontextprotocol.io) so that MCP-aware
clients (Claude, IDEs, agent runtimes) can discover and add it by name instead
of being handed a URL out of band.

This complements — it does not replace — the self-hosted discovery surfaces
(`/.well-known/mcp/server-card.json`, `/.well-known/mcp.json`, the api-catalog
linkset, and the `POST /mcp` endpoint itself). The registry is one more front
door; the server-card remains the authoritative, always-current description.

## The listing

- **Manifest:** [`server.json`](../server.json) at the repo root, validated
  against `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`.
- **Name (namespace):** `io.github.jsonbored/metagraphed`. The `io.github.*`
  namespace is proven by **GitHub OIDC** from this repo — no DNS record, no
  Ed25519 key, no stored secret. (The branded reverse-DNS alternative
  `sh.metagraph/*` would require a DNS `TXT` record + a signing key held as a CI
  secret; not worth the operational surface for an equivalent listing.)
- **Transport:** a single `remotes[]` entry —
  `{ "type": "streamable-http", "url": "https://api.metagraph.sh/mcp" }`. There
  is **no package** (npm/PyPI) to publish; this is a hosted remote server, so
  the registry stores only the metadata pointing at the live endpoint.

## Publishing

`mcp-publisher` is run from CI by
[`.github/workflows/publish-mcp-registry.yml`](../.github/workflows/publish-mcp-registry.yml):

1. **Trigger:** manual (`workflow_dispatch`) — Actions → _Publish MCP Registry_
   → _Run workflow_. Mirrors the Python SDK release flow.
2. **Auth:** `mcp-publisher login github-oidc` using the job's `id-token: write`
   OIDC token. The registry maps the token's repo owner (`JSONbored`) to the
   `io.github.jsonbored/*` namespace. **No secret to configure.**
3. **Supply chain:** the `mcp-publisher` binary is pinned to a release tag and
   verified against a hardcoded SHA256 before it runs.
4. **Publish:** `mcp-publisher publish` reads `server.json` and submits it.

### Re-publishing / version bumps

The registry **rejects a re-publish of an existing `version`**. To ship a
change, bump `version` in `server.json` (it is an independent listing version —
not the live `serverInfo.version`, which tracks the API contract) and re-run the
workflow. Editing `server.json` without bumping the version will fail the
publish step, by design.

## Verifying a published listing

```
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.jsonbored/metagraphed" | jq .
```

The returned record should show the `streamable-http` remote at
`https://api.metagraph.sh/mcp` and the current `version`.

## Adding the server in a client

Most MCP clients accept the remote URL directly:

```
https://api.metagraph.sh/mcp
```

Registry-aware clients can instead resolve it by name —
`io.github.jsonbored/metagraphed` — and pick up the transport automatically.
