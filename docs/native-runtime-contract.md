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

The pinned node's [state RPC](https://github.com/RaoFoundation/polkadot-sdk/blob/cacb4310f20c7cac83eb3ccd8ed5a5ad4212608a/substrate/client/rpc/src/state/state_full.rs)
invokes its [call executor](https://github.com/RaoFoundation/polkadot-sdk/blob/cacb4310f20c7cac83eb3ccd8ed5a5ad4212608a/substrate/client/service/src/client/call_executor.rs)
with a fresh overlay, returning the execution result without committing that
overlay. Simulation does not publish code, create a persistent contract or
submit a transaction. Independent SCALE fixtures qualify the API encoding and
results; they do not execute Wasm or measure deployed-chain behavior.

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
arguments are never cached there. Missing code-hash RPC support performs a full
metadata read; oversized projections remain readable without being retained.

Frame metadata V14 and V15 are parsed and reference-tested. V15 advertises read
API signatures; V14 storage, constants and call preparation use its portable
types. The separate Root basket readers use verified historical API layouts for
their supported runtime eras rather than inferring those signatures from V14.

The representative v470 fixtures are derived from the
[official runtime API declarations](https://github.com/RaoFoundation/subtensor/blob/923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d/runtime-api/src/lib.rs),
[storage declarations](https://github.com/RaoFoundation/subtensor/blob/923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d/pallets/subtensor/src/lib.rs),
and [hyperparameter definitions](https://github.com/RaoFoundation/subtensor/blob/923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d/pallets/subtensor/src/rpc_info/subnet_info.rs).
They are source-based fixtures, not observations of the deployed network.
