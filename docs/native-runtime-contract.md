# Native runtime contract

`POST /api/v1/native-runtime`, the `get_native_runtime` MCP tool and `/apis/native`
use the same request and response schemas. The runtime's portable metadata is
the source for pallet names, storage keys, constants, native call arguments and
read API signatures. A new storage field or call does not require another
hand-maintained list of JSON fields.

The stable JSON contract describes the portable type grammar. Type identities
and values come from the selected finalized block, and therefore follow that
block's runtime. Keep the response's source together with its type registry;
type IDs must not be carried between runtime upgrades. Integers are decimal
strings, bytes are hex, and fixed-point types retain their original bits.

## Discover and use protocol features

Describe a pallet to discover its storage items, constants and native calls:

```json
{
  "operations": [
    { "kind": "describe", "pallet": "SubtensorModule", "limit": 32 }
  ]
}
```

Descriptions include the argument types and key arity. Follow `next_offset`
to inspect another page, using the response's `finalized_block_hash` as
`as_of` to keep that discovery at the same source. A request without a pallet,
API or type ID lists the available namespaces. `type_id` returns the relevant
portable type closure.

The native page provides current mechanism, collateral, hyperparameter, account
lock, auto-stake and pending delegation views. Its contract browser also makes
the other runtime storage items, constants, read APIs and calls accessible.
Hyperparameter names introduced upstream become readable labels, while their
exact values and the complete original response remain accessible.

`storage` reads one fully specified key. `entries` discovers map records using
zero or more leading key arguments, so a caller does not need to know every
account key in advance:

```json
{
  "operations": [
    {
      "kind": "entries",
      "pallet": "SubtensorModule",
      "member": "MinerCollateral",
      "args": [19],
      "limit": 16
    }
  ]
}
```

Rows contain the storage key, decoded value and key components. Concat and
identity hashers yield the original typed key. Irreversible hashers yield the
exact digest with its hasher ID. Continue with the result's `next_cursor` and
the original response's finalized hash as `as_of`; the server rejects a cursor
without that source. All seven Substrate storage hashers are supported.

`constant` reads a declared pallet constant. `runtime` invokes a metadata-declared
method in an audited read API family. Node-internal block execution and keystore
generation are excluded. Consensus authorities, epoch state and ownership proofs,
session-key decoding, genesis presets, and EVM accounts, code, storage and finalized
receipts are available through individually audited methods from the
[v470 runtime implementation](https://github.com/RaoFoundation/subtensor/blob/923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d/runtime/src/lib.rs).
Mixed API families do not admit new methods implicitly. EVM `call` and `create`
simulate contract or precompile execution using the official runtime’s non-transactional
runner at the selected finalized block. Both use their metadata-declared argument and
return types, including access and authorization lists when the runtime declares them.
The caller must supply an exact positive `gas_limit`; each request has an aggregate
one-million-gas budget, in addition to the input, output and timeout bounds. Reverts,
return bytes, gas consumption and runtime dispatch errors retain the declared result
structure. Simulations do not create execution receipts or persist chain state.

Follow the discovered portable type for EVM quantities. The v470
`primitive_types::U256` layout is four little-endian `u64` limbs, so a gas limit
of 500,000 is `["500000", "0", "0", "0"]`. All limbs remain exact decimal
strings, and every high limb participates in gas admission. The existing
aggregate gas cap and duplicate coalescing apply to this layout as well as
historical scalar integer layouts. The current signature also includes the
metadata-declared `authorization_list` argument.

The public MCP `decode_evm_call` tool accepts `runtime_spec_version` for
release-bound precompile calldata decoding. The audited catalogue follows every
published compiled release in the qualified spec 205–471 eras, including the
v470 scheduler,
Drand, timestamp, runtime configuration and precompile registry interfaces.
Nested arrays, dynamic bytes, UTF-8 strings and fixed byte arguments retain their
declared ABI shapes; wide integers remain exact decimal strings. The result
identifies its source commit. Unknown selectors retain the recognized address;
malformed arguments produce `args: null` rather than a partial decode. Raw
cryptographic/storage precompiles are identified but have no Solidity selector.
The tool makes no chain requests. Omit the version to retain the original
captured-call catalogue and response bytes. The protected history decoder is
unchanged. Decoding is a local interpretation of calldata; use the native
`EthereumRuntimeRPCApi.call` operation to simulate execution at the selected
finalized source.

The same native REST/MCP contract provides release-bound precompile discovery and
encoding. `{"kind":"describe","evm":true}` lists precompile addresses;
`{"kind":"describe","evm":"0x0000000000000000000000000000000000000805"}`
lists that address's signatures, selectors, argument names/types and return layouts. Both use the
ordinary offset/limit paging and finalized source. Raw cryptographic precompiles
have no Solidity function list.

On `EthereumRuntimeRPCApi.call`, add `evm_call` with a catalogue signature and
ordered Solidity arguments. Set the native `to` argument to the precompile and
keep `data` as `"0x"`. For example:

```json
{
  "signature": "getStake(bytes32,bytes32,uint256)",
  "args": [
    "0x1111111111111111111111111111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222222222222222222222222222",
    "19"
  ]
}
```

The server encodes and inserts exactly that ABI input; native source, gas, value,
access/authorization lists, admission and duplicate coalescing still apply. The
result contract retains the signature, selector, address and source commit;
padded calldata is not echoed into that compact receipt. The same `evm_call` works with native `EVM.call` preparation using
`target` and empty `input`, so the existing explicit wallet review can sign those
method bytes. Integer widths, dynamic array offsets, UTF-8 and byte padding are
bounded and exact. Caller-supplied selectors and arbitrary signatures cannot
replace the release-qualified ABI. Ordinary raw calldata remains supported.

The native page inspects and pages precompile signatures, accepts Solidity
arguments and sends the compact descriptor at the inspected finalized source.
Successful `evm_call` simulations also expose `evm_result.values` in the declared
output order. `getStake` returns an exact decimal quantity; `getAxon` and
`getCrowdloan` return named records; array and dynamic byte/string outputs retain
their contents. Each selected signature's return layout is included in
`contract.evm_call.outputs`. Wide integers are decimal strings, tuples use
unique named fields or positional arrays, and bytes remain hex.

The complete native `value` still carries raw return bytes, exit reason, gas,
weight and logs. Dispatch failures, reverts and EVM errors receive explicit
`evm_result.status` values without interpreting their bytes as successful
outputs. Malformed ABI padding, offsets, lengths, trailing bytes or invalid
UTF-8 produce `invalid_output` while retaining the native execution result.
Decoding is bounded by the existing value and response budgets and adds no
execution request. Return layouts follow the selected release's actual Rust
dispatch signatures and codec structs, including functions omitted from older
Solidity ABI files; output layouts are shared across unchanged releases.

Clients do not need a downloaded ABI, selector hashes or padded calldata in chat
context. Reference-vector and compiled-metadata tests qualify encoding and
binding; they do not establish successful execution of a particular call on a
live node.

`ShieldApi.try_unshield_tx` decrypts caller-supplied shielded data and decodes
the resulting extrinsic. The audited implementation does not submit it, access
a local keystore or write chain state. It is available alongside
`try_decode_shielded_tx` and `is_shielded_using_current_key` through the same
typed contract and bounded SCALE read path.

`ContractsApi.call`, `instantiate` and `upload_code` provide Wasm contract
simulation. Describe `ContractsApi` to obtain the selected runtime's complete
argument types. Call and instantiate require an explicit `Some` gas limit;
omitting it would select the upstream maximum block Weight. For WeightV2,
the limit has this form:

```json
{
  "variant": "Some",
  "fields": { "ref_time": "100000000000", "proof_size": "32768" }
}
```

Distinct simulations in a request share limits of 250,000,000,000 reference
picoseconds and 65,536 proof bytes. Reference time is a Weight unit, not a
prediction of wall time. Historical WeightV1 uses an exact reference-time
integer in the `Some` fields. Code upload simulation and `instantiate` with
`Code::Upload` share one upload and 16,384 code bytes per request; the overall
32 KB request limit also applies. `Code::Existing` selects an on-chain code
hash. Both hex byte strings and byte arrays use the runtime's declared SCALE
types. Returned gas consumed/required, deposits, account/code hashes, return
flags and bytes, and dispatch errors remain exact typed results. A revert flag
does not become a successful execution receipt.

A `code_artifact` reference supports full Wasm code without inserting its hex
into the request or chat context. Supply a public `raw.githubusercontent.com`
file URL pinned to a full commit, the exact SHA-256 and uncompressed byte count:

```json
{
  "kind": "runtime",
  "api": "ContractsApi",
  "member": "upload_code",
  "args": ["<origin>", "0x", "<storage deposit limit>", "<determinism>"],
  "code_artifact": {
    "url": "https://raw.githubusercontent.com/owner/contracts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/contract.wasm",
    "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "bytes": 131072
  }
}
```

Use the metadata-declared argument order and types; the strings in angle
brackets above are placeholders. For `instantiate`, keep the code enum as
`{"variant":"Upload","fields":"0x"}`. The same reference works with native
`Contracts.upload_code` and `instantiate_with_code` preparation. The server
checks the declared code type, all arguments and explicit simulation Weight,
then loads at most one distinct public artifact under a five-second deadline
and bounded stream. Redirects, mutable URLs, wrong lengths or checksums reject.
Artifact size is at most 128 KiB and must fit this source's `MaxCodeLen`.
Distinct simulations still share one upload and the same Weight budgets. The
reference and verified byte identity remain in the result contract; prepared
method bytes include the complete code for wallet review. This adds no stored
artifact, service, provider credential or recurring download. Ordinary inline
requests keep their existing 16 KiB simulation and general request limits.
The native page provides the URL, checksum and byte-count fields for these code
operations, with no automatic artifact or state request.

The same `code_artifact` supports EVM deployment bytecode through
`EthereumRuntimeRPCApi.create` simulation and native `EVM.create`/`create2`
preparation. Leave the metadata-declared `data` (simulation) or `init`
(preparation) byte vector as `"0x"`. The verified artifact replaces only that
argument, preserving constructor bytes, value, fee, nonce, access/authorization
lists and CREATE2 salt. The runtime's declared code argument must be a byte
vector; ordinary calls and precompile assistance cannot use this deployment
reference.

EVM simulation admits the exact positive gas limit before fetching an artifact,
then retains the existing per-request aggregate gas and native input/output
budgets. Its actual execution result and creation address remain in the native
value. EVM code follows the same 128 KiB artifact transport maximum and bounded
fetch; the selected runtime retains its own code-size and creation-permission
rules. Wasm continues to enforce its source `MaxCodeLen`. Prepared creation
bytes remain unsigned and pass through the same explicit wallet source/account
review; an artifact reference neither deploys code nor submits a transaction.
The website exposes the artifact fields on both creation paths. Remote
compiled-metadata fixtures compare complete deployment bytes across the release
catalogue; they do not establish that a synthetic bytecode fixture executes.

The pinned node's [state RPC](https://github.com/RaoFoundation/polkadot-sdk/blob/cacb4310f20c7cac83eb3ccd8ed5a5ad4212608a/substrate/client/rpc/src/state/state_full.rs)
invokes its [call executor](https://github.com/RaoFoundation/polkadot-sdk/blob/cacb4310f20c7cac83eb3ccd8ed5a5ad4212608a/substrate/client/service/src/client/call_executor.rs)
with a fresh overlay, returning the execution result without committing that
overlay. Simulation does not publish code, create a persistent contract or
submit a transaction. Independent SCALE fixtures qualify the API encoding and
results; they do not execute Wasm or measure deployed-chain behavior.

A separate [remote engine qualification](https://github.com/JSONbored/metagraphed/actions/runs/37031194950)
executed the published v471 runtime Wasm, SHA-256
`04385dd7ddda37d4f70cd59a0e8360227165a4aefead0203c47adea5fc4b4aeb`,
through the public native request encoder and result decoder. Fixture state
produced an EVM return word of 42, a preserved revert and a typed timestamp
precompile result; duplicate calls shared one execution. A valid 107-byte Wasm
contract passed code upload and constructor execution, preserving its declared
return flags and empty return bytes. The harness implemented bounded storage
and balanced transactions, discarded execution overlays and rejected unknown
host calls. It used the pinned SDK's proof-recording-disabled convention;
it does not qualify trie proofs or production gas costs. These five cases
establish compiled-engine fixture execution, with zero chain requests. They
do not measure a deployed node, retained history or live latency.

`prepare` encodes a native method from its declared
argument types, including runtime-specific enum and composite arguments. It
returns method bytes and signed-extension types for explicit wallet review;
these are distinct from a signed extrinsic. The native page can review any
prepared call through a connected wallet, showing its decoded arguments, exact
amounts, current fee estimate, spendable balance and pending nonce. An explicit
sign-and-submit action sends it directly through the selected network's official
endpoint. Mainnet and testnet have separate connections.

Before the wallet prompt, and again when the signature returns, the flow checks
the account, network, API origin, canonical finalized source, runtime code and
transaction version, method bytes, nonce and fee estimate. Frozen funds are
excluded from spendable balance, including the older fee/misc-freeze layouts.
Native signatures use a mortal era and the reviewed nonce. Transaction and block
hashes, chain dispatch failures and finalization status remain visible. No
server-side signature or submission occurs; a fee estimate does not guarantee
execution or cap the fee ultimately charged by the chain.

Raw byte vectors and fixed byte arrays use the value-byte budget rather than
the recursive collection budget. Full EVM account code and the v470 runtime's
128 KiB `Contracts.PristineCode` remain hex and can be read within the existing
262,144-byte value and 524,288-byte response limits. SCALE length prefixes count
toward the value limit. Numeric arrays, nested collections, and execution code
uploads keep their existing item and simulation budgets.

## Finality, bounds and reuse

Every operation shares one finalized block, genesis hash, runtime and metadata
fingerprint. Historical `as_of` requests must be canonical finalized ancestors.
They read the state supplied by the archive endpoint; a read does not create a
retained historical record.

A request contains at most 16 operations. Map pages contain at most 32 records,
with at most 64 requested records across all pages in a request. RPC batches,
metadata, value decoding, recursion, request bytes and response bytes are bounded.
Repeated reads are coalesced while results retain the requested order.

Warm isolates retain at most two compact metadata contracts. Each use verifies
the runtime code hash at the requested block. Genesis, code hash, spec version
and transaction version bind the cache identity. State values and account
arguments are never cached there. A cached V14 fallback is renegotiated when a
typed runtime call or API-specific discovery needs signatures; a continued
provider failure reuses the validated fallback without another V14 fetch or
decode. Ordinary storage and preparation requests still reuse V14 without that
retry. Missing code-hash RPC support performs a full metadata read; oversized
projections remain readable without being retained.

The V15 loader reads the negotiated metadata payload through a bounded byte
view. It avoids copying that payload into hex and decoding the same hex again,
while retaining canonical SCALE lengths, wrapper and payload limits, complete
consumption checks and the same contract checksum.

Frame metadata V14 and V15 are parsed and reference-tested. V15 advertises read
API signatures; V14 storage, constants and call preparation use its portable
types. The separate Root basket readers use verified historical API layouts for
their supported runtime eras rather than inferring those signatures from V14.

The representative v470 fixtures are derived from the
[official runtime API declarations](https://github.com/RaoFoundation/subtensor/blob/923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d/pallets/subtensor/runtime-api/src/lib.rs),
[storage declarations](https://github.com/RaoFoundation/subtensor/blob/923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d/pallets/subtensor/src/lib.rs),
and [hyperparameter definitions](https://github.com/RaoFoundation/subtensor/blob/923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d/pallets/subtensor/src/rpc_info/subnet_info.rs).
They are source-based fixtures, not observations of the deployed network.

## Runtime reads when metadata omits signatures

V14 metadata contains portable pallet types but no runtime API method signatures.
`runtime_scale` provides actual reads in that case. The caller supplies the exact
SCALE argument bytes for the source runtime's ABI. The service admits only the
named read methods audited against the pinned v470 runtime implementation and
requires that `RuntimeVersion.apis` advertise that API. It returns the exact result
hex plus `runtime_api_id` and `runtime_api_version` in the result contract. The
request uses the same finalized source, canonical ancestor checks, network
isolation, work/byte bounds and duplicate coalescing as typed reads.

For example, an `AccountNonceApi.account_nonce` read supplies the AccountId32's
32 raw bytes as `input`, not JSON arguments. The response's API version and runtime
source identify the ABI the caller must use to decode the result. Where metadata
contains a signature, prefer the typed `runtime` operation. A SCALE result is
explicitly byte-oriented: the server does not invent missing portable types or
claim it has decoded that older ABI.

For the published spec 205, 210, 211, 212, 216, 217, 218 and 219 runtimes,
delegate, neuron, subnet and stake read APIs wrap their records in `Vec<u8>`.
Set `decode_inner: true` on `runtime` or `runtime_scale` to read those records
through layouts derived from the exact compiled source and bound to the
published metadata checksum. `inner_result` contains the record;
`contract.inner_scale` carries its scoped portable types and source commit.
The ordinary `value` retains the original bytes. An absent singular record
becomes `null`; vectors and nested SCALE Options retain their declared shapes.
Decoding adds no chain request. Omitted or disabled decoding preserves the
ordinary result. Later runtimes expose these structures through their normal
portable API result types and do not need this option. EVM account code remains
bytecode, rather than a record interpreted through these layouts.

The native page can inspect an explicitly supplied canonical finalized block
hash, select nested record decoding for these legacy reads, and display both
decoded fields and original bytes. Changing the source clears the previous
contract and record selection. Malformed hashes issue no request.

Repeated native results share their SCALE decoding within one request, keyed
by the upstream call and wire type. Nested records also share their selected
source decoding. Public result objects remain independent after canonical
response validation. Storage defaults retain their declaration-specific
fallback bytes; retained state and account values are not cached across requests.

`describe` exposes the audited SCALE methods when an advertised API has no
metadata signatures. The website lets users select the method, enter SCALE hex
and read the exact bytes at the inspected block. EVM `call`/`create`, Wasm
`call`/`instantiate`/`upload_code`, block execution, keystore generation and
submission methods cannot use this path; simulations require typed gas/Weight
admission. An older runtime may advertise an API whose version lacks a newer
method; the node's method error is retained as a failed read, never fabricated
as empty data. Source-derived V14/V15 regression fixtures are not deployed
all-era qualification.

The protocol-state page also reads hotkey conviction and the subnet king from
`StakeInfoRuntimeApi`. It preserves the exact fixed-point result rather than
reconstructing current conviction from elapsed time or a float approximation.

## Compiled release compatibility

Hermetic regression fixtures retain both V14 and V15 metadata from each
published official release tag with a WASM artifact: 65 older releases from
`v1.1.7` through `v3.4.9-424` (compiled specs 205–424), plus these 26 releases
in the v430–v471 range:

`430, 431, 432, 437, 438, 439, 440, 441, 442, 443, 445, 446, 447, 448, 450,
452, 453, 454, 459, 464, 466, 467, 468, 469, 470, 471`.

The published v471 prerelease is qualified from its compiled artifact and
pinned sources. This is fixture qualification and does not assert which
runtime is deployed on either network.

The newer upgrade manifests bind the source commit and compressed WASM
SHA-256. Older releases use the published srtool digest, pinned by its own
SHA-256 together with the exact WASM checksum, length and compiled build
commit. Metadata extraction checks that identity and the compiled Core runtime
version. Five older tag commits differ from the published build commits:
`v2.0.0`, `v2.0.4`, `v3.2.1`, `v3.2.15-347` and `v3.4.1-413`. Both identities
are retained; a tag name is never substituted for the actual compiled source.
The fixtures record separate V14/V15 metadata hashes for all 91 releases. There
are no invented releases for missing version numbers. The extraction runs on
remote CI with allocation/log-level host functions only; the final tests use
compact local fixtures without network downloads.

The compatibility suite checks native call preparation through the public
contract against an independent reference registry, for both metadata formats.
It also checks constants, exact older storage keys and leading-key prefixes,
audited typed reads, runtime-specific EVM/Wasm simulation ABI and the V14
SCALE read fallback. Full code artifacts exercise upload/instantiation paths
across v430–v471, with both preparation formats and each source MaxCodeLen. Two Grandpa proof calls use an uninhabited runtime type;
fabricated proof values must be rejected. These are compiled ABI tests with
synthetic arguments and transport results. They do not establish successful
chain execution, deployed historical state availability or retained capture
coverage. The portable metadata contract derives features from the selected
source. Version numbers without published WASM artifacts are not invented or
counted as independently compiled qualification.

Cold metadata parsing traverses discarded documentation, type parameters and
custom records without building unused arrays. Collection and text limits,
canonical SCALE lengths and UTF-8 validation remain active; retained projection
bytes match the previous array-producing traversal across all 182 contracts.
The v470 fixture removes 7,290 arrays and 6,440 element slots. Warm contract
reuse remains bound to code identity and its existing two-contract byte cap.

Single-byte reads use the bounded byte directly rather than creating a one-byte
view and converting through BigInt. Each reader lazily reuses one fatal UTF-8
decoder for its independent SCALE strings. Non-streaming decode resets its state
for every string, preserving initial BOMs and rejection of malformed or truncated
UTF-8, including after a preceding decode error. Decoder state is not shared
between requests/readers.

## Neuron UID pages without a bulk result

The website's **Neuron records** form reads a bounded range of singular records
through the existing native contract. It first reads `SubtensorModule.SubnetworkN`,
then sends up to sixteen `NeuronInfoRuntimeApi.get_neuron` operations at that
response's finalized block. **Lite records** selects `get_neuron_lite` explicitly.
The count and records retain their network, genesis, block, runtime and code
identity; continuation uses the last successful subnet, format and page size even
if the form is subsequently edited. Empty/completed ranges make no record request.

REST and MCP use the same operations. First request the count:

```json
{
  "operations": [
    { "kind": "storage", "pallet": "SubtensorModule", "member": "SubnetworkN", "args": [19] }
  ]
}
```

Use its `source.finalized_block_hash` as `as_of` for the selected singular reads:

```json
{
  "as_of": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "operations": [
    { "kind": "runtime", "api": "NeuronInfoRuntimeApi", "member": "get_neuron", "args": [19, 0] },
    { "kind": "runtime", "api": "NeuronInfoRuntimeApi", "member": "get_neuron", "args": [19, 1] }
  ]
}
```

The displayed hash is a fixture placeholder; continuation must use the actual
count response. Stop before its UID count and keep that source for later batches.
Each result retains its source-defined Option and complete fields, including
weights and bonds for full records. A missing UID remains `None`; later requested
UIDs are still returned. This is an explicit UID range, not a synthesized substitute
for the upstream `get_neurons` vector: the pinned v470 implementation stops that
vector at the first missing neuron. Do not report a UID count as the vector length.

For the eight source-qualified opaque eras (compiled specs 205, 210, 211, 212,
216, 217, 218 and 219), the form uses `runtime_scale` singular reads with
`decode_inner: true`. Arguments are the source's little-endian `u16` netuid and UID;
the native server still requires the exact compiled metadata/catalogue binding.
For netuid 19 and UID 256, the input is `0x13000001`. Exact outer bytes and decoded
records/confirmed absence remain available together.

Singular reads avoid downloading and parsing an oversized full collection. The
existing sixteen-operation, per-value byte, work and final-response budgets remain
in force. An individual record that exceeds a budget still fails explicitly; UID
pagination does not make an unbounded single record safe.

## Explicit collection pages

A typed `storage`, `constant` or `runtime` read accepts `value_page`:

```json
{
  "kind": "runtime",
  "api": "NeuronInfoRuntimeApi",
  "member": "get_neurons",
  "args": [19],
  "value_page": { "path": [], "offset": 0, "limit": 16 }
}
```

The root path `[]` selects the returned vector. Named fields, positional tuple/array
indices and enum variant names select nested collections: `[0,"weights"]` selects
the first neuron's weights. Transparent single-field newtypes add no path segment.
The selected collection alone becomes `value`. `value_page` reports its source
collection/element type ids, total, offset, limit and next offset. Raw byte collections
remain hex. Empty collections return an empty value and terminal continuation;
an absent variant or element path is an error, rather than fabricated empty data.

Continue with the identical operation/path and the response's finalized source hash
as `as_of`. A nonzero offset requires that source. The website exposes these controls
and continues the saved request even if the argument form is subsequently edited.
Identical and distinct pages share one upstream execution within a request, while
identical page decoding is memoized and public results remain independent objects.

With `decode_inner`, source-qualified legacy `runtime` and `runtime_scale` methods
also accept the option. The page is returned as `inner_result`; original outer bytes
are omitted only for this explicit projection, and remain available by omitting the
page option. Unqualified caller-encoded output cannot silently acquire a guessed
layout. EVM precompile interpretation retains its complete result and does not combine
with collection projection.

The full upstream value is validated, including omitted booleans, Unicode, enum
variants, compact integers and trailing bytes. Fixed-width integer/byte spans skip
in bulk without allocating their values. Wire bytes, per-collection count, text,
depth, retained item and final response limits stay unchanged. Explicit pages have a
separate bounded validation traversal to handle omitted nested records without
retaining them; adversarial zero-width wrappers cannot create unbounded work.
A request retains at most 64 selected collection/storage entries across its operations.
Default full reads retain their original representations, bounds and errors.
