# Alpha event sufficiency spike (#10835)

This is an offline analyzer, not an incremental position producer. The existing
same-hash Alpha snapshot remains canonical. No scheduling, new storage reads,
state writes or cadence changes are introduced.

## What the pinned source establishes

Both audited source revisions declare `StakeAdded`/`StakeRemoved` as coldkey,
hotkey, TAO, alpha, netuid and **fee**. The trailing u64 is not resulting shares:

- [454 event operands](https://github.com/opentensor/subtensor/blob/14cde6410fe8ec81a940e290c56f94a632a0988d/pallets/subtensor/src/macros/events.rs#L17),
  [actual emission](https://github.com/opentensor/subtensor/blob/14cde6410fe8ec81a940e290c56f94a632a0988d/pallets/subtensor/src/staking/stake_utils.rs#L1036).
- [478 event operands](https://github.com/opentensor/subtensor/blob/850f2755bb05a3851f948489f0ab27b0645cebce/pallets/subtensor/src/macros/events.rs#L17),
  [actual emission](https://github.com/opentensor/subtensor/blob/850f2755bb05a3851f948489f0ab27b0645cebce/pallets/subtensor/src/staking/stake_utils.rs#L1267).

Move and swap events name two pool legs. A single-netuid account projection
cannot supply their complete touch set. Analyze the all-pallet `chain_events`
record, not a curated account feed. The event operand layouts are pinned in
`macros/events.rs` at lines35,295 and310 (478) and35,294 and309 (454).

[478 denominator reconciliation](https://github.com/opentensor/subtensor/blob/850f2755bb05a3851f948489f0ab27b0645cebce/pallets/subtensor/src/macros/events.rs#L836)
names the pool without publishing the rewritten denominator.
[Legacy-first selection, current-share checks and denominator reads](https://github.com/opentensor/subtensor/blob/850f2755bb05a3851f948489f0ab27b0645cebce/pallets/subtensor/src/staking/stake_utils.rs#L1962)
and [epoch changes on denominator zero transitions](https://github.com/opentensor/subtensor/blob/850f2755bb05a3851f948489f0ab27b0645cebce/pallets/subtensor/src/staking/stake_utils.rs#L2056)
require state beyond those event operands. Therefore amounts cannot be applied
as share deltas. This does not prove a fully modeled runtime replay impossible;
it establishes that these decoded events alone are insufficient.

Source revisions describe audited semantics. Their tags alone do not prove the
Wasm deployed at a block. The analyzer admits a runtime only when its declared
spec, code hash and metadata digest match `src/alpha-runtime-identity.ts`.
Unknown identities and unsupported Subtensor methods are reported explicitly.
No unsupported event is silently declared irrelevant to state changes.

## Input and bounded execution

Run only in an approved native/offline analysis environment:

```sh
node scripts/analyze-alpha-event-window.ts manifest.json blocks.ndjson > report.json
```

The command reads exactly two supplied files and writes stdout. It has no RPC,
DB, bucket, queue, host or credential access. It refuses inputs above8MiB for
the manifest or256MiB for NDJSON,10,000 blocks,2,000,000 total events,20,000
events per block,16MiB per block line,64MiB of per-event report records and100,000 canonical comparisons. A
refusal is an unqualified window, never permission to sample and extrapolate.
Offline Node memory and duration must be measured for an actual admitted day;
these bounds are not a capacity or memory guarantee for production.

`AlphaSpikeManifestSchema` and `AlphaSpikeBlockSchema` in
`scripts/lib/alpha-event-spike.ts` define the exact version1 input contract.
The manifest supplies a UTC day, declared evidence kind, genesis, SHA-256 of
all NDJSON bytes, provenance of an independently prepared block/event census,
and every block's hash, parent, chain timestamp, runtime identity and event
count. Include the adjacent header immediately before the day and immediately
after it. Source lines contain one complete block each, ordered by height;
events must be the complete zero-based event-index sequence. Zero-event blocks
are still required. A window missing a block, endpoint, event or final digest
fails closed.

Each block also supplies `canonical_state`, which may be an explicit empty
array if no retained same-hash originals exist. Supplied entries carry member,
pool, original legacy/V2 share, original denominator, total alpha, epochs and
expected exact alpha rao at that block hash. The analyzer calls the existing
`quoteAlphaPool` rather than reimplementing arithmetic. It refuses mismatches,
unknown runtimes and repeated canonical AccountId32 members. Canonical quantity samples require Finney42 and non-root netuids; root legs require their separate state semantics. A successful comparison verifies the
quote computation; it does not independently establish where those state bytes
were obtained. Post-block state also cannot establish an intermediate value
between two events in that block.

The report retains each supported event's exact raw argument string, operand
names, both known pool legs, missing state requirements and derivability
verdict. It does not convert event amounts through JavaScript numbers or use
them to compute shares. Only account and netuid identities are decoded for the
touch set. The distinct count is explicitly the **known-event touch set**, not
a census of every pool whose value changed. Unknown methods remain counted and
reported. Parent links, source hashes and census consistency are checked;
cryptographic header/finality proofs and independent archive custody are not.
Their verification flags remain false. No input label can turn those flags
true or qualify an event-only producer.

## Evidence still needed before choosing a producer

The authentic frozen454/478 fixtures contain bounded state samples at separate
historical hashes, all with share ratios1. They contain neither a complete day
of events nor a nontrivial transition. The added synthetic day fixtures test
admission, duplicate/order/gap refusal, both event legs and canonical
legacy/V2/retired-epoch arithmetic. They are not measurements of real daily
churn. No authentic daily touched-pool count is claimed by this change.

The next bounded evidence action is to materialize one complete UTC day from
already retained originals, with an independently pinned header/event census,
raw arguments, per-runtime metadata/code identities, adjacent boundary headers
and the original finality/publication receipts. Attach retained canonical
same-hash pool/member samples, including a denominator change and an epoch
retirement if present. Record missing state as missing; never fetch a pruned
value under a later hash. Run the analyzer natively, retain source/report
hashes and duration/peak memory, then independently check archive custody and
finality. A census exceeding admission needs a reviewed streaming extension,
not widened production query limits.

Before any incremental producer, enumerate all runtime mutation paths affecting
member originals, denominators, pool amounts and epochs, including hooks,
emission, migrations, direct transfers and events absent from this initial
method set. Compare complete independent state passes with the proposed replay
at the same finalized cuts. Measure distinct known touched pools, unknown paths,
state reads and all affected members to recompute. Keep daily reconciliation
and explicit gaps until that stronger proof exists. #10835 remains open; this
spike completes source tooling and identifies the exact evidence input gap.
