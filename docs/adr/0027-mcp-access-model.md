# ADR 0027 — MCP access model: public by default, authentication buys throughput

- **Status:** Accepted · partially implemented (#8967)
- **Date:** 2026-08-02
- **Relates to:** #8967 (this ADR), #8608 / #8611 / #8812 (the tiered ceilings,
  blocklist and daily quota that landed on `/mcp` before this was written),
  #7151 / #7153 (the OAuth provider and its GitHub identity), ADR 0020 (API-key
  issuance and storage), ADR 0022 (the deferred paid-tier decision this feeds)

## Context

`/mcp` is the surface with the largest plans attached to it and the least
written down about who may call it. This ADR records the decision that had been
accreting in code without ever being stated.

**The starting assumption was wrong, and that matters for the decision.** The
issue behind this ADR described `/mcp` as "fully public … no `Authorization`
check, no bearer verification, no `WWW-Authenticate` challenge, no
`/.well-known/oauth-protected-resource`", with three auth systems built and
none connected. Checking the tree and then production found most of that had
already been built:

| control                                                | state | where                                                       |
| ------------------------------------------------------ | ----- | ----------------------------------------------------------- |
| `Authorization: Bearer mg_…` verified                  | live  | `workers/tiered-rate-limit.ts:219-222` via `validateApiKey` |
| per-tier ceilings, not a flat 100/60s                  | live  | `MCP_TIERED_RATE_LIMIT`, `src/mcp-server.ts` (#8608)        |
| account blocklist ahead of the ceiling                 | live  | `workers/tiered-rate-limit.ts` (#8611)                      |
| cost-weighted daily quota                              | live  | `workers/tiered-rate-limit.ts` (#8812)                      |
| `/.well-known/oauth-protected-resource`                | live  | `@cloudflare/workers-oauth-provider`                        |
| `/.well-known/oauth-protected-resource/mcp` (RFC 9728) | live  | same                                                        |
| `/.well-known/oauth-authorization-server`              | live  | same                                                        |
| `WWW-Authenticate` on 401                              | live  | same                                                        |

Verified against production, not inferred. A POST to `/mcp` with a Bearer token
the provider cannot validate returns:

```
HTTP/2 401
www-authenticate: Bearer realm="OAuth",
  resource_metadata="https://api.metagraph.sh/.well-known/oauth-protected-resource/mcp",
  error="invalid_token"
```

while an anonymous POST returns 200.

So the honest description of today is not "public with no auth". It is **an
OAuth 2.1 protected resource that permits anonymous access** — which is Model B
already implemented, arrived at incrementally and never named.

Two things were genuinely missing, and both follow from never having made the
decision explicitly:

1. **Nobody could measure it.** No event carried whether a call was
   authenticated, so "what share of MCP traffic is authenticated" — the
   question any decision to extend the tier system starts from — was
   unanswerable.
2. **We were telling registries the opposite.** The MCP server card advertised
   `"authentication": "none"`. Registry consumers were being told a
   security-relevant property of the endpoint that was false, and the OAuth
   metadata that makes Claude/ChatGPT-class clients authenticate natively was
   invisible to anything reading the card.

## Decision

**Model B: public by default, authentication optional and additive.**

1. **Anonymous access stays.** Any client may call any currently-published tool
   with no credential, at 100 requests/60s per IP.
2. **Authentication is offered on one header.** `Authorization: Bearer` accepts
   either an `mg_…` API key (Unkey, tiered per `rpc_accounts.tier`) or an OAuth
   2.1 access token from the in-repo authorization server. The OAuth path is
   advertised through RFC 9728 metadata so spec-aware clients discover it
   without configuration.
3. **Authentication buys throughput, not reach — for now.** 500/60s keyed,
   higher on paid tiers, plus a cost-weighted daily quota. It does not unlock
   tools or surfaces today, and the server card now says so in those words.
4. **Any future privileged capability is gated on authentication**, and adding
   the first one is the trigger to revisit clause 3 — not a decision to be made
   inside that feature's PR.
5. **`auth_tier` is emitted on every `$mcp_*` event**, so clause 3 can be
   revisited against data rather than intuition.

## Why not the alternatives

**Model A (public, committed — no auth at all).** Rejected because it is no
longer achievable without _removing_ working code. The OAuth provider, the key
system and the tier ceilings are deployed and serving. Model A would mean
deleting a live resource-server posture to reach a simpler state we are not in.

**Model C (authentication required).** Rejected because anonymous
discoverability is the funnel, not an accident. 30 days of `$mcp_initialize`
data shows the top clients are registry crawlers and probes — `glimind-probe`
(1,912), `mcpregistry` (661), `glama` (188), `smithery-probe` (168). Those
listings are how agent clients find the server at all. Requiring auth would
trade the distribution channel for access control over data that is, by design,
public: the registry exists to be read.

The asymmetry decides it. Anonymous reads cost us rate-limited compute against
already-public data. Anonymous _writes_ or privileged reads would cost
something real — and there are none, which is exactly why clause 4 exists.

## Consequences

- **The rate limit is the security boundary for anonymous callers.** It is
  best-effort by construction (Cloudflare's binding will not trip on a
  sufficiently concurrent burst), so it must never be the only thing standing
  between an anonymous caller and an expensive or mutating operation. Clause 4
  is what keeps that true.
- **`credential`-in-tool-arguments survives for now**, for `auth_required`
  subnet surfaces. It is the wrong long-term shape — OAuth-aware clients are
  moving away from passing secrets through tool arguments — but migrating it
  changes published tool schemas for real callers and needs a session-bound
  credential store. Tracked as #9009.
- **Tier changes are now observable.** `$mcp_auth_tier` distinguishes
  `anonymous` from `free` / `community` / `paid`, so the paid-tier question ADR
  0022 deferred can be answered with measured MCP demand instead of a guess.
- **The server card is a contract with registries.** It said `none` for long
  enough that this ADR exists partly to record that a discovery document
  drifting from reality is a defect, not cosmetics — the same class as ADR
  0026's write path claiming a coalescing that did not happen.

## Implementation status

Landed with this ADR:

- `$mcp_auth_tier` on every `$mcp_*` event, resolved by the rate-limit gate
  that already verified the token (no second verification).
- Server card `authentication: "optional"` plus a structured
  `authentication_detail` describing anonymous, OAuth and API-key access, and
  stating plainly that auth does not currently unlock tools.

Already live before it (see the table above): bearer verification, tiered
ceilings, blocklist, daily quota, and the full RFC 9728 / `WWW-Authenticate`
resource-server posture.

Deliberately not in scope, tracked separately:

- Migrating `auth_required` surface credentials out of tool arguments (#9009).
- Deciding _which_ tools, if any, should require authentication — clause 4's
  trigger has not fired yet, and inventing a privileged tool to justify the
  mechanism would be backwards.
