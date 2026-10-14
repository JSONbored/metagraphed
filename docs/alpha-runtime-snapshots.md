# Runtime-qualified Alpha snapshots

Legacy `SubtensorModule::Alpha` and the current `AlphaV2` are share accounting,
not asset amounts. The old producer walks only legacy shares and both the
producer and native normalization infer a denominator by summing observed
members. That misses migrated members and changes runtime share-pool semantics.
Neuron `stake_tao` is effective voting weight, including inherited/weighted Root;
it is not an asset balance, even on non-Root subnets. See #12014 and #12112.

This source draft qualifies two exact deployed runtime/code/metadata identities:
454 at block9000000 and478 at9277292. Original V14 metadata is retained in the
frozen fixtures. The deployed code hash, rather than a runtime tag/spec number
alone, selects the audited arithmetic. The private producer asks for a finalized
head, checks Finney genesis, obtains runtime/code/metadata at that hash and keeps
that same original transport/hash through every state read. Unknown identity,
layout, omitted/duplicate/wrong-block value, bad cursor or decode fails the full
pass before publication. It does not fall back to legacy-only decoding.

Both keyspaces are paged to an explicit empty result. A short page is continued,
never mistaken for the end. Blake2_128Concat/identity key components are checked.
Pool legacy/V2 denominators, TotalHotkeyAlpha and478 pool/member epochs are
state_queryStorageAt batches of at most250keys at the same hash; there is no
runtime call per member. Every bounded batch yields the existing global scan
admission permit, including short pages and248-key pool batches. The original
minimum scan floor remains a guard, not proof of complete network coverage.
The producer admits at most1million unique members; actual peak RAM/RPC budget
must still be qualified before deployment. Counts keep their existing distinct
stored-member definition, including zero/Root rows; they do not claim positively
valued or complete wallet holdings.

The sink retains original legacy u128 bits and SafeFloat mantissa/exponent as
canonical decimal strings. Legacy presence, including zero, wins over V2.
TotalHotkeyAlpha is u64 rao, not a SafeFloat. SafeFloat checked intermediate
exponents, truncation, capped powers and u64 saturation follow the pinned
runtime. Only478 retires a member when nonzero pool epoch differs from the
member epoch and caps the resulting amount at the pool total;454 does neither.
A display share ratio alone may be floating point; exact originals and resulting
rao never pass through Number. A nonfinite display ratio is unavailable.

Migration0042 adds two optional serving columns and native metadata/pass/chunk/
staging tables in the current state owner. Original runtime metadata is stored
once by SHA, sent only in the first chunk and not duplicated per pass. Whole
account-owner chunks are2500rows maximum with an8MB serialized UTF-8 request ceiling.
The shared ordered context/original-component tuple hashes identically in the
Rust producer and TypeScript receiver; the golden receipt exercises that wire
contract. The private producer requires the exact receipt/census/completion,
not just an HTTP2xx from a receiver ignoring the new protocol. The bounded
receipt transport is shared with existing complete self-stake snapshots.

Partial passes never modify serving rows or trigger unchanged serving exports.
Exact chunk receipts prevent recounting/replacement and disjoint owner ranges
refuse overlapping chunks. Same-block pool evidence must agree across members.
Once every declared row/chunk lands, one native transaction publishes the Alpha
source, retires only its superseded source rows, updates completion and verifies
the selected target rows. Lower finalized blocks cannot replace higher selected
ones despite later wall clocks. Old Alpha writers are fenced after selection;
a legacy self-stake writer cannot erase an existing qualified Alpha row.

Staging reserves at most two incomplete passes and an aggregate1million expected
positions. Uncompleted originals are not silently purged to make room. An
interrupted source must resume/repair its exact capture or receive a reviewed
operator decision; a newer daily walk is not authority to destroy older originals.
The metadata/pass/chunk record and retained serving originals require coherent
native backup/restore ownership. D1 PITR does not recover independently removed
assets. The serving export permits the exact Alpha originals/rao, which contain
public chain data and no signing secrets. Current API quantity/provenance and
explicit compatibility/deprecation are a separate dependent consumer correction:
this ingestion draft alone does not make the legacy neuron-derived API quantities
supported holdings or permit relabeling them as native Alpha.

Authentic fixtures cover legacy-only and V2-only members at454, V2/default epochs
and matching nonzero epochs at478. Their ratios all equal1. Mixed-layout overlap,
nontrivial fractions, retirement, caps and extreme exponents are clearly synthetic
causal fixtures. No authentic exact-upgrade transition, nontrivial fraction, full
census or genesis history is asserted. Current snapshot originals do not establish
historical state availability: blocks/extrinsics/events cannot automatically
regenerate these pool/member states once pruned. This is latest-state ownership,
not a new complete historical Alpha archive.

Release requires both producer and receiver full native CI/required99%branch-
counted patch coverage, independent source review, physical schema introspection,
actual D1 space/write/index/transaction/memory/RPC qualification, coherent recovery
and runtime/schema ordering. The final whole-source promotion cost is unmeasured
at production cardinality. The reported near10GB D1 file size establishes no free
space. Applied0038 and held0039/0040/0041 are preserved. No live DDL, capture,
backfill, endpoint workload, fleet command, purchase or hosting decision is part
of this source preparation. Rollback must fence producers and preserve selected
originals; an old consumer/writer is not a safe implicit rollback after selection.
