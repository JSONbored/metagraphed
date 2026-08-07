# ADR 0028 — The public/private repo boundary: what lives where, and the test that decides

- **Status:** Accepted
- **Date:** 2026-08-07
- **Supersedes:** [0016](0016-indexer-rs-consolidation.md) (indexer-rs consolidation)
- **Relates to:** metagraphed-infra#343 phase 4, metagraphed-infra#374

## Context

Two repositories hold this project. `JSONbored/metagraphed` is public and
open-source; `JSONbored/metagraphed-infra` is private. Which side a given change
belongs on has been decided case by case, and the recurring question — asked of
the Rust indexer, of the box runbooks, of the backup procedures — has never had
a written answer.

**The answer that did exist was wrong, and it was public.** ADR 0016 (2026-07-13)
moved the Rust chain indexer from a private repo into `apps/indexer-rs/`, and
argued:

> Keeping `indexer-rs` private after that precedent no longer had a real
> justification: it isn't itself a secret (subtensor is a public chain,
> decode/backfill logic isn't proprietary)

That decision was reversed. `indexer-rs` was extracted back out to
`metagraphed-infra/services/indexer-rs/` in #9170, and it is now the only place
the poller and decode Containers are built and deployed from. But 0016 remained
**Accepted** in the public ADR index, pointing at a directory that no longer
exists, giving reasoning that is the opposite of why the code moved back. A
contributor reading the index would conclude the project's position is that none
of this is worth protecting.

An ADR is an immutable record of a decision at a point in time, so 0016 is not
edited. It is superseded, and this is the superseding record.

### What the boundary is actually protecting

Not the chain. Subtensor is public, its runtime is public, and anyone can sync a
node. What is not public is **the accumulated work of making that chain
queryable**: which storage maps are worth scanning and at what cadence, how a
pass is proven complete, how a runtime upgrade is absorbed without a decode
lane wedging, which failures are transient and which are structural. That
knowledge is in the ingestion services and the operator procedures, and it is
several months of measured incidents, not an afternoon's transcription.

The comparison worth naming: no competitor in this space publishes their
ingestion internals either.

## Decision

**The test is what a document or a file _does_, not what it is about.**

| If it…                                                                                   | It goes     | Because                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **serves a request** — Workers, routes, readers, the contract, the UI                    | **public**  | It is the product. Its behaviour is observable from outside anyway, and a consumer reasoning about a response needs the code that produced it.                                        |
| **produces the data** — the Rust poller, decode lanes, backfill, ingestion               | **private** | The accumulated operational knowledge above.                                                                                                                                          |
| **operates a machine** — Ansible, inventory, box runbooks, backup and restore procedures | **private** | It describes systems the public has no business reaching, and a map of the backup estate is a map for someone else too.                                                               |
| **is a commercial position** — pricing strategy, competitor economics, margins           | **private** | Not open-source material at any level of infrastructure detail.                                                                                                                       |
| **is the rule itself**                                                                   | **public**  | Stating that ingestion is private protects nothing by being secret, and a contributor who does not know the rule will keep proposing the wrong thing. This ADR is the worked example. |

Two consequences of the test that are worth stating because they read as
exceptions and are not:

- **`src/indexer-rs-ethereum-decode.ts` is public** despite the name. It decodes
  an EVM call _on the serving path_, in response to a request. It serves; it
  does not produce.
- **`deploy/`'s three Dockerfiles are public** despite building box-side images.
  They are the **canonical source** of six files vendored byte-for-byte into
  `metagraphed-infra/roles/*/files/`, and that repo's
  `scripts/check-vendored-sync.py` compares against this repo's `main` daily. A
  fix lands here first and is re-vendored afterwards, never the reverse.

### What this means in practice

**Before adding a new deployable to the public repo, apply the test.** A new
ingestion service goes in `metagraphed-infra/services/` and deploys from that
checkout — Cloudflare Workers Builds is wired to the public repo only, so a
private service is deployed explicitly rather than on merge.

**The seam between the two is HTTP.** The private producers POST to
`/api/v1/internal/*-sync` on the public Workers, each authenticated by its own
shared-secret header, each verified with `timingSafeEqual` and refused with a
503 when the secret is unset. Those routes are public code — they serve a
request — and they are the only surface the private side touches.

**A history purge is not part of this.** `indexer-rs` remains in this repo's git
history from its time under `apps/`. Rewriting published history is a separate,
destructive decision with its own costs, and it is not taken as a side effect of
writing down a rule.

## Consequences

**Moved to `metagraphed-infra` with this ADR** (metagraphed-infra#374), each
leaving a stub here so existing links land on an explanation:

| Was                                       | Now                                                |
| ----------------------------------------- | -------------------------------------------------- |
| `docs/disaster-recovery.md`               | `docs/disaster-recovery.md` (private)              |
| `deploy/README.md` (the operator runbook) | `docs/self-hosted-deployment-runbook.md` (private) |
| ADR 0022, the paid-tier memo              | `docs/paid-tier-decision-memo.md` (private)        |

**Deliberately not moved.** ADR 0013 and 0014 describe the chain-data
architecture and the reasoning behind the Postgres cutover, and ADR 0015
describes the firehose. They name box topology in passing, but their content is
_why the system is shaped as it is_ — which is exactly what an open-source
project should be able to explain about itself. The boxes they describe are
decommissioned; the reasoning is still load-bearing.

**What this ADR does not fix.** The seam's row shapes are duplicated by hand on
both sides of the boundary — `src/chain-network.ts`, `src/decode-watermark.ts`
and `src/poller-lane-health.ts` each carry a "MUST match" comment naming a file
in the other repo. They agree today, nothing checks that they keep agreeing, and
a drift fails silently as a schema-stable empty result. A boundary with no
contract across it is the next thing to fix, tracked separately.
