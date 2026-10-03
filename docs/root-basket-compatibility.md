# Native Root basket compatibility

One public response vocabulary is shared by REST, MCP and the website. The
runtime adapter is selected at the response's finalized block, rather than
assuming today's methods or byte layout existed at an older block.

The source includes the network/genesis, finalized block hash and height,
runtime spec/API versions, exact decoder identity, metadata digest and declared
capabilities. Only the official release identities below are admitted. An
integer between release tags is not automatically supported. Release dates are
not evidence of when a runtime was deployed.

| Runtime | Basket API | Audited source                                                                                       |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| v441    | 1          | [8b9d55c7](https://github.com/RaoFoundation/subtensor/tree/8b9d55c723e00d0d713eed799de627e94603dfd4) |
| v442    | 1          | [ec112cb0](https://github.com/RaoFoundation/subtensor/tree/ec112cb0e68469fa1c5e5ae67dece043033f6673) |
| v443    | 1          | [c02a376e](https://github.com/RaoFoundation/subtensor/tree/c02a376ecee28718970962562fece409b695df72) |
| v445    | 1          | [d3f40e44](https://github.com/RaoFoundation/subtensor/tree/d3f40e44bda9019c606aeb0c907bb52ba7fe386c) |
| v446    | 1          | [52d7e7cf](https://github.com/RaoFoundation/subtensor/tree/52d7e7cf66c6fdcc76f62fd4b00732aa506afb2c) |
| v447    | 1          | [1f090af8](https://github.com/RaoFoundation/subtensor/tree/1f090af85d1771c5d8ece1f0910576fbd129906e) |
| v448    | 1          | [e18ca67f](https://github.com/RaoFoundation/subtensor/tree/e18ca67f1a00b35c7d5986888d1cc388da8c095f) |
| v450    | 3          | [9540b3af](https://github.com/RaoFoundation/subtensor/tree/9540b3af59179b88af99f8e0d03add5d96512e3f) |
| v452    | 3          | [da06f033](https://github.com/RaoFoundation/subtensor/tree/da06f033663896ef2fdbbfc3ecc68ca908fba0f5) |
| v453    | 3          | [823bdcbc](https://github.com/RaoFoundation/subtensor/tree/823bdcbc58a29f60b243be4737a7c72b34ac7d93) |
| v454    | 3          | [14cde641](https://github.com/RaoFoundation/subtensor/tree/14cde6410fe8ec81a940e290c56f94a632a0988d) |
| v459    | 3          | [70378404](https://github.com/RaoFoundation/subtensor/tree/70378404b56c12a85bc8cd163aca2f32cf4d1b80) |
| v464    | 4          | [5cd66b85](https://github.com/RaoFoundation/subtensor/tree/5cd66b8597b3ce5f9f2bade2b11c91af57df923d) |
| v466    | 4          | [cdffbe2f](https://github.com/RaoFoundation/subtensor/tree/cdffbe2f7ab0c37ab07884387bfbd6443dca178d) |
| v467    | 4          | [c6bcb4a7](https://github.com/RaoFoundation/subtensor/tree/c6bcb4a7400764c94c1d1b1938514c6c2dd3d33b) |
| v468    | 5          | [30c70d90](https://github.com/RaoFoundation/subtensor/tree/30c70d90f8a3708d85cf95ae992b7a3fe30d2c4c) |
| v469    | 5          | [370bac46](https://github.com/RaoFoundation/subtensor/tree/370bac46fa8cf602c4f8283a0635b3a8b4675394) |
| v470    | 5          | [923fd1fa](https://github.com/RaoFoundation/subtensor/tree/923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d) |

## API generations

| Generation | Public data                                                                                                         | Intentionally absent operations                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| API 1      | Bounded legacy directory, fund holdings, exact stored u16 target weights, owed-share entitlements and marked payout | Display pricing, beta position display units, beta baselines/indexes, trading status, dust-aware claim previews |
| API 3      | Paginated pricing, exact display beta positions, baselines/indexes, holdings and stored target weights              | Trading status and dust-aware claim previews                                                                    |
| API 4      | Pricing, positions, baselines/indexes, holdings and trading status                                                  | Target weights have been removed; dust-aware claim previews are absent                                          |
| API 5      | Pricing, positions, baselines/indexes, holdings, trading status and dust-aware claim previews                       | Target weights have been removed                                                                                |

API 1 uses `data.kind: legacy-directory` with `summaries`, so an absent pricing
method cannot masquerade as an empty pricing page. Fund pricing/baseline/trading
fields are null when their method is not published. API 1 account entries retain
`entitlement` separately from display `position` and dust-aware `claim`.
`source.capabilities` distinguishes those cases from confirmed absence.

Marked payout and realizable NAV are valuation reads. They are not execution
quotes and are not substituted into a dust-aware claim preview.

The older summary SCALE layout places the weight vector before the holdings.
The API-4/5 layout removes that vector. The adapter selects the exact decoder
instead of reading an old weight vector as holdings or discarding it.

Both directory forms resume with `next_after` and the same `as_of` finalized
hash. API 1 has no upstream pagination: its one summary result is bounded by
the existing byte/fund limits, checked for duplicate identities, ordered by
AccountId32 and sliced locally. An oversized response declines rather than
silently publishing a partial directory.

Account pages retain every pinned StakingHotkeys relationship. API 1's complete
entitlement result is bounded and checked against those relationships before
paging. API-3/4 pages request only positions; API-5 pages batch positions and
previews. Empty relationship pages do no runtime-call work.

## Qualification and limits

`tests/root-basket-compatibility.test.ts` exercises all 18 release identities,
all three public views, capability/schema pairing, old weight offsets,
entitlement meaning, pinned calls, pagination, duplicate/foreign identities,
absent methods, malformed/oversized SCALE and observation compatibility.
Browser regressions cover the API-1 and API-3 website states. Fixtures are
synthetic encodings of the pinned Rust layouts, not production observations.

The legacy pre-v441 claim contract remains separate: baskets did not exist
there. This adapter does not expand that adapter's v440 qualification or claim
that every earlier runtime layout is supported.

A successful historical `as_of` read needs the source node to retain that
finalized state. It does not prove a local snapshot was captured or stored.
The historical internal receiver remains its separately qualified v454
contract. Modern observations do not silently enter that receiver. This change
activates no collector, scheduler, publication or deployment.

This is Root-basket compatibility. Complete Subtensor, transaction and subnet
API coverage is a broader audit with separate acceptance criteria; this module
does not assert that coverage.
