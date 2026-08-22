# Authentication

The metagraphed API at `api.metagraph.sh` is **public by default and
read-only**. No authentication is _required_ for any endpoint — every tool and
route is callable anonymously.

Authentication is **optional and additive**. It raises rate limits, and it
unlocks depth. History windows longer than 90 days need a
paid tier, and a small number of tools need an identity at all (see below). Every
tool stays listed and callable at every tier — what a tier buys is how far back
you may read, not what you may see.

- Auth scheme: none required; `Authorization: Bearer` accepted
- Registration: not required, but self-serve keys are available
- Protected resources: `POST /mcp` is an OAuth 2.1 protected resource that
  permits anonymous access
- OAuth / OIDC: supported for MCP clients (see below)

## Optional credentials

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

An anonymous request is **served, not challenged** — with one exception. Calling
a tool that needs an identity returns `401` with the same challenge, so a
spec-compliant client can offer to sign in and retry. Those tools are:

- `delete_surface_credential`
- `list_surface_credentials`
- `store_surface_credential`

They bind a stored secret to an account, which an anonymous request has none of.

## What a tier buys

- **Depth.** Windows up to 90 days are open to every caller.
  Longer windows answer `payment_required`, naming the tier that clears them and
  where to get one.
- **Rate.** See below.
- **Identity.** The credential store above.

Nothing is hidden from an anonymous caller: a refused call says what it needs.

## Rate limits

Anonymous limits apply per client IP; a valid key raises them per account.
Each entry below is anonymous → keyed.

- REST + artifact reads: unmetered either way (cached at the edge)
- RPC proxy (`/rpc/v1/*`): 100 / 60s → higher, per tier
- MCP endpoint (`POST /mcp`): 100 / 60s → 500 / 60s, higher on paid tiers
- AI routes (`/api/v1/ask`, `/api/v1/search/semantic`): 20 / 60s → higher, per tier

Keyed accounts are also subject to a cost-weighted daily quota.

## Discovery

- Machine index: https://api.metagraph.sh/llms.txt
- Agent workflows: https://api.metagraph.sh/agent-workflows.md
- API catalog (RFC 9727): https://api.metagraph.sh/.well-known/api-catalog
- OpenAPI 3.1: https://api.metagraph.sh/metagraph/openapi.json
- MCP server card: https://api.metagraph.sh/.well-known/mcp/server-card.json
