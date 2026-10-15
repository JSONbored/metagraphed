# Prospective canonical raw capture

This source proposal adds one native owner for raw publication and its frontier. It does not
claim genesis completeness, recover unavailable historical state, lower either capture floor,
or certify the existing height-only prefix. The explorer's current public contract is unchanged.

## Source and schema dependencies

- PR #12620 owns migration `0038_raw_capture_publications.sql`, already applied on 2026-10-03.
  Preserve its immutable exact-byte receipts, logical chain hash and native archive handoff.
- PR #12621 reserves unapplied migration `0040_self_stake_snapshot_receipts.sql`. Its source and
  migration precede this proposal in the stack; this change does not rewrite that migration.
- This proposal owns unapplied `0041_raw_capture_finality.sql`. Its nullable anchor columns leave
  all existing heights, timestamps and error details intact. `verified_from` starts at the old
  frontier plus one. The new proof ledger is retained across staging archival.

The physical-schema validator remains enabled. A draft containing unapplied tables cannot be
release-qualified merely because fixture DDL succeeds. No live schema snapshot is fabricated here.
Applying migrations, generating a new snapshot from live introspection, and runtime deployment
require a separate reviewed release decision. No live schema, backfill, repair or floor change is
part of this proposal.

## Capture protocol and trust

The producer pins `chain_getFinalizedHead`, rehashes the SCALE header using Compact<u32> and
Blake2b-256, checks the network's measured genesis, and rechecks the canonical hash at the pinned
height. It validates the actual legacy predecessor header before initializing an anchor. Every
chunk and failover checks genesis, the fixed finalized hash, the durable predecessor and the
previous finalized anchor. Every captured row must match its recomputed header hash and the
preceding row's hash, and contain ordered even-length SCALE extrinsics and available event bytes.

These checks establish consistency with an RPC source's finalized assertion. They do not verify
GRANDPA justifications, reconstruct the extrinsics trie or prove System.Events inclusion against
the state root. A malicious consistent source can still lie. Runtime metadata at an upgrade's
post-block state is not automatically the executing runtime for that block. Decoder provenance,
upgrade boundaries, historical metadata/runtime availability and derived-data coverage remain
separate acceptance work.

Raw bytes are staged and independently compressed-byte checked. One native D1 batch marks the
bytes complete, inserts the canonical publication receipt and its proof, and lets the proof trigger
advance the exact frontier and select those bytes. Canonical receipts do not choose archived legacy
candidates by capture timestamp. Native selector/archive guards also refuse older runtime SQL;
application-only checks are insufficient for an in-flight or rollback writer. The proof trigger performs an exact predecessor/revision compare-and-swap and aborts the
batch if that frontier change did not occur, including a trigger that returns RAISE(IGNORE).
A lost reply is resolved against a publication plus its qualified proof and guarded descendant
frontier, including after native archival releases the staging chunks. A concurrent equal-chain
capture may have a different captured_at token and still resolve to the winning transition.
Different ranges, branches or predecessors cannot advance a stale cursor.

Existing legacy captures may remain readable. Once a network has an anchor, a height-only writer
cannot advance it or change the selected canonical bytes. A legacy selected object with a future
capture timestamp cannot prevent prospective canonical selection. A branch mismatch is a loud
refusal, never permission to rewind or rewrite an existing finalized anchor.

## Budgets and production qualification

The paced lane budget includes three HTTP requests per chunk: anchor qualification, hashes,
and body/events. Every bootstrap and failover attempt consumes a paced slot from the same
planned chunk allowance, plus one startup slot; endpoint count cannot widen the invocation span. All RPC requests, including bootstrap and failover attempts, share a hard cap
of 200 per network invocation. This cap does not prove a total Worker subrequest, native-query,
CPU, compressed-byte or transaction budget. Qualify those separately with representative bytes,
real binding limits and scheduled overlap before releasing. Endpoint count never multiplies the
shared rate allowance. Neither this source change nor its tests run heavy public-chain workloads.

## Acceptance and rollback boundary

Native CI must exercise the authentic frozen header vector, synthetic branch/admission failures,
both networks, partial prefixes, concurrent versions, ignored writes, lost replies, native archival
and restarted capture. The original receipt and acknowledged-watermark regressions remain in scope.
Full repository CI, branch-counted patch coverage and the physical-schema gate must be reported
against the exact head; a failed gate cannot be called a pass or silently waived.

Before any migration release, take and restore-test a backup, inventory current legacy coverage,
compare all preserved rows and archive receipts, and inspect the proposed SQL physically in a
representative isolated native database. After separately authorized schema application, take the
real schema snapshot and rerun every required gate before runtime release. Observe a bounded
prospective interval for cursor linkage, finality assertions, byte receipts, archive handoff,
endpoint admission and invocation budgets. Rollout needs an explicit stop condition for each.

Runtime rollback after anchoring cannot resume the old height-only writer: the database guards
intentionally reject it. Disable capture while retaining the schema, receipts, checkpoint and bytes;
restore the qualified canonical writer before resuming. DDL rollback or finalized-branch repair
requires a separate reviewed preservation plan. Never delete anchors to make old code run.

A serving-table export is not a backup of this control protocol: raw state and proof/publication
ledgers are outside `D1_EXPORT_TABLES`. Restore acceptance must preserve the whole coherent native
state set (`raw_capture_state`, `raw_capture_finality`, `raw_capture_publications`, selectors,
staging descriptors/chunks and archive descriptors) plus the referenced native archive bytes.
Qualify the actual native snapshot/SQL-export restore format and trigger creation order: ordinary
application inserts intentionally cannot recreate an anchored frontier without its proofs. No
ad-hoc row replay or independently timed partial exports are established as a restore procedure.

## Coordinated release requirement

Merging this draft is itself a live-schema action: `.github/workflows/d1-maintenance.yml` runs
`migrate:d1 -- --remote` on main pushes touching migrations, then introspects and validates the
physical schema. Automatic native Worker builds also deploy main independently; the deployment
script defaults to production and does not wait for that schema gate. A generic source-preparation
approval therefore does not authorize merging this draft.

Before any owner-approved merge, define a coordinated capture pause and deployment hold that
prevents new code reaching production before the schema/physical snapshot is qualified. Preserve
both current frontiers and their byte/receipt estate, qualify native restore, inspect the exact
0040/0041 application order, and determine how actual introspection is committed for the required
full CI and coverage. Record the exact image/version that may resume capture after those gates.
Neither CI failure nor the automation order justifies a fabricated snapshot, gate waiver or live
application during preparation. The pause/hold mechanics and their bounded operational approval
remain release work, not an inferred action in this draft.

The isolated native CI upgrade/restore regression creates legacy selected bytes and a legacy
frontier before actual0038 DDL, then applies0038/0040/0041 in order. It verifies that0038 itself
creates the NULL legacy chain receipt. After prospective capture it retains and independently
checks real compressed/raw fixture bytes, archives them through native D1, closes workerd,
copies the complete SQLite persistence tree and object files, then restarts a separate runtime.
It checks the archived receipt, unchanged verification floor, old-SQL refusal and next-block
resume. This qualifies a closed local native persistence fixture, not production Cloudflare
Time Travel, an operator backup or the actual deployed asset-service recovery path.
