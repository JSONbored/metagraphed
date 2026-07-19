# ADR 0018 — Native staking architecture: non-custodial signing, direct-to-RPC broadcast, mandatory slippage protection

- **Status:** Accepted
- **Date:** 2026-07-14
- **Relates to:** #5229 (native staking & delegation epic, the tracker this ADR
  unblocks), #5230 (scope-fence amendment on #2589 that authorized this epic),
  #5232 (safe-staking default policy, folded into this ADR's Decision §3),
  ADR 0013 §item 5 (the planned-but-unshipped first-party RPC origin this
  ADR's future-upgrade path depends on).

## Context

#5229 adds a non-custodial, wallet-connected staking/delegation rail to
metagraphed: a user connects a browser wallet, picks a validator, and
stakes/unstakes/moves stake, signed client-side. Before any Phase 2/3 issue
can start, three things need a documented decision, because every later issue
in the epic inherits them:

1. **Which wallet standard** the client-side integration targets.
2. **How a signed extrinsic reaches the chain** — this repo has zero
   write/broadcast infrastructure today, and its existing RPC-facing surfaces
   are _deliberately_ read-only-enforced at three independent layers: the
   HTTP proxy's method allowlist (`SAFE_RPC_METHODS`,
   `workers/config.mjs:327-339`), `wss-lb`'s own copy of that allowlist
   (`deploy/wss-lb/src/rpc-policy.mjs:1-49`), and a hard-coded
   `DENIED_RPC_PREFIXES` blocking `author_` as defense-in-depth
   (`workers/config.mjs:360-366`). `author_submitExtrinsic` appears nowhere
   in this repo except test fixtures asserting it's rejected
   (`tests/request-handlers-rpc-proxy.test.mjs:478-495`). Building a broadcast
   path means adding new infrastructure, not extending the read path — and
   deciding _how much_ new infrastructure is exactly the fork this ADR
   resolves.
3. **What slippage protection is the default**, since the underlying pallet
   doesn't provide one. `add_stake`/`remove_stake` execute as unbounded
   market orders with zero on-chain slippage protection; real protection only
   exists via the `_limit` variants (`add_stake_limit`, `remove_stake_limit`,
   `swap_stake_limit`) with a caller-supplied `limit_price`, and the
   Bittensor SDK's own default is "unsafe mode" — no protection — unless the
   caller opts in.

The bare-metal box already runs a full-archive `subtensor` node with RPC
enabled (`docker-compose.yml:66-87`, `--rpc-external --rpc-cors=all`), but it
is not publicly bound (`expose: "9944"` only, no host port mapping) and does
not appear in `TRUSTED_RPC_UPSTREAM_ORIGINS`. ADR 0013 item 5 planned to
publish it as a first-party RPC origin; that never shipped. It remains a
future option, not a v1 dependency.

## Decision

### 1. Wallet standard: `@polkadot/extension-dapp`-compatible injection

Target the standard browser-extension injection protocol
(`web3Enable` → `web3Accounts` → `web3FromSource` → `signAndSend`) that the
Polkadot.js extension, Talisman, and SubWallet all implement identically —
research confirmed one integration covers all three with zero bespoke
per-wallet code; they differentiate only by `account.meta.source`. Both
Talisman and SubWallet additionally ship first-class native Bittensor staking
UI of their own, on top of (not instead of) this same signer surface, which
is further evidence the standard is well-trodden for this exact use case.

WalletConnect (Reown)/Nova Wallet mobile signing is a real, documented,
currently-used pattern in the wider ecosystem but is **explicitly deferred**
to a future phase — v1 ships desktop-extension signing only. A read-only
"watch mode" (paste an address, no wallet) stays a separate surface from the
signer-connect flow, consistent with how every comparable Substrate dashboard
splits the two.

Build directly on `@polkadot/api` against subtensor's own runtime metadata
rather than `opentensor/bittensor-js` (no releases, minimal activity) — every
serious Bittensor web dApp surveyed, including Taostats itself, treats
subtensor as "just another Substrate chain" client-side.

### 2. Broadcast path: browser signs and submits directly to a vetted third-party RPC endpoint

For v1, the signed extrinsic goes straight from the browser to a trusted,
already-public RPC endpoint from the existing `TRUSTED_RPC_UPSTREAM_ORIGINS`
allowlist (`workers/config.mjs:419-436`) — the same shape Polkadot.js Apps
itself uses, and the lowest-engineering, lowest-security-surface option
available today. **Signed extrinsics never transit metagraphed's own
backend** in v1: no new relay endpoint, no new rate-limiter binding, no new
abuse surface to build and hold correct on day one.

This is a deliberate rejection of the alternative (a metagraphed-owned
write-broadcast Worker mirroring the `alert-triggers`
shared-secret-plus-rate-limiter shape). That alternative remains architecturally
sound and is the natural **future upgrade path** once the box's own subtensor
node is published as a first-party RPC origin per ADR 0013 item 5 — at that
point, routing broadcast through infrastructure metagraphed controls end to
end becomes strictly better (no third-party dependency, consistent uptime
with the read path) and should be revisited. It is out of scope for v1
specifically because it multiplies the amount of new, security-critical
infrastructure the epic must get right before shipping anything, with no
functional benefit to the user over the direct path.

Consequence: #5238 ("implement the broadcast path") builds the direct-to-RPC
path only; #5250 ("broadcast-path rate limiting") is deferred and only
becomes relevant if a future ADR revisits this decision. Signed extrinsics
are never routed through `workers/request-handlers/rpc-proxy.mjs` — that
code path is architecturally and repeatedly guarded against exactly this, by
design, and stays that way.

### 3. Safe-staking default: `_limit`-only, 5% default tolerance, no unsafe opt-in in v1

The client-side extrinsic construction library (#5237) **only ever
constructs the `_limit` variants** — `add_stake_limit`, `remove_stake_limit`,
`swap_stake_limit` — computing `limit_price` from the current spot price
(read from the AMM pool reserves already live in `economics.json`) times a
tolerance band. Default tolerance is **5%**, adjustable per-transaction in
the pre-sign confirmation screen (#5239), never silently widened by the
client.

Root-network (netuid 0) staking is exempt from this entirely — there is no
AMM on root, stake there is TAO-denominated 1:1 with no swap fee and no price
impact, so there is nothing to protect against.

**No "unsafe mode" opt-in ships in v1.** The plain, unprotected
`add_stake`/`remove_stake` calls are never exposed in the UI. If a real user
need for bypassing protection surfaces later, it requires its own ADR
amendment and explicit, separately-worded consent copy — it is not a
toggle to add casually.

### 4. Message-signing scope evolution (2026-07-19): opaque login-challenge signing

The original v1 scope for `wallet-injected.ts` was extrinsic-signing only —
`connectWallet`/`getSigner` feed `signAndSend`, and the connect/persistence
module (`lib/metagraphed/wallet.ts`) was explicitly read-only, "never used to
sign anything." The freemium API-key epic (#6733/#6735/#6736, now built on
Unkey) needs a wallet-signature login: connect → sign an opaque challenge
string → authenticated dashboard session — no on-chain transaction anywhere
in that flow.

This adds `signMessage()` to `wallet-injected.ts`, calling the extension's
`signRaw({ type: "bytes" })` — the same signer surface already used for
extrinsics, just signing an arbitrary message instead of a call. This is a
narrow, additive capability, not a reversal of section 2's broadcast-path
decision: no extrinsic is ever constructed or submitted by this path, and
`lib/metagraphed/wallet.ts` itself still persists only an address, never a
signature. The signature format (bare hex, no `0x` prefix, sr25519) matches
`src/wallet-auth.mjs`'s existing challenge/verify machinery, built for ADR
0021's fullnode-gate login and reused here unchanged.

## Consequences

- Every Phase 2 issue (#5236–#5241) builds against this decision directly:
  wallet-connect targets the three-wallet injection standard (#5236), the
  extrinsic library only ever emits `_limit` calls (#5237), the broadcast
  path is direct-to-RPC with no new backend surface (#5238), and the
  pre-sign confirmation screen's fee/slippage display reflects the 5%
  default (#5239).
- #5250 ("broadcast-path rate limiting") is **not built in v1** — its scope is
  preserved for the future relay-path upgrade, not deleted. Re-opened only if
  a future ADR chooses the relay path.
- No new Cloudflare bindings, rate limiters, or Worker routes are needed to
  ship v1 staking — the entire new-infrastructure surface is client-side
  (a JS library + wallet integration), which meaningfully shrinks the
  pre-launch security review's (#5251) scope versus the relay alternative.
- The box's subtensor node stays exactly as it is today (private,
  archive-indexing only) — this ADR creates no new pressure to publish it.
  That remains ADR 0013 item 5's open item, decoupled from this epic.
- If usage or reliability problems with third-party RPC endpoints surface
  post-launch (rate limits, downtime, censorship of specific calls), the
  relay-path alternative documented and rejected above is the designed
  escape hatch — not a redesign from scratch.

## Links/resources

- `opentensor/subtensor` pallet source: `staking/add_stake.rs`,
  `staking/stake_utils.rs`, `staking/helpers.rs` (extrinsic signatures, the
  unprotected-by-default behavior of the plain calls)
- `bittensor.com/docs/concepts/money#slippage`,
  `bittensor.com/docs/concepts/money#minimums` (slippage + minimum-stake
  mechanics this ADR's §3 relies on)
- Polkadot.js Extension Cookbook — `polkadot.js.org/docs/extension/cookbook`
  (the injection flow §1 targets)
- `workers/config.mjs:327-436` (existing read-only RPC allowlist enforcement
  this ADR deliberately does not touch)
- `docs/adr/0013-hybrid-deployment-topology.md:118-120` (the planned,
  unshipped first-party RPC origin — this ADR's future-upgrade path)
