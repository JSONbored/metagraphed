# Authentication

The metagraphed API at `api.metagraph.sh` is fully public and read-only.
**No authentication, API key, token, or registration is required** for any
endpoint.

- Auth scheme: none
- Registration: not required (there is nothing to register for)
- Protected resources: none
- OAuth / OIDC: not applicable (no protected resources to authorize)

If a tool expects an `Authorization` header, omit it — requests with or
without one are treated identically.

## Rate limits

Anonymous abuse-control limits apply per client IP (no key raises them):

- REST + artifact reads: unmetered (cached at the edge)
- RPC proxy (`/rpc/v1/*`): 100 requests / 60s
- MCP endpoint (`POST /mcp`): 100 requests / 60s
- AI routes (`/api/v1/ask`, `/api/v1/search/semantic`): 20 requests / 60s

## Discovery

- Machine index: https://api.metagraph.sh/llms.txt
- API catalog (RFC 9727): https://api.metagraph.sh/.well-known/api-catalog
- OpenAPI 3.1: https://api.metagraph.sh/metagraph/openapi.json
- MCP server card: https://api.metagraph.sh/.well-known/mcp/server-card.json
