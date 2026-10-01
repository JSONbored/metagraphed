# Authentication

The public, read-only REST API at `api.metagraph.sh` remains **public by default and
read-only**. Authentication is optional for public REST reads and
raises their limits or unlocks existing history depth.

**MCP authentication is required. Sign-in is free.** All MCP mounts and catalog
profiles require OAuth 2.1 or an API key. Authentication does not introduce a
subscription purchase: free accounts can discover and invoke the full tool
catalog, subject to existing quotas, permissions and history-depth limits.

- MCP auth scheme: `Authorization: Bearer` with OAuth or an `mg_` API key
- REST auth scheme: optional `Authorization: Bearer`
- Protected resources: `/mcp` and `/mcp/core`, including full catalog mode
- OAuth metadata, client registration and the MCP server card remain public

## Credentials

**API key.** A self-serve `mg_...` key sent as `Authorization: Bearer mg_...`
raises the rate limits below. Keys are minted by wallet-signature login.

**OAuth 2.1.** MCP clients that speak the spec can discover and complete
authorization with no manual configuration:

- Protected-resource metadata (RFC 9728):
  https://api.metagraph.sh/.well-known/oauth-protected-resource/mcp
- Authorization-server metadata:
  https://api.metagraph.sh/.well-known/oauth-authorization-server

A Bearer token that cannot be validated gets `401` with a
`WWW-Authenticate` challenge pointing at the metadata above.

An unauthenticated MCP request returns **HTTP 401** with a
`WWW-Authenticate` challenge before parsing the request body. A session ID is
not a credential. MCP clients should follow the metadata to sign in and retry
with a token. If an already-validated OAuth account cannot be resolved, the
server returns HTTP 503 with `Retry-After`; retry rather than re-consent.

These account-bound credential-store tools additionally bind stored secrets to
the authenticated account:

- `delete_surface_credential`
- `list_surface_credentials`
- `store_surface_credential`

They store, list or delete surface credentials (see `/credential-store.md`).

## What a tier buys

- **Depth.** Windows up to 90 days are open to every caller.
  Longer windows answer `payment_required`, naming the tier that clears them and
  where to get one.
- **Rate.** See below.
- **Identity.** The credential store above.

MCP authentication is required regardless of tier. Free accounts see the full
catalog; existing depth gates govern how much history they may read.

## Rate limits

Public REST anonymous limits apply per client IP; authenticated limits are per
account. Unauthenticated MCP requests are refused before dispatch and are
still rate-limited. The other entries below are anonymous → keyed.

- REST + artifact reads: unmetered either way (cached at the edge)
- RPC proxy (`/rpc/v1/*`): 100 / 60s → higher, per tier
- MCP endpoint (`POST /mcp`): authentication required; free accounts 500 / 60s, higher on paid tiers
- AI routes (`/api/v1/ask`, `/api/v1/search/semantic`): 20 / 60s → higher, per tier

Keyed accounts are also subject to a cost-weighted daily quota.

## Discovery

- Machine index: https://api.metagraph.sh/llms.txt
- Agent workflows: https://api.metagraph.sh/agent-workflows.md
- API catalog (RFC 9727): https://api.metagraph.sh/.well-known/api-catalog
- OpenAPI 3.1: https://api.metagraph.sh/metagraph/openapi.json
- MCP server card: https://api.metagraph.sh/.well-known/mcp/server-card.json
