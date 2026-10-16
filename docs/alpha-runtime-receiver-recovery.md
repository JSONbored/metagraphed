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
The existing exact454/478 adapters retain their arithmetic bounds and tests.
The explicitly pinned479 identity is admitted for structural capture only;
its original legacy/V2 components, denominator, pool amount and epochs survive,
while derived valuation remains null and unqualified. Spec version alone never
qualifies arithmetic. A later479 valuation adapter requires separate evidence
and review; it must not rewrite the accepted originals.

Original decimal strings remain exact, including explicit legacy zero, distinct
mantissas/exponents and absent epochs. Derived calculations never replace those
strings. Whole-owner chunks are disjoint, receipts bind original context and rows,
replay cannot recount or replace a chunk, and repeated pool identities must agree.
Partial passes remain isolated from serving rows. Completed capture originals,
metadata and receipts remain retained and immutable. Capture-only passes can
complete and become canonical without inventing an economic quantity.

Promotion publishes the full Alpha source, coverage receipts and selector in one
native transaction, with a row-level readback check. Finalized block order wins
over capture wall clocks. Reader qualification first resolves the newest canonical
capture and then checks its metadata/adapter; it never searches backward for an
older priced pass when the newest pass is unqualified or incomplete. Existing
public response shapes remain unchanged and unavailable economic values use their
existing degraded behavior. The new safe path is scoped to the colocated native
nominator-position owner.

Self-stake uses the existing snapshot receipt owner and digest-v2 IEEE754 fraction
semantics. It acknowledges source-assigned and Alpha-shadowed observations while
leaving Alpha-owned evidence intact. Legacy partial self-stake remains compatible
before DDL. After Alpha selection, legacy Alpha writers and overlapping self-stake
writes are fenced. Old writers cannot normalize, overwrite or prune selected
originals by falling back to fraction-only input.

## Focused schema identity and recovery compatibility

Main ends at D1 migration0038. Its bytes and all earlier migration identities stay
unchanged. The proposed next identity is
`0039_alpha_runtime_receiver.sql`: seven tables (`alpha_runtime_metadata`,
`alpha_snapshot_passes`, `alpha_snapshot_chunks`, `alpha_snapshot_rows`,
`alpha_snapshot_pools`, `self_stake_snapshot_passes`,
`self_stake_snapshot_chunks`), nullable `alpha_rao`/`alpha_evidence` on
`nominator_positions`, ownership/immutability triggers and supporting indexes.
This is a fresh focused migration, not a renaming of a recorded migration.

The retained stack used0039 for unrelated retention trigger work,0040 for
self-stake receipts,0041 for raw finality,0042 for webhooks and0043 for Alpha.
Only the self-stake/Alpha requirements are composed here. Do not copy those
numbers with gaps, apply both versions, or treat any previously recorded0039 as
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

## Activation and rollback preconditions

This source change authorizes no production action. The original physical-schema
assertion and observed schema snapshot remain unchanged. Proposed-schema native
fixtures are software evidence and cannot certify deployed objects, physical
headroom, authentic full census or historical state availability.

Before eventual activation, the coordinating owner must:

1. Verify the selected source/receiver/exporter identities, exact migration ledger
   and physical schema, and fence competing old writers at a coherent cut.
2. Qualify old-schema exporter/receiver compatibility first, retain independent
   originals/receipts and a coherent recoverable backup, and prove restoration.
3. Separately authorize DDL on the chosen owner, verify every new column, trigger
   and table physically, retain that actual schema capture, and rerun the intact
   physical-schema gate. Main merge would otherwise trigger tracked D1 maintenance.
4. Measure admission and full-pass promotion at worst-case cardinality and pool
   width within D1 execution, statement, memory, I/O and storage budgets, including
   concurrent serving impact. The one-million-row ceiling is not a performance
   guarantee. Incomplete captures are retained rather than silently discarded to
   free capacity; release needs an explicit retention/capacity plan.
5. Coordinate the compatible producer only after those gates, prove exact receipts,
   census, pool originals and canonical selection, then verify current readers
   decline unqualified479 valuation. Exact historical resume requires retained
   historical state; a receiver receipt does not spool every producer packet.

Keep the compatible exporter after DDL. Before any runtime rollback, fence
producers and retain all accepted originals, receipts and canonical selectors.
An old writer/exporter cannot be selected as an implicit rollback after schema
addition or Alpha ownership selection. Reverse DDL, deletion, replay and changing
canonical ownership require separate coordination and approval; no destructive
rollback script is included.
