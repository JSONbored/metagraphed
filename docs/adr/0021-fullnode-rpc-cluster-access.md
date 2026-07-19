# ADR 0021 — Account-gated fullnode RPC cluster access

- **Status:** Accepted · implemented (2026-07-19, #6835): wallet-signature
  login (`src/wallet-auth.mjs`), the `rpc_accounts` table + `api_keys.
account_id`, session-authed + invite-gated key mint/list/revoke
  (`workers/data-api.mjs`), and the isolated `/rpc/v1/fullnode` proxy
  (`workers/request-handlers/fullnode-rpc-proxy.mjs`, reusing
  `rpc-proxy.mjs`'s scoring/failover machinery against a separate origin
  allowlist) all shipped in one PR. Network exposure (the actual Cloudflare
  Tunnel hostname) remains an infra prerequisite, tracked separately.
- **Date:** 2026-07-19
- **Relates to:** #6835 (this design), ADR 0020 (self-serve API key issuance
  - storage, #6733), #2111 (archive node), #6646 (tiered/paid public API
    access model, design-spike)

## Context

Two RPC surfaces already exist and are explicitly **out of scope for this
ADR**, kept separate on purpose:

- `GET/POST /rpc/v1/*` — the existing public proxy (`workers/request-handlers/
rpc-proxy.mjs`), a free, keyless, load-balanced-with-failover pool over
  **third-party** community RPC endpoints (`TRUSTED_RPC_UPSTREAM_ORIGINS`:
  `archive.chain.opentensor.ai`, OnFinality, Nodies, the two opentensor.ai
  entrypoints — confirmed live, none of them ours). This stays exactly as-is.
- The dedicated bare-metal **archive node** (#2111, syncing) — owner decision
  (2026-07-19): archive access will be **paid-only, in the future, not now**.
  Not designed here.

This ADR is about a **third** surface: a **fullnode** RPC cluster (pruned,
recent-state — distinct from the archive node's full historical state),
currently one instance, planned to grow into a real cluster. The owner wants
to offer **account-gated, tiered** access to it — free tier at launch, paid
tiers later — modeled on how taostats offers hosted RPC connectivity.

### Reference model (taostats, researched live 2026-07-19)

- **Sign-up**: `taostats.io/pro/` offers **both** a wallet-based flow (their
  own "Bittensor Auth Gateway" — OAuth2/OIDC-shaped, but the identity is
  chain-backed: the app redirects to taostats Auth, the wallet **signs an
  authentication challenge**, taostats verifies that signature/on-chain
  state, and issues a JWT) **and** simpler email/anonymous sign-in. A free
  API key is available with no payment info; RBAC/billing/paid tiers are
  themselves still listed as "coming soon" on taostats' own docs.
- **RPC delivery**: two WSS endpoints gated by node type — light
  (`wss://api.taostats.io/api/v1/rpc/ws/finney_lite?authorization=API_KEY`)
  and archive (`.../finney_archive?authorization=API_KEY`). The key travels
  as a **query parameter**, not a header — trivially compatible with any
  WebSocket client that can't set custom headers (browsers' native
  `WebSocket`, most Substrate client libraries).

Two design questions this ADR answers:

1. **Auth model** — wallet-signature login, simple email login, or both;
   what's realistic to build first.
2. **Key/tier issuance + the RPC-gating mechanism** — how a validated account
   turns into a usable, rate-differentiated RPC credential, and how the new
   proxy route enforces it.

## Decision

### 1. Reuse ADR 0020's key primitives; this ADR only adds the identity layer

The key **format**, **hashing at rest**, and **validation** ADR 0020 already
designed (`mg_<prefix>_<secret>`, SHA-256 of the secret only,
`timingSafeEqual` compare) apply unchanged here — `src/api-keys.mjs`
(`generateApiKey`, `hashApiKeySecret`, `isValidApiKeySecret`, `parseApiKey`)
is auth-method-agnostic and is reused directly, not reimplemented. What's new
here is **what has to happen before a key can be minted**: instead of ADR
0020's "email contact + rate limit" anti-abuse gate on an otherwise-anonymous
mint, this tier requires a **verified account** first.

### 2. Auth: wallet-signature login ONLY — no email/OAuth path (owner decision)

Given the target audience (agent-reached integration devs already holding a
Bittensor wallet — ADR 0003) and that a wallet challenge-sign avoids adding
a third-party OAuth provider dependency entirely, **wallet login is the only
auth path, decided, not just "ships first"**:

- **Challenge issuance**: `POST /api/v1/auth/wallet/challenge { ss58 }` →
  a short-lived, single-use nonce (e.g. `mg-login:<ss58>:<random>`, stored in
  KV with a short TTL — mirrors the negative-cache-style short-TTL pattern
  already used elsewhere, e.g. `SUDO_KEY_NEGATIVE_KV_TTL`).
- **Verification**: `POST /api/v1/auth/wallet/verify { ss58, signature }` —
  the caller signs the issued challenge with their coldkey/hotkey (client-
  side, via `@polkadot/extension-dapp` or the wallet's own signer — the
  signing key material is never transmitted to or handled by this codebase
  at all), the Worker verifies the signature against the claimed `ss58`,
  consumes the nonce (single-use), and on success issues a session tied to
  that account.
- **sr25519 verification — RESOLVED (2026-07-19), no longer blocking**:
  Bittensor wallets are predominantly **sr25519** (Schnorrkel), which
  `@noble/curves` doesn't implement directly — but `@polkadot/util-crypto`
  (already a dependency, `apps/ui/package.json`, v14.0.3) does **not** use
  the old WASM path for this anymore: its `sr25519Verify` is a thin wrapper
  around `@scure/sr25519` (`node_modules/@polkadot/util-crypto/sr25519/
verify.js`) — a **pure-JS, audited implementation** ("Audited & minimal
  implementation of sr25519 (polkadot) cryptography") whose own dependency
  tree is just `@noble/curves` + `@noble/hashes`, the identical audited,
  no-WASM family this codebase already trusts and uses elsewhere. Verified
  empirically, not assumed: a real `wrangler dev` Worker importing
  `@scure/sr25519` directly (not the full `@polkadot/util-crypto` bundle,
  to avoid pulling in its unrelated `@polkadot/wasm-crypto` transitive
  dependency for functions this doesn't need) generated an sr25519 keypair,
  signed a message, and verified both the valid signature (accepted) and a
  tampered one (correctly rejected) — no WASM instantiation, no
  workerd-compatibility surprise of the kind `src/account-balance.mjs`'s
  header warns about for `node:crypto`'s `blake2b512`. Implementation should
  add `@scure/sr25519` as an explicit direct dependency (currently only a
  transitive one via `apps/ui`'s `@polkadot/util-crypto`) rather than rely on
  workspace-hoisting luck.
- **Email/anonymous sign-in** (taostats' simpler fallback path) is **not
  built** (owner decision, 2026-07-19) — wallet-signature login is the sole
  identity path for this surface, not a v1-only starting point.

### 3. Session + account storage: Postgres row (same tier as ADR 0020's `api_keys`)

A new `rpc_accounts` table (`ss58 UNIQUE`, `tier`, `created_at`), reached the
same way `api_keys`/`chain_alert_triggers` are — through
`workers/data-api.mjs`'s Hyperdrive connection, never D1 (fully retired).
One account can hold multiple API keys (`api_keys.account_id` becomes a
nullable foreign key — nullable because ADR 0020's own anonymous, contact-
only keys keep working unchanged for the public API tier this ADR doesn't
touch). A session (post wallet-verify) is a short-lived signed cookie or
bearer token scoped only to the key-management UI/routes (creating/listing/
revoking THIS account's own keys) — the actual RPC credential is still the
`mg_...` API key, not the session, matching taostats' own "session gets you
to the dashboard, the API key is the actual bearer credential" split.

### 4. Private-launch access gate: a shared invite code (owner decision)

Wallet-verified login alone would let anyone with a wallet complete sign-up
— too open for the private-team phase. Gate the mint step (not login
itself) behind a single shared invite code, checked the same way
`ALERT_TRIGGER_CREATE_TOKEN` already gates `chain_alert_triggers` creation
(`workers/data-api.mjs`'s `handleAlertTriggerCreate`, `timingSafeEqual`
against an `env`-provisioned secret) — a `wrangler secret put` value the
owner hands to teammates out-of-band (Slack/email), never committed. Two
properties this needs to preserve: (1) rotating/killing access for everyone
at once is a single secret rotation, not a per-person revocation sweep; (2)
this is the exact mechanism to later relax for a public launch — delete the
gate check, keep everything else unchanged. Distinct from ADR 0020's own
anti-abuse gate (contact + rate limit on an otherwise-open mint) — this one
is binary access control, not abuse throttling, and applies in addition to
wallet verification, not instead of it.

### 4a. Evolution: named invite-code cohorts, not one shared secret (2026-07-19)

The single shared invite code above generalized, in practice, to a short
list of independently-provisioned codes (`workers/data-api.mjs`'s
`FULLNODE_INVITE_CODE_TIERS`), each mapping to a distinct `tier` stamped on
any key minted with it — e.g. a separate code for an owner-designated
partner cohort onboarding its own users, distinct from the original
private-team code. This preserves both properties section 4 required (a
single rotation kills exactly one cohort's access, never the other's; each
is still the "delete the check, keep everything else" relax-later
mechanism) while adding per-cohort attribution and a per-cohort rate-limit
policy (`workers/request-handlers/fullnode-rpc-proxy.mjs`'s
`FULLNODE_RPC_TIER_RATE_LIMITS`) instead of one flat figure for every
minted key. Deliberately a short, explicit list — not a general
multi-tenant invite-code registry — until a third cohort actually
materializes.

### 5. Tiering: one free tier at launch, matching taostats' own current reality

Even taostats' own RBAC/billing is "coming soon" per their docs — there is no
working reference implementation to copy for paid tiers yet, so this ADR
doesn't invent one. v1 ships a single `tier: "free"` on every `rpc_accounts`
row (the column exists so a later paid tier is additive, not a schema
migration). A rate limit distinct from (and looser than, this being the
actual product) the existing anonymous `/rpc/v1` pool's limits applies per
key, enforced the same Cloudflare Workers Rate Limiting binding pattern ADR
0020 already establishes.

### 6. New route, new infra, explicitly isolated from the public pool

- **`/rpc/v1/fullnode/*`** (exact path TBD in implementation, naming should
  make "this is the gated one" obvious) proxies **only** to the fullnode
  cluster — no failover into `TRUSTED_RPC_UPSTREAM_ORIGINS`'s public pool,
  and vice versa. Mixing a best-effort public failover path with a paid/
  gated guaranteed path in the same failover logic is a real isolation risk:
  a public-pool degradation must never affect a paying caller's request, and
  a gated-tier incident must never silently fail open to public traffic.
- **Real pool/failover architecture from day one (owner decision)**: rather
  than a single-origin proxy refactored into a pool once a second fullnode
  exists, the gated route reuses the SAME scoring/failover machinery
  `workers/request-handlers/rpc-proxy.mjs` already runs in production for
  the public pool (origin health scoring, best→worst failover walk — see
  that file's own header) against a **separate, dedicated origin list**
  (starting with exactly one entry). This is genuinely lower-risk than it
  sounds: it's proven code, not new/untested logic, just pointed at a
  different, isolated origin set — growing the fullnode cluster later is
  purely a config change (append to the list), not a code change.
- **Network exposure**: the fullnode(s) need a Cloudflare Tunnel hostname the
  Worker can reach, the same mechanism already used for the archive box's
  Postgres connection via Hyperdrive (`wrangler.data.jsonc`'s own comment:
  "self-hosted indexer box Postgres, reached via Cloudflare Tunnel"). This is
  an infra-side action (metagraphed-infra/Ansible), not application code —
  tracked as a prerequisite, not designed here.
- **Key delivery matches taostats' own convention** (`?authorization=`
  query param, not a header) specifically so existing WSS client code
  written against taostats-shaped URLs needs minimal changes to point at
  this instead — a deliberate compatibility choice, not an accidental
  departure from ADR 0020's header-based convention for the public API.

### 7. Method scope: read-only PLUS `author_submitExtrinsic` (owner decision)

Decided during implementation (2026-07-19): the gated route allows real tx
broadcast, not just the public proxy's read-only `SAFE_RPC_METHODS` set —
this tier is genuine RPC access, and read-only-only would give a paying
caller nothing the free public proxy doesn't already offer.
`author_submitAndWatchExtrinsic` stays excluded (subscription-based, doesn't
fit this proxy's single-POST/single-response model — no WSS support here,
matching the public proxy's own HTTP-only `/rpc/v1/{network}` route); every
other `author_`/`sudo_`/`payment_`/`contracts_`/`state_call` method stays
blocked by the same `DENIED_RPC_PREFIXES` defense-in-depth the public proxy
uses. `state_getStorage`/`state_getKeysPaged` (the public proxy's separately-
gated state-query set) are deliberately NOT included in v1 — they need their
own param-shape validation/rate-limit budget ported over, a scope cut noted
here rather than silently expanded.

## Consequences

- This is the **first user-account system** in this codebase (ADR 0020
  explicitly noted there was none). `rpc_accounts` + wallet-signature
  verification is new surface area, not an extension of an existing pattern.
- The sr25519-in-workerd question is resolved (see section 2) — no longer a
  blocker on implementation starting.
- The archive node and the existing public `/rpc/v1` proxy are unaffected —
  zero risk of this work regressing either.
- `src/api-keys.mjs` (format/hash/validate) is now used by two independent
  systems (ADR 0020's anonymous public-API keys and this ADR's account-
  linked fullnode keys) — any change to that module needs both call sites
  considered.
- The gated route's failover machinery is shared code with the public
  `/rpc/v1` proxy (section 6) — a bug fix there benefits both; a bug
  introduced there risks both, so changes to
  `workers/request-handlers/rpc-proxy.mjs`'s scoring/failover logic need
  testing against both origin sets, not just the public one.

## Open questions

- **Paid tiers**: explicitly deferred to #6646 (needs the owner's pricing/
  billing-provider call) — this ADR only reserves the `tier` column.
- **Network exposure**: the gated cluster's actual Cloudflare Tunnel
  hostname(s) aren't provisioned yet — `FULLNODE_RPC_ORIGINS` is wired as a
  deployment secret (never a committed value) precisely so this can land
  without waiting on that infra step; until it's set, the route 503s with no
  configured endpoint.

## Resolved during implementation

- **Session mechanism**: a stateless HMAC-signed bearer token
  (`src/wallet-auth.mjs`'s `createSessionToken`/`verifySessionToken`, scoped
  only to the key-management routes, 1h TTL) — no sessions table, no
  framework; picked over a signed cookie as the simpler correct option this
  codebase's existing HMAC primitive (`src/webhooks.mjs`'s `signPayload`)
  already supports.

## Links/resources

- [ADR 0020](0020-api-key-issuance-and-storage.md) (the key format/hashing/
  storage this ADR reuses unchanged)
- `src/api-keys.mjs` (generateApiKey/hashApiKeySecret/isValidApiKeySecret/
  parseApiKey — already implemented, auth-method-agnostic)
- `workers/request-handlers/rpc-proxy.mjs` /
  `workers/config.mjs`'s `TRUSTED_RPC_UPSTREAM_ORIGINS` (the existing public
  proxy this ADR does NOT touch)
- `src/account-balance.mjs` (the precedent for rejecting a crypto primitive
  after finding it doesn't actually work in workerd — `node:crypto`'s
  `blake2b512` — the same discipline the sr25519 open question needs)
- taostats docs, researched live 2026-07-19: `docs.taostats.io/docs/
getting-started-with-taostats-api`, `docs.taostats.io/reference/
hosted-rpc-connectivity`, `taostats.io/bittensor-auth`
