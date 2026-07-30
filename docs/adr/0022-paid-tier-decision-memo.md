# ADR 0022 — Paid-tier decision memo: cost model, three options, recommendation

- **Status:** Accepted — **Option (b) extended: data API free; the self-hosted surfaces (fullnode RPC, bulk export, archive snapshots) paid**
- **Date:** 2026-07-28 (proposed) · 2026-07-30 (accepted)
- **Decision:** the maintainer selected Option (b) on 2026-07-30, then amended it
  the same day once a **missing cost shape** (the self-hosted fullnode RPC node)
  was found. See "Decision" below the Recommendation.
- **Relates to:** #8388 (this memo), #6646 (design-spike this memo fulfills),
  ADR 0020 (self-serve API key issuance — the identity/metering layer this
  memo assumes exists), ADR 0006/0014 (storage/infra tiering this memo's
  cost model is built on)

## Context

ADR 0020 shipped the identity + metering layer (self-serve `mg_...` keys,
now extended to the general API in #8386's keyed-free tier — 5× the
anonymous rate ceiling, still free) but explicitly deferred the paid
question to #6646: "If real demand shows up for multiple paid/free tiers,
that's #6646's design-spike territory... not a reason to over-build tiering
into this foundational layer now." The platform now has everything charging
would need — stable per-caller identity, a usage dashboard, a tiered
rate-limit mechanism already proven in production for the keyed-free tier —
and no decision on whether, what, or how to charge.

This memo is that decision document. It does not choose a billing vendor,
write billing code, or announce anything (explicitly out of scope per the
issue). It is deliberately conservative about numbers it cannot actually
verify: **dollar figures below marked 🔶 are public list pricing or
order-of-magnitude estimates, not this project's actual invoiced spend** —
the maintainer's real Cloudflare/hosting bills are the input that turns
this from a structural analysis into a real financial one, and this memo's
structure is built so dropping those numbers in doesn't require rewriting
anything around them.

## Cost model

### The data plane has two cost shapes, not one

This matters more than any single dollar figure, because it changes what
"cost per request" even means depending on which tier serves the request
(ADR 0006's provenance-tiering, ADR 0014's Postgres cutover):

| Tier                                                                                                                                                         | What serves it                                                                                   | Cost shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Edge / cached artifacts** (most `GET` routes — subnet index, health, most list endpoints)                                                                  | Cloudflare Workers + R2/KV, edge-cached with `stale-while-revalidate`                            | **Metered, near-zero marginal.** Cloudflare's usage-based pricing (🔶 Workers Paid: $5/mo base + $0.30/million requests past the included 10M/mo, per Cloudflare's public pricing as of this writing — not our actual plan tier or spend) — a cache hit costs a fraction of a cent regardless of who's asking.                                                                                                                                                                                                                                              |
| **Postgres-tier / deep-history** (`/api/v1/chain-events*`, ownership-history, conviction, lease/history — the exact routes #8386 wired tiered limiting into) | `metagraphed-data-api` Worker → Hyperdrive → the **self-hosted indexer box's** Postgres instance | **Fixed capacity, not per-request billed.** The box (ADR 0014: "the real, permanent core, not a Railway stopgap") is a flat monthly hosting cost (🔶 order-of-magnitude a dedicated/VPS box in this class runs $20–150/mo depending on spec — maintainer to confirm the actual bill) regardless of request volume, up to its connection-pool/CPU ceiling. The real cost of a heavy caller here isn't "$X per request" — it's **connection-pool contention** crowding out other callers, which is exactly why #8386 tiered this specific route family first. |
| **AI / semantic search** (`/ask`, `/search/semantic`)                                                                                                        | Workers AI + Vectorize                                                                           | **Metered with a hard ceiling already in place.** ADR 0003: Vectorize's ~1.4M stored dimensions sit inside the 10M free allowance; `/ask`'s `AI_RATE_LIMITER` (20/60s) is deliberately the tightest limiter in the codebase because LLM inference is the one route family with a real, immediate per-call cost even at Workers AI's free-model pricing.                                                                                                                                                                                                     |
| **Archive / bulk export** (raw R2 artifacts, `/datasets/*`, full-history pulls)                                                                              | R2 direct                                                                                        | **Storage + egress, the one tier with genuine bandwidth cost.** 🔶 R2 has no egress fee to the internet (Cloudflare's actual differentiator vs. S3) but does charge for storage (~$0.015/GB-month list price) and Class A/B operations — a bulk exporter pulling the full historical dataset repeatedly is the closest thing this platform has to a caller who costs real, scaling money.                                                                                                                                                                   |

| **Gated fullnode RPC** (`POST /rpc/v1/fullnode` — safe reads **plus `author_submitExtrinsic`**) | The **first-party self-hosted subtensor node** (#4965, `fullnode-rpc.metagraph.sh` behind a Cloudflare Tunnel; `roles/subtensor-fullnode` + `roles/subtensor-archive` in metagraphed-infra) | **Fixed monthly self-hosted cost, plus the largest operational burden of any tier.** A synced Bittensor fullnode is a VPS, a continuously-growing chain database, and bandwidth — and unlike the Postgres box it is a **write path to the chain**, since this is the only tier granting transaction broadcast. 🔶 maintainer to confirm the actual bill. |

**Added 2026-07-30 (amendment).** This row was **missing from the original memo**, and its absence materially shaped the recommendation below — see the Decision section.

**The takeaway that should drive pricing design**: the routes people would
most want a paid tier _for_ (deep-history, bulk archive) are exactly the
routes with the least Cloudflare-metered, most infrastructure-capacity-bound
cost shape — a flat-rate-limit-multiplier model prices every route the same
even though their actual cost profiles are wildly different. This is the
core tension Option (b) below is built to resolve and Option (a) is not.

### Ecosystem comparator (from #6646's own survey, #5968)

TaoMarketCap — "the most detailed published API monetization model among
the 11 explorers surveyed" — runs: free/no-auth (10 req/60s, 600/hr,
100k/mo), Pro $49/mo, Business $199/mo, each with distinct rate limits. This
is the shape Option (a) below mirrors if chosen.

### What we don't know yet (maintainer inputs, placeholders)

- 🔶 Actual monthly Cloudflare bill (Workers Paid tier, R2 storage/ops,
  Workers AI usage) — the account's real invoice, not list pricing.
- 🔶 Actual monthly self-hosted box cost (the indexer/Postgres host).
- 🔶 Current total request volume by route family (edge vs. Postgres-tier
  vs. AI) — `src/usage-telemetry.ts` pushes to PostHog but (per #8386's own
  finding) has no query path back yet; a real query would need either a
  PostHog dashboard pull or the same minimal-counter approach #8386 just
  built for per-key usage, generalized to a network-wide rollup.
- 🔶 How many self-serve keys have actually been minted since #8386 shipped,
  and what fraction of keyed traffic is concentrated in a small number of
  heavy callers (the classic SaaS usage curve — if true, a small number of
  named accounts might be a better lever than a public price list at all).

## Three candidate models

### Option (a) — Usage tiers on the API (ecosystem-standard shape)

A paid tier **above** the free keyed tier #8386 already shipped: e.g.
`keyed-paid` at 25× anonymous (vs. keyed-free's 5×), sold as a flat
monthly subscription (TaoMarketCap's Pro/Business shape). Mechanically
trivial to add — the tiered-rate-limit machinery (`workers/tiered-rate-
limit.ts`) already generalizes to any number of tiers; a paid tier is
another `RateLimitTierPolicy` entry and a `tier` value on the account row,
no new architecture.

- **Revenue mechanics:** subscription, billed monthly, tier determined by
  `rpc_accounts.tier` (already the field ADR 0020/0021's fullnode gate uses
  for exactly this).
- **What it risks breaking:** the least, of the three — anonymous and
  keyed-free are structurally untouched (an additive tier, same posture
  ADR 0020 already committed to: "an additive higher-tier bucket, never a
  replacement"). Some risk of being read as "we're going premium" even
  though nothing existing changes — a positioning/comms risk, not a
  technical one.
- **Operational burden:** needs a real billing vendor (Stripe is the
  obvious default — recurring subscriptions, tax handling largely
  automated via Stripe Tax) integrated into the wallet-verified account
  model, which currently has no payment-method concept at all. Support
  burden: "why did my rate limit reset" tickets, dunning/failed-payment
  handling.
- **Cost-alignment problem:** per the cost model above, a flat rate-limit
  multiplier charges the same whether the paying caller only hits cheap
  edge-cached routes or hammers the expensive Postgres-tier ones — it
  prices _request count_, not _actual infrastructure cost_.

### Option (b) — Product-scoped pricing (archive/snapshot/bulk export as the paid product)

The API itself stays free at keyed-free's 5× ceiling for everyone,
forever — no API tier above that. Instead, the **specific capabilities
that map to real, scaling infrastructure cost** become the paid products:
full historical archive access, point-in-time snapshot exports, bulk
dataset downloads beyond what `/datasets/index.json` already gives away
free. This is a direct answer to the cost-model finding above: price the
thing that actually costs money (R2 storage/egress, sustained Postgres
load from a bulk puller) rather than a generic per-request multiplier.

- **Revenue mechanics:** either a flat monthly archive-access subscription,
  or metered-per-export (closer to actual cost causation, more billing
  complexity).
- **What it risks breaking:** lowest risk to the agent-adoption thesis
  (ADR 0003's whole reason keyless stays generous) — an agent doing normal
  integration work never touches bulk archive exports, so this tier is
  invisible to the exact audience this project has spent the most design
  effort protecting. Risk is narrower: does anyone actually want to _buy_
  bulk archive access, or is the addressable market (researchers, other
  explorers wanting a data feed) too small to matter?
- **Operational burden:** similar billing-vendor need as (a), but the
  product surface (a handful of archive/export endpoints) is much smaller
  than "the whole API," so entitlement-checking logic is simpler — closer
  to `auth_required`-style route gating this codebase already has patterns
  for than to a rate-limit-tier system.
- **Best cost-alignment of the three.**

### Option (c) — Sponsor/patron model (paid = support + limits, not gated capability)

No new capability is ever paywalled. A "supporter" tier is Patreon/GitHub-
Sponsors-shaped: paying gets a modestly higher rate-limit ceiling (framed
as "thank you," not "the product"), a supporter badge/mention, maybe
priority on feature requests — never something a non-paying agent-building
developer is blocked from.

- **Revenue mechanics:** GitHub Sponsors or Patreon directly — **zero new
  billing-vendor integration**, no PCI/tax surface this codebase has to
  touch at all (the sponsor platform owns all of that).
- **What it risks breaking:** nothing technically; the honest risk is
  revenue ceiling — sponsor models scale with goodwill and visibility, not
  with usage or need, and historically raise materially less than a real
  product tier for a developer-infrastructure project at this stage.
- **Operational burden:** lowest of the three by a wide margin — this is
  closer to a config change (a sponsors page + a modest rate-limit bump
  keyed off a GitHub Sponsors webhook or a manual allowlist, the same
  `handleAccountTierPromote` ops-driven-promotion pattern ADR 0021 already
  uses for `gittensor-partner`) than a new subsystem.

## The non-negotiables (restated, apply to all three options)

- **The keyless base never loses capability.** No option above touches
  anonymous access. This is re-confirmed, not re-litigated — ADR 0003's
  agent-adoption thesis and #8386's just-shipped docs promise ("Keyless
  stays keyless... that never changes to a paid tier") both depend on it
  holding permanently, not just at launch.
- **Probe-derived health is never pay-to-fix.** Health/uptime/latency data
  (ADR 0002) stays probe-derived and public regardless of tier — a paid
  tier can buy more _access_, never a better-looking (or hidden-worse)
  _health number_. No option above touches this; stated explicitly because
  it's the one non-negotiable a hasty pricing-page draft could accidentally
  violate (e.g. "priority support" quietly reading as "we fix your subnet's
  displayed health faster").
- **No wallet-custody features.** Whatever billing vendor is chosen (Stripe
  for (a)/(b), a sponsor platform for (c)) handles payment method custody
  entirely off this codebase — matches the existing native-staking posture
  (ADR 0018: non-custodial, direct-to-RPC) of never holding anything on a
  user's behalf.

## Recommendation

**Option (b), with (c) as a legitimate lower-lift interim step if the
maintainer wants revenue signal before committing to a billing-vendor
integration.**

Reasoning that survives being wrong: the cost model above is the actual
new information this memo contributes (#6646's own survey already covered
the ecosystem-comparator research) — it shows the three options aren't
equally well-matched to how this platform's costs actually work. A flat
API-tier multiplier (a) charges for the cheap, already-generous-for-free
resource (edge-cached requests) and only accidentally captures the
expensive one (Postgres-tier load) if a paying caller happens to use those
specific routes. Product-scoped pricing (b) charges for the resource that
is actually scarce and cost-bearing (R2 storage/egress, sustained
Postgres-tier load from bulk pulls) and leaves the resource that's
genuinely cheap to serve (everything an integrating agent touches) free
regardless of tier — which is also the framing least likely to ever put
this project in tension with the agent-adoption thesis ADR 0003 committed
to, because the paying audience (researchers/data-feed consumers wanting
bulk archive access) and the free-forever audience (integrating agents)
barely overlap.

**What would flip this recommendation:** if the maintainer-gathered real
numbers (see placeholders above) show request volume is overwhelmingly
edge/cached rather than Postgres-tier or archive-heavy — i.e., if the
actual infrastructure cost driver turns out to be raw request _count_ at
the edge rather than deep-history/bulk load — then Option (a)'s simpler,
already-half-built mechanism (extend #8386's tiering with one more tier)
becomes the better cost-aligned choice, and this recommendation should be
revisited, not defended. Similarly, if real usage-telemetry numbers (once
queryable) show self-serve key adoption is too low for a subscription
product to have a viable addressable market at all, Option (c) becomes the
right choice by default — it costs almost nothing to run and provides a
revenue signal before betting engineering time on either (a) or (b).

## Decision (2026-07-30, amended same day)

**Option (b), extended: the data API stays free — and the two SELF-HOSTED
surfaces are the paid products.**

- **Free at every tier, permanently:** the keyless base and the whole cached/
  edge data API. No capability moves behind a paywall. ADR 0003's
  agent-adoption thesis is untouched, which was the main reason to prefer (b)
  over a flat API multiplier.
- **Paid:** three surfaces, all of them things we self-host and pay for:
  1. **Gated fullnode RPC** — specifically `author_submitExtrinsic` and
     high-volume access.
  2. **Bulk export** of our own derived datasets.
  3. **Archive-node chain snapshots** — see below; the strongest of the three.

### Archive-node snapshots (added 2026-07-30)

A restorable snapshot of the **synced archive chain database**, so a buyer can
stand up their own Bittensor archive node in hours instead of syncing from
genesis. Distinct from (2): that exports _our derived data_; this is the raw
chain DB.

Why this is the best-shaped product of the three:

- **The cost to the buyer of not having it is weeks.** metagraphed-infra's own
  backup script states it plainly: a full genesis resync is "weeks, not hours".
  That is the value being sold, and it is unusually legible.
- **Nobody publishes free public archive snapshots.** There is no free
  substitute to compete with, unlike almost every other surface here.
- **Our marginal distribution cost is ~zero, and uniquely so.** This memo already
  notes R2 has **no egress fee** — the one place that fact is a decisive
  advantage rather than a footnote. Shipping a multi-TB snapshot costs us
  storage and operations; a competitor doing the same on S3 pays egress on every
  copy. The economics only work for us.
- **We already pay the storage.** The archive volume is backed up weekly to R2
  today (metagraphed-infra#94, restic, content-defined-chunking dedup).

What it is **not** yet, and what stands between here and a product:

- Those restic backups are **not a consumable snapshot**. They are encrypted
  under `RESTIC_PASSWORD` and in restic's own repository format — a disaster-
  recovery artifact for us, not something a customer can drop into their node.
  A product needs a separate plain, restorable export, which is additional R2
  storage on top of the backup that already exists.
- The archive node must be **at tip and verified** before any snapshot is worth
  selling. Sync state is tracked separately.
- Snapshot cadence, retention, and integrity/provenance (a published checksum at
  minimum) are unresolved.

This is a **long-run** product, recorded here so the option is not lost, not a
commitment to build it now.

### Why this was amended within hours of being recorded

The memo's cost model enumerated four cost shapes and **omitted the fullnode
RPC node entirely**. That omission is not cosmetic: it is the one surface that
is simultaneously

1. a **fixed monthly bill we already pay** for hardware we run ourselves,
2. the capability hosted-RPC providers actually **charge for** (transaction
   broadcast), and
3. served **free** today at 300 req/min on the `free` tier, wallet-gated only.

So "the API stays free" — read off a table the fullnode was not in — silently
meant "we give away access to nodes we pay for monthly, including the write
path to the chain." Meanwhile the product (b) originally named as THE paid
surface, bulk archive, is the one this very memo notes has **no R2 egress fee**;
its real cost is storage at ~$0.015/GB-month plus operations. The original
decision therefore monetised the cheaper self-hosted burden and gave away the
dearer one, purely because the dearer one was never in the option set.

The principle of (b) survives that correction. The scope of "free" does not.

### What this settles

- **There is still no paid tier on the DATA API.** The `free` / `community` /
  `paid` entries in `src/api-tiers.ts` remain _rate-limit_ tiers, granted, never
  sold. **`paid` is a misnomer under this decision and should be renamed** (the
  fullnode gate's own `free` / `gittensor-partner` / `unlimited` naming is the
  better precedent).
- **Nothing already free on the data API becomes paid.**
- **Fullnode RPC gets a paid dimension.** Free-tier _read_ access should stay
  generous; broadcast and high volume are the paid surface. Exact split is an
  implementation decision, not settled here.

### Still open, deliberately

- **Price points.** #8597 (merged 2026-07-30) now measures all-traffic volume by
  route family and cost shape, including the `keyless_share` this memo could not
  observe. Set numbers from that, not from guesses.
- **The real fullnode bill.** Still 🔶 — needed before pricing it.
- **Billing vendor.** Unchanged scope exclusion.
- The memo's own _"what would flip this"_ clause still stands and is **not**
  closed by this decision.

### Implementation consequences

- **#8610** is a _limits and access_ page, not an API price list: what each
  rate-limit tier allows, how to get a higher one (granted, not bought), and
  what the paid surfaces are.
- A follow-up issue is needed for the paid fullnode tier itself.

## Consequences

- No code or infrastructure change ships with this ADR — it is the
  decision record #8388 asked for. Follow-up issues (titles only,
  unstarted) are filed once the maintainer confirms which option, per the
  issue's own scope.
- This memo does not choose a billing vendor, write billing code, or
  announce a pricing change — all explicitly deferred to implementation
  issues filed after the decision.
- #6646 (the design-spike this memo fulfills) can be closed once the
  maintainer confirms this memo satisfies its ask — left to the
  maintainer's own judgment rather than closed here, since #6646 is a
  business-strategy issue and its closure is itself part of the decision
  this memo is asking for.

## Open questions

- ~~**Pricing/quantity for whichever option is chosen**~~ — the OPTION is now
  decided (see Decision above); the price points remain open and are now
  measurable rather than guessable, via #8597's rollup.
- **Billing vendor** (Stripe vs. alternatives) if (a) or (b) is chosen —
  out of scope for this memo per the issue's own instruction.
- **Whether (b)'s archive/export product and (a)'s API tier are mutually
  exclusive** — they are not architecturally; a future memo could combine
  them (e.g. (b) ships first as the lower-risk revenue test, (a) added
  later if usage data supports it). This memo recommends starting with one,
  not ruling out the other permanently.

## Links/resources

- [ADR 0020](0020-api-key-issuance-and-storage.md) (the identity/metering
  layer this memo assumes; its own "Open questions" section explicitly
  deferred tier granularity to #6646/this memo)
- [ADR 0021](0021-fullnode-rpc-cluster-access.md) (`gittensor-partner`/
  `unlimited` tiers — the existing ops-driven tier-promotion precedent
  Option (c) could reuse directly)
- [ADR 0006](0006-provenance-tiered-storage.md), [ADR 0014](0014-chain-data-infrastructure-and-postgres-cutover.md)
  (the storage/infra tiering the cost model above is built on)
- [ADR 0003](0003-ai-native-layer.md) (the agent-adoption thesis every
  option's "what it risks breaking" column is measured against)
- `workers/tiered-rate-limit.ts` (#8386 — the mechanism Option (a) would
  extend with one more tier; already generalized, not route-specific)
- #6646 (the design-spike this memo fulfills, TaoMarketCap comparator
  source), #5968 (the 11-explorer competitive survey #6646 itself cites)
