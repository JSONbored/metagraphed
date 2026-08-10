// Community-contributable entity labels (#6737-#6740): pure shaping over the
// baked entities.json artifact (registry/entities/<ss58>.json, one file per
// address) plus a reverse join against the SAME chain_events SubnetOwnerChanged
// stream src/subnet-ownership-history.ts already shapes per-subnet -- this
// module pivots that stream by coldkey instead of by netuid. No new capture:
// both inputs (the entity registry, the chain_events stream) already exist.
//
// THE TRANSFER STREAM IS NOT THE OWNERSHIP RECORD (#9313).
//
// SubnetOwnerChanged only fires on an AUTOMATIC conviction-contest transfer
// (docs/conviction-lock-mechanism.md), and there is exactly ONE such event in
// all of chain history. Ownership is established at REGISTRATION, so reading
// the stream alone answered `ownership_ties: 0` for coldkeys that plainly own
// a subnet -- this module used to call that "a real data-source gap, not a
// bug", which was true about the stream and wrong about the answer: a caller
// cannot tell a gap from a fact, and an empty list reads as "owns nothing".
//
// So current ownership now comes from the economics tier's per-subnet
// `owner_coldkey` -- MEASURED from SubtensorModule.SubnetOwner, and the only
// source every surface can reach (the poller's ownership ledger lives in the
// lakehouse alone, and this route is answered by more than one store).
// NetworkAdded cannot serve here: its args are `["netuid"]` with no coldkey to
// attribute, which is also why NetworkRemoved cannot retire a tie.
//
// The two halves stay distinguishable in the payload: `owns` is a STATE with a
// null block, the transfers are EVENTS with one, and `owners_observed_at` says
// when the state was read so it is never served as fresher than its capture.

import { decodeChainEventArgs } from "./chain-event-args.ts";

export const ENTITY_LABELS_ARTIFACT = "/metagraph/entities.json";

// entities: the entities.json artifact's `entities` array (or any array of
// entity records). Keyed by ss58 -- the registry's own one-file-per-address
// invariant means this is never a genuine collision, just last-write-wins
// defensively.
export function entityLabelsIndex(
  entities: Array<Record<string, unknown>> | null | undefined,
): Map<string, Record<string, unknown>> {
  const bySs58 = new Map<string, Record<string, unknown>>();
  for (const entity of entities ?? []) {
    if (typeof entity?.ss58 === "string" && entity.ss58) {
      bySs58.set(entity.ss58, entity);
    }
  }
  return bySs58;
}

export interface EntityLabel {
  name: unknown;
  category: unknown;
  notes: unknown;
  // #8372: the entity's own canonical homepage (schemas/entity.schema.json's
  // `url`), distinct from source_urls (which prove address ownership, not
  // the entity's identity) -- optional so a pre-#8372 entry without one
  // still resolves cleanly.
  url: unknown;
  source_urls: unknown[];
}

// Public label shape for a given address -- omits `review`/internal
// governance fields (those are curation metadata, not a user-facing claim).
// Always an array (0 or 1 entries today; array-shaped so a future multi-label
// address doesn't need a breaking response-shape change).
export function labelsForSs58(
  index: Map<string, Record<string, unknown>>,
  ss58: string,
): EntityLabel[] {
  const entity = index.get(ss58);
  if (!entity) return [];
  return [
    {
      name: entity.name ?? null,
      category: entity.category ?? null,
      notes: entity.notes ?? null,
      url: entity.url ?? null,
      source_urls: Array.isArray(entity.source_urls) ? entity.source_urls : [],
    },
  ];
}

// --- nametag resolution (#8372) -------------------------------------------
// The display-name question ("what do I call this address?") answered in one
// place, isomorphic so the Worker and the frontend can't drift on it.
//
// Order: private label -> on-chain identity -> curated nametag -> truncated
// ss58.
//
// Identity outranks the curated nametag deliberately: an on-chain identity is
// the address's OWN signed claim about itself, while a nametag is a third
// party's claim about it -- when both exist, the self-attestation wins.
//
// The private label outranks BOTH, and that ordering is the point: a user's
// own name for their own key is the most specific, most intentional claim
// available, and overriding it with a global label would be actively worse
// (someone who labels a key "Ledger cold" does not want to see "Binance"
// there instead). #8372 shipped this parameter unused, with its precedence
// fixed and tested, so that #8484 (the private-label store + UI) is purely
// additive at the call sites and needs no change to this function.

export type ResolvedAddressSource =
  "private" | "identity" | "nametag" | "truncated";

export interface ResolvedAddress {
  /** What to render. Never empty -- falls back to the truncated address. */
  display: string;
  /** Which layer produced `display`, so callers can style/affix accordingly. */
  source: ResolvedAddressSource;
  /** Present only when `source === "nametag"`; drives the category chip. */
  category: string | null;
  /** Always the full, untruncated address -- kept one copy-click away. */
  ss58: string;
}

/** `5Grwva…KutQY` -- the same shape apps/ui's own shortHash produces, kept
 * here so the fallback is part of the resolver's contract rather than each
 * call site's own choice. `keep` chars at each end. */
export function truncateSs58(ss58: string, keep = 6): string {
  if (ss58.length <= keep * 2 + 1) return ss58;
  return `${ss58.slice(0, keep)}…${ss58.slice(-keep)}`;
}

export function resolveAddress(
  ss58: string,
  {
    localLabel,
    identityName,
    nametag,
    keep,
  }: {
    /**
     * The viewer's OWN private name for this address (#8484). Browser-local,
     * never transmitted -- this module only ever receives an already-read
     * string, it does not know where that string is stored.
     */
    localLabel?: string | null;
    /** The account's own on-chain identity name, when it has set one. */
    identityName?: string | null;
    /** The curated label for this address, when one exists. */
    nametag?: { name?: unknown; category?: unknown } | null;
    keep?: number;
  } = {},
): ResolvedAddress {
  const priv = typeof localLabel === "string" ? localLabel.trim() : "";
  if (priv) {
    return { display: priv, source: "private", category: null, ss58 };
  }
  const identity = typeof identityName === "string" ? identityName.trim() : "";
  if (identity) {
    return { display: identity, source: "identity", category: null, ss58 };
  }
  const tagName = typeof nametag?.name === "string" ? nametag.name.trim() : "";
  if (tagName) {
    return {
      display: tagName,
      source: "nametag",
      category:
        typeof nametag?.category === "string" && nametag.category
          ? nametag.category
          : null,
      ss58,
    };
  }
  return {
    display: truncateSs58(ss58, keep),
    source: "truncated",
    category: null,
    ss58,
  };
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A netuid, or null -- WITHOUT `Number(null) === 0`.
 *
 * numberOrNull above coerces with `Number()`, and `Number(null)` and
 * `Number("")` are both 0 -- finite, so both pass its guard. On an owner row
 * from the economics blob that turns "this row has no netuid" into "this
 * coldkey owns subnet 0", and netuid 0 is ROOT: the silent failure is a
 * claim on the most consequential subnet there is.
 *
 * The transfer path keeps numberOrNull: its rows come from a decoded chain
 * event that always carries a netuid, so tightening it there would be changing
 * behaviour nothing exercises. This is for the untrusted artifact shape.
 */
function netuidOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isoOrNull(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * An ALREADY-ISO timestamp, normalised, or null.
 *
 * Distinct from isoOrNull above, which converts epoch MILLISECONDS -- the shape
 * chain_events rows carry. The economics artifact writes `captured_at` as an
 * ISO string, and pushing that through the numeric helper yields NaN and so
 * null, which would have published `owners_observed_at: null` on every single
 * response while looking entirely correct.
 */
function isoStringOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

interface OwnershipChangeRow {
  netuid: number | null;
  old_coldkey: unknown;
  new_coldkey: unknown;
  block_number: number | null;
  observed_at: string | null;
}

// One SubnetOwnerChanged chain_events row -> { netuid, old_coldkey,
// new_coldkey, block_number, observed_at }, decoded exactly like
// subnet-ownership-history.ts's own shapeOwnershipChange.
function decodeOwnershipChangeRow(
  row: Record<string, unknown>,
): OwnershipChangeRow {
  const decoded = decodeChainEventArgs(row.args, {
    pallet: row.pallet as string,
    method: row.method as string,
  }) as Record<string, unknown> | null | undefined;
  return {
    netuid: numberOrNull(decoded?.netuid),
    old_coldkey: decoded?.old_coldkey ?? null,
    new_coldkey: decoded?.new_coldkey ?? null,
    block_number: numberOrNull(row.block_number),
    observed_at: isoOrNull(row.observed_at),
  };
}

export interface OwnershipTie {
  netuid: number | null;
  /**
   * `owns` is a STATE; the other two are TRANSITIONS (#9313).
   *
   * They are not interchangeable and `owns` is not spelled `gained_ownership`:
   * the overwhelming majority of owners never gained anything, they registered
   * the subnet and kept it. Calling that a gain would assert a transfer that
   * never happened, on 269 of the 270 subnets ever created.
   */
  role: "owns" | "gained_ownership" | "lost_ownership";
  /** NULL for `owns` -- current ownership is not an event and has no block. */
  block_number: number | null;
  observed_at: string | null;
}

/**
 * Who currently owns each subnet, and when that was read.
 *
 * `captured_at` rides along because a current-ownership claim is only as
 * current as the capture behind it -- serving `owns` with no ceiling would be
 * publishing a snapshot as a live fact.
 */
export interface SubnetOwnerSnapshot {
  rows: Array<{ netuid: unknown; owner_coldkey: unknown }>;
  captured_at: string | null;
}

/**
 * The per-subnet owners out of the economics artifact (#9313).
 *
 * `owner_coldkey` is a MEASURED field there (`SubtensorModule.SubnetOwner`,
 * per src/economics-field-sources.ts), which is a stronger provenance than any
 * reconstruction from the event log -- and it is the only source available to
 * every surface, since the ownership ledger the poller keeps lives in the
 * lakehouse alone.
 *
 * Returns null when the blob cannot be read as one, so a missing artifact stays
 * distinguishable from a subnet set with no owners in it.
 */
export function subnetOwnersFromEconomics(
  blob: unknown,
): SubnetOwnerSnapshot | null {
  const data = blob as Record<string, unknown> | null | undefined;
  const subnets = data?.subnets;
  if (!Array.isArray(subnets)) return null;
  return {
    rows: subnets.filter(
      (row): row is { netuid: unknown; owner_coldkey: unknown } =>
        !!row && typeof row === "object" && !Array.isArray(row),
    ),
    captured_at: isoStringOrNull(data?.captured_at),
  };
}

export interface AccountEntitiesResult {
  schema_version: 1;
  ss58: string;
  labels: EntityLabel[];
  ownership_tie_count: number;
  ownership_ties: OwnershipTie[];
  /**
   * When the CURRENT-ownership half was captured, or null when no owner
   * snapshot was available (#9313).
   *
   * Null is load-bearing: it says the `owns` ties are absent because nothing
   * was read, not because this coldkey owns nothing. Without it those two
   * cases are the same empty list -- which is the confusion that made this
   * route report `ownership_ties: 0` for a live subnet owner.
   */
  owners_observed_at: string | null;
}

// #6740: one coldkey's entity labels plus every subnet-ownership tie it has
// via the SubnetOwnerChanged stream (either side of the transfer), newest
// first. `ownershipRows` are the RAW, unfiltered chain_events rows (pallet=
// SubtensorModule, method=SubnetOwnerChanged, ANY netuid) -- filtering by
// coldkey happens here, in JS, after decoding, since the raw args column
// stores hex pubkeys and only decodeChainEventArgs knows how to resolve them
// to ss58 (a SQL-side equality filter would need the reverse ss58->hex
// encoding, which this module deliberately does not attempt).
export function buildAccountEntities(
  ss58: string,
  {
    entities,
    ownershipRows,
    owners,
  }: {
    entities?: Array<Record<string, unknown>> | null;
    ownershipRows?: Array<Record<string, unknown>> | null;
    owners?: SubnetOwnerSnapshot | null;
  } = {},
): AccountEntitiesResult {
  const labels = labelsForSs58(entityLabelsIndex(entities), ss58);

  // CURRENT OWNERSHIP FIRST (#9313).
  //
  // The transfer stream below cannot answer "what does this coldkey own": it
  // holds exactly ONE SubnetOwnerChanged event chain-wide, because ownership is
  // established at registration and only transferred by conviction contest.
  // Reading it alone reported `ownership_ties: 0` for coldkeys that demonstrably
  // own a subnet -- a confident empty, which is worse than a decline.
  const ownedTies: OwnershipTie[] = (owners?.rows ?? [])
    .filter((row) => row.owner_coldkey === ss58)
    .map((row) => ({
      netuid: netuidOrNull(row.netuid),
      role: "owns" as const,
      // NOT a block. Current ownership is a state read from storage, and
      // inventing a block for it would date a standing fact to an event.
      block_number: null,
      observed_at: owners?.captured_at ?? null,
    }))
    .sort((a, b) => (a.netuid ?? 0) - (b.netuid ?? 0));

  const transferTies: OwnershipTie[] = (ownershipRows ?? [])
    .map(decodeOwnershipChangeRow)
    .filter(
      (change) => change.old_coldkey === ss58 || change.new_coldkey === ss58,
    )
    .map((change) => ({
      netuid: change.netuid,
      role: (change.new_coldkey === ss58
        ? "gained_ownership"
        : "lost_ownership") as "gained_ownership" | "lost_ownership",
      block_number: change.block_number,
      observed_at: change.observed_at,
    }))
    .sort((a, b) => (b.block_number ?? 0) - (a.block_number ?? 0));

  // State before history, and NOT merged into one sort: the two halves are
  // ordered by different things (netuid; block) and have different meanings, so
  // interleaving them by a shared key would imply a timeline they do not share.
  const ownershipTies = [...ownedTies, ...transferTies];

  return {
    schema_version: 1,
    ss58,
    labels,
    ownership_tie_count: ownershipTies.length,
    ownership_ties: ownershipTies,
    owners_observed_at: owners?.captured_at ?? null,
  };
}
