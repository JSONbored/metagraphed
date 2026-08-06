// What did the user paste? (metagraphed-infra#362)
//
// A block explorer's most common search is not a question, it is an
// IDENTIFIER: a block hash, an extrinsic hash, an account, a netuid. Every one
// of them is recognisable from its shape alone, with no index lookup, no
// inference, and no round trip.
//
// This existed nowhere. The three search surfaces are all corpus search -- two
// over the registry, one over the docs -- and none of them resolves a chain
// identifier, so pasting a block hash into the search box returned registry
// results or nothing. The explorer PAGES were there the whole time; nothing
// routed a query to them.
//
// DETERMINISTIC, AND DELIBERATELY SO. Putting a model in front of a 64-hex
// string can only make a question with exactly one right answer slower and less
// certain. Semantic search is the right tool for "which subnet does
// speech-to-text"; it is the wrong tool for "0x1234...".
//
// AMBIGUITY IS RETURNED, NOT GUESSED. Two inputs are genuinely ambiguous on
// this chain, and picking one would be wrong roughly half the time:
//
//   * a 64-hex hash is a block hash OR an extrinsic hash -- the two share a
//     shape and only a lookup can separate them;
//   * a small integer is a netuid AND a block height -- 7 is both a real subnet
//     and a real block, and always has been.
//
// So the resolver returns every candidate, ordered by likelihood, and the
// caller shows them. A disambiguation UI is a better answer than a coin flip.
import { decodeSs58 } from "./ss58.ts";

/** One place the resolver thinks the query might lead. */
export interface ResolvedIdentifier {
  kind: "account" | "block" | "extrinsic" | "evm-account" | "subnet" | "neuron";
  /** The canonical value, normalised (hex lowercased, integers as numbers). */
  value: string;
  /** The API path that answers for it. */
  api_path: string;
  /** The site path a UI should link to. */
  ui_path: string;
  /**
   * Whether this candidate is the only possible reading of the input.
   *
   * `false` means the SHAPE matched but another kind matches the same shape --
   * the caller should present alternatives rather than redirect. It does NOT
   * mean the entity exists; the resolver never looks anything up.
   */
  exact: boolean;
}

/**
 * The netuid ceiling used to decide whether a bare integer could be a subnet.
 *
 * Matches CHAIN_BURN_MAX_NETUIDS rather than the ~129 subnets that exist today:
 * the resolver must keep working as the network grows, and a ceiling tuned to
 * the current count would silently stop offering the subnet reading the day
 * subnet 130 registered.
 */
export const RESOLVER_MAX_NETUID = 1024;

/** Substrate block hashes and extrinsic hashes are both 32-byte blake2. */
const HASH_HEX_LENGTH = 64;
/** An Ethereum-style address, for the EVM mapping surface. */
const H160_HEX_LENGTH = 40;

/** Bound the work an attacker-controlled query can cause. Nothing legitimate is
 * longer than an ss58 address, and every branch below is O(1) anyway -- this is
 * about not hashing a megabyte to learn it is not an address. */
const MAX_QUERY_LENGTH = 128;

const HEX_RE = /^[0-9a-f]+$/;

function hexBody(query: string): string | null {
  const body = query.startsWith("0x") ? query.slice(2) : query;
  const lower = body.toLowerCase();
  return HEX_RE.test(lower) ? lower : null;
}

/**
 * Every destination a query could mean, most likely first.
 *
 * Returns `[]` when nothing matches, which is the signal to fall through to
 * corpus search -- the resolver's job is to catch identifiers, not to have an
 * opinion about prose.
 */
export function resolveIdentifier(query: unknown): ResolvedIdentifier[] {
  if (typeof query !== "string") return [];
  const q = query.trim();
  if (!q || q.length > MAX_QUERY_LENGTH) return [];

  // --- neuron: netuid:uid ---------------------------------------------------
  // Checked FIRST because "74:12" also parses as neither an integer nor a hash,
  // and reading it as anything else would lose the uid.
  const neuron = /^(\d{1,4}):(\d{1,5})$/.exec(q);
  if (neuron) {
    const netuid = Number(neuron[1]);
    const uid = Number(neuron[2]);
    if (netuid <= RESOLVER_MAX_NETUID) {
      return [
        {
          kind: "neuron",
          value: `${netuid}:${uid}`,
          api_path: `/api/v1/subnets/${netuid}/neurons/${uid}`,
          ui_path: `/subnets/${netuid}?uid=${uid}`,
          exact: true,
        },
      ];
    }
  }

  // --- account: an ss58 address, CHECKSUM-VERIFIED --------------------------
  // Shape alone is not enough: a 48-character base58 string that fails the
  // checksum is a typo, and offering it as an account sends the user to a 404
  // that looks like "this account has no activity".
  if (decodeSs58(q)) {
    return [
      {
        kind: "account",
        value: q,
        api_path: `/api/v1/accounts/${q}`,
        ui_path: `/accounts/${q}`,
        exact: true,
      },
    ];
  }

  const hex = hexBody(q);

  // --- EVM account: 20 bytes ------------------------------------------------
  if (hex && hex.length === H160_HEX_LENGTH && q.startsWith("0x")) {
    return [
      {
        kind: "evm-account",
        value: `0x${hex}`,
        api_path: `/api/v1/evm/address-mapping/0x${hex}`,
        ui_path: `/accounts?h160=0x${hex}`,
        exact: true,
      },
    ];
  }

  // --- 32 bytes: a block hash OR an extrinsic hash --------------------------
  // BOTH are returned. They are indistinguishable by shape, and guessing wrong
  // sends the user to a 404 for an entity that exists under the other reading.
  // Block first only because a bare hash is more often pasted from a block
  // context; the caller should show both.
  if (hex && hex.length === HASH_HEX_LENGTH) {
    const value = `0x${hex}`;
    return [
      {
        kind: "block",
        value,
        api_path: `/api/v1/blocks/${value}`,
        ui_path: `/blocks/${value}`,
        exact: false,
      },
      {
        kind: "extrinsic",
        value,
        api_path: `/api/v1/extrinsics/${value}`,
        ui_path: `/extrinsics/${value}`,
        exact: false,
      },
    ];
  }

  // --- a bare integer: a block height AND possibly a netuid -----------------
  // The genuinely ambiguous case. `7` is subnet 7 and block 7, both real. The
  // block reading is listed first because block heights span the whole range
  // while netuids stop at a few hundred, so a large number is unambiguous and a
  // small one is the case that needs the choice shown.
  if (/^\d{1,12}$/.test(q)) {
    const n = Number(q);
    const out: ResolvedIdentifier[] = [
      {
        kind: "block",
        value: String(n),
        api_path: `/api/v1/blocks/${n}`,
        ui_path: `/blocks/${n}`,
        exact: n > RESOLVER_MAX_NETUID,
      },
    ];
    if (n <= RESOLVER_MAX_NETUID) {
      out.push({
        kind: "subnet",
        value: String(n),
        api_path: `/api/v1/subnets/${n}`,
        ui_path: `/subnets/${n}`,
        exact: false,
      });
    }
    return out;
  }

  return [];
}

/** The served payload for GET /api/v1/search/resolve. Pure, so the route is a
 * thin wrapper and the shape is testable without a request. */
export function buildSearchResolve(query: unknown): {
  schema_version: 1;
  query: string;
  matches: ResolvedIdentifier[];
  match_count: number;
  unambiguous: boolean;
} {
  const q = typeof query === "string" ? query.trim() : "";
  const matches = resolveIdentifier(q);
  return {
    schema_version: 1,
    query: q,
    matches,
    match_count: matches.length,
    // A UI may navigate straight to a single exact candidate. With two readings
    // -- or one that only matched by shape -- it must show the choice, which is
    // the entire reason this field exists rather than `matches[0]`.
    unambiguous: matches.length === 1 && matches[0]!.exact,
  };
}
