/**
 * The glossary behind every `<Definition term="…">` (#11606): one sentence
 * per term, the sentence a reader gets from the 16×16 "?" beside the term.
 * `definitions.test.ts` asserts every term used in TSX is defined here, so a
 * typo in a `term` prop fails the suite instead of rendering nothing.
 *
 * Keep each entry to one sentence, in plain words, ending with a full stop.
 */
export const DEFINITIONS = {
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
