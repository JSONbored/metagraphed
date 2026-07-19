# ADR 0020 — Self-serve API key issuance + storage model

- **Status:** Proposed
- **Date:** 2026-07-19
- **Relates to:** #6733 (epic), #6734 (this design), #6735 (key-validation
  middleware, follow-on), #6736 (usage/quota route, follow-on)

## Context

The API is fully keyless today — no `Authorization`/API-key concept anywhere
in `workers/`. taostats' management API lets developers self-check
quota/usage (`management-api.taostats.io/api/v1/key/validate`,
`docs.taostats.io/reference/get-api-usage`); metagraphed has nothing
equivalent.

This is **not** about gating the open default. Keyless-by-default is the
right call for the agent-reached-integration-devs audience this repo targets
(ADR 0003) and stays the default — anonymous callers keep exactly the
access they have today. This ADR designs an **optional** identity tier a
caller can opt into for a higher rate-limit bucket and self-checkable usage,
foundational for other epics that want per-caller identity (curated
entity-label registry, saved/parameterized queries).

Three design questions from #6734, answered below:

1. **Storage** — which tier, following the provenance rationale in
   [ADR 0006](0006-provenance-tiered-storage.md)?
2. **Key format + issuance flow** — generation, self-serve vs manual, what's
   returned and when?
3. **Rate-limiter interaction** — how does a keyed caller relate to the
   existing per-IP `ratelimits` bindings in `wrangler.jsonc`?

## Decision

### 1. Storage: Postgres row (issuance/lookup) + KV cache (hot-path validation)

ADR 0006's rule is "a datum's store is decided by its provenance, not its
shape or its consumers." An API key is caller-issued, mutates over its
lifetime (revocation, usage counters), and needs to be queryable (a
maintainer listing all issued keys, a caller checking their own usage) — the
same shape as `chain_alert_triggers` (#4984), which already lives in
Postgres via the `metagraphed-data-api` Worker's Hyperdrive connection. D1 is
not a candidate: it is fully retired end-to-end (2026-07-17), not merely
deprioritized.

- **System of record: a new `api_keys` Postgres table**, reached through
  `workers/data-api.mjs` the same way `chain_alert_triggers` CRUD is (own
  route, own `*_SYNC_SECRET`-style internal auth for any maintainer-only
  action). Columns (indicative, finalized in #6735's implementation):
  `id`, `prefix` (public, see §2), `secret_hash`, `owner_contact` (see §3),
  `tier`, `created_at`, `revoked_at`, `last_used_at`.
- **Hot-path validation reads a KV cache in front of Postgres**, not
  Postgres directly. Every authenticated request would otherwise cost a
  Hyperdrive round-trip before the actual route logic runs — unacceptable
  added latency on every single call, and a needless load multiplier on the
  connection pool ADR 0014 already treats as the scarce resource. Mirrors
  two already-shipped precedents exactly: `src/network-parameters.mjs`'s
  `METAGRAPH_CONTROL`-KV-front-of-RPC pattern (300s TTL, negative-cached
  shorter), and `workers/alerter-hub.mjs`'s `ALERTER_HUB_TRIGGER_CACHE_TTL_MS`
  (5 min) front-of-Postgres trigger cache. A key lookup misses KV on first
  use, fetches+validates against Postgres, caches the (key → tier, revoked)
  tuple for a TTL (proposed 5 min, matching AlerterHub's), then serves purely
  from KV until expiry or explicit invalidation on revoke.
- **Usage/quota counters are out of scope for this ADR** — #6736 owns that
  design (the issue's own text: "reuse the Cloudflare Workers Rate Limiting
  binding's own counters if it exposes them, else a lightweight KV/D1
  counter"). This ADR only commits to the identity/validation half; whatever
  #6736 picks composes with either storage choice.

### 2. Key format: `mg_<32-hex prefix>_<64-hex secret>`, hashed at rest

- **Generation:** reuse `generateSecret()` (`src/webhooks.mjs`) — 32 random
  bytes, hex-encoded — for the secret portion. Add a short, non-secret
  **prefix** (8 random bytes, hex-encoded) so a key can be identified/looked
  up (support requests, a caller's own key list, revocation) without ever
  needing the full secret in a log or support ticket. Final shape:
  `mg_<16-hex prefix>_<64-hex secret>` — the `mg_` tag makes a leaked key
  instantly recognizable as a metagraphed credential (matches the
  vendor-prefix convention GitHub/Stripe/OpenAI tokens use, which secret
  scanners already pattern-match on).
- **Storage: hash the secret portion (SHA-256) before it reaches Postgres;
  store the prefix in cleartext.** This is a deliberate **departure** from
  this codebase's existing `owner_token`/webhook-subscription-secret
  precedent (`src/alert-triggers.mjs`'s `isValidAlertOwnerToken`,
  `src/webhooks.mjs`'s subscription secrets), which store the generated
  secret in plaintext and compare it directly via `timingSafeEqual`. That
  precedent is proportionate for those credentials — narrow-scope,
  single-record blast radius (a leaked webhook secret lets someone delete
  _that one_ subscription). An API key is broader-scope (grants elevated
  rate-limit tier + usage visibility across every route for as long as it's
  valid) and long-lived by design, so a full-table compromise (a Postgres
  backup, a misconfigured read replica, a SQL-injection-adjacent bug
  elsewhere in the schema) should not hand out every live customer
  credential in plaintext. Validation still stays timing-safe: hash the
  caller-provided secret and compare the hash via `timingSafeEqual` (or a
  plain equality check on the hash — a SHA-256 digest has no meaningful
  timing side-channel to protect once both sides are fixed-length hex).
- **Returned to the caller exactly once, at creation** — mirrors
  `owner_token`'s own convention (`src/alert-triggers.mjs`'s comment: "the
  sole ownership credential ... never echoed back on read"). A caller who
  loses their secret must revoke + reissue; there is no recovery flow,
  matching the no-user-account-system constraint this whole tier operates
  under.

### 3. Issuance: self-serve, `POST /api/v1/keys`, contact-gated + rate-limited

Self-serve, not manual — matches the issue's own framing and this
codebase's no-account-system posture (a manual/reviewed flow would need
somewhere to review requests, which doesn't exist and shouldn't be built
just for this). Two anti-abuse measures, both required together (either
alone is insufficient: a bare per-IP limiter is defeated by rotating
egress IPs; a bare contact field is defeated by disposable-email churn if
nothing rate-limits repeat issuance from the same source):

- **`owner_contact` (email) is required at issuance** — not for a login/auth
  flow (none exists), purely so an abuse report or a "we're about to
  deprecate this tier" notice has somewhere to go, matching taostats' own
  signup requiring an email. No verification (magic link, etc.) in v1 — an
  unverified contact is still strictly better than none for abuse response,
  and building verification is real added scope with no other consumer of
  it yet.
- **A dedicated, tight per-IP rate limiter on the mint route itself** — same
  posture as `ALERT_TRIGGER_CREATE_RATE_LIMITER` (10/60s, wrangler.data.jsonc),
  proposed tighter here (e.g. 3/day) since minting is a far rarer, higher-
  value action than creating an alert trigger. Prevents "mint a fresh key
  whenever the current one's quota is exhausted" from trivially defeating
  the whole point of a quota tier.

`GET /api/v1/keys` (list the caller's own keys, by presenting a valid key —
chicken-and-egg only for the very first key, which is fine, matching
Stripe/GitHub's own "create your first token via the dashboard, manage
further ones via the API" pattern — metagraphed has no dashboard yet, so v1
narrows to create + revoke only, no self-serve listing) and `DELETE
/api/v1/keys/{prefix}` (revoke, authenticated the same way
`deleteWebhookSubscription` authenticates a delete: present the secret,
`timingSafeEqual` against the stored hash) are both #6735 implementation
detail, not re-litigated here.

### 4. Rate-limiter interaction: an additive higher-tier bucket, never a replacement

A keyed caller gets a **separate** Cloudflare Workers Rate Limiting binding
(e.g. `DATA_RATE_LIMITER_KEYED`), not a swap-in replacement for the existing
anonymous `DATA_RATE_LIMITER` (60 req/60s, `wrangler.jsonc`). #6735's
middleware is explicitly optional-auth: an absent or invalid key falls
through to today's unchanged anonymous limiter; a valid key routes to the
keyed bucket instead. Proposed starting multiplier: 5× the anonymous limit
per route family (e.g. 300/60s where anonymous is 60/60s) — high enough to
be a real incentive to key a request, conservative enough to revisit once
real usage data exists rather than guessing a permanent number now. Exact
per-route multipliers are #6735's call, informed by each route's existing
anonymous limit (`RPC_RATE_LIMITER` 100/60s, `AI_RATE_LIMITER` 20/60s,
`STATE_QUERY_RATE_LIMITER` 20/60s, `DATA_RATE_LIMITER` 60/60s) — a single
global multiplier is the right _default_, not a hard requirement to apply
uniformly if a specific route's cost profile argues otherwise (`/ask`'s LLM
cost, in particular, may warrant a smaller multiplier than the rest).

## Consequences

- No code or infrastructure change ships with this ADR — it is the design
  record #6734 asked for. #6735 (validation middleware) and #6736
  (usage/quota route) are the implementation, sequenced after this.
- A new Postgres table (`api_keys`) and a new KV cache namespace enter the
  data-architecture inventory (ADR 0006/0014's tiering), reached exclusively
  through `metagraphed-data-api`, matching every other Postgres-backed
  write path in this codebase.
- This is the **first credential in this codebase stored hashed rather than
  plaintext** — a deliberate, documented departure from the
  `owner_token`/webhook-secret precedent, not an oversight; #6735's
  implementation must not silently fall back to the plaintext-compare
  convenience of the existing helpers.
- The anonymous/keyless tier is untouched. Nothing about this ADR narrows,
  slows, or gates what an unauthenticated caller can do today.

## Open questions

- **Tier granularity.** This ADR assumes one flat "keyed" tier (single
  multiplier over anonymous). If real demand shows up for multiple paid/free
  tiers, that's #6646's design-spike territory (tiered/paid public API
  access), not a reason to over-build tiering into this foundational layer
  now.
- **Revocation propagation latency.** The KV cache means a revoked key stays
  valid for up to the cache TTL on any Worker instance that already cached
  it as valid. Acceptable for v1 (5 min matches AlerterHub's own tolerance
  for stale trigger state); revisit if abuse response ever needs faster
  cutoff than that.
- **Key rotation.** Not designed here — v1 is mint/revoke only, no in-place
  rotation. A caller wanting rotation issues a new key and revokes the old
  one; flag back as a follow-up if that two-step flow proves to be a real
  friction point.

## Links/resources

- [ADR 0006](0006-provenance-tiered-storage.md) (the provenance-tiering
  rule this decision applies)
- [ADR 0014](0014-chain-data-infrastructure-and-postgres-cutover.md) (why
  Postgres via Hyperdrive, not D1, is the only live dynamic-data tier)
- `src/webhooks.mjs` (`generateSecret`, `timingSafeEqual`, the existing
  per-subscription-secret precedent this ADR partially follows and partially
  departs from)
- `src/alert-triggers.mjs` (`generateAlertTriggerOwnerToken`,
  `isValidAlertOwnerToken` — the closest existing "mint a per-caller
  credential, validate on later requests" precedent)
- `workers/alerter-hub.mjs` (`ALERTER_HUB_TRIGGER_CACHE_TTL_MS` — the
  KV-front-of-Postgres caching precedent this ADR's validation path mirrors)
- `wrangler.jsonc` `ratelimits` (the existing per-IP anonymous buckets a
  keyed tier sits alongside, never replaces)
- `wrangler.data.jsonc` `ALERT_TRIGGER_CREATE_RATE_LIMITER` (the closest
  existing "rate-limit a mint endpoint" precedent)
