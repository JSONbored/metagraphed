// Per-account axon-removal footprint: which subnets one account (hotkey) removed an announced axon
// endpoint on over a recent window, broken down per subnet and rolled up into a footprint scorecard.
// Pure shaping (buildAccountAxonRemovals) + a thin store loader (loadAccountAxonRemovals); the Worker
// adds the REST envelope. Null-safe: a cold store or an empty window yields schema-stable zeros
// (never throws), matching the sibling account tiers (serving, registrations, stake-flow).
//
// This is the account-level companion of the per-subnet and network axon-removal leaderboards
// (/api/v1/subnets/{netuid}/axon-removals and /api/v1/chain/axon-removals): those answer "who tears
// down axons on subnet N" / "which subnets churn their serving infrastructure", this answers "which
// subnets did THIS account remove an axon on, how often, and when" — a per-subnet AxonInfoRemoved
// count with the first/last removal timestamps, an HHI concentration of where its teardown activity
// is focused, and the dominant subnet. The teardown-side complement to /accounts/{ss58}/serving
// (axon announcements) — an account announces an axon, then removes it — operational activity
// orthogonal to /accounts/{ss58}/subnets (registration state).

import { roundBelowOne } from "./lib/stats.ts";
import {
  axonChangeKind,
  axonChangesCoverage,
  axonChangesDerivation,
  axonChangesObservedAt,
  emptyAxonChangeBreakdown,
  type AxonChangeBreakdown,
  type AxonChangesCoverage,
  type AxonChangesDerivation,
} from "./axon-reachability-changes.ts";

// A non-negative integer netuid, or null for a malformed/absent cell. Guard null explicitly so a
// null netuid is skipped rather than coerced to subnet 0 (Number(null) === 0); a blank/whitespace
// cell (Number("") → 0) is likewise skipped.
function normalizedNetuid(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

// A non-negative whole count from a COUNT() cell (number, numeric string, or
// null), defaulting to 0 for anything non-finite or negative.
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export interface AccountAxonRemovalSubnet {
  netuid: number;
  removals: number;
  first_removed_at: string | null;
  last_removed_at: string | null;
  changes: AxonChangeBreakdown;
}

export interface AccountAxonRemovalsResult extends AxonChangesCoverage {
  schema_version: 1;
  address: string;
  window: string | null;
  observed_at: string | null;
  total_removals: number;
  subnet_count: number;
  concentration: number | null;
  dominant_netuid: number | null;
  subnets: AccountAxonRemovalSubnet[];
  /** The account's full three-way split across every subnet in the window. */
  changes: AxonChangeBreakdown;
  derivation: AxonChangesDerivation;
}

/**
 * Shape an account's footprint from its per-(netuid, kind) aggregate.
 *
 * `rows` carries netuid, kind, n, and -- on the stopped-announcing rows only --
 * first_date / last_date. `total_removals` and the concentration are computed
 * over REMOVALS alone: an account whose UID was recycled on ten subnets did not
 * remove ten axons, and folding those in would report a teardown footprint for
 * an account that tore nothing down.
 *
 * Subnets where the account's only changes were deregistrations or moves still
 * appear, with `removals: 0` and their `changes` stated. Dropping them would
 * hide the thing worth seeing: that the account is churning, not withdrawing.
 */
export function buildAccountAxonRemovals(
  rows: Array<Record<string, unknown>> | null | undefined,
  address: string,
  {
    window,
    coverage,
  }: { window?: string | null; coverage?: AxonChangesCoverage } = {},
): AccountAxonRemovalsResult {
  const list = Array.isArray(rows) ? rows : [];
  const perSubnet = new Map<
    number,
    {
      changes: AxonChangeBreakdown;
      firstDate: string | null;
      lastDate: string | null;
    }
  >();
  for (const row of list) {
    const netuid = normalizedNetuid(row?.netuid);
    const kind = axonChangeKind(row?.kind);
    if (netuid == null || kind == null) continue;
    const n = toCount(row?.n);
    const bucket = perSubnet.get(netuid) ?? {
      changes: emptyAxonChangeBreakdown(),
      firstDate: null,
      lastDate: null,
    };
    if (kind === "deregistered") bucket.changes.deregistered += n;
    else if (kind === "moved-unroutable") bucket.changes.moved_unroutable += n;
    else {
      bucket.changes.stopped_announcing += n;
      // Only a removal has a removal date. A deregistration's dates belong to
      // whoever took the UID, and a move is not a removal at all.
      const first = normalizedDate(row?.first_date);
      const last = normalizedDate(row?.last_date);
      if (
        first != null &&
        (bucket.firstDate == null || first < bucket.firstDate)
      ) {
        bucket.firstDate = first;
      }
      if (last != null && (bucket.lastDate == null || last > bucket.lastDate)) {
        bucket.lastDate = last;
      }
    }
    bucket.changes.total += n;
    perSubnet.set(netuid, bucket);
  }

  let totalRemovals = 0;
  let squares = 0;
  const accountChanges = emptyAxonChangeBreakdown();
  const subnets: AccountAxonRemovalSubnet[] = [];
  for (const [netuid, b] of perSubnet) {
    const removals = b.changes.stopped_announcing;
    totalRemovals += removals;
    squares += removals * removals;
    accountChanges.deregistered += b.changes.deregistered;
    accountChanges.moved_unroutable += b.changes.moved_unroutable;
    accountChanges.stopped_announcing += removals;
    accountChanges.total += b.changes.total;
    subnets.push({
      netuid,
      removals,
      first_removed_at: axonChangesObservedAt(b.firstDate),
      last_removed_at: axonChangesObservedAt(b.lastDate),
      changes: b.changes,
    });
  }
  // Most removals first, then most total change, then netuid for stability --
  // the same ranking rule the chain leaderboard uses, for the same reason.
  subnets.sort(
    (a, b) =>
      b.removals - a.removals ||
      b.changes.total - a.changes.total ||
      a.netuid - b.netuid,
  );
  // The dominant subnet is the head of that ranking, and null when the account
  // removed nothing anywhere -- a churning account has no dominant teardown.
  const dominantNetuid =
    subnets.length > 0 && subnets[0].removals > 0 ? subnets[0].netuid : null;
  // HHI over removals: 1 = all on one subnet, -> 1/n as it spreads. Null when
  // there are no removals to concentrate.
  const concentration =
    totalRemovals > 0
      ? roundBelowOne(squares / (totalRemovals * totalRemovals))
      : null;

  const resolved = coverage ?? axonChangesCoverage(null, null, null, null);
  return {
    schema_version: 1,
    address,
    window: window ?? null,
    observed_at: axonChangesObservedAt(resolved.end_date),
    ...resolved,
    total_removals: totalRemovals,
    subnet_count: subnets.length,
    concentration,
    dominant_netuid: dominantNetuid,
    subnets,
    changes: accountChanges,
    derivation: axonChangesDerivation(),
  };
}

/** A YYYY-MM-DD snapshot date, or null. */
function normalizedDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}
