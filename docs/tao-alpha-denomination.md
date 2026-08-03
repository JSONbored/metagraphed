# `*_tao` fields: which hold TAO, which hold alpha, and why

Issue #8945's inventory deliverable, resolved 2026-08-03.

A non-root neuron's stake is **that subnet's alpha token, not TAO** (#2550,
`src/metagraph-neurons.ts`). Any field named `*_tao` that carries such a value
is publishing alpha under a TAO name, and any sum of them across subnets is a
cross-subnet alpha count with no dimensional meaning.

#8945 was written when that was true of roughly 25 fields. Two later changes
fixed most of them, so **this inventory is the post-fix state, verified field by
field against the tree** — not the issue's original list:

- **#8803** renamed the two fields it named (`/accounts/{ss58}/positions`'s
  `total_stake_alpha`, `/chain/yield`'s `total_stake_alpha` /
  `total_emission_alpha`) and fixed `/accounts/top-holders`, which had summed
  alpha into genuine `System::Account` TAO and reported the top account holding
  71% of a 21M-capped supply.
- **#9051** _converted_ the cross-subnet totals instead of renaming them: they
  now price each membership through its own subnet's `alpha_price_tao` before
  summing, so the `*_tao` name became correct rather than misleading.

## Classification

### Convert — done (#9051). The name is now accurate.

These are genuine TAO because each leg is priced before summing. No action.

| Field                                   | Route(s)                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `total_stake_tao`, `total_emission_tao` | `/validators/{hotkey}`, `/validators`, `/accounts`, `/accounts/{ss58}/portfolio`, `/validators/{hotkey}/history`, `compare-validators` |
| `root_stake_tao`, `alpha_stake_tao`     | `/validators/{hotkey}`, `/validators` — the two legs of the priced total, which sum to it exactly                                      |
| `total_stake_tao`                       | `/domains` — priced through each member subnet's alpha price                                                                           |

### Rename — done (#8803). The name says alpha because the value is alpha.

| Field                                       | Route                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `total_stake_alpha`                         | `/accounts/{ss58}/positions`                                                                                                                                   |
| `total_stake_alpha`, `total_emission_alpha` | `/chain/yield` — the yield denominators; converting these alone would have broken three published ratios, which is why they were renamed rather than converted |

### Genuine TAO all along. No action.

`total_staked_tao` / `total_unstaked_tao` / `net_flow_tao` / `gross_flow_tao`
(`/chain/stake-flow`, `/subnets/{netuid}/stake-flow`,
`/accounts/{ss58}/stake-flow`, `/validators/{hotkey}/nominators`) sum
`account_events.total_tao` — the **TAO leg** of each executed StakeAdded /
StakeRemoved trade, not the alpha received. `stake_threshold_tao`,
`block_emission_tao` (`/network`, `/chain/emission-pipeline`) are chain-level
TAO quantities.

### Leave — and say so. This PR's change.

Per-row fields that carry the on-chain column name verbatim **and sit next to
the `netuid` that denominates them**. Renaming these would break every consumer
for no gain in truth: the reader already has the netuid in the same object, and
the on-chain name is what the chain calls it. What was missing was the
statement, which is now in each field's description.

| Field                                                                    | Schema file                   |
| ------------------------------------------------------------------------ | ----------------------------- |
| `stake_tao`, `emission_tao` (per-subnet row)                             | `routes/accounts-list.ts`     |
| `stake_tao`, `emission_tao` (per-subnet row)                             | `routes/subnet-yield.ts`      |
| `stake_tao`, `emission_tao` (per-neuron row)                             | `routes/subnet-metagraph.ts`  |
| `stake_tao` (position row), `stake_tao` / `emission_tao` (history point) | `routes/account-positions.ts` |
| `stake_tao`, `emission_tao` (membership row)                             | `routes/account-portfolio.ts` |

The rule each description now states: **alpha for non-root subnets, genuine TAO
for netuid 0, comparable within a subnet, never summable across subnets** — and
that the cross-subnet totals which _are_ safe to read as TAO get there by
pricing through `alpha_price_tao` first.

## The invariant that must not break

`scripts/lib/economics-artifacts.ts`'s
`computeAlphaMarketCapTao(alphaPriceTao, totalStakeTao) => alphaPriceTao *
totalStakeTao` is dimensionally valid **only because its `totalStakeTao` input
is alpha**. It reads the economics artifact's own per-subnet total, which is a
single subnet's alpha count — not any of the converted cross-subnet totals
above. Anything that later "fixes" that input to a priced TAO value must also
drop the multiplication, or the market cap becomes price² × alpha.
