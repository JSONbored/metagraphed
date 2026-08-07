# ADR 0022 — Paid-tier decision memo

- **Status:** Accepted · **content moved to `JSONbored/metagraphed-infra`
  (`docs/paid-tier-decision-memo.md`) on 2026-08-07**
- **Date:** 2026-07-27 (moved 2026-08-07)
- **Superseded by:** nothing — the decision stands, the document is private

## Why this number is a stub

The memo is a commercial strategy document: what to sell, what competitors can
and cannot match, where the margin is, and which surfaces are worth charging
for. That is not open-source material, independently of the infrastructure
detail it also carried — the fullnode tunnel hostname, the Ansible role names
behind the self-hosted RPC tier, and the archive backup posture.

The number stays claimed so the ADR sequence keeps no hole and existing links
land on an explanation rather than a 404.

## What is public about it

The **outcome** is, and is visible in the code rather than in a memo: the data
API is free, the rate-limit tiers are declared in `wrangler.jsonc`, and the API
key model is [ADR 0020](0020-api-key-issuance-and-storage.md) with the gated
fullnode RPC in [ADR 0021](0021-fullnode-rpc-cluster-access.md). Nothing a
consumer needs in order to use or reason about this API lives in the private
copy.

See [ADR 0028](0028-public-private-repo-boundary.md) for the rule.
