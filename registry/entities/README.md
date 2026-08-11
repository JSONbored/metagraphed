# `registry/entities/`

One file per address: `registry/entities/<ss58>.json`, matching
`schemas/entity.schema.json`. This is the curated layer that names the
addresses the chain never will — exchange wallets, bridge escrows, foundation
and team treasuries, burn addresses.

**It is empty, and that is a real state.** Nothing has been attributed yet
because nothing has cleared the bar. An empty directory here is the honest
answer, not an oversight — see below for why filling it carelessly would be
worse than leaving it empty.

## Before you add a file

Read **[`docs/nametag-evidence-bar.md`](../../docs/nametag-evidence-bar.md)**.
It answers the only question that matters: what counts as proof that this
address belongs to this entity?

The short version: at least one **independent, public, verifiable-by-anyone**
source that ties **this specific address** to **this specific entity**. Not
that the entity exists. Not that the address exists. That the two are the same
thing.

Not accepted on their own: folklore, a third party's assertion, inference from
transaction patterns, or a truncated address that "matches".

> A wrong nametag is actively worse than no nametag: it's a specific,
> confident, _wrong_ claim rendered next to real financial activity, not a
> merely incomplete one.

## Two categories carry extra rules

**`owner` is not a declarable category.** It is read from
`SubtensorModule.SubnetOwner` and served with `chain_derived: true`. A
hand-written `owner` entry is dropped rather than honoured, so no file here can
impersonate a chain read.

**`burn` requires proof of unspendability** — `unspendable_proof.basis` is one
of `known-black-hole`, `provably-keyless`, or `documented-recycle-call`. An
address with no observed outbound movement is **not** a basis: silence is not
inability to spend. A team saying "we will not spend this" is a promise, which
is a `treasury`.

## What happens after you add one

Every entry enters as `review.state: "community-submitted"`. A maintainer
promotes it to `maintainer-reviewed` after checking the cited source actually
supports the claim, or marks it `rejected` if it does not. `review.reviewed_at`
records when that happened, separately from `submitted_at` — a submission and a
review are different claims.

The entries here are published at `/metagraph/entities.json` and surface on
`GET /api/v1/subnets/{netuid}/wallets`, where **every attribution carries its
`source_urls` in the response** so a reader repeating it can check it without a
second call.

## Whether anyone has looked

Separately from this directory, a scheduled lane records — per subnet, with a
date — that its published surfaces were searched for an address, and what was
found. That is an observation and lives in Neon, not here; it surfaces as
`attribution_search` on the wallets route. An empty wallet list beside a
`none-published` verdict means somebody looked; beside a null one it means
nobody has.
