import type { AccountSummary } from "./types";

// #8252: Bittensor's total issuance is capped at 21M TAO. A balance above it
// is definitionally a decode/unit bug, not a real holding -- the Phase-0 fix
// (#8259) corrected the u64-vs-u128 AccountData decode that produced
// "2,324,289,753,287.40M τ" on a whale coldkey, and this is the UI-side guard
// so a future regression of that class renders "—" rather than an absurd
// number presented as fact.
export const TAO_TOTAL_ISSUANCE = 21_000_000;

export function isImplausibleTao(value: number | null | undefined): boolean {
  return value != null && Number.isFinite(value) && value > TAO_TOTAL_ISSUANCE;
}

export const IMPLAUSIBLE_TAO_NOTE =
  "This value exceeds TAO's 21M total issuance, so it can't be a real balance — it indicates a data or unit-decode error upstream, not a holding of this size.";

/**
 * Which face of the account page leads.
 *
 * An ss58 is just an address -- the same key can be a coldkey (holds balance,
 * delegates stake) or a hotkey (registered on subnets, validates/mines), and
 * plenty are both or neither. Rather than guess from the address itself
 * (impossible -- coldkey and hotkey addresses are indistinguishable), infer
 * from what the account actually DOES on-chain: registrations/UIDs mean it
 * acts as a hotkey; their absence means the balance/positions/transfers story
 * is the whole story.
 *
 * "unknown" is a real, common answer (a cold address with no indexed activity
 * yet) and deliberately leads with the coldkey view -- balance and transfers
 * are meaningful for any address, while a registrations table for a key with
 * no registrations is exactly the framed-empty-panel noise #8252 removes.
 */
export type AccountRole = "coldkey" | "hotkey";

export function accountRole(account: Pick<AccountSummary, "registrations">): AccountRole {
  return (account.registrations?.length ?? 0) > 0 ? "hotkey" : "coldkey";
}
