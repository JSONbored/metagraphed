// Per-subnet chain news for the subnet feed (#8704).
//
// The per-subnet feed carried registry changes, incidents and gap reports. A
// subnet's actual news — what governance did to it on chain — never appeared,
// even though we already index every input. This module turns those indexed
// rows into feed items.
//
// ── THE CURATION RULES, WHICH ARE CODE ──────────────────────────────────────
//
// 1. EVERY ITEM CITES A PRIMARY SOURCE, OR IT DOES NOT EXIST. `newsItem` is the
//    only constructor, it takes a non-optional `url`, and it returns null when
//    that url is empty. There is no path that produces an uncited item. This is
//    the line that keeps "aggregated" from sliding into "made up": if we cannot
//    point at the block or the extrinsic that proves a claim, we do not publish
//    the claim.
//
// 2. PER-SOURCE CAPS, applied per feed window. A hyperparameter flurry (one
//    sudo call can move several params in a block) or a chatty source must not
//    be able to push everything else out of a 50-item feed. Each kind gets its
//    own budget, so a flood in one lane cannot starve the others — the #8611
//    quiet-channel rule, applied to feeds instead of alerts.
//
// 3. DEDUPE BY IDENTITY, NOT BY OBSERVATION. Ids are keyed on the thing that
//    happened — (kind, netuid, block, param) — never on the poll that saw it,
//    so re-reading the same rows yields byte-identical items and a reader does
//    not see the same change twice.
//
// ── WHAT THE REAL DATA FORCED (captured 2026-07-30, not read off a schema) ───
//
// * `subnet_hyperparams_history` stores SNAPSHOTS, not diffs — each row is the
//   full hyperparameter object at a block. "param, old→new" therefore has to be
//   computed by diffing consecutive snapshots here; there is no change table to
//   read. `diffHyperparamSnapshots` is that computation.
//
// * `SubnetOwnerChanged` carries `netuid` as a POSITIONAL ARRAY (`[18]`), not a
//   scalar, and lands with `phase: "Initialization"` and `extrinsic_index:
//   null` — it is emitted by on-chain logic, not by a signed call. So these
//   items link to the BLOCK; there is no extrinsic to cite. A fixture typed
//   from the schema would have got both of those wrong (the same trap as
//   #8650's positional netuid).
//
// * `observed_at` arrives as epoch-ms from the chain-events tier, not ISO.
//
// * SubnetLeaseCreated/SubnetLeaseTerminated have ZERO occurrences chain-wide
//   in our indexed window, so no fixture can be captured from the producer for
//   them. They share this exact event envelope, so the envelope handling is
//   real and tested via the ownership row; only their `args` payload is
//   unobserved. `leaseEventItems` is deliberately written against the envelope
//   alone (it reports the event, not decoded lease terms) so nothing here
//   depends on a payload we have never seen.

const SITE_URL = "https://metagraph.sh";

/** Feed item shape, structurally identical to src/feeds.ts' FeedItem. */
export interface NewsItem {
  id: string;
  url: string;
  title: string;
  summary: string;
  timestamp: string;
  tags: string[];
}

/** Tag every item in this module carries, so `?tag=chain` selects them. */
export const NEWS_TAG = "chain";

/**
 * Per-kind caps, applied per feed build.
 *
 * Sized against what the sources actually do: a single sudo call can move
 * several hyperparameters in one block, so that lane gets the largest budget;
 * ownership and lease changes are rare enough that a handful is a lot.
 * Deliberately summing to less than FEED_MAX_ITEMS (50) so chain news can never
 * evict every registry change and incident from a subnet's feed.
 */
export const NEWS_CAPS: Readonly<Record<string, number>> = {
  "hyperparam-change": 12,
  "ownership-change": 5,
  "lease-event": 5,
};

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === "string") {
    // The chain-events tier returns epoch-ms; some tiers return ISO. Accept
    // both rather than assuming, and reject anything neither.
    const numeric = /^\d{10,}$/.test(value) ? Number(value) : Date.parse(value);
    if (!Number.isFinite(numeric)) return null;
    const date = new Date(numeric);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function toInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * Read a chain-event arg that may be a scalar or a positional array.
 *
 * `SubnetOwnerChanged` emits `netuid: [18]`. Other events emit it as a plain
 * number. Both are real, so both are read — this repo has now shipped one bug
 * (#8650) from assuming the scalar form.
 */
export function unwrapArg(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The ONLY item constructor. Returns null when the item cannot cite a source.
 *
 * Enforced at the single choke point rather than by convention, so an uncited
 * item is unconstructible instead of merely discouraged.
 */
export function newsItem(input: {
  id: string;
  url: string;
  title: string;
  summary: string;
  timestamp: string | null;
  tags: string[];
}): NewsItem | null {
  const { id, url, title, summary, timestamp, tags } = input;
  if (!id || !title) return null;
  if (typeof url !== "string" || url.trim() === "") return null;
  if (!timestamp) return null;
  return { id, url, title, summary, timestamp, tags };
}

/** Block explorer URL — the citation for anything without an extrinsic. */
export function blockUrl(blockNumber: number): string {
  return `${SITE_URL}/blocks/${blockNumber}`;
}

/** Extrinsic URL, when the change came from a signed call we indexed. */
export function extrinsicUrl(
  blockNumber: number,
  extrinsicIndex: number,
): string {
  return `${SITE_URL}/extrinsics/${blockNumber}-${extrinsicIndex}`;
}

// ── hyperparameter changes ──────────────────────────────────────────────────

/**
 * Hyperparameters whose movement is worth a feed item.
 *
 * An allowlist, not a denylist. The snapshot carries ~30 fields, several of
 * which are derived or float-noisy (`kappa_ratio` reads 0.49999237 for a value
 * governance set to 0.5), and emitting an item for every one of those would
 * bury the changes an operator actually needs to see. These are the parameters
 * that change what it costs or what it takes to participate.
 */
export const NEWSWORTHY_HYPERPARAMS: Readonly<Record<string, string>> = {
  registration_allowed: "Registration",
  min_burn_tao: "Minimum burn",
  max_burn_tao: "Maximum burn",
  tempo: "Tempo",
  immunity_period: "Immunity period",
  max_validators: "Max validators",
  weights_rate_limit: "Weights rate limit",
  activity_cutoff: "Activity cutoff",
  commit_reveal_enabled: "Commit-reveal",
  commit_reveal_period: "Commit-reveal period",
  liquid_alpha_enabled: "Liquid alpha",
  serving_rate_limit: "Serving rate limit",
  target_regs_per_interval: "Target registrations per interval",
  max_regs_per_block: "Max registrations per block",
  min_allowed_weights: "Min allowed weights",
  yuma_version: "Yuma version",
  transfers_enabled: "Transfers",
  subnet_is_active: "Subnet active",
};

/** One snapshot row from subnet_hyperparams_history. */
export interface HyperparamSnapshot {
  block_number: number;
  observed_at: string;
  hyperparameters: Record<string, unknown>;
}

/** A single parameter's movement between two consecutive snapshots. */
export interface HyperparamChange {
  param: string;
  label: string;
  before: unknown;
  after: unknown;
  block_number: number;
  observed_at: string;
}

function formatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  if (typeof value === "number") {
    // Trim float noise without lying about magnitude.
    return Number.isInteger(value)
      ? String(value)
      : String(Number(value.toPrecision(6)));
  }
  return String(value);
}

/**
 * Diff consecutive snapshots into per-parameter changes.
 *
 * `snapshots` must be ascending by block. Each adjacent pair yields one change
 * per newsworthy parameter that moved. The FIRST snapshot produces nothing —
 * there is no earlier state to compare it against, and reporting "tempo is 360"
 * as a change would be an item about our retention window rather than about the
 * subnet.
 */
export function diffHyperparamSnapshots(
  snapshots: readonly HyperparamSnapshot[] | null | undefined,
): HyperparamChange[] {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return [];
  const changes: HyperparamChange[] = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    const blockNumber = toInt(current?.block_number);
    const observedAt = toIso(current?.observed_at);
    if (blockNumber == null || observedAt == null) continue;
    // `?? {}` already guarantees objects, so there is no null check here --
    // an unreachable guard is dead weight that hides whether the real cases
    // are handled.
    const before = previous?.hyperparameters ?? {};
    const after = current?.hyperparameters ?? {};
    for (const [param, label] of Object.entries(NEWSWORTHY_HYPERPARAMS)) {
      // Object.hasOwn on BOTH sides: a param absent from one snapshot is a
      // schema change on our side, not a governance change on theirs, and
      // reporting `undefined -> 5000` would be a lie about what happened.
      if (!Object.hasOwn(before, param) || !Object.hasOwn(after, param)) {
        continue;
      }
      if (Object.is(before[param], after[param])) continue;
      changes.push({
        param,
        label,
        before: before[param],
        after: after[param],
        block_number: blockNumber,
        observed_at: observedAt,
      });
    }
  }
  return changes;
}

/**
 * Feed items for hyperparameter changes.
 *
 * Ids are keyed on (netuid, block, param) — the change itself — so re-polling
 * the same history yields byte-identical items.
 */
export function hyperparamChangeItems(
  netuid: number,
  snapshots: readonly HyperparamSnapshot[] | null | undefined,
  options: { cap?: number } = {},
): NewsItem[] {
  const cap = options.cap ?? NEWS_CAPS["hyperparam-change"];
  const changes = diffHyperparamSnapshots(snapshots);
  // Newest first BEFORE capping, so the cap drops the oldest rather than
  // whichever happened to be scanned last.
  changes.sort((a, b) => b.block_number - a.block_number);
  const items: NewsItem[] = [];
  for (const change of changes) {
    if (items.length >= cap) break;
    // diffHyperparamSnapshots only emits changes whose block and timestamp
    // already parsed, so newsItem cannot reject one -- the non-null assertion
    // records that, rather than a guard that can never fire.
    const item = newsItem({
      id: `chain:sn${netuid}:hyperparam:${change.block_number}:${change.param}`,
      url: blockUrl(change.block_number),
      title: `Subnet ${netuid}: ${change.label} ${formatValue(change.before)} → ${formatValue(change.after)}`,
      summary:
        `${change.label} changed from ${formatValue(change.before)} to ` +
        `${formatValue(change.after)} at block #${change.block_number}.`,
      timestamp: change.observed_at,
      tags: [NEWS_TAG, "hyperparam", `sn${netuid}`],
    })!;
    items.push(item);
  }
  return items;
}

// ── ownership + lease events ────────────────────────────────────────────────

/** One row from the chain-events tier. */
export interface ChainEventRow {
  block_number: number;
  event_index?: number | null;
  pallet?: string;
  method?: string;
  args?: Record<string, unknown> | null;
  extrinsic_index?: number | null;
  observed_at?: unknown;
}

function shortAddress(value: unknown): string {
  const address = typeof value === "string" ? value : "";
  if (address.length <= 12) return address || "unknown";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Feed items for subnet ownership transfers.
 *
 * Links to the BLOCK, not an extrinsic: the captured row carries
 * `phase: "Initialization"` and `extrinsic_index: null`, because the event is
 * emitted by runtime logic rather than a signed call. Where an extrinsic index
 * IS present we cite that instead, since it is the more precise source.
 */
export function ownershipChangeItems(
  netuid: number,
  rows: readonly ChainEventRow[] | null | undefined,
  options: { cap?: number } = {},
): NewsItem[] {
  const cap = options.cap ?? NEWS_CAPS["ownership-change"];
  if (!Array.isArray(rows)) return [];
  const items: NewsItem[] = [];
  for (const row of rows) {
    if (items.length >= cap) break;
    // Only the block number is pre-checked, because the URL cannot be built
    // without it. Everything else flows into newsItem, which is the single
    // place an item is accepted or rejected -- validating twice invites the
    // two checks to disagree.
    const blockNumber = toInt(row?.block_number);
    if (blockNumber == null) continue;
    const rowNetuid = toInt(unwrapArg(row?.args?.netuid));
    if (rowNetuid != null && rowNetuid !== netuid) continue;
    const from = shortAddress(unwrapArg(row?.args?.old_coldkey));
    const to = shortAddress(unwrapArg(row?.args?.new_coldkey));
    const extrinsicIndex = toInt(row?.extrinsic_index);
    const item = newsItem({
      id: `chain:sn${netuid}:owner:${blockNumber}:${row?.event_index ?? 0}`,
      url:
        extrinsicIndex == null
          ? blockUrl(blockNumber)
          : extrinsicUrl(blockNumber, extrinsicIndex),
      title: `Subnet ${netuid} ownership transferred`,
      summary: `Subnet ${netuid}'s owner coldkey changed from ${from} to ${to} at block #${blockNumber}.`,
      timestamp: toIso(row?.observed_at),
      tags: [NEWS_TAG, "governance", "ownership", `sn${netuid}`],
    });
    if (item) items.push(item);
  }
  return items;
}

/** Lease methods this reports, mapped to their human verb. */
const LEASE_VERBS: Readonly<Record<string, string>> = {
  SubnetLeaseCreated: "leased",
  SubnetLeaseTerminated: "lease terminated",
};

/**
 * Feed items for subnet lease lifecycle events.
 *
 * Written against the event ENVELOPE only — block, index, method, netuid — and
 * never against decoded lease terms, because these events have not fired once
 * chain-wide in our indexed window, so no payload has been observed. Reporting
 * "a lease was created, here is the block" is fully supported by the envelope;
 * reporting its duration or beneficiary would be describing fields we have
 * never seen. If they start firing, that detail is a follow-up with a real
 * fixture behind it.
 */
export function leaseEventItems(
  netuid: number,
  rows: readonly ChainEventRow[] | null | undefined,
  options: { cap?: number } = {},
): NewsItem[] {
  const cap = options.cap ?? NEWS_CAPS["lease-event"];
  if (!Array.isArray(rows)) return [];
  const items: NewsItem[] = [];
  for (const row of rows) {
    if (items.length >= cap) break;
    const method = typeof row?.method === "string" ? row.method : "";
    const verb = LEASE_VERBS[method];
    if (!verb) continue;
    const blockNumber = toInt(row?.block_number);
    if (blockNumber == null) continue;
    const rowNetuid = toInt(unwrapArg(row?.args?.netuid));
    if (rowNetuid != null && rowNetuid !== netuid) continue;
    const extrinsicIndex = toInt(row?.extrinsic_index);
    const item = newsItem({
      id: `chain:sn${netuid}:lease:${blockNumber}:${row?.event_index ?? 0}`,
      url:
        extrinsicIndex == null
          ? blockUrl(blockNumber)
          : extrinsicUrl(blockNumber, extrinsicIndex),
      title: `Subnet ${netuid} ${verb}`,
      summary: `A ${method} event was recorded for subnet ${netuid} at block #${blockNumber}.`,
      timestamp: toIso(row?.observed_at),
      tags: [NEWS_TAG, "governance", "lease", `sn${netuid}`],
    });
    if (item) items.push(item);
  }
  return items;
}

/**
 * All chain news for one subnet, capped per lane and newest-first.
 *
 * Per-lane caps are applied inside each builder, so a flood in one lane cannot
 * consume another's budget — the property `NEWS_CAPS` exists for.
 */
export function subnetNewsItems(input: {
  netuid: number;
  hyperparamSnapshots?: readonly HyperparamSnapshot[] | null;
  ownershipRows?: readonly ChainEventRow[] | null;
  leaseRows?: readonly ChainEventRow[] | null;
}): NewsItem[] {
  const { netuid } = input;
  return [
    ...hyperparamChangeItems(netuid, input.hyperparamSnapshots),
    ...ownershipChangeItems(netuid, input.ownershipRows),
    ...leaseEventItems(netuid, input.leaseRows),
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
