// #10442/#10483/#10516: every subnet owns a protocol-derived TAO account, and
// that account is the single most dangerous thing to mislabel in the money map.
//
// It receives large, continuous, many-party inbound flow -- because that is
// what buying alpha looks like -- so it presents exactly like a subnet team's
// payment collector. The #10448 spike very nearly recorded SN64's as a Chutes
// revenue wallet on that basis; the inbound was users staking, a capital flow,
// and counting it as revenue would have overstated the subnet by orders of
// magnitude.
//
// It is not a judgement call. Substrate derives these addresses deterministic-
// ally from a PalletId, so membership is COMPUTED, never curated:
//
//   AccountId32 = b"modl" ++ b"subtensr" ++ scale(u16 netuid), zero-padded to 32
//
// Verified against three independently-observed production addresses:
//   netuid 0   -> 5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F
//   netuid 44  -> 5EYCAe5jLQhn6ofDSw3BjtVwyQbDX7QCLmMzRiuh4KrSienC
//   netuid 64  -> 5EYCAe5jLQhn6ofDSw8caRPiDJ7AgBRh4CABSaeQJqM278gq
//
// Deriving beats listing: a curated list goes stale the moment a subnet is
// registered, and a stale list fails OPEN -- the new subnet's account is
// unlabelled and therefore attributable. Derivation covers netuids that do not
// exist yet.
import { DEFAULT_SS58_PREFIX, decodeSs58, encodeAccountId32 } from "./ss58.ts";

/** `modl` — Substrate's universal prefix for PalletId-derived accounts. */
const MODULE_PREFIX = [0x6d, 0x6f, 0x64, 0x6c];
/** Subtensor's 8-byte PalletId. */
const SUBTENSOR_PALLET_ID = [0x73, 0x75, 0x62, 0x74, 0x65, 0x6e, 0x73, 0x72];

export const MAX_NETUID = 65535;

/**
 * The 32-byte AccountId for a subnet's protocol TAO account. Returns null for a
 * netuid outside the u16 range rather than truncating it into another subnet's
 * account -- silently returning the wrong subnet's address is the one failure
 * mode this module must not have.
 */
export function subnetAccountId(netuid: number): Uint8Array | null {
  if (!Number.isInteger(netuid) || netuid < 0 || netuid > MAX_NETUID) {
    return null;
  }
  const bytes = new Uint8Array(32);
  bytes.set(MODULE_PREFIX, 0);
  bytes.set(SUBTENSOR_PALLET_ID, MODULE_PREFIX.length);
  // SCALE-encodes u16 little-endian; the remaining bytes stay zero, which is
  // `into_sub_account_truncating`'s padding.
  const offset = MODULE_PREFIX.length + SUBTENSOR_PALLET_ID.length;
  bytes[offset] = netuid & 0xff;
  bytes[offset + 1] = (netuid >> 8) & 0xff;
  return bytes;
}

/** The SS58 address of a subnet's protocol TAO account, or null if netuid is out of range. */
export function subnetAccountSs58(
  netuid: number,
  prefix = DEFAULT_SS58_PREFIX,
): string | null {
  const id = subnetAccountId(netuid);
  return id ? encodeAccountId32(id, prefix) : null;
}

/**
 * The netuid an address is the protocol account for, or null if it is not one.
 *
 * Recognises by DECODING the address and reading its structure, not by
 * comparing against a generated list. Two consequences, both wanted:
 *
 *  - It answers correctly for subnets that do not exist yet. A caller asking
 *    "may this address carry a revenue or treasury role?" wants `false` for
 *    netuid 999 even with no such subnet registered -- the address is still
 *    protocol-shaped and still not anybody's treasury. A curated list would
 *    fail OPEN here, which is the dangerous direction.
 *  - It is O(1), and it is prefix-agnostic: the same account re-encoded under
 *    another SS58 prefix still decodes to the same public key, so a caller
 *    cannot slip one past the guard by changing network prefix.
 */
export function protocolSubnetNetuid(
  ss58: string | null | undefined,
): number | null {
  const decoded = decodeSs58(ss58);
  if (!decoded) return null;
  // decodeSs58 validates the checksum over a fixed-width payload, so publicKey
  // is always exactly 32 bytes here -- no length guard, which would be dead.
  const pk = decoded.publicKey;
  for (let i = 0; i < MODULE_PREFIX.length; i += 1) {
    if (pk[i] !== MODULE_PREFIX[i]) return null;
  }
  for (let i = 0; i < SUBTENSOR_PALLET_ID.length; i += 1) {
    if (pk[MODULE_PREFIX.length + i] !== SUBTENSOR_PALLET_ID[i]) return null;
  }
  const offset = MODULE_PREFIX.length + SUBTENSOR_PALLET_ID.length;
  // Everything past the netuid must be the derivation's zero padding. Without
  // this check any account merely STARTING with the pallet prefix would be
  // accepted as protocol-owned -- the guard would then exempt an address an
  // attacker chose, which is worse than not having it.
  for (let i = offset + 2; i < pk.length; i += 1) {
    if (pk[i] !== 0) return null;
  }
  return pk[offset] | (pk[offset + 1] << 8);
}

/** True when the address is a subnet's protocol TAO account. */
export function isProtocolSubnetAccount(
  ss58: string | null | undefined,
): boolean {
  return protocolSubnetNetuid(ss58) !== null;
}
