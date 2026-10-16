# Alpha runtime receiver recovery

Legacy Alpha and AlphaV2 members are share accounting. A runtime change must
not turn missing layouts into an empty successful scan or infer a pool denominator
from observed members. This change accepts the exact original member/pool packet
on the existing authenticated nominator-position route, including receiver-owned
resume, and publishes only a complete pass under one native state owner.

The source baseline is main `ae554a2c70d3ae4a9b37fa87a04ab2606f0a1238`.
Receiver, arithmetic, receipt and regression material was extracted from retained
#12711 `4a53bfb23be0116776d4134563178b1c433b590f` and #12709
`7a8421f4192e4b2526fe79410f1a5636e1886792`. Those are reference sources, not
qualified releases: their prior full integration retained a failing physical-schema
assertion. Unrelated finality, webhook, retention, delivery and UI changes are
excluded here. Producer source and deployment coordination have a separate owner.

## Runtime and ownership contract

Admission checks genesis, spec, code and original metadata identity together.
The existing exact 454/478 adapters retain their arithmetic bounds and tests.
The explicitly pinned 479 identity uses the source-qualified getter adapter
with exact derived-value parity cases. Original member components, denominator,
pool amount and epochs survive unchanged. The 479 capture layout requires empty
legacy lanes; synthetic legacy arithmetic cases do not authorize legacy storage
in an actual 479 capture. The coordinated producer checks both entire legacy
prefixes at each pinned capture before packets. The receiver checks the declared
legacy member census and each row's legacy components; its receipt alone is not
an independent global denominator-prefix proof. Spec version alone never qualifies
arithmetic.

The capture retains raw `scanned_legacy`/`scanned_v2`, the distinct union
`distinct_members`, and `excluded_root_members`. Serving rows must equal the
distinct union minus excluded root members. Runtime479 additionally requires
zero legacy members and a distinct union equal to its V2 census. Completion
checks actual retained rows and both raw-lane representation deficits against
the explicit root scope. Zero and retired originals remain part of that census.
Historical receipt `selected` is monotone; boolean `current` reports whether
that capture is still canonical by finalized block, then capture timestamp.

The arithmetic reference executes unchanged share-pool 0.1.0 and SafeFloat from
[upstream commit f4786f9](https://github.com/RaoFoundation/subtensor/tree/f4786f9087cac84cfab37cbdf1e01c399042653a),
with SDK `cacb4310f20c7cac83eb3ccd8ed5a5ad4212608a`, substrate-fixed 0.6.0
`d5f70362f2e05b5f33fb51cd7baa825323e4e6c5` and locked dependency digest
`b0c52b9f5c895dd81689c9b148d9abaf4cfc4b9346caecbc41040339b41550f0`.
The reference output digest is
`4240a3b3c16802f2c72fc6bba7297bc669eb30775feae691870b1f16beb96495`.
The public mathematical fixture covers 23 explicitly synthetic vectors and four
unchanged historical 454/478 original cases as cross-version inputs. It compares
raw arithmetic selection, effective share after epochs, exact rao and the getter
wrapper. Normalized arithmetic intermediates never replace original storage bits.

Missing or retired members have unavailable raw `try_get_value` results. The
source-derived getter's `unwrap_or(0)` yields zero for those valid states;
invalid evidence, unknown identity and failed reads still refuse the capture.
Stored zero remains a present zero, including mismatched epochs. Selection,
epoch policy and fallback are source-derived adapters, rather than executed
pallet getters or proof that deployed Wasm matches the reviewed source. The
bounded reference is neither authentic current479 pool/member evidence nor a
full census or runtime-transition proof. Deployment/source binding and authentic
selected-capture acceptance remain activation gates.

Original decimal strings remain exact, including explicit legacy zero, distinct
mantissas/exponents and absent epochs. Derived calculations never replace those
strings. Whole-owner chunks are disjoint, receipts bind original context and rows,
replay cannot recount or replace a chunk, and repeated pool identities must agree.
Partial passes remain isolated from serving rows. Completed capture originals,
metadata and receipts remain retained and immutable. Previously retained
unvalued rows remain unavailable; adding an arithmetic adapter does not rewrite
the accepted capture or borrow another pass's derived quantity.

Promotion publishes the full Alpha source, coverage receipts and selector in one
native transaction, with a row-level readback check. Finalized block order wins
over capture wall clocks. Reader qualification first resolves the newest canonical
capture and then checks its metadata/adapter; it never searches backward for an
older priced pass when the newest pass is unqualified or incomplete. Existing
public response shapes remain unchanged and unavailable economic values use their
existing degraded behavior. The new safe path is scoped to the colocated native
nominator-position owner.

The receiver supports self-stake snapshot receipts and digest-v2 IEEE754 fraction
semantics. It acknowledges source-assigned and Alpha-shadowed observations while
leaving Alpha-owned evidence intact. Legacy partial self-stake remains compatible;
its producer does not exercise full-snapshot receipts or empty-pass retirement.
After Alpha selection, legacy Alpha writers and overlapping self-stake writes are
fenced. Old writers cannot normalize, overwrite or prune selected originals by
falling back to fraction-only input.

## Focused schema identity and recovery compatibility

Main ends at D1 migration 0038. Its bytes and all earlier migration identities stay
unchanged. The proposed next identity is
`0039_alpha_runtime_receiver.sql`: seven tables (`alpha_runtime_metadata`,
`alpha_snapshot_passes`, `alpha_snapshot_chunks`, `alpha_snapshot_rows`,
`alpha_snapshot_pools`, `self_stake_snapshot_passes`,
`self_stake_snapshot_chunks`), nullable `alpha_rao`/`alpha_evidence` on
`nominator_positions`, nullable exact `alpha_snapshot` on the existing
`validator_nominator_counts_passes`, ownership/immutability triggers and indexes.
This is a fresh focused migration, not a renaming of a recorded migration.

The retained stack used 0039 for unrelated retention trigger work, 0040 for
self-stake receipts, 0041 for raw finality, 0042 for webhooks and 0043 for Alpha.
Only the self-stake/Alpha requirements are composed here. Do not copy those
numbers with gaps, apply both versions, or treat any previously recorded 0039 as
this migration. Stop and reconcile the actual ledger and physical schema if
any competing identity is present. No Neon migration is introduced.

The strict exporter supports both exact reviewed position generations: the
baseline seven columns and the additive nine columns. Unknown or partial physical
generations still fail closed. The unchanged typed-cell lossless protocol retains
TEXT shares, evidence and null values; schema/digest identity describes the actual
generation. Export/recovery compatibility must be selected and qualified against
the old physical schema before eventual DDL. Its baseline lossless corpus remains
unchanged; new fixtures exercise the upgraded generation and restored serving.
The position export allowlist is not expanded to unrelated tables. Capture
metadata, immutable rows/pools and receipt tables additionally require coherent
native backup/restore coverage; a positions-only export is not complete recovery.

The native recovery regression takes one coherent thirteen-table family cut,
including all seven new tables, positions, pass/scan completeness evidence and
the export revision ledger, plus counts and their anchored pass receipts.
It restores exact typed cells into a blank migrated
fixture, then checks canonical reads, pending resume, unchanged Alpha/self-stake
receipts, lower-clock canonical counts and replay before completing the pending
pass. Count rows restore before selected Alpha passes, and anchored count receipts
restore after their retained capture identities, in one atomic native batch.
This is a synthetic
software restore proof. It does not certify production backup coverage or permit
mixing independently exported tables while writers continue to mutate them.

## Count transport and terminal receipt

The existing authenticated counts-sync POST accepts
`{rows, pass_total, alpha_snapshot}`. The count anchor contains exactly
`captured_at`, `block_number`, `block_hash`, `genesis_hash`, `spec_version`,
`code_hash`, `metadata_sha256`, `scanned_legacy`, `scanned_v2`,
`distinct_members` and `excluded_root_members`. It travels unchanged through
every packed queue message. Queue admission returns `queued:true` and
`stores:["queue"]`; it does not claim that counts were written.

Poll the same authenticated POST with
`{counts_status:true, alpha_snapshot, pass_total}`. The native terminal receipt
echoes the anchor and total with `stores:["d1"]`, `applied_count`, `completed_at`,
boolean `complete` and boolean `current`. Success requires exact anchor/total
equality, both flags true, applied count equal to the total and non-null completion.
Completion is a positive receiver timestamp; it is not ordered against the
producer's capture clock. Canonical order comes from finalized block identity.
This proves only the co-owned D1 transaction. A separate Neon sink requires its
own completion proof; anchored cross-store application is refused.

The consumer checks actual canonical selection inside the transaction that
writes count rows and their receipt. Distinct actual hotkeys determine progress,
so duplicate and reordered deliveries cannot complete a truncated pass.
Higher finalized blocks may replace counts despite a lower capture clock;
superseded chunks fail without changing counts or receipts. Empty raw captures
use an empty rows/zero-total control transaction, without enqueueing bulk work.
No separate controller or wire generation is introduced.

Bulk queue admission remains bounded to 50,000 rows and 8 MB. Without the queue,
inline application supports at most 1,000 rows and 98,304 UTF-8 bytes of the
projected rows JSON. Larger inline requests return actionable HTTP 413 before
any receipt or business write; configure the count queue or send bounded chunks.
The native writer also rejects more than 5,000 rows or 128 KiB of projected JSON,
matching existing queue transport bounds. Every accepted delivery keeps its
canonical check, rows, census and tally in one atomic transaction. Admission
does not claim bulk completion, and the existing queue packer is unchanged.

Counts describe distinct raw coldkeys per hotkey across all subnets, including
root, stored-zero and retired members. They do not certify economic stake.
Known retained non-root hotkeys and coldkeys bound the declared pass and every
count; additional distinct pairs cannot exceed excluded root members. The root
census also bounds the final distinct-pair sum from below: root has one netuid,
so each excluded root member is a distinct coldkey/hotkey pair. Partial delivery
may remain below that bound; terminal completion may not. Root originals are
outside this serving capture, so their per-hotkey contribution and overlap with
non-root pairs remain producer evidence. Economic readers require qualified quantities,
exclude exact zero outputs, and retain every original row. Count readers require
the current capture's complete anchored pass; old stamps and leftover hotkeys
cannot supply counts or confirmed zeros.

Operator directories requalify counts when serving materialized neuron data.
Public operator, global validator and validator-detail responses use `no-store`;
count-bearing operator and global list routes bypass edge-cache entries whose
neuron or health stamp cannot express capture selection or count completion.
An unchanged neuron artifact cannot preserve a previous capture's count or zero.

## Activation and rollback preconditions

This source change authorizes no production action. Source qualification uses
`validate:declared-tables-exist -- --proposed-native`: it applies the actual
tracked migrations to ephemeral native D1 and checks every declared table/view
and reader dependency against that database's physical catalog. Missing objects
still fail. Its catalog is proposed-schema evidence and is never written into
the observed production artifacts.

The default production verifier, authentic snapshot pair and maintenance workflow
remain strict. Before DDL, the observed catalog through 0038 cannot satisfy the
new 0039 declarations. A passing source check cannot certify deployed objects,
physical headroom, authentic full census or historical state availability.
Main pushes touching these paths automatically apply tracked migrations; merging
this PR is an activation step and remains held.
Exporter-only prerequisite #12767 contains no DDL or new-schema-dependent reader
and must be qualified on the existing schema before this combined change merges.

Before eventual activation, the coordinating owner must:

1. Verify the selected source/receiver/exporter identities, exact migration ledger
   and physical schema, and fence competing old writers at a coherent cut.
2. Qualify old-schema exporter/receiver compatibility first, retain independent
   originals/receipts and a coherent recoverable backup, and prove restoration.
3. Only after exporter and coherent restore qualification, separately authorize
   DDL on the chosen owner. Verify every new column, trigger and table physically,
   capture the actual catalog through the protected schema writer, review both
   production snapshot artifacts, and run the unchanged ledger/schema/declaration
   verifiers. Reconcile those artifacts before main merge. The existing apply
   workflow can apply DDL and then fail verification against the old snapshot;
   that outcome is not successful activation or proof that DDL rolled back.
   Inspect the actual ledger and catalog before any retry.
4. Measure admission and full-pass promotion at worst-case cardinality and pool
   width within D1 execution, statement, memory, I/O and storage budgets, including
   concurrent serving impact. The one-million-row ceiling is not a performance
   guarantee. Incomplete captures are retained rather than silently discarded to
   free capacity; release needs an explicit retention/capacity plan.
5. Coordinate the compatible producer only after those gates, prove exact receipts,
   census, pool originals, deployed-runtime/source binding and canonical
   selection, then verify 479 values and explicit refusal of unqualified captures.
   Exact historical resume requires retained historical state; a receiver receipt
   does not spool every producer packet.

Keep the compatible exporter after DDL. Before any runtime rollback, fence
producers and retain all accepted originals, receipts and canonical selectors.
An old writer/exporter cannot be selected as an implicit rollback after schema
addition or Alpha ownership selection. Reverse DDL, deletion, replay and changing
canonical ownership require separate coordination and approval; no destructive
rollback script is included.
