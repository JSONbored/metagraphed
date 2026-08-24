/**
 * The glossary behind every `<Definition term="…">` (#11606): one sentence
 * per term, the sentence a reader gets from the 16×16 "?" beside the term.
 * `definitions.test.ts` asserts every term used in TSX is defined here, so a
 * typo in a `term` prop fails the suite instead of rendering nothing.
 *
 * Keep each entry to one sentence, in plain words, ending with a full stop.
 */
export const DEFINITIONS = {
  // ── Summary-card labels (#11698) ──────────────────────────────────────────
  //
  // `FactCell` looks its label up here, so a term listed below grows a "?" on
  // every card that uses it, on every route, at once. Only the terms a reader
  // would actually stop at: a "?" beside "Providers" is noise, and noise is
  // what makes a help affordance get ignored where it matters.
  Nakamoto:
    "The fewest block authors who could halt the chain between them; higher is more decentralised.",
  "Head block": "The most recent block this indexer has seen.",
  "Block time": "How long the chain took between blocks over the window, at the median.",
  "Block time p50": "The median gap between blocks over the window; half were faster.",
  "Extrinsics per block": "How many signed calls the average block in this window carried.",
  Signers: "Distinct accounts that signed at least one extrinsic in the window.",
  "Top module": "The runtime pallet that submitted the most calls on this page.",
  "Most frequent": "The event kind the runtime emitted most often in the window.",
  "Stake listed": "Total stake held by the accounts on this page, not by the whole network.",
  "Top 10 share": "What the ten largest holders on this page hold, as a share of the listed total.",
  "Median take": "The middle validator's take; half of them keep more, half keep less.",
  "Median APY": "The middle validator's estimated annual yield; an estimate, not a promise.",
  "Est. APY": "Yield projected from recent rewards; it moves with emission and with stake.",
  Memberships: "Subnets this operator validates on; one hotkey can hold several.",
  "Memberships / permits":
    "Subnets this operator validates on, and how many of those carry a permit.",
  "Positions / subnets":
    "Live stake positions this account holds, and how many subnets they sit in.",
  "Net flow": "Stake in minus stake out over the window; negative means the account is exiting.",
  "Permit floor": "The stake a hotkey needs right now to hold a validator permit here.",
  "Earning floor": "The stake a miner needs right now to earn anything on this subnet.",
  Slots: "UIDs in use against the subnet's cap; a full subnet deregisters to admit anyone new.",
  "Miners earning nothing":
    "The share of registered miners this subnet paid zero to over the window.",
  "Miners / Validators": "Registered neurons split by role; only permit-holders set weights.",
  Tempo: "Blocks between weight-setting rounds on this subnet.",
  "Pool liquidity": "TAO sitting in the subnet's alpha pool, backing its price.",
  "Chain buys": "Emission the chain itself spent buying alpha, rather than paying it out.",
  Paid: "Subnets the chain actually paid this block, against the number registered.",
  "Probed surfaces": "Surfaces the prober watches; the rest are catalogued but unmeasured.",
  "RPC pools": "Managed endpoint pools a client can be routed to instead of one host.",
  "Degraded now": "Endpoints answering slowly or partially at the last probe, but still answering.",
  "Open incidents": "Probe failures the prober has not yet seen recover.",
  Healthy: "The share of PROBED surfaces that answered, not of the whole catalogue.",
  "Official or claimed":
    "Providers whose identity the registry has verified or the operator has claimed.",
  "Sources resolving": "Providers whose published source URL still answers.",
  "Adapter-backed": "Subnets with a typed adapter, the top rung of the curation ladder.",
  "Avg freshness": "How old the registry's data is on average across every tracked surface.",
  Moved: "Schemas whose contract changed between the last two captures.",
  "Not captured": "Surfaces that advertise a schema the registry could not fetch.",
  "Subnets with gaps": "Subnets missing at least one surface kind the registry expects.",
  Candidates: "Discovered surfaces queued for a human to accept or reject.",
  "Average completeness":
    "How much of the expected surface set the registry has found, across all subnets.",
  "Callable services": "Subnet surfaces an agent can call directly through this registry.",
  "Metagraphed itself":
    "Whether this site and its API are up, measured the same way it measures others.",

  "Emission share": "The fraction of each block's TAO emission the chain directs to this subnet.",
  "Alpha price": "What one unit of this subnet's alpha token costs in TAO on its own pool.",
  "Total stake": "All TAO and alpha staked to this subnet's validators, valued in TAO.",
  "Validator take": "The share of rewards a validator keeps before paying its nominators.",
  Nominators: "Wallets that stake to a validator and receive its rewards minus take.",
  "Validator permit":
    "A hotkey's right to set weights on a subnet; only the top-staked neurons hold one.",
  "Immunity period": "Blocks after registration during which a neuron cannot be deregistered.",
  "Registration cost":
    "TAO burned to register a neuron on this subnet right now; it moves with demand.",
  Health: "Whether the surface answered a probe recently and how fast; probe-derived only.",
  Freshness: "How long ago the data behind this value was last captured.",
  Coverage: "How much of the subnet's public surface the registry has found and verified.",
  Readiness: "How integration-ready a subnet is: documented, schema'd, healthy, callable.",
  Curation: "How far a subnet's registry entry has been reviewed beyond what machines found.",
  Concentration: "How much of a subnet's stake sits with its few largest holders.",
  Turnover: "How often neurons on this subnet are replaced by new registrations.",
  Yield: "Rewards earned per unit staked over the window, annualised.",
  Conviction: "Stake that has stayed put across the window rather than moving between subnets.",
  Burn: "TAO removed from circulation by registrations and recycling.",
  Recycled: "Emission that was not earned and went back to the pool.",
  "Owner cut": "The share of a subnet's emission its owner keeps.",
  Trust: "How much validators agree on this neuron's weights.",
  Incentive: "The share of a subnet's miner emission this neuron earned last epoch.",
  Dividends: "The share of a subnet's validator emission this neuron earned last epoch.",
  Consensus: "The stake-weighted agreement of validators on a miner's value.",
  "Stake flow": "Net TAO staked minus unstaked on this subnet over the window.",
  "Idle stake": "Stake on a hotkey that is not currently validating or mining.",
  "Deregistration risk":
    "How close a neuron is to being pruned: low incentive, out of immunity, near the floor.",
  "Archive node": "A node that keeps full historical chain state, not only recent blocks.",
  Extrinsic: "A signed transaction or inherent included in a block.",
  "Source URL": "The public page that proves the subnet itself publishes this surface.",
  Surface: "Anything a subnet exposes publicly: an API, docs, a schema, a repo, a dashboard.",
  Provider: "The team or operator that runs a surface.",
  "Alpha reserve ratio":
    "Alpha in the pool divided by alpha in plus alpha out, from the latest on-chain AMM reserves snapshot.",
  "Endpoint kinds": "Verified public endpoints for this subnet, counted by kind.",
  "Provider ranking":
    "Providers ranked by how many verified surfaces they operate for this subnet; unverified candidates are not counted.",
  "Diff provenance":
    "Where the snapshot diff was derived from; open or copy these to verify the change against the source.",
  "Snapshot summary":
    "Derived from the published schema record; line-level diffs need snapshot history the registry does not keep.",
  "Probe mosaic":
    "One cell per tracked endpoint, coloured by its last probe: ok within budget, warn when slow or intermittent, down when failing.",
  "Pallet breakdown":
    "The ten most frequent pallet.method calls in this block's event stream; a longer bar means that call dominated the block.",
  "Block cadence": "Seconds between consecutive blocks; Subtensor targets about twelve.",
  "Block header":
    "Raw header fields from the block API: runtime version, storage roots and any annotations the backend attached.",
  "Block authors":
    "Validators that produced the most blocks in this page window; click a row to filter the feed to theirs.",
  "Activity heatmap":
    "Daily probe samples and recorded incidents, not commits; this drives the registry's freshness signal.",
  "Cadence heatmap":
    "Seconds between consecutive blocks on this page: deeper mint is faster, amber is slow, red is a stalled slot.",
  "Drift classification":
    "A heuristic on drift_status: breaking if it says break, incompatible or major; additive if add, minor, patch or compatible.",
  "Status mosaic":
    "One tile per monitored endpoint, coloured by its latest probe state; click a tile to open its subnet.",
  "Uptime timeline":
    "Each surface's uptime over the window, worst first; the bar fills to the uptime and the dashed mark is the 95% line.",
  "Coverage matrix":
    "Profile completeness joined with the subnet list; each cell shows whether a required interface kind is present, missing or unverified.",
  "Completeness histogram":
    "Subnets bucketed by completeness score from 0 to 100; the rightmost bin is the fully complete set.",
  "Kind coverage": "The share of subnets with at least one surface of each kind, registry-wide.",
  "Network pulse":
    "Sample-weighted daily uptime from health trends for 7d and 30d; 1h and 24h fall back to the latest probe ratio.",
  "Coverage funnel":
    "Each step's bar is scaled to the largest step; the percentage is conversion from the previous step.",
  "Incidents timeline":
    "Incidents placed by start time and sized by duration, coloured by severity; click a row to open it.",
} as const satisfies Record<string, string>;

export type DefinitionTerm = keyof typeof DEFINITIONS;
