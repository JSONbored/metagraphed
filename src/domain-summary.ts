// Per-domain rollup aggregation (#6749): a DefiLlama-style category summary layer
// on top of the existing 14-tag domain/capability taxonomy (src/domain-tags.mjs),
// already exposed read-only via ?domain= on /api/v1/subnets. That taxonomy is NOT
// rebuilt here -- this module only joins it against current subnet economics to
// answer "how much of the network's stake/emission sits in each domain, and how
// concentrated is that emission across the domain's subnets."
//
// Pure shaping over two already-served projections, no new capture: the subnets
// index (netuid -> categories/derived_categories, /metagraph/subnets.json) and the
// economics tier (netuid -> total_stake_tao/emission_share, /metagraph/economics.json
// or its live KV mirror). Null-safe by design, matching this codebase's other live
// tiers: a subnet missing from either input just contributes nothing extra, never
// throws.

import { DOMAIN_TAGS } from "./domain-tags.mjs";
import {
  computeConcentration,
  type ConcentrationScorecard,
} from "./concentration.ts";

// 1 TAO = 1e9 rao. Sum in rao-integer BigInt space, not float space -- summing a
// domain's worth of subnets' total_stake_tao with plain `+=` compounds rounding
// error across the accumulation even when each individual value is itself exact
// (mirrors src/concentration.ts's own toRaoBig/raoBigToTao, a deliberate
// byte-for-byte copy per this codebase's per-module rounding-helper convention --
// see src/subnet-ohlc.mjs's header comment for why these aren't shared imports).
function toRaoBig(taoValue: unknown): bigint {
  /* v8 ignore next -- defensive: the only call site already passes a number. */
  const n = typeof taoValue === "number" ? taoValue : Number(taoValue);
  /* v8 ignore next -- defensive: the only call site already Number.isFinite-checked it. */
  return Number.isFinite(n) ? BigInt(Math.round(n * 1e9)) : 0n;
}
function raoBigToTao(rao: bigint): number {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

function round(value: number | null | undefined, dp = 4): number | null {
  /* v8 ignore next -- defensive: both call sites below always pass a finite
     number (raoBigToTao's output, or a reduce-sum over already
     Number.isFinite-filtered emissionShares); copied verbatim from
     concentration.ts's own round, whose other callers do need this guard. */
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// A subnet's domain membership is the UNION of curated `categories` and derived
// `derived_categories` -- the exact same resolution ?domain= already uses on
// /api/v1/subnets (src/contracts.mjs's `arrayFilters: { domain: ["categories",
// "derived_categories"] }`), so a subnet's domain-summary membership always
// matches which subnets that existing filter would return for the same tag.
function subnetDomainTags(subnet: Record<string, unknown>): Set<unknown> {
  const tags = new Set<unknown>();
  for (const tag of (subnet?.categories as unknown[]) || []) tags.add(tag);
  for (const tag of (subnet?.derived_categories as unknown[]) || [])
    tags.add(tag);
  return tags;
}

export interface DomainSummaryResult {
  schema_version: 1;
  domain: string;
  subnet_count: number;
  netuids: number[];
  total_stake_tao: number | null;
  total_emission_share: number | null;
  emission_concentration: ConcentrationScorecard | null;
}

// One domain tag's rollup: how many subnets carry it, how much of the network's
// stake/emission they collectively hold, and how concentrated that emission is
// across just this domain's own subnets (not the whole network). `economicsRows`
// entries missing a numeric total_stake_tao/emission_share simply don't
// contribute to that specific total -- a partial economics miss never drops the
// whole subnet from `subnet_count`/`netuids`.
export function buildDomainSummary(
  tag: string,
  subnetRows: Array<Record<string, unknown>> | null | undefined,
  economicsRows: Array<Record<string, unknown>> | null | undefined,
): DomainSummaryResult {
  const economicsByNetuid = new Map<number, Record<string, unknown>>();
  for (const row of economicsRows || []) {
    if (Number.isInteger(row?.netuid))
      economicsByNetuid.set(row.netuid as number, row);
  }

  const netuids: number[] = [];
  let stakeRao = 0n;
  const emissionShares: number[] = [];
  for (const subnet of subnetRows || []) {
    if (!Number.isInteger(subnet?.netuid)) continue;
    if (!subnetDomainTags(subnet).has(tag)) continue;
    const netuid = subnet.netuid as number;
    netuids.push(netuid);
    const econ = economicsByNetuid.get(netuid);
    const stake = Number(econ?.total_stake_tao);
    if (Number.isFinite(stake)) stakeRao += toRaoBig(stake);
    const emissionShare = Number(econ?.emission_share);
    if (Number.isFinite(emissionShare) && emissionShare > 0) {
      emissionShares.push(emissionShare);
    }
  }
  netuids.sort((a, b) => a - b);

  return {
    schema_version: 1,
    domain: tag,
    subnet_count: netuids.length,
    netuids,
    total_stake_tao: round(raoBigToTao(stakeRao)),
    // Sum of this domain's subnets' emission_share -- each subnet's share of
    // NETWORK-WIDE emission (dTAO emission is price-weighted: a subnet's share
    // of network TAO emission tracks its alpha price, scripts/fetch-native-
    // subnets.py:76-79), so this reads as "what fraction of all network
    // emission currently flows to this domain."
    total_emission_share: round(
      emissionShares.reduce((sum, v) => sum + v, 0),
      6,
    ),
    // How concentrated emission is WITHIN this domain, across just its own
    // member subnets (computeConcentration is scale-invariant -- it normalizes
    // by the input's own total, so emission_share values already produce the
    // correct within-domain gini/hhi without needing a raw emission_tao figure
    // that doesn't exist as a captured field). `null` when the domain has no
    // subnet with a positive emission share (matches computeConcentration's
    // own empty-distribution contract).
    emission_concentration: computeConcentration(emissionShares),
  };
}

export interface DomainOverviewResult {
  schema_version: 1;
  domain_count: number;
  domains: DomainSummaryResult[];
}

// Every domain tag's rollup in one call -- the overview a caller browses before
// drilling into a single tag's own summary. One netuid pass per tag rather than
// a single combined pass: the taxonomy is a fixed 14 tags, so 14 O(subnets)
// passes is a few thousand iterations, not a scaling concern, and keeps
// buildDomainSummary a single, independently testable/reusable unit instead of
// forking its logic for a batched variant.
export function buildDomainOverview(
  subnetRows: Array<Record<string, unknown>> | null | undefined,
  economicsRows: Array<Record<string, unknown>> | null | undefined,
): DomainOverviewResult {
  return {
    schema_version: 1,
    domain_count: DOMAIN_TAGS.length,
    // DOMAIN_TAGS is derived from domain-tags.mjs (still untyped) via
    // `DOMAIN_TAG_RULES.map(([tag]) => tag)`, which TS widens to
    // `(string | RegExp)[]` since it can't see the [string, RegExp] tuple
    // shape through the untyped .mjs import -- every element is a string
    // at runtime (DOMAIN_TAG_RULES's own first element is always a string
    // literal), so this cast reflects the real value, not a workaround.
    domains: (DOMAIN_TAGS as string[]).map((tag) =>
      buildDomainSummary(tag, subnetRows, economicsRows),
    ),
  };
}
