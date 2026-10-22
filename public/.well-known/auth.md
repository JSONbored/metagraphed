# metagraphed auth.md

For MCP clients and agents acting on behalf of a user, this guide documents the
supported owner-approved Auth.md registration, OAuth authorization and wallet
API-key provisioning methods. The
resource audience is the `resource` URL in the selected mount's protected-resource
metadata; use that exact URL throughout OAuth authorization and token requests.

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

## OAuth client registration and authorization

1. Fetch protected-resource metadata for the mount you will call:
   `https://api.metagraph.sh/.well-known/oauth-protected-resource/mcp` or
   `https://api.metagraph.sh/.well-known/oauth-protected-resource/mcp/core`.
   The root discovery document is at
   `https://api.metagraph.sh/.well-known/oauth-protected-resource`.
   Read `resource`, `authorization_servers`, `scopes_supported` and
   `bearer_methods_supported`; tokens are sent in the `Authorization` header.
2. Fetch the authorization server's metadata and verify its `issuer` matches the
   advertised authorization server. The supported scope is `profile`.
   Prefer an HTTPS Client ID Metadata Document when the client supports it and
   metadata advertises `client_id_metadata_document_supported`. Otherwise, use
   OAuth dynamic client registration (RFC 7591): `POST https://api.metagraph.sh/oauth/register`
   with JSON containing `client_name`, your `redirect_uris`, and
   `token_endpoint_auth_method: "none"` for a public client. Save the returned
   `client_id`. Registering a client does not issue a user access token.
3. Generate a fresh `state` and PKCE verifier with its S256 challenge. Open the
   discovered `authorization_endpoint` (`GET https://api.metagraph.sh/authorize`) with
   `response_type=code`, `client_id`, `redirect_uri`, `scope=profile`,
   `resource`, `state`, `code_challenge`, and `code_challenge_method=S256`.
   The user approves access and signs in with GitHub. Verify the returned
   `state` before using the authorization code.
4. Exchange the code at `POST https://api.metagraph.sh/oauth/token` using
   `application/x-www-form-urlencoded`: `grant_type=authorization_code`,
   `client_id`, `code`, `redirect_uri`, `code_verifier`, and the same `resource`.
   Send the returned `access_token` as `Authorization: Bearer <access_token>`
   to the selected MCP mount. Respect `expires_in`; when a `refresh_token` is
   issued, refresh at the same token endpoint with `grant_type=refresh_token`,
   `client_id`, `refresh_token`, and the same `resource`.
5. To revoke an OAuth token, use the discovered `revocation_endpoint`
   (`POST https://api.metagraph.sh/oauth/token`) with a form-encoded `token`, omitting
   `grant_type`. A public client (`token_endpoint_auth_method: "none"`) must
   also send `client_id`; confidential clients use their registered
   authentication method. Keep credentials out of URLs.

## Wallet API-key provisioning

1. With the wallet owner's approval, request `POST https://api.metagraph.sh/api/v1/auth/wallet/challenge`
   with JSON `{ "ss58": "<owner's Bittensor address>" }`. Have the owner's
   sr25519 wallet sign the returned `message`; never request the wallet seed.
2. Submit `POST https://api.metagraph.sh/api/v1/auth/wallet/verify` with JSON containing
   the same `ss58` and its `signature`. The returned `session_token` is valid
   for `expires_in_seconds`. This session authorizes key management, not MCP.
3. Call `POST https://api.metagraph.sh/api/v1/keys` with
   `Authorization: Bearer <session_token>`. Save the returned `key` securely;
   the full `mg_...` value is returned only once. Use that value as
   `Authorization: Bearer mg_...` for MCP or authenticated API calls.
4. List keys with `GET https://api.metagraph.sh/api/v1/keys` and revoke a key with
   `DELETE https://api.metagraph.sh/api/v1/keys/<key_id>`, using the wallet session.

## Auth.md agent registration (service_auth)

Use this flow only when authorization-server metadata advertises `agent_auth`
with `service_auth` in `identity_types_supported`. Discovery stays disabled
until the dedicated signing key, rate limiter and private database migration are
available. An unprovisioned endpoint returns `503`; it never issues a credential
with missing durable state. This flow does not support anonymous issuance,
upstream ID-JAG identity assertions or the older `verified_email` identity type.

1. Send `POST https://api.metagraph.sh/agent/register` with JSON
   `{ "type": "service_auth", "login_hint": "owner@example.com" }`.
   Use the intended owner's email address. Save `registration_id` and the
   secret `claim_token` securely. The response includes `claim.user_code`,
   `claim.verification_uri`, `claim.expires_in` and `claim.interval`.
   Registration does not issue an access token or assertion.
2. Give the owner the verification URI and six-digit user code. The owner signs
   in with GitHub, which must report a verified email matching the original
   `login_hint`, reviews the requested `profile` scope, and explicitly
   approves the displayed registration using the code. Sign-in alone is not
   approval. Never send the claim token to a third-party URL or ask for the
   owner's GitHub password, wallet seed or private key.
3. Poll `POST https://api.metagraph.sh/oauth/token` using
   `application/x-www-form-urlencoded` with
   `grant_type=urn:workos:agent-auth:grant-type:claim` and `claim_token`.
   Wait at least the advertised interval. Handle `authorization_pending`,
   `slow_down`, `access_denied` and `expired_token` without creating a new
   registration on every poll. Claims expire after ten minutes.
4. After approval, the claim grant returns an opaque `access_token` and a
   service-signed `identity_assertion`. Send the access token as
   `Authorization: Bearer <access_token>` to `https://api.metagraph.sh/mcp` or its
   `/mcp/core` mount. These tokens resolve to the approving GitHub account
   and its current tier; they do not bypass the existing quotas or permissions.
5. Within the original one-hour approval window, exchange the assertion at the
   same token endpoint using
   `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and
   `assertion=<identity_assertion>`. Optional `resource` must be the canonical
   `https://api.metagraph.sh/mcp` or `https://api.metagraph.sh/mcp/core` audience. Repeated exchanges never extend the original
   approval window. The JWKS is at `https://api.metagraph.sh/oauth/jwks`.
6. Revoke an agent access token using form-encoded
   `POST https://api.metagraph.sh/oauth/revoke` with `token=<access_token>` and
   `token_type_hint=access_token`. To revoke the registration and all derived
   tokens, send `token=<identity_assertion>` with
   `token_type_hint=identity_assertion` to the same endpoint. This prevents
   further exchanges. Ordinary
   OAuth clients continue to use their discovered OAuth revocation endpoint.

The advertised `claim_endpoint` (`POST https://api.metagraph.sh/agent/claim`) accepts
`claim_token` and a matching `email` to start a fresh owner ceremony.
The original intended email cannot be changed during a claim. Rotating a claim
token at `POST https://api.metagraph.sh/agent/rotate` invalidates the previous token and
pending ceremonies. Keep all claim tokens, assertions and access tokens out of
URLs and logs. Passive scanners must read discovery documents only; registration
and claim requests create durable state.

## Credential use and authentication failures

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
