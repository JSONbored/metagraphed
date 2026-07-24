import { GraphQLResolveInfo, GraphQLScalarType, GraphQLScalarTypeConfig } from 'graphql';
import { GqlContext } from '../../src/graphql.ts';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type RequireFields<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  /** Opaque JSON value, for dynamic-keyed maps with no fixed field set (e.g. the incident summary's by_kind/by_provider/by_status count maps) -- matching how the MCP mirror serves them. */
  JSON: { input: unknown; output: unknown; }
};

/** Signing-activity aggregate from the extrinsics tier, matched by signer only -- an account queried by a key that did not sign returns tx_count 0, other fields null/empty. */
export type AccountActivity = {
  __typename?: 'AccountActivity';
  last_tx_at?: Maybe<Scalars['String']['output']>;
  last_tx_block?: Maybe<Scalars['Int']['output']>;
  modules_called: Array<AccountModuleCall>;
  total_fee_tao?: Maybe<Scalars['Float']['output']>;
  tx_count: Scalars['Int']['output'];
};

/** One subnet's slice of an account's axon-removal footprint over the window. */
export type AccountAxonRemovalSubnet = {
  __typename?: 'AccountAxonRemovalSubnet';
  first_removed_at?: Maybe<Scalars['String']['output']>;
  last_removed_at?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
  removals: Scalars['Int']['output'];
};

export type AccountAxonRemovals = {
  __typename?: 'AccountAxonRemovals';
  address: Scalars['String']['output'];
  concentration?: Maybe<Scalars['Float']['output']>;
  dominant_netuid?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<AccountAxonRemovalSubnet>;
  total_removals: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** Live free+reserved balance in TAO for one Finney ss58 account, read directly from chain via RPC (KV-cached). balance_tao is null on RPC failure (schema-stable, never a GraphQL error). Mirrors GET /api/v1/accounts/{ss58}/balance. */
export type AccountBalance = {
  __typename?: 'AccountBalance';
  balance_tao?: Maybe<Scalars['Float']['output']>;
  queried_at: Scalars['String']['output'];
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
};

/** One child hotkey's delegated-stake proportion on a subnet. proportion is the raw stringified u64 (0..u64::MAX represents 0..100%); proportion_fraction is the same value pre-divided to a 0..1 float. */
export type AccountChildEntry = {
  __typename?: 'AccountChildEntry';
  child: Scalars['String']['output'];
  proportion: Scalars['String']['output'];
  proportion_fraction: Scalars['Float']['output'];
};

/** One subnet's child-hotkey delegation entries in an account's live children graph. */
export type AccountChildSubnet = {
  __typename?: 'AccountChildSubnet';
  entries: Array<AccountChildEntry>;
  netuid: Scalars['Int']['output'];
};

/** Live child-hotkey delegation graph (#6723) for one Finney ss58 account, read directly from chain via RPC (KV-cached). subnets is null on RPC failure, distinct from a confirmed-empty [] (schema-stable, never a GraphQL error). Mirrors GET /api/v1/accounts/{ss58}/children. */
export type AccountChildren = {
  __typename?: 'AccountChildren';
  account: Scalars['String']['output'];
  queried_at: Scalars['String']['output'];
  schema_version: Scalars['Int']['output'];
  subnets?: Maybe<Array<AccountChildSubnet>>;
};

export type AccountCounterparties = {
  __typename?: 'AccountCounterparties';
  counterparties: Array<AccountCounterparty>;
  counterparty_count: Scalars['Int']['output'];
  /** Present only in relationship (counterparty) mode; null in list mode. */
  relationship?: Maybe<AccountCounterpartyRelationship>;
  scan_capped: Scalars['Boolean']['output'];
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
  total_received_tao: Scalars['Float']['output'];
  total_sent_tao: Scalars['Float']['output'];
  transfers_scanned: Scalars['Int']['output'];
};

/** One counterparty the account transacts native TAO with, aggregated over the scanned Transfer set. */
export type AccountCounterparty = {
  __typename?: 'AccountCounterparty';
  address: Scalars['String']['output'];
  last_block?: Maybe<Scalars['Int']['output']>;
  net_tao: Scalars['Float']['output'];
  received_tao: Scalars['Float']['output'];
  sent_tao: Scalars['Float']['output'];
  transfer_count: Scalars['Int']['output'];
};

/** Focused fund-flow summary for one account/counterparty relationship, with the bounded transfer evidence; only present when counterparty was supplied. */
export type AccountCounterpartyRelationship = {
  __typename?: 'AccountCounterpartyRelationship';
  counterparty: Scalars['String']['output'];
  /** Oldest block/timestamp are null when the newest-first scan was truncated (scan_capped). */
  first_block?: Maybe<Scalars['Int']['output']>;
  first_seen_at?: Maybe<Scalars['String']['output']>;
  last_block?: Maybe<Scalars['Int']['output']>;
  last_seen_at?: Maybe<Scalars['String']['output']>;
  limit: Scalars['Int']['output'];
  net_tao: Scalars['Float']['output'];
  scan_capped: Scalars['Boolean']['output'];
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
  total_received_tao: Scalars['Float']['output'];
  total_sent_tao: Scalars['Float']['output'];
  transfer_count: Scalars['Int']['output'];
  transfers: Array<AccountCounterpartyTransfer>;
  transfers_scanned: Scalars['Int']['output'];
};

/** One direction-aware transfer between the account and the drilled-into counterparty. */
export type AccountCounterpartyTransfer = {
  __typename?: 'AccountCounterpartyTransfer';
  amount_tao: Scalars['Float']['output'];
  block_number?: Maybe<Scalars['Int']['output']>;
  /** sent (account = from) or received (account = to). */
  direction: Scalars['String']['output'];
  event_index?: Maybe<Scalars['Int']['output']>;
  from?: Maybe<Scalars['String']['output']>;
  netuid?: Maybe<Scalars['Int']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
  to?: Maybe<Scalars['String']['output']>;
};

/** One day's rolled-up activity for an account on one subnet, from the account_events_daily tier. event_kinds is the distinct set of event ids seen that day. */
export type AccountDay = {
  __typename?: 'AccountDay';
  day?: Maybe<Scalars['String']['output']>;
  event_count?: Maybe<Scalars['Int']['output']>;
  event_kinds: Array<Scalars['String']['output']>;
  first_block?: Maybe<Scalars['Int']['output']>;
  last_block?: Maybe<Scalars['Int']['output']>;
  netuid?: Maybe<Scalars['Int']['output']>;
};

/** One subnet's slice of an account's deregistration footprint over the window. */
export type AccountDeregistrationSubnet = {
  __typename?: 'AccountDeregistrationSubnet';
  deregistrations: Scalars['Int']['output'];
  first_deregistered_at?: Maybe<Scalars['String']['output']>;
  last_deregistered_at?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
};

export type AccountDeregistrations = {
  __typename?: 'AccountDeregistrations';
  address: Scalars['String']['output'];
  concentration?: Maybe<Scalars['Float']['output']>;
  dominant_netuid?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<AccountDeregistrationSubnet>;
  total_deregistrations: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One coldkey's community-contributed entity labels plus its subnet-ownership ties (#6740). Mirrors GET /api/v1/accounts/{ss58}/entities. */
export type AccountEntities = {
  __typename?: 'AccountEntities';
  labels: Array<AccountEntityLabel>;
  ownership_tie_count: Scalars['Int']['output'];
  ownership_ties: Array<AccountOwnershipTie>;
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
};

/** A community-contributed entity label for an address (exchange/foundation/operator/other). */
export type AccountEntityLabel = {
  __typename?: 'AccountEntityLabel';
  category?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  source_urls: Array<Scalars['String']['output']>;
};

export type AccountEntry = {
  __typename?: 'AccountEntry';
  coldkey?: Maybe<Scalars['String']['output']>;
  coldkey_count?: Maybe<Scalars['Int']['output']>;
  hotkey: Scalars['String']['output'];
  latest_block_number?: Maybe<Scalars['Int']['output']>;
  latest_captured_at?: Maybe<Scalars['String']['output']>;
  miner_count?: Maybe<Scalars['Int']['output']>;
  stake_dominance?: Maybe<Scalars['Float']['output']>;
  subnet_count?: Maybe<Scalars['Int']['output']>;
  /** Per-subnet stake/emission rows for this account, capped at the top 10 by stake. */
  subnets: Array<AccountSubnet>;
  total_emission_tao?: Maybe<Scalars['Float']['output']>;
  total_stake_tao?: Maybe<Scalars['Float']['output']>;
  uid_count?: Maybe<Scalars['Int']['output']>;
  validator_count?: Maybe<Scalars['Int']['output']>;
};

export type AccountEvent = {
  __typename?: 'AccountEvent';
  alpha_amount?: Maybe<Scalars['Float']['output']>;
  amount_tao?: Maybe<Scalars['Float']['output']>;
  block_number?: Maybe<Scalars['Int']['output']>;
  coldkey?: Maybe<Scalars['String']['output']>;
  event_index?: Maybe<Scalars['Int']['output']>;
  event_kind?: Maybe<Scalars['String']['output']>;
  extrinsic_index?: Maybe<Scalars['Int']['output']>;
  hotkey?: Maybe<Scalars['String']['output']>;
  netuid?: Maybe<Scalars['Int']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
  uid?: Maybe<Scalars['Int']['output']>;
};

export type AccountEventKind = {
  __typename?: 'AccountEventKind';
  count: Scalars['Int']['output'];
  kind: Scalars['String']['output'];
};

/** One account's first-party chain-event feed (matched by the hotkey OR coldkey union, newest first), keyset-paginated. event_count is the page count, not a grand total. Mirrors GET /api/v1/accounts/{ss58}/events' data envelope. Each item is an AccountEvent. */
export type AccountEvents = {
  __typename?: 'AccountEvents';
  event_count: Scalars['Int']['output'];
  events: Array<AccountEvent>;
  limit?: Maybe<Scalars['Int']['output']>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  offset?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
};

/** One account's signed-extrinsic feed (newest first), backing account_extrinsics. Matched by the extrinsic signer only. extrinsic_count is the page count, matching the REST feed convention. Each item is a full Extrinsic (block/index/hash/call/success/fee/tip). */
export type AccountExtrinsics = {
  __typename?: 'AccountExtrinsics';
  extrinsic_count: Scalars['Int']['output'];
  extrinsics: Array<Extrinsic>;
  limit?: Maybe<Scalars['Int']['output']>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  offset?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
};

/** One account's durable per-day activity series (hotkey-keyed, newest day first), keyset-paginated. day_count is the page count, not a grand total. Mirrors GET /api/v1/accounts/{ss58}/history' data envelope. Each item is an AccountDay. */
export type AccountHistory = {
  __typename?: 'AccountHistory';
  day_count: Scalars['Int']['output'];
  days: Array<AccountDay>;
  limit?: Maybe<Scalars['Int']['output']>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  offset?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
};

export type AccountIdentity = {
  __typename?: 'AccountIdentity';
  account: Scalars['String']['output'];
  additional?: Maybe<Scalars['String']['output']>;
  captured_at?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  discord?: Maybe<Scalars['String']['output']>;
  github?: Maybe<Scalars['String']['output']>;
  has_identity: Scalars['Boolean']['output'];
  image?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  url?: Maybe<Scalars['String']['output']>;
};

export type AccountIdentityHistory = {
  __typename?: 'AccountIdentityHistory';
  account: Scalars['String']['output'];
  entries: Array<AccountIdentityHistoryEntry>;
  entry_count: Scalars['Int']['output'];
  limit?: Maybe<Scalars['Int']['output']>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  offset?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
};

/** One diff-tracked snapshot of an account's on-chain identity, taken when any tracked field changed since the previous entry. */
export type AccountIdentityHistoryEntry = {
  __typename?: 'AccountIdentityHistoryEntry';
  additional?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  discord?: Maybe<Scalars['String']['output']>;
  github?: Maybe<Scalars['String']['output']>;
  /** Stable hash of this entry's tracked identity fields -- unchanged across entries where nothing actually differs. */
  identity_hash?: Maybe<Scalars['String']['output']>;
  image?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
  url?: Maybe<Scalars['String']['output']>;
};

export type AccountList = {
  __typename?: 'AccountList';
  block_number?: Maybe<Scalars['Int']['output']>;
  captured_at?: Maybe<Scalars['String']['output']>;
  items: Array<AccountEntry>;
  sort: Scalars['String']['output'];
  total: Scalars['Int']['output'];
};

export type AccountModuleCall = {
  __typename?: 'AccountModuleCall';
  call_module: Scalars['String']['output'];
  count: Scalars['Int']['output'];
};

/** One SubnetOwnerChanged transfer tying this coldkey to a subnet, either as the gaining or losing side, newest first. */
export type AccountOwnershipTie = {
  __typename?: 'AccountOwnershipTie';
  block_number?: Maybe<Scalars['Int']['output']>;
  netuid?: Maybe<Scalars['Int']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
  role: Scalars['String']['output'];
};

/** One parent hotkey's delegated-stake proportion on a subnet. proportion is the raw stringified u64 (0..u64::MAX represents 0..100%); proportion_fraction is the same value pre-divided to a 0..1 float. */
export type AccountParentEntry = {
  __typename?: 'AccountParentEntry';
  parent: Scalars['String']['output'];
  proportion: Scalars['String']['output'];
  proportion_fraction: Scalars['Float']['output'];
};

/** One subnet's parent-hotkey delegation entries in an account's live parents graph. */
export type AccountParentSubnet = {
  __typename?: 'AccountParentSubnet';
  entries: Array<AccountParentEntry>;
  netuid: Scalars['Int']['output'];
};

/** Live parent-hotkey delegation graph (#6723) for one Finney ss58 account, read directly from chain via RPC (KV-cached). subnets is null on RPC failure, distinct from a confirmed-empty [] (schema-stable, never a GraphQL error). Mirrors GET /api/v1/accounts/{ss58}/parents. */
export type AccountParents = {
  __typename?: 'AccountParents';
  account: Scalars['String']['output'];
  queried_at: Scalars['String']['output'];
  schema_version: Scalars['Int']['output'];
  subnets?: Maybe<Array<AccountParentSubnet>>;
};

/** One wallet's cross-subnet neuron portfolio (#5702): every subnet where the hotkey is a registered neuron, plus wallet-level aggregates. Mirrors GET /api/v1/accounts/{ss58}/portfolio. */
export type AccountPortfolio = {
  __typename?: 'AccountPortfolio';
  captured_at?: Maybe<Scalars['String']['output']>;
  miner_count: Scalars['Int']['output'];
  /** Total emission over total stake across every position; null when total stake is 0. */
  overall_yield?: Maybe<Scalars['Float']['output']>;
  position_count: Scalars['Int']['output'];
  positions: Array<AccountPortfolioPosition>;
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
  /** How concentrated the wallet's stake is across its subnets (Gini/HHI/etc); null with no positions. */
  stake_concentration?: Maybe<ConcentrationMetrics>;
  subnet_count: Scalars['Int']['output'];
  total_emission_tao: Scalars['Float']['output'];
  total_stake_tao: Scalars['Float']['output'];
  validator_count: Scalars['Int']['output'];
};

/** One subnet position in a wallet's portfolio, ranked biggest-stake-first. */
export type AccountPortfolioPosition = {
  __typename?: 'AccountPortfolioPosition';
  active: Scalars['Boolean']['output'];
  dividends?: Maybe<Scalars['Float']['output']>;
  emission_tao: Scalars['Float']['output'];
  incentive?: Maybe<Scalars['Float']['output']>;
  netuid: Scalars['Int']['output'];
  rank?: Maybe<Scalars['Float']['output']>;
  role: Scalars['String']['output'];
  stake_tao: Scalars['Float']['output'];
  trust?: Maybe<Scalars['Float']['output']>;
  uid?: Maybe<Scalars['Int']['output']>;
  /** Emission over stake for this position; null when stake is 0. */
  yield?: Maybe<Scalars['Float']['output']>;
};

/** One account's per-subnet position history over a lookback window, one point per neuron_daily snapshot. Mirrors GET /api/v1/accounts/{ss58}/subnets/{netuid}/history. */
export type AccountPositionHistory = {
  __typename?: 'AccountPositionHistory';
  netuid: Scalars['Int']['output'];
  point_count: Scalars['Int']['output'];
  points: Array<AccountPositionHistoryPoint>;
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One day's position for an account in one subnet: the neuron's uid/role/active plus stake/emission and its rank/trust/incentive/dividends scores and emission-per-stake yield. */
export type AccountPositionHistoryPoint = {
  __typename?: 'AccountPositionHistoryPoint';
  active: Scalars['Boolean']['output'];
  captured_at?: Maybe<Scalars['String']['output']>;
  coldkey?: Maybe<Scalars['String']['output']>;
  dividends?: Maybe<Scalars['Float']['output']>;
  emission_tao?: Maybe<Scalars['Float']['output']>;
  incentive?: Maybe<Scalars['Float']['output']>;
  rank?: Maybe<Scalars['Float']['output']>;
  role: Scalars['String']['output'];
  snapshot_date: Scalars['String']['output'];
  stake_tao?: Maybe<Scalars['Float']['output']>;
  trust?: Maybe<Scalars['Float']['output']>;
  uid?: Maybe<Scalars['Int']['output']>;
  yield?: Maybe<Scalars['Float']['output']>;
};

/** This account's reconstructed nominator-side positions: what it holds delegated across every hotkey/subnet, distinct from AccountPortfolio's hotkey-scoped view. Mirrors GET /api/v1/accounts/{ss58}/positions. */
export type AccountPositions = {
  __typename?: 'AccountPositions';
  captured_at?: Maybe<Scalars['String']['output']>;
  position_count: Scalars['Int']['output'];
  positions: Array<NominatorPosition>;
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
  total_stake_tao: Scalars['Float']['output'];
};

/** One account's Prometheus telemetry-serving footprint (#5703) across subnets over a 7d/30d/90d window. Mirrors GET /api/v1/accounts/{ss58}/prometheus. */
export type AccountPrometheus = {
  __typename?: 'AccountPrometheus';
  address: Scalars['String']['output'];
  /** Herfindahl-Hirschman index of announcements across subnets: 1 = all on one subnet, -> 1/n as it spreads evenly; null when the account has no announcements. */
  concentration?: Maybe<Scalars['Float']['output']>;
  dominant_netuid?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<AccountPrometheusSubnet>;
  total_announcements: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One subnet's Prometheus-announcement activity in an account's footprint, ranked most-active-first. */
export type AccountPrometheusSubnet = {
  __typename?: 'AccountPrometheusSubnet';
  announcements: Scalars['Int']['output'];
  first_announced_at?: Maybe<Scalars['String']['output']>;
  last_announced_at?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
};

export type AccountRegistration = {
  __typename?: 'AccountRegistration';
  active: Scalars['Boolean']['output'];
  netuid?: Maybe<Scalars['Int']['output']>;
  stake_tao?: Maybe<Scalars['Float']['output']>;
  uid?: Maybe<Scalars['Int']['output']>;
  validator_permit: Scalars['Boolean']['output'];
};

/** One subnet's slice of an account's registration footprint over the window. */
export type AccountRegistrationSubnet = {
  __typename?: 'AccountRegistrationSubnet';
  first_registered_at?: Maybe<Scalars['String']['output']>;
  last_registered_at?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
  registrations: Scalars['Int']['output'];
};

export type AccountRegistrations = {
  __typename?: 'AccountRegistrations';
  address: Scalars['String']['output'];
  concentration?: Maybe<Scalars['Float']['output']>;
  dominant_netuid?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<AccountRegistrationSubnet>;
  total_registrations: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** Live root-claim current state for one Finney ss58 account (#7229), read directly from chain via RPC (KV-cached). claim_type/hotkeys are null on RPC failure (schema-stable, never a GraphQL error). Read-only; never submits claim_root. Mirrors GET /api/v1/accounts/{ss58}/root-claim. */
export type AccountRootClaim = {
  __typename?: 'AccountRootClaim';
  claim_type?: Maybe<RootClaimType>;
  hotkeys?: Maybe<Array<RootClaimHotkey>>;
  queried_at: Scalars['String']['output'];
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
};

export type AccountServing = {
  __typename?: 'AccountServing';
  address: Scalars['String']['output'];
  concentration?: Maybe<Scalars['Float']['output']>;
  dominant_netuid?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<AccountServingSubnet>;
  total_announcements: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One subnet's slice of an account's axon-serving footprint over the window. */
export type AccountServingSubnet = {
  __typename?: 'AccountServingSubnet';
  announcements: Scalars['Int']['output'];
  first_served_at?: Maybe<Scalars['String']['output']>;
  last_served_at?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
};

/** One account's StakeAdded/StakeRemoved staking-behavior scorecard (#5706) across subnets over a 7d/30d/90d window. Mirrors GET /api/v1/accounts/{ss58}/stake-flow. */
export type AccountStakeFlow = {
  __typename?: 'AccountStakeFlow';
  address: Scalars['String']['output'];
  /** Herfindahl-Hirschman index of gross flow across subnets: 1 = all flow in one subnet, -> 1/n as it spreads evenly; null when there is no flow to concentrate. */
  concentration?: Maybe<Scalars['Float']['output']>;
  /** accumulating / exiting / churning / idle, derived from flow_ratio. */
  direction: Scalars['String']['output'];
  dominant_netuid?: Maybe<Scalars['Int']['output']>;
  /** net_flow_tao / gross_flow_tao, [-1, 1]; null when gross_flow_tao is 0 (no flow to rate). */
  flow_ratio?: Maybe<Scalars['Float']['output']>;
  gross_flow_tao: Scalars['Float']['output'];
  net_flow_tao: Scalars['Float']['output'];
  schema_version: Scalars['Int']['output'];
  stake_events: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<AccountStakeFlowSubnet>;
  total_staked_tao: Scalars['Float']['output'];
  total_unstaked_tao: Scalars['Float']['output'];
  unstake_events: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One subnet's stake flow in an account's footprint, ranked most-active-first (highest gross flow). */
export type AccountStakeFlowSubnet = {
  __typename?: 'AccountStakeFlowSubnet';
  direction: Scalars['String']['output'];
  flow_ratio?: Maybe<Scalars['Float']['output']>;
  gross_flow_tao: Scalars['Float']['output'];
  net_flow_tao: Scalars['Float']['output'];
  netuid: Scalars['Int']['output'];
  stake_events: Scalars['Int']['output'];
  staked_tao: Scalars['Float']['output'];
  unstake_events: Scalars['Int']['output'];
  unstaked_tao: Scalars['Float']['output'];
};

/** One subnet's slice of an account's stake-movement footprint over the window. */
export type AccountStakeMoveSubnet = {
  __typename?: 'AccountStakeMoveSubnet';
  first_moved_at?: Maybe<Scalars['String']['output']>;
  last_moved_at?: Maybe<Scalars['String']['output']>;
  movements: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  /** Alpha price (TAO) on the UTC day of this subnet's most recent move; null when that day has no snapshot yet or there was no move. */
  price_tao_at_last_move?: Maybe<Scalars['Float']['output']>;
};

export type AccountStakeMoves = {
  __typename?: 'AccountStakeMoves';
  address: Scalars['String']['output'];
  concentration?: Maybe<Scalars['Float']['output']>;
  dominant_netuid?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<AccountStakeMoveSubnet>;
  total_movements: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

export type AccountSubnet = {
  __typename?: 'AccountSubnet';
  emission_tao?: Maybe<Scalars['Float']['output']>;
  netuid: Scalars['Int']['output'];
  stake_tao?: Maybe<Scalars['Float']['output']>;
  uid?: Maybe<Scalars['Int']['output']>;
};

/** One account's live cross-subnet registration footprint (the neurons snapshot), backing account_subnets. The lightweight sibling of AccountPortfolio -- registration facts only, no economics rollup. */
export type AccountSubnets = {
  __typename?: 'AccountSubnets';
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
  subnet_count: Scalars['Int']['output'];
  /** Where this hotkey is currently registered, ordered by netuid -- each an AccountRegistration (netuid/uid/stake/validator_permit/active). */
  subnets: Array<AccountRegistration>;
};

export type AccountSummary = {
  __typename?: 'AccountSummary';
  activity: AccountActivity;
  event_count: Scalars['Int']['output'];
  event_kinds: Array<AccountEventKind>;
  /** True when this account has more events than the summary's scan window -- event_count/subnet_count/event_kinds are then a lower bound and first_block/first_seen_at are null. */
  event_scan_capped: Scalars['Boolean']['output'];
  first_block?: Maybe<Scalars['Int']['output']>;
  first_seen_at?: Maybe<Scalars['String']['output']>;
  last_block?: Maybe<Scalars['Int']['output']>;
  last_seen_at?: Maybe<Scalars['String']['output']>;
  recent_events: Array<AccountEvent>;
  /** Where this hotkey is currently registered + staked (the live cross-subnet footprint). */
  registrations: Array<AccountRegistration>;
  ss58: Scalars['String']['output'];
  subnet_count: Scalars['Int']['output'];
};

/** One native-TAO Balances.Transfer event on an account's feed. direction is relative to the queried address (sent = it paid, received = it was paid). */
export type AccountTransfer = {
  __typename?: 'AccountTransfer';
  amount_tao?: Maybe<Scalars['Float']['output']>;
  block_number?: Maybe<Scalars['Int']['output']>;
  direction?: Maybe<Scalars['String']['output']>;
  event_index?: Maybe<Scalars['Int']['output']>;
  from?: Maybe<Scalars['String']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
  to?: Maybe<Scalars['String']['output']>;
};

/** One account's native-TAO transfer feed, keyset-paginated newest-first. Mirrors GET /api/v1/accounts/{ss58}/transfers' data envelope. */
export type AccountTransfers = {
  __typename?: 'AccountTransfers';
  limit?: Maybe<Scalars['Int']['output']>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  offset?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  ss58: Scalars['String']['output'];
  transfer_count: Scalars['Int']['output'];
  transfers: Array<AccountTransfer>;
};

/** One account's (validator hotkey's) WeightsSet weight-setting footprint across subnets over a 7d/30d window. Mirrors GET /api/v1/accounts/{ss58}/weight-setters. */
export type AccountWeightSetters = {
  __typename?: 'AccountWeightSetters';
  address: Scalars['String']['output'];
  /** Herfindahl-Hirschman index of weight-sets across subnets: 1 = all on one subnet, -> 1/n as it spreads evenly; null when the account has no weight-sets. */
  concentration?: Maybe<Scalars['Float']['output']>;
  dominant_netuid?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<AccountWeightSettersSubnet>;
  total_weight_sets: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One subnet's WeightsSet activity in an account's weight-setting footprint, ranked most-active-first. */
export type AccountWeightSettersSubnet = {
  __typename?: 'AccountWeightSettersSubnet';
  first_set_at?: Maybe<Scalars['String']['output']>;
  last_set_at?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
  weight_sets: Scalars['Int']['output'];
};

/** One adapter-backed public metrics snapshot. snapshot and extensions are opaque JSON -- their shape is adapter-specific. Mirrors GET /api/v1/adapters/{slug}'s data envelope. */
export type Adapter = {
  __typename?: 'Adapter';
  contract_version?: Maybe<Scalars['String']['output']>;
  /** Per-adapter extension metadata keyed by provider id; each value's shape is adapter-specific. */
  extensions?: Maybe<Scalars['JSON']['output']>;
  generated_at?: Maybe<Scalars['String']['output']>;
  netuid?: Maybe<Scalars['Int']['output']>;
  /** Public-safe notes; may be a string or a string list depending on the adapter. */
  notes?: Maybe<Scalars['JSON']['output']>;
  schema_version: Scalars['Int']['output'];
  slug: Scalars['String']['output'];
  /** Captured adapter metrics payload; shape is adapter-specific. */
  snapshot?: Maybe<Scalars['JSON']['output']>;
  subnet?: Maybe<Scalars['String']['output']>;
};

export type Block = {
  __typename?: 'Block';
  author?: Maybe<Scalars['String']['output']>;
  block_hash?: Maybe<Scalars['String']['output']>;
  block_number?: Maybe<Scalars['Int']['output']>;
  event_count?: Maybe<Scalars['Int']['output']>;
  extrinsic_count?: Maybe<Scalars['Int']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
  parent_hash?: Maybe<Scalars['String']['output']>;
  spec_version?: Maybe<Scalars['Int']['output']>;
};

/** One block's raw all-events-tier events (#6977) -- every pallet.method event, distinct from the curated block_events stream. Rows are opaque JSON. */
export type BlockChainEvents = {
  __typename?: 'BlockChainEvents';
  block_number?: Maybe<Scalars['Int']['output']>;
  event_count: Scalars['Int']['output'];
  events: Array<Scalars['JSON']['output']>;
  schema_version?: Maybe<Scalars['Int']['output']>;
};

export type BlockDetail = {
  __typename?: 'BlockDetail';
  block?: Maybe<Block>;
  /** Nearest STORED higher block height for chain-walk nav (detail only); null at the head of the retained window or when the ref didn't resolve. */
  next_block_number?: Maybe<Scalars['Int']['output']>;
  /** Nearest STORED lower block height for chain-walk nav (detail only); null at the start of the retained window or when the ref didn't resolve. */
  prev_block_number?: Maybe<Scalars['Int']['output']>;
  ref?: Maybe<Scalars['String']['output']>;
};

/** One block's decoded, account-attributed events list (#6977). Rows are opaque JSON; block_number is null for an unknown ref. */
export type BlockEvents = {
  __typename?: 'BlockEvents';
  block_number?: Maybe<Scalars['Int']['output']>;
  event_count: Scalars['Int']['output'];
  events: Array<Scalars['JSON']['output']>;
  limit?: Maybe<Scalars['Int']['output']>;
  offset?: Maybe<Scalars['Int']['output']>;
  ref?: Maybe<Scalars['String']['output']>;
  schema_version?: Maybe<Scalars['Int']['output']>;
};

/** One block's extrinsics list (#6977). Rows are the opaque JSON extrinsic shape the extrinsics feed uses; block_number is null for an unknown ref. */
export type BlockExtrinsics = {
  __typename?: 'BlockExtrinsics';
  block_number?: Maybe<Scalars['Int']['output']>;
  extrinsic_count: Scalars['Int']['output'];
  extrinsics: Array<Scalars['JSON']['output']>;
  limit?: Maybe<Scalars['Int']['output']>;
  offset?: Maybe<Scalars['Int']['output']>;
  ref?: Maybe<Scalars['String']['output']>;
  schema_version?: Maybe<Scalars['Int']['output']>;
};

export type BlockList = {
  __typename?: 'BlockList';
  items: Array<Block>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  /** Page count -- this feed has no cheap grand total, matching REST's block_count. */
  total: Scalars['Int']['output'];
};

/** Inter-block interval distribution in milliseconds, over genuinely consecutive in-window blocks. */
export type BlockTimeDistribution = {
  __typename?: 'BlockTimeDistribution';
  count: Scalars['Int']['output'];
  max_ms?: Maybe<Scalars['Float']['output']>;
  mean_ms?: Maybe<Scalars['Float']['output']>;
  min_ms?: Maybe<Scalars['Float']['output']>;
  p50_ms?: Maybe<Scalars['Float']['output']>;
  p90_ms?: Maybe<Scalars['Float']['output']>;
};

/** Block-production summary (#5664) over the recent-block window. Every aggregate is null on a cold retired-D1 store (schema-stable, never a GraphQL error). Mirrors GET /api/v1/blocks/summary. */
export type BlocksSummary = {
  __typename?: 'BlocksSummary';
  author_concentration?: Maybe<ConcentrationMetrics>;
  block_count: Scalars['Int']['output'];
  block_time?: Maybe<BlockTimeDistribution>;
  distinct_authors: Scalars['Int']['output'];
  distinct_spec_versions: Scalars['Int']['output'];
  first_block?: Maybe<Scalars['Int']['output']>;
  first_observed_at?: Maybe<Scalars['String']['output']>;
  last_block?: Maybe<Scalars['Int']['output']>;
  last_observed_at?: Maybe<Scalars['String']['output']>;
  latest_spec_version?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  throughput?: Maybe<BlocksThroughput>;
};

/** Extrinsic/event throughput across the summarized block window. */
export type BlocksThroughput = {
  __typename?: 'BlocksThroughput';
  max_extrinsics_in_block: Scalars['Int']['output'];
  mean_events_per_block?: Maybe<Scalars['Float']['output']>;
  mean_extrinsics_per_block?: Maybe<Scalars['Float']['output']>;
  total_events: Scalars['Int']['output'];
  total_extrinsics: Scalars['Int']['output'];
};

export type BuildSummary = {
  __typename?: 'BuildSummary';
  adapter_count?: Maybe<Scalars['Int']['output']>;
  artifact_budget_summary?: Maybe<Scalars['JSON']['output']>;
  artifact_count: Scalars['Int']['output'];
  artifact_size_bytes?: Maybe<Scalars['Int']['output']>;
  artifacts?: Maybe<Scalars['JSON']['output']>;
  contract_version?: Maybe<Scalars['String']['output']>;
  coverage?: Maybe<Scalars['JSON']['output']>;
  generated_at?: Maybe<Scalars['String']['output']>;
  provider_count?: Maybe<Scalars['Int']['output']>;
  published_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count?: Maybe<Scalars['Int']['output']>;
  surface_count?: Maybe<Scalars['Int']['output']>;
};

/** Per-UTC-day network activity series (blocks, extrinsics, events, signers) over the window, newest day first. Mirrors GET /api/v1/chain/activity's data envelope. */
export type ChainActivity = {
  __typename?: 'ChainActivity';
  day_count: Scalars['Int']['output'];
  days: Array<ChainActivityDay>;
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  window: Scalars['String']['output'];
};

/** One UTC day's network activity: block/extrinsic/event counts, the successful-extrinsic count and its success rate (null on a zero-extrinsic day), and the distinct signer count. */
export type ChainActivityDay = {
  __typename?: 'ChainActivityDay';
  block_count: Scalars['Int']['output'];
  day: Scalars['String']['output'];
  event_count: Scalars['Int']['output'];
  extrinsic_count: Scalars['Int']['output'];
  success_rate?: Maybe<Scalars['Float']['output']>;
  successful_extrinsics: Scalars['Int']['output'];
  unique_signers: Scalars['Int']['output'];
};

/** Network-wide rolling 24h buy/sell alpha-volume leaderboard, summed live from the account_events StakeAdded/StakeRemoved stream. Mirrors GET /api/v1/chain/alpha-volume's data envelope. */
export type ChainAlphaVolume = {
  __typename?: 'ChainAlphaVolume';
  network: ChainAlphaVolumeNetwork;
  /** Newest event observed_at across the window; null on a cold store. */
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<ChainAlphaVolumeSubnet>;
  /** Spread of per-subnet total_volume_tao across every subnet with volume; null when no subnet had volume. */
  volume_distribution?: Maybe<ChainAlphaVolumeDistribution>;
  /** Fixed rolling window label (always 24h). */
  window?: Maybe<Scalars['String']['output']>;
};

/** Spread of per-subnet total_volume_tao across EVERY subnet with volume (not just the returned page, so the spread stays network-wide when limit truncates the leaderboard). */
export type ChainAlphaVolumeDistribution = {
  __typename?: 'ChainAlphaVolumeDistribution';
  count: Scalars['Int']['output'];
  max: Scalars['Float']['output'];
  mean: Scalars['Float']['output'];
  median: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  p25: Scalars['Float']['output'];
  p75: Scalars['Float']['output'];
  p90: Scalars['Float']['output'];
};

/** Network-wide buy/sell volume rollup across every subnet with volume in the window. */
export type ChainAlphaVolumeNetwork = {
  __typename?: 'ChainAlphaVolumeNetwork';
  buy_count: Scalars['Int']['output'];
  buy_volume_alpha: Scalars['Float']['output'];
  buy_volume_tao: Scalars['Float']['output'];
  net_volume_alpha: Scalars['Float']['output'];
  sell_count: Scalars['Int']['output'];
  sell_volume_alpha: Scalars['Float']['output'];
  sell_volume_tao: Scalars['Float']['output'];
  /** Coarse sentiment label (bullish/bearish/neutral); neutral both for balanced volume and an empty window. */
  sentiment: Scalars['String']['output'];
  /** net/gross alpha lean in [-1, 1]; null when there was no volume in the window. */
  sentiment_ratio?: Maybe<Scalars['Float']['output']>;
  total_volume_alpha: Scalars['Float']['output'];
  total_volume_tao: Scalars['Float']['output'];
};

/** One subnet's rolling 24h buy/sell volume scorecard, ranked by total_volume_tao then netuid. */
export type ChainAlphaVolumeSubnet = {
  __typename?: 'ChainAlphaVolumeSubnet';
  buy_count: Scalars['Int']['output'];
  buy_volume_alpha: Scalars['Float']['output'];
  buy_volume_tao: Scalars['Float']['output'];
  net_volume_alpha: Scalars['Float']['output'];
  netuid: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
  sell_count: Scalars['Int']['output'];
  sell_volume_alpha: Scalars['Float']['output'];
  sell_volume_tao: Scalars['Float']['output'];
  /** Coarse sentiment label (bullish/bearish/neutral). */
  sentiment: Scalars['String']['output'];
  /** net/gross alpha lean in [-1, 1]; null when this subnet had no volume. */
  sentiment_ratio?: Maybe<Scalars['Float']['output']>;
  total_volume_alpha: Scalars['Float']['output'];
  total_volume_tao: Scalars['Float']['output'];
  /** 24h volume / market-cap turnover ratio; always null here (no per-subnet market-cap input in scope at the network level). */
  vol_mcap_ratio?: Maybe<Scalars['Float']['output']>;
  window?: Maybe<Scalars['String']['output']>;
};

export type ChainAxonRemovals = {
  __typename?: 'ChainAxonRemovals';
  intensity_distribution?: Maybe<ChainAxonRemovalsIntensityDistribution>;
  network: ChainAxonRemovalsNetwork;
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<ChainAxonRemovalsSubnet>;
  window?: Maybe<Scalars['String']['output']>;
};

/** Spread of per-subnet teardown intensity (AxonInfoRemoved events per remover) across EVERY subnet with removals in the window -- network-wide even when limit truncates the leaderboard. */
export type ChainAxonRemovalsIntensityDistribution = {
  __typename?: 'ChainAxonRemovalsIntensityDistribution';
  count: Scalars['Int']['output'];
  max: Scalars['Float']['output'];
  mean: Scalars['Float']['output'];
  median: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  p25: Scalars['Float']['output'];
  p75: Scalars['Float']['output'];
  p90: Scalars['Float']['output'];
};

/** Network-wide axon-removal rollup: every subnet with AxonInfoRemoved events in the window, combined. distinct_removers counts a hotkey once even when it tears endpoints down on several subnets, so it is NOT the sum of the per-subnet counts. */
export type ChainAxonRemovalsNetwork = {
  __typename?: 'ChainAxonRemovalsNetwork';
  distinct_removers: Scalars['Int']['output'];
  removals: Scalars['Int']['output'];
  /** Null when distinct_removers is 0 (no defined intensity without removers). */
  removals_per_remover?: Maybe<Scalars['Float']['output']>;
};

/** One subnet's axon-removal activity in the window, ranked by removals. */
export type ChainAxonRemovalsSubnet = {
  __typename?: 'ChainAxonRemovalsSubnet';
  distinct_removers: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  removals: Scalars['Int']['output'];
  removals_per_remover?: Maybe<Scalars['Float']['output']>;
};

/** One row of the extrinsic call-mix breakdown -- a call_module (plus call_function when group_by=module_function), its extrinsic count over the window, and its share of the window total (null when the window has no extrinsics). */
export type ChainCall = {
  __typename?: 'ChainCall';
  call_function?: Maybe<Scalars['String']['output']>;
  call_module: Scalars['String']['output'];
  count: Scalars['Int']['output'];
  share?: Maybe<Scalars['Float']['output']>;
};

/** Extrinsic call-mix breakdown over the window. Mirrors GET /api/v1/chain/calls's data envelope. */
export type ChainCalls = {
  __typename?: 'ChainCalls';
  call_count: Scalars['Int']['output'];
  calls: Array<ChainCall>;
  group_by: Scalars['String']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  total_extrinsics: Scalars['Int']['output'];
  window: Scalars['String']['output'];
};

/** Network-wide stake & emission decentralization card (#5872). Metric blocks are null on a cold/empty store. Mirrors GET /api/v1/chain/concentration. */
export type ChainConcentration = {
  __typename?: 'ChainConcentration';
  captured_at?: Maybe<Scalars['String']['output']>;
  /** Raw emission concentration across every neuron network-wide. */
  emission?: Maybe<ConcentrationMetrics>;
  /** Distinct controlling entities (coldkeys) network-wide, collapsed across subnets. */
  entity_count: Scalars['Int']['output'];
  /** Emission concentration per controlling entity -- hotkeys collapsed across subnets. */
  entity_emission?: Maybe<ConcentrationMetrics>;
  /** Stake concentration per controlling entity -- hotkeys collapsed across subnets, so one operator counts once. */
  entity_stake?: Maybe<ConcentrationMetrics>;
  neuron_count: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
  /** Raw stake concentration across every neuron network-wide. */
  stake?: Maybe<ConcentrationMetrics>;
  /** Distinct subnets the snapshot spans. */
  subnet_count: Scalars['Int']['output'];
  /** UIDs per controlling entity network-wide -- a consolidation signal (1.0 = every UID a distinct owner; higher = fewer operators each running many). Null when no entities. */
  uids_per_entity?: Maybe<Scalars['Float']['output']>;
  /** Stake concentration across permitted validators network-wide only. */
  validator_stake?: Maybe<ConcentrationMetrics>;
};

export type ChainDeregistrations = {
  __typename?: 'ChainDeregistrations';
  intensity_distribution?: Maybe<ChainDeregistrationsIntensityDistribution>;
  network: ChainDeregistrationsNetwork;
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<ChainDeregistrationsSubnet>;
  window?: Maybe<Scalars['String']['output']>;
};

/** Spread of per-subnet churn intensity (NeuronDeregistered events per hotkey) across EVERY subnet with deregistrations in the window -- network-wide even when limit truncates the leaderboard. */
export type ChainDeregistrationsIntensityDistribution = {
  __typename?: 'ChainDeregistrationsIntensityDistribution';
  count: Scalars['Int']['output'];
  max: Scalars['Float']['output'];
  mean: Scalars['Float']['output'];
  median: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  p25: Scalars['Float']['output'];
  p75: Scalars['Float']['output'];
  p90: Scalars['Float']['output'];
};

/** Network-wide deregistration rollup: every subnet with NeuronDeregistered events in the window, combined. distinct_deregistered_hotkeys counts a hotkey once even when it is deregistered from several subnets, so it is NOT the sum of the per-subnet counts. */
export type ChainDeregistrationsNetwork = {
  __typename?: 'ChainDeregistrationsNetwork';
  deregistrations: Scalars['Int']['output'];
  /** Null when distinct_deregistered_hotkeys is 0 (no defined intensity without hotkeys). */
  deregistrations_per_hotkey?: Maybe<Scalars['Float']['output']>;
  distinct_deregistered_hotkeys: Scalars['Int']['output'];
};

/** One subnet's neuron-deregistration activity in the window, ranked by deregistrations. */
export type ChainDeregistrationsSubnet = {
  __typename?: 'ChainDeregistrationsSubnet';
  deregistrations: Scalars['Int']['output'];
  deregistrations_per_hotkey?: Maybe<Scalars['Float']['output']>;
  distinct_deregistered_hotkeys: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
};

export type ChainEvent = {
  __typename?: 'ChainEvent';
  /** account_events only */
  amount_tao?: Maybe<Scalars['Float']['output']>;
  /** blocks only */
  block_hash?: Maybe<Scalars['String']['output']>;
  block_number: Scalars['Int']['output'];
  /** extrinsics only */
  call_function?: Maybe<Scalars['String']['output']>;
  /** extrinsics only */
  call_module?: Maybe<Scalars['String']['output']>;
  /** account_events only */
  coldkey?: Maybe<Scalars['String']['output']>;
  /** blocks only */
  event_count?: Maybe<Scalars['Int']['output']>;
  /** chain_events / account_events (event index within the block) */
  event_index?: Maybe<Scalars['Int']['output']>;
  /** account_events only -- the curated kind (e.g. Transfer, StakeAdded) */
  event_kind?: Maybe<Scalars['String']['output']>;
  /** blocks only */
  extrinsic_count?: Maybe<Scalars['Int']['output']>;
  /** extrinsics only */
  extrinsic_index?: Maybe<Scalars['Int']['output']>;
  /** account_events only */
  hotkey?: Maybe<Scalars['String']['output']>;
  /** chain_events only */
  method?: Maybe<Scalars['String']['output']>;
  /** account_events only */
  netuid?: Maybe<Scalars['Int']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
  /** chain_events only */
  pallet?: Maybe<Scalars['String']['output']>;
  /** extrinsics only */
  signer?: Maybe<Scalars['String']['output']>;
  /** extrinsics only */
  success?: Maybe<Scalars['Boolean']['output']>;
  table: ChainFirehoseTable;
};

/** One raw pallet-level chain event from the all-events tier (distinct from the curated AccountEvent and from Subscription's ChainEvent firehose payload). */
export type ChainEventRow = {
  __typename?: 'ChainEventRow';
  args?: Maybe<Scalars['JSON']['output']>;
  block_number?: Maybe<Scalars['Int']['output']>;
  event_index?: Maybe<Scalars['Int']['output']>;
  extrinsic_index?: Maybe<Scalars['Int']['output']>;
  method?: Maybe<Scalars['String']['output']>;
  observed_at?: Maybe<Scalars['Float']['output']>;
  pallet?: Maybe<Scalars['String']['output']>;
  phase?: Maybe<Scalars['String']['output']>;
};

/** Paginated all-events feed from the Postgres-backed all-events tier. Mirrors GET /api/v1/chain-events (and MCP list_chain_events). Distinct from Subscription.chainEvents. */
export type ChainEventsFeed = {
  __typename?: 'ChainEventsFeed';
  count: Scalars['Int']['output'];
  events: Array<ChainEventRow>;
  next_before?: Maybe<Scalars['Int']['output']>;
  next_cursor?: Maybe<Scalars['String']['output']>;
};

/** Chain-activity aggregate (pallet.method event distribution) over the most recent N blocks from the Postgres-backed all-events tier. The aggregate sibling of ChainEventsFeed. Mirrors GET /api/v1/chain-events/stats (and MCP get_chain_activity). */
export type ChainEventsStats = {
  __typename?: 'ChainEventsStats';
  activity: Array<ChainEventsStatsRow>;
  groups: Scalars['Int']['output'];
  window_blocks: Scalars['Int']['output'];
};

/** One pallet.method group in the chain-activity aggregate, with its event count over the window. */
export type ChainEventsStatsRow = {
  __typename?: 'ChainEventsStatsRow';
  count?: Maybe<Scalars['Int']['output']>;
  method?: Maybe<Scalars['String']['output']>;
  pallet?: Maybe<Scalars['String']['output']>;
};

/** One top fee-paying signer over the window, with its total fee/tip and extrinsic count. */
export type ChainFeePayer = {
  __typename?: 'ChainFeePayer';
  extrinsic_count: Scalars['Int']['output'];
  signer: Scalars['String']['output'];
  total_fee_tao?: Maybe<Scalars['Float']['output']>;
  total_tip_tao?: Maybe<Scalars['Float']['output']>;
};

/** Per-UTC-day network fee/tip series plus the top fee payers over the window. Mirrors GET /api/v1/chain/fees's data envelope. */
export type ChainFees = {
  __typename?: 'ChainFees';
  daily: Array<ChainFeesDay>;
  day_count: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  top_fee_payers: Array<ChainFeePayer>;
  window: Scalars['String']['output'];
};

/** One UTC day's fee/tip aggregate: extrinsic count, total/avg/median fee and tip in TAO (avg/median are null on a zero-extrinsic day). */
export type ChainFeesDay = {
  __typename?: 'ChainFeesDay';
  avg_fee_tao?: Maybe<Scalars['Float']['output']>;
  avg_tip_tao?: Maybe<Scalars['Float']['output']>;
  day: Scalars['String']['output'];
  extrinsic_count: Scalars['Int']['output'];
  median_fee_tao?: Maybe<Scalars['Float']['output']>;
  median_tip_tao?: Maybe<Scalars['Float']['output']>;
  total_fee_tao?: Maybe<Scalars['Float']['output']>;
  total_tip_tao?: Maybe<Scalars['Float']['output']>;
};

export enum ChainFirehoseTable {
  AccountEvents = 'account_events',
  Blocks = 'blocks',
  ChainEvents = 'chain_events',
  Extrinsics = 'extrinsics'
}

export type ChainIdentityHistory = {
  __typename?: 'ChainIdentityHistory';
  changes: Array<ChainIdentityHistoryEntry>;
  count: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
};

/** One cross-subnet identity change in the network-wide feed (carries its netuid). */
export type ChainIdentityHistoryEntry = {
  __typename?: 'ChainIdentityHistoryEntry';
  block_number?: Maybe<Scalars['Int']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  discord?: Maybe<Scalars['String']['output']>;
  github_repo?: Maybe<Scalars['String']['output']>;
  identity_hash?: Maybe<Scalars['String']['output']>;
  logo_url?: Maybe<Scalars['String']['output']>;
  netuid?: Maybe<Scalars['Int']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
  subnet_name?: Maybe<Scalars['String']['output']>;
  subnet_url?: Maybe<Scalars['String']['output']>;
  symbol?: Maybe<Scalars['String']['output']>;
};

/** Network-wide idle-stake rollup: every subnet's stake on currently-zero-dividends hotkeys, ranked by idle_stake_tao. Mirrors GET /api/v1/chain/idle-stake's data envelope. */
export type ChainIdleStake = {
  __typename?: 'ChainIdleStake';
  captured_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<ChainIdleStakeSubnet>;
  total_idle_stake_tao: Scalars['Float']['output'];
};

/** One subnet's idle-stake scorecard in the network ranking. */
export type ChainIdleStakeSubnet = {
  __typename?: 'ChainIdleStakeSubnet';
  idle_neuron_count: Scalars['Int']['output'];
  idle_stake_tao: Scalars['Float']['output'];
  netuid: Scalars['Int']['output'];
  neuron_count: Scalars['Int']['output'];
};

/** Network-wide reward-distribution & score-spread card (#5688) -- the network analog of SubnetPerformance, spanning every subnet's neurons in one snapshot. Metric blocks are null on a cold/empty store. Mirrors GET /api/v1/chain/performance. */
export type ChainPerformance = {
  __typename?: 'ChainPerformance';
  active_count: Scalars['Int']['output'];
  captured_at?: Maybe<Scalars['String']['output']>;
  /** Consensus score spread across all neurons network-wide. */
  consensus?: Maybe<ScoreDistribution>;
  /** Dividends concentration across permitted validators network-wide only. */
  dividends?: Maybe<ConcentrationMetrics>;
  /** Incentive concentration across all neurons network-wide with positive incentive. */
  incentive?: Maybe<ConcentrationMetrics>;
  neuron_count: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
  /** Distinct subnets the snapshot spans. */
  subnet_count: Scalars['Int']['output'];
  /** Trust score spread across all neurons network-wide. */
  trust?: Maybe<ScoreDistribution>;
  validator_count: Scalars['Int']['output'];
  /** Validator-trust score spread across permitted validators network-wide only. */
  validator_trust?: Maybe<ScoreDistribution>;
};

export type ChainPrometheus = {
  __typename?: 'ChainPrometheus';
  intensity_distribution?: Maybe<ChainPrometheusIntensityDistribution>;
  network: ChainPrometheusNetwork;
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<ChainPrometheusSubnet>;
  window?: Maybe<Scalars['String']['output']>;
};

/** Spread of per-subnet re-announcement intensity (PrometheusServed events per exporter) across EVERY subnet with announcements in the window -- network-wide even when limit truncates the leaderboard. */
export type ChainPrometheusIntensityDistribution = {
  __typename?: 'ChainPrometheusIntensityDistribution';
  count: Scalars['Int']['output'];
  max: Scalars['Float']['output'];
  mean: Scalars['Float']['output'];
  median: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  p25: Scalars['Float']['output'];
  p75: Scalars['Float']['output'];
  p90: Scalars['Float']['output'];
};

/** Network-wide Prometheus-serving rollup: every subnet with PrometheusServed announcements in the window, combined. distinct_exporters counts a hotkey once even when it announces on several subnets, so it is NOT the sum of the per-subnet counts. */
export type ChainPrometheusNetwork = {
  __typename?: 'ChainPrometheusNetwork';
  announcements: Scalars['Int']['output'];
  /** Null when distinct_exporters is 0 (no defined intensity without exporters). */
  announcements_per_exporter?: Maybe<Scalars['Float']['output']>;
  distinct_exporters: Scalars['Int']['output'];
};

/** One subnet's Prometheus telemetry-serving activity in the window, ranked by announcements. */
export type ChainPrometheusSubnet = {
  __typename?: 'ChainPrometheusSubnet';
  announcements: Scalars['Int']['output'];
  announcements_per_exporter?: Maybe<Scalars['Float']['output']>;
  distinct_exporters: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
};

export type ChainRegistrations = {
  __typename?: 'ChainRegistrations';
  intensity_distribution?: Maybe<ChainRegistrationsIntensityDistribution>;
  network: ChainRegistrationsNetwork;
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<ChainRegistrationsSubnet>;
  window?: Maybe<Scalars['String']['output']>;
};

/** Spread of per-subnet registration intensity (NeuronRegistered events per hotkey) across EVERY subnet with registrations in the window -- network-wide even when limit truncates the leaderboard. */
export type ChainRegistrationsIntensityDistribution = {
  __typename?: 'ChainRegistrationsIntensityDistribution';
  count: Scalars['Int']['output'];
  max: Scalars['Float']['output'];
  mean: Scalars['Float']['output'];
  median: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  p25: Scalars['Float']['output'];
  p75: Scalars['Float']['output'];
  p90: Scalars['Float']['output'];
};

/** Network-wide registration rollup: every subnet with NeuronRegistered events in the window, combined. distinct_registrants counts a hotkey once even when it registers on several subnets, so it is NOT the sum of the per-subnet counts. */
export type ChainRegistrationsNetwork = {
  __typename?: 'ChainRegistrationsNetwork';
  distinct_registrants: Scalars['Int']['output'];
  registrations: Scalars['Int']['output'];
  /** Null when distinct_registrants is 0 (no defined intensity without hotkeys). */
  registrations_per_registrant?: Maybe<Scalars['Float']['output']>;
};

/** One subnet's neuron-registration activity in the window, ranked by registrations. */
export type ChainRegistrationsSubnet = {
  __typename?: 'ChainRegistrationsSubnet';
  distinct_registrants: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  registrations: Scalars['Int']['output'];
  registrations_per_registrant?: Maybe<Scalars['Float']['output']>;
};

/** Network-wide axon-serving announcement leaderboard (#5873). The network-wide counterpart of subnet_serving. Mirrors GET /api/v1/chain/serving's data envelope. */
export type ChainServing = {
  __typename?: 'ChainServing';
  intensity_distribution?: Maybe<ChainServingIntensityDistribution>;
  network: ChainServingNetwork;
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<ChainServingSubnet>;
  window?: Maybe<Scalars['String']['output']>;
};

/** Spread of per-subnet re-announcement intensity (AxonServed events per server) across EVERY subnet with announcements in the window -- network-wide even when limit truncates the leaderboard. */
export type ChainServingIntensityDistribution = {
  __typename?: 'ChainServingIntensityDistribution';
  count: Scalars['Int']['output'];
  max: Scalars['Float']['output'];
  mean: Scalars['Float']['output'];
  median: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  p25: Scalars['Float']['output'];
  p75: Scalars['Float']['output'];
  p90: Scalars['Float']['output'];
};

/** Network-wide axon-serving rollup: every subnet with AxonServed announcements in the window, combined. */
export type ChainServingNetwork = {
  __typename?: 'ChainServingNetwork';
  announcements: Scalars['Int']['output'];
  /** Null when distinct_servers is 0 (no defined intensity without servers). */
  announcements_per_server?: Maybe<Scalars['Float']['output']>;
  distinct_servers: Scalars['Int']['output'];
};

/** One subnet's axon-serving activity in the window, ranked by announcements. */
export type ChainServingSubnet = {
  __typename?: 'ChainServingSubnet';
  announcements: Scalars['Int']['output'];
  announcements_per_server?: Maybe<Scalars['Float']['output']>;
  distinct_servers: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
};

/** One account's extrinsic-submission activity in the window, ranked by the requested sort. */
export type ChainSigner = {
  __typename?: 'ChainSigner';
  last_tx_block?: Maybe<Scalars['Int']['output']>;
  signer: Scalars['String']['output'];
  /** Total fees paid across the window's extrinsics; null when the tier has no fee data. */
  total_fee_tao?: Maybe<Scalars['Float']['output']>;
  total_tip_tao?: Maybe<Scalars['Float']['output']>;
  tx_count: Scalars['Int']['output'];
};

/** Network-wide weight-setter leaderboard over a lookback window, summed live from the account_events WeightsSet stream. The setter-level drill-in behind ChainWeights. Mirrors GET /api/v1/chain/weights/setters. */
export type ChainSigners = {
  __typename?: 'ChainSigners';
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  signer_count: Scalars['Int']['output'];
  signers: Array<ChainSigner>;
  /** The rank order actually applied: tx_count or total_fee_tao. */
  sort: Scalars['String']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** Network-wide cross-subnet capital-flow leaderboard over a lookback window, summed live from the account_events StakeAdded/StakeRemoved stream. Mirrors GET /api/v1/chain/stake-flow's data envelope. */
export type ChainStakeFlow = {
  __typename?: 'ChainStakeFlow';
  /** Spread of per-subnet net_flow_tao across EVERY subnet with stake events; null when no subnet moved stake. */
  net_flow_distribution?: Maybe<ChainStakeFlowDistribution>;
  network: ChainStakeFlowNetwork;
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<ChainStakeFlowSubnet>;
  window?: Maybe<Scalars['String']['output']>;
};

/** Spread of per-subnet net_flow_tao (can be negative) across EVERY subnet with stake events (not just the returned page). */
export type ChainStakeFlowDistribution = {
  __typename?: 'ChainStakeFlowDistribution';
  count: Scalars['Int']['output'];
  max: Scalars['Float']['output'];
  mean: Scalars['Float']['output'];
  median: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  p25: Scalars['Float']['output'];
  p75: Scalars['Float']['output'];
  p90: Scalars['Float']['output'];
};

/** Network rollup over every subnet that moved stake in the window. */
export type ChainStakeFlowNetwork = {
  __typename?: 'ChainStakeFlowNetwork';
  flat: Scalars['Int']['output'];
  gaining: Scalars['Int']['output'];
  gross_flow_tao: Scalars['Float']['output'];
  losing: Scalars['Int']['output'];
  net_flow_tao: Scalars['Float']['output'];
  stake_events: Scalars['Int']['output'];
  total_staked_tao: Scalars['Float']['output'];
  total_unstaked_tao: Scalars['Float']['output'];
  unstake_events: Scalars['Int']['output'];
};

/** One subnet's capital-flow scorecard in the window, ranked by net_flow_tao. */
export type ChainStakeFlowSubnet = {
  __typename?: 'ChainStakeFlowSubnet';
  /** inflow | outflow | balanced */
  direction: Scalars['String']['output'];
  gross_flow_tao: Scalars['Float']['output'];
  net_flow_tao: Scalars['Float']['output'];
  netuid: Scalars['Int']['output'];
  stake_events: Scalars['Int']['output'];
  total_staked_tao: Scalars['Float']['output'];
  total_unstaked_tao: Scalars['Float']['output'];
  unstake_events: Scalars['Int']['output'];
};

/** Network-wide stake-movement (re-delegation) leaderboard over a lookback window, summed live from the account_events StakeMoved stream. Mirrors GET /api/v1/chain/stake-moves's data envelope. */
export type ChainStakeMoves = {
  __typename?: 'ChainStakeMoves';
  intensity_distribution?: Maybe<ChainStakeMovesIntensityDistribution>;
  network: ChainStakeMovesNetwork;
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<ChainStakeMovesSubnet>;
  window?: Maybe<Scalars['String']['output']>;
};

/** Spread of per-subnet movements-per-mover intensity across EVERY subnet with moves in the window. */
export type ChainStakeMovesIntensityDistribution = {
  __typename?: 'ChainStakeMovesIntensityDistribution';
  count: Scalars['Int']['output'];
  max: Scalars['Float']['output'];
  mean: Scalars['Float']['output'];
  median: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  p25: Scalars['Float']['output'];
  p75: Scalars['Float']['output'];
  p90: Scalars['Float']['output'];
};

/** Network-wide stake-move rollup: every subnet with StakeMoved events in the window, combined. distinct_movers counts a coldkey once even when it moves on several subnets. */
export type ChainStakeMovesNetwork = {
  __typename?: 'ChainStakeMovesNetwork';
  distinct_movers: Scalars['Int']['output'];
  movements: Scalars['Int']['output'];
  /** Null when distinct_movers is 0. */
  movements_per_mover?: Maybe<Scalars['Float']['output']>;
};

/** One subnet's stake-movement activity in the window, ranked by movements. */
export type ChainStakeMovesSubnet = {
  __typename?: 'ChainStakeMovesSubnet';
  distinct_movers: Scalars['Int']['output'];
  movements: Scalars['Int']['output'];
  movements_per_mover?: Maybe<Scalars['Float']['output']>;
  netuid: Scalars['Int']['output'];
};

/** Network-wide stake-transfer (between-coldkeys) leaderboard over a lookback window, summed live from the account_events StakeTransferred stream. Mirrors GET /api/v1/chain/stake-transfers's data envelope. */
export type ChainStakeTransfers = {
  __typename?: 'ChainStakeTransfers';
  intensity_distribution?: Maybe<ChainStakeTransfersIntensityDistribution>;
  network: ChainStakeTransfersNetwork;
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<ChainStakeTransfersSubnet>;
  window?: Maybe<Scalars['String']['output']>;
};

/** Spread of per-subnet transfers-per-sender intensity across EVERY subnet with transfers in the window. */
export type ChainStakeTransfersIntensityDistribution = {
  __typename?: 'ChainStakeTransfersIntensityDistribution';
  count: Scalars['Int']['output'];
  max: Scalars['Float']['output'];
  mean: Scalars['Float']['output'];
  median: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  p25: Scalars['Float']['output'];
  p75: Scalars['Float']['output'];
  p90: Scalars['Float']['output'];
};

/** Network-wide stake-transfer rollup: every subnet with StakeTransferred events in the window, combined. distinct_senders counts an origin coldkey once even when it transfers out of several subnets. */
export type ChainStakeTransfersNetwork = {
  __typename?: 'ChainStakeTransfersNetwork';
  distinct_senders: Scalars['Int']['output'];
  transfers: Scalars['Int']['output'];
  /** Null when distinct_senders is 0. */
  transfers_per_sender?: Maybe<Scalars['Float']['output']>;
};

/** One subnet's stake-transfer activity in the window, ranked by transfers. */
export type ChainStakeTransfersSubnet = {
  __typename?: 'ChainStakeTransfersSubnet';
  distinct_senders: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  transfers: Scalars['Int']['output'];
  transfers_per_sender?: Maybe<Scalars['Float']['output']>;
};

/** One directed sender -> receiver corridor on the transfer-pairs leaderboard. */
export type ChainTransferPair = {
  __typename?: 'ChainTransferPair';
  from: Scalars['String']['output'];
  last_block?: Maybe<Scalars['Int']['output']>;
  last_observed_at?: Maybe<Scalars['String']['output']>;
  to: Scalars['String']['output'];
  transfer_count: Scalars['Int']['output'];
  volume_tao: Scalars['Float']['output'];
};

/** Network-wide directed native-TAO transfer-corridor leaderboard over a lookback window. Mirrors GET /api/v1/chain/transfer-pairs's data envelope. */
export type ChainTransferPairs = {
  __typename?: 'ChainTransferPairs';
  observed_at?: Maybe<Scalars['String']['output']>;
  pair_count: Scalars['Int']['output'];
  pairs: Array<ChainTransferPair>;
  schema_version: Scalars['Int']['output'];
  /** The rank order actually applied: volume or count. */
  sort: Scalars['String']['output'];
  /** Highest-volume corridor's share of total pairable volume; null when the window has no pairable volume. */
  top_pair_share?: Maybe<Scalars['Float']['output']>;
  total_volume_tao: Scalars['Float']['output'];
  transfer_count: Scalars['Int']['output'];
  unique_pairs: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One account on a chain-transfers sender/receiver leaderboard. */
export type ChainTransferParty = {
  __typename?: 'ChainTransferParty';
  address: Scalars['String']['output'];
  transfer_count: Scalars['Int']['output'];
  volume_tao: Scalars['Float']['output'];
};

/** Network-wide native-TAO transfer analytics over a lookback window. Mirrors GET /api/v1/chain/transfers's data envelope. */
export type ChainTransfers = {
  __typename?: 'ChainTransfers';
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  top_receivers: Array<ChainTransferParty>;
  /** Top senders' combined share of total volume; null when total volume is 0. */
  top_sender_share?: Maybe<Scalars['Float']['output']>;
  top_senders: Array<ChainTransferParty>;
  total_volume_tao: Scalars['Float']['output'];
  transfer_count: Scalars['Int']['output'];
  unique_receivers: Scalars['Int']['output'];
  unique_senders: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** Network-wide validator-set churn across all subnets (#5686). Mirrors GET /api/v1/chain/turnover's data envelope. */
export type ChainTurnover = {
  __typename?: 'ChainTurnover';
  /** False when the window resolved to fewer than two distinct snapshots, so start/end churn is not measurable. */
  comparable: Scalars['Boolean']['output'];
  /** End snapshot date; null on a cold store. */
  end_date?: Maybe<Scalars['String']['output']>;
  network: ChainTurnoverNetwork;
  schema_version: Scalars['Int']['output'];
  /** Null when no subnet had a stability score in the window (nothing to distribute). */
  stability_distribution?: Maybe<ChainTurnoverStabilityDistribution>;
  /** Start snapshot date; null on a cold store. */
  start_date?: Maybe<Scalars['String']['output']>;
  subnet_count: Scalars['Int']['output'];
  subnets: Array<ChainTurnoverSubnet>;
  window?: Maybe<Scalars['String']['output']>;
};

/** Network-wide validator-set rollup: every subnet's validators combined, deduplicated across the network. */
export type ChainTurnoverNetwork = {
  __typename?: 'ChainTurnoverNetwork';
  /** 0-100 stability score; null on a cold/non-comparable window. */
  stability_score?: Maybe<Scalars['Float']['output']>;
  /** Jaccard retention of the start set into the end set; null on a cold/non-comparable window. */
  validator_retention?: Maybe<Scalars['Float']['output']>;
  validators_end: Scalars['Int']['output'];
  validators_entered: Scalars['Int']['output'];
  validators_exited: Scalars['Int']['output'];
  validators_start: Scalars['Int']['output'];
};

/** Spread of per-subnet stability score across EVERY subnet in the window (not just the returned page, so the spread stays network-wide when limit truncates the leaderboard). */
export type ChainTurnoverStabilityDistribution = {
  __typename?: 'ChainTurnoverStabilityDistribution';
  count: Scalars['Int']['output'];
  max: Scalars['Float']['output'];
  mean: Scalars['Float']['output'];
  median: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  p25: Scalars['Float']['output'];
  p75: Scalars['Float']['output'];
  p90: Scalars['Float']['output'];
};

/** One subnet's validator-set churn, ranked by gross churn (entered + exited) then netuid. */
export type ChainTurnoverSubnet = {
  __typename?: 'ChainTurnoverSubnet';
  netuid: Scalars['Int']['output'];
  stability_score?: Maybe<Scalars['Float']['output']>;
  validator_retention?: Maybe<Scalars['Float']['output']>;
  validators_end: Scalars['Int']['output'];
  validators_entered: Scalars['Int']['output'];
  validators_exited: Scalars['Int']['output'];
  validators_start: Scalars['Int']['output'];
};

/** One validator's network-wide weight-setting activity in the window. netuid is set only when hotkey is null (a uid-only identity has no meaning outside its own subnet). */
export type ChainWeightSetter = {
  __typename?: 'ChainWeightSetter';
  first_set_at?: Maybe<Scalars['String']['output']>;
  hotkey?: Maybe<Scalars['String']['output']>;
  last_set_at?: Maybe<Scalars['String']['output']>;
  netuid?: Maybe<Scalars['Int']['output']>;
  /** This setter's share of the network total weight_sets; null when the network total is 0. */
  share?: Maybe<Scalars['Float']['output']>;
  uid?: Maybe<Scalars['Int']['output']>;
  weight_sets: Scalars['Int']['output'];
};

export type ChainWeightSetters = {
  __typename?: 'ChainWeightSetters';
  distinct_setters: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  setter_count: Scalars['Int']['output'];
  setters: Array<ChainWeightSetter>;
  weight_sets: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** Network-wide validator weight-setting activity over a lookback window, summed live from the account_events WeightsSet stream. Mirrors GET /api/v1/chain/weights. */
export type ChainWeights = {
  __typename?: 'ChainWeights';
  intensity_distribution?: Maybe<ChainWeightsIntensityDistribution>;
  network: ChainWeightsNetwork;
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  subnets: Array<ChainWeightsSubnet>;
  window?: Maybe<Scalars['String']['output']>;
};

/** Spread of per-subnet update intensity (WeightsSet events per validator) across every subnet that set weights in the window. */
export type ChainWeightsIntensityDistribution = {
  __typename?: 'ChainWeightsIntensityDistribution';
  count: Scalars['Int']['output'];
  max: Scalars['Float']['output'];
  mean: Scalars['Float']['output'];
  median: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  p25: Scalars['Float']['output'];
  p75: Scalars['Float']['output'];
  p90: Scalars['Float']['output'];
};

/** Network-wide weight-setting rollup: every subnet that set weights in the window, combined. */
export type ChainWeightsNetwork = {
  __typename?: 'ChainWeightsNetwork';
  distinct_setters: Scalars['Int']['output'];
  /** Null when distinct_setters is 0 (no defined intensity without setters). */
  sets_per_setter?: Maybe<Scalars['Float']['output']>;
  weight_sets: Scalars['Int']['output'];
};

/** One subnet's weight-setting activity in the window, ranked by weight_sets. */
export type ChainWeightsSubnet = {
  __typename?: 'ChainWeightsSubnet';
  distinct_setters: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  sets_per_setter?: Maybe<Scalars['Float']['output']>;
  weight_sets: Scalars['Int']['output'];
};

/** Network-wide emission-yield (return rate) card across every subnet's neurons. Aggregates are null on a cold store (schema-stable, never a GraphQL error). Mirrors GET /api/v1/chain/yield. */
export type ChainYield = {
  __typename?: 'ChainYield';
  captured_at?: Maybe<Scalars['String']['output']>;
  distribution?: Maybe<YieldDistribution>;
  miner_count: Scalars['Int']['output'];
  miner_yield?: Maybe<Scalars['Float']['output']>;
  network_yield?: Maybe<Scalars['Float']['output']>;
  neuron_count: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  total_emission_tao: Scalars['Float']['output'];
  total_stake_tao: Scalars['Float']['output'];
  validator_count: Scalars['Int']['output'];
  validator_yield?: Maybe<Scalars['Float']['output']>;
};

export type Changelog = {
  __typename?: 'Changelog';
  artifacts?: Maybe<Scalars['JSON']['output']>;
  coverage_delta?: Maybe<Scalars['JSON']['output']>;
  generated_at?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['JSON']['output']>;
  source?: Maybe<Scalars['String']['output']>;
  subnets?: Maybe<Scalars['JSON']['output']>;
  summary?: Maybe<Scalars['JSON']['output']>;
};

export type Compare = {
  __typename?: 'Compare';
  dimensions: Array<Scalars['String']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
  requested_netuids: Array<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  source?: Maybe<Scalars['String']['output']>;
  subnets: Array<CompareSubnet>;
};

export type CompareEconomics = {
  __typename?: 'CompareEconomics';
  alpha_price_tao?: Maybe<Scalars['Float']['output']>;
  emission_share?: Maybe<Scalars['Float']['output']>;
  miner_count?: Maybe<Scalars['Int']['output']>;
  miner_readiness?: Maybe<Scalars['Int']['output']>;
  open_slots?: Maybe<Scalars['Int']['output']>;
  registration_allowed?: Maybe<Scalars['Boolean']['output']>;
  registration_cost_tao?: Maybe<Scalars['Float']['output']>;
  total_stake_tao?: Maybe<Scalars['Float']['output']>;
  validator_count?: Maybe<Scalars['Int']['output']>;
};

export type CompareHealth = {
  __typename?: 'CompareHealth';
  avg_latency_ms?: Maybe<Scalars['Int']['output']>;
  ok_count?: Maybe<Scalars['Int']['output']>;
  surface_count?: Maybe<Scalars['Int']['output']>;
};

export type CompareStructure = {
  __typename?: 'CompareStructure';
  completeness_score?: Maybe<Scalars['Float']['output']>;
  operational_interface_count?: Maybe<Scalars['Int']['output']>;
  surface_count?: Maybe<Scalars['Int']['output']>;
};

export type CompareSubnet = {
  __typename?: 'CompareSubnet';
  economics?: Maybe<CompareEconomics>;
  found: Scalars['Boolean']['output'];
  health?: Maybe<CompareHealth>;
  name?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
  slug?: Maybe<Scalars['String']['output']>;
  structure?: Maybe<CompareStructure>;
};

export type ComparedValidator = {
  __typename?: 'ComparedValidator';
  apy_estimate?: Maybe<Scalars['Float']['output']>;
  apy_estimate_eligible_subnet_count: Scalars['Int']['output'];
  avg_validator_trust?: Maybe<Scalars['Float']['output']>;
  coldkey?: Maybe<Scalars['String']['output']>;
  /** The coldkey's self-declared on-chain identity; opaque JSON, matching the REST/MCP shape. */
  coldkey_identity?: Maybe<Scalars['JSON']['output']>;
  hotkey: Scalars['String']['output'];
  max_validator_trust?: Maybe<Scalars['Float']['output']>;
  nominator_count?: Maybe<Scalars['Int']['output']>;
  /** This validator's membership row in the requested netuid; null when netuid was omitted or it has no permit there. Opaque JSON, matching the REST/MCP shape. */
  subnet_context?: Maybe<Scalars['JSON']['output']>;
  subnet_count: Scalars['Int']['output'];
  take?: Maybe<Scalars['Float']['output']>;
  total_emission_tao: Scalars['Float']['output'];
  total_stake_tao: Scalars['Float']['output'];
};

/** Concentration metrics over a value distribution -- Gini, HHI (raw + holder-count-normalized), Nakamoto coefficient, top-percentile shares, and Shannon entropy. */
export type ConcentrationMetrics = {
  __typename?: 'ConcentrationMetrics';
  entropy?: Maybe<Scalars['Float']['output']>;
  entropy_normalized?: Maybe<Scalars['Float']['output']>;
  gini?: Maybe<Scalars['Float']['output']>;
  hhi?: Maybe<Scalars['Float']['output']>;
  hhi_normalized?: Maybe<Scalars['Float']['output']>;
  holders: Scalars['Int']['output'];
  nakamoto_coefficient?: Maybe<Scalars['Int']['output']>;
  top_1pct_share?: Maybe<Scalars['Float']['output']>;
  top_5pct_share?: Maybe<Scalars['Float']['output']>;
  top_10pct_share?: Maybe<Scalars['Float']['output']>;
  top_20pct_share?: Maybe<Scalars['Float']['output']>;
  total?: Maybe<Scalars['Float']['output']>;
};

export type Contracts = {
  __typename?: 'Contracts';
  artifacts: Array<Scalars['JSON']['output']>;
  base_path?: Maybe<Scalars['String']['output']>;
  contract_version?: Maybe<Scalars['String']['output']>;
  generated_at?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['JSON']['output']>;
  openapi_url?: Maybe<Scalars['String']['output']>;
  primary_domain?: Maybe<Scalars['String']['output']>;
  schema_version?: Maybe<Scalars['Int']['output']>;
  type_definitions_url?: Maybe<Scalars['String']['output']>;
};

/** The per-domain rollup overview across the fixed capability taxonomy (#6989). Mirrors GET /api/v1/domains. */
export type DomainOverview = {
  __typename?: 'DomainOverview';
  domain_count: Scalars['Int']['output'];
  domains: Array<DomainSummary>;
  schema_version: Scalars['Int']['output'];
};

/** One domain/capability tag's rollup (#6989). Mirrors GET /api/v1/domains/{tag}/summary. */
export type DomainSummary = {
  __typename?: 'DomainSummary';
  domain: Scalars['String']['output'];
  /** Within-domain emission HHI; null when the domain has no members. */
  emission_concentration?: Maybe<Scalars['Float']['output']>;
  netuids: Array<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  total_emission_share: Scalars['Float']['output'];
  total_stake_tao: Scalars['Float']['output'];
};

export type EconomicsList = {
  __typename?: 'EconomicsList';
  next_cursor?: Maybe<Scalars['String']['output']>;
  subnets: Array<SubnetEconomics>;
  summary?: Maybe<EconomicsSummary>;
  total: Scalars['Int']['output'];
};

export type EconomicsSummary = {
  __typename?: 'EconomicsSummary';
  registration_open_count: Scalars['Int']['output'];
  subnet_count: Scalars['Int']['output'];
  /** Sum of every non-root subnet's alpha_market_cap_tao -- rao-precision decimal string (#6641). */
  total_alpha_value_tao: Scalars['String']['output'];
  total_miners: Scalars['Int']['output'];
  /** total_root_value_tao + total_alpha_value_tao -- Backprop's Total Network Value (#6641). */
  total_network_value_tao: Scalars['String']['output'];
  /** Root (netuid 0) TAO-denominated stake -- rao-precision decimal string (#6641). */
  total_root_value_tao: Scalars['String']['output'];
  total_stake_tao: Scalars['String']['output'];
  total_validators: Scalars['Int']['output'];
  with_economics_count: Scalars['Int']['output'];
};

export type EconomicsTrends = {
  __typename?: 'EconomicsTrends';
  day_count: Scalars['Int']['output'];
  days: Array<EconomicsTrendsDay>;
  schema_version: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One UTC day of network-wide economics aggregated across every subnet with a snapshot that day. Sums are null only when no subnet reported a value that day. */
export type EconomicsTrendsDay = {
  __typename?: 'EconomicsTrendsDay';
  alpha_price_tao_median?: Maybe<Scalars['Float']['output']>;
  alpha_price_tao_weighted?: Maybe<Scalars['Float']['output']>;
  mean_emission_share?: Maybe<Scalars['Float']['output']>;
  miner_count?: Maybe<Scalars['Int']['output']>;
  snapshot_date: Scalars['String']['output'];
  subnet_count: Scalars['Int']['output'];
  /** Lossless fixed 9-decimal (rao-precision) TAO string, summed across every subnet reporting that day -- exceeds the exact-double ceiling as a JSON number, so it is served as a string rather than Float. */
  total_stake_tao?: Maybe<Scalars['String']['output']>;
  validator_count?: Maybe<Scalars['Int']['output']>;
};

export type Endpoint = {
  __typename?: 'Endpoint';
  auth_required?: Maybe<Scalars['Boolean']['output']>;
  authority?: Maybe<Scalars['String']['output']>;
  classification?: Maybe<Scalars['String']['output']>;
  health_source?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  kind?: Maybe<Scalars['String']['output']>;
  last_checked?: Maybe<Scalars['String']['output']>;
  last_ok?: Maybe<Scalars['String']['output']>;
  latency_ms?: Maybe<Scalars['Int']['output']>;
  latest_block?: Maybe<Scalars['Int']['output']>;
  layer?: Maybe<Scalars['String']['output']>;
  monitoring_status?: Maybe<Scalars['String']['output']>;
  netuid?: Maybe<Scalars['Int']['output']>;
  network?: Maybe<Scalars['String']['output']>;
  operator?: Maybe<Scalars['String']['output']>;
  pool_eligible?: Maybe<Scalars['Boolean']['output']>;
  provider?: Maybe<Scalars['String']['output']>;
  public_safe?: Maybe<Scalars['Boolean']['output']>;
  score?: Maybe<Scalars['Int']['output']>;
  source_urls?: Maybe<Array<Scalars['String']['output']>>;
  status?: Maybe<Scalars['String']['output']>;
  subnet_name?: Maybe<Scalars['String']['output']>;
  subnet_slug?: Maybe<Scalars['String']['output']>;
  surface_id?: Maybe<Scalars['String']['output']>;
  surface_key?: Maybe<Scalars['String']['output']>;
  url?: Maybe<Scalars['String']['output']>;
};

/** One endpoint incident in the global ledger. Mirrors the REST EndpointIncident shape (enum-valued fields carried as their string values). */
export type EndpointIncident = {
  __typename?: 'EndpointIncident';
  classification?: Maybe<Scalars['String']['output']>;
  detected_at?: Maybe<Scalars['String']['output']>;
  endpoint_id?: Maybe<Scalars['String']['output']>;
  health_source?: Maybe<Scalars['String']['output']>;
  health_stale?: Maybe<Scalars['Boolean']['output']>;
  id?: Maybe<Scalars['String']['output']>;
  kind?: Maybe<Scalars['String']['output']>;
  last_checked?: Maybe<Scalars['String']['output']>;
  last_ok?: Maybe<Scalars['String']['output']>;
  layer?: Maybe<Scalars['String']['output']>;
  netuid?: Maybe<Scalars['Int']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
  operator?: Maybe<Scalars['String']['output']>;
  pool_eligible?: Maybe<Scalars['Boolean']['output']>;
  provider?: Maybe<Scalars['String']['output']>;
  reason?: Maybe<Scalars['String']['output']>;
  severity?: Maybe<Scalars['String']['output']>;
  state?: Maybe<Scalars['String']['output']>;
  status?: Maybe<Scalars['String']['output']>;
  subnet_name?: Maybe<Scalars['String']['output']>;
  subnet_slug?: Maybe<Scalars['String']['output']>;
  surface_id?: Maybe<Scalars['String']['output']>;
  surface_key?: Maybe<Scalars['String']['output']>;
  user_reported?: Maybe<Scalars['Boolean']['output']>;
};

export type EndpointList = {
  __typename?: 'EndpointList';
  items: Array<Endpoint>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  total: Scalars['Int']['output'];
};

/** Network-wide public evidence ledger page. Mirrors GET /api/v1/evidence (and MCP list_evidence). */
export type EvidenceList = {
  __typename?: 'EvidenceList';
  claims: Array<Scalars['JSON']['output']>;
  cursor: Scalars['Int']['output'];
  generated_at?: Maybe<Scalars['String']['output']>;
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  returned: Scalars['Int']['output'];
  schema_version?: Maybe<Scalars['String']['output']>;
  sort?: Maybe<Scalars['String']['output']>;
  summary?: Maybe<Scalars['JSON']['output']>;
  total: Scalars['Int']['output'];
};

/** Live EVM (H160) -> Substrate (SS58) account-address mapping read from chain via RPC. ss58 is null when the mapping cannot be resolved (schema-stable, never a GraphQL error). Mirrors GET /api/v1/evm/address/{h160}. */
export type EvmAddressMapping = {
  __typename?: 'EvmAddressMapping';
  h160: Scalars['String']['output'];
  queried_at: Scalars['String']['output'];
  schema_version: Scalars['Int']['output'];
  ss58?: Maybe<Scalars['String']['output']>;
};

export type Extrinsic = {
  __typename?: 'Extrinsic';
  block_number?: Maybe<Scalars['Int']['output']>;
  /** JSON-encoded decoded call arguments. */
  call_args?: Maybe<Scalars['String']['output']>;
  call_function?: Maybe<Scalars['String']['output']>;
  call_module?: Maybe<Scalars['String']['output']>;
  extrinsic_hash?: Maybe<Scalars['String']['output']>;
  extrinsic_index?: Maybe<Scalars['Int']['output']>;
  fee_tao?: Maybe<Scalars['Float']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
  signer?: Maybe<Scalars['String']['output']>;
  success?: Maybe<Scalars['Boolean']['output']>;
  tip_tao?: Maybe<Scalars['Float']['output']>;
};

export type ExtrinsicDetail = {
  __typename?: 'ExtrinsicDetail';
  extrinsic?: Maybe<Extrinsic>;
  ref?: Maybe<Scalars['String']['output']>;
};

export type ExtrinsicList = {
  __typename?: 'ExtrinsicList';
  items: Array<Extrinsic>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  /** Page count -- this feed has no cheap grand total, matching REST's extrinsic_count. */
  total: Scalars['Int']['output'];
};

/** Registry-wide interface gap report page. Mirrors GET /api/v1/gaps (and MCP list_gaps). */
export type GapsList = {
  __typename?: 'GapsList';
  cursor: Scalars['Int']['output'];
  gaps: Array<Scalars['JSON']['output']>;
  generated_at?: Maybe<Scalars['String']['output']>;
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  notes?: Maybe<Scalars['JSON']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  returned: Scalars['Int']['output'];
  sort?: Maybe<Scalars['String']['output']>;
  total: Scalars['Int']['output'];
};

export type GlobalHealth = {
  __typename?: 'GlobalHealth';
  avg_latency_ms?: Maybe<Scalars['Int']['output']>;
  degraded_count?: Maybe<Scalars['Int']['output']>;
  failed_count?: Maybe<Scalars['Int']['output']>;
  generated_at?: Maybe<Scalars['String']['output']>;
  health_source?: Maybe<Scalars['String']['output']>;
  last_checked?: Maybe<Scalars['String']['output']>;
  last_ok?: Maybe<Scalars['String']['output']>;
  latency_sample_count?: Maybe<Scalars['Int']['output']>;
  ok_count?: Maybe<Scalars['Int']['output']>;
  operational_observed_at?: Maybe<Scalars['String']['output']>;
  scope?: Maybe<Scalars['String']['output']>;
  status?: Maybe<Scalars['String']['output']>;
  subnets: Array<SubnetHealth>;
  surface_count?: Maybe<Scalars['Int']['output']>;
  unknown_count?: Maybe<Scalars['Int']['output']>;
};

/** Global endpoint-incident ledger (#5660). Mirrors GET /api/v1/incidents' data envelope. */
export type GlobalIncidents = {
  __typename?: 'GlobalIncidents';
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  source?: Maybe<Scalars['String']['output']>;
  /** Aggregate counts -- incident_count, active_count, and by_kind/by_layer/by_provider/by_severity/by_status maps. Opaque JSON: the by_* maps are dynamic-keyed, matching the MCP get_global_incidents summary shape. */
  summary?: Maybe<Scalars['JSON']['output']>;
  surfaces: Array<EndpointIncident>;
  window?: Maybe<Scalars['String']['output']>;
};

export type HealthHistory = {
  __typename?: 'HealthHistory';
  cursor: Scalars['Int']['output'];
  date?: Maybe<Scalars['String']['output']>;
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  returned: Scalars['Int']['output'];
  sort?: Maybe<Scalars['String']['output']>;
  summary?: Maybe<Scalars['JSON']['output']>;
  surfaces: Array<Scalars['JSON']['output']>;
  total: Scalars['Int']['output'];
};

/** All-subnet 7d/30d daily uptime + latency trend matrix from the live health-probe history. Mirrors GET /api/v1/health/trends' data envelope. */
export type HealthTrends = {
  __typename?: 'HealthTrends';
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  source?: Maybe<Scalars['String']['output']>;
  /** The 7d/30d windows keyed by window label (7d, 30d), each holding days/granularity/subnet_count and the per-subnet daily point series. Opaque JSON: dynamic-keyed by window label, matching the get_health_trends MCP/REST shape. */
  windows: Scalars['JSON']['output'];
};

/** One subnet's on-chain hyperparameter block. Every field is nullable: a value absent from the captured row stays null rather than being coerced. *_ratio fields are 0..1 U16-derived ratios; *_tao fields are rao-exact (9dp); bonds_moving_avg_raw is the unscaled on-chain integer. */
export type Hyperparameters = {
  __typename?: 'Hyperparameters';
  activity_cutoff?: Maybe<Scalars['Int']['output']>;
  activity_cutoff_factor?: Maybe<Scalars['Int']['output']>;
  alpha_high_ratio?: Maybe<Scalars['Float']['output']>;
  alpha_low_ratio?: Maybe<Scalars['Float']['output']>;
  alpha_sigmoid_steepness?: Maybe<Scalars['Float']['output']>;
  bonds_moving_avg_raw?: Maybe<Scalars['Int']['output']>;
  bonds_reset_enabled?: Maybe<Scalars['Boolean']['output']>;
  burn_half_life?: Maybe<Scalars['Int']['output']>;
  burn_increase_mult?: Maybe<Scalars['Float']['output']>;
  commit_reveal_enabled?: Maybe<Scalars['Boolean']['output']>;
  commit_reveal_period?: Maybe<Scalars['Int']['output']>;
  immunity_period?: Maybe<Scalars['Int']['output']>;
  kappa_ratio?: Maybe<Scalars['Float']['output']>;
  liquid_alpha_enabled?: Maybe<Scalars['Boolean']['output']>;
  max_burn_tao?: Maybe<Scalars['Float']['output']>;
  max_regs_per_block?: Maybe<Scalars['Int']['output']>;
  max_validators?: Maybe<Scalars['Int']['output']>;
  max_weight_limit_ratio?: Maybe<Scalars['Float']['output']>;
  min_allowed_weights?: Maybe<Scalars['Int']['output']>;
  min_burn_tao?: Maybe<Scalars['Float']['output']>;
  min_childkey_take_ratio?: Maybe<Scalars['Float']['output']>;
  owner_cut_auto_lock_enabled?: Maybe<Scalars['Boolean']['output']>;
  owner_cut_enabled?: Maybe<Scalars['Boolean']['output']>;
  registration_allowed?: Maybe<Scalars['Boolean']['output']>;
  serving_rate_limit?: Maybe<Scalars['Int']['output']>;
  subnet_is_active?: Maybe<Scalars['Boolean']['output']>;
  target_regs_per_interval?: Maybe<Scalars['Int']['output']>;
  tempo?: Maybe<Scalars['Int']['output']>;
  transfers_enabled?: Maybe<Scalars['Boolean']['output']>;
  user_liquidity_enabled?: Maybe<Scalars['Boolean']['output']>;
  weights_rate_limit?: Maybe<Scalars['Int']['output']>;
  weights_version?: Maybe<Scalars['Int']['output']>;
  yuma_version?: Maybe<Scalars['Int']['output']>;
};

/** One observed hyperparameter change: the full block as of that block_number, plus the hash the diff-on-change writer keyed it by. */
export type HyperparamsHistoryEntry = {
  __typename?: 'HyperparamsHistoryEntry';
  block_number?: Maybe<Scalars['Int']['output']>;
  hyperparameters?: Maybe<Hyperparameters>;
  hyperparams_hash?: Maybe<Scalars['String']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
};

/** Self-reported on-chain identity (SubtensorModule::set_identity) for a coldkey. */
export type Identity = {
  __typename?: 'Identity';
  additional?: Maybe<Scalars['String']['output']>;
  captured_at?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  discord?: Maybe<Scalars['String']['output']>;
  github?: Maybe<Scalars['String']['output']>;
  has_identity: Scalars['Boolean']['output'];
  image?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  url?: Maybe<Scalars['String']['output']>;
};

export type IncidentList = {
  __typename?: 'IncidentList';
  cursor: Scalars['Int']['output'];
  generated_at?: Maybe<Scalars['String']['output']>;
  incidents: Array<Scalars['JSON']['output']>;
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  notes?: Maybe<Scalars['JSON']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  returned: Scalars['Int']['output'];
  sort?: Maybe<Scalars['String']['output']>;
  summary?: Maybe<Scalars['JSON']['output']>;
  total: Scalars['Int']['output'];
};

/** Live global Subtensor protocol/governance parameters, read live from chain via RPC. Each field is independently null on its own RPC failure (schema-stable). Mirrors GET /api/v1/network/parameters's data envelope. */
export type NetworkParameters = {
  __typename?: 'NetworkParameters';
  pending_childkey_cooldown_blocks?: Maybe<Scalars['Int']['output']>;
  queried_at: Scalars['String']['output'];
  schema_version: Scalars['Int']['output'];
  stake_threshold_tao?: Maybe<Scalars['Float']['output']>;
  tao_weight?: Maybe<Scalars['Float']['output']>;
};

/** Live drand randomness-beacon status read from chain via RPC. Each field is independently null on its own RPC failure (schema-stable). Mirrors GET /api/v1/network/randomness's data envelope. */
export type NetworkRandomness = {
  __typename?: 'NetworkRandomness';
  last_stored_round?: Maybe<Scalars['Int']['output']>;
  oldest_stored_round?: Maybe<Scalars['Int']['output']>;
  queried_at: Scalars['String']['output'];
  schema_version: Scalars['Int']['output'];
  stored_round_span?: Maybe<Scalars['Int']['output']>;
};

/** One neuron's live metagraph detail card (#5900). Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}: neuron is null when that UID is absent from the latest snapshot. */
export type Neuron = {
  __typename?: 'Neuron';
  block_number?: Maybe<Scalars['Int']['output']>;
  captured_at?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
  /** The UID's live metagraph row; null when absent from the latest snapshot. */
  neuron?: Maybe<NeuronState>;
  schema_version: Scalars['Int']['output'];
};

/** One neuron's per-day metagraph history. Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}/history. */
export type NeuronHistory = {
  __typename?: 'NeuronHistory';
  netuid: Scalars['Int']['output'];
  point_count: Scalars['Int']['output'];
  points: Array<NeuronHistoryPoint>;
  schema_version: Scalars['Int']['output'];
  uid: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One day's metagraph state for a single UID (NeuronState fields plus snapshot_date/captured_at/block_number). */
export type NeuronHistoryPoint = {
  __typename?: 'NeuronHistoryPoint';
  active?: Maybe<Scalars['Boolean']['output']>;
  axon?: Maybe<Scalars['String']['output']>;
  block_number?: Maybe<Scalars['Int']['output']>;
  captured_at?: Maybe<Scalars['String']['output']>;
  coldkey?: Maybe<Scalars['String']['output']>;
  consensus?: Maybe<Scalars['Float']['output']>;
  dividends?: Maybe<Scalars['Float']['output']>;
  emission_tao?: Maybe<Scalars['Float']['output']>;
  hotkey?: Maybe<Scalars['String']['output']>;
  incentive?: Maybe<Scalars['Float']['output']>;
  is_immunity_period?: Maybe<Scalars['Boolean']['output']>;
  rank?: Maybe<Scalars['Float']['output']>;
  registered_at_block?: Maybe<Scalars['Int']['output']>;
  snapshot_date: Scalars['String']['output'];
  stake_tao?: Maybe<Scalars['Float']['output']>;
  take?: Maybe<Scalars['Float']['output']>;
  trust?: Maybe<Scalars['Float']['output']>;
  uid?: Maybe<Scalars['Int']['output']>;
  validator_permit?: Maybe<Scalars['Boolean']['output']>;
  validator_trust?: Maybe<Scalars['Float']['output']>;
};

/** One UID's live metagraph state within a subnet (hot/cold keys, scores, stake/emission, axon, take). */
export type NeuronState = {
  __typename?: 'NeuronState';
  active?: Maybe<Scalars['Boolean']['output']>;
  /** Axon endpoint as host:port, or null when not served. */
  axon?: Maybe<Scalars['String']['output']>;
  coldkey?: Maybe<Scalars['String']['output']>;
  consensus?: Maybe<Scalars['Float']['output']>;
  dividends?: Maybe<Scalars['Float']['output']>;
  emission_tao?: Maybe<Scalars['Float']['output']>;
  hotkey?: Maybe<Scalars['String']['output']>;
  /** Estimated wall-clock ETA for immunity_expires_at_block, extrapolated from this snapshot's own block/timestamp at ~12s/block; null if that anchor is unavailable (#6640). */
  immunity_expires_at?: Maybe<Scalars['String']['output']>;
  /** The block immunity ends (registered_at_block + the subnet's live immunity_period); only present while is_immunity_period is true (#6640). */
  immunity_expires_at_block?: Maybe<Scalars['Int']['output']>;
  incentive?: Maybe<Scalars['Float']['output']>;
  is_immunity_period?: Maybe<Scalars['Boolean']['output']>;
  rank?: Maybe<Scalars['Float']['output']>;
  registered_at_block?: Maybe<Scalars['Int']['output']>;
  stake_tao?: Maybe<Scalars['Float']['output']>;
  /** Validator take/commission (0..1) from SubtensorModule::Delegates; null when no Delegates entry at capture. */
  take?: Maybe<Scalars['Float']['output']>;
  trust?: Maybe<Scalars['Float']['output']>;
  uid?: Maybe<Scalars['Int']['output']>;
  validator_permit?: Maybe<Scalars['Boolean']['output']>;
  validator_trust?: Maybe<Scalars['Float']['output']>;
};

/** One nominating coldkey's staking activity toward a validator within the window. */
export type Nominator = {
  __typename?: 'Nominator';
  coldkey: Scalars['String']['output'];
  event_count: Scalars['Int']['output'];
  /** staked_tao + unstaked_tao (total churn, regardless of direction). */
  gross_staked_tao: Scalars['Float']['output'];
  /** Most recent StakeAdded/StakeRemoved time for this coldkey; null when unstamped. */
  last_observed_at?: Maybe<Scalars['String']['output']>;
  /** staked_tao - unstaked_tao. */
  net_staked_tao: Scalars['Float']['output'];
  staked_tao: Scalars['Float']['output'];
  unstaked_tao: Scalars['Float']['output'];
};

/** One validator's nominator leaderboard (#5692). Mirrors GET /api/v1/validators/{hotkey}/nominators' data envelope. */
export type NominatorList = {
  __typename?: 'NominatorList';
  hotkey: Scalars['String']['output'];
  limit: Scalars['Int']['output'];
  /** Total distinct nominating coldkeys in the window, before limit/offset paging. */
  nominator_count: Scalars['Int']['output'];
  nominators: Array<Nominator>;
  offset: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
  /** The resolved sort actually applied (an omitted sort resolves to net_staked). */
  sort: Scalars['String']['output'];
  /** The resolved window label; null only if the builder was handed no window. */
  window?: Maybe<Scalars['String']['output']>;
};

/** One (hotkey, netuid) delegation this account holds, reconstructed from the nominator-positions ledger joined against the hotkey's live stake_tao for that netuid. */
export type NominatorPosition = {
  __typename?: 'NominatorPosition';
  hotkey: Scalars['String']['output'];
  netuid: Scalars['Int']['output'];
  /** This account's share of the hotkey's total alpha-pool shares on this subnet (0..1), not a TAO amount. */
  share_fraction: Scalars['Float']['output'];
  stake_tao: Scalars['Float']['output'];
};

export type OpportunityBoards = {
  __typename?: 'OpportunityBoards';
  biggest_alpha_gain_1d: Array<OpportunityEntry>;
  biggest_alpha_gain_7d: Array<OpportunityEntry>;
  cheapest_registration: Array<OpportunityEntry>;
  highest_emission: Array<OpportunityEntry>;
  observed_at?: Maybe<Scalars['String']['output']>;
  open_slots: Array<OpportunityEntry>;
  validator_headroom: Array<OpportunityEntry>;
  with_economics_count: Scalars['Int']['output'];
};

export type OpportunityEntry = {
  __typename?: 'OpportunityEntry';
  alpha_price_change_1d?: Maybe<Scalars['Float']['output']>;
  alpha_price_change_7d?: Maybe<Scalars['Float']['output']>;
  alpha_price_tao?: Maybe<Scalars['Float']['output']>;
  emission_share?: Maybe<Scalars['Float']['output']>;
  max_uids?: Maybe<Scalars['Int']['output']>;
  max_validators?: Maybe<Scalars['Int']['output']>;
  miner_count?: Maybe<Scalars['Int']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
  open_slots?: Maybe<Scalars['Int']['output']>;
  registration_allowed?: Maybe<Scalars['Boolean']['output']>;
  registration_cost_tao?: Maybe<Scalars['Float']['output']>;
  slug?: Maybe<Scalars['String']['output']>;
  total_stake_tao?: Maybe<Scalars['Float']['output']>;
  validator_count?: Maybe<Scalars['Int']['output']>;
  validator_headroom?: Maybe<Scalars['Int']['output']>;
};

/** Shared by endpoint_pools and rpc_pools -- same pools[] row shape, filter/sort/page surface, and pagination-metadata fields (#6570); rpc_pools additionally populates source/operational_observed_at from its live cron overlay, which endpoint_pools leaves null. */
export type PoolList = {
  __typename?: 'PoolList';
  cursor: Scalars['Int']['output'];
  generated_at?: Maybe<Scalars['String']['output']>;
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  notes?: Maybe<Scalars['JSON']['output']>;
  operational_observed_at?: Maybe<Scalars['String']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  pools: Array<Scalars['JSON']['output']>;
  returned: Scalars['Int']['output'];
  sort?: Maybe<Scalars['String']['output']>;
  source?: Maybe<Scalars['String']['output']>;
  total: Scalars['Int']['output'];
};

export type ProfileList = {
  __typename?: 'ProfileList';
  captured_at?: Maybe<Scalars['String']['output']>;
  cursor: Scalars['Int']['output'];
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  profiles: Array<Scalars['JSON']['output']>;
  returned: Scalars['Int']['output'];
  sort?: Maybe<Scalars['String']['output']>;
  total: Scalars['Int']['output'];
};

export type Provider = {
  __typename?: 'Provider';
  authority?: Maybe<Scalars['String']['output']>;
  contact_url?: Maybe<Scalars['String']['output']>;
  docs_url?: Maybe<Scalars['String']['output']>;
  endpoint_count?: Maybe<Scalars['Int']['output']>;
  /** This provider's endpoint/resource registry rows -- the nested companion to endpoint_count, mirroring GET /api/v1/providers/{slug}/endpoints. */
  endpoints: Array<Endpoint>;
  github_url?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  kind?: Maybe<Scalars['String']['output']>;
  logo_url?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  netuids: Array<Maybe<Scalars['Int']['output']>>;
  notes?: Maybe<Scalars['String']['output']>;
  public_notes?: Maybe<Scalars['String']['output']>;
  subnet_count?: Maybe<Scalars['Int']['output']>;
  /** The subnets this provider operates surfaces on. */
  subnets: Array<Subnet>;
  surface_count?: Maybe<Scalars['Int']['output']>;
  website_url?: Maybe<Scalars['String']['output']>;
};

export type ProviderList = {
  __typename?: 'ProviderList';
  items: Array<Provider>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  total: Scalars['Int']['output'];
};

export type Query = {
  __typename?: 'Query';
  /** One account's cross-subnet event-history summary by ss58 address; an address with no matching account_events rows resolves to a schema-stable zero summary, never null. Mirrors GET /api/v1/accounts/{ss58}. */
  account?: Maybe<AccountSummary>;
  /** One account's per-subnet axon-removal footprint over a 7d/30d/90d window (default 30d): AxonInfoRemoved count and first/last timestamps per subnet, an HHI concentration of where its teardown activity is focused, and the dominant subnet; an address with no removals in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/axon-removals. */
  account_axon_removals: AccountAxonRemovals;
  /** Live free+reserved balance in TAO for one Finney ss58 account, read directly from chain via RPC (KV-cached, not the Postgres tier). balance_tao is null on RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/accounts/{ss58}/balance. */
  account_balance?: Maybe<AccountBalance>;
  /** Live child-hotkey delegation graph (#6723) for one Finney ss58 account -- every child hotkey it currently delegates stake-weight to, per subnet, with the proportion charged -- read directly from chain via RPC (KV-cached, not the Postgres tier). subnets is null on RPC failure, distinct from a confirmed-empty [] (the account genuinely has no children on any subnet). Companion to account_parents. Mirrors GET /api/v1/accounts/{ss58}/children. */
  account_children?: Maybe<AccountChildren>;
  /** Rank who one account transacts native TAO with, by total transfer volume, from the Balances.Transfer feed: per counterparty the sent/received/net TAO, transfer count, and last block, plus scan totals. Pass counterparty=<ss58> (must differ from ss58) to drill into a single relationship instead -- its fund-flow totals plus direction-aware transfer evidence under relationship, newest first. limit caps the ranked list (default 20) or the relationship's transfer evidence (default 50); 1-100. An address with no transfers resolves to a schema-stable zero card, never null. Mirrors GET /api/v1/accounts/{ss58}/counterparties. */
  account_counterparties: AccountCounterparties;
  /** One account's per-subnet deregistration footprint over a 7d/30d/90d window (default 30d): NeuronDeregistered count and first/last timestamps per subnet, an HHI concentration of where its deregistration activity is focused, and the dominant subnet; an address with no deregistrations in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/deregistrations. */
  account_deregistrations: AccountDeregistrations;
  /** One coldkey's community-contributed entity labels (exchange/foundation/operator/other) plus every subnet-ownership tie it has via the chain_events SubnetOwnerChanged stream (either side of an automatic conviction-contest transfer). Only tracks automatic SubnetOwnerChanged transfers, not genesis ownership -- a coldkey that has held a subnet since registration and never lost it to a challenger will not appear in ownership_ties. An address with no labels or ties resolves to a schema-stable empty card, never null. Mirrors GET /api/v1/accounts/{ss58}/entities. */
  account_entities: AccountEntities;
  /** One account's first-party chain-event feed, newest first -- every event where this address is the hotkey OR coldkey (the union account_extrinsics does not use), each carrying its block/event index, event_kind, hotkey/coldkey, netuid/uid, amount_tao/alpha_amount, extrinsic_index and observed_at. kind filters to one event kind (e.g. StakeAdded, NeuronRegistered, AxonServed, WeightsSet); netuid scopes to one subnet; block_start/block_end bound the block-height range; page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). event_count is the page count, not a grand total. An address with no matching events resolves to a schema-stable empty feed, never null. Mirrors GET /api/v1/accounts/{ss58}/events. */
  account_events: AccountEvents;
  /** One account's signed-extrinsic feed, newest first -- the extrinsics whose signer is this address (matched by signer only, not the hotkey/coldkey union account_events uses), each carrying its block/index, hash, call_module/call_function, decoded call_args, success flag, fee and tip. block_start/block_end bound the block-height range; page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). extrinsic_count is the page count, not a grand total. An address that signed nothing resolves to a schema-stable empty feed, never null. Mirrors GET /api/v1/accounts/{ss58}/extrinsics. */
  account_extrinsics: AccountExtrinsics;
  /** One account's durable per-day activity series from the hotkey-keyed account_events_daily rollup, newest day first -- each day's netuid, event_count, event_kinds, and first/last block. netuid filters to one subnet; from/to are YYYY-MM-DD bounds; page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). day_count is the page count, not a grand total. Note: the rollup is hotkey-attributed only -- a coldkey-only address returns zero days even when account_events shows activity. An address with no matching days resolves to a schema-stable empty series, never null. Mirrors GET /api/v1/accounts/{ss58}/history. */
  account_history: AccountHistory;
  /** One account's on-chain identity (its latest set_identity values, sanitized at serve time). has_identity is false with every field null for an account that never set one -- the common case, so this is a schema-stable card, never null and never a GraphQL error. Mirrors GET /api/v1/accounts/{ss58}/identity. */
  account_identity: AccountIdentity;
  /** One account's on-chain identity change history, newest first -- an append-only diff-tracking timeline (name/url/github/image/discord/description/additional plus a stable hash per entry). Page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). An address with no identity-history rows resolves to a schema-stable empty timeline, never null. Mirrors GET /api/v1/accounts/{ss58}/identity-history. */
  account_identity_history: AccountIdentityHistory;
  /** Live parent-hotkey delegation graph (#6723) for one Finney ss58 account -- every hotkey currently delegating stake-weight to it, per subnet -- read directly from chain via RPC (KV-cached, not the Postgres tier). subnets is null on RPC failure, distinct from a confirmed-empty [] (the account genuinely has no parents on any subnet). Companion to account_children. Mirrors GET /api/v1/accounts/{ss58}/parents. */
  account_parents?: Maybe<AccountParents>;
  /** One wallet's cross-subnet neuron portfolio: every subnet where the hotkey is a registered neuron, each position's economics (stake, emission, rank, trust, incentive, dividends, role) and emission/stake yield, plus wallet-level aggregates (totals, counts, overall return, stake concentration). Richer than account.registrations (registration footprint only). An address with no registered neurons resolves to a schema-stable empty card, never null. Mirrors GET /api/v1/accounts/{ss58}/portfolio. */
  account_portfolio: AccountPortfolio;
  /** One account's per-subnet position (uid/role/active plus stake/emission/rank/trust/incentive/dividends/yield) day-by-day over a 7d/30d/90d/1y/all window (default 30d), newest first, one point per neuron_daily snapshot. An account with no rows for the subnet in the window resolves to a schema-stable empty-points card, never null. Mirrors GET /api/v1/accounts/{ss58}/subnets/{netuid}/history. */
  account_position_history: AccountPositionHistory;
  /** This account's reconstructed nominator-side positions: what it holds delegated across every hotkey/subnet, distinct from account_portfolio's hotkey-scoped view (a pure delegator shows near-zero there since its stake lives on someone ELSE's hotkey row). Root (netuid 0) stake is not covered -- root has no alpha pool, so an address that only holds root-delegated stake resolves to a schema-stable empty positions[], never null. Mirrors GET /api/v1/accounts/{ss58}/positions. */
  account_positions: AccountPositions;
  /** One account's Prometheus telemetry-serving footprint across subnets over a 7d/30d/90d window (default 30d) -- which subnets it announces a Prometheus endpoint on, how often, first/last announcement times, and an HHI concentration of where that activity is focused. An address with no matching announcements resolves to a schema-stable zeroed footprint, never null. Mirrors GET /api/v1/accounts/{ss58}/prometheus. */
  account_prometheus: AccountPrometheus;
  /** One account's per-subnet registration footprint over a 7d/30d/90d window (default 30d): NeuronRegistered count and first/last timestamps per subnet, an HHI concentration of where its registration activity is focused, and the dominant subnet; an address with no registrations in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/registrations. */
  account_registrations: AccountRegistrations;
  /** Live root-claim current state for one Finney ss58 account (#7229) — claim type, per-hotkey claimable rates, cumulative claimed watermarks, and per-netuid thresholds — read directly from chain via RPC (KV-cached, not the Postgres tier). claim_type/hotkeys are null on RPC failure, schema-stable, never a GraphQL error. Read-only; never submits claim_root. Mirrors GET /api/v1/accounts/{ss58}/root-claim. */
  account_root_claim?: Maybe<AccountRootClaim>;
  /** One account's per-subnet axon-serving footprint over a 7d/30d/90d window (default 30d): AxonServed announcement count and first/last timestamps per subnet, an HHI concentration of where its serving activity is focused, and the dominant subnet; an address with no announcements in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/serving. */
  account_serving: AccountServing;
  /** One account's StakeAdded/StakeRemoved flow per subnet over a 7d/30d/90d window (default 30d) -- net + gross flow, a direction label (accumulating/exiting/churning/idle), and an HHI concentration of where its flow is focused. direction narrows to inflow (in) or outflow (out) only; all (default) reports both sides. An address with no flow in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/stake-flow. */
  account_stake_flow: AccountStakeFlow;
  /** One account's per-subnet StakeMoved footprint over a 7d/30d/90d window (default 30d): movement count, first/last timestamps, and the alpha price (TAO) at its most recent move per subnet, an HHI concentration of where its re-delegation churn is focused, and the dominant subnet; an address with no moves in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/stake-moves. */
  account_stake_moves: AccountStakeMoves;
  /** One account's live cross-subnet footprint: every subnet where the hotkey is currently registered as a neuron, each with its netuid, uid, stake, validator-permit and active flag, plus a subnet_count. The registration snapshot only (netuid/uid/stake/permit/active) -- account_portfolio is the richer economics view over the same neurons. An unregistered or never-seen address resolves to a schema-stable empty footprint (subnet_count 0, subnets []), never null. Mirrors GET /api/v1/accounts/{ss58}/subnets. */
  account_subnets: AccountSubnets;
  /** One account's native-TAO transfer feed from the Balances.Transfer event stream, newest first -- each event's block/index, from/to, amount_tao, a direction relative to the queried address (sent = it paid, received = it was paid), and observed_at. direction narrows to sent | received only (default both); block_start/block_end bound the block-height range; page with limit/offset or cursor (opaque keyset from a prior response's next_cursor). An address with no transfers resolves to a schema-stable empty feed, never null. Mirrors GET /api/v1/accounts/{ss58}/transfers. */
  account_transfers: AccountTransfers;
  /** One account's (validator hotkey's) WeightsSet weight-setting footprint per subnet over a 7d/30d window (default 7d): each subnet's weight-set count with the first/last WeightsSet timestamps, plus account totals, an HHI concentration of where its weight-setting activity is focused, and the dominant subnet. An address with no weight-sets in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/accounts/{ss58}/weight-setters. */
  account_weight_setters: AccountWeightSetters;
  /** Site-wide accounts leaderboard -- every currently-registered hotkey, aggregated cross-subnet from the current neurons snapshot. Mirrors GET /api/v1/accounts. */
  accounts: AccountList;
  /** One adapter-backed public metrics snapshot by slug (e.g. 'gittensor', 'allways', 'sn-64'): the captured adapter snapshot, extension metadata, and netuid linkage. An invalid slug is a BAD_USER_INPUT error; a missing slug resolves to null (schema-stable, never a GraphQL error). Mirrors GET /api/v1/adapters/{slug}. */
  adapter?: Maybe<Adapter>;
  /** The agent-callable service catalog: without a netuid, the global index of subnets exposing callable services; with one, that subnet's full per-service catalog. Both are overlaid with live health exactly as REST composes them. Null when the catalog has not been baked. Opaque JSON, matching the get_agent_catalog MCP/REST shape. Mirrors GET /api/v1/agent-catalog. */
  agent_catalog?: Maybe<Scalars['JSON']['output']>;
  /** The machine-readable AI-resources index: the copyable agent prompt (/agent.md), MCP server install metadata and tool listing, the Bittensor skill, llms.txt, OpenAPI, and links to the agent-facing APIs. Use it to bootstrap an agent integration before calling the catalog/search fields. Null when the index has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the get_agent_resources MCP/REST shape. Mirrors GET /api/v1/agent-resources. */
  agent_resources?: Maybe<Scalars['JSON']['output']>;
  /** One block by numeric height or 0x block hash; block is null when the ref doesn't resolve (schema-stable, never a GraphQL error). Mirrors GET /api/v1/blocks/{ref}. */
  block?: Maybe<BlockDetail>;
  /** Every raw pallet.method event in one block from the Postgres all-events tier (ADR 0013), by numeric block_number, in read order. Distinct from block_events (the curated account-attributed D1 stream); requires the all-events data Worker, so it is a GraphQL error where that tier is unavailable (e.g. preview deploys). Mirrors GET /api/v1/blocks/{block_number}/chain-events. */
  block_chain_events: BlockChainEvents;
  /** The decoded, account-attributed chain events in one block by ref, in read order (event_index ASC), paginated with limit (1-1000, default 100)/offset. Returns block_number:null + events:[] for an unknown ref or cold store, never a GraphQL error. Mirrors GET /api/v1/blocks/{ref}/events. */
  block_events: BlockEvents;
  /** The extrinsics in one block by ref (numeric block_number or 0x hash), in natural read order (extrinsic_index ASC), paginated with limit (1-100, default 50)/offset. Returns block_number:null + extrinsics:[] for an unknown ref or cold store, never a GraphQL error. Mirrors GET /api/v1/blocks/{ref}/extrinsics. */
  block_extrinsics: BlockExtrinsics;
  /** Recent-block feed (newest first). Optionally filter by author (SS58), spec_version, block_start/block_end (inclusive block-height range), from/to (observed_at epoch-ms range — String args because epoch-ms exceeds GraphQL Int's 32-bit range, matching account_history), min_extrinsics, and min_events — the same filter set MCP list_blocks and GET /api/v1/blocks accept. Mirrors GET /api/v1/blocks. */
  blocks: BlockList;
  /** Block-production summary over the recent-block window -- counts, inter-block timing, throughput, and author-concentration. Every aggregate is null (never a GraphQL error) when the retired-D1 store is cold. Mirrors GET /api/v1/blocks/summary. */
  blocks_summary: BlocksSummary;
  /** The generated build summary: artifact inventory counts and sizes, subnet/provider/surface totals, coverage rollup, and publish metadata. Resolves to a GraphQL error (not null) when the build-summary artifact has not been baked in this environment, matching the REST route's 404 and the get_build MCP tool. Mirrors GET /api/v1/build. */
  build: BuildSummary;
  /** The discovered candidate-surface ledger: every machine-discovered surface awaiting review, with its subnet (netuid), kind, provider, and review state. Filter by netuid/kind/provider/state and page with limit/cursor, exactly like the REST route. Resolves to {items,total,next_cursor} as opaque JSON. Mirrors GET /api/v1/candidates. */
  candidates?: Maybe<Scalars['JSON']['output']>;
  /** Per-UTC-day network activity series over a 7d/30d window (default 7d): each UTC day's block count, extrinsic count (with its successful-extrinsic count and success rate), on-chain event count, and distinct signer count, newest day first. Computed live from the extrinsics/blocks tiers; a cold store yields a schema-stable empty series, never a GraphQL error. Mirrors GET /api/v1/chain/activity. */
  chain_activity: ChainActivity;
  /** Network-wide rolling 24h buy/sell alpha-volume leaderboard: every subnet with StakeAdded (buy) or StakeRemoved (sell) volume in the last 24h ranked by total_volume_tao, each carrying its full buy/sell/total volume + sentiment scorecard (vol_mcap_ratio always null here -- no per-subnet market-cap input at the network level), plus a network rollup with its own net/gross sentiment reading and the per-subnet total-volume spread, summed live from the account_events stream. Fixed 24h window (no window arg); limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/alpha-volume. */
  chain_alpha_volume: ChainAlphaVolume;
  /** Network-wide axon-removal (teardown) leaderboard over a 7d/30d window (default 7d): subnets ranked by AxonInfoRemoved events with each's distinct-remover count and removals-per-remover teardown intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The teardown counterpart of chain_serving's announcements -- where neurons are tearing endpoints down. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/axon-removals. */
  chain_axon_removals: ChainAxonRemovals;
  /** Extrinsic call-mix breakdown over a 7d/30d window (default 7d): the extrinsic count and share per call_module, or per call_module+call_function when group_by is module_function (default module), optionally scoped to a single call_module, ranked by count (limit default 50, max 100). Computed live from the extrinsics tier; a cold store yields a schema-stable empty breakdown, never a GraphQL error. Mirrors GET /api/v1/chain/calls. */
  chain_calls: ChainCalls;
  /** Network-wide stake & emission decentralization across every subnet's neurons at once: the raw stake/emission distribution, the same two lenses collapsed per controlling entity (an operator running hotkeys in ten subnets counts once, not ten times), and the permitted-validator stake distribution -- each as gini/HHI/Nakamoto/top-share/entropy. uids_per_entity is the network consolidation signal (1.0 = every UID a distinct owner). Current snapshot only (no window/params). Every metric block is null (never a GraphQL error) on a cold store. The network analog of subnet concentration. Mirrors GET /api/v1/chain/concentration. */
  chain_concentration: ChainConcentration;
  /** Network-wide neuron-deregistration leaderboard over a 7d/30d window (default 7d): subnets ranked by NeuronDeregistered events with each's distinct-hotkey count and deregistrations-per-hotkey churn intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The network-wide, exit-side counterpart of subnet_deregistrations -- where neurons are being pushed out. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/deregistrations. */
  chain_deregistrations: ChainDeregistrations;
  /** Paginated all-events feed (newest first) from the Postgres-backed all-events tier: each event's block, event index, pallet, method, decoded args, phase, and emitting extrinsic index. Filter by pallet/method/block/extrinsic; page with limit (1-200, default 50) and the opaque keyset cursor (or legacy before=block_number). An invalid filter combo is a GraphQL BAD_USER_INPUT error; a cold/unbound tier resolves to a schema-stable empty feed, never a GraphQL error. Reads the raw all-events tier -- distinct from account_events/subnet_events (the curated account-attributed streams, a different data source) and from Subscription.chainEvents (live WebSocket firehose). Mirrors GET /api/v1/chain-events. */
  chain_events: ChainEventsFeed;
  /** Chain-activity aggregate over the most recent N blocks (the blocks arg, 1-5000, default 1000, a stray large value silently capped) from the Postgres-backed all-events tier: the pallet.method event distribution, each with its count, busiest first. A non-positive/non-integer blocks is a GraphQL BAD_USER_INPUT error; a cold/unbound tier resolves to a schema-stable empty aggregate, never a GraphQL error. The aggregate sibling of chain_events (the raw feed). Mirrors GET /api/v1/chain-events/stats (and MCP get_chain_activity). */
  chain_events_stats: ChainEventsStats;
  /** Per-UTC-day network fee/tip series over a 7d/30d window (default 7d): each day's extrinsic count and total/avg/median fee + tip in TAO, plus the top fee-paying signers (limit default 25, max 100), optionally scoped to a single call_module. Computed live from the extrinsics tier; a cold store yields a schema-stable empty series, never a GraphQL error. Mirrors GET /api/v1/chain/fees. */
  chain_fees: ChainFees;
  /** Network-wide identity-change feed: the most-recent SubnetIdentitiesV3 changes across every subnet (each entry carries its netuid), newest first, capped by limit; a cold/absent store resolves to a schema-stable empty feed (count 0), never null. Mirrors GET /api/v1/chain/identity-history. */
  chain_identity_history: ChainIdentityHistory;
  /** Network-wide idle-stake rollup: every subnet's stake delegated to a currently-zero-dividends hotkey, ranked by idle_stake_tao, plus the network total. Current snapshot only (no window/params). A cold store yields a schema-stable empty ranking, never a GraphQL error. Mirrors GET /api/v1/chain/idle-stake. */
  chain_idle_stake: ChainIdleStake;
  /** Network-wide reward-distribution & score-spread card across every subnet's neurons: incentive/dividends concentration (who actually captures rewards network-wide) plus the trust/consensus/validator_trust score spread. Current snapshot only (no window/params). Every metric block is null (never a GraphQL error) on a cold store. The network analog of subnet_performance. Mirrors GET /api/v1/chain/performance. */
  chain_performance: ChainPerformance;
  /** Network-wide Prometheus telemetry-endpoint announcement leaderboard over a 7d/30d window (default 7d): subnets ranked by PrometheusServed announcements with each's distinct-exporter count and announcements-per-exporter re-announcement intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The telemetry-endpoint companion to chain_serving's axon endpoints -- which subnets run observability infrastructure. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/prometheus. */
  chain_prometheus: ChainPrometheus;
  /** Network-wide neuron-registration leaderboard over a 7d/30d window (default 7d): subnets ranked by NeuronRegistered events with each's distinct-hotkey count and registrations-per-registrant re-registration intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The network-wide, entry-side counterpart of subnet_registrations -- where neurons are joining. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/registrations. */
  chain_registrations: ChainRegistrations;
  /** Network-wide axon-serving announcement leaderboard over a 7d/30d window (default 7d): subnets ranked by AxonServed announcements with each's distinct-server count and announcements-per-server re-announcement intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. The network-wide counterpart of subnet_serving. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/serving. */
  chain_serving: ChainServing;
  /** Most-active signer leaderboard over a 7d/30d window (default 7d): the accounts submitting the most extrinsics, each with its extrinsic count, total fees and tips paid in TAO, and last-seen block. Rank by tx_count (default) or total_fee_tao, optionally scoped to a single call_module pallet (limit default 50, max 100). Computed live from the extrinsics tier; a cold store yields a schema-stable empty leaderboard, never a GraphQL error. Mirrors GET /api/v1/chain/signers. */
  chain_signers: ChainSigners;
  /** Network-wide cross-subnet capital-flow leaderboard over a 7d/30d window (default 7d): subnets ranked by net StakeAdded minus StakeRemoved TAO with staked/unstaked/gross totals and an inflow/outflow/balanced direction label, plus a network rollup and the per-subnet net-flow spread, summed live from the account_events stream. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/stake-flow. */
  chain_stake_flow: ChainStakeFlow;
  /** Network-wide stake-movement (re-delegation) leaderboard over a 7d/30d window (default 7d): subnets ranked by StakeMoved events with each's distinct-mover count and movements-per-mover intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. StakeMoved relocates stake between hotkeys/subnets without unstaking -- re-delegation churn, not net capital flow. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/stake-moves. */
  chain_stake_moves: ChainStakeMoves;
  /** Network-wide stake-transfer (between-coldkeys) leaderboard over a 7d/30d window (default 7d): subnets ranked by StakeTransferred events with each's distinct-sender count and transfers-per-sender intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. StakeTransferred relocates ownership on the same hotkey -- not net capital or re-delegation churn. limit caps the leaderboard (default 20, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/stake-transfers. */
  chain_stake_transfers: ChainStakeTransfers;
  /** Network-wide directed native-TAO transfer-corridor leaderboard over a 7d/30d window (default 7d): top sender->receiver pairs ranked by volume (default) or transfer count, each with volume, count, and last block/time, plus a network rollup (total volume, transfer count, unique corridors, top-corridor share). Self-transfers and malformed rows are excluded. limit caps the corridors (default 25, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/transfer-pairs. */
  chain_transfer_pairs: ChainTransferPairs;
  /** Network-wide native-TAO transfer analytics over a 7d/30d window (default 7d): total Balances.Transfer volume and count, distinct senders/receivers, top senders and receivers ranked by volume, and the top senders' share of total volume. limit caps each leaderboard (default 25, max 100). A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/chain/transfers. */
  chain_transfers: ChainTransfers;
  /** Network-wide validator-set churn across all subnets over a 7d/30d/90d window (default 30d): every subnet ranked by gross validator churn (entered + exited) between the window's start and end snapshots, each with its retention and 0-100 stability score, plus a network rollup and the network-wide stability spread. neuron_daily-derived; comparable is false and the leaderboard empty on a cold or single-snapshot store, never null. Mirrors GET /api/v1/chain/turnover. */
  chain_turnover: ChainTurnover;
  /** Network-wide weight-setter leaderboard over a 7d/30d window (default 7d): the individual validators driving consensus network-wide, each with its total WeightsSet count, share of the network total, and first/last set times, ranked by activity. The setter-level drill-in behind chain_weights. Mirrors GET /api/v1/chain/weights/setters. */
  chain_weight_setters: ChainWeightSetters;
  /** Network-wide validator weight-setting activity leaderboard over a 7d/30d window (default 7d): subnets ranked by WeightsSet events with each's distinct-setter count and sets-per-setter update intensity, plus a network rollup and the per-subnet intensity spread, summed live from the account_events stream. Mirrors GET /api/v1/chain/weights. */
  chain_weights: ChainWeights;
  /** Network-wide emission-yield (return rate) aggregated across every subnet's neurons -- the aggregate network return, the same split by validator vs miner role, and the distribution of the per-neuron return rate. Every aggregate is null (never a GraphQL error) on a cold store. Mirrors GET /api/v1/chain/yield. */
  chain_yield: ChainYield;
  /** The latest generated registry changelog: artifact added/modified/removed rows, subnet added/removed/renamed events, and coverage deltas since the previous publish. Resolves to a GraphQL error (not null) when the changelog artifact has not been baked in this environment, matching the REST route's 404 and the get_changelog MCP tool. Mirrors GET /api/v1/changelog. */
  changelog?: Maybe<Changelog>;
  /** Cross-subnet comparison: registry structure, live economics, and live health placed side by side for the requested netuids, in requested order. Mirrors GET /api/v1/compare. */
  compare: Compare;
  /** Several validators side by side for a stake/delegate decision: each hotkey's take, estimated APY, nominator count, identity, and cross-subnet stake/emission/trust aggregates. hotkeys takes 1-16 distinct SS58 addresses (a real GraphQL list, like the sibling compare field's netuids, rather than REST's comma-separated string); the optional netuid adds each validator's membership row in that subnet. The validator equivalent of the compare field. Mirrors GET /api/v1/compare/validators. */
  compare_validators: ValidatorComparison;
  /** The registry's public artifact contract metadata: every baked artifact path, storage tier, schema reference, and consumer notes. Resolves to a GraphQL error (not null) when the contracts artifact has not been baked in this environment, matching the REST route's 404 and the get_contracts MCP tool. Mirrors GET /api/v1/contracts. */
  contracts?: Maybe<Contracts>;
  /** The registry coverage summary: surface/subnet counts, domain coverage, and overall completeness across the whole Bittensor application layer. Null when the coverage artifact has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the get_coverage MCP/REST shape. Mirrors GET /api/v1/coverage. */
  coverage?: Maybe<Scalars['JSON']['output']>;
  /** The machine-usable coverage-depth scorecard and ranked enrichment queue: per-subnet tier/score/priority rows plus the ranked queue of enrichment targets. Null when the coverage-depth artifact has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the /api/v1/coverage-depth REST shape. Mirrors GET /api/v1/coverage-depth. */
  coverage_depth?: Maybe<Scalars['JSON']['output']>;
  /** Curation states by subnet — each subnet's registry curation level and review state. Null when the artifact has not been baked. Opaque JSON passed through verbatim, matching the list_curation MCP/REST shape. Mirrors GET /api/v1/curation. */
  curation?: Maybe<Scalars['JSON']['output']>;
  /** One domain/capability tag's own rollup. tag must be one of the 14 fixed domain tags (the same enum ?domain= validates on subnets); an unknown tag is a BAD_USER_INPUT error. Mirrors GET /api/v1/domains/{tag}/summary. */
  domain_summary: DomainSummary;
  /** The per-domain rollup overview: every tag in the fixed 14-tag capability taxonomy with its member subnet count, total stake, total emission share, and within-domain emission concentration. Computed live from the subnets index + economics tier. Mirrors GET /api/v1/domains. */
  domains: DomainOverview;
  /** Paginated per-subnet economic + validator metrics. */
  economics: EconomicsList;
  /** Network-wide economics time series, aggregated per UTC day across all subnets; day_count is 0 and days is empty on a cold rollup, never null. Mirrors GET /api/v1/economics/trends. */
  economics_trends: EconomicsTrends;
  /** Probe-derived endpoint incident feed -- active endpoint failures/degradations with severity, state, provider, and subnet. Filter by netuid/kind/provider/status/severity/state, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/endpoint-incidents. */
  endpoint_incidents: IncidentList;
  /** Generalized endpoint pool scores -- each pool's kind, eligible/total endpoint count, and probe-derived routing score. Filter by id/kind, threshold with min_/max_eligible_count and min_/max_endpoint_count, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/endpoint-pools. */
  endpoint_pools: PoolList;
  /** Endpoint/resource registry, optionally scoped to one subnet. */
  endpoints: EndpointList;
  /** Network-wide public evidence ledger -- the append-only provenance record behind registry surfaces. Search with q across subject/claim/source_url/support_summary, sort with sort/order, project with fields, and page with limit (1-100)/cursor. An invalid sort/limit/cursor is a GraphQL error, not a silently substituted default. Distinct from subnet_evidence(netuid) (one subnet's claims). Mirrors GET /api/v1/evidence. */
  evidence: EvidenceList;
  /** Live EVM (H160) -> Substrate (SS58) account-address mapping for a 20-byte 0x-prefixed hex address, resolved directly from chain via RPC (not the Postgres tier). ss58 is null when the address has no association or the RPC lookup fails, schema-stable, never a GraphQL error. Mirrors GET /api/v1/evm/address/{h160}. */
  evm_address?: Maybe<EvmAddressMapping>;
  /** The get_evm_address_mapping-aligned name for evm_address, so the MCP tool name and this Query field line up. Structurally identical to evm_address -- same live RPC read, same validation, same schema-stable null on an unresolved mapping -- not a second lookup. Mirrors GET /api/v1/evm/address/{h160}. */
  evm_address_mapping?: Maybe<EvmAddressMapping>;
  /** One extrinsic by hash or composite block_number-extrinsic_index ref; extrinsic is null when the ref doesn't resolve (schema-stable, never a GraphQL error). Mirrors GET /api/v1/extrinsics/{ref}. */
  extrinsic?: Maybe<ExtrinsicDetail>;
  /** Recent-extrinsic feed (newest first), optionally filtered. Mirrors GET /api/v1/extrinsics. */
  extrinsics: ExtrinsicList;
  /** The recorded response fixtures for registered surfaces, used to replay/verify a surface without calling it. Null when no fixture index has been baked in this environment. Opaque JSON passed through verbatim, matching the list_fixtures MCP/REST shape. Mirrors GET /api/v1/fixtures. */
  fixtures?: Maybe<Scalars['JSON']['output']>;
  /** Artifact freshness: each published artifact's generated_at/age, merged with the live cron snapshot stamp when the health store is warm. Null when no freshness artifact has been baked. Opaque JSON, matching the get_freshness MCP/REST shape. Mirrors GET /api/v1/freshness. */
  freshness?: Maybe<Scalars['JSON']['output']>;
  /** Registry-wide interface gap report -- every active subnet's missing/unsupported public interface facets, gap_count, coverage_level, and curation_level. Filter by netuid/coverage_level/curation_level, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Distinct from subnet_gaps(netuid) (one subnet's contributor enrichment queue). Mirrors GET /api/v1/gaps. */
  gaps: GapsList;
  /** The get_global_incidents-aligned name for the same global downtime-incident ledger (#7643): identical 7d/30d window validation, tier fallback, and cold-tier degradation as incidents — a thin alias so MCP tool names and GraphQL fields line up. Distinct from endpoint_incidents (the active endpoint failure/degradation feed, GET /api/v1/endpoint-incidents): this is the historical incident ledger. Returns the typed GlobalIncidents envelope rather than the issue's literal JSON suggestion, matching incidents. Mirrors GET /api/v1/incidents. */
  global_incidents: GlobalIncidents;
  /** Subtensor's root-origin hyperparameter/network-config change feed (newest first) -- the extrinsics feed fixed to call_module=AdminUtils, so it takes no signer/call_module filter. Same ExtrinsicList shape as extrinsics. Mirrors GET /api/v1/governance/config-changes. */
  governance_config_changes: ExtrinsicList;
  /** Global operational health rollup with per-subnet summaries. */
  health?: Maybe<GlobalHealth>;
  /** A compact daily operational health snapshot for one UTC date (YYYY-MM-DD): per-surface status/latency plus summary incident counts from the archived health/history tier. Filter by netuid/kind/provider/status/classification, sort with sort/order, and page with limit (1-1000)/cursor. An invalid date/filter/sort/limit/cursor or a missing snapshot is a GraphQL error, not a silently substituted default. Distinct from the live health rollup and health_trends. Mirrors GET /api/v1/health/history/{date}. */
  health_history: HealthHistory;
  /** Compact all-subnet 7d/30d daily uptime + latency trend matrix from the live health-probe history (probed every ~15 minutes); a cold store still returns both windows, schema-stable and zeroed, never a GraphQL error. Mirrors GET /api/v1/health/trends. */
  health_trends: HealthTrends;
  /** Global endpoint-incident ledger over a 7d/30d window; degrades to a schema-stable empty ledger (never a GraphQL error) on a cold/retired health tier. Mirrors GET /api/v1/incidents. */
  incidents: GlobalIncidents;
  /** The maintainer-approved cross-network subnet lineage: which testnet subnets have graduated to mainnet (mainnet <-> testnet pairs with match evidence), plus any flagged broken links. Null when the lineage has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the get_lineage MCP/REST shape. Mirrors GET /api/v1/lineage. */
  lineage?: Maybe<Scalars['JSON']['output']>;
  /** Live global Subtensor protocol/governance parameters (TaoWeight, StakeThreshold, PendingChildKeyCooldown), read directly from chain via RPC (not the Postgres tier). Each field is independently null on its own RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/network/parameters. */
  network_parameters?: Maybe<NetworkParameters>;
  /** Live drand randomness-beacon status read directly from chain via RPC (not the Postgres tier): the newest and oldest stored beacon rounds and the span between them. Each field is independently null on its own RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/network/randomness. */
  network_randomness?: Maybe<NetworkRandomness>;
  /** One neuron in a subnet by UID: hot/cold keys, stake, rank, trust, consensus, incentive, dividends, emission, validator permit, immunity, axon, and take. The nested neuron field is null when that UID is absent from the latest snapshot -- a schema-stable card, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}. */
  neuron: Neuron;
  /** One neuron's per-day metagraph history in a subnet by UID from the neuron_daily rollup (window: 7d/30d/90d/1y/all, default 30d), newest first: stake, rank, trust, consensus, incentive, dividends, emission, validator permit, and axon per snapshot_date. A UID with no matching rows resolves to a schema-stable empty-points card, never null. Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}/history. */
  neuron_history: NeuronHistory;
  /** Cross-subnet economic opportunity boards (where to register, what it costs, where the emission and validator headroom are). */
  opportunity_boards: OpportunityBoards;
  /** Public-safe subnet profile index -- completeness scores, surface/interface counts, curation level, review state, and confidence for every registered subnet. Filter by netuid/subnet_type/curation_level/review_state/confidence/profile_level, search name/slug/project/team/categories with q, sort with sort/order, and page with limit (1-1000)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/profiles. */
  profiles: ProfileList;
  /** One provider with its subnets. */
  provider?: Maybe<Provider>;
  /** One provider's endpoint rows with full REST filter parity: filter by kind/layer/publication_state/status, latency and score ranges, sort + order, and page with limit/cursor. Composed live from the baked /metagraph/providers/{slug}/endpoints.json artifact. An unsupported filter/sort or an unknown provider is a GraphQL error (matching REST/MCP), not a silently substituted default. Opaque JSON passed through verbatim, matching the list_provider_endpoints MCP/REST shape. Mirrors GET /api/v1/providers/{slug}/endpoints. */
  provider_endpoints?: Maybe<Scalars['JSON']['output']>;
  /** Paginated provider/source registry -- filter by id/kind/authority, sort with sort/order, project with fields, and page with limit/cursor. An invalid filter/sort is a GraphQL error, not a silently substituted default. Cursor remains the pre-existing opaque string id-keyset (not REST's integer offset), and a cold/absent artifact still resolves to an empty list. Filter/sort reuse loadProvidersList (same logic as GET /api/v1/providers / list_providers). */
  providers: ProviderList;
  /** The get_randomness_status-aligned name for the same live drand beacon snapshot (#7649): identical loader, KV cache, and independently-null RPC-failure behavior as network_randomness — a thin alias so MCP tool names and GraphQL fields line up. Returns the typed NetworkRandomness envelope rather than the issue's literal JSON suggestion, matching network_randomness. Mirrors GET /api/v1/network/randomness. */
  randomness_status?: Maybe<NetworkRandomness>;
  /** Registry leaderboards: the operational boards (healthiest, fastest-rpc, most-complete, most-enriched, fastest-growing, most-reliable) and the economic-opportunity boards (open-slots, cheapest-registration, highest-emission, validator-headroom, biggest-alpha-gain-1d, biggest-alpha-gain-7d), composed live from the registry profiles projection plus D1 health/rpc/growth/reliability rows and the economics tier. Pass board to return just that board (default: every board); limit caps each board's entries (default 20, max 100). An unknown board is a BAD_USER_INPUT error, matching REST's invalid_query 400. Mirrors GET /api/v1/registry/leaderboards. */
  registry_leaderboards: RegistryLeaderboards;
  /** The registry-wide summary: overall subnet count, coverage/curation-level/profile-level counts, recent registry changes, and the most-complete top subnets. A fast orientation for the whole Bittensor application layer. Null when the summary has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the registry_summary MCP/REST shape. Mirrors GET /api/v1/registry/summary. */
  registry_summary?: Maybe<Scalars['JSON']['output']>;
  /** Subnets worth deeper adapter work -- recommended_adapter_kind, operational and candidate API kinds, priority_score, and reason_codes. Filter by netuid/curation_level/candidate_api_kinds/operational_kinds/recommended_adapter_kind/reason_codes, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/review/adapter-candidates. */
  review_adapter_candidates: ReviewAdapterCandidateList;
  /** Detailed candidate evidence behind the enrichment queue -- evidence_action, lane, missing kinds, and priority_score per subnet. Filter by netuid/lane/evidence_action/direct_submission_kinds/missing_kinds, search with q, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/review/enrichment-evidence. */
  review_enrichment_evidence: ReviewEnrichmentEvidenceList;
  /** Prioritized all-subnet enrichment queue -- lane, priority_score, missing kinds, and recommended_action per subnet. Filter by netuid/lane/evidence_action/identity_level/curation_level/profile_level/direct_submission_kinds/missing_kinds/manual_review_required/reason_codes/review_state, search with q, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/review/enrichment-queue. */
  review_enrichment_queue: ReviewEnrichmentQueueList;
  /** Contributor-facing enrichment targets -- target_type, target_action, lane, priority_score, and submission_route. Filter by netuid/target_type/target_action/kind/lane/evidence_action/identity_level/profile_level/submission_route/auto_review_candidate/manual_review_required/missing_kinds/reason_codes, search with q, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/review/enrichment-targets. */
  review_enrichment_targets: ReviewEnrichmentTargetList;
  /** Contributor-targeted review gap priorities -- priority_score, missing surface kinds, curation_level, and review_state. Distinct from the per-subnet subnet_gaps field and the global gaps ledger. Filter by netuid/curation_level/missing_kinds/review_state, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/review/gaps. */
  review_gaps: ReviewGapPriorityList;
  /** Contributor review queue of subnet profile-completeness gaps -- identity, native name, confidence, and promotion signals. Filter by netuid/profile_level/confidence/identity_level/identity_promotion_kinds/native_name_quality, sort with sort/order, and page with limit (1-100)/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/review/profile-completeness. */
  review_profile_completeness: ReviewProfileCompletenessList;
  /** The full catalog of monitored Bittensor base-layer RPC endpoints and their status (each endpoint's URL, network, and probe-derived health/latency), with the same live 15-minute cron RPC-pool overlay REST and MCP apply before serving. Filter by kind/layer/netuid/pool_eligible/provider/publication_state/status, threshold with min_/max_latency_ms and min_/max_score, project with fields, sort with sort/order, and page with limit/cursor. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default; a cold/absent catalog is likewise a GraphQL error (matching endpoint_pools / rpc_pools). Opaque JSON passed through verbatim, matching the list_rpc_endpoints MCP/REST shape. Mirrors GET /api/v1/rpc/endpoints. */
  rpc_endpoints?: Maybe<Scalars['JSON']['output']>;
  /** The load-balanced Bittensor RPC pool scores -- the RPC-specific predecessor of endpoint_pools (#6570): same pools[] row shape and filter/sort/page surface, with a live 15-minute cron eligibility overlay applied before filtering/sorting. An invalid filter/sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/rpc/pools. */
  rpc_pools: PoolList;
  /** RPC reverse-proxy usage analytics over a 7d/30d window (default 7d): total request volume, error + failover rates, cache-hit rate, latency p50/p95/avg, the per-endpoint and per-network request distribution, and bounded time buckets (1h for 7d, 6h for 30d), computed live from the rpc_proxy_events telemetry. A cold store yields a schema-stable zeroed card, never a GraphQL error. Mirrors GET /api/v1/rpc/usage. */
  rpc_usage: RpcUsage;
  /** Site-wide runtime spec-version transition timeline: the earliest known block at each distinct spec_version observed (ascending), the current spec_version, and where coverage starts. The empty shape (transition_count 0, current_spec_version null) is schema-stable, never a GraphQL error, when the store has no reading yet. Mirrors GET /api/v1/runtime. */
  runtime: RuntimeVersionHistory;
  /** Run one maintainer-curated saved-query template by id, with its template-defined params object -- the same parameterized query library REST and the run_saved_query MCP tool execute. Resolves to {query_id, params, data} as opaque JSON. An unknown id or invalid params is a BAD_USER_INPUT error listing the valid template ids, not a silently substituted default. Mirrors GET /api/v1/queries/{id}. */
  saved_query?: Maybe<Scalars['JSON']['output']>;
  /** The registry's captured API-schema index: which subnet surfaces publish a machine-readable OpenAPI/Swagger schema, each schema's hash, and its drift status (new/unchanged/changed). Null when the schema index has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the list_schemas MCP/REST shape. Mirrors GET /api/v1/schemas. */
  schemas?: Maybe<Scalars['JSON']['output']>;
  /** The full compact search index: one document per subnet/surface/provider/doc, each with its id, type, title, subtitle, url, and the per-document token blob that widens server-side recall. Documents are heterogeneous by type, so each is passed through as opaque JSON. Mirrors GET /api/v1/search. */
  search: SearchDocumentList;
  /** The slim search index -- the same documents as search without the per-document token blobs, for fast browser typeahead and listing. Mirrors GET /api/v1/search-index. */
  search_index: SearchDocumentList;
  /** The per-provider source-health rollup: for each provider/source, the candidate-surface count and its live/redirected/dead classification, endpoint and RPC-endpoint counts, verification-result count, and an overall status. Null when the rollup has not been baked in this environment (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the get_source_health MCP/REST shape. Mirrors GET /api/v1/source-health. */
  source_health?: Maybe<Scalars['JSON']['output']>;
  /** Per-source input-hash ledger -- each registry data source's captured input hash and record count at ingest time, for detecting hash drift or seeing per-source contribution volume. Filter with q (keyword search across id/kind/path), sort with sort/order, and page with limit (1-100)/cursor. An invalid sort/limit/cursor is a GraphQL error, not a silently substituted default. Mirrors GET /api/v1/source-snapshots. */
  source_snapshots: SourceSnapshotList;
  /** One subnet with its health, surfaces, endpoints, and economics. */
  subnet?: Maybe<Subnet>;
  /** Per-subnet axon-removal activity over a 7d/30d window (distinct removers, AxonInfoRemoved count, and removals per remover); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/axon-removals. */
  subnet_axon_removals: SubnetAxonRemovals;
  /** Live current registration/burn cost for one subnet -- the dynamic price between the static min_burn_tao/max_burn_tao bounds, read directly from chain via RPC (not the Postgres tier). burn_tao is null on RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/burn. */
  subnet_burn?: Maybe<SubnetBurn>;
  /** One subnet's unpromoted candidate-surface queue — the baked per-subnet /metagraph/candidates/{netuid}.json artifact the REST route and get_subnet_candidates MCP tool read. Filter with kind, provider, state, id, and confidence; sort with sort + order; and page with limit (1-100) / cursor, exactly as REST does — an unsupported filter/sort value is a GraphQL error, not a silently substituted default. The envelope carries the same pagination meta REST returns (total, returned, limit, cursor, next_cursor, sort, order) alongside the candidates rows. Null when no candidate artifact has been baked for the netuid (rather than a GraphQL error). Distinct from candidates(...) (the filterable network-wide candidate catalog). Mirrors GET /api/v1/subnets/{netuid}/candidates. */
  subnet_candidates?: Maybe<Scalars['JSON']['output']>;
  /** Per-subnet stake and emission concentration over the current neurons snapshot: raw-UID and per-entity Gini/HHI/Nakamoto/top-K share for stake and emission, validator-only stake concentration, and a uids-per-entity Sybil signal; a subnet with no neurons resolves to a schema-stable zeroed card (metric blocks null), never null. Mirrors GET /api/v1/subnets/{netuid}/concentration. */
  subnet_concentration: SubnetConcentration;
  /** Per-subnet per-day stake and emission concentration trend from the neuron_daily rollup over a 7d/30d/90d window (default 30d): each day's stake/emission Gini, Nakamoto coefficient, and top-10% share, newest first; a subnet with no daily rollup resolves to a schema-stable empty series (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/concentration/history. */
  subnet_concentration_history: SubnetConcentrationHistory;
  /** Live per-subnet conviction leaderboard (#6638, part of the conviction/ownership-contest tracker epic #4302) -- who currently holds the most rolled conviction, i.e. how close the subnet is to an automatic ownership flip. Companion to subnet_ownership_history (that's the event log of past flips; this is the current standings). A subnet with no active challengers/owner lock returns an empty leaderboard. Reaches the Postgres-only all-events tier directly; an out-of-range netuid or an unavailable tier is a GraphQL error, never a silent empty leaderboard. Mirrors GET /api/v1/subnets/{netuid}/conviction. */
  subnet_conviction: SubnetConviction;
  /** Per-subnet neuron-deregistration activity over a 7d/30d window (distinct deregistered hotkeys, NeuronDeregistered count, and deregistrations per hotkey); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/deregistrations. */
  subnet_deregistrations: SubnetDeregistrations;
  /** One subnet's chain-event activity summary over a 7d/30d/90d window (default 30d): total events, the per-kind and per-category breakdowns with hotkey/coldkey participation and TAO/alpha amounts, and a bounded newest-first recent-event list (limit 1-50, default 10). A subnet with no events resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/event-summary. */
  subnet_event_summary: SubnetEventSummary;
  /** One subnet's paginated first-party chain-event feed (newest first): each event's kind, block, UID, hot/cold keys, amount, and timestamp. Filter by kind and by block_start/block_end (inclusive block bounds); page with limit (1-1000, default 100)/offset. event_count is the page count, not a grand total. A subnet with no matching events resolves to a schema-stable empty feed, never null. Mirrors GET /api/v1/subnets/{netuid}/events. */
  subnet_events: SubnetEvents;
  /** One subnet's curation evidence record — the provenance trail (source URLs, checks, reviewer notes) behind its registry entry. Search with q across subject, claim, source_url, and support_summary; sort with sort + order; project with fields; and page with limit (1-100) / cursor, exactly as REST does — an unsupported sort/limit/cursor is a GraphQL error, not a silently substituted default. The envelope carries the same pagination meta REST returns (total, returned, limit, cursor, next_cursor, sort, order) alongside the claims rows. Null when no evidence record has been baked for the netuid (rather than a GraphQL error). Mirrors GET /api/v1/subnets/{netuid}/evidence. */
  subnet_evidence?: Maybe<Scalars['JSON']['output']>;
  /** One subnet's registry gap report — the reviewer-facing list of missing/incomplete surface coverage backing its curation state. Null when no gap report has been baked for the netuid (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the get_subnet_gaps MCP/REST shape. Mirrors GET /api/v1/subnets/{netuid}/gaps. */
  subnet_gaps?: Maybe<Scalars['JSON']['output']>;
  /** One subnet's current live operational-health card: the per-surface status/latency/last-ok rows from the latest ~15-minute cron probe (summarized into ok/degraded/failed/unknown counts) plus the cross-window reliability score. The at-a-glance base card completing the health family whose windowed views are subnet_health_trends/subnet_health_incidents/subnet_health_percentiles. A subnet with no live health data resolves to the same schema-stable unknown card (summary.status of unknown, empty surfaces), never null. Opaque JSON passed through verbatim, matching the get_subnet_health MCP/REST shape (the existing typed SubnetHealth is the flat health-list item, a different shape, so this base card is JSON like the sibling surfaces payloads). Mirrors GET /api/v1/subnets/{netuid}/health. */
  subnet_health?: Maybe<Scalars['JSON']['output']>;
  /** One subnet's per-surface SLA (uptime ratio) and reconstructed downtime incidents over a 7d/30d window (default 7d), computed live from the health-probe history: each surface's sample count, uptime_ratio, incident_count, total downtime_ms, and the gap-island incident list. A subnet with no probe history resolves to a schema-stable empty surfaces list, never null. Mirrors GET /api/v1/subnets/{netuid}/health/incidents. */
  subnet_health_incidents: SubnetHealthIncidents;
  /** One subnet's per-surface latency percentiles (p50/p90/p95/p99) over a 7d/30d window (default 7d), computed live from the success-only health-probe history. The latency-distribution companion of subnet_health_incidents' availability view. A subnet with no probe history resolves to a schema-stable empty surfaces list, never null. Mirrors GET /api/v1/subnets/{netuid}/health/percentiles. */
  subnet_health_percentiles: SubnetHealthPercentiles;
  /** One subnet's uptime + success-only latency trend windows (7d/30d) from the live health-probe history: per-window samples, uptime_ratio, latency sample count, and the per-surface uptime/latency series. A subnet with no probe history resolves to a schema-stable zeroed-windows card, never null. Mirrors GET /api/v1/subnets/{netuid}/health/trends. */
  subnet_health_trends: SubnetHealthTrends;
  /** One subnet's daily history from the neuron_daily rollup over a 7d/30d/90d/1y/all window (default 30d): neuron count, validator count, total stake (TAO), and total emission (TAO) per snapshot_date, newest first. A subnet with no daily rollup resolves to a schema-stable empty series (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/history. */
  subnet_history: SubnetHistory;
  /** One subnet's live on-chain hyperparameters (latest snapshot only). The hyperparameters block is null when the subnet has no captured row -- a schema-stable card, never a GraphQL error, matching the Query.block ref-lookup convention. Mirrors GET /api/v1/subnets/{netuid}/hyperparameters. */
  subnet_hyperparameters?: Maybe<SubnetHyperparameters>;
  /** One subnet's append-only hyperparameter-change history, newest first, one entry per observed change. Forward-only: entries exist only from when the diff-on-change write started. A subnet with no recorded changes resolves to an empty entry list, never null. Mirrors GET /api/v1/subnets/{netuid}/hyperparameters/history. */
  subnet_hyperparameters_history: SubnetHyperparamsHistory;
  /** Append-only on-chain SubnetIdentitiesV3 change timeline for one subnet (name, symbol, description, repo, website, discord, logo), newest first; page with limit/offset or follow next_cursor. A subnet with no matching events resolves to a schema-stable empty timeline (entry_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/identity-history. */
  subnet_identity_history: SubnetIdentityHistory;
  /** Per-subnet idle-stake scorecard from the current neurons snapshot: stake delegated to a hotkey earning zero dividends right now (no validator permit, or a permitted hotkey whose weight-setting output is zero), plus the neuron and idle-neuron counts; a subnet with no neurons resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/idle-stake. */
  subnet_idle_stake: SubnetIdleStake;
  /** Live subnet-lease state (#6719, part of the subnet-leasing/crowdloan-tracking epic #6717) -- whether a subnet is currently under a lease (a crowdfunded, time-boxed primary market for new subnets) and, if so, its terms and accumulated-but-undistributed alpha dividends, read directly from chain via RPC (not the Postgres tier). leased is null (not false) on RPC failure, distinct from a confirmed no-lease (leased:false); schema-stable, never a GraphQL error except for an out-of-range netuid. Mirrors GET /api/v1/subnets/{netuid}/lease. */
  subnet_lease?: Maybe<SubnetLease>;
  /** Every SubnetLeaseCreated/SubnetLeaseTerminated event one subnet has had (#6719, part of the subnet-leasing/crowdloan-tracking epic #6717), decoded from the account_events stream. Companion to subnet_lease (that's the current state; this is the event log). A subnet that has never been leased returns an empty list. Reaches the Postgres-only all-events tier directly; an out-of-range netuid or an unavailable tier is a GraphQL error, never a silent empty list. Mirrors GET /api/v1/subnets/{netuid}/lease/history. */
  subnet_lease_history: SubnetLeaseHistory;
  /** One subnet's live metagraph: every neuron with its uid, keys, stake, trust/consensus/incentive/dividends, emission, and axon, plus the subnet's aggregate counters. Set validator_permit to true to return only permit-holding validators. A subnet with no indexed neurons resolves to a schema-stable empty metagraph, never null. Opaque JSON passed through verbatim, matching the get_subnet_metagraph MCP/REST shape. Mirrors GET /api/v1/subnets/{netuid}/metagraph. */
  subnet_metagraph?: Maybe<Scalars['JSON']['output']>;
  /** Cross-subnet momentum leaderboard: every subnet ranked by its stake/emission/validator change between a window's start and end snapshots; movers is empty on a cold or single-snapshot store, never null. Mirrors GET /api/v1/subnets/movers. */
  subnet_movers: SubnetMovers;
  /** One subnet's alpha-price OHLC candles bucketed by interval (1h or 1d, default 1h) over the trailing days window (default 90, max 365), from the same executed-trade stream subnet_volume reads. A subnet with no trades resolves to a schema-stable empty candle list, never null. Mirrors GET /api/v1/subnets/{netuid}/ohlc. */
  subnet_ohlc: SubnetOhlc;
  /** One subnet's composed overview card: the baked static subnet record overlaid with live probe-derived health, exactly as the REST route composes it. Null when no overview has been baked for that netuid (rather than a GraphQL error). Opaque JSON passed through verbatim, matching the get_subnet MCP/REST shape. Mirrors GET /api/v1/subnets/{netuid}/overview. */
  subnet_overview?: Maybe<Scalars['JSON']['output']>;
  /** Every automatic ownership transfer one subnet has undergone (#6637, part of the conviction/ownership-contest tracker epic #4302), decoded from the chain_events SubnetOwnerChanged stream -- Bittensor subnet ownership is a permissionless, conviction-weighted contest that transfers automatically once a challenger's conviction overtakes the incumbent owner's, no vote required. A subnet that has never changed hands returns an empty list. Reaches the Postgres-only all-events tier directly (no D1 predecessor); an out-of-range netuid or an unavailable tier is a GraphQL error, never a silent empty list. Mirrors GET /api/v1/subnets/{netuid}/ownership-history. */
  subnet_ownership_history: SubnetOwnershipHistory;
  /** Per-subnet reward-distribution and score-spread card over the current neurons snapshot: incentive/dividends concentration plus p10–p90 trust/consensus/validator_trust; a subnet with no neurons resolves to a schema-stable zeroed card (metric blocks null), never null. Mirrors GET /api/v1/subnets/{netuid}/performance. */
  subnet_performance: SubnetPerformance;
  /** Per-subnet per-day reward-distribution and score-spread trend from the neuron_daily rollup over a 7d/30d/90d window (default 30d): each day's incentive/dividends Gini, Nakamoto coefficient, and top-10% share plus mean/median trust, consensus, and validator_trust, newest first; a subnet with no daily rollup resolves to a schema-stable empty series (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/performance/history. */
  subnet_performance_history: SubnetPerformanceHistory;
  /** One subnet's contributor-review profile: candidate surfaces, contract version, endpoints, and completeness/curation metadata. Null when no profile has been baked for that netuid (rather than a GraphQL error); a negative netuid is a BAD_USER_INPUT error. Opaque JSON passed through verbatim, matching the get_subnet_profile MCP/REST shape. Mirrors GET /api/v1/subnets/{netuid}/profile. */
  subnet_profile?: Maybe<Scalars['JSON']['output']>;
  /** Per-subnet Prometheus telemetry-endpoint serving activity over a 7d/30d window (default 7d): distinct exporters (hotkeys), PrometheusServed announcement count, and announcements per exporter, summed live from the account_events stream. A subnet with no announcements resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/prometheus. */
  subnet_prometheus: SubnetPrometheus;
  /** Live cumulative TAO recycled for registration on one subnet, read directly from chain via RPC (not the Postgres tier). recycled_tao is null on RPC failure, schema-stable, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/recycled. */
  subnet_recycled?: Maybe<SubnetRecycled>;
  /** Per-subnet neuron-registration activity over a 7d/30d window (distinct registrants, NeuronRegistered count, and registrations per registrant); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/registrations. */
  subnet_registrations: SubnetRegistrations;
  /** Per-subnet axon-serving activity over a 7d/30d window (distinct servers, AxonServed announcement count, and announcements per server); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/serving. */
  subnet_serving: SubnetServing;
  /** Per-subnet net stake flow over a 7d/30d/90d window (default 30d): TAO staked (StakeAdded) vs unstaked (StakeRemoved), the net capital flow, and event counts, summed live from the account_events stream. direction narrows to inflow (in) or outflow (out); all (default) reports both. A subnet with no events resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/stake-flow. */
  subnet_stake_flow: SubnetStakeFlow;
  /** Per-subnet stake-movement (re-delegation) activity over a 7d/30d window (distinct movers, StakeMoved count, and movements per mover); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/stake-moves. */
  subnet_stake_moves: SubnetStakeMoves;
  /** A read-only quote for a hypothetical stake/unstake against one subnet's live AMM pool: expected amount out, spot vs effective price, and estimated price impact. Computes nothing on-chain and signs nothing. Mirrors GET /api/v1/subnets/{netuid}/stake-quote. */
  subnet_stake_quote: SubnetStakeQuote;
  /** Per-subnet stake-transfer activity over a 7d/30d window (distinct senders, StakeTransferred count, and transfers per sender); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/stake-transfers. */
  subnet_stake_transfers: SubnetStakeTransfers;
  /** One subnet's weekly structural + economics trajectory from the daily snapshots: a chronological series of points (completeness/surface/endpoint counts plus validator/miner counts and economics — stake, alpha price, emission share, pool reserves, volume), and the latest-vs-window-ago deltas for the 7d and 30d windows. A subnet with no snapshots resolves to a schema-stable empty trajectory (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/trajectory. */
  subnet_trajectory: SubnetTrajectory;
  /** One subnet's validator/neuron-set turnover (entered/exited/retention/0-100 stability) between the boundary snapshots of a 7d/30d/90d/1y/all window (default 30d), from neuron_daily. comparable is false and the churn metrics zeroed on a single-snapshot or cold store, never null. Mirrors GET /api/v1/subnets/{netuid}/turnover. */
  subnet_turnover: SubnetTurnover;
  /** One subnet's long-term daily uptime history for its operational surfaces from the live surface_uptime_daily rollup: per-surface day series, window-wide uptime ratios, and reliability scores for the requested window (90d or 1y, default 90d). Optional min_samples drops day rows whose daily probe count is below the threshold (including zero-sample 'unknown' days). A subnet with no history resolves to a schema-stable empty card (surfaces []), never null. Mirrors GET /api/v1/subnets/{netuid}/uptime. */
  subnet_uptime: SubnetUptime;
  /** One subnet's current validator set (permitted neurons) from the live metagraph snapshot, with each validator's full neuron record. A subnet with no snapshot resolves to a schema-stable empty list, never null. Mirrors GET /api/v1/subnets/{netuid}/validators. */
  subnet_validators: SubnetValidatorList;
  /** One subnet's rolling 24h alpha trading volume from the StakeAdded/StakeRemoved trade stream: buy/sell volume in alpha and TAO, trade counts, net flow, a buy-vs-sell sentiment ratio, and volume-to-market-cap ratio. A subnet with no trades resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/volume. */
  subnet_volume: SubnetVolume;
  /** Per-subnet weight-setter leaderboard over a 7d/30d window (default 7d): the individual validators behind /weights ranked by WeightsSet activity, each with count, share, and first/last set times; a subnet with no events resolves to a schema-stable empty leaderboard, never null. Mirrors GET /api/v1/subnets/{netuid}/weights/setters. */
  subnet_weight_setters: SubnetWeightSetters;
  /** Per-subnet validator weight-setting activity over a 7d/30d window (distinct weight-setters, WeightsSet count, and sets per setter); a subnet with no events in the window resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/weights. */
  subnet_weights: SubnetWeights;
  /** Per-subnet emission-per-stake yield over the current metagraph snapshot: each UID's yield plus the subnet-wide aggregate and p25/median/p75/p90 distribution; a subnet with no neurons resolves to a schema-stable zeroed card, never null. Mirrors GET /api/v1/subnets/{netuid}/yield. */
  subnet_yield: SubnetYield;
  /** Per-subnet per-day emission-per-stake yield trend from the neuron_daily rollup over a 7d/30d/90d window (default 30d): each day's subnet-wide yield plus the mean/median/p25/p75/p90 distribution across UIDs, newest first; a subnet with no daily rollup resolves to a schema-stable empty series (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/yield/history. */
  subnet_yield_history: SubnetYieldHistory;
  /** Paginated active-subnet index. */
  subnets: SubnetList;
  /** Recent Sudo-pallet extrinsic feed (newest first): the chain's superuser governance calls, the same shape as the extrinsics feed with call_module fixed to Sudo (so no signer/call_module args). Mirrors GET /api/v1/sudo. */
  sudo: ExtrinsicList;
  /** The network's on-chain sudo (superuser) key hotkey, read live from chain via RPC (not the Postgres tier). hotkey is null on RPC failure or a renounced sudo, schema-stable, never a GraphQL error. Mirrors GET /api/v1/sudo/key. */
  sudo_key?: Maybe<SudoKey>;
  /** Curated public interface surfaces, optionally scoped to one subnet. */
  surfaces: SurfaceList;
  /** The largest TAO holders ranked by the chosen sort (total_tao by default), limit 1-100 (default 20). An unknown sort is a BAD_USER_INPUT error. Resolves to a schema-stable empty list when the holders tier is cold, never null. Opaque JSON, matching the get_top_holders MCP/REST shape. Mirrors GET /api/v1/accounts/top-holders. */
  top_holders?: Maybe<Scalars['JSON']['output']>;
  /** One validator's cross-subnet aggregate by hotkey; a hotkey with no validator_permit=1 rows resolves to a schema-stable zeroed aggregate, never null. Mirrors GET /api/v1/validators/{hotkey}. */
  validator?: Maybe<Validator>;
  /** One validator's cross-subnet staked-over-time history: one point per day (window: 7d/30d/90d/1y/all, default 30d), summed across every subnet it validates in, plus a rewards-per-1000-TAO rate. A hotkey with no matching neuron_daily rows resolves to a schema-stable empty-points card, never null. Mirrors GET /api/v1/validators/{hotkey}/history. */
  validator_history: ValidatorHistory;
  /** One validator's nominator leaderboard over a 7d/30d/90d window (default 30d): every coldkey that staked to or unstaked from this hotkey in the window, with its staked/unstaked/net/gross TAO, event count, and last-activity time, ranked by sort (net_staked | gross_staked | last_activity, default net_staked). An unsupported window/sort is a GraphQL error, not a silently substituted default; a hotkey with no nominators resolves to a schema-stable empty list, never null and never a GraphQL error. Mirrors GET /api/v1/validators/{hotkey}/nominators. */
  validator_nominators: NominatorList;
  /** Network-wide validator/operator leaderboard, grouped by hotkey across every subnet it operates in. Paginate with limit/cursor like providers. Mirrors GET /api/v1/validators. */
  validators: ValidatorList;
};


export type QueryAccountArgs = {
  ss58: Scalars['String']['input'];
};


export type QueryAccount_Axon_RemovalsArgs = {
  ss58: Scalars['String']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryAccount_BalanceArgs = {
  ss58: Scalars['String']['input'];
};


export type QueryAccount_ChildrenArgs = {
  ss58: Scalars['String']['input'];
};


export type QueryAccount_CounterpartiesArgs = {
  counterparty?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  ss58: Scalars['String']['input'];
};


export type QueryAccount_DeregistrationsArgs = {
  ss58: Scalars['String']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryAccount_EntitiesArgs = {
  ss58: Scalars['String']['input'];
};


export type QueryAccount_EventsArgs = {
  block_end?: InputMaybe<Scalars['Int']['input']>;
  block_start?: InputMaybe<Scalars['Int']['input']>;
  cursor?: InputMaybe<Scalars['String']['input']>;
  kind?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  ss58: Scalars['String']['input'];
};


export type QueryAccount_ExtrinsicsArgs = {
  block_end?: InputMaybe<Scalars['Int']['input']>;
  block_start?: InputMaybe<Scalars['Int']['input']>;
  cursor?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  ss58: Scalars['String']['input'];
};


export type QueryAccount_HistoryArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  from?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  ss58: Scalars['String']['input'];
  to?: InputMaybe<Scalars['String']['input']>;
};


export type QueryAccount_IdentityArgs = {
  ss58: Scalars['String']['input'];
};


export type QueryAccount_Identity_HistoryArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  ss58: Scalars['String']['input'];
};


export type QueryAccount_ParentsArgs = {
  ss58: Scalars['String']['input'];
};


export type QueryAccount_PortfolioArgs = {
  ss58: Scalars['String']['input'];
};


export type QueryAccount_Position_HistoryArgs = {
  netuid: Scalars['Int']['input'];
  ss58: Scalars['String']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryAccount_PositionsArgs = {
  ss58: Scalars['String']['input'];
};


export type QueryAccount_PrometheusArgs = {
  ss58: Scalars['String']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryAccount_RegistrationsArgs = {
  ss58: Scalars['String']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryAccount_Root_ClaimArgs = {
  ss58: Scalars['String']['input'];
};


export type QueryAccount_ServingArgs = {
  ss58: Scalars['String']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryAccount_Stake_FlowArgs = {
  direction?: InputMaybe<Scalars['String']['input']>;
  ss58: Scalars['String']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryAccount_Stake_MovesArgs = {
  ss58: Scalars['String']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryAccount_SubnetsArgs = {
  ss58: Scalars['String']['input'];
};


export type QueryAccount_TransfersArgs = {
  block_end?: InputMaybe<Scalars['Int']['input']>;
  block_start?: InputMaybe<Scalars['Int']['input']>;
  cursor?: InputMaybe<Scalars['String']['input']>;
  direction?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  ss58: Scalars['String']['input'];
};


export type QueryAccount_Weight_SettersArgs = {
  ss58: Scalars['String']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryAccountsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QueryAdapterArgs = {
  slug: Scalars['String']['input'];
};


export type QueryAgent_CatalogArgs = {
  netuid?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryBlockArgs = {
  ref: Scalars['String']['input'];
};


export type QueryBlock_Chain_EventsArgs = {
  block_number: Scalars['Int']['input'];
};


export type QueryBlock_EventsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  ref: Scalars['String']['input'];
};


export type QueryBlock_ExtrinsicsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  ref: Scalars['String']['input'];
};


export type QueryBlocksArgs = {
  author?: InputMaybe<Scalars['String']['input']>;
  block_end?: InputMaybe<Scalars['Int']['input']>;
  block_start?: InputMaybe<Scalars['Int']['input']>;
  cursor?: InputMaybe<Scalars['String']['input']>;
  from?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  min_events?: InputMaybe<Scalars['Int']['input']>;
  min_extrinsics?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  spec_version?: InputMaybe<Scalars['Int']['input']>;
  to?: InputMaybe<Scalars['String']['input']>;
};


export type QueryCandidatesArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  kind?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  provider?: InputMaybe<Scalars['String']['input']>;
  state?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_ActivityArgs = {
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_Alpha_VolumeArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryChain_Axon_RemovalsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_CallsArgs = {
  call_module?: InputMaybe<Scalars['String']['input']>;
  group_by?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_DeregistrationsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_EventsArgs = {
  before?: InputMaybe<Scalars['Int']['input']>;
  block?: InputMaybe<Scalars['Int']['input']>;
  cursor?: InputMaybe<Scalars['String']['input']>;
  extrinsic?: InputMaybe<Scalars['Int']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  method?: InputMaybe<Scalars['String']['input']>;
  pallet?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_Events_StatsArgs = {
  blocks?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryChain_FeesArgs = {
  call_module?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_Identity_HistoryArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryChain_PrometheusArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_RegistrationsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_ServingArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_SignersArgs = {
  call_module?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_Stake_FlowArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_Stake_MovesArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_Stake_TransfersArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_Transfer_PairsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_TransfersArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_TurnoverArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_Weight_SettersArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryChain_WeightsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryCompareArgs = {
  dimensions?: InputMaybe<Array<Scalars['String']['input']>>;
  netuids: Array<Scalars['Int']['input']>;
};


export type QueryCompare_ValidatorsArgs = {
  hotkeys: Array<Scalars['String']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryDomain_SummaryArgs = {
  tag: Scalars['String']['input'];
};


export type QueryEconomicsArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryEconomics_TrendsArgs = {
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryEndpoint_IncidentsArgs = {
  cursor?: InputMaybe<Scalars['Int']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  kind?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  provider?: InputMaybe<Scalars['String']['input']>;
  severity?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
  state?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
};


export type QueryEndpoint_PoolsArgs = {
  cursor?: InputMaybe<Scalars['Int']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  id?: InputMaybe<Scalars['String']['input']>;
  kind?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  max_eligible_count?: InputMaybe<Scalars['Float']['input']>;
  max_endpoint_count?: InputMaybe<Scalars['Float']['input']>;
  min_eligible_count?: InputMaybe<Scalars['Float']['input']>;
  min_endpoint_count?: InputMaybe<Scalars['Float']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QueryEndpointsArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryEvidenceArgs = {
  cursor?: InputMaybe<Scalars['Int']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  q?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QueryEvm_AddressArgs = {
  h160: Scalars['String']['input'];
};


export type QueryEvm_Address_MappingArgs = {
  h160: Scalars['String']['input'];
};


export type QueryExtrinsicArgs = {
  ref: Scalars['String']['input'];
};


export type QueryExtrinsicsArgs = {
  block?: InputMaybe<Scalars['Int']['input']>;
  call_function?: InputMaybe<Scalars['String']['input']>;
  call_module?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  signer?: InputMaybe<Scalars['String']['input']>;
  success?: InputMaybe<Scalars['Boolean']['input']>;
};


export type QueryGapsArgs = {
  coverage_level?: InputMaybe<Scalars['String']['input']>;
  curation_level?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['Int']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QueryGlobal_IncidentsArgs = {
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryGovernance_Config_ChangesArgs = {
  block?: InputMaybe<Scalars['Int']['input']>;
  block_end?: InputMaybe<Scalars['Int']['input']>;
  block_start?: InputMaybe<Scalars['Int']['input']>;
  call_function?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['String']['input']>;
  from?: InputMaybe<Scalars['Int']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  success?: InputMaybe<Scalars['Boolean']['input']>;
  to?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryHealth_HistoryArgs = {
  classification?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['Int']['input']>;
  date: Scalars['String']['input'];
  fields?: InputMaybe<Scalars['String']['input']>;
  kind?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  provider?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
};


export type QueryIncidentsArgs = {
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryNeuronArgs = {
  netuid: Scalars['Int']['input'];
  uid: Scalars['Int']['input'];
};


export type QueryNeuron_HistoryArgs = {
  netuid: Scalars['Int']['input'];
  uid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryOpportunity_BoardsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryProfilesArgs = {
  confidence?: InputMaybe<Scalars['String']['input']>;
  curation_level?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['Int']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  profile_level?: InputMaybe<Scalars['String']['input']>;
  q?: InputMaybe<Scalars['String']['input']>;
  review_state?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
  subnet_type?: InputMaybe<Scalars['String']['input']>;
};


export type QueryProviderArgs = {
  id: Scalars['String']['input'];
};


export type QueryProvider_EndpointsArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  kind?: InputMaybe<Scalars['String']['input']>;
  layer?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  max_latency_ms?: InputMaybe<Scalars['Int']['input']>;
  max_score?: InputMaybe<Scalars['Float']['input']>;
  min_latency_ms?: InputMaybe<Scalars['Int']['input']>;
  min_score?: InputMaybe<Scalars['Float']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  publication_state?: InputMaybe<Scalars['String']['input']>;
  slug: Scalars['String']['input'];
  sort?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
};


export type QueryProvidersArgs = {
  authority?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['String']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  id?: InputMaybe<Scalars['String']['input']>;
  kind?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QueryRegistry_LeaderboardsArgs = {
  board?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryReview_Adapter_CandidatesArgs = {
  candidate_api_kinds?: InputMaybe<Scalars['String']['input']>;
  curation_level?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['Int']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  operational_kinds?: InputMaybe<Scalars['String']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  reason_codes?: InputMaybe<Scalars['String']['input']>;
  recommended_adapter_kind?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QueryReview_Enrichment_EvidenceArgs = {
  cursor?: InputMaybe<Scalars['Int']['input']>;
  direct_submission_kinds?: InputMaybe<Scalars['String']['input']>;
  evidence_action?: InputMaybe<Scalars['String']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  lane?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  missing_kinds?: InputMaybe<Scalars['String']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  q?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QueryReview_Enrichment_QueueArgs = {
  curation_level?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['Int']['input']>;
  direct_submission_kinds?: InputMaybe<Scalars['String']['input']>;
  evidence_action?: InputMaybe<Scalars['String']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  identity_level?: InputMaybe<Scalars['String']['input']>;
  lane?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  manual_review_required?: InputMaybe<Scalars['String']['input']>;
  missing_kinds?: InputMaybe<Scalars['String']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  profile_level?: InputMaybe<Scalars['String']['input']>;
  q?: InputMaybe<Scalars['String']['input']>;
  reason_codes?: InputMaybe<Scalars['String']['input']>;
  review_state?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QueryReview_Enrichment_TargetsArgs = {
  auto_review_candidate?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['Int']['input']>;
  evidence_action?: InputMaybe<Scalars['String']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  identity_level?: InputMaybe<Scalars['String']['input']>;
  kind?: InputMaybe<Scalars['String']['input']>;
  lane?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  manual_review_required?: InputMaybe<Scalars['String']['input']>;
  missing_kinds?: InputMaybe<Scalars['String']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  profile_level?: InputMaybe<Scalars['String']['input']>;
  q?: InputMaybe<Scalars['String']['input']>;
  reason_codes?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
  submission_route?: InputMaybe<Scalars['String']['input']>;
  target_action?: InputMaybe<Scalars['String']['input']>;
  target_type?: InputMaybe<Scalars['String']['input']>;
};


export type QueryReview_GapsArgs = {
  curation_level?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['Int']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  missing_kinds?: InputMaybe<Scalars['String']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  review_state?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QueryReview_Profile_CompletenessArgs = {
  confidence?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['Int']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  identity_level?: InputMaybe<Scalars['String']['input']>;
  identity_promotion_kinds?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  native_name_quality?: InputMaybe<Scalars['String']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  profile_level?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QueryRpc_EndpointsArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  fields?: InputMaybe<Array<Scalars['String']['input']>>;
  kind?: InputMaybe<Scalars['String']['input']>;
  layer?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  max_latency_ms?: InputMaybe<Scalars['Int']['input']>;
  max_score?: InputMaybe<Scalars['Float']['input']>;
  min_latency_ms?: InputMaybe<Scalars['Int']['input']>;
  min_score?: InputMaybe<Scalars['Float']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  pool_eligible?: InputMaybe<Scalars['Boolean']['input']>;
  provider?: InputMaybe<Scalars['String']['input']>;
  publication_state?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
};


export type QueryRpc_PoolsArgs = {
  cursor?: InputMaybe<Scalars['Int']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  id?: InputMaybe<Scalars['String']['input']>;
  kind?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  max_eligible_count?: InputMaybe<Scalars['Float']['input']>;
  max_endpoint_count?: InputMaybe<Scalars['Float']['input']>;
  min_eligible_count?: InputMaybe<Scalars['Float']['input']>;
  min_endpoint_count?: InputMaybe<Scalars['Float']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QueryRpc_UsageArgs = {
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySaved_QueryArgs = {
  id: Scalars['String']['input'];
  params?: InputMaybe<Scalars['JSON']['input']>;
};


export type QuerySearchArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QuerySearch_IndexArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QuerySource_SnapshotsArgs = {
  cursor?: InputMaybe<Scalars['Int']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  order?: InputMaybe<Scalars['String']['input']>;
  q?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnetArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_Axon_RemovalsArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_BurnArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_CandidatesArgs = {
  confidence?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['Int']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  id?: InputMaybe<Scalars['String']['input']>;
  kind?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid: Scalars['Int']['input'];
  order?: InputMaybe<Scalars['String']['input']>;
  provider?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
  state?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_ConcentrationArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_Concentration_HistoryArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_ConvictionArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_DeregistrationsArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_Event_SummaryArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_EventsArgs = {
  block_end?: InputMaybe<Scalars['Int']['input']>;
  block_start?: InputMaybe<Scalars['Int']['input']>;
  kind?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid: Scalars['Int']['input'];
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QuerySubnet_EvidenceArgs = {
  cursor?: InputMaybe<Scalars['Int']['input']>;
  fields?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid: Scalars['Int']['input'];
  order?: InputMaybe<Scalars['String']['input']>;
  q?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_GapsArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_HealthArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_Health_IncidentsArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_Health_PercentilesArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_Health_TrendsArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_HistoryArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_HyperparametersArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_Hyperparameters_HistoryArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid: Scalars['Int']['input'];
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QuerySubnet_Identity_HistoryArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid: Scalars['Int']['input'];
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QuerySubnet_Idle_StakeArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_LeaseArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_Lease_HistoryArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_MetagraphArgs = {
  netuid: Scalars['Int']['input'];
  validator_permit?: InputMaybe<Scalars['Boolean']['input']>;
};


export type QuerySubnet_MoversArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_OhlcArgs = {
  days?: InputMaybe<Scalars['Int']['input']>;
  interval?: InputMaybe<Scalars['String']['input']>;
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_OverviewArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_Ownership_HistoryArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_PerformanceArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_Performance_HistoryArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_ProfileArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_PrometheusArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_RecycledArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_RegistrationsArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_ServingArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_Stake_FlowArgs = {
  direction?: InputMaybe<Scalars['String']['input']>;
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_Stake_MovesArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_Stake_QuoteArgs = {
  amount: Scalars['Float']['input'];
  direction?: InputMaybe<Scalars['String']['input']>;
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_Stake_TransfersArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_TrajectoryArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_TurnoverArgs = {
  changes?: InputMaybe<Scalars['Boolean']['input']>;
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_UptimeArgs = {
  min_samples?: InputMaybe<Scalars['Int']['input']>;
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_ValidatorsArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_VolumeArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_Weight_SettersArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_WeightsArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnet_YieldArgs = {
  netuid: Scalars['Int']['input'];
};


export type QuerySubnet_Yield_HistoryArgs = {
  netuid: Scalars['Int']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySubnetsArgs = {
  coverage_level?: InputMaybe<Scalars['String']['input']>;
  curation_level?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['String']['input']>;
  domain?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
  subnet_type?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySudoArgs = {
  block?: InputMaybe<Scalars['Int']['input']>;
  call_function?: InputMaybe<Scalars['String']['input']>;
  cursor?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  success?: InputMaybe<Scalars['Boolean']['input']>;
};


export type QuerySurfacesArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  netuid?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryTop_HoldersArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};


export type QueryValidatorArgs = {
  hotkey: Scalars['String']['input'];
};


export type QueryValidator_HistoryArgs = {
  hotkey: Scalars['String']['input'];
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryValidator_NominatorsArgs = {
  coldkey?: InputMaybe<Scalars['String']['input']>;
  hotkey: Scalars['String']['input'];
  sort?: InputMaybe<Scalars['String']['input']>;
  window?: InputMaybe<Scalars['String']['input']>;
};


export type QueryValidatorsArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  sort?: InputMaybe<Scalars['String']['input']>;
};

/** Registry leaderboards over the operational + economic-opportunity boards. Mirrors GET /api/v1/registry/leaderboards. */
export type RegistryLeaderboards = {
  __typename?: 'RegistryLeaderboards';
  /** The board filter that was applied, or null when every board is returned. */
  board?: Maybe<Scalars['String']['output']>;
  /** Every board keyed by board name, each an array of ranked subnet entries capped at limit. Opaque JSON like HealthTrends.windows: the keys are dynamic AND hyphenated (fastest-rpc, most-complete, open-slots, …) so they are not expressible as GraphQL field names, and each board carries its own metric columns (healthiest has uptime_ratio/surfaces_ok, fastest-rpc has latency_ms, fastest-growing has completeness_delta, …). Passing it through verbatim keeps the REST/MCP get_registry_leaderboards shape byte-for-byte. */
  boards: Scalars['JSON']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  source?: Maybe<Scalars['String']['output']>;
};

export type ReviewAdapterCandidateList = {
  __typename?: 'ReviewAdapterCandidateList';
  candidates: Array<Scalars['JSON']['output']>;
  cursor: Scalars['Int']['output'];
  generated_at?: Maybe<Scalars['String']['output']>;
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  notes?: Maybe<Scalars['JSON']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  returned: Scalars['Int']['output'];
  sort?: Maybe<Scalars['String']['output']>;
  total: Scalars['Int']['output'];
};

export type ReviewEnrichmentEvidenceList = {
  __typename?: 'ReviewEnrichmentEvidenceList';
  cursor: Scalars['Int']['output'];
  entries: Array<Scalars['JSON']['output']>;
  generated_at?: Maybe<Scalars['String']['output']>;
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  notes?: Maybe<Scalars['JSON']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  returned: Scalars['Int']['output'];
  sort?: Maybe<Scalars['String']['output']>;
  total: Scalars['Int']['output'];
};

export type ReviewEnrichmentQueueList = {
  __typename?: 'ReviewEnrichmentQueueList';
  cursor: Scalars['Int']['output'];
  generated_at?: Maybe<Scalars['String']['output']>;
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  notes?: Maybe<Scalars['JSON']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  queue: Array<Scalars['JSON']['output']>;
  returned: Scalars['Int']['output'];
  sort?: Maybe<Scalars['String']['output']>;
  total: Scalars['Int']['output'];
};

export type ReviewEnrichmentTargetList = {
  __typename?: 'ReviewEnrichmentTargetList';
  cursor: Scalars['Int']['output'];
  generated_at?: Maybe<Scalars['String']['output']>;
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  notes?: Maybe<Scalars['JSON']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  returned: Scalars['Int']['output'];
  sort?: Maybe<Scalars['String']['output']>;
  targets: Array<Scalars['JSON']['output']>;
  total: Scalars['Int']['output'];
};

export type ReviewGapPriorityList = {
  __typename?: 'ReviewGapPriorityList';
  cursor: Scalars['Int']['output'];
  generated_at?: Maybe<Scalars['String']['output']>;
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  notes?: Maybe<Scalars['JSON']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  priorities: Array<Scalars['JSON']['output']>;
  returned: Scalars['Int']['output'];
  sort?: Maybe<Scalars['String']['output']>;
  total: Scalars['Int']['output'];
};

export type ReviewProfileCompletenessList = {
  __typename?: 'ReviewProfileCompletenessList';
  cursor: Scalars['Int']['output'];
  generated_at?: Maybe<Scalars['String']['output']>;
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  notes?: Maybe<Scalars['JSON']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  profiles: Array<Scalars['JSON']['output']>;
  returned: Scalars['Int']['output'];
  sort?: Maybe<Scalars['String']['output']>;
  summary?: Maybe<Scalars['JSON']['output']>;
  total: Scalars['Int']['output'];
};

/** One netuid's root-claim accounting for a (hotkey, account) pair (#7229). */
export type RootClaimEntry = {
  __typename?: 'RootClaimEntry';
  claimable_rate: Scalars['Float']['output'];
  claimed: Scalars['String']['output'];
  netuid: Scalars['Int']['output'];
  threshold: Scalars['Float']['output'];
};

/** Root-claim rows for one staking/owned hotkey of the queried account (#7229). */
export type RootClaimHotkey = {
  __typename?: 'RootClaimHotkey';
  entries: Array<RootClaimEntry>;
  hotkey: Scalars['String']['output'];
};

/** Per-account RootClaimTypeEnum (#7229): Swap / Keep / KeepSubnets. */
export type RootClaimType = {
  __typename?: 'RootClaimType';
  kind: Scalars['String']['output'];
  subnets?: Maybe<Array<Scalars['Int']['output']>>;
};

/** RPC reverse-proxy usage analytics over a 7d/30d window. Mirrors GET /api/v1/rpc/usage's data envelope. */
export type RpcUsage = {
  __typename?: 'RpcUsage';
  /** Time-bucket granularity for buckets: 1h for the 7d window, 6h for 30d. Null on a cold store. */
  bucket_granularity?: Maybe<Scalars['String']['output']>;
  /** Bounded time buckets over the window for heatmaps, oldest-first. */
  buckets: Array<RpcUsageBucket>;
  /** Per-endpoint request distribution, ranked by request volume (top 50). */
  endpoints: Array<RpcUsageEndpoint>;
  /** Per-network request breakdown, ordered by request volume. */
  networks: Array<RpcUsageNetwork>;
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  source?: Maybe<Scalars['String']['output']>;
  summary: RpcUsageSummary;
  window?: Maybe<Scalars['String']['output']>;
};

/** One bounded time bucket of RPC reverse-proxy traffic (bucket_granularity wide). */
export type RpcUsageBucket = {
  __typename?: 'RpcUsageBucket';
  avg_latency_ms?: Maybe<Scalars['Int']['output']>;
  errors: Scalars['Int']['output'];
  requests: Scalars['Int']['output'];
  ts: Scalars['Float']['output'];
};

/** One endpoint's share of RPC reverse-proxy traffic in the window. */
export type RpcUsageEndpoint = {
  __typename?: 'RpcUsageEndpoint';
  avg_latency_ms?: Maybe<Scalars['Int']['output']>;
  endpoint_id?: Maybe<Scalars['String']['output']>;
  /** Null when the endpoint had no requests in the window. */
  error_rate?: Maybe<Scalars['Float']['output']>;
  ok_requests: Scalars['Int']['output'];
  provider?: Maybe<Scalars['String']['output']>;
  rank: Scalars['Int']['output'];
  requests: Scalars['Int']['output'];
};

/** Window latency percentiles + average for RPC reverse-proxy traffic; each is null on a cold store. */
export type RpcUsageLatency = {
  __typename?: 'RpcUsageLatency';
  avg?: Maybe<Scalars['Int']['output']>;
  p50?: Maybe<Scalars['Int']['output']>;
  p95?: Maybe<Scalars['Int']['output']>;
};

/** One network's share of RPC reverse-proxy traffic in the window. */
export type RpcUsageNetwork = {
  __typename?: 'RpcUsageNetwork';
  /** Null when the network had no requests in the window. */
  error_rate?: Maybe<Scalars['Float']['output']>;
  network?: Maybe<Scalars['String']['output']>;
  ok_requests: Scalars['Int']['output'];
  requests: Scalars['Int']['output'];
};

/** Window-total rollup for RPC reverse-proxy traffic. */
export type RpcUsageSummary = {
  __typename?: 'RpcUsageSummary';
  /** Null when there are no requests in the window. */
  cache_hit_rate?: Maybe<Scalars['Float']['output']>;
  cache_hits: Scalars['Int']['output'];
  /** Null when there are no requests in the window (no defined rate). */
  error_rate?: Maybe<Scalars['Float']['output']>;
  error_requests: Scalars['Int']['output'];
  /** Null when there are no requests in the window. */
  failover_rate?: Maybe<Scalars['Float']['output']>;
  failover_requests: Scalars['Int']['output'];
  latency_ms: RpcUsageLatency;
  ok_requests: Scalars['Int']['output'];
  total_requests: Scalars['Int']['output'];
};

/** One runtime spec-version's first-seen block in the transition timeline. */
export type RuntimeTransition = {
  __typename?: 'RuntimeTransition';
  block_number: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  spec_version: Scalars['Int']['output'];
};

/** Site-wide runtime spec-version transition timeline. Mirrors GET /api/v1/runtime. */
export type RuntimeVersionHistory = {
  __typename?: 'RuntimeVersionHistory';
  coverage_from_at?: Maybe<Scalars['String']['output']>;
  coverage_from_block?: Maybe<Scalars['Int']['output']>;
  current_spec_version?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  transition_count: Scalars['Int']['output'];
  transitions: Array<RuntimeTransition>;
};

/** 0..1 score column spread (count/mean/min/max plus nearest-rank percentiles). Null when no neuron carries a finite value. */
export type ScoreDistribution = {
  __typename?: 'ScoreDistribution';
  count: Scalars['Int']['output'];
  max?: Maybe<Scalars['Float']['output']>;
  mean?: Maybe<Scalars['Float']['output']>;
  min?: Maybe<Scalars['Float']['output']>;
  p10?: Maybe<Scalars['Float']['output']>;
  p25?: Maybe<Scalars['Float']['output']>;
  p50?: Maybe<Scalars['Float']['output']>;
  p75?: Maybe<Scalars['Float']['output']>;
  p90?: Maybe<Scalars['Float']['output']>;
};

export type SearchDocumentList = {
  __typename?: 'SearchDocumentList';
  /** Heterogeneous per-type documents (subnet/surface/provider/doc), passed through verbatim as opaque JSON. */
  documents: Array<Scalars['JSON']['output']>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  total: Scalars['Int']['output'];
};

export type SourceSnapshotList = {
  __typename?: 'SourceSnapshotList';
  cursor: Scalars['Int']['output'];
  generated_at?: Maybe<Scalars['String']['output']>;
  limit: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['Int']['output']>;
  order?: Maybe<Scalars['String']['output']>;
  returned: Scalars['Int']['output'];
  schema_version?: Maybe<Scalars['String']['output']>;
  sort?: Maybe<Scalars['String']['output']>;
  sources: Array<Scalars['JSON']['output']>;
  summary?: Maybe<Scalars['JSON']['output']>;
  total: Scalars['Int']['output'];
};

export type Subnet = {
  __typename?: 'Subnet';
  categories?: Maybe<Array<Scalars['String']['output']>>;
  coverage_level?: Maybe<Scalars['String']['output']>;
  curation_level?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  docs_url?: Maybe<Scalars['String']['output']>;
  /** Per-subnet economic + validator metrics. */
  economics?: Maybe<SubnetEconomics>;
  /** Endpoint/resource registry rows for this subnet. */
  endpoints: Array<Endpoint>;
  first_party?: Maybe<Scalars['Boolean']['output']>;
  gap_count?: Maybe<Scalars['Int']['output']>;
  /** Live operational health summary for this subnet. */
  health?: Maybe<SubnetHealth>;
  integration_readiness?: Maybe<Scalars['Int']['output']>;
  lifecycle?: Maybe<Scalars['String']['output']>;
  logo_url?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
  official_surface_count?: Maybe<Scalars['Int']['output']>;
  probed_surface_count?: Maybe<Scalars['Int']['output']>;
  slug?: Maybe<Scalars['String']['output']>;
  status?: Maybe<Scalars['String']['output']>;
  subnet_type?: Maybe<Scalars['String']['output']>;
  surface_count?: Maybe<Scalars['Int']['output']>;
  /** Curated public interface surfaces of this subnet. */
  surfaces: Array<Surface>;
  symbol?: Maybe<Scalars['String']['output']>;
  website_url?: Maybe<Scalars['String']['output']>;
};

export type SubnetAxonRemovals = {
  __typename?: 'SubnetAxonRemovals';
  distinct_removers: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  removals: Scalars['Int']['output'];
  removals_per_remover?: Maybe<Scalars['Float']['output']>;
  schema_version: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** Live current registration/burn cost for one subnet, read directly from chain via RPC. burn_tao is null on RPC failure (schema-stable, never a GraphQL error). Mirrors GET /api/v1/subnets/{netuid}/burn. */
export type SubnetBurn = {
  __typename?: 'SubnetBurn';
  burn_tao?: Maybe<Scalars['Float']['output']>;
  netuid: Scalars['Int']['output'];
  queried_at: Scalars['String']['output'];
  schema_version: Scalars['Int']['output'];
};

/** Per-subnet stake & emission concentration card (#5901) over the current neurons snapshot. Metric blocks are null on a cold/empty subnet. Mirrors GET /api/v1/subnets/{netuid}/concentration. */
export type SubnetConcentration = {
  __typename?: 'SubnetConcentration';
  captured_at?: Maybe<Scalars['String']['output']>;
  /** Emission concentration across all UIDs. */
  emission?: Maybe<ConcentrationMetrics>;
  /** Distinct controlling entities (coldkeys) behind the subnet's UIDs. */
  entity_count: Scalars['Int']['output'];
  /** Emission concentration collapsed to one holder per controlling entity. */
  entity_emission?: Maybe<ConcentrationMetrics>;
  /** Stake concentration collapsed to one holder per controlling entity. */
  entity_stake?: Maybe<ConcentrationMetrics>;
  netuid: Scalars['Int']['output'];
  neuron_count: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
  /** Stake concentration across all UIDs. */
  stake?: Maybe<ConcentrationMetrics>;
  /** UIDs per controlling entity -- a Sybil/consolidation signal (1.0 = every UID a distinct owner; higher = fewer operators each running many hotkeys). Null on an empty subnet. */
  uids_per_entity?: Maybe<Scalars['Float']['output']>;
  /** Stake concentration across permitted validators only. */
  validator_stake?: Maybe<ConcentrationMetrics>;
};

/** Per-subnet per-day concentration trend (#5901) from the neuron_daily rollup, newest first. An empty series (point_count 0) on a cold store, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/concentration/history. */
export type SubnetConcentrationHistory = {
  __typename?: 'SubnetConcentrationHistory';
  netuid: Scalars['Int']['output'];
  point_count: Scalars['Int']['output'];
  points: Array<SubnetConcentrationHistoryPoint>;
  schema_version: Scalars['Int']['output'];
  /** The resolved window label (7d/30d/90d). */
  window?: Maybe<Scalars['String']['output']>;
};

export type SubnetConcentrationHistoryPoint = {
  __typename?: 'SubnetConcentrationHistoryPoint';
  emission_gini?: Maybe<Scalars['Float']['output']>;
  emission_nakamoto_coefficient?: Maybe<Scalars['Int']['output']>;
  emission_top_10pct_share?: Maybe<Scalars['Float']['output']>;
  neuron_count: Scalars['Int']['output'];
  snapshot_date: Scalars['String']['output'];
  stake_gini?: Maybe<Scalars['Float']['output']>;
  stake_nakamoto_coefficient?: Maybe<Scalars['Int']['output']>;
  stake_top_10pct_share?: Maybe<Scalars['Float']['output']>;
};

/** Live per-subnet conviction leaderboard -- who currently holds the most rolled conviction, rolled forward from a periodically-captured snapshot using the current live-queried unlock_rate/maturity_rate. Mirrors GET /api/v1/subnets/{netuid}/conviction. */
export type SubnetConviction = {
  __typename?: 'SubnetConviction';
  count: Scalars['Int']['output'];
  king?: Maybe<Scalars['JSON']['output']>;
  leaderboard: Array<Scalars['JSON']['output']>;
  maturity_rate?: Maybe<Scalars['Float']['output']>;
  netuid: Scalars['Int']['output'];
  queried_at_block?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  unlock_rate?: Maybe<Scalars['Float']['output']>;
};

/** Per-subnet neuron-deregistration activity over a window (#5719). Zeroed card (0 counts) on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/deregistrations. */
export type SubnetDeregistrations = {
  __typename?: 'SubnetDeregistrations';
  deregistrations: Scalars['Int']['output'];
  deregistrations_per_hotkey?: Maybe<Scalars['Float']['output']>;
  distinct_deregistered_hotkeys: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

export type SubnetEconomics = {
  __typename?: 'SubnetEconomics';
  alpha_fdv_tao?: Maybe<Scalars['Float']['output']>;
  alpha_in_pool?: Maybe<Scalars['Float']['output']>;
  alpha_market_cap_tao?: Maybe<Scalars['Float']['output']>;
  alpha_out_pool?: Maybe<Scalars['Float']['output']>;
  /** Signed %-change in alpha_price_tao over ~1 day from subnet_snapshots (#7227). */
  alpha_price_change_1d?: Maybe<Scalars['Float']['output']>;
  /** Signed %-change in alpha_price_tao over ~1h. Always null from daily snapshots (#7227). */
  alpha_price_change_1h?: Maybe<Scalars['Float']['output']>;
  /** Signed %-change in alpha_price_tao over ~30 days from subnet_snapshots (#7227). */
  alpha_price_change_1m?: Maybe<Scalars['Float']['output']>;
  /** Signed %-change in alpha_price_tao over ~7 days from subnet_snapshots (#7227). */
  alpha_price_change_7d?: Maybe<Scalars['Float']['output']>;
  alpha_price_tao?: Maybe<Scalars['Float']['output']>;
  emission_share?: Maybe<Scalars['Float']['output']>;
  max_stake_tao?: Maybe<Scalars['Float']['output']>;
  max_uids?: Maybe<Scalars['Int']['output']>;
  max_validators?: Maybe<Scalars['Int']['output']>;
  miner_count?: Maybe<Scalars['Int']['output']>;
  miner_readiness?: Maybe<Scalars['Int']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
  open_slots?: Maybe<Scalars['Int']['output']>;
  owner_coldkey?: Maybe<Scalars['String']['output']>;
  owner_hotkey?: Maybe<Scalars['String']['output']>;
  registration_allowed?: Maybe<Scalars['Boolean']['output']>;
  registration_cost_tao?: Maybe<Scalars['Float']['output']>;
  slug?: Maybe<Scalars['String']['output']>;
  subnet_volume_tao?: Maybe<Scalars['Float']['output']>;
  tao_in_pool_tao?: Maybe<Scalars['Float']['output']>;
  total_stake_tao?: Maybe<Scalars['Float']['output']>;
  validator_count?: Maybe<Scalars['Int']['output']>;
};

/** One subnet's chain-event activity summary over a window (#6980). Mirrors GET /api/v1/subnets/{netuid}/event-summary' data envelope. */
export type SubnetEventSummary = {
  __typename?: 'SubnetEventSummary';
  /** Per event category: its kind list and rolled-up counts. Opaque JSON passed through verbatim, matching the get_subnet_event_summary MCP/REST shape. */
  categories: Scalars['JSON']['output'];
  category_count: Scalars['Int']['output'];
  /** Per event kind: event_count, hotkey/coldkey participation counts, TAO/alpha amounts, and first/last block + observed_at. Opaque JSON passed through verbatim. */
  event_kinds: Scalars['JSON']['output'];
  kind_count: Scalars['Int']['output'];
  /** The resolved recent-event cap actually applied (1-50, default 10). */
  limit: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  recent_event_count: Scalars['Int']['output'];
  /** The bounded newest-first recent-event list. Opaque JSON passed through verbatim. */
  recent_events: Scalars['JSON']['output'];
  schema_version: Scalars['Int']['output'];
  total_events: Scalars['Int']['output'];
  /** The resolved window label (7d/30d/90d). */
  window?: Maybe<Scalars['String']['output']>;
};

/** One subnet's paginated first-party chain-event feed (#7172), newest first, offset-paginated. event_count is the page count, not a grand total. Each item is an AccountEvent. Empty feed on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/events' data envelope. */
export type SubnetEvents = {
  __typename?: 'SubnetEvents';
  event_count: Scalars['Int']['output'];
  events: Array<AccountEvent>;
  limit?: Maybe<Scalars['Int']['output']>;
  netuid: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['String']['output']>;
  offset?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
};

export type SubnetHealth = {
  __typename?: 'SubnetHealth';
  avg_latency_ms?: Maybe<Scalars['Int']['output']>;
  degraded_count?: Maybe<Scalars['Int']['output']>;
  failed_count?: Maybe<Scalars['Int']['output']>;
  last_checked?: Maybe<Scalars['String']['output']>;
  last_ok?: Maybe<Scalars['String']['output']>;
  latency_sample_count?: Maybe<Scalars['Int']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  netuid?: Maybe<Scalars['Int']['output']>;
  ok_count?: Maybe<Scalars['Int']['output']>;
  slug?: Maybe<Scalars['String']['output']>;
  status?: Maybe<Scalars['String']['output']>;
  surface_count?: Maybe<Scalars['Int']['output']>;
  unknown_count?: Maybe<Scalars['Int']['output']>;
};

/** One subnet's per-surface SLA + reconstructed downtime incidents over the window. Mirrors GET /api/v1/subnets/{netuid}/health/incidents's data envelope. */
export type SubnetHealthIncidents = {
  __typename?: 'SubnetHealthIncidents';
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  source?: Maybe<Scalars['String']['output']>;
  /** Per operational surface: its sample count, uptime_ratio, incident_count, total downtime_ms, and gap-island incident list (started_at/ended_at/duration_ms/failed_samples, epoch-ms). Opaque JSON passed through verbatim, matching the get_subnet_health_incidents MCP/REST shape (like SubnetHealthTrends.windows). */
  surfaces: Scalars['JSON']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One subnet's per-surface success-only latency percentiles (#6980). Mirrors GET /api/v1/subnets/{netuid}/health/percentiles' data envelope. */
export type SubnetHealthPercentiles = {
  __typename?: 'SubnetHealthPercentiles';
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  source?: Maybe<Scalars['String']['output']>;
  /** Per operational surface: its success-only latency sample count and p50/p90/p95/p99 latency percentiles in ms. Opaque JSON passed through verbatim, matching the get_subnet_health_percentiles MCP/REST shape (like SubnetHealthIncidents.surfaces). */
  surfaces: Scalars['JSON']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One subnet's uptime + latency trend windows. Mirrors GET /api/v1/subnets/{netuid}/health/trends's data envelope. */
export type SubnetHealthTrends = {
  __typename?: 'SubnetHealthTrends';
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  source?: Maybe<Scalars['String']['output']>;
  /** The 7d/30d windows keyed by window label, each holding this subnet's samples, uptime_ratio, latency_sample_count and the per-surface uptime/latency series. Opaque JSON: dynamic-keyed by window label, matching the get_subnet_health_trends MCP/REST shape. */
  windows: Scalars['JSON']['output'];
};

/** One subnet's daily history series (#7172) from the neuron_daily rollup, newest first. Empty series (point_count 0) on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/history' data envelope. */
export type SubnetHistory = {
  __typename?: 'SubnetHistory';
  netuid: Scalars['Int']['output'];
  point_count: Scalars['Int']['output'];
  points: Array<SubnetHistoryPoint>;
  schema_version: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One daily-rollup point on a subnet's history (#7172). Economics fields are null on days captured before those columns existed / when unavailable. */
export type SubnetHistoryPoint = {
  __typename?: 'SubnetHistoryPoint';
  neuron_count?: Maybe<Scalars['Int']['output']>;
  snapshot_date?: Maybe<Scalars['String']['output']>;
  total_emission_tao?: Maybe<Scalars['Float']['output']>;
  total_stake_tao?: Maybe<Scalars['Float']['output']>;
  validator_count?: Maybe<Scalars['Int']['output']>;
};

/** Per-subnet neuron-registration activity over a window (#5720). Zeroed card (0 counts) on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/registrations. */
export type SubnetHyperparameters = {
  __typename?: 'SubnetHyperparameters';
  block_number?: Maybe<Scalars['Int']['output']>;
  captured_at?: Maybe<Scalars['String']['output']>;
  hyperparameters?: Maybe<Hyperparameters>;
  netuid: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
};

export type SubnetHyperparamsHistory = {
  __typename?: 'SubnetHyperparamsHistory';
  entries: Array<HyperparamsHistoryEntry>;
  entry_count: Scalars['Int']['output'];
  limit?: Maybe<Scalars['Int']['output']>;
  netuid: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['String']['output']>;
  offset?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
};

/** Append-only on-chain subnet identity timeline (#1647 / #5721). Empty entries on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/identity-history. */
export type SubnetIdentityHistory = {
  __typename?: 'SubnetIdentityHistory';
  entries: Array<SubnetIdentityHistoryEntry>;
  entry_count: Scalars['Int']['output'];
  limit?: Maybe<Scalars['Int']['output']>;
  netuid: Scalars['Int']['output'];
  next_cursor?: Maybe<Scalars['String']['output']>;
  offset?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
};

/** One SubnetIdentitiesV3 snapshot recorded when a tracked identity field changed. */
export type SubnetIdentityHistoryEntry = {
  __typename?: 'SubnetIdentityHistoryEntry';
  block_number?: Maybe<Scalars['Int']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  discord?: Maybe<Scalars['String']['output']>;
  github_repo?: Maybe<Scalars['String']['output']>;
  identity_hash?: Maybe<Scalars['String']['output']>;
  logo_url?: Maybe<Scalars['String']['output']>;
  observed_at?: Maybe<Scalars['String']['output']>;
  subnet_name?: Maybe<Scalars['String']['output']>;
  subnet_url?: Maybe<Scalars['String']['output']>;
  symbol?: Maybe<Scalars['String']['output']>;
};

/** Per-subnet idle-stake scorecard (#7172). Zeroed card on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/idle-stake. */
export type SubnetIdleStake = {
  __typename?: 'SubnetIdleStake';
  captured_at?: Maybe<Scalars['String']['output']>;
  idle_neuron_count: Scalars['Int']['output'];
  idle_stake_tao: Scalars['Float']['output'];
  netuid: Scalars['Int']['output'];
  neuron_count: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
};

/** Live subnet-lease state -- whether a subnet is currently under a lease and, if so, its terms (beneficiary, coldkey, hotkey, emissions_share_percent, end_block, cost_tao) and accumulated-but-undistributed alpha dividends. leased is null (not false) on RPC failure, distinct from a confirmed no-lease (leased:false). Mirrors GET /api/v1/subnets/{netuid}/lease. */
export type SubnetLease = {
  __typename?: 'SubnetLease';
  lease?: Maybe<Scalars['JSON']['output']>;
  leased?: Maybe<Scalars['Boolean']['output']>;
  netuid: Scalars['Int']['output'];
  queried_at: Scalars['String']['output'];
  schema_version: Scalars['Int']['output'];
};

/** Every SubnetLeaseCreated/SubnetLeaseTerminated event one subnet has had, decoded from the account_events stream. Mirrors GET /api/v1/subnets/{netuid}/lease/history. */
export type SubnetLeaseHistory = {
  __typename?: 'SubnetLeaseHistory';
  count: Scalars['Int']['output'];
  lease_events: Array<Scalars['JSON']['output']>;
  netuid: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
};

export type SubnetList = {
  __typename?: 'SubnetList';
  items: Array<Subnet>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  total: Scalars['Int']['output'];
};

/** One subnet's stake/emission/validator/neuron movement between the window's start and end snapshots. */
export type SubnetMover = {
  __typename?: 'SubnetMover';
  emission_delta_tao: Scalars['Float']['output'];
  emission_end_tao: Scalars['Float']['output'];
  emission_pct_change?: Maybe<Scalars['Float']['output']>;
  emission_share_pct?: Maybe<Scalars['Float']['output']>;
  emission_start_tao: Scalars['Float']['output'];
  netuid: Scalars['Int']['output'];
  neurons_delta: Scalars['Int']['output'];
  neurons_end: Scalars['Int']['output'];
  neurons_start: Scalars['Int']['output'];
  stake_delta_tao: Scalars['Float']['output'];
  stake_end_tao: Scalars['Float']['output'];
  /** Null when the start snapshot's stake was 0 (growth from nothing is undefined). */
  stake_pct_change?: Maybe<Scalars['Float']['output']>;
  /** This subnet's share of network stake at the end snapshot; null when the network total is 0. */
  stake_share_pct?: Maybe<Scalars['Float']['output']>;
  stake_start_tao: Scalars['Float']['output'];
  validators_delta: Scalars['Int']['output'];
  validators_end: Scalars['Int']['output'];
  validators_start: Scalars['Int']['output'];
};

export type SubnetMovers = {
  __typename?: 'SubnetMovers';
  end_date?: Maybe<Scalars['String']['output']>;
  movers: Array<SubnetMover>;
  network: SubnetMoversNetwork;
  schema_version: Scalars['Int']['output'];
  sort: Scalars['String']['output'];
  start_date?: Maybe<Scalars['String']['output']>;
  subnet_count: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** Network-wide boundary totals for the movers window, summed across every ranked subnet (not just the returned page). */
export type SubnetMoversNetwork = {
  __typename?: 'SubnetMoversNetwork';
  gainers: Scalars['Int']['output'];
  losers: Scalars['Int']['output'];
  total_emission_delta_tao: Scalars['String']['output'];
  total_emission_end_tao: Scalars['String']['output'];
  total_emission_start_tao: Scalars['String']['output'];
  total_stake_delta_tao: Scalars['String']['output'];
  total_stake_end_tao: Scalars['String']['output'];
  /** Lossless fixed 9-decimal (rao-precision) TAO string -- exceeds the exact-double ceiling as a JSON number, so it is served as a string rather than Float. */
  total_stake_start_tao: Scalars['String']['output'];
  total_validators_delta: Scalars['Int']['output'];
  total_validators_end: Scalars['Int']['output'];
  total_validators_start: Scalars['Int']['output'];
  unchanged: Scalars['Int']['output'];
};

/** One subnet's alpha-price OHLC candles (#6979). Mirrors GET /api/v1/subnets/{netuid}/ohlc' data envelope. */
export type SubnetOhlc = {
  __typename?: 'SubnetOhlc';
  candles: Array<SubnetOhlcCandle>;
  /** The resolved bucket interval (1h/1d). */
  interval?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
  /** True for root (netuid 0), whose 1:1 price makes candles meaningless, so none are emitted. */
  root_excluded: Scalars['Boolean']['output'];
  schema_version: Scalars['Int']['output'];
};

export type SubnetOhlcCandle = {
  __typename?: 'SubnetOhlcCandle';
  /** Bucket start as epoch milliseconds -- a Float, since epoch-ms exceeds GraphQL's 32-bit Int. */
  bucket_start: Scalars['Float']['output'];
  bucket_start_iso?: Maybe<Scalars['String']['output']>;
  close?: Maybe<Scalars['Float']['output']>;
  event_count: Scalars['Int']['output'];
  high?: Maybe<Scalars['Float']['output']>;
  low?: Maybe<Scalars['Float']['output']>;
  open?: Maybe<Scalars['Float']['output']>;
  volume_alpha?: Maybe<Scalars['Float']['output']>;
  volume_tao?: Maybe<Scalars['Float']['output']>;
};

/** Every automatic ownership transfer one subnet has undergone, decoded from the chain_events SubnetOwnerChanged stream. Mirrors GET /api/v1/subnets/{netuid}/ownership-history. */
export type SubnetOwnershipHistory = {
  __typename?: 'SubnetOwnershipHistory';
  count: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  ownership_changes: Array<Scalars['JSON']['output']>;
  schema_version: Scalars['Int']['output'];
};

/** Per-subnet reward-distribution & score-spread card (#5714). Metric blocks are null on a cold/empty subnet. Mirrors GET /api/v1/subnets/{netuid}/performance. */
export type SubnetPerformance = {
  __typename?: 'SubnetPerformance';
  active_count: Scalars['Int']['output'];
  captured_at?: Maybe<Scalars['String']['output']>;
  /** Consensus score spread across all neurons. */
  consensus?: Maybe<ScoreDistribution>;
  /** Dividends concentration across permitted validators only. */
  dividends?: Maybe<ConcentrationMetrics>;
  /** Incentive concentration across all neurons with positive incentive. */
  incentive?: Maybe<ConcentrationMetrics>;
  netuid: Scalars['Int']['output'];
  neuron_count: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
  /** Trust score spread across all neurons. */
  trust?: Maybe<ScoreDistribution>;
  validator_count: Scalars['Int']['output'];
  /** Validator-trust score spread across permitted validators only. */
  validator_trust?: Maybe<ScoreDistribution>;
};

/** Per-subnet per-day reward-distribution trend (#6981) from the neuron_daily rollup, newest first. An empty series (point_count 0) on a cold store, never a GraphQL error. The history twin of subnet_performance, mirroring GET /api/v1/subnets/{netuid}/performance/history. */
export type SubnetPerformanceHistory = {
  __typename?: 'SubnetPerformanceHistory';
  netuid: Scalars['Int']['output'];
  point_count: Scalars['Int']['output'];
  points: Array<SubnetPerformanceHistoryPoint>;
  schema_version: Scalars['Int']['output'];
  /** The resolved window label (7d/30d/90d). */
  window?: Maybe<Scalars['String']['output']>;
};

/** One day's point in a subnet's concentration trend (#5901). Flattened (not nested) stake/emission metrics keep the series trivial to plot; each is null on a cold/empty day. */
export type SubnetPerformanceHistoryPoint = {
  __typename?: 'SubnetPerformanceHistoryPoint';
  active_count: Scalars['Int']['output'];
  consensus_mean?: Maybe<Scalars['Float']['output']>;
  consensus_median?: Maybe<Scalars['Float']['output']>;
  dividends_gini?: Maybe<Scalars['Float']['output']>;
  dividends_nakamoto_coefficient?: Maybe<Scalars['Int']['output']>;
  dividends_top_10pct_share?: Maybe<Scalars['Float']['output']>;
  incentive_gini?: Maybe<Scalars['Float']['output']>;
  incentive_nakamoto_coefficient?: Maybe<Scalars['Int']['output']>;
  incentive_top_10pct_share?: Maybe<Scalars['Float']['output']>;
  neuron_count: Scalars['Int']['output'];
  snapshot_date: Scalars['String']['output'];
  trust_mean?: Maybe<Scalars['Float']['output']>;
  trust_median?: Maybe<Scalars['Float']['output']>;
  validator_count: Scalars['Int']['output'];
  validator_trust_mean?: Maybe<Scalars['Float']['output']>;
  validator_trust_median?: Maybe<Scalars['Float']['output']>;
};

/** Per-subnet Prometheus-endpoint serving activity (#7172) over a 7d/30d window. Zeroed card on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/prometheus. */
export type SubnetPrometheus = {
  __typename?: 'SubnetPrometheus';
  announcements: Scalars['Int']['output'];
  announcements_per_exporter?: Maybe<Scalars['Float']['output']>;
  distinct_exporters: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** Live cumulative TAO recycled for registration on one subnet, read directly from chain via RPC. recycled_tao is null on RPC failure (schema-stable, never a GraphQL error). Mirrors GET /api/v1/subnets/{netuid}/recycled. */
export type SubnetRecycled = {
  __typename?: 'SubnetRecycled';
  netuid: Scalars['Int']['output'];
  queried_at: Scalars['String']['output'];
  recycled_tao?: Maybe<Scalars['Float']['output']>;
  schema_version: Scalars['Int']['output'];
};

export type SubnetRegistrations = {
  __typename?: 'SubnetRegistrations';
  distinct_registrants: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  registrations: Scalars['Int']['output'];
  registrations_per_registrant?: Maybe<Scalars['Float']['output']>;
  schema_version: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

export type SubnetServing = {
  __typename?: 'SubnetServing';
  announcements: Scalars['Int']['output'];
  announcements_per_server?: Maybe<Scalars['Float']['output']>;
  distinct_servers: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** Per-subnet net stake flow (#7172) over a 7d/30d/90d window. Zeroed card on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/stake-flow' data envelope. */
export type SubnetStakeFlow = {
  __typename?: 'SubnetStakeFlow';
  net_flow_tao: Scalars['Float']['output'];
  netuid: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
  stake_events: Scalars['Int']['output'];
  total_staked_tao: Scalars['Float']['output'];
  total_unstaked_tao: Scalars['Float']['output'];
  unstake_events: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

export type SubnetStakeMoves = {
  __typename?: 'SubnetStakeMoves';
  distinct_movers: Scalars['Int']['output'];
  movements: Scalars['Int']['output'];
  movements_per_mover?: Maybe<Scalars['Float']['output']>;
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** A read-only hypothetical stake/unstake quote against one subnet's live AMM pool (#6979). Mirrors GET /api/v1/subnets/{netuid}/stake-quote. */
export type SubnetStakeQuote = {
  __typename?: 'SubnetStakeQuote';
  alpha_in_pool?: Maybe<Scalars['Float']['output']>;
  amount?: Maybe<Scalars['Float']['output']>;
  /** stake (spends TAO for alpha) or unstake (spends alpha for TAO). */
  direction?: Maybe<Scalars['String']['output']>;
  effective_price_tao?: Maybe<Scalars['Float']['output']>;
  expected_out?: Maybe<Scalars['Float']['output']>;
  expected_out_unit?: Maybe<Scalars['String']['output']>;
  /** True for root (netuid 0), which quotes 1:1 with no price impact. */
  is_root?: Maybe<Scalars['Boolean']['output']>;
  netuid: Scalars['Int']['output'];
  price_impact_pct?: Maybe<Scalars['Float']['output']>;
  schema_version: Scalars['Int']['output'];
  spot_price_tao?: Maybe<Scalars['Float']['output']>;
  tao_in_pool_tao?: Maybe<Scalars['Float']['output']>;
};

/** Per-subnet stake-transfer activity (#5717) over a 7d/30d window. Zeroed card on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/stake-transfers. */
export type SubnetStakeTransfers = {
  __typename?: 'SubnetStakeTransfers';
  distinct_senders: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  transfers: Scalars['Int']['output'];
  transfers_per_sender?: Maybe<Scalars['Float']['output']>;
  window?: Maybe<Scalars['String']['output']>;
};

/** One subnet's weekly structural + economics trajectory from the daily snapshots (#5887). Mirrors GET /api/v1/subnets/{netuid}/trajectory's data envelope. The REST envelope's window-keyed deltas map (7d/30d) is exposed here as a list carrying each window label, since those keys are not valid GraphQL field names. */
export type SubnetTrajectory = {
  __typename?: 'SubnetTrajectory';
  /** Latest-vs-window-ago deltas -- one entry per window (7d, 30d) that has a prior point to compare against; empty when the series is too short. */
  deltas: Array<SubnetTrajectoryDelta>;
  netuid: Scalars['Int']['output'];
  point_count: Scalars['Int']['output'];
  points: Array<SubnetTrajectoryPoint>;
  schema_version: Scalars['Int']['output'];
};

/** Change in a subnet's key metrics over a trailing window (latest point minus the point at-or-before the window start). Pool-reserve deltas double as the net TAO/alpha flow over the window. */
export type SubnetTrajectoryDelta = {
  __typename?: 'SubnetTrajectoryDelta';
  alpha_in_pool?: Maybe<Scalars['Float']['output']>;
  alpha_out_pool?: Maybe<Scalars['Float']['output']>;
  completeness_score?: Maybe<Scalars['Int']['output']>;
  endpoint_count?: Maybe<Scalars['Int']['output']>;
  from_date?: Maybe<Scalars['String']['output']>;
  surface_count?: Maybe<Scalars['Int']['output']>;
  tao_in_pool_tao?: Maybe<Scalars['Float']['output']>;
  to_date?: Maybe<Scalars['String']['output']>;
  window: Scalars['String']['output'];
};

/** One daily-snapshot point on a subnet's trajectory (chronological). Economics fields are null on rows captured before those columns existed / when economics was unavailable that day. */
export type SubnetTrajectoryPoint = {
  __typename?: 'SubnetTrajectoryPoint';
  alpha_in_pool?: Maybe<Scalars['Float']['output']>;
  alpha_out_pool?: Maybe<Scalars['Float']['output']>;
  alpha_price_tao?: Maybe<Scalars['Float']['output']>;
  completeness_score?: Maybe<Scalars['Int']['output']>;
  date?: Maybe<Scalars['String']['output']>;
  emission_share?: Maybe<Scalars['Float']['output']>;
  endpoint_count?: Maybe<Scalars['Int']['output']>;
  miner_count?: Maybe<Scalars['Int']['output']>;
  subnet_volume_tao?: Maybe<Scalars['Float']['output']>;
  surface_count?: Maybe<Scalars['Int']['output']>;
  tao_in_pool_tao?: Maybe<Scalars['Float']['output']>;
  total_stake_tao?: Maybe<Scalars['Float']['output']>;
  validator_count?: Maybe<Scalars['Int']['output']>;
};

/** One subnet's validator/neuron-set turnover between a window's boundary snapshots. The churn metrics are zeroed and the retentions/stability null on a single-snapshot or cold store (schema-stable). Mirrors GET /api/v1/subnets/{netuid}/turnover's default scorecard. */
export type SubnetTurnover = {
  __typename?: 'SubnetTurnover';
  /** Per-neuron churn detail behind the counts above, populated only when the field's changes toggle is set (mirroring REST's ?changes=true). Null otherwise, and on a cold store. */
  changes?: Maybe<SubnetTurnoverChanges>;
  comparable: Scalars['Boolean']['output'];
  end_date?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
  neuron_retention?: Maybe<Scalars['Float']['output']>;
  neurons_end: Scalars['Int']['output'];
  neurons_start: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
  stability_score?: Maybe<Scalars['Int']['output']>;
  start_date?: Maybe<Scalars['String']['output']>;
  uids_deregistered: Scalars['Int']['output'];
  validator_retention?: Maybe<Scalars['Float']['output']>;
  validators_end: Scalars['Int']['output'];
  validators_entered: Scalars['Int']['output'];
  validators_exited: Scalars['Int']['output'];
  validators_start: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** The per-neuron churn behind a subnet's turnover scorecard: which validators entered and exited, and which UIDs were reassigned. Mirrors the changes block of GET /api/v1/subnets/{netuid}/turnover?changes=true. */
export type SubnetTurnoverChanges = {
  __typename?: 'SubnetTurnoverChanges';
  uid_reassignment_count: Scalars['Int']['output'];
  uid_reassignments: Array<TurnoverUidReassignment>;
  validators_entered: Array<TurnoverValidatorChange>;
  validators_entered_count: Scalars['Int']['output'];
  validators_exited: Array<TurnoverValidatorChange>;
  validators_exited_count: Scalars['Int']['output'];
};

/** One subnet's long-term daily uptime history (#5885). Mirrors GET /api/v1/subnets/{netuid}/uptime's data envelope. */
export type SubnetUptime = {
  __typename?: 'SubnetUptime';
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  /** Subnet-level sample-weighted reliability score over the window; null when there are no probe samples. */
  reliability?: Maybe<UptimeReliability>;
  schema_version: Scalars['Int']['output'];
  source?: Maybe<Scalars['String']['output']>;
  /** Per-surface day series with window-wide uptime ratios and per-surface reliability scores. */
  surfaces: Array<UptimeSurface>;
  window?: Maybe<Scalars['String']['output']>;
};

/** One subnet's current validator set (#6979). Mirrors GET /api/v1/subnets/{netuid}/validators' data envelope. */
export type SubnetValidatorList = {
  __typename?: 'SubnetValidatorList';
  block_number?: Maybe<Scalars['Int']['output']>;
  captured_at?: Maybe<Scalars['String']['output']>;
  netuid: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
  validator_count: Scalars['Int']['output'];
  /** Each permitted validator's live metagraph row -- the same NeuronState shape the neuron field returns. */
  validators: Array<NeuronState>;
};

/** One subnet's rolling 24h alpha trading volume (#6979). Mirrors GET /api/v1/subnets/{netuid}/volume' data envelope. */
export type SubnetVolume = {
  __typename?: 'SubnetVolume';
  buy_count: Scalars['Int']['output'];
  buy_volume_alpha: Scalars['Float']['output'];
  buy_volume_tao: Scalars['Float']['output'];
  net_volume_alpha: Scalars['Float']['output'];
  netuid: Scalars['Int']['output'];
  schema_version: Scalars['Int']['output'];
  sell_count: Scalars['Int']['output'];
  sell_volume_alpha: Scalars['Float']['output'];
  sell_volume_tao: Scalars['Float']['output'];
  /** Bucketed reading of sentiment_ratio (buying/selling/neutral). */
  sentiment?: Maybe<Scalars['String']['output']>;
  /** Buy share of total volume (0-1); null when there was no volume. */
  sentiment_ratio?: Maybe<Scalars['Float']['output']>;
  total_volume_alpha: Scalars['Float']['output'];
  total_volume_tao: Scalars['Float']['output'];
  /** Total TAO volume over alpha market cap; null when market cap is unknown. */
  vol_mcap_ratio?: Maybe<Scalars['Float']['output']>;
  /** The rolling window label this card covers (24h). */
  window?: Maybe<Scalars['String']['output']>;
};

/** One validator's weight-setting activity within one subnet over the lookback window. */
export type SubnetWeightSetter = {
  __typename?: 'SubnetWeightSetter';
  first_set_at?: Maybe<Scalars['String']['output']>;
  hotkey?: Maybe<Scalars['String']['output']>;
  last_set_at?: Maybe<Scalars['String']['output']>;
  /** This setter's share of the subnet total weight_sets; null when the subnet total is 0. */
  share?: Maybe<Scalars['Float']['output']>;
  uid?: Maybe<Scalars['Int']['output']>;
  weight_sets: Scalars['Int']['output'];
};

/** Per-subnet weight-setter leaderboard (#5712). Empty setters on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/weights/setters. */
export type SubnetWeightSetters = {
  __typename?: 'SubnetWeightSetters';
  distinct_setters: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  setter_count: Scalars['Int']['output'];
  setters: Array<SubnetWeightSetter>;
  weight_sets: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

export type SubnetWeights = {
  __typename?: 'SubnetWeights';
  distinct_setters: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  observed_at?: Maybe<Scalars['String']['output']>;
  schema_version: Scalars['Int']['output'];
  sets_per_setter?: Maybe<Scalars['Float']['output']>;
  weight_sets: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

export type SubnetYield = {
  __typename?: 'SubnetYield';
  block_number?: Maybe<Scalars['Int']['output']>;
  captured_at?: Maybe<Scalars['String']['output']>;
  mean_yield?: Maybe<Scalars['Float']['output']>;
  median_yield?: Maybe<Scalars['Float']['output']>;
  miner_count: Scalars['Int']['output'];
  netuid: Scalars['Int']['output'];
  neuron_count: Scalars['Int']['output'];
  neurons: Array<SubnetYieldNeuron>;
  p25_yield?: Maybe<Scalars['Float']['output']>;
  p75_yield?: Maybe<Scalars['Float']['output']>;
  p90_yield?: Maybe<Scalars['Float']['output']>;
  schema_version: Scalars['Int']['output'];
  subnet_yield?: Maybe<Scalars['Float']['output']>;
  total_emission_tao?: Maybe<Scalars['Float']['output']>;
  total_stake_tao?: Maybe<Scalars['Float']['output']>;
  validator_count: Scalars['Int']['output'];
};

/** Per-subnet per-day emission-per-stake yield trend (#6981) from the neuron_daily rollup, newest first. An empty series (point_count 0) on a cold store, never a GraphQL error. The history twin of subnet_yield, mirroring GET /api/v1/subnets/{netuid}/yield/history. */
export type SubnetYieldHistory = {
  __typename?: 'SubnetYieldHistory';
  netuid: Scalars['Int']['output'];
  point_count: Scalars['Int']['output'];
  points: Array<SubnetYieldHistoryPoint>;
  schema_version: Scalars['Int']['output'];
  /** The resolved window label (7d/30d/90d). */
  window?: Maybe<Scalars['String']['output']>;
};

export type SubnetYieldHistoryPoint = {
  __typename?: 'SubnetYieldHistoryPoint';
  mean_yield?: Maybe<Scalars['Float']['output']>;
  median_yield?: Maybe<Scalars['Float']['output']>;
  neuron_count: Scalars['Int']['output'];
  p25_yield?: Maybe<Scalars['Float']['output']>;
  p75_yield?: Maybe<Scalars['Float']['output']>;
  p90_yield?: Maybe<Scalars['Float']['output']>;
  snapshot_date: Scalars['String']['output'];
  subnet_yield?: Maybe<Scalars['Float']['output']>;
  validator_count: Scalars['Int']['output'];
  yield_count: Scalars['Int']['output'];
};

/** One UID's emission-per-stake yield within a subnet's current metagraph snapshot. */
export type SubnetYieldNeuron = {
  __typename?: 'SubnetYieldNeuron';
  emission_tao?: Maybe<Scalars['Float']['output']>;
  hotkey?: Maybe<Scalars['String']['output']>;
  role: Scalars['String']['output'];
  stake_tao?: Maybe<Scalars['Float']['output']>;
  uid: Scalars['Int']['output'];
  yield?: Maybe<Scalars['Float']['output']>;
};

export type Subscription = {
  __typename?: 'Subscription';
  /** Live chain events as they land (blocks/extrinsics/chain_events/account_events), optionally filtered to one or more tables. Field shape mirrors the #4980 NOTIFY payload -- only the fields relevant to the event's table are populated. */
  chainEvents: ChainEvent;
};


export type SubscriptionChainEventsArgs = {
  tables?: InputMaybe<Array<ChainFirehoseTable>>;
};

/** The network's on-chain sudo (superuser) key, read live from chain via RPC. hotkey is null on RPC failure or a renounced sudo (schema-stable). Mirrors GET /api/v1/sudo/key's data envelope. */
export type SudoKey = {
  __typename?: 'SudoKey';
  hotkey?: Maybe<Scalars['String']['output']>;
  queried_at: Scalars['String']['output'];
  schema_version: Scalars['Int']['output'];
};

export type Surface = {
  __typename?: 'Surface';
  auth_required?: Maybe<Scalars['Boolean']['output']>;
  authority?: Maybe<Scalars['String']['output']>;
  classification?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  key?: Maybe<Scalars['String']['output']>;
  kind?: Maybe<Scalars['String']['output']>;
  last_verified_at?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  netuid?: Maybe<Scalars['Int']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  provider?: Maybe<Scalars['String']['output']>;
  public_safe?: Maybe<Scalars['Boolean']['output']>;
  schema_status?: Maybe<Scalars['String']['output']>;
  schema_url?: Maybe<Scalars['String']['output']>;
  source_urls?: Maybe<Array<Scalars['String']['output']>>;
  stale?: Maybe<Scalars['Boolean']['output']>;
  status?: Maybe<Scalars['String']['output']>;
  subnet_name?: Maybe<Scalars['String']['output']>;
  subnet_slug?: Maybe<Scalars['String']['output']>;
  url?: Maybe<Scalars['String']['output']>;
};

export type SurfaceList = {
  __typename?: 'SurfaceList';
  items: Array<Surface>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  total: Scalars['Int']['output'];
};

/** One UID that changed hands between the window's boundary snapshots. */
export type TurnoverUidReassignment = {
  __typename?: 'TurnoverUidReassignment';
  from_hotkey: Scalars['String']['output'];
  to_hotkey: Scalars['String']['output'];
  uid: Scalars['Int']['output'];
};

/** One validator that entered or left a subnet's validator set between the window's boundary snapshots. */
export type TurnoverValidatorChange = {
  __typename?: 'TurnoverValidatorChange';
  hotkey: Scalars['String']['output'];
  /** The UID it held at the boundary snapshot, null when the row carried no usable uid. */
  uid?: Maybe<Scalars['Int']['output']>;
};

/** One daily uptime point for a surface. */
export type UptimeDay = {
  __typename?: 'UptimeDay';
  avg_latency_ms?: Maybe<Scalars['Int']['output']>;
  day?: Maybe<Scalars['String']['output']>;
  latency_ms?: Maybe<UptimeLatency>;
  latency_sample_count?: Maybe<Scalars['Int']['output']>;
  samples?: Maybe<Scalars['Int']['output']>;
  status?: Maybe<Scalars['String']['output']>;
  uptime_ratio?: Maybe<Scalars['Float']['output']>;
};

/** Percentile latency summary for one uptime day. */
export type UptimeLatency = {
  __typename?: 'UptimeLatency';
  p50?: Maybe<Scalars['Int']['output']>;
  p95?: Maybe<Scalars['Int']['output']>;
  p99?: Maybe<Scalars['Int']['output']>;
};

/** Window-wide reliability score (0-100) with letter grade. Surface-level scores omit window/surface_count/day_count/computed_at. */
export type UptimeReliability = {
  __typename?: 'UptimeReliability';
  avg_latency_ms?: Maybe<Scalars['Int']['output']>;
  computed_at?: Maybe<Scalars['String']['output']>;
  day_count?: Maybe<Scalars['Int']['output']>;
  grade?: Maybe<Scalars['String']['output']>;
  latency_sample_count?: Maybe<Scalars['Int']['output']>;
  sample_count?: Maybe<Scalars['Int']['output']>;
  score?: Maybe<Scalars['Int']['output']>;
  surface_count?: Maybe<Scalars['Int']['output']>;
  uptime_ratio?: Maybe<Scalars['Float']['output']>;
  window?: Maybe<Scalars['String']['output']>;
};

/** One operational surface's uptime history over the requested window. */
export type UptimeSurface = {
  __typename?: 'UptimeSurface';
  day_count?: Maybe<Scalars['Int']['output']>;
  days: Array<UptimeDay>;
  reliability?: Maybe<UptimeReliability>;
  samples?: Maybe<Scalars['Int']['output']>;
  surface_id?: Maybe<Scalars['String']['output']>;
  uptime_ratio?: Maybe<Scalars['Float']['output']>;
};

export type Validator = {
  __typename?: 'Validator';
  alpha_stake_tao?: Maybe<Scalars['Float']['output']>;
  apy_estimate?: Maybe<Scalars['Float']['output']>;
  apy_estimate_eligible_subnet_count?: Maybe<Scalars['Int']['output']>;
  avg_validator_trust?: Maybe<Scalars['Float']['output']>;
  block_number?: Maybe<Scalars['Int']['output']>;
  captured_at?: Maybe<Scalars['String']['output']>;
  coldkey?: Maybe<Scalars['String']['output']>;
  coldkey_count?: Maybe<Scalars['Int']['output']>;
  coldkey_identity?: Maybe<Identity>;
  featured: Scalars['Boolean']['output'];
  hotkey: Scalars['String']['output'];
  max_validator_trust?: Maybe<Scalars['Float']['output']>;
  nominator_count?: Maybe<Scalars['Int']['output']>;
  /** Realized 1-day return on staked capital: the fractional change in total_stake_tao vs the neuron_daily snapshot ~1 day ago. Backward-looking over an elapsed window (captures compounding + net delegation flow), unlike the forward-looking apy_estimate; null when no rollup row exists that far back. Mirrors realized_return_1d in the REST/MCP shape (#7228). */
  realized_return_1d?: Maybe<Scalars['Float']['output']>;
  /** Realized 30-day return on staked capital vs the neuron_daily snapshot ~1 month ago; null when no rollup row exists that far back (#7228). */
  realized_return_1m?: Maybe<Scalars['Float']['output']>;
  /** Realized 7-day return on staked capital vs the neuron_daily snapshot ~1 week ago; null when no rollup row exists that far back (#7228). */
  realized_return_1w?: Maybe<Scalars['Float']['output']>;
  root_stake_tao?: Maybe<Scalars['Float']['output']>;
  subnet_count?: Maybe<Scalars['Int']['output']>;
  /** Per-subnet membership rows for this validator. The global leaderboard entry caps this at the top 10 by stake; the single-validator lookup carries every subnet. */
  subnets: Array<ValidatorSubnet>;
  take?: Maybe<Scalars['Float']['output']>;
  total_emission_tao?: Maybe<Scalars['Float']['output']>;
  total_stake_tao?: Maybe<Scalars['Float']['output']>;
  uid_count?: Maybe<Scalars['Int']['output']>;
};

/** Several validators placed side by side (#6989). Mirrors GET /api/v1/compare/validators. */
export type ValidatorComparison = {
  __typename?: 'ValidatorComparison';
  /** The optional subnet context the comparison was scoped to. */
  netuid?: Maybe<Scalars['Int']['output']>;
  schema_version: Scalars['Int']['output'];
  validator_count: Scalars['Int']['output'];
  validators: Array<ComparedValidator>;
};

/** One validator's cross-subnet staked-over-time history. Mirrors GET /api/v1/validators/{hotkey}/history. */
export type ValidatorHistory = {
  __typename?: 'ValidatorHistory';
  hotkey: Scalars['String']['output'];
  point_count: Scalars['Int']['output'];
  points: Array<ValidatorHistoryPoint>;
  schema_version: Scalars['Int']['output'];
  window?: Maybe<Scalars['String']['output']>;
};

/** One day's cross-subnet rollup for a validator hotkey, summed across every subnet it validates in that day. */
export type ValidatorHistoryPoint = {
  __typename?: 'ValidatorHistoryPoint';
  rewards_per_1000_tao?: Maybe<Scalars['Float']['output']>;
  snapshot_date: Scalars['String']['output'];
  subnet_count?: Maybe<Scalars['Int']['output']>;
  total_emission_tao?: Maybe<Scalars['Float']['output']>;
  total_stake_tao?: Maybe<Scalars['Float']['output']>;
};

export type ValidatorList = {
  __typename?: 'ValidatorList';
  block_number?: Maybe<Scalars['Int']['output']>;
  captured_at?: Maybe<Scalars['String']['output']>;
  items: Array<Validator>;
  next_cursor?: Maybe<Scalars['String']['output']>;
  sort: Scalars['String']['output'];
  total: Scalars['Int']['output'];
};

export type ValidatorSubnet = {
  __typename?: 'ValidatorSubnet';
  emission_tao?: Maybe<Scalars['Float']['output']>;
  netuid: Scalars['Int']['output'];
  stake_tao?: Maybe<Scalars['Float']['output']>;
  uid?: Maybe<Scalars['Int']['output']>;
  validator_trust?: Maybe<Scalars['Float']['output']>;
};

/** Distribution of the per-neuron emission/stake return rate across the network. */
export type YieldDistribution = {
  __typename?: 'YieldDistribution';
  count: Scalars['Int']['output'];
  max: Scalars['Float']['output'];
  mean: Scalars['Float']['output'];
  median: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  p10: Scalars['Float']['output'];
  p25: Scalars['Float']['output'];
  p75: Scalars['Float']['output'];
  p90: Scalars['Float']['output'];
};

export type WithIndex<TObject> = TObject & Record<string, any>;
export type ResolversObject<TObject> = WithIndex<TObject>;

export type ResolverTypeWrapper<T> = Promise<T> | T;


export type ResolverWithResolve<TResult, TParent, TContext, TArgs> = {
  resolve: ResolverFn<TResult, TParent, TContext, TArgs>;
};
export type Resolver<TResult, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = ResolverFn<TResult, TParent, TContext, TArgs> | ResolverWithResolve<TResult, TParent, TContext, TArgs>;

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => Promise<TResult> | TResult;

export type SubscriptionSubscribeFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => AsyncIterable<TResult> | Promise<AsyncIterable<TResult>>;

export type SubscriptionResolveFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;

export interface SubscriptionSubscriberObject<TResult, TKey extends string, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<{ [key in TKey]: TResult }, TParent, TContext, TArgs>;
  resolve?: SubscriptionResolveFn<TResult, { [key in TKey]: TResult }, TContext, TArgs>;
}

export interface SubscriptionResolverObject<TResult, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<any, TParent, TContext, TArgs>;
  resolve: SubscriptionResolveFn<TResult, any, TContext, TArgs>;
}

export type SubscriptionObject<TResult, TKey extends string, TParent, TContext, TArgs> =
  | SubscriptionSubscriberObject<TResult, TKey, TParent, TContext, TArgs>
  | SubscriptionResolverObject<TResult, TParent, TContext, TArgs>;

export type SubscriptionResolver<TResult, TKey extends string, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> =
  | ((...args: any[]) => SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>)
  | SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>;

export type TypeResolveFn<TTypes, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (
  parent: TParent,
  context: TContext,
  info: GraphQLResolveInfo
) => Maybe<TTypes> | Promise<Maybe<TTypes>>;

export type IsTypeOfResolverFn<T = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (obj: T, context: TContext, info: GraphQLResolveInfo) => boolean | Promise<boolean>;

export type NextResolverFn<T> = () => Promise<T>;

export type DirectiveResolverFn<TResult = Record<PropertyKey, never>, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = (
  next: NextResolverFn<TResult>,
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;





/** Mapping between all available schema types and the resolvers types */
export type ResolversTypes = ResolversObject<{
  AccountActivity: ResolverTypeWrapper<AccountActivity>;
  AccountAxonRemovalSubnet: ResolverTypeWrapper<AccountAxonRemovalSubnet>;
  AccountAxonRemovals: ResolverTypeWrapper<AccountAxonRemovals>;
  AccountBalance: ResolverTypeWrapper<AccountBalance>;
  AccountChildEntry: ResolverTypeWrapper<AccountChildEntry>;
  AccountChildSubnet: ResolverTypeWrapper<AccountChildSubnet>;
  AccountChildren: ResolverTypeWrapper<AccountChildren>;
  AccountCounterparties: ResolverTypeWrapper<AccountCounterparties>;
  AccountCounterparty: ResolverTypeWrapper<AccountCounterparty>;
  AccountCounterpartyRelationship: ResolverTypeWrapper<AccountCounterpartyRelationship>;
  AccountCounterpartyTransfer: ResolverTypeWrapper<AccountCounterpartyTransfer>;
  AccountDay: ResolverTypeWrapper<AccountDay>;
  AccountDeregistrationSubnet: ResolverTypeWrapper<AccountDeregistrationSubnet>;
  AccountDeregistrations: ResolverTypeWrapper<AccountDeregistrations>;
  AccountEntities: ResolverTypeWrapper<AccountEntities>;
  AccountEntityLabel: ResolverTypeWrapper<AccountEntityLabel>;
  AccountEntry: ResolverTypeWrapper<AccountEntry>;
  AccountEvent: ResolverTypeWrapper<AccountEvent>;
  AccountEventKind: ResolverTypeWrapper<AccountEventKind>;
  AccountEvents: ResolverTypeWrapper<AccountEvents>;
  AccountExtrinsics: ResolverTypeWrapper<AccountExtrinsics>;
  AccountHistory: ResolverTypeWrapper<AccountHistory>;
  AccountIdentity: ResolverTypeWrapper<AccountIdentity>;
  AccountIdentityHistory: ResolverTypeWrapper<AccountIdentityHistory>;
  AccountIdentityHistoryEntry: ResolverTypeWrapper<AccountIdentityHistoryEntry>;
  AccountList: ResolverTypeWrapper<AccountList>;
  AccountModuleCall: ResolverTypeWrapper<AccountModuleCall>;
  AccountOwnershipTie: ResolverTypeWrapper<AccountOwnershipTie>;
  AccountParentEntry: ResolverTypeWrapper<AccountParentEntry>;
  AccountParentSubnet: ResolverTypeWrapper<AccountParentSubnet>;
  AccountParents: ResolverTypeWrapper<AccountParents>;
  AccountPortfolio: ResolverTypeWrapper<AccountPortfolio>;
  AccountPortfolioPosition: ResolverTypeWrapper<AccountPortfolioPosition>;
  AccountPositionHistory: ResolverTypeWrapper<AccountPositionHistory>;
  AccountPositionHistoryPoint: ResolverTypeWrapper<AccountPositionHistoryPoint>;
  AccountPositions: ResolverTypeWrapper<AccountPositions>;
  AccountPrometheus: ResolverTypeWrapper<AccountPrometheus>;
  AccountPrometheusSubnet: ResolverTypeWrapper<AccountPrometheusSubnet>;
  AccountRegistration: ResolverTypeWrapper<AccountRegistration>;
  AccountRegistrationSubnet: ResolverTypeWrapper<AccountRegistrationSubnet>;
  AccountRegistrations: ResolverTypeWrapper<AccountRegistrations>;
  AccountRootClaim: ResolverTypeWrapper<AccountRootClaim>;
  AccountServing: ResolverTypeWrapper<AccountServing>;
  AccountServingSubnet: ResolverTypeWrapper<AccountServingSubnet>;
  AccountStakeFlow: ResolverTypeWrapper<AccountStakeFlow>;
  AccountStakeFlowSubnet: ResolverTypeWrapper<AccountStakeFlowSubnet>;
  AccountStakeMoveSubnet: ResolverTypeWrapper<AccountStakeMoveSubnet>;
  AccountStakeMoves: ResolverTypeWrapper<AccountStakeMoves>;
  AccountSubnet: ResolverTypeWrapper<AccountSubnet>;
  AccountSubnets: ResolverTypeWrapper<AccountSubnets>;
  AccountSummary: ResolverTypeWrapper<AccountSummary>;
  AccountTransfer: ResolverTypeWrapper<AccountTransfer>;
  AccountTransfers: ResolverTypeWrapper<AccountTransfers>;
  AccountWeightSetters: ResolverTypeWrapper<AccountWeightSetters>;
  AccountWeightSettersSubnet: ResolverTypeWrapper<AccountWeightSettersSubnet>;
  Adapter: ResolverTypeWrapper<Adapter>;
  Block: ResolverTypeWrapper<Block>;
  BlockChainEvents: ResolverTypeWrapper<BlockChainEvents>;
  BlockDetail: ResolverTypeWrapper<BlockDetail>;
  BlockEvents: ResolverTypeWrapper<BlockEvents>;
  BlockExtrinsics: ResolverTypeWrapper<BlockExtrinsics>;
  BlockList: ResolverTypeWrapper<BlockList>;
  BlockTimeDistribution: ResolverTypeWrapper<BlockTimeDistribution>;
  BlocksSummary: ResolverTypeWrapper<BlocksSummary>;
  BlocksThroughput: ResolverTypeWrapper<BlocksThroughput>;
  Boolean: ResolverTypeWrapper<Scalars['Boolean']['output']>;
  BuildSummary: ResolverTypeWrapper<BuildSummary>;
  ChainActivity: ResolverTypeWrapper<ChainActivity>;
  ChainActivityDay: ResolverTypeWrapper<ChainActivityDay>;
  ChainAlphaVolume: ResolverTypeWrapper<ChainAlphaVolume>;
  ChainAlphaVolumeDistribution: ResolverTypeWrapper<ChainAlphaVolumeDistribution>;
  ChainAlphaVolumeNetwork: ResolverTypeWrapper<ChainAlphaVolumeNetwork>;
  ChainAlphaVolumeSubnet: ResolverTypeWrapper<ChainAlphaVolumeSubnet>;
  ChainAxonRemovals: ResolverTypeWrapper<ChainAxonRemovals>;
  ChainAxonRemovalsIntensityDistribution: ResolverTypeWrapper<ChainAxonRemovalsIntensityDistribution>;
  ChainAxonRemovalsNetwork: ResolverTypeWrapper<ChainAxonRemovalsNetwork>;
  ChainAxonRemovalsSubnet: ResolverTypeWrapper<ChainAxonRemovalsSubnet>;
  ChainCall: ResolverTypeWrapper<ChainCall>;
  ChainCalls: ResolverTypeWrapper<ChainCalls>;
  ChainConcentration: ResolverTypeWrapper<ChainConcentration>;
  ChainDeregistrations: ResolverTypeWrapper<ChainDeregistrations>;
  ChainDeregistrationsIntensityDistribution: ResolverTypeWrapper<ChainDeregistrationsIntensityDistribution>;
  ChainDeregistrationsNetwork: ResolverTypeWrapper<ChainDeregistrationsNetwork>;
  ChainDeregistrationsSubnet: ResolverTypeWrapper<ChainDeregistrationsSubnet>;
  ChainEvent: ResolverTypeWrapper<ChainEvent>;
  ChainEventRow: ResolverTypeWrapper<ChainEventRow>;
  ChainEventsFeed: ResolverTypeWrapper<ChainEventsFeed>;
  ChainEventsStats: ResolverTypeWrapper<ChainEventsStats>;
  ChainEventsStatsRow: ResolverTypeWrapper<ChainEventsStatsRow>;
  ChainFeePayer: ResolverTypeWrapper<ChainFeePayer>;
  ChainFees: ResolverTypeWrapper<ChainFees>;
  ChainFeesDay: ResolverTypeWrapper<ChainFeesDay>;
  ChainFirehoseTable: ResolverTypeWrapper<ChainFirehoseTable>;
  ChainIdentityHistory: ResolverTypeWrapper<ChainIdentityHistory>;
  ChainIdentityHistoryEntry: ResolverTypeWrapper<ChainIdentityHistoryEntry>;
  ChainIdleStake: ResolverTypeWrapper<ChainIdleStake>;
  ChainIdleStakeSubnet: ResolverTypeWrapper<ChainIdleStakeSubnet>;
  ChainPerformance: ResolverTypeWrapper<ChainPerformance>;
  ChainPrometheus: ResolverTypeWrapper<ChainPrometheus>;
  ChainPrometheusIntensityDistribution: ResolverTypeWrapper<ChainPrometheusIntensityDistribution>;
  ChainPrometheusNetwork: ResolverTypeWrapper<ChainPrometheusNetwork>;
  ChainPrometheusSubnet: ResolverTypeWrapper<ChainPrometheusSubnet>;
  ChainRegistrations: ResolverTypeWrapper<ChainRegistrations>;
  ChainRegistrationsIntensityDistribution: ResolverTypeWrapper<ChainRegistrationsIntensityDistribution>;
  ChainRegistrationsNetwork: ResolverTypeWrapper<ChainRegistrationsNetwork>;
  ChainRegistrationsSubnet: ResolverTypeWrapper<ChainRegistrationsSubnet>;
  ChainServing: ResolverTypeWrapper<ChainServing>;
  ChainServingIntensityDistribution: ResolverTypeWrapper<ChainServingIntensityDistribution>;
  ChainServingNetwork: ResolverTypeWrapper<ChainServingNetwork>;
  ChainServingSubnet: ResolverTypeWrapper<ChainServingSubnet>;
  ChainSigner: ResolverTypeWrapper<ChainSigner>;
  ChainSigners: ResolverTypeWrapper<ChainSigners>;
  ChainStakeFlow: ResolverTypeWrapper<ChainStakeFlow>;
  ChainStakeFlowDistribution: ResolverTypeWrapper<ChainStakeFlowDistribution>;
  ChainStakeFlowNetwork: ResolverTypeWrapper<ChainStakeFlowNetwork>;
  ChainStakeFlowSubnet: ResolverTypeWrapper<ChainStakeFlowSubnet>;
  ChainStakeMoves: ResolverTypeWrapper<ChainStakeMoves>;
  ChainStakeMovesIntensityDistribution: ResolverTypeWrapper<ChainStakeMovesIntensityDistribution>;
  ChainStakeMovesNetwork: ResolverTypeWrapper<ChainStakeMovesNetwork>;
  ChainStakeMovesSubnet: ResolverTypeWrapper<ChainStakeMovesSubnet>;
  ChainStakeTransfers: ResolverTypeWrapper<ChainStakeTransfers>;
  ChainStakeTransfersIntensityDistribution: ResolverTypeWrapper<ChainStakeTransfersIntensityDistribution>;
  ChainStakeTransfersNetwork: ResolverTypeWrapper<ChainStakeTransfersNetwork>;
  ChainStakeTransfersSubnet: ResolverTypeWrapper<ChainStakeTransfersSubnet>;
  ChainTransferPair: ResolverTypeWrapper<ChainTransferPair>;
  ChainTransferPairs: ResolverTypeWrapper<ChainTransferPairs>;
  ChainTransferParty: ResolverTypeWrapper<ChainTransferParty>;
  ChainTransfers: ResolverTypeWrapper<ChainTransfers>;
  ChainTurnover: ResolverTypeWrapper<ChainTurnover>;
  ChainTurnoverNetwork: ResolverTypeWrapper<ChainTurnoverNetwork>;
  ChainTurnoverStabilityDistribution: ResolverTypeWrapper<ChainTurnoverStabilityDistribution>;
  ChainTurnoverSubnet: ResolverTypeWrapper<ChainTurnoverSubnet>;
  ChainWeightSetter: ResolverTypeWrapper<ChainWeightSetter>;
  ChainWeightSetters: ResolverTypeWrapper<ChainWeightSetters>;
  ChainWeights: ResolverTypeWrapper<ChainWeights>;
  ChainWeightsIntensityDistribution: ResolverTypeWrapper<ChainWeightsIntensityDistribution>;
  ChainWeightsNetwork: ResolverTypeWrapper<ChainWeightsNetwork>;
  ChainWeightsSubnet: ResolverTypeWrapper<ChainWeightsSubnet>;
  ChainYield: ResolverTypeWrapper<ChainYield>;
  Changelog: ResolverTypeWrapper<Changelog>;
  Compare: ResolverTypeWrapper<Compare>;
  CompareEconomics: ResolverTypeWrapper<CompareEconomics>;
  CompareHealth: ResolverTypeWrapper<CompareHealth>;
  CompareStructure: ResolverTypeWrapper<CompareStructure>;
  CompareSubnet: ResolverTypeWrapper<CompareSubnet>;
  ComparedValidator: ResolverTypeWrapper<ComparedValidator>;
  ConcentrationMetrics: ResolverTypeWrapper<ConcentrationMetrics>;
  Contracts: ResolverTypeWrapper<Contracts>;
  DomainOverview: ResolverTypeWrapper<DomainOverview>;
  DomainSummary: ResolverTypeWrapper<DomainSummary>;
  EconomicsList: ResolverTypeWrapper<EconomicsList>;
  EconomicsSummary: ResolverTypeWrapper<EconomicsSummary>;
  EconomicsTrends: ResolverTypeWrapper<EconomicsTrends>;
  EconomicsTrendsDay: ResolverTypeWrapper<EconomicsTrendsDay>;
  Endpoint: ResolverTypeWrapper<Endpoint>;
  EndpointIncident: ResolverTypeWrapper<EndpointIncident>;
  EndpointList: ResolverTypeWrapper<EndpointList>;
  EvidenceList: ResolverTypeWrapper<EvidenceList>;
  EvmAddressMapping: ResolverTypeWrapper<EvmAddressMapping>;
  Extrinsic: ResolverTypeWrapper<Extrinsic>;
  ExtrinsicDetail: ResolverTypeWrapper<ExtrinsicDetail>;
  ExtrinsicList: ResolverTypeWrapper<ExtrinsicList>;
  Float: ResolverTypeWrapper<Scalars['Float']['output']>;
  GapsList: ResolverTypeWrapper<GapsList>;
  GlobalHealth: ResolverTypeWrapper<GlobalHealth>;
  GlobalIncidents: ResolverTypeWrapper<GlobalIncidents>;
  HealthHistory: ResolverTypeWrapper<HealthHistory>;
  HealthTrends: ResolverTypeWrapper<HealthTrends>;
  Hyperparameters: ResolverTypeWrapper<Hyperparameters>;
  HyperparamsHistoryEntry: ResolverTypeWrapper<HyperparamsHistoryEntry>;
  Identity: ResolverTypeWrapper<Identity>;
  IncidentList: ResolverTypeWrapper<IncidentList>;
  Int: ResolverTypeWrapper<Scalars['Int']['output']>;
  JSON: ResolverTypeWrapper<Scalars['JSON']['output']>;
  NetworkParameters: ResolverTypeWrapper<NetworkParameters>;
  NetworkRandomness: ResolverTypeWrapper<NetworkRandomness>;
  Neuron: ResolverTypeWrapper<Neuron>;
  NeuronHistory: ResolverTypeWrapper<NeuronHistory>;
  NeuronHistoryPoint: ResolverTypeWrapper<NeuronHistoryPoint>;
  NeuronState: ResolverTypeWrapper<NeuronState>;
  Nominator: ResolverTypeWrapper<Nominator>;
  NominatorList: ResolverTypeWrapper<NominatorList>;
  NominatorPosition: ResolverTypeWrapper<NominatorPosition>;
  OpportunityBoards: ResolverTypeWrapper<OpportunityBoards>;
  OpportunityEntry: ResolverTypeWrapper<OpportunityEntry>;
  PoolList: ResolverTypeWrapper<PoolList>;
  ProfileList: ResolverTypeWrapper<ProfileList>;
  Provider: ResolverTypeWrapper<Provider>;
  ProviderList: ResolverTypeWrapper<ProviderList>;
  Query: ResolverTypeWrapper<Record<PropertyKey, never>>;
  RegistryLeaderboards: ResolverTypeWrapper<RegistryLeaderboards>;
  ReviewAdapterCandidateList: ResolverTypeWrapper<ReviewAdapterCandidateList>;
  ReviewEnrichmentEvidenceList: ResolverTypeWrapper<ReviewEnrichmentEvidenceList>;
  ReviewEnrichmentQueueList: ResolverTypeWrapper<ReviewEnrichmentQueueList>;
  ReviewEnrichmentTargetList: ResolverTypeWrapper<ReviewEnrichmentTargetList>;
  ReviewGapPriorityList: ResolverTypeWrapper<ReviewGapPriorityList>;
  ReviewProfileCompletenessList: ResolverTypeWrapper<ReviewProfileCompletenessList>;
  RootClaimEntry: ResolverTypeWrapper<RootClaimEntry>;
  RootClaimHotkey: ResolverTypeWrapper<RootClaimHotkey>;
  RootClaimType: ResolverTypeWrapper<RootClaimType>;
  RpcUsage: ResolverTypeWrapper<RpcUsage>;
  RpcUsageBucket: ResolverTypeWrapper<RpcUsageBucket>;
  RpcUsageEndpoint: ResolverTypeWrapper<RpcUsageEndpoint>;
  RpcUsageLatency: ResolverTypeWrapper<RpcUsageLatency>;
  RpcUsageNetwork: ResolverTypeWrapper<RpcUsageNetwork>;
  RpcUsageSummary: ResolverTypeWrapper<RpcUsageSummary>;
  RuntimeTransition: ResolverTypeWrapper<RuntimeTransition>;
  RuntimeVersionHistory: ResolverTypeWrapper<RuntimeVersionHistory>;
  ScoreDistribution: ResolverTypeWrapper<ScoreDistribution>;
  SearchDocumentList: ResolverTypeWrapper<SearchDocumentList>;
  SourceSnapshotList: ResolverTypeWrapper<SourceSnapshotList>;
  String: ResolverTypeWrapper<Scalars['String']['output']>;
  Subnet: ResolverTypeWrapper<Subnet>;
  SubnetAxonRemovals: ResolverTypeWrapper<SubnetAxonRemovals>;
  SubnetBurn: ResolverTypeWrapper<SubnetBurn>;
  SubnetConcentration: ResolverTypeWrapper<SubnetConcentration>;
  SubnetConcentrationHistory: ResolverTypeWrapper<SubnetConcentrationHistory>;
  SubnetConcentrationHistoryPoint: ResolverTypeWrapper<SubnetConcentrationHistoryPoint>;
  SubnetConviction: ResolverTypeWrapper<SubnetConviction>;
  SubnetDeregistrations: ResolverTypeWrapper<SubnetDeregistrations>;
  SubnetEconomics: ResolverTypeWrapper<SubnetEconomics>;
  SubnetEventSummary: ResolverTypeWrapper<SubnetEventSummary>;
  SubnetEvents: ResolverTypeWrapper<SubnetEvents>;
  SubnetHealth: ResolverTypeWrapper<SubnetHealth>;
  SubnetHealthIncidents: ResolverTypeWrapper<SubnetHealthIncidents>;
  SubnetHealthPercentiles: ResolverTypeWrapper<SubnetHealthPercentiles>;
  SubnetHealthTrends: ResolverTypeWrapper<SubnetHealthTrends>;
  SubnetHistory: ResolverTypeWrapper<SubnetHistory>;
  SubnetHistoryPoint: ResolverTypeWrapper<SubnetHistoryPoint>;
  SubnetHyperparameters: ResolverTypeWrapper<SubnetHyperparameters>;
  SubnetHyperparamsHistory: ResolverTypeWrapper<SubnetHyperparamsHistory>;
  SubnetIdentityHistory: ResolverTypeWrapper<SubnetIdentityHistory>;
  SubnetIdentityHistoryEntry: ResolverTypeWrapper<SubnetIdentityHistoryEntry>;
  SubnetIdleStake: ResolverTypeWrapper<SubnetIdleStake>;
  SubnetLease: ResolverTypeWrapper<SubnetLease>;
  SubnetLeaseHistory: ResolverTypeWrapper<SubnetLeaseHistory>;
  SubnetList: ResolverTypeWrapper<SubnetList>;
  SubnetMover: ResolverTypeWrapper<SubnetMover>;
  SubnetMovers: ResolverTypeWrapper<SubnetMovers>;
  SubnetMoversNetwork: ResolverTypeWrapper<SubnetMoversNetwork>;
  SubnetOhlc: ResolverTypeWrapper<SubnetOhlc>;
  SubnetOhlcCandle: ResolverTypeWrapper<SubnetOhlcCandle>;
  SubnetOwnershipHistory: ResolverTypeWrapper<SubnetOwnershipHistory>;
  SubnetPerformance: ResolverTypeWrapper<SubnetPerformance>;
  SubnetPerformanceHistory: ResolverTypeWrapper<SubnetPerformanceHistory>;
  SubnetPerformanceHistoryPoint: ResolverTypeWrapper<SubnetPerformanceHistoryPoint>;
  SubnetPrometheus: ResolverTypeWrapper<SubnetPrometheus>;
  SubnetRecycled: ResolverTypeWrapper<SubnetRecycled>;
  SubnetRegistrations: ResolverTypeWrapper<SubnetRegistrations>;
  SubnetServing: ResolverTypeWrapper<SubnetServing>;
  SubnetStakeFlow: ResolverTypeWrapper<SubnetStakeFlow>;
  SubnetStakeMoves: ResolverTypeWrapper<SubnetStakeMoves>;
  SubnetStakeQuote: ResolverTypeWrapper<SubnetStakeQuote>;
  SubnetStakeTransfers: ResolverTypeWrapper<SubnetStakeTransfers>;
  SubnetTrajectory: ResolverTypeWrapper<SubnetTrajectory>;
  SubnetTrajectoryDelta: ResolverTypeWrapper<SubnetTrajectoryDelta>;
  SubnetTrajectoryPoint: ResolverTypeWrapper<SubnetTrajectoryPoint>;
  SubnetTurnover: ResolverTypeWrapper<SubnetTurnover>;
  SubnetTurnoverChanges: ResolverTypeWrapper<SubnetTurnoverChanges>;
  SubnetUptime: ResolverTypeWrapper<SubnetUptime>;
  SubnetValidatorList: ResolverTypeWrapper<SubnetValidatorList>;
  SubnetVolume: ResolverTypeWrapper<SubnetVolume>;
  SubnetWeightSetter: ResolverTypeWrapper<SubnetWeightSetter>;
  SubnetWeightSetters: ResolverTypeWrapper<SubnetWeightSetters>;
  SubnetWeights: ResolverTypeWrapper<SubnetWeights>;
  SubnetYield: ResolverTypeWrapper<SubnetYield>;
  SubnetYieldHistory: ResolverTypeWrapper<SubnetYieldHistory>;
  SubnetYieldHistoryPoint: ResolverTypeWrapper<SubnetYieldHistoryPoint>;
  SubnetYieldNeuron: ResolverTypeWrapper<SubnetYieldNeuron>;
  Subscription: ResolverTypeWrapper<Record<PropertyKey, never>>;
  SudoKey: ResolverTypeWrapper<SudoKey>;
  Surface: ResolverTypeWrapper<Surface>;
  SurfaceList: ResolverTypeWrapper<SurfaceList>;
  TurnoverUidReassignment: ResolverTypeWrapper<TurnoverUidReassignment>;
  TurnoverValidatorChange: ResolverTypeWrapper<TurnoverValidatorChange>;
  UptimeDay: ResolverTypeWrapper<UptimeDay>;
  UptimeLatency: ResolverTypeWrapper<UptimeLatency>;
  UptimeReliability: ResolverTypeWrapper<UptimeReliability>;
  UptimeSurface: ResolverTypeWrapper<UptimeSurface>;
  Validator: ResolverTypeWrapper<Validator>;
  ValidatorComparison: ResolverTypeWrapper<ValidatorComparison>;
  ValidatorHistory: ResolverTypeWrapper<ValidatorHistory>;
  ValidatorHistoryPoint: ResolverTypeWrapper<ValidatorHistoryPoint>;
  ValidatorList: ResolverTypeWrapper<ValidatorList>;
  ValidatorSubnet: ResolverTypeWrapper<ValidatorSubnet>;
  YieldDistribution: ResolverTypeWrapper<YieldDistribution>;
}>;

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = ResolversObject<{
  AccountActivity: AccountActivity;
  AccountAxonRemovalSubnet: AccountAxonRemovalSubnet;
  AccountAxonRemovals: AccountAxonRemovals;
  AccountBalance: AccountBalance;
  AccountChildEntry: AccountChildEntry;
  AccountChildSubnet: AccountChildSubnet;
  AccountChildren: AccountChildren;
  AccountCounterparties: AccountCounterparties;
  AccountCounterparty: AccountCounterparty;
  AccountCounterpartyRelationship: AccountCounterpartyRelationship;
  AccountCounterpartyTransfer: AccountCounterpartyTransfer;
  AccountDay: AccountDay;
  AccountDeregistrationSubnet: AccountDeregistrationSubnet;
  AccountDeregistrations: AccountDeregistrations;
  AccountEntities: AccountEntities;
  AccountEntityLabel: AccountEntityLabel;
  AccountEntry: AccountEntry;
  AccountEvent: AccountEvent;
  AccountEventKind: AccountEventKind;
  AccountEvents: AccountEvents;
  AccountExtrinsics: AccountExtrinsics;
  AccountHistory: AccountHistory;
  AccountIdentity: AccountIdentity;
  AccountIdentityHistory: AccountIdentityHistory;
  AccountIdentityHistoryEntry: AccountIdentityHistoryEntry;
  AccountList: AccountList;
  AccountModuleCall: AccountModuleCall;
  AccountOwnershipTie: AccountOwnershipTie;
  AccountParentEntry: AccountParentEntry;
  AccountParentSubnet: AccountParentSubnet;
  AccountParents: AccountParents;
  AccountPortfolio: AccountPortfolio;
  AccountPortfolioPosition: AccountPortfolioPosition;
  AccountPositionHistory: AccountPositionHistory;
  AccountPositionHistoryPoint: AccountPositionHistoryPoint;
  AccountPositions: AccountPositions;
  AccountPrometheus: AccountPrometheus;
  AccountPrometheusSubnet: AccountPrometheusSubnet;
  AccountRegistration: AccountRegistration;
  AccountRegistrationSubnet: AccountRegistrationSubnet;
  AccountRegistrations: AccountRegistrations;
  AccountRootClaim: AccountRootClaim;
  AccountServing: AccountServing;
  AccountServingSubnet: AccountServingSubnet;
  AccountStakeFlow: AccountStakeFlow;
  AccountStakeFlowSubnet: AccountStakeFlowSubnet;
  AccountStakeMoveSubnet: AccountStakeMoveSubnet;
  AccountStakeMoves: AccountStakeMoves;
  AccountSubnet: AccountSubnet;
  AccountSubnets: AccountSubnets;
  AccountSummary: AccountSummary;
  AccountTransfer: AccountTransfer;
  AccountTransfers: AccountTransfers;
  AccountWeightSetters: AccountWeightSetters;
  AccountWeightSettersSubnet: AccountWeightSettersSubnet;
  Adapter: Adapter;
  Block: Block;
  BlockChainEvents: BlockChainEvents;
  BlockDetail: BlockDetail;
  BlockEvents: BlockEvents;
  BlockExtrinsics: BlockExtrinsics;
  BlockList: BlockList;
  BlockTimeDistribution: BlockTimeDistribution;
  BlocksSummary: BlocksSummary;
  BlocksThroughput: BlocksThroughput;
  Boolean: Scalars['Boolean']['output'];
  BuildSummary: BuildSummary;
  ChainActivity: ChainActivity;
  ChainActivityDay: ChainActivityDay;
  ChainAlphaVolume: ChainAlphaVolume;
  ChainAlphaVolumeDistribution: ChainAlphaVolumeDistribution;
  ChainAlphaVolumeNetwork: ChainAlphaVolumeNetwork;
  ChainAlphaVolumeSubnet: ChainAlphaVolumeSubnet;
  ChainAxonRemovals: ChainAxonRemovals;
  ChainAxonRemovalsIntensityDistribution: ChainAxonRemovalsIntensityDistribution;
  ChainAxonRemovalsNetwork: ChainAxonRemovalsNetwork;
  ChainAxonRemovalsSubnet: ChainAxonRemovalsSubnet;
  ChainCall: ChainCall;
  ChainCalls: ChainCalls;
  ChainConcentration: ChainConcentration;
  ChainDeregistrations: ChainDeregistrations;
  ChainDeregistrationsIntensityDistribution: ChainDeregistrationsIntensityDistribution;
  ChainDeregistrationsNetwork: ChainDeregistrationsNetwork;
  ChainDeregistrationsSubnet: ChainDeregistrationsSubnet;
  ChainEvent: ChainEvent;
  ChainEventRow: ChainEventRow;
  ChainEventsFeed: ChainEventsFeed;
  ChainEventsStats: ChainEventsStats;
  ChainEventsStatsRow: ChainEventsStatsRow;
  ChainFeePayer: ChainFeePayer;
  ChainFees: ChainFees;
  ChainFeesDay: ChainFeesDay;
  ChainIdentityHistory: ChainIdentityHistory;
  ChainIdentityHistoryEntry: ChainIdentityHistoryEntry;
  ChainIdleStake: ChainIdleStake;
  ChainIdleStakeSubnet: ChainIdleStakeSubnet;
  ChainPerformance: ChainPerformance;
  ChainPrometheus: ChainPrometheus;
  ChainPrometheusIntensityDistribution: ChainPrometheusIntensityDistribution;
  ChainPrometheusNetwork: ChainPrometheusNetwork;
  ChainPrometheusSubnet: ChainPrometheusSubnet;
  ChainRegistrations: ChainRegistrations;
  ChainRegistrationsIntensityDistribution: ChainRegistrationsIntensityDistribution;
  ChainRegistrationsNetwork: ChainRegistrationsNetwork;
  ChainRegistrationsSubnet: ChainRegistrationsSubnet;
  ChainServing: ChainServing;
  ChainServingIntensityDistribution: ChainServingIntensityDistribution;
  ChainServingNetwork: ChainServingNetwork;
  ChainServingSubnet: ChainServingSubnet;
  ChainSigner: ChainSigner;
  ChainSigners: ChainSigners;
  ChainStakeFlow: ChainStakeFlow;
  ChainStakeFlowDistribution: ChainStakeFlowDistribution;
  ChainStakeFlowNetwork: ChainStakeFlowNetwork;
  ChainStakeFlowSubnet: ChainStakeFlowSubnet;
  ChainStakeMoves: ChainStakeMoves;
  ChainStakeMovesIntensityDistribution: ChainStakeMovesIntensityDistribution;
  ChainStakeMovesNetwork: ChainStakeMovesNetwork;
  ChainStakeMovesSubnet: ChainStakeMovesSubnet;
  ChainStakeTransfers: ChainStakeTransfers;
  ChainStakeTransfersIntensityDistribution: ChainStakeTransfersIntensityDistribution;
  ChainStakeTransfersNetwork: ChainStakeTransfersNetwork;
  ChainStakeTransfersSubnet: ChainStakeTransfersSubnet;
  ChainTransferPair: ChainTransferPair;
  ChainTransferPairs: ChainTransferPairs;
  ChainTransferParty: ChainTransferParty;
  ChainTransfers: ChainTransfers;
  ChainTurnover: ChainTurnover;
  ChainTurnoverNetwork: ChainTurnoverNetwork;
  ChainTurnoverStabilityDistribution: ChainTurnoverStabilityDistribution;
  ChainTurnoverSubnet: ChainTurnoverSubnet;
  ChainWeightSetter: ChainWeightSetter;
  ChainWeightSetters: ChainWeightSetters;
  ChainWeights: ChainWeights;
  ChainWeightsIntensityDistribution: ChainWeightsIntensityDistribution;
  ChainWeightsNetwork: ChainWeightsNetwork;
  ChainWeightsSubnet: ChainWeightsSubnet;
  ChainYield: ChainYield;
  Changelog: Changelog;
  Compare: Compare;
  CompareEconomics: CompareEconomics;
  CompareHealth: CompareHealth;
  CompareStructure: CompareStructure;
  CompareSubnet: CompareSubnet;
  ComparedValidator: ComparedValidator;
  ConcentrationMetrics: ConcentrationMetrics;
  Contracts: Contracts;
  DomainOverview: DomainOverview;
  DomainSummary: DomainSummary;
  EconomicsList: EconomicsList;
  EconomicsSummary: EconomicsSummary;
  EconomicsTrends: EconomicsTrends;
  EconomicsTrendsDay: EconomicsTrendsDay;
  Endpoint: Endpoint;
  EndpointIncident: EndpointIncident;
  EndpointList: EndpointList;
  EvidenceList: EvidenceList;
  EvmAddressMapping: EvmAddressMapping;
  Extrinsic: Extrinsic;
  ExtrinsicDetail: ExtrinsicDetail;
  ExtrinsicList: ExtrinsicList;
  Float: Scalars['Float']['output'];
  GapsList: GapsList;
  GlobalHealth: GlobalHealth;
  GlobalIncidents: GlobalIncidents;
  HealthHistory: HealthHistory;
  HealthTrends: HealthTrends;
  Hyperparameters: Hyperparameters;
  HyperparamsHistoryEntry: HyperparamsHistoryEntry;
  Identity: Identity;
  IncidentList: IncidentList;
  Int: Scalars['Int']['output'];
  JSON: Scalars['JSON']['output'];
  NetworkParameters: NetworkParameters;
  NetworkRandomness: NetworkRandomness;
  Neuron: Neuron;
  NeuronHistory: NeuronHistory;
  NeuronHistoryPoint: NeuronHistoryPoint;
  NeuronState: NeuronState;
  Nominator: Nominator;
  NominatorList: NominatorList;
  NominatorPosition: NominatorPosition;
  OpportunityBoards: OpportunityBoards;
  OpportunityEntry: OpportunityEntry;
  PoolList: PoolList;
  ProfileList: ProfileList;
  Provider: Provider;
  ProviderList: ProviderList;
  Query: Record<PropertyKey, never>;
  RegistryLeaderboards: RegistryLeaderboards;
  ReviewAdapterCandidateList: ReviewAdapterCandidateList;
  ReviewEnrichmentEvidenceList: ReviewEnrichmentEvidenceList;
  ReviewEnrichmentQueueList: ReviewEnrichmentQueueList;
  ReviewEnrichmentTargetList: ReviewEnrichmentTargetList;
  ReviewGapPriorityList: ReviewGapPriorityList;
  ReviewProfileCompletenessList: ReviewProfileCompletenessList;
  RootClaimEntry: RootClaimEntry;
  RootClaimHotkey: RootClaimHotkey;
  RootClaimType: RootClaimType;
  RpcUsage: RpcUsage;
  RpcUsageBucket: RpcUsageBucket;
  RpcUsageEndpoint: RpcUsageEndpoint;
  RpcUsageLatency: RpcUsageLatency;
  RpcUsageNetwork: RpcUsageNetwork;
  RpcUsageSummary: RpcUsageSummary;
  RuntimeTransition: RuntimeTransition;
  RuntimeVersionHistory: RuntimeVersionHistory;
  ScoreDistribution: ScoreDistribution;
  SearchDocumentList: SearchDocumentList;
  SourceSnapshotList: SourceSnapshotList;
  String: Scalars['String']['output'];
  Subnet: Subnet;
  SubnetAxonRemovals: SubnetAxonRemovals;
  SubnetBurn: SubnetBurn;
  SubnetConcentration: SubnetConcentration;
  SubnetConcentrationHistory: SubnetConcentrationHistory;
  SubnetConcentrationHistoryPoint: SubnetConcentrationHistoryPoint;
  SubnetConviction: SubnetConviction;
  SubnetDeregistrations: SubnetDeregistrations;
  SubnetEconomics: SubnetEconomics;
  SubnetEventSummary: SubnetEventSummary;
  SubnetEvents: SubnetEvents;
  SubnetHealth: SubnetHealth;
  SubnetHealthIncidents: SubnetHealthIncidents;
  SubnetHealthPercentiles: SubnetHealthPercentiles;
  SubnetHealthTrends: SubnetHealthTrends;
  SubnetHistory: SubnetHistory;
  SubnetHistoryPoint: SubnetHistoryPoint;
  SubnetHyperparameters: SubnetHyperparameters;
  SubnetHyperparamsHistory: SubnetHyperparamsHistory;
  SubnetIdentityHistory: SubnetIdentityHistory;
  SubnetIdentityHistoryEntry: SubnetIdentityHistoryEntry;
  SubnetIdleStake: SubnetIdleStake;
  SubnetLease: SubnetLease;
  SubnetLeaseHistory: SubnetLeaseHistory;
  SubnetList: SubnetList;
  SubnetMover: SubnetMover;
  SubnetMovers: SubnetMovers;
  SubnetMoversNetwork: SubnetMoversNetwork;
  SubnetOhlc: SubnetOhlc;
  SubnetOhlcCandle: SubnetOhlcCandle;
  SubnetOwnershipHistory: SubnetOwnershipHistory;
  SubnetPerformance: SubnetPerformance;
  SubnetPerformanceHistory: SubnetPerformanceHistory;
  SubnetPerformanceHistoryPoint: SubnetPerformanceHistoryPoint;
  SubnetPrometheus: SubnetPrometheus;
  SubnetRecycled: SubnetRecycled;
  SubnetRegistrations: SubnetRegistrations;
  SubnetServing: SubnetServing;
  SubnetStakeFlow: SubnetStakeFlow;
  SubnetStakeMoves: SubnetStakeMoves;
  SubnetStakeQuote: SubnetStakeQuote;
  SubnetStakeTransfers: SubnetStakeTransfers;
  SubnetTrajectory: SubnetTrajectory;
  SubnetTrajectoryDelta: SubnetTrajectoryDelta;
  SubnetTrajectoryPoint: SubnetTrajectoryPoint;
  SubnetTurnover: SubnetTurnover;
  SubnetTurnoverChanges: SubnetTurnoverChanges;
  SubnetUptime: SubnetUptime;
  SubnetValidatorList: SubnetValidatorList;
  SubnetVolume: SubnetVolume;
  SubnetWeightSetter: SubnetWeightSetter;
  SubnetWeightSetters: SubnetWeightSetters;
  SubnetWeights: SubnetWeights;
  SubnetYield: SubnetYield;
  SubnetYieldHistory: SubnetYieldHistory;
  SubnetYieldHistoryPoint: SubnetYieldHistoryPoint;
  SubnetYieldNeuron: SubnetYieldNeuron;
  Subscription: Record<PropertyKey, never>;
  SudoKey: SudoKey;
  Surface: Surface;
  SurfaceList: SurfaceList;
  TurnoverUidReassignment: TurnoverUidReassignment;
  TurnoverValidatorChange: TurnoverValidatorChange;
  UptimeDay: UptimeDay;
  UptimeLatency: UptimeLatency;
  UptimeReliability: UptimeReliability;
  UptimeSurface: UptimeSurface;
  Validator: Validator;
  ValidatorComparison: ValidatorComparison;
  ValidatorHistory: ValidatorHistory;
  ValidatorHistoryPoint: ValidatorHistoryPoint;
  ValidatorList: ValidatorList;
  ValidatorSubnet: ValidatorSubnet;
  YieldDistribution: YieldDistribution;
}>;

export type AccountActivityResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountActivity'] = ResolversParentTypes['AccountActivity']> = ResolversObject<{
  last_tx_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_tx_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  modules_called?: Resolver<Array<ResolversTypes['AccountModuleCall']>, ParentType, ContextType>;
  total_fee_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  tx_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountAxonRemovalSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountAxonRemovalSubnet'] = ResolversParentTypes['AccountAxonRemovalSubnet']> = ResolversObject<{
  first_removed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_removed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  removals?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountAxonRemovalsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountAxonRemovals'] = ResolversParentTypes['AccountAxonRemovals']> = ResolversObject<{
  address?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  concentration?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  dominant_netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['AccountAxonRemovalSubnet']>, ParentType, ContextType>;
  total_removals?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountBalanceResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountBalance'] = ResolversParentTypes['AccountBalance']> = ResolversObject<{
  balance_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  queried_at?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type AccountChildEntryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountChildEntry'] = ResolversParentTypes['AccountChildEntry']> = ResolversObject<{
  child?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  proportion?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  proportion_fraction?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type AccountChildSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountChildSubnet'] = ResolversParentTypes['AccountChildSubnet']> = ResolversObject<{
  entries?: Resolver<Array<ResolversTypes['AccountChildEntry']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountChildrenResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountChildren'] = ResolversParentTypes['AccountChildren']> = ResolversObject<{
  account?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  queried_at?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Maybe<Array<ResolversTypes['AccountChildSubnet']>>, ParentType, ContextType>;
}>;

export type AccountCounterpartiesResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountCounterparties'] = ResolversParentTypes['AccountCounterparties']> = ResolversObject<{
  counterparties?: Resolver<Array<ResolversTypes['AccountCounterparty']>, ParentType, ContextType>;
  counterparty_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  relationship?: Resolver<Maybe<ResolversTypes['AccountCounterpartyRelationship']>, ParentType, ContextType>;
  scan_capped?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_received_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_sent_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  transfers_scanned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountCounterpartyResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountCounterparty'] = ResolversParentTypes['AccountCounterparty']> = ResolversObject<{
  address?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  last_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  net_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  received_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  sent_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  transfer_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountCounterpartyRelationshipResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountCounterpartyRelationship'] = ResolversParentTypes['AccountCounterpartyRelationship']> = ResolversObject<{
  counterparty?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  first_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  first_seen_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  last_seen_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  net_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  scan_capped?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_received_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_sent_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  transfer_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  transfers?: Resolver<Array<ResolversTypes['AccountCounterpartyTransfer']>, ParentType, ContextType>;
  transfers_scanned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountCounterpartyTransferResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountCounterpartyTransfer'] = ResolversParentTypes['AccountCounterpartyTransfer']> = ResolversObject<{
  amount_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  direction?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  event_index?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  from?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  to?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountDayResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountDay'] = ResolversParentTypes['AccountDay']> = ResolversObject<{
  day?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  event_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  event_kinds?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  first_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  last_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type AccountDeregistrationSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountDeregistrationSubnet'] = ResolversParentTypes['AccountDeregistrationSubnet']> = ResolversObject<{
  deregistrations?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  first_deregistered_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_deregistered_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountDeregistrationsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountDeregistrations'] = ResolversParentTypes['AccountDeregistrations']> = ResolversObject<{
  address?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  concentration?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  dominant_netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['AccountDeregistrationSubnet']>, ParentType, ContextType>;
  total_deregistrations?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountEntitiesResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountEntities'] = ResolversParentTypes['AccountEntities']> = ResolversObject<{
  labels?: Resolver<Array<ResolversTypes['AccountEntityLabel']>, ParentType, ContextType>;
  ownership_tie_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ownership_ties?: Resolver<Array<ResolversTypes['AccountOwnershipTie']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type AccountEntityLabelResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountEntityLabel'] = ResolversParentTypes['AccountEntityLabel']> = ResolversObject<{
  category?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  source_urls?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountEntryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountEntry'] = ResolversParentTypes['AccountEntry']> = ResolversObject<{
  coldkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  coldkey_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  hotkey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  latest_block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  latest_captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  miner_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  stake_dominance?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  subnet_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['AccountSubnet']>, ParentType, ContextType>;
  total_emission_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uid_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  validator_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type AccountEventResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountEvent'] = ResolversParentTypes['AccountEvent']> = ResolversObject<{
  alpha_amount?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  amount_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  coldkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  event_index?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  event_kind?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  extrinsic_index?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  hotkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  uid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type AccountEventKindResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountEventKind'] = ResolversParentTypes['AccountEventKind']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  kind?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type AccountEventsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountEvents'] = ResolversParentTypes['AccountEvents']> = ResolversObject<{
  event_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  events?: Resolver<Array<ResolversTypes['AccountEvent']>, ParentType, ContextType>;
  limit?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  offset?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type AccountExtrinsicsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountExtrinsics'] = ResolversParentTypes['AccountExtrinsics']> = ResolversObject<{
  extrinsic_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  extrinsics?: Resolver<Array<ResolversTypes['Extrinsic']>, ParentType, ContextType>;
  limit?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  offset?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type AccountHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountHistory'] = ResolversParentTypes['AccountHistory']> = ResolversObject<{
  day_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  days?: Resolver<Array<ResolversTypes['AccountDay']>, ParentType, ContextType>;
  limit?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  offset?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type AccountIdentityResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountIdentity'] = ResolversParentTypes['AccountIdentity']> = ResolversObject<{
  account?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  additional?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  discord?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  github?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  has_identity?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  image?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountIdentityHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountIdentityHistory'] = ResolversParentTypes['AccountIdentityHistory']> = ResolversObject<{
  account?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  entries?: Resolver<Array<ResolversTypes['AccountIdentityHistoryEntry']>, ParentType, ContextType>;
  entry_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  limit?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  offset?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountIdentityHistoryEntryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountIdentityHistoryEntry'] = ResolversParentTypes['AccountIdentityHistoryEntry']> = ResolversObject<{
  additional?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  discord?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  github?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  identity_hash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  image?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountList'] = ResolversParentTypes['AccountList']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  items?: Resolver<Array<ResolversTypes['AccountEntry']>, ParentType, ContextType>;
  sort?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountModuleCallResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountModuleCall'] = ResolversParentTypes['AccountModuleCall']> = ResolversObject<{
  call_module?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountOwnershipTieResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountOwnershipTie'] = ResolversParentTypes['AccountOwnershipTie']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  role?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type AccountParentEntryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountParentEntry'] = ResolversParentTypes['AccountParentEntry']> = ResolversObject<{
  parent?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  proportion?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  proportion_fraction?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type AccountParentSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountParentSubnet'] = ResolversParentTypes['AccountParentSubnet']> = ResolversObject<{
  entries?: Resolver<Array<ResolversTypes['AccountParentEntry']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountParentsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountParents'] = ResolversParentTypes['AccountParents']> = ResolversObject<{
  account?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  queried_at?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Maybe<Array<ResolversTypes['AccountParentSubnet']>>, ParentType, ContextType>;
}>;

export type AccountPortfolioResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountPortfolio'] = ResolversParentTypes['AccountPortfolio']> = ResolversObject<{
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  miner_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  overall_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  position_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  positions?: Resolver<Array<ResolversTypes['AccountPortfolioPosition']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  stake_concentration?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_emission_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_stake_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  validator_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountPortfolioPositionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountPortfolioPosition'] = ResolversParentTypes['AccountPortfolioPosition']> = ResolversObject<{
  active?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  dividends?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  emission_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  incentive?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  rank?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  role?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  stake_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  trust?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type AccountPositionHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountPositionHistory'] = ResolversParentTypes['AccountPositionHistory']> = ResolversObject<{
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  point_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  points?: Resolver<Array<ResolversTypes['AccountPositionHistoryPoint']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountPositionHistoryPointResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountPositionHistoryPoint'] = ResolversParentTypes['AccountPositionHistoryPoint']> = ResolversObject<{
  active?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  coldkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  dividends?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  emission_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  incentive?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  rank?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  role?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  snapshot_date?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  trust?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type AccountPositionsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountPositions'] = ResolversParentTypes['AccountPositions']> = ResolversObject<{
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  position_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  positions?: Resolver<Array<ResolversTypes['NominatorPosition']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_stake_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type AccountPrometheusResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountPrometheus'] = ResolversParentTypes['AccountPrometheus']> = ResolversObject<{
  address?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  concentration?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  dominant_netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['AccountPrometheusSubnet']>, ParentType, ContextType>;
  total_announcements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountPrometheusSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountPrometheusSubnet'] = ResolversParentTypes['AccountPrometheusSubnet']> = ResolversObject<{
  announcements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  first_announced_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_announced_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountRegistrationResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountRegistration'] = ResolversParentTypes['AccountRegistration']> = ResolversObject<{
  active?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  validator_permit?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type AccountRegistrationSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountRegistrationSubnet'] = ResolversParentTypes['AccountRegistrationSubnet']> = ResolversObject<{
  first_registered_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_registered_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  registrations?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountRegistrationsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountRegistrations'] = ResolversParentTypes['AccountRegistrations']> = ResolversObject<{
  address?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  concentration?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  dominant_netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['AccountRegistrationSubnet']>, ParentType, ContextType>;
  total_registrations?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountRootClaimResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountRootClaim'] = ResolversParentTypes['AccountRootClaim']> = ResolversObject<{
  claim_type?: Resolver<Maybe<ResolversTypes['RootClaimType']>, ParentType, ContextType>;
  hotkeys?: Resolver<Maybe<Array<ResolversTypes['RootClaimHotkey']>>, ParentType, ContextType>;
  queried_at?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type AccountServingResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountServing'] = ResolversParentTypes['AccountServing']> = ResolversObject<{
  address?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  concentration?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  dominant_netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['AccountServingSubnet']>, ParentType, ContextType>;
  total_announcements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountServingSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountServingSubnet'] = ResolversParentTypes['AccountServingSubnet']> = ResolversObject<{
  announcements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  first_served_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_served_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountStakeFlowResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountStakeFlow'] = ResolversParentTypes['AccountStakeFlow']> = ResolversObject<{
  address?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  concentration?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  direction?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  dominant_netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  flow_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  gross_flow_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  net_flow_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stake_events?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['AccountStakeFlowSubnet']>, ParentType, ContextType>;
  total_staked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_unstaked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  unstake_events?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountStakeFlowSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountStakeFlowSubnet'] = ResolversParentTypes['AccountStakeFlowSubnet']> = ResolversObject<{
  direction?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  flow_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  gross_flow_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  net_flow_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stake_events?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  staked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  unstake_events?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  unstaked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type AccountStakeMoveSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountStakeMoveSubnet'] = ResolversParentTypes['AccountStakeMoveSubnet']> = ResolversObject<{
  first_moved_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_moved_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  movements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  price_tao_at_last_move?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type AccountStakeMovesResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountStakeMoves'] = ResolversParentTypes['AccountStakeMoves']> = ResolversObject<{
  address?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  concentration?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  dominant_netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['AccountStakeMoveSubnet']>, ParentType, ContextType>;
  total_movements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountSubnet'] = ResolversParentTypes['AccountSubnet']> = ResolversObject<{
  emission_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type AccountSubnetsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountSubnets'] = ResolversParentTypes['AccountSubnets']> = ResolversObject<{
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['AccountRegistration']>, ParentType, ContextType>;
}>;

export type AccountSummaryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountSummary'] = ResolversParentTypes['AccountSummary']> = ResolversObject<{
  activity?: Resolver<ResolversTypes['AccountActivity'], ParentType, ContextType>;
  event_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  event_kinds?: Resolver<Array<ResolversTypes['AccountEventKind']>, ParentType, ContextType>;
  event_scan_capped?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  first_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  first_seen_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  last_seen_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  recent_events?: Resolver<Array<ResolversTypes['AccountEvent']>, ParentType, ContextType>;
  registrations?: Resolver<Array<ResolversTypes['AccountRegistration']>, ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AccountTransferResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountTransfer'] = ResolversParentTypes['AccountTransfer']> = ResolversObject<{
  amount_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  direction?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  event_index?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  from?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  to?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountTransfersResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountTransfers'] = ResolversParentTypes['AccountTransfers']> = ResolversObject<{
  limit?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  offset?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  transfer_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  transfers?: Resolver<Array<ResolversTypes['AccountTransfer']>, ParentType, ContextType>;
}>;

export type AccountWeightSettersResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountWeightSetters'] = ResolversParentTypes['AccountWeightSetters']> = ResolversObject<{
  address?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  concentration?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  dominant_netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['AccountWeightSettersSubnet']>, ParentType, ContextType>;
  total_weight_sets?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type AccountWeightSettersSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AccountWeightSettersSubnet'] = ResolversParentTypes['AccountWeightSettersSubnet']> = ResolversObject<{
  first_set_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_set_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  weight_sets?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AdapterResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Adapter'] = ResolversParentTypes['Adapter']> = ResolversObject<{
  contract_version?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  extensions?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  slug?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  snapshot?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  subnet?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type BlockResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Block'] = ResolversParentTypes['Block']> = ResolversObject<{
  author?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  block_hash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  event_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  extrinsic_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  parent_hash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  spec_version?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type BlockChainEventsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['BlockChainEvents'] = ResolversParentTypes['BlockChainEvents']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  event_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  events?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  schema_version?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type BlockDetailResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['BlockDetail'] = ResolversParentTypes['BlockDetail']> = ResolversObject<{
  block?: Resolver<Maybe<ResolversTypes['Block']>, ParentType, ContextType>;
  next_block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  prev_block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  ref?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type BlockEventsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['BlockEvents'] = ResolversParentTypes['BlockEvents']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  event_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  events?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  limit?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  offset?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  ref?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type BlockExtrinsicsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['BlockExtrinsics'] = ResolversParentTypes['BlockExtrinsics']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  extrinsic_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  extrinsics?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  limit?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  offset?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  ref?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type BlockListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['BlockList'] = ResolversParentTypes['BlockList']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['Block']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type BlockTimeDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['BlockTimeDistribution'] = ResolversParentTypes['BlockTimeDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max_ms?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  mean_ms?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  min_ms?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  p50_ms?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  p90_ms?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type BlocksSummaryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['BlocksSummary'] = ResolversParentTypes['BlocksSummary']> = ResolversObject<{
  author_concentration?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  block_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  block_time?: Resolver<Maybe<ResolversTypes['BlockTimeDistribution']>, ParentType, ContextType>;
  distinct_authors?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  distinct_spec_versions?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  first_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  first_observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  last_observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  latest_spec_version?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  throughput?: Resolver<Maybe<ResolversTypes['BlocksThroughput']>, ParentType, ContextType>;
}>;

export type BlocksThroughputResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['BlocksThroughput'] = ResolversParentTypes['BlocksThroughput']> = ResolversObject<{
  max_extrinsics_in_block?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  mean_events_per_block?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  mean_extrinsics_per_block?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_events?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_extrinsics?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type BuildSummaryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['BuildSummary'] = ResolversParentTypes['BuildSummary']> = ResolversObject<{
  adapter_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  artifact_budget_summary?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  artifact_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  artifact_size_bytes?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  artifacts?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  contract_version?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  coverage?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  provider_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  published_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  surface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type ChainActivityResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainActivity'] = ResolversParentTypes['ChainActivity']> = ResolversObject<{
  day_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  days?: Resolver<Array<ResolversTypes['ChainActivityDay']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type ChainActivityDayResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainActivityDay'] = ResolversParentTypes['ChainActivityDay']> = ResolversObject<{
  block_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  day?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  event_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  extrinsic_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  success_rate?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  successful_extrinsics?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  unique_signers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainAlphaVolumeResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainAlphaVolume'] = ResolversParentTypes['ChainAlphaVolume']> = ResolversObject<{
  network?: Resolver<ResolversTypes['ChainAlphaVolumeNetwork'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ChainAlphaVolumeSubnet']>, ParentType, ContextType>;
  volume_distribution?: Resolver<Maybe<ResolversTypes['ChainAlphaVolumeDistribution']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainAlphaVolumeDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainAlphaVolumeDistribution'] = ResolversParentTypes['ChainAlphaVolumeDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  mean?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  median?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  min?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p25?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p75?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p90?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainAlphaVolumeNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainAlphaVolumeNetwork'] = ResolversParentTypes['ChainAlphaVolumeNetwork']> = ResolversObject<{
  buy_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  buy_volume_alpha?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  buy_volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  net_volume_alpha?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  sell_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sell_volume_alpha?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  sell_volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  sentiment?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sentiment_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_volume_alpha?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainAlphaVolumeSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainAlphaVolumeSubnet'] = ResolversParentTypes['ChainAlphaVolumeSubnet']> = ResolversObject<{
  buy_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  buy_volume_alpha?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  buy_volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  net_volume_alpha?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sell_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sell_volume_alpha?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  sell_volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  sentiment?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sentiment_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_volume_alpha?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  vol_mcap_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainAxonRemovalsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainAxonRemovals'] = ResolversParentTypes['ChainAxonRemovals']> = ResolversObject<{
  intensity_distribution?: Resolver<Maybe<ResolversTypes['ChainAxonRemovalsIntensityDistribution']>, ParentType, ContextType>;
  network?: Resolver<ResolversTypes['ChainAxonRemovalsNetwork'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ChainAxonRemovalsSubnet']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainAxonRemovalsIntensityDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainAxonRemovalsIntensityDistribution'] = ResolversParentTypes['ChainAxonRemovalsIntensityDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  mean?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  median?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  min?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p25?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p75?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p90?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainAxonRemovalsNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainAxonRemovalsNetwork'] = ResolversParentTypes['ChainAxonRemovalsNetwork']> = ResolversObject<{
  distinct_removers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  removals?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  removals_per_remover?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ChainAxonRemovalsSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainAxonRemovalsSubnet'] = ResolversParentTypes['ChainAxonRemovalsSubnet']> = ResolversObject<{
  distinct_removers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  removals?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  removals_per_remover?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ChainCallResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainCall'] = ResolversParentTypes['ChainCall']> = ResolversObject<{
  call_function?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  call_module?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ChainCallsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainCalls'] = ResolversParentTypes['ChainCalls']> = ResolversObject<{
  call_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  calls?: Resolver<Array<ResolversTypes['ChainCall']>, ParentType, ContextType>;
  group_by?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_extrinsics?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type ChainConcentrationResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainConcentration'] = ResolversParentTypes['ChainConcentration']> = ResolversObject<{
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  emission?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  entity_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  entity_emission?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  entity_stake?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stake?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  uids_per_entity?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_stake?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
}>;

export type ChainDeregistrationsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainDeregistrations'] = ResolversParentTypes['ChainDeregistrations']> = ResolversObject<{
  intensity_distribution?: Resolver<Maybe<ResolversTypes['ChainDeregistrationsIntensityDistribution']>, ParentType, ContextType>;
  network?: Resolver<ResolversTypes['ChainDeregistrationsNetwork'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ChainDeregistrationsSubnet']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainDeregistrationsIntensityDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainDeregistrationsIntensityDistribution'] = ResolversParentTypes['ChainDeregistrationsIntensityDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  mean?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  median?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  min?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p25?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p75?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p90?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainDeregistrationsNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainDeregistrationsNetwork'] = ResolversParentTypes['ChainDeregistrationsNetwork']> = ResolversObject<{
  deregistrations?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  deregistrations_per_hotkey?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  distinct_deregistered_hotkeys?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainDeregistrationsSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainDeregistrationsSubnet'] = ResolversParentTypes['ChainDeregistrationsSubnet']> = ResolversObject<{
  deregistrations?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  deregistrations_per_hotkey?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  distinct_deregistered_hotkeys?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainEventResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainEvent'] = ResolversParentTypes['ChainEvent']> = ResolversObject<{
  amount_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  block_hash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  block_number?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  call_function?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  call_module?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  coldkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  event_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  event_index?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  event_kind?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  extrinsic_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  extrinsic_index?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  hotkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  method?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  pallet?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  signer?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  table?: Resolver<ResolversTypes['ChainFirehoseTable'], ParentType, ContextType>;
}>;

export type ChainEventRowResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainEventRow'] = ResolversParentTypes['ChainEventRow']> = ResolversObject<{
  args?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  event_index?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  extrinsic_index?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  method?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  pallet?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  phase?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainEventsFeedResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainEventsFeed'] = ResolversParentTypes['ChainEventsFeed']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  events?: Resolver<Array<ResolversTypes['ChainEventRow']>, ParentType, ContextType>;
  next_before?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainEventsStatsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainEventsStats'] = ResolversParentTypes['ChainEventsStats']> = ResolversObject<{
  activity?: Resolver<Array<ResolversTypes['ChainEventsStatsRow']>, ParentType, ContextType>;
  groups?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window_blocks?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainEventsStatsRowResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainEventsStatsRow'] = ResolversParentTypes['ChainEventsStatsRow']> = ResolversObject<{
  count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  method?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  pallet?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainFeePayerResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainFeePayer'] = ResolversParentTypes['ChainFeePayer']> = ResolversObject<{
  extrinsic_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  signer?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_fee_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_tip_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ChainFeesResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainFees'] = ResolversParentTypes['ChainFees']> = ResolversObject<{
  daily?: Resolver<Array<ResolversTypes['ChainFeesDay']>, ParentType, ContextType>;
  day_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  top_fee_payers?: Resolver<Array<ResolversTypes['ChainFeePayer']>, ParentType, ContextType>;
  window?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type ChainFeesDayResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainFeesDay'] = ResolversParentTypes['ChainFeesDay']> = ResolversObject<{
  avg_fee_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  avg_tip_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  day?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  extrinsic_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  median_fee_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  median_tip_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_fee_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_tip_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ChainIdentityHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainIdentityHistory'] = ResolversParentTypes['ChainIdentityHistory']> = ResolversObject<{
  changes?: Resolver<Array<ResolversTypes['ChainIdentityHistoryEntry']>, ParentType, ContextType>;
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainIdentityHistoryEntryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainIdentityHistoryEntry'] = ResolversParentTypes['ChainIdentityHistoryEntry']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  discord?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  github_repo?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  identity_hash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  logo_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  symbol?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainIdleStakeResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainIdleStake'] = ResolversParentTypes['ChainIdleStake']> = ResolversObject<{
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ChainIdleStakeSubnet']>, ParentType, ContextType>;
  total_idle_stake_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainIdleStakeSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainIdleStakeSubnet'] = ResolversParentTypes['ChainIdleStakeSubnet']> = ResolversObject<{
  idle_neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  idle_stake_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainPerformanceResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainPerformance'] = ResolversParentTypes['ChainPerformance']> = ResolversObject<{
  active_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  consensus?: Resolver<Maybe<ResolversTypes['ScoreDistribution']>, ParentType, ContextType>;
  dividends?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  incentive?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  trust?: Resolver<Maybe<ResolversTypes['ScoreDistribution']>, ParentType, ContextType>;
  validator_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validator_trust?: Resolver<Maybe<ResolversTypes['ScoreDistribution']>, ParentType, ContextType>;
}>;

export type ChainPrometheusResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainPrometheus'] = ResolversParentTypes['ChainPrometheus']> = ResolversObject<{
  intensity_distribution?: Resolver<Maybe<ResolversTypes['ChainPrometheusIntensityDistribution']>, ParentType, ContextType>;
  network?: Resolver<ResolversTypes['ChainPrometheusNetwork'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ChainPrometheusSubnet']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainPrometheusIntensityDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainPrometheusIntensityDistribution'] = ResolversParentTypes['ChainPrometheusIntensityDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  mean?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  median?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  min?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p25?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p75?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p90?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainPrometheusNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainPrometheusNetwork'] = ResolversParentTypes['ChainPrometheusNetwork']> = ResolversObject<{
  announcements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  announcements_per_exporter?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  distinct_exporters?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainPrometheusSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainPrometheusSubnet'] = ResolversParentTypes['ChainPrometheusSubnet']> = ResolversObject<{
  announcements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  announcements_per_exporter?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  distinct_exporters?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainRegistrationsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainRegistrations'] = ResolversParentTypes['ChainRegistrations']> = ResolversObject<{
  intensity_distribution?: Resolver<Maybe<ResolversTypes['ChainRegistrationsIntensityDistribution']>, ParentType, ContextType>;
  network?: Resolver<ResolversTypes['ChainRegistrationsNetwork'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ChainRegistrationsSubnet']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainRegistrationsIntensityDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainRegistrationsIntensityDistribution'] = ResolversParentTypes['ChainRegistrationsIntensityDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  mean?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  median?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  min?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p25?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p75?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p90?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainRegistrationsNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainRegistrationsNetwork'] = ResolversParentTypes['ChainRegistrationsNetwork']> = ResolversObject<{
  distinct_registrants?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  registrations?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  registrations_per_registrant?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ChainRegistrationsSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainRegistrationsSubnet'] = ResolversParentTypes['ChainRegistrationsSubnet']> = ResolversObject<{
  distinct_registrants?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  registrations?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  registrations_per_registrant?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ChainServingResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainServing'] = ResolversParentTypes['ChainServing']> = ResolversObject<{
  intensity_distribution?: Resolver<Maybe<ResolversTypes['ChainServingIntensityDistribution']>, ParentType, ContextType>;
  network?: Resolver<ResolversTypes['ChainServingNetwork'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ChainServingSubnet']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainServingIntensityDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainServingIntensityDistribution'] = ResolversParentTypes['ChainServingIntensityDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  mean?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  median?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  min?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p25?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p75?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p90?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainServingNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainServingNetwork'] = ResolversParentTypes['ChainServingNetwork']> = ResolversObject<{
  announcements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  announcements_per_server?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  distinct_servers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainServingSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainServingSubnet'] = ResolversParentTypes['ChainServingSubnet']> = ResolversObject<{
  announcements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  announcements_per_server?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  distinct_servers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainSignerResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainSigner'] = ResolversParentTypes['ChainSigner']> = ResolversObject<{
  last_tx_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  signer?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_fee_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_tip_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  tx_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainSignersResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainSigners'] = ResolversParentTypes['ChainSigners']> = ResolversObject<{
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  signer_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  signers?: Resolver<Array<ResolversTypes['ChainSigner']>, ParentType, ContextType>;
  sort?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainStakeFlowResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainStakeFlow'] = ResolversParentTypes['ChainStakeFlow']> = ResolversObject<{
  net_flow_distribution?: Resolver<Maybe<ResolversTypes['ChainStakeFlowDistribution']>, ParentType, ContextType>;
  network?: Resolver<ResolversTypes['ChainStakeFlowNetwork'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ChainStakeFlowSubnet']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainStakeFlowDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainStakeFlowDistribution'] = ResolversParentTypes['ChainStakeFlowDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  mean?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  median?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  min?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p25?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p75?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p90?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainStakeFlowNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainStakeFlowNetwork'] = ResolversParentTypes['ChainStakeFlowNetwork']> = ResolversObject<{
  flat?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  gaining?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  gross_flow_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  losing?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  net_flow_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  stake_events?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_staked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_unstaked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  unstake_events?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainStakeFlowSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainStakeFlowSubnet'] = ResolversParentTypes['ChainStakeFlowSubnet']> = ResolversObject<{
  direction?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  gross_flow_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  net_flow_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stake_events?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_staked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_unstaked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  unstake_events?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainStakeMovesResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainStakeMoves'] = ResolversParentTypes['ChainStakeMoves']> = ResolversObject<{
  intensity_distribution?: Resolver<Maybe<ResolversTypes['ChainStakeMovesIntensityDistribution']>, ParentType, ContextType>;
  network?: Resolver<ResolversTypes['ChainStakeMovesNetwork'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ChainStakeMovesSubnet']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainStakeMovesIntensityDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainStakeMovesIntensityDistribution'] = ResolversParentTypes['ChainStakeMovesIntensityDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  mean?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  median?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  min?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p25?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p75?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p90?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainStakeMovesNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainStakeMovesNetwork'] = ResolversParentTypes['ChainStakeMovesNetwork']> = ResolversObject<{
  distinct_movers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  movements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  movements_per_mover?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ChainStakeMovesSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainStakeMovesSubnet'] = ResolversParentTypes['ChainStakeMovesSubnet']> = ResolversObject<{
  distinct_movers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  movements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  movements_per_mover?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainStakeTransfersResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainStakeTransfers'] = ResolversParentTypes['ChainStakeTransfers']> = ResolversObject<{
  intensity_distribution?: Resolver<Maybe<ResolversTypes['ChainStakeTransfersIntensityDistribution']>, ParentType, ContextType>;
  network?: Resolver<ResolversTypes['ChainStakeTransfersNetwork'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ChainStakeTransfersSubnet']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainStakeTransfersIntensityDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainStakeTransfersIntensityDistribution'] = ResolversParentTypes['ChainStakeTransfersIntensityDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  mean?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  median?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  min?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p25?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p75?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p90?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainStakeTransfersNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainStakeTransfersNetwork'] = ResolversParentTypes['ChainStakeTransfersNetwork']> = ResolversObject<{
  distinct_senders?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  transfers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  transfers_per_sender?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ChainStakeTransfersSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainStakeTransfersSubnet'] = ResolversParentTypes['ChainStakeTransfersSubnet']> = ResolversObject<{
  distinct_senders?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  transfers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  transfers_per_sender?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ChainTransferPairResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainTransferPair'] = ResolversParentTypes['ChainTransferPair']> = ResolversObject<{
  from?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  last_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  last_observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  to?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  transfer_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainTransferPairsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainTransferPairs'] = ResolversParentTypes['ChainTransferPairs']> = ResolversObject<{
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  pair_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  pairs?: Resolver<Array<ResolversTypes['ChainTransferPair']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  top_pair_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  transfer_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  unique_pairs?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainTransferPartyResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainTransferParty'] = ResolversParentTypes['ChainTransferParty']> = ResolversObject<{
  address?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  transfer_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainTransfersResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainTransfers'] = ResolversParentTypes['ChainTransfers']> = ResolversObject<{
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  top_receivers?: Resolver<Array<ResolversTypes['ChainTransferParty']>, ParentType, ContextType>;
  top_sender_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  top_senders?: Resolver<Array<ResolversTypes['ChainTransferParty']>, ParentType, ContextType>;
  total_volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  transfer_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  unique_receivers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  unique_senders?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainTurnoverResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainTurnover'] = ResolversParentTypes['ChainTurnover']> = ResolversObject<{
  comparable?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  end_date?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  network?: Resolver<ResolversTypes['ChainTurnoverNetwork'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stability_distribution?: Resolver<Maybe<ResolversTypes['ChainTurnoverStabilityDistribution']>, ParentType, ContextType>;
  start_date?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ChainTurnoverSubnet']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainTurnoverNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainTurnoverNetwork'] = ResolversParentTypes['ChainTurnoverNetwork']> = ResolversObject<{
  stability_score?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_retention?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validators_end?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators_entered?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators_exited?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators_start?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainTurnoverStabilityDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainTurnoverStabilityDistribution'] = ResolversParentTypes['ChainTurnoverStabilityDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  mean?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  median?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  min?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p25?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p75?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p90?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainTurnoverSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainTurnoverSubnet'] = ResolversParentTypes['ChainTurnoverSubnet']> = ResolversObject<{
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stability_score?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_retention?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validators_end?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators_entered?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators_exited?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators_start?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainWeightSetterResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainWeightSetter'] = ResolversParentTypes['ChainWeightSetter']> = ResolversObject<{
  first_set_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  hotkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_set_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  weight_sets?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainWeightSettersResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainWeightSetters'] = ResolversParentTypes['ChainWeightSetters']> = ResolversObject<{
  distinct_setters?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  setter_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  setters?: Resolver<Array<ResolversTypes['ChainWeightSetter']>, ParentType, ContextType>;
  weight_sets?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainWeightsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainWeights'] = ResolversParentTypes['ChainWeights']> = ResolversObject<{
  intensity_distribution?: Resolver<Maybe<ResolversTypes['ChainWeightsIntensityDistribution']>, ParentType, ContextType>;
  network?: Resolver<ResolversTypes['ChainWeightsNetwork'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ChainWeightsSubnet']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ChainWeightsIntensityDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainWeightsIntensityDistribution'] = ResolversParentTypes['ChainWeightsIntensityDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  mean?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  median?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  min?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p25?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p75?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p90?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ChainWeightsNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainWeightsNetwork'] = ResolversParentTypes['ChainWeightsNetwork']> = ResolversObject<{
  distinct_setters?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sets_per_setter?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  weight_sets?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainWeightsSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainWeightsSubnet'] = ResolversParentTypes['ChainWeightsSubnet']> = ResolversObject<{
  distinct_setters?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sets_per_setter?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  weight_sets?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ChainYieldResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ChainYield'] = ResolversParentTypes['ChainYield']> = ResolversObject<{
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  distribution?: Resolver<Maybe<ResolversTypes['YieldDistribution']>, ParentType, ContextType>;
  miner_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  miner_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  network_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_emission_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_stake_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  validator_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validator_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ChangelogResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Changelog'] = ResolversParentTypes['Changelog']> = ResolversObject<{
  artifacts?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  coverage_delta?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnets?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  summary?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
}>;

export type CompareResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Compare'] = ResolversParentTypes['Compare']> = ResolversObject<{
  dimensions?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  requested_netuids?: Resolver<Array<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['CompareSubnet']>, ParentType, ContextType>;
}>;

export type CompareEconomicsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['CompareEconomics'] = ResolversParentTypes['CompareEconomics']> = ResolversObject<{
  alpha_price_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  emission_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  miner_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  miner_readiness?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  open_slots?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  registration_allowed?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  registration_cost_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type CompareHealthResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['CompareHealth'] = ResolversParentTypes['CompareHealth']> = ResolversObject<{
  avg_latency_ms?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  ok_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  surface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type CompareStructureResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['CompareStructure'] = ResolversParentTypes['CompareStructure']> = ResolversObject<{
  completeness_score?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  operational_interface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  surface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type CompareSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['CompareSubnet'] = ResolversParentTypes['CompareSubnet']> = ResolversObject<{
  economics?: Resolver<Maybe<ResolversTypes['CompareEconomics']>, ParentType, ContextType>;
  found?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  health?: Resolver<Maybe<ResolversTypes['CompareHealth']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  slug?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  structure?: Resolver<Maybe<ResolversTypes['CompareStructure']>, ParentType, ContextType>;
}>;

export type ComparedValidatorResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ComparedValidator'] = ResolversParentTypes['ComparedValidator']> = ResolversObject<{
  apy_estimate?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  apy_estimate_eligible_subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  avg_validator_trust?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  coldkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  coldkey_identity?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  hotkey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  max_validator_trust?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  nominator_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  subnet_context?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  take?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_emission_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_stake_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ConcentrationMetricsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ConcentrationMetrics'] = ResolversParentTypes['ConcentrationMetrics']> = ResolversObject<{
  entropy?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  entropy_normalized?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  gini?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  hhi?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  hhi_normalized?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  holders?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  nakamoto_coefficient?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  top_1pct_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  top_5pct_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  top_10pct_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  top_20pct_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ContractsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Contracts'] = ResolversParentTypes['Contracts']> = ResolversObject<{
  artifacts?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  base_path?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  contract_version?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  openapi_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  primary_domain?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  type_definitions_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type DomainOverviewResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['DomainOverview'] = ResolversParentTypes['DomainOverview']> = ResolversObject<{
  domain_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  domains?: Resolver<Array<ResolversTypes['DomainSummary']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type DomainSummaryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['DomainSummary'] = ResolversParentTypes['DomainSummary']> = ResolversObject<{
  domain?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  emission_concentration?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  netuids?: Resolver<Array<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_emission_share?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_stake_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type EconomicsListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['EconomicsList'] = ResolversParentTypes['EconomicsList']> = ResolversObject<{
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['SubnetEconomics']>, ParentType, ContextType>;
  summary?: Resolver<Maybe<ResolversTypes['EconomicsSummary']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type EconomicsSummaryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['EconomicsSummary'] = ResolversParentTypes['EconomicsSummary']> = ResolversObject<{
  registration_open_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_alpha_value_tao?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_miners?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_network_value_tao?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_root_value_tao?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_stake_tao?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_validators?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  with_economics_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type EconomicsTrendsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['EconomicsTrends'] = ResolversParentTypes['EconomicsTrends']> = ResolversObject<{
  day_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  days?: Resolver<Array<ResolversTypes['EconomicsTrendsDay']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type EconomicsTrendsDayResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['EconomicsTrendsDay'] = ResolversParentTypes['EconomicsTrendsDay']> = ResolversObject<{
  alpha_price_tao_median?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_price_tao_weighted?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  mean_emission_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  miner_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  snapshot_date?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_stake_tao?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  validator_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type EndpointResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Endpoint'] = ResolversParentTypes['Endpoint']> = ResolversObject<{
  auth_required?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  authority?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  classification?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  health_source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  kind?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_checked?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_ok?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  latency_ms?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  latest_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  layer?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  monitoring_status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  network?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  operator?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  pool_eligible?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  provider?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  public_safe?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  score?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  source_urls?: Resolver<Maybe<Array<ResolversTypes['String']>>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_slug?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  surface_id?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  surface_key?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type EndpointIncidentResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['EndpointIncident'] = ResolversParentTypes['EndpointIncident']> = ResolversObject<{
  classification?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  detected_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  endpoint_id?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  health_source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  health_stale?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  id?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  kind?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_checked?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_ok?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  layer?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  operator?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  pool_eligible?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  provider?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  reason?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  severity?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  state?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_slug?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  surface_id?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  surface_key?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  user_reported?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
}>;

export type EndpointListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['EndpointList'] = ResolversParentTypes['EndpointList']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['Endpoint']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type EvidenceListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['EvidenceList'] = ResolversParentTypes['EvidenceList']> = ResolversObject<{
  claims?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  summary?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type EvmAddressMappingResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['EvmAddressMapping'] = ResolversParentTypes['EvmAddressMapping']> = ResolversObject<{
  h160?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  queried_at?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ss58?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ExtrinsicResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Extrinsic'] = ResolversParentTypes['Extrinsic']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  call_args?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  call_function?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  call_module?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  extrinsic_hash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  extrinsic_index?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  fee_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  signer?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  tip_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ExtrinsicDetailResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ExtrinsicDetail'] = ResolversParentTypes['ExtrinsicDetail']> = ResolversObject<{
  extrinsic?: Resolver<Maybe<ResolversTypes['Extrinsic']>, ParentType, ContextType>;
  ref?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ExtrinsicListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ExtrinsicList'] = ResolversParentTypes['ExtrinsicList']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['Extrinsic']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type GapsListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['GapsList'] = ResolversParentTypes['GapsList']> = ResolversObject<{
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  gaps?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type GlobalHealthResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['GlobalHealth'] = ResolversParentTypes['GlobalHealth']> = ResolversObject<{
  avg_latency_ms?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  degraded_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  failed_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  health_source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_checked?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_ok?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  latency_sample_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  ok_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  operational_observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  scope?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['SubnetHealth']>, ParentType, ContextType>;
  surface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  unknown_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type GlobalIncidentsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['GlobalIncidents'] = ResolversParentTypes['GlobalIncidents']> = ResolversObject<{
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  summary?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  surfaces?: Resolver<Array<ResolversTypes['EndpointIncident']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type HealthHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['HealthHistory'] = ResolversParentTypes['HealthHistory']> = ResolversObject<{
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  date?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  summary?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  surfaces?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type HealthTrendsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['HealthTrends'] = ResolversParentTypes['HealthTrends']> = ResolversObject<{
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  windows?: Resolver<ResolversTypes['JSON'], ParentType, ContextType>;
}>;

export type HyperparametersResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Hyperparameters'] = ResolversParentTypes['Hyperparameters']> = ResolversObject<{
  activity_cutoff?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  activity_cutoff_factor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  alpha_high_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_low_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_sigmoid_steepness?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  bonds_moving_avg_raw?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  bonds_reset_enabled?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  burn_half_life?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  burn_increase_mult?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  commit_reveal_enabled?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  commit_reveal_period?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  immunity_period?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  kappa_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  liquid_alpha_enabled?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  max_burn_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  max_regs_per_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  max_validators?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  max_weight_limit_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  min_allowed_weights?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  min_burn_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  min_childkey_take_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  owner_cut_auto_lock_enabled?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  owner_cut_enabled?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  registration_allowed?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  serving_rate_limit?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  subnet_is_active?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  target_regs_per_interval?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  tempo?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  transfers_enabled?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  user_liquidity_enabled?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  weights_rate_limit?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  weights_version?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  yuma_version?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type HyperparamsHistoryEntryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['HyperparamsHistoryEntry'] = ResolversParentTypes['HyperparamsHistoryEntry']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  hyperparameters?: Resolver<Maybe<ResolversTypes['Hyperparameters']>, ParentType, ContextType>;
  hyperparams_hash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type IdentityResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Identity'] = ResolversParentTypes['Identity']> = ResolversObject<{
  additional?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  discord?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  github?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  has_identity?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  image?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type IncidentListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['IncidentList'] = ResolversParentTypes['IncidentList']> = ResolversObject<{
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  incidents?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  summary?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export interface JsonScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['JSON'], any> {
  name: 'JSON';
}

export type NetworkParametersResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['NetworkParameters'] = ResolversParentTypes['NetworkParameters']> = ResolversObject<{
  pending_childkey_cooldown_blocks?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  queried_at?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stake_threshold_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  tao_weight?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type NetworkRandomnessResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['NetworkRandomness'] = ResolversParentTypes['NetworkRandomness']> = ResolversObject<{
  last_stored_round?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  oldest_stored_round?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  queried_at?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stored_round_span?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type NeuronResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Neuron'] = ResolversParentTypes['Neuron']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  neuron?: Resolver<Maybe<ResolversTypes['NeuronState']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type NeuronHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['NeuronHistory'] = ResolversParentTypes['NeuronHistory']> = ResolversObject<{
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  point_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  points?: Resolver<Array<ResolversTypes['NeuronHistoryPoint']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  uid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type NeuronHistoryPointResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['NeuronHistoryPoint'] = ResolversParentTypes['NeuronHistoryPoint']> = ResolversObject<{
  active?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  axon?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  coldkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  consensus?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  dividends?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  emission_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  hotkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  incentive?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  is_immunity_period?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  rank?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  registered_at_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  snapshot_date?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  take?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  trust?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  validator_permit?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  validator_trust?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type NeuronStateResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['NeuronState'] = ResolversParentTypes['NeuronState']> = ResolversObject<{
  active?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  axon?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  coldkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  consensus?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  dividends?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  emission_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  hotkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  immunity_expires_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  immunity_expires_at_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  incentive?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  is_immunity_period?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  rank?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  registered_at_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  take?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  trust?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  validator_permit?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  validator_trust?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type NominatorResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Nominator'] = ResolversParentTypes['Nominator']> = ResolversObject<{
  coldkey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  event_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  gross_staked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  last_observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  net_staked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  staked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  unstaked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type NominatorListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['NominatorList'] = ResolversParentTypes['NominatorList']> = ResolversObject<{
  hotkey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  nominator_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  nominators?: Resolver<Array<ResolversTypes['Nominator']>, ParentType, ContextType>;
  offset?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type NominatorPositionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['NominatorPosition'] = ResolversParentTypes['NominatorPosition']> = ResolversObject<{
  hotkey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  share_fraction?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  stake_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type OpportunityBoardsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['OpportunityBoards'] = ResolversParentTypes['OpportunityBoards']> = ResolversObject<{
  biggest_alpha_gain_1d?: Resolver<Array<ResolversTypes['OpportunityEntry']>, ParentType, ContextType>;
  biggest_alpha_gain_7d?: Resolver<Array<ResolversTypes['OpportunityEntry']>, ParentType, ContextType>;
  cheapest_registration?: Resolver<Array<ResolversTypes['OpportunityEntry']>, ParentType, ContextType>;
  highest_emission?: Resolver<Array<ResolversTypes['OpportunityEntry']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  open_slots?: Resolver<Array<ResolversTypes['OpportunityEntry']>, ParentType, ContextType>;
  validator_headroom?: Resolver<Array<ResolversTypes['OpportunityEntry']>, ParentType, ContextType>;
  with_economics_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type OpportunityEntryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['OpportunityEntry'] = ResolversParentTypes['OpportunityEntry']> = ResolversObject<{
  alpha_price_change_1d?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_price_change_7d?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_price_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  emission_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  max_uids?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  max_validators?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  miner_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  open_slots?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  registration_allowed?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  registration_cost_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  slug?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total_stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  validator_headroom?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type PoolListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['PoolList'] = ResolversParentTypes['PoolList']> = ResolversObject<{
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  operational_observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  pools?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ProfileListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ProfileList'] = ResolversParentTypes['ProfileList']> = ResolversObject<{
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  profiles?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ProviderResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Provider'] = ResolversParentTypes['Provider']> = ResolversObject<{
  authority?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  contact_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  docs_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  endpoint_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  endpoints?: Resolver<Array<ResolversTypes['Endpoint']>, ParentType, ContextType>;
  github_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  kind?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  logo_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuids?: Resolver<Array<Maybe<ResolversTypes['Int']>>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  public_notes?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['Subnet']>, ParentType, ContextType>;
  surface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  website_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ProviderListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ProviderList'] = ResolversParentTypes['ProviderList']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['Provider']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type QueryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query']> = ResolversObject<{
  account?: Resolver<Maybe<ResolversTypes['AccountSummary']>, ParentType, ContextType, RequireFields<QueryAccountArgs, 'ss58'>>;
  account_axon_removals?: Resolver<ResolversTypes['AccountAxonRemovals'], ParentType, ContextType, RequireFields<QueryAccount_Axon_RemovalsArgs, 'ss58'>>;
  account_balance?: Resolver<Maybe<ResolversTypes['AccountBalance']>, ParentType, ContextType, RequireFields<QueryAccount_BalanceArgs, 'ss58'>>;
  account_children?: Resolver<Maybe<ResolversTypes['AccountChildren']>, ParentType, ContextType, RequireFields<QueryAccount_ChildrenArgs, 'ss58'>>;
  account_counterparties?: Resolver<ResolversTypes['AccountCounterparties'], ParentType, ContextType, RequireFields<QueryAccount_CounterpartiesArgs, 'ss58'>>;
  account_deregistrations?: Resolver<ResolversTypes['AccountDeregistrations'], ParentType, ContextType, RequireFields<QueryAccount_DeregistrationsArgs, 'ss58'>>;
  account_entities?: Resolver<ResolversTypes['AccountEntities'], ParentType, ContextType, RequireFields<QueryAccount_EntitiesArgs, 'ss58'>>;
  account_events?: Resolver<ResolversTypes['AccountEvents'], ParentType, ContextType, RequireFields<QueryAccount_EventsArgs, 'ss58'>>;
  account_extrinsics?: Resolver<ResolversTypes['AccountExtrinsics'], ParentType, ContextType, RequireFields<QueryAccount_ExtrinsicsArgs, 'ss58'>>;
  account_history?: Resolver<ResolversTypes['AccountHistory'], ParentType, ContextType, RequireFields<QueryAccount_HistoryArgs, 'ss58'>>;
  account_identity?: Resolver<ResolversTypes['AccountIdentity'], ParentType, ContextType, RequireFields<QueryAccount_IdentityArgs, 'ss58'>>;
  account_identity_history?: Resolver<ResolversTypes['AccountIdentityHistory'], ParentType, ContextType, RequireFields<QueryAccount_Identity_HistoryArgs, 'ss58'>>;
  account_parents?: Resolver<Maybe<ResolversTypes['AccountParents']>, ParentType, ContextType, RequireFields<QueryAccount_ParentsArgs, 'ss58'>>;
  account_portfolio?: Resolver<ResolversTypes['AccountPortfolio'], ParentType, ContextType, RequireFields<QueryAccount_PortfolioArgs, 'ss58'>>;
  account_position_history?: Resolver<ResolversTypes['AccountPositionHistory'], ParentType, ContextType, RequireFields<QueryAccount_Position_HistoryArgs, 'netuid' | 'ss58'>>;
  account_positions?: Resolver<ResolversTypes['AccountPositions'], ParentType, ContextType, RequireFields<QueryAccount_PositionsArgs, 'ss58'>>;
  account_prometheus?: Resolver<ResolversTypes['AccountPrometheus'], ParentType, ContextType, RequireFields<QueryAccount_PrometheusArgs, 'ss58'>>;
  account_registrations?: Resolver<ResolversTypes['AccountRegistrations'], ParentType, ContextType, RequireFields<QueryAccount_RegistrationsArgs, 'ss58'>>;
  account_root_claim?: Resolver<Maybe<ResolversTypes['AccountRootClaim']>, ParentType, ContextType, RequireFields<QueryAccount_Root_ClaimArgs, 'ss58'>>;
  account_serving?: Resolver<ResolversTypes['AccountServing'], ParentType, ContextType, RequireFields<QueryAccount_ServingArgs, 'ss58'>>;
  account_stake_flow?: Resolver<ResolversTypes['AccountStakeFlow'], ParentType, ContextType, RequireFields<QueryAccount_Stake_FlowArgs, 'ss58'>>;
  account_stake_moves?: Resolver<ResolversTypes['AccountStakeMoves'], ParentType, ContextType, RequireFields<QueryAccount_Stake_MovesArgs, 'ss58'>>;
  account_subnets?: Resolver<ResolversTypes['AccountSubnets'], ParentType, ContextType, RequireFields<QueryAccount_SubnetsArgs, 'ss58'>>;
  account_transfers?: Resolver<ResolversTypes['AccountTransfers'], ParentType, ContextType, RequireFields<QueryAccount_TransfersArgs, 'ss58'>>;
  account_weight_setters?: Resolver<ResolversTypes['AccountWeightSetters'], ParentType, ContextType, RequireFields<QueryAccount_Weight_SettersArgs, 'ss58'>>;
  accounts?: Resolver<ResolversTypes['AccountList'], ParentType, ContextType, Partial<QueryAccountsArgs>>;
  adapter?: Resolver<Maybe<ResolversTypes['Adapter']>, ParentType, ContextType, RequireFields<QueryAdapterArgs, 'slug'>>;
  agent_catalog?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, Partial<QueryAgent_CatalogArgs>>;
  agent_resources?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  block?: Resolver<Maybe<ResolversTypes['BlockDetail']>, ParentType, ContextType, RequireFields<QueryBlockArgs, 'ref'>>;
  block_chain_events?: Resolver<ResolversTypes['BlockChainEvents'], ParentType, ContextType, RequireFields<QueryBlock_Chain_EventsArgs, 'block_number'>>;
  block_events?: Resolver<ResolversTypes['BlockEvents'], ParentType, ContextType, RequireFields<QueryBlock_EventsArgs, 'ref'>>;
  block_extrinsics?: Resolver<ResolversTypes['BlockExtrinsics'], ParentType, ContextType, RequireFields<QueryBlock_ExtrinsicsArgs, 'ref'>>;
  blocks?: Resolver<ResolversTypes['BlockList'], ParentType, ContextType, Partial<QueryBlocksArgs>>;
  blocks_summary?: Resolver<ResolversTypes['BlocksSummary'], ParentType, ContextType>;
  build?: Resolver<ResolversTypes['BuildSummary'], ParentType, ContextType>;
  candidates?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, Partial<QueryCandidatesArgs>>;
  chain_activity?: Resolver<ResolversTypes['ChainActivity'], ParentType, ContextType, Partial<QueryChain_ActivityArgs>>;
  chain_alpha_volume?: Resolver<ResolversTypes['ChainAlphaVolume'], ParentType, ContextType, Partial<QueryChain_Alpha_VolumeArgs>>;
  chain_axon_removals?: Resolver<ResolversTypes['ChainAxonRemovals'], ParentType, ContextType, Partial<QueryChain_Axon_RemovalsArgs>>;
  chain_calls?: Resolver<ResolversTypes['ChainCalls'], ParentType, ContextType, Partial<QueryChain_CallsArgs>>;
  chain_concentration?: Resolver<ResolversTypes['ChainConcentration'], ParentType, ContextType>;
  chain_deregistrations?: Resolver<ResolversTypes['ChainDeregistrations'], ParentType, ContextType, Partial<QueryChain_DeregistrationsArgs>>;
  chain_events?: Resolver<ResolversTypes['ChainEventsFeed'], ParentType, ContextType, Partial<QueryChain_EventsArgs>>;
  chain_events_stats?: Resolver<ResolversTypes['ChainEventsStats'], ParentType, ContextType, Partial<QueryChain_Events_StatsArgs>>;
  chain_fees?: Resolver<ResolversTypes['ChainFees'], ParentType, ContextType, Partial<QueryChain_FeesArgs>>;
  chain_identity_history?: Resolver<ResolversTypes['ChainIdentityHistory'], ParentType, ContextType, Partial<QueryChain_Identity_HistoryArgs>>;
  chain_idle_stake?: Resolver<ResolversTypes['ChainIdleStake'], ParentType, ContextType>;
  chain_performance?: Resolver<ResolversTypes['ChainPerformance'], ParentType, ContextType>;
  chain_prometheus?: Resolver<ResolversTypes['ChainPrometheus'], ParentType, ContextType, Partial<QueryChain_PrometheusArgs>>;
  chain_registrations?: Resolver<ResolversTypes['ChainRegistrations'], ParentType, ContextType, Partial<QueryChain_RegistrationsArgs>>;
  chain_serving?: Resolver<ResolversTypes['ChainServing'], ParentType, ContextType, Partial<QueryChain_ServingArgs>>;
  chain_signers?: Resolver<ResolversTypes['ChainSigners'], ParentType, ContextType, Partial<QueryChain_SignersArgs>>;
  chain_stake_flow?: Resolver<ResolversTypes['ChainStakeFlow'], ParentType, ContextType, Partial<QueryChain_Stake_FlowArgs>>;
  chain_stake_moves?: Resolver<ResolversTypes['ChainStakeMoves'], ParentType, ContextType, Partial<QueryChain_Stake_MovesArgs>>;
  chain_stake_transfers?: Resolver<ResolversTypes['ChainStakeTransfers'], ParentType, ContextType, Partial<QueryChain_Stake_TransfersArgs>>;
  chain_transfer_pairs?: Resolver<ResolversTypes['ChainTransferPairs'], ParentType, ContextType, Partial<QueryChain_Transfer_PairsArgs>>;
  chain_transfers?: Resolver<ResolversTypes['ChainTransfers'], ParentType, ContextType, Partial<QueryChain_TransfersArgs>>;
  chain_turnover?: Resolver<ResolversTypes['ChainTurnover'], ParentType, ContextType, Partial<QueryChain_TurnoverArgs>>;
  chain_weight_setters?: Resolver<ResolversTypes['ChainWeightSetters'], ParentType, ContextType, Partial<QueryChain_Weight_SettersArgs>>;
  chain_weights?: Resolver<ResolversTypes['ChainWeights'], ParentType, ContextType, Partial<QueryChain_WeightsArgs>>;
  chain_yield?: Resolver<ResolversTypes['ChainYield'], ParentType, ContextType>;
  changelog?: Resolver<Maybe<ResolversTypes['Changelog']>, ParentType, ContextType>;
  compare?: Resolver<ResolversTypes['Compare'], ParentType, ContextType, RequireFields<QueryCompareArgs, 'netuids'>>;
  compare_validators?: Resolver<ResolversTypes['ValidatorComparison'], ParentType, ContextType, RequireFields<QueryCompare_ValidatorsArgs, 'hotkeys'>>;
  contracts?: Resolver<Maybe<ResolversTypes['Contracts']>, ParentType, ContextType>;
  coverage?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  coverage_depth?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  curation?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  domain_summary?: Resolver<ResolversTypes['DomainSummary'], ParentType, ContextType, RequireFields<QueryDomain_SummaryArgs, 'tag'>>;
  domains?: Resolver<ResolversTypes['DomainOverview'], ParentType, ContextType>;
  economics?: Resolver<ResolversTypes['EconomicsList'], ParentType, ContextType, Partial<QueryEconomicsArgs>>;
  economics_trends?: Resolver<ResolversTypes['EconomicsTrends'], ParentType, ContextType, Partial<QueryEconomics_TrendsArgs>>;
  endpoint_incidents?: Resolver<ResolversTypes['IncidentList'], ParentType, ContextType, Partial<QueryEndpoint_IncidentsArgs>>;
  endpoint_pools?: Resolver<ResolversTypes['PoolList'], ParentType, ContextType, Partial<QueryEndpoint_PoolsArgs>>;
  endpoints?: Resolver<ResolversTypes['EndpointList'], ParentType, ContextType, Partial<QueryEndpointsArgs>>;
  evidence?: Resolver<ResolversTypes['EvidenceList'], ParentType, ContextType, Partial<QueryEvidenceArgs>>;
  evm_address?: Resolver<Maybe<ResolversTypes['EvmAddressMapping']>, ParentType, ContextType, RequireFields<QueryEvm_AddressArgs, 'h160'>>;
  evm_address_mapping?: Resolver<Maybe<ResolversTypes['EvmAddressMapping']>, ParentType, ContextType, RequireFields<QueryEvm_Address_MappingArgs, 'h160'>>;
  extrinsic?: Resolver<Maybe<ResolversTypes['ExtrinsicDetail']>, ParentType, ContextType, RequireFields<QueryExtrinsicArgs, 'ref'>>;
  extrinsics?: Resolver<ResolversTypes['ExtrinsicList'], ParentType, ContextType, Partial<QueryExtrinsicsArgs>>;
  fixtures?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  freshness?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  gaps?: Resolver<ResolversTypes['GapsList'], ParentType, ContextType, Partial<QueryGapsArgs>>;
  global_incidents?: Resolver<ResolversTypes['GlobalIncidents'], ParentType, ContextType, Partial<QueryGlobal_IncidentsArgs>>;
  governance_config_changes?: Resolver<ResolversTypes['ExtrinsicList'], ParentType, ContextType, Partial<QueryGovernance_Config_ChangesArgs>>;
  health?: Resolver<Maybe<ResolversTypes['GlobalHealth']>, ParentType, ContextType>;
  health_history?: Resolver<ResolversTypes['HealthHistory'], ParentType, ContextType, RequireFields<QueryHealth_HistoryArgs, 'date'>>;
  health_trends?: Resolver<ResolversTypes['HealthTrends'], ParentType, ContextType>;
  incidents?: Resolver<ResolversTypes['GlobalIncidents'], ParentType, ContextType, Partial<QueryIncidentsArgs>>;
  lineage?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  network_parameters?: Resolver<Maybe<ResolversTypes['NetworkParameters']>, ParentType, ContextType>;
  network_randomness?: Resolver<Maybe<ResolversTypes['NetworkRandomness']>, ParentType, ContextType>;
  neuron?: Resolver<ResolversTypes['Neuron'], ParentType, ContextType, RequireFields<QueryNeuronArgs, 'netuid' | 'uid'>>;
  neuron_history?: Resolver<ResolversTypes['NeuronHistory'], ParentType, ContextType, RequireFields<QueryNeuron_HistoryArgs, 'netuid' | 'uid'>>;
  opportunity_boards?: Resolver<ResolversTypes['OpportunityBoards'], ParentType, ContextType, Partial<QueryOpportunity_BoardsArgs>>;
  profiles?: Resolver<ResolversTypes['ProfileList'], ParentType, ContextType, Partial<QueryProfilesArgs>>;
  provider?: Resolver<Maybe<ResolversTypes['Provider']>, ParentType, ContextType, RequireFields<QueryProviderArgs, 'id'>>;
  provider_endpoints?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, RequireFields<QueryProvider_EndpointsArgs, 'slug'>>;
  providers?: Resolver<ResolversTypes['ProviderList'], ParentType, ContextType, Partial<QueryProvidersArgs>>;
  randomness_status?: Resolver<Maybe<ResolversTypes['NetworkRandomness']>, ParentType, ContextType>;
  registry_leaderboards?: Resolver<ResolversTypes['RegistryLeaderboards'], ParentType, ContextType, Partial<QueryRegistry_LeaderboardsArgs>>;
  registry_summary?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  review_adapter_candidates?: Resolver<ResolversTypes['ReviewAdapterCandidateList'], ParentType, ContextType, Partial<QueryReview_Adapter_CandidatesArgs>>;
  review_enrichment_evidence?: Resolver<ResolversTypes['ReviewEnrichmentEvidenceList'], ParentType, ContextType, Partial<QueryReview_Enrichment_EvidenceArgs>>;
  review_enrichment_queue?: Resolver<ResolversTypes['ReviewEnrichmentQueueList'], ParentType, ContextType, Partial<QueryReview_Enrichment_QueueArgs>>;
  review_enrichment_targets?: Resolver<ResolversTypes['ReviewEnrichmentTargetList'], ParentType, ContextType, Partial<QueryReview_Enrichment_TargetsArgs>>;
  review_gaps?: Resolver<ResolversTypes['ReviewGapPriorityList'], ParentType, ContextType, Partial<QueryReview_GapsArgs>>;
  review_profile_completeness?: Resolver<ResolversTypes['ReviewProfileCompletenessList'], ParentType, ContextType, Partial<QueryReview_Profile_CompletenessArgs>>;
  rpc_endpoints?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, Partial<QueryRpc_EndpointsArgs>>;
  rpc_pools?: Resolver<ResolversTypes['PoolList'], ParentType, ContextType, Partial<QueryRpc_PoolsArgs>>;
  rpc_usage?: Resolver<ResolversTypes['RpcUsage'], ParentType, ContextType, Partial<QueryRpc_UsageArgs>>;
  runtime?: Resolver<ResolversTypes['RuntimeVersionHistory'], ParentType, ContextType>;
  saved_query?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, RequireFields<QuerySaved_QueryArgs, 'id'>>;
  schemas?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  search?: Resolver<ResolversTypes['SearchDocumentList'], ParentType, ContextType, Partial<QuerySearchArgs>>;
  search_index?: Resolver<ResolversTypes['SearchDocumentList'], ParentType, ContextType, Partial<QuerySearch_IndexArgs>>;
  source_health?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  source_snapshots?: Resolver<ResolversTypes['SourceSnapshotList'], ParentType, ContextType, Partial<QuerySource_SnapshotsArgs>>;
  subnet?: Resolver<Maybe<ResolversTypes['Subnet']>, ParentType, ContextType, RequireFields<QuerySubnetArgs, 'netuid'>>;
  subnet_axon_removals?: Resolver<ResolversTypes['SubnetAxonRemovals'], ParentType, ContextType, RequireFields<QuerySubnet_Axon_RemovalsArgs, 'netuid'>>;
  subnet_burn?: Resolver<Maybe<ResolversTypes['SubnetBurn']>, ParentType, ContextType, RequireFields<QuerySubnet_BurnArgs, 'netuid'>>;
  subnet_candidates?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, RequireFields<QuerySubnet_CandidatesArgs, 'netuid'>>;
  subnet_concentration?: Resolver<ResolversTypes['SubnetConcentration'], ParentType, ContextType, RequireFields<QuerySubnet_ConcentrationArgs, 'netuid'>>;
  subnet_concentration_history?: Resolver<ResolversTypes['SubnetConcentrationHistory'], ParentType, ContextType, RequireFields<QuerySubnet_Concentration_HistoryArgs, 'netuid'>>;
  subnet_conviction?: Resolver<ResolversTypes['SubnetConviction'], ParentType, ContextType, RequireFields<QuerySubnet_ConvictionArgs, 'netuid'>>;
  subnet_deregistrations?: Resolver<ResolversTypes['SubnetDeregistrations'], ParentType, ContextType, RequireFields<QuerySubnet_DeregistrationsArgs, 'netuid'>>;
  subnet_event_summary?: Resolver<ResolversTypes['SubnetEventSummary'], ParentType, ContextType, RequireFields<QuerySubnet_Event_SummaryArgs, 'netuid'>>;
  subnet_events?: Resolver<ResolversTypes['SubnetEvents'], ParentType, ContextType, RequireFields<QuerySubnet_EventsArgs, 'netuid'>>;
  subnet_evidence?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, RequireFields<QuerySubnet_EvidenceArgs, 'netuid'>>;
  subnet_gaps?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, RequireFields<QuerySubnet_GapsArgs, 'netuid'>>;
  subnet_health?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, RequireFields<QuerySubnet_HealthArgs, 'netuid'>>;
  subnet_health_incidents?: Resolver<ResolversTypes['SubnetHealthIncidents'], ParentType, ContextType, RequireFields<QuerySubnet_Health_IncidentsArgs, 'netuid'>>;
  subnet_health_percentiles?: Resolver<ResolversTypes['SubnetHealthPercentiles'], ParentType, ContextType, RequireFields<QuerySubnet_Health_PercentilesArgs, 'netuid'>>;
  subnet_health_trends?: Resolver<ResolversTypes['SubnetHealthTrends'], ParentType, ContextType, RequireFields<QuerySubnet_Health_TrendsArgs, 'netuid'>>;
  subnet_history?: Resolver<ResolversTypes['SubnetHistory'], ParentType, ContextType, RequireFields<QuerySubnet_HistoryArgs, 'netuid'>>;
  subnet_hyperparameters?: Resolver<Maybe<ResolversTypes['SubnetHyperparameters']>, ParentType, ContextType, RequireFields<QuerySubnet_HyperparametersArgs, 'netuid'>>;
  subnet_hyperparameters_history?: Resolver<ResolversTypes['SubnetHyperparamsHistory'], ParentType, ContextType, RequireFields<QuerySubnet_Hyperparameters_HistoryArgs, 'netuid'>>;
  subnet_identity_history?: Resolver<ResolversTypes['SubnetIdentityHistory'], ParentType, ContextType, RequireFields<QuerySubnet_Identity_HistoryArgs, 'netuid'>>;
  subnet_idle_stake?: Resolver<ResolversTypes['SubnetIdleStake'], ParentType, ContextType, RequireFields<QuerySubnet_Idle_StakeArgs, 'netuid'>>;
  subnet_lease?: Resolver<Maybe<ResolversTypes['SubnetLease']>, ParentType, ContextType, RequireFields<QuerySubnet_LeaseArgs, 'netuid'>>;
  subnet_lease_history?: Resolver<ResolversTypes['SubnetLeaseHistory'], ParentType, ContextType, RequireFields<QuerySubnet_Lease_HistoryArgs, 'netuid'>>;
  subnet_metagraph?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, RequireFields<QuerySubnet_MetagraphArgs, 'netuid'>>;
  subnet_movers?: Resolver<ResolversTypes['SubnetMovers'], ParentType, ContextType, Partial<QuerySubnet_MoversArgs>>;
  subnet_ohlc?: Resolver<ResolversTypes['SubnetOhlc'], ParentType, ContextType, RequireFields<QuerySubnet_OhlcArgs, 'netuid'>>;
  subnet_overview?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, RequireFields<QuerySubnet_OverviewArgs, 'netuid'>>;
  subnet_ownership_history?: Resolver<ResolversTypes['SubnetOwnershipHistory'], ParentType, ContextType, RequireFields<QuerySubnet_Ownership_HistoryArgs, 'netuid'>>;
  subnet_performance?: Resolver<ResolversTypes['SubnetPerformance'], ParentType, ContextType, RequireFields<QuerySubnet_PerformanceArgs, 'netuid'>>;
  subnet_performance_history?: Resolver<ResolversTypes['SubnetPerformanceHistory'], ParentType, ContextType, RequireFields<QuerySubnet_Performance_HistoryArgs, 'netuid'>>;
  subnet_profile?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, RequireFields<QuerySubnet_ProfileArgs, 'netuid'>>;
  subnet_prometheus?: Resolver<ResolversTypes['SubnetPrometheus'], ParentType, ContextType, RequireFields<QuerySubnet_PrometheusArgs, 'netuid'>>;
  subnet_recycled?: Resolver<Maybe<ResolversTypes['SubnetRecycled']>, ParentType, ContextType, RequireFields<QuerySubnet_RecycledArgs, 'netuid'>>;
  subnet_registrations?: Resolver<ResolversTypes['SubnetRegistrations'], ParentType, ContextType, RequireFields<QuerySubnet_RegistrationsArgs, 'netuid'>>;
  subnet_serving?: Resolver<ResolversTypes['SubnetServing'], ParentType, ContextType, RequireFields<QuerySubnet_ServingArgs, 'netuid'>>;
  subnet_stake_flow?: Resolver<ResolversTypes['SubnetStakeFlow'], ParentType, ContextType, RequireFields<QuerySubnet_Stake_FlowArgs, 'netuid'>>;
  subnet_stake_moves?: Resolver<ResolversTypes['SubnetStakeMoves'], ParentType, ContextType, RequireFields<QuerySubnet_Stake_MovesArgs, 'netuid'>>;
  subnet_stake_quote?: Resolver<ResolversTypes['SubnetStakeQuote'], ParentType, ContextType, RequireFields<QuerySubnet_Stake_QuoteArgs, 'amount' | 'netuid'>>;
  subnet_stake_transfers?: Resolver<ResolversTypes['SubnetStakeTransfers'], ParentType, ContextType, RequireFields<QuerySubnet_Stake_TransfersArgs, 'netuid'>>;
  subnet_trajectory?: Resolver<ResolversTypes['SubnetTrajectory'], ParentType, ContextType, RequireFields<QuerySubnet_TrajectoryArgs, 'netuid'>>;
  subnet_turnover?: Resolver<ResolversTypes['SubnetTurnover'], ParentType, ContextType, RequireFields<QuerySubnet_TurnoverArgs, 'netuid'>>;
  subnet_uptime?: Resolver<ResolversTypes['SubnetUptime'], ParentType, ContextType, RequireFields<QuerySubnet_UptimeArgs, 'netuid'>>;
  subnet_validators?: Resolver<ResolversTypes['SubnetValidatorList'], ParentType, ContextType, RequireFields<QuerySubnet_ValidatorsArgs, 'netuid'>>;
  subnet_volume?: Resolver<ResolversTypes['SubnetVolume'], ParentType, ContextType, RequireFields<QuerySubnet_VolumeArgs, 'netuid'>>;
  subnet_weight_setters?: Resolver<ResolversTypes['SubnetWeightSetters'], ParentType, ContextType, RequireFields<QuerySubnet_Weight_SettersArgs, 'netuid'>>;
  subnet_weights?: Resolver<ResolversTypes['SubnetWeights'], ParentType, ContextType, RequireFields<QuerySubnet_WeightsArgs, 'netuid'>>;
  subnet_yield?: Resolver<ResolversTypes['SubnetYield'], ParentType, ContextType, RequireFields<QuerySubnet_YieldArgs, 'netuid'>>;
  subnet_yield_history?: Resolver<ResolversTypes['SubnetYieldHistory'], ParentType, ContextType, RequireFields<QuerySubnet_Yield_HistoryArgs, 'netuid'>>;
  subnets?: Resolver<ResolversTypes['SubnetList'], ParentType, ContextType, Partial<QuerySubnetsArgs>>;
  sudo?: Resolver<ResolversTypes['ExtrinsicList'], ParentType, ContextType, Partial<QuerySudoArgs>>;
  sudo_key?: Resolver<Maybe<ResolversTypes['SudoKey']>, ParentType, ContextType>;
  surfaces?: Resolver<ResolversTypes['SurfaceList'], ParentType, ContextType, Partial<QuerySurfacesArgs>>;
  top_holders?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType, Partial<QueryTop_HoldersArgs>>;
  validator?: Resolver<Maybe<ResolversTypes['Validator']>, ParentType, ContextType, RequireFields<QueryValidatorArgs, 'hotkey'>>;
  validator_history?: Resolver<ResolversTypes['ValidatorHistory'], ParentType, ContextType, RequireFields<QueryValidator_HistoryArgs, 'hotkey'>>;
  validator_nominators?: Resolver<ResolversTypes['NominatorList'], ParentType, ContextType, RequireFields<QueryValidator_NominatorsArgs, 'hotkey'>>;
  validators?: Resolver<ResolversTypes['ValidatorList'], ParentType, ContextType, Partial<QueryValidatorsArgs>>;
}>;

export type RegistryLeaderboardsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RegistryLeaderboards'] = ResolversParentTypes['RegistryLeaderboards']> = ResolversObject<{
  board?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  boards?: Resolver<ResolversTypes['JSON'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ReviewAdapterCandidateListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ReviewAdapterCandidateList'] = ResolversParentTypes['ReviewAdapterCandidateList']> = ResolversObject<{
  candidates?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ReviewEnrichmentEvidenceListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ReviewEnrichmentEvidenceList'] = ResolversParentTypes['ReviewEnrichmentEvidenceList']> = ResolversObject<{
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  entries?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ReviewEnrichmentQueueListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ReviewEnrichmentQueueList'] = ResolversParentTypes['ReviewEnrichmentQueueList']> = ResolversObject<{
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  queue?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ReviewEnrichmentTargetListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ReviewEnrichmentTargetList'] = ResolversParentTypes['ReviewEnrichmentTargetList']> = ResolversObject<{
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  targets?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ReviewGapPriorityListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ReviewGapPriorityList'] = ResolversParentTypes['ReviewGapPriorityList']> = ResolversObject<{
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  priorities?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ReviewProfileCompletenessListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ReviewProfileCompletenessList'] = ResolversParentTypes['ReviewProfileCompletenessList']> = ResolversObject<{
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  profiles?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  summary?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type RootClaimEntryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RootClaimEntry'] = ResolversParentTypes['RootClaimEntry']> = ResolversObject<{
  claimable_rate?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  claimed?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  threshold?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type RootClaimHotkeyResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RootClaimHotkey'] = ResolversParentTypes['RootClaimHotkey']> = ResolversObject<{
  entries?: Resolver<Array<ResolversTypes['RootClaimEntry']>, ParentType, ContextType>;
  hotkey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type RootClaimTypeResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RootClaimType'] = ResolversParentTypes['RootClaimType']> = ResolversObject<{
  kind?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  subnets?: Resolver<Maybe<Array<ResolversTypes['Int']>>, ParentType, ContextType>;
}>;

export type RpcUsageResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RpcUsage'] = ResolversParentTypes['RpcUsage']> = ResolversObject<{
  bucket_granularity?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  buckets?: Resolver<Array<ResolversTypes['RpcUsageBucket']>, ParentType, ContextType>;
  endpoints?: Resolver<Array<ResolversTypes['RpcUsageEndpoint']>, ParentType, ContextType>;
  networks?: Resolver<Array<ResolversTypes['RpcUsageNetwork']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  summary?: Resolver<ResolversTypes['RpcUsageSummary'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type RpcUsageBucketResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RpcUsageBucket'] = ResolversParentTypes['RpcUsageBucket']> = ResolversObject<{
  avg_latency_ms?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  errors?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  requests?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ts?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type RpcUsageEndpointResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RpcUsageEndpoint'] = ResolversParentTypes['RpcUsageEndpoint']> = ResolversObject<{
  avg_latency_ms?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  endpoint_id?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  error_rate?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  ok_requests?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  provider?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  rank?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  requests?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type RpcUsageLatencyResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RpcUsageLatency'] = ResolversParentTypes['RpcUsageLatency']> = ResolversObject<{
  avg?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  p50?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  p95?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type RpcUsageNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RpcUsageNetwork'] = ResolversParentTypes['RpcUsageNetwork']> = ResolversObject<{
  error_rate?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  network?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  ok_requests?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  requests?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type RpcUsageSummaryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RpcUsageSummary'] = ResolversParentTypes['RpcUsageSummary']> = ResolversObject<{
  cache_hit_rate?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  cache_hits?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  error_rate?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  error_requests?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  failover_rate?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  failover_requests?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  latency_ms?: Resolver<ResolversTypes['RpcUsageLatency'], ParentType, ContextType>;
  ok_requests?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_requests?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type RuntimeTransitionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RuntimeTransition'] = ResolversParentTypes['RuntimeTransition']> = ResolversObject<{
  block_number?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  spec_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type RuntimeVersionHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RuntimeVersionHistory'] = ResolversParentTypes['RuntimeVersionHistory']> = ResolversObject<{
  coverage_from_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  coverage_from_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  current_spec_version?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  transition_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  transitions?: Resolver<Array<ResolversTypes['RuntimeTransition']>, ParentType, ContextType>;
}>;

export type ScoreDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ScoreDistribution'] = ResolversParentTypes['ScoreDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  mean?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  min?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  p10?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  p25?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  p50?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  p75?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  p90?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type SearchDocumentListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SearchDocumentList'] = ResolversParentTypes['SearchDocumentList']> = ResolversObject<{
  documents?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SourceSnapshotListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SourceSnapshotList'] = ResolversParentTypes['SourceSnapshotList']> = ResolversObject<{
  cursor?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  generated_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  order?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  returned?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sort?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sources?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  summary?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Subnet'] = ResolversParentTypes['Subnet']> = ResolversObject<{
  categories?: Resolver<Maybe<Array<ResolversTypes['String']>>, ParentType, ContextType>;
  coverage_level?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  curation_level?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  docs_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  economics?: Resolver<Maybe<ResolversTypes['SubnetEconomics']>, ParentType, ContextType>;
  endpoints?: Resolver<Array<ResolversTypes['Endpoint']>, ParentType, ContextType>;
  first_party?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  gap_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  health?: Resolver<Maybe<ResolversTypes['SubnetHealth']>, ParentType, ContextType>;
  integration_readiness?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  lifecycle?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  logo_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  official_surface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  probed_surface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  slug?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_type?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  surface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  surfaces?: Resolver<Array<ResolversTypes['Surface']>, ParentType, ContextType>;
  symbol?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  website_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetAxonRemovalsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetAxonRemovals'] = ResolversParentTypes['SubnetAxonRemovals']> = ResolversObject<{
  distinct_removers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  removals?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  removals_per_remover?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetBurnResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetBurn'] = ResolversParentTypes['SubnetBurn']> = ResolversObject<{
  burn_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  queried_at?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetConcentrationResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetConcentration'] = ResolversParentTypes['SubnetConcentration']> = ResolversObject<{
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  emission?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  entity_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  entity_emission?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  entity_stake?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stake?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  uids_per_entity?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_stake?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
}>;

export type SubnetConcentrationHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetConcentrationHistory'] = ResolversParentTypes['SubnetConcentrationHistory']> = ResolversObject<{
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  point_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  points?: Resolver<Array<ResolversTypes['SubnetConcentrationHistoryPoint']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetConcentrationHistoryPointResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetConcentrationHistoryPoint'] = ResolversParentTypes['SubnetConcentrationHistoryPoint']> = ResolversObject<{
  emission_gini?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  emission_nakamoto_coefficient?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  emission_top_10pct_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  snapshot_date?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  stake_gini?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  stake_nakamoto_coefficient?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  stake_top_10pct_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type SubnetConvictionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetConviction'] = ResolversParentTypes['SubnetConviction']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  king?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  leaderboard?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  maturity_rate?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  queried_at_block?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  unlock_rate?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type SubnetDeregistrationsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetDeregistrations'] = ResolversParentTypes['SubnetDeregistrations']> = ResolversObject<{
  deregistrations?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  deregistrations_per_hotkey?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  distinct_deregistered_hotkeys?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetEconomicsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetEconomics'] = ResolversParentTypes['SubnetEconomics']> = ResolversObject<{
  alpha_fdv_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_in_pool?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_market_cap_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_out_pool?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_price_change_1d?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_price_change_1h?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_price_change_1m?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_price_change_7d?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_price_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  emission_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  max_stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  max_uids?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  max_validators?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  miner_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  miner_readiness?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  open_slots?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  owner_coldkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  owner_hotkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  registration_allowed?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  registration_cost_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  slug?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_volume_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  tao_in_pool_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type SubnetEventSummaryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetEventSummary'] = ResolversParentTypes['SubnetEventSummary']> = ResolversObject<{
  categories?: Resolver<ResolversTypes['JSON'], ParentType, ContextType>;
  category_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  event_kinds?: Resolver<ResolversTypes['JSON'], ParentType, ContextType>;
  kind_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  recent_event_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  recent_events?: Resolver<ResolversTypes['JSON'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_events?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetEventsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetEvents'] = ResolversParentTypes['SubnetEvents']> = ResolversObject<{
  event_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  events?: Resolver<Array<ResolversTypes['AccountEvent']>, ParentType, ContextType>;
  limit?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  offset?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetHealthResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetHealth'] = ResolversParentTypes['SubnetHealth']> = ResolversObject<{
  avg_latency_ms?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  degraded_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  failed_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  last_checked?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_ok?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  latency_sample_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  ok_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  slug?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  surface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  unknown_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type SubnetHealthIncidentsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetHealthIncidents'] = ResolversParentTypes['SubnetHealthIncidents']> = ResolversObject<{
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  surfaces?: Resolver<ResolversTypes['JSON'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetHealthPercentilesResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetHealthPercentiles'] = ResolversParentTypes['SubnetHealthPercentiles']> = ResolversObject<{
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  surfaces?: Resolver<ResolversTypes['JSON'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetHealthTrendsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetHealthTrends'] = ResolversParentTypes['SubnetHealthTrends']> = ResolversObject<{
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  windows?: Resolver<ResolversTypes['JSON'], ParentType, ContextType>;
}>;

export type SubnetHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetHistory'] = ResolversParentTypes['SubnetHistory']> = ResolversObject<{
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  point_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  points?: Resolver<Array<ResolversTypes['SubnetHistoryPoint']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetHistoryPointResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetHistoryPoint'] = ResolversParentTypes['SubnetHistoryPoint']> = ResolversObject<{
  neuron_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  snapshot_date?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total_emission_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type SubnetHyperparametersResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetHyperparameters'] = ResolversParentTypes['SubnetHyperparameters']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  hyperparameters?: Resolver<Maybe<ResolversTypes['Hyperparameters']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetHyperparamsHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetHyperparamsHistory'] = ResolversParentTypes['SubnetHyperparamsHistory']> = ResolversObject<{
  entries?: Resolver<Array<ResolversTypes['HyperparamsHistoryEntry']>, ParentType, ContextType>;
  entry_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  limit?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  offset?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetIdentityHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetIdentityHistory'] = ResolversParentTypes['SubnetIdentityHistory']> = ResolversObject<{
  entries?: Resolver<Array<ResolversTypes['SubnetIdentityHistoryEntry']>, ParentType, ContextType>;
  entry_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  limit?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  offset?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetIdentityHistoryEntryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetIdentityHistoryEntry'] = ResolversParentTypes['SubnetIdentityHistoryEntry']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  discord?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  github_repo?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  identity_hash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  logo_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  symbol?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetIdleStakeResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetIdleStake'] = ResolversParentTypes['SubnetIdleStake']> = ResolversObject<{
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  idle_neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  idle_stake_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetLeaseResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetLease'] = ResolversParentTypes['SubnetLease']> = ResolversObject<{
  lease?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  leased?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  queried_at?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetLeaseHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetLeaseHistory'] = ResolversParentTypes['SubnetLeaseHistory']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  lease_events?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetList'] = ResolversParentTypes['SubnetList']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['Subnet']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetMoverResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetMover'] = ResolversParentTypes['SubnetMover']> = ResolversObject<{
  emission_delta_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  emission_end_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  emission_pct_change?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  emission_share_pct?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  emission_start_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  neurons_delta?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  neurons_end?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  neurons_start?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stake_delta_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  stake_end_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  stake_pct_change?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  stake_share_pct?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  stake_start_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  validators_delta?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators_end?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators_start?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetMoversResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetMovers'] = ResolversParentTypes['SubnetMovers']> = ResolversObject<{
  end_date?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  movers?: Resolver<Array<ResolversTypes['SubnetMover']>, ParentType, ContextType>;
  network?: Resolver<ResolversTypes['SubnetMoversNetwork'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sort?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  start_date?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetMoversNetworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetMoversNetwork'] = ResolversParentTypes['SubnetMoversNetwork']> = ResolversObject<{
  gainers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  losers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_emission_delta_tao?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_emission_end_tao?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_emission_start_tao?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_stake_delta_tao?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_stake_end_tao?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_stake_start_tao?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total_validators_delta?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_validators_end?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_validators_start?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  unchanged?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetOhlcResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetOhlc'] = ResolversParentTypes['SubnetOhlc']> = ResolversObject<{
  candles?: Resolver<Array<ResolversTypes['SubnetOhlcCandle']>, ParentType, ContextType>;
  interval?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  root_excluded?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetOhlcCandleResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetOhlcCandle'] = ResolversParentTypes['SubnetOhlcCandle']> = ResolversObject<{
  bucket_start?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  bucket_start_iso?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  close?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  event_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  high?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  low?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  open?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  volume_alpha?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  volume_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type SubnetOwnershipHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetOwnershipHistory'] = ResolversParentTypes['SubnetOwnershipHistory']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ownership_changes?: Resolver<Array<ResolversTypes['JSON']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetPerformanceResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetPerformance'] = ResolversParentTypes['SubnetPerformance']> = ResolversObject<{
  active_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  consensus?: Resolver<Maybe<ResolversTypes['ScoreDistribution']>, ParentType, ContextType>;
  dividends?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  incentive?: Resolver<Maybe<ResolversTypes['ConcentrationMetrics']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  trust?: Resolver<Maybe<ResolversTypes['ScoreDistribution']>, ParentType, ContextType>;
  validator_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validator_trust?: Resolver<Maybe<ResolversTypes['ScoreDistribution']>, ParentType, ContextType>;
}>;

export type SubnetPerformanceHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetPerformanceHistory'] = ResolversParentTypes['SubnetPerformanceHistory']> = ResolversObject<{
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  point_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  points?: Resolver<Array<ResolversTypes['SubnetPerformanceHistoryPoint']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetPerformanceHistoryPointResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetPerformanceHistoryPoint'] = ResolversParentTypes['SubnetPerformanceHistoryPoint']> = ResolversObject<{
  active_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  consensus_mean?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  consensus_median?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  dividends_gini?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  dividends_nakamoto_coefficient?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  dividends_top_10pct_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  incentive_gini?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  incentive_nakamoto_coefficient?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  incentive_top_10pct_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  snapshot_date?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  trust_mean?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  trust_median?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validator_trust_mean?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_trust_median?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type SubnetPrometheusResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetPrometheus'] = ResolversParentTypes['SubnetPrometheus']> = ResolversObject<{
  announcements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  announcements_per_exporter?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  distinct_exporters?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetRecycledResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetRecycled'] = ResolversParentTypes['SubnetRecycled']> = ResolversObject<{
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  queried_at?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  recycled_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetRegistrationsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetRegistrations'] = ResolversParentTypes['SubnetRegistrations']> = ResolversObject<{
  distinct_registrants?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  registrations?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  registrations_per_registrant?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetServingResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetServing'] = ResolversParentTypes['SubnetServing']> = ResolversObject<{
  announcements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  announcements_per_server?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  distinct_servers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetStakeFlowResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetStakeFlow'] = ResolversParentTypes['SubnetStakeFlow']> = ResolversObject<{
  net_flow_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stake_events?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total_staked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_unstaked_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  unstake_events?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetStakeMovesResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetStakeMoves'] = ResolversParentTypes['SubnetStakeMoves']> = ResolversObject<{
  distinct_movers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  movements?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  movements_per_mover?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetStakeQuoteResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetStakeQuote'] = ResolversParentTypes['SubnetStakeQuote']> = ResolversObject<{
  alpha_in_pool?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  amount?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  direction?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  effective_price_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  expected_out?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  expected_out_unit?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  is_root?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  price_impact_pct?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  spot_price_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  tao_in_pool_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type SubnetStakeTransfersResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetStakeTransfers'] = ResolversParentTypes['SubnetStakeTransfers']> = ResolversObject<{
  distinct_senders?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  transfers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  transfers_per_sender?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetTrajectoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetTrajectory'] = ResolversParentTypes['SubnetTrajectory']> = ResolversObject<{
  deltas?: Resolver<Array<ResolversTypes['SubnetTrajectoryDelta']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  point_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  points?: Resolver<Array<ResolversTypes['SubnetTrajectoryPoint']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetTrajectoryDeltaResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetTrajectoryDelta'] = ResolversParentTypes['SubnetTrajectoryDelta']> = ResolversObject<{
  alpha_in_pool?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_out_pool?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  completeness_score?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  endpoint_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  from_date?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  surface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  tao_in_pool_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  to_date?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  window?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type SubnetTrajectoryPointResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetTrajectoryPoint'] = ResolversParentTypes['SubnetTrajectoryPoint']> = ResolversObject<{
  alpha_in_pool?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_out_pool?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  alpha_price_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  completeness_score?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  date?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  emission_share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  endpoint_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  miner_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  subnet_volume_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  surface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  tao_in_pool_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type SubnetTurnoverResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetTurnover'] = ResolversParentTypes['SubnetTurnover']> = ResolversObject<{
  changes?: Resolver<Maybe<ResolversTypes['SubnetTurnoverChanges']>, ParentType, ContextType>;
  comparable?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  end_date?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  neuron_retention?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  neurons_end?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  neurons_start?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stability_score?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  start_date?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  uids_deregistered?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validator_retention?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validators_end?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators_entered?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators_exited?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators_start?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetTurnoverChangesResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetTurnoverChanges'] = ResolversParentTypes['SubnetTurnoverChanges']> = ResolversObject<{
  uid_reassignment_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  uid_reassignments?: Resolver<Array<ResolversTypes['TurnoverUidReassignment']>, ParentType, ContextType>;
  validators_entered?: Resolver<Array<ResolversTypes['TurnoverValidatorChange']>, ParentType, ContextType>;
  validators_entered_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators_exited?: Resolver<Array<ResolversTypes['TurnoverValidatorChange']>, ParentType, ContextType>;
  validators_exited_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetUptimeResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetUptime'] = ResolversParentTypes['SubnetUptime']> = ResolversObject<{
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  reliability?: Resolver<Maybe<ResolversTypes['UptimeReliability']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  surfaces?: Resolver<Array<ResolversTypes['UptimeSurface']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetValidatorListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetValidatorList'] = ResolversParentTypes['SubnetValidatorList']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validator_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators?: Resolver<Array<ResolversTypes['NeuronState']>, ParentType, ContextType>;
}>;

export type SubnetVolumeResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetVolume'] = ResolversParentTypes['SubnetVolume']> = ResolversObject<{
  buy_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  buy_volume_alpha?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  buy_volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  net_volume_alpha?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sell_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sell_volume_alpha?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  sell_volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  sentiment?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sentiment_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_volume_alpha?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  total_volume_tao?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  vol_mcap_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetWeightSetterResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetWeightSetter'] = ResolversParentTypes['SubnetWeightSetter']> = ResolversObject<{
  first_set_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  hotkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_set_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  share?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  weight_sets?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetWeightSettersResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetWeightSetters'] = ResolversParentTypes['SubnetWeightSetters']> = ResolversObject<{
  distinct_setters?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  setter_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  setters?: Resolver<Array<ResolversTypes['SubnetWeightSetter']>, ParentType, ContextType>;
  weight_sets?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetWeightsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetWeights'] = ResolversParentTypes['SubnetWeights']> = ResolversObject<{
  distinct_setters?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  observed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sets_per_setter?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  weight_sets?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetYieldResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetYield'] = ResolversParentTypes['SubnetYield']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  mean_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  median_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  miner_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  neurons?: Resolver<Array<ResolversTypes['SubnetYieldNeuron']>, ParentType, ContextType>;
  p25_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  p75_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  p90_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  subnet_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_emission_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetYieldHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetYieldHistory'] = ResolversParentTypes['SubnetYieldHistory']> = ResolversObject<{
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  point_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  points?: Resolver<Array<ResolversTypes['SubnetYieldHistoryPoint']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SubnetYieldHistoryPointResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetYieldHistoryPoint'] = ResolversParentTypes['SubnetYieldHistoryPoint']> = ResolversObject<{
  mean_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  median_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  neuron_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  p25_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  p75_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  p90_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  snapshot_date?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  subnet_yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  validator_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  yield_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubnetYieldNeuronResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SubnetYieldNeuron'] = ResolversParentTypes['SubnetYieldNeuron']> = ResolversObject<{
  emission_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  hotkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  role?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  yield?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type SubscriptionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Subscription'] = ResolversParentTypes['Subscription']> = ResolversObject<{
  chainEvents?: SubscriptionResolver<ResolversTypes['ChainEvent'], "chainEvents", ParentType, ContextType, Partial<SubscriptionChainEventsArgs>>;
}>;

export type SudoKeyResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SudoKey'] = ResolversParentTypes['SudoKey']> = ResolversObject<{
  hotkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  queried_at?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SurfaceResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Surface'] = ResolversParentTypes['Surface']> = ResolversObject<{
  auth_required?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  authority?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  classification?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  key?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  kind?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  last_verified_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  notes?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  provider?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  public_safe?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  schema_status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  schema_url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  source_urls?: Resolver<Maybe<Array<ResolversTypes['String']>>, ParentType, ContextType>;
  stale?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subnet_slug?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SurfaceListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SurfaceList'] = ResolversParentTypes['SurfaceList']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['Surface']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type TurnoverUidReassignmentResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['TurnoverUidReassignment'] = ResolversParentTypes['TurnoverUidReassignment']> = ResolversObject<{
  from_hotkey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  to_hotkey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  uid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type TurnoverValidatorChangeResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['TurnoverValidatorChange'] = ResolversParentTypes['TurnoverValidatorChange']> = ResolversObject<{
  hotkey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  uid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type UptimeDayResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['UptimeDay'] = ResolversParentTypes['UptimeDay']> = ResolversObject<{
  avg_latency_ms?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  day?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  latency_ms?: Resolver<Maybe<ResolversTypes['UptimeLatency']>, ParentType, ContextType>;
  latency_sample_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  samples?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  uptime_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type UptimeLatencyResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['UptimeLatency'] = ResolversParentTypes['UptimeLatency']> = ResolversObject<{
  p50?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  p95?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  p99?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type UptimeReliabilityResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['UptimeReliability'] = ResolversParentTypes['UptimeReliability']> = ResolversObject<{
  avg_latency_ms?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  computed_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  day_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  grade?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  latency_sample_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  sample_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  score?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  surface_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  uptime_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type UptimeSurfaceResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['UptimeSurface'] = ResolversParentTypes['UptimeSurface']> = ResolversObject<{
  day_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  days?: Resolver<Array<ResolversTypes['UptimeDay']>, ParentType, ContextType>;
  reliability?: Resolver<Maybe<ResolversTypes['UptimeReliability']>, ParentType, ContextType>;
  samples?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  surface_id?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  uptime_ratio?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ValidatorResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Validator'] = ResolversParentTypes['Validator']> = ResolversObject<{
  alpha_stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  apy_estimate?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  apy_estimate_eligible_subnet_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  avg_validator_trust?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  coldkey?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  coldkey_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  coldkey_identity?: Resolver<Maybe<ResolversTypes['Identity']>, ParentType, ContextType>;
  featured?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  hotkey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  max_validator_trust?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  nominator_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  realized_return_1d?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  realized_return_1m?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  realized_return_1w?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  root_stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  subnet_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  subnets?: Resolver<Array<ResolversTypes['ValidatorSubnet']>, ParentType, ContextType>;
  take?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_emission_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uid_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type ValidatorComparisonResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ValidatorComparison'] = ResolversParentTypes['ValidatorComparison']> = ResolversObject<{
  netuid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validator_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  validators?: Resolver<Array<ResolversTypes['ComparedValidator']>, ParentType, ContextType>;
}>;

export type ValidatorHistoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ValidatorHistory'] = ResolversParentTypes['ValidatorHistory']> = ResolversObject<{
  hotkey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  point_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  points?: Resolver<Array<ResolversTypes['ValidatorHistoryPoint']>, ParentType, ContextType>;
  schema_version?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  window?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ValidatorHistoryPointResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ValidatorHistoryPoint'] = ResolversParentTypes['ValidatorHistoryPoint']> = ResolversObject<{
  rewards_per_1000_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  snapshot_date?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  subnet_count?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  total_emission_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  total_stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type ValidatorListResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ValidatorList'] = ResolversParentTypes['ValidatorList']> = ResolversObject<{
  block_number?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  captured_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  items?: Resolver<Array<ResolversTypes['Validator']>, ParentType, ContextType>;
  next_cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sort?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ValidatorSubnetResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ValidatorSubnet'] = ResolversParentTypes['ValidatorSubnet']> = ResolversObject<{
  emission_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  netuid?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stake_tao?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  validator_trust?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
}>;

export type YieldDistributionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['YieldDistribution'] = ResolversParentTypes['YieldDistribution']> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  max?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  mean?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  median?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  min?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p10?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p25?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p75?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  p90?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type Resolvers<ContextType = GqlContext> = ResolversObject<{
  AccountActivity?: AccountActivityResolvers<ContextType>;
  AccountAxonRemovalSubnet?: AccountAxonRemovalSubnetResolvers<ContextType>;
  AccountAxonRemovals?: AccountAxonRemovalsResolvers<ContextType>;
  AccountBalance?: AccountBalanceResolvers<ContextType>;
  AccountChildEntry?: AccountChildEntryResolvers<ContextType>;
  AccountChildSubnet?: AccountChildSubnetResolvers<ContextType>;
  AccountChildren?: AccountChildrenResolvers<ContextType>;
  AccountCounterparties?: AccountCounterpartiesResolvers<ContextType>;
  AccountCounterparty?: AccountCounterpartyResolvers<ContextType>;
  AccountCounterpartyRelationship?: AccountCounterpartyRelationshipResolvers<ContextType>;
  AccountCounterpartyTransfer?: AccountCounterpartyTransferResolvers<ContextType>;
  AccountDay?: AccountDayResolvers<ContextType>;
  AccountDeregistrationSubnet?: AccountDeregistrationSubnetResolvers<ContextType>;
  AccountDeregistrations?: AccountDeregistrationsResolvers<ContextType>;
  AccountEntities?: AccountEntitiesResolvers<ContextType>;
  AccountEntityLabel?: AccountEntityLabelResolvers<ContextType>;
  AccountEntry?: AccountEntryResolvers<ContextType>;
  AccountEvent?: AccountEventResolvers<ContextType>;
  AccountEventKind?: AccountEventKindResolvers<ContextType>;
  AccountEvents?: AccountEventsResolvers<ContextType>;
  AccountExtrinsics?: AccountExtrinsicsResolvers<ContextType>;
  AccountHistory?: AccountHistoryResolvers<ContextType>;
  AccountIdentity?: AccountIdentityResolvers<ContextType>;
  AccountIdentityHistory?: AccountIdentityHistoryResolvers<ContextType>;
  AccountIdentityHistoryEntry?: AccountIdentityHistoryEntryResolvers<ContextType>;
  AccountList?: AccountListResolvers<ContextType>;
  AccountModuleCall?: AccountModuleCallResolvers<ContextType>;
  AccountOwnershipTie?: AccountOwnershipTieResolvers<ContextType>;
  AccountParentEntry?: AccountParentEntryResolvers<ContextType>;
  AccountParentSubnet?: AccountParentSubnetResolvers<ContextType>;
  AccountParents?: AccountParentsResolvers<ContextType>;
  AccountPortfolio?: AccountPortfolioResolvers<ContextType>;
  AccountPortfolioPosition?: AccountPortfolioPositionResolvers<ContextType>;
  AccountPositionHistory?: AccountPositionHistoryResolvers<ContextType>;
  AccountPositionHistoryPoint?: AccountPositionHistoryPointResolvers<ContextType>;
  AccountPositions?: AccountPositionsResolvers<ContextType>;
  AccountPrometheus?: AccountPrometheusResolvers<ContextType>;
  AccountPrometheusSubnet?: AccountPrometheusSubnetResolvers<ContextType>;
  AccountRegistration?: AccountRegistrationResolvers<ContextType>;
  AccountRegistrationSubnet?: AccountRegistrationSubnetResolvers<ContextType>;
  AccountRegistrations?: AccountRegistrationsResolvers<ContextType>;
  AccountRootClaim?: AccountRootClaimResolvers<ContextType>;
  AccountServing?: AccountServingResolvers<ContextType>;
  AccountServingSubnet?: AccountServingSubnetResolvers<ContextType>;
  AccountStakeFlow?: AccountStakeFlowResolvers<ContextType>;
  AccountStakeFlowSubnet?: AccountStakeFlowSubnetResolvers<ContextType>;
  AccountStakeMoveSubnet?: AccountStakeMoveSubnetResolvers<ContextType>;
  AccountStakeMoves?: AccountStakeMovesResolvers<ContextType>;
  AccountSubnet?: AccountSubnetResolvers<ContextType>;
  AccountSubnets?: AccountSubnetsResolvers<ContextType>;
  AccountSummary?: AccountSummaryResolvers<ContextType>;
  AccountTransfer?: AccountTransferResolvers<ContextType>;
  AccountTransfers?: AccountTransfersResolvers<ContextType>;
  AccountWeightSetters?: AccountWeightSettersResolvers<ContextType>;
  AccountWeightSettersSubnet?: AccountWeightSettersSubnetResolvers<ContextType>;
  Adapter?: AdapterResolvers<ContextType>;
  Block?: BlockResolvers<ContextType>;
  BlockChainEvents?: BlockChainEventsResolvers<ContextType>;
  BlockDetail?: BlockDetailResolvers<ContextType>;
  BlockEvents?: BlockEventsResolvers<ContextType>;
  BlockExtrinsics?: BlockExtrinsicsResolvers<ContextType>;
  BlockList?: BlockListResolvers<ContextType>;
  BlockTimeDistribution?: BlockTimeDistributionResolvers<ContextType>;
  BlocksSummary?: BlocksSummaryResolvers<ContextType>;
  BlocksThroughput?: BlocksThroughputResolvers<ContextType>;
  BuildSummary?: BuildSummaryResolvers<ContextType>;
  ChainActivity?: ChainActivityResolvers<ContextType>;
  ChainActivityDay?: ChainActivityDayResolvers<ContextType>;
  ChainAlphaVolume?: ChainAlphaVolumeResolvers<ContextType>;
  ChainAlphaVolumeDistribution?: ChainAlphaVolumeDistributionResolvers<ContextType>;
  ChainAlphaVolumeNetwork?: ChainAlphaVolumeNetworkResolvers<ContextType>;
  ChainAlphaVolumeSubnet?: ChainAlphaVolumeSubnetResolvers<ContextType>;
  ChainAxonRemovals?: ChainAxonRemovalsResolvers<ContextType>;
  ChainAxonRemovalsIntensityDistribution?: ChainAxonRemovalsIntensityDistributionResolvers<ContextType>;
  ChainAxonRemovalsNetwork?: ChainAxonRemovalsNetworkResolvers<ContextType>;
  ChainAxonRemovalsSubnet?: ChainAxonRemovalsSubnetResolvers<ContextType>;
  ChainCall?: ChainCallResolvers<ContextType>;
  ChainCalls?: ChainCallsResolvers<ContextType>;
  ChainConcentration?: ChainConcentrationResolvers<ContextType>;
  ChainDeregistrations?: ChainDeregistrationsResolvers<ContextType>;
  ChainDeregistrationsIntensityDistribution?: ChainDeregistrationsIntensityDistributionResolvers<ContextType>;
  ChainDeregistrationsNetwork?: ChainDeregistrationsNetworkResolvers<ContextType>;
  ChainDeregistrationsSubnet?: ChainDeregistrationsSubnetResolvers<ContextType>;
  ChainEvent?: ChainEventResolvers<ContextType>;
  ChainEventRow?: ChainEventRowResolvers<ContextType>;
  ChainEventsFeed?: ChainEventsFeedResolvers<ContextType>;
  ChainEventsStats?: ChainEventsStatsResolvers<ContextType>;
  ChainEventsStatsRow?: ChainEventsStatsRowResolvers<ContextType>;
  ChainFeePayer?: ChainFeePayerResolvers<ContextType>;
  ChainFees?: ChainFeesResolvers<ContextType>;
  ChainFeesDay?: ChainFeesDayResolvers<ContextType>;
  ChainIdentityHistory?: ChainIdentityHistoryResolvers<ContextType>;
  ChainIdentityHistoryEntry?: ChainIdentityHistoryEntryResolvers<ContextType>;
  ChainIdleStake?: ChainIdleStakeResolvers<ContextType>;
  ChainIdleStakeSubnet?: ChainIdleStakeSubnetResolvers<ContextType>;
  ChainPerformance?: ChainPerformanceResolvers<ContextType>;
  ChainPrometheus?: ChainPrometheusResolvers<ContextType>;
  ChainPrometheusIntensityDistribution?: ChainPrometheusIntensityDistributionResolvers<ContextType>;
  ChainPrometheusNetwork?: ChainPrometheusNetworkResolvers<ContextType>;
  ChainPrometheusSubnet?: ChainPrometheusSubnetResolvers<ContextType>;
  ChainRegistrations?: ChainRegistrationsResolvers<ContextType>;
  ChainRegistrationsIntensityDistribution?: ChainRegistrationsIntensityDistributionResolvers<ContextType>;
  ChainRegistrationsNetwork?: ChainRegistrationsNetworkResolvers<ContextType>;
  ChainRegistrationsSubnet?: ChainRegistrationsSubnetResolvers<ContextType>;
  ChainServing?: ChainServingResolvers<ContextType>;
  ChainServingIntensityDistribution?: ChainServingIntensityDistributionResolvers<ContextType>;
  ChainServingNetwork?: ChainServingNetworkResolvers<ContextType>;
  ChainServingSubnet?: ChainServingSubnetResolvers<ContextType>;
  ChainSigner?: ChainSignerResolvers<ContextType>;
  ChainSigners?: ChainSignersResolvers<ContextType>;
  ChainStakeFlow?: ChainStakeFlowResolvers<ContextType>;
  ChainStakeFlowDistribution?: ChainStakeFlowDistributionResolvers<ContextType>;
  ChainStakeFlowNetwork?: ChainStakeFlowNetworkResolvers<ContextType>;
  ChainStakeFlowSubnet?: ChainStakeFlowSubnetResolvers<ContextType>;
  ChainStakeMoves?: ChainStakeMovesResolvers<ContextType>;
  ChainStakeMovesIntensityDistribution?: ChainStakeMovesIntensityDistributionResolvers<ContextType>;
  ChainStakeMovesNetwork?: ChainStakeMovesNetworkResolvers<ContextType>;
  ChainStakeMovesSubnet?: ChainStakeMovesSubnetResolvers<ContextType>;
  ChainStakeTransfers?: ChainStakeTransfersResolvers<ContextType>;
  ChainStakeTransfersIntensityDistribution?: ChainStakeTransfersIntensityDistributionResolvers<ContextType>;
  ChainStakeTransfersNetwork?: ChainStakeTransfersNetworkResolvers<ContextType>;
  ChainStakeTransfersSubnet?: ChainStakeTransfersSubnetResolvers<ContextType>;
  ChainTransferPair?: ChainTransferPairResolvers<ContextType>;
  ChainTransferPairs?: ChainTransferPairsResolvers<ContextType>;
  ChainTransferParty?: ChainTransferPartyResolvers<ContextType>;
  ChainTransfers?: ChainTransfersResolvers<ContextType>;
  ChainTurnover?: ChainTurnoverResolvers<ContextType>;
  ChainTurnoverNetwork?: ChainTurnoverNetworkResolvers<ContextType>;
  ChainTurnoverStabilityDistribution?: ChainTurnoverStabilityDistributionResolvers<ContextType>;
  ChainTurnoverSubnet?: ChainTurnoverSubnetResolvers<ContextType>;
  ChainWeightSetter?: ChainWeightSetterResolvers<ContextType>;
  ChainWeightSetters?: ChainWeightSettersResolvers<ContextType>;
  ChainWeights?: ChainWeightsResolvers<ContextType>;
  ChainWeightsIntensityDistribution?: ChainWeightsIntensityDistributionResolvers<ContextType>;
  ChainWeightsNetwork?: ChainWeightsNetworkResolvers<ContextType>;
  ChainWeightsSubnet?: ChainWeightsSubnetResolvers<ContextType>;
  ChainYield?: ChainYieldResolvers<ContextType>;
  Changelog?: ChangelogResolvers<ContextType>;
  Compare?: CompareResolvers<ContextType>;
  CompareEconomics?: CompareEconomicsResolvers<ContextType>;
  CompareHealth?: CompareHealthResolvers<ContextType>;
  CompareStructure?: CompareStructureResolvers<ContextType>;
  CompareSubnet?: CompareSubnetResolvers<ContextType>;
  ComparedValidator?: ComparedValidatorResolvers<ContextType>;
  ConcentrationMetrics?: ConcentrationMetricsResolvers<ContextType>;
  Contracts?: ContractsResolvers<ContextType>;
  DomainOverview?: DomainOverviewResolvers<ContextType>;
  DomainSummary?: DomainSummaryResolvers<ContextType>;
  EconomicsList?: EconomicsListResolvers<ContextType>;
  EconomicsSummary?: EconomicsSummaryResolvers<ContextType>;
  EconomicsTrends?: EconomicsTrendsResolvers<ContextType>;
  EconomicsTrendsDay?: EconomicsTrendsDayResolvers<ContextType>;
  Endpoint?: EndpointResolvers<ContextType>;
  EndpointIncident?: EndpointIncidentResolvers<ContextType>;
  EndpointList?: EndpointListResolvers<ContextType>;
  EvidenceList?: EvidenceListResolvers<ContextType>;
  EvmAddressMapping?: EvmAddressMappingResolvers<ContextType>;
  Extrinsic?: ExtrinsicResolvers<ContextType>;
  ExtrinsicDetail?: ExtrinsicDetailResolvers<ContextType>;
  ExtrinsicList?: ExtrinsicListResolvers<ContextType>;
  GapsList?: GapsListResolvers<ContextType>;
  GlobalHealth?: GlobalHealthResolvers<ContextType>;
  GlobalIncidents?: GlobalIncidentsResolvers<ContextType>;
  HealthHistory?: HealthHistoryResolvers<ContextType>;
  HealthTrends?: HealthTrendsResolvers<ContextType>;
  Hyperparameters?: HyperparametersResolvers<ContextType>;
  HyperparamsHistoryEntry?: HyperparamsHistoryEntryResolvers<ContextType>;
  Identity?: IdentityResolvers<ContextType>;
  IncidentList?: IncidentListResolvers<ContextType>;
  JSON?: GraphQLScalarType;
  NetworkParameters?: NetworkParametersResolvers<ContextType>;
  NetworkRandomness?: NetworkRandomnessResolvers<ContextType>;
  Neuron?: NeuronResolvers<ContextType>;
  NeuronHistory?: NeuronHistoryResolvers<ContextType>;
  NeuronHistoryPoint?: NeuronHistoryPointResolvers<ContextType>;
  NeuronState?: NeuronStateResolvers<ContextType>;
  Nominator?: NominatorResolvers<ContextType>;
  NominatorList?: NominatorListResolvers<ContextType>;
  NominatorPosition?: NominatorPositionResolvers<ContextType>;
  OpportunityBoards?: OpportunityBoardsResolvers<ContextType>;
  OpportunityEntry?: OpportunityEntryResolvers<ContextType>;
  PoolList?: PoolListResolvers<ContextType>;
  ProfileList?: ProfileListResolvers<ContextType>;
  Provider?: ProviderResolvers<ContextType>;
  ProviderList?: ProviderListResolvers<ContextType>;
  Query?: QueryResolvers<ContextType>;
  RegistryLeaderboards?: RegistryLeaderboardsResolvers<ContextType>;
  ReviewAdapterCandidateList?: ReviewAdapterCandidateListResolvers<ContextType>;
  ReviewEnrichmentEvidenceList?: ReviewEnrichmentEvidenceListResolvers<ContextType>;
  ReviewEnrichmentQueueList?: ReviewEnrichmentQueueListResolvers<ContextType>;
  ReviewEnrichmentTargetList?: ReviewEnrichmentTargetListResolvers<ContextType>;
  ReviewGapPriorityList?: ReviewGapPriorityListResolvers<ContextType>;
  ReviewProfileCompletenessList?: ReviewProfileCompletenessListResolvers<ContextType>;
  RootClaimEntry?: RootClaimEntryResolvers<ContextType>;
  RootClaimHotkey?: RootClaimHotkeyResolvers<ContextType>;
  RootClaimType?: RootClaimTypeResolvers<ContextType>;
  RpcUsage?: RpcUsageResolvers<ContextType>;
  RpcUsageBucket?: RpcUsageBucketResolvers<ContextType>;
  RpcUsageEndpoint?: RpcUsageEndpointResolvers<ContextType>;
  RpcUsageLatency?: RpcUsageLatencyResolvers<ContextType>;
  RpcUsageNetwork?: RpcUsageNetworkResolvers<ContextType>;
  RpcUsageSummary?: RpcUsageSummaryResolvers<ContextType>;
  RuntimeTransition?: RuntimeTransitionResolvers<ContextType>;
  RuntimeVersionHistory?: RuntimeVersionHistoryResolvers<ContextType>;
  ScoreDistribution?: ScoreDistributionResolvers<ContextType>;
  SearchDocumentList?: SearchDocumentListResolvers<ContextType>;
  SourceSnapshotList?: SourceSnapshotListResolvers<ContextType>;
  Subnet?: SubnetResolvers<ContextType>;
  SubnetAxonRemovals?: SubnetAxonRemovalsResolvers<ContextType>;
  SubnetBurn?: SubnetBurnResolvers<ContextType>;
  SubnetConcentration?: SubnetConcentrationResolvers<ContextType>;
  SubnetConcentrationHistory?: SubnetConcentrationHistoryResolvers<ContextType>;
  SubnetConcentrationHistoryPoint?: SubnetConcentrationHistoryPointResolvers<ContextType>;
  SubnetConviction?: SubnetConvictionResolvers<ContextType>;
  SubnetDeregistrations?: SubnetDeregistrationsResolvers<ContextType>;
  SubnetEconomics?: SubnetEconomicsResolvers<ContextType>;
  SubnetEventSummary?: SubnetEventSummaryResolvers<ContextType>;
  SubnetEvents?: SubnetEventsResolvers<ContextType>;
  SubnetHealth?: SubnetHealthResolvers<ContextType>;
  SubnetHealthIncidents?: SubnetHealthIncidentsResolvers<ContextType>;
  SubnetHealthPercentiles?: SubnetHealthPercentilesResolvers<ContextType>;
  SubnetHealthTrends?: SubnetHealthTrendsResolvers<ContextType>;
  SubnetHistory?: SubnetHistoryResolvers<ContextType>;
  SubnetHistoryPoint?: SubnetHistoryPointResolvers<ContextType>;
  SubnetHyperparameters?: SubnetHyperparametersResolvers<ContextType>;
  SubnetHyperparamsHistory?: SubnetHyperparamsHistoryResolvers<ContextType>;
  SubnetIdentityHistory?: SubnetIdentityHistoryResolvers<ContextType>;
  SubnetIdentityHistoryEntry?: SubnetIdentityHistoryEntryResolvers<ContextType>;
  SubnetIdleStake?: SubnetIdleStakeResolvers<ContextType>;
  SubnetLease?: SubnetLeaseResolvers<ContextType>;
  SubnetLeaseHistory?: SubnetLeaseHistoryResolvers<ContextType>;
  SubnetList?: SubnetListResolvers<ContextType>;
  SubnetMover?: SubnetMoverResolvers<ContextType>;
  SubnetMovers?: SubnetMoversResolvers<ContextType>;
  SubnetMoversNetwork?: SubnetMoversNetworkResolvers<ContextType>;
  SubnetOhlc?: SubnetOhlcResolvers<ContextType>;
  SubnetOhlcCandle?: SubnetOhlcCandleResolvers<ContextType>;
  SubnetOwnershipHistory?: SubnetOwnershipHistoryResolvers<ContextType>;
  SubnetPerformance?: SubnetPerformanceResolvers<ContextType>;
  SubnetPerformanceHistory?: SubnetPerformanceHistoryResolvers<ContextType>;
  SubnetPerformanceHistoryPoint?: SubnetPerformanceHistoryPointResolvers<ContextType>;
  SubnetPrometheus?: SubnetPrometheusResolvers<ContextType>;
  SubnetRecycled?: SubnetRecycledResolvers<ContextType>;
  SubnetRegistrations?: SubnetRegistrationsResolvers<ContextType>;
  SubnetServing?: SubnetServingResolvers<ContextType>;
  SubnetStakeFlow?: SubnetStakeFlowResolvers<ContextType>;
  SubnetStakeMoves?: SubnetStakeMovesResolvers<ContextType>;
  SubnetStakeQuote?: SubnetStakeQuoteResolvers<ContextType>;
  SubnetStakeTransfers?: SubnetStakeTransfersResolvers<ContextType>;
  SubnetTrajectory?: SubnetTrajectoryResolvers<ContextType>;
  SubnetTrajectoryDelta?: SubnetTrajectoryDeltaResolvers<ContextType>;
  SubnetTrajectoryPoint?: SubnetTrajectoryPointResolvers<ContextType>;
  SubnetTurnover?: SubnetTurnoverResolvers<ContextType>;
  SubnetTurnoverChanges?: SubnetTurnoverChangesResolvers<ContextType>;
  SubnetUptime?: SubnetUptimeResolvers<ContextType>;
  SubnetValidatorList?: SubnetValidatorListResolvers<ContextType>;
  SubnetVolume?: SubnetVolumeResolvers<ContextType>;
  SubnetWeightSetter?: SubnetWeightSetterResolvers<ContextType>;
  SubnetWeightSetters?: SubnetWeightSettersResolvers<ContextType>;
  SubnetWeights?: SubnetWeightsResolvers<ContextType>;
  SubnetYield?: SubnetYieldResolvers<ContextType>;
  SubnetYieldHistory?: SubnetYieldHistoryResolvers<ContextType>;
  SubnetYieldHistoryPoint?: SubnetYieldHistoryPointResolvers<ContextType>;
  SubnetYieldNeuron?: SubnetYieldNeuronResolvers<ContextType>;
  Subscription?: SubscriptionResolvers<ContextType>;
  SudoKey?: SudoKeyResolvers<ContextType>;
  Surface?: SurfaceResolvers<ContextType>;
  SurfaceList?: SurfaceListResolvers<ContextType>;
  TurnoverUidReassignment?: TurnoverUidReassignmentResolvers<ContextType>;
  TurnoverValidatorChange?: TurnoverValidatorChangeResolvers<ContextType>;
  UptimeDay?: UptimeDayResolvers<ContextType>;
  UptimeLatency?: UptimeLatencyResolvers<ContextType>;
  UptimeReliability?: UptimeReliabilityResolvers<ContextType>;
  UptimeSurface?: UptimeSurfaceResolvers<ContextType>;
  Validator?: ValidatorResolvers<ContextType>;
  ValidatorComparison?: ValidatorComparisonResolvers<ContextType>;
  ValidatorHistory?: ValidatorHistoryResolvers<ContextType>;
  ValidatorHistoryPoint?: ValidatorHistoryPointResolvers<ContextType>;
  ValidatorList?: ValidatorListResolvers<ContextType>;
  ValidatorSubnet?: ValidatorSubnetResolvers<ContextType>;
  YieldDistribution?: YieldDistributionResolvers<ContextType>;
}>;

