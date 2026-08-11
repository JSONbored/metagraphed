// #10487: do the tokens they said they burned ever move again?
//
// The sharpest question in either money-map epic, and the one with the largest
// blast radius, so the framing is part of the contract rather than a nicety.
//
// A FIRE IS A DISCREPANCY BETWEEN A CLAIM AND THE CHAIN, NOT AN ACCUSATION.
// Three things can produce one, and only the third is misconduct:
//
//   1. OUR ATTRIBUTION IS WRONG -- we labelled an address `burn` that is not
//      one. Given #10448 nearly recorded a protocol-derived account as a
//      collector, this is a live possibility and is named first on purpose.
//   2. THE UNSPENDABILITY PROOF WAS WEAKER THAN IT LOOKED -- an address
//      believed keyless turning out not to be.
//   3. The team moved tokens they said were destroyed.
//
// Every emitted finding carries all three readings. A watchdog that says "SN X
// moved burned tokens" has decided between them; this one reports what moved
// and states that it cannot.
//
// WHAT IS NOT A THRESHOLD. A burn address should have EXACTLY zero outbound, so
// there is no tolerance band to tune -- `min_amount` exists only to floor
// index noise (a dust row from a decode artefact), not to permit small
// movements. Sizing it "to the producer cadence" the way a staleness watchdog
// is sized would be a category error: this lane is not watching for silence.
//
// AND IT IS NEVER SUPPRESSED. There is no known-bad state that makes an
// outbound move from a declared burn address expected -- if one moves, that is
// precisely the signal, and silencing it because we already know would defeat
// the only thing this lane does.

import type { DeclaredWallet, WalletFlowRow } from "./wallet-activity.ts";

/** The floor below which a row is index noise rather than a movement. Alpha and
 * TAO are both 9dp on chain, so anything under a nanounit is not a transfer. */
export const BURN_OUTFLOW_DUST_FLOOR = 1e-9;

export interface BurnDiscrepancy {
  address: string;
  netuid: number | null;
  denomination: "tao" | "alpha";
  amount: number;
  observed_at: string | null;
  /** The declared evidence for the burn claim, carried so a reader can check
   * the attribution that produced this finding without a second lookup. */
  source_urls: string[];
  /** The wording is fixed here, once, rather than improvised per event. */
  reading: string;
}

const READING =
  "An address declared unspendable shows outbound movement. This is a " +
  "discrepancy between a published claim and the chain, not a finding of " +
  "misconduct: our attribution may be wrong, the unspendability proof may " +
  "have been weaker than it looked, or the tokens may have moved. This lane " +
  "cannot distinguish those.";

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Every outbound movement from the declared burn addresses in `wallets`.
 *
 * ONE FINDING PER EVENT, with its own amount and stamp -- not a rolling summary.
 * A summary answers "how much left this quarter", which is a different and less
 * actionable question than "which movement, when": the second can be looked up
 * on chain and argued with, the first cannot.
 */
export function detectBurnOutflow(
  wallets: DeclaredWallet[] | null | undefined,
  rowsByAddress: Map<string, WalletFlowRow[]> | null | undefined,
  { minAmount = BURN_OUTFLOW_DUST_FLOOR }: { minAmount?: number } = {},
): BurnDiscrepancy[] {
  const out: BurnDiscrepancy[] = [];
  for (const wallet of Array.isArray(wallets) ? wallets : []) {
    // ONLY declared burns. A treasury moving funds is ordinary activity and
    // reporting it here would drown the one signal that matters.
    if (wallet?.category !== "burn") continue;
    const address = typeof wallet.ss58 === "string" ? wallet.ss58 : "";
    if (!address) continue;

    for (const row of rowsByAddress?.get(address) ?? []) {
      if (row?.address !== address) continue;
      if (row.direction !== "out") continue;
      const amount = finite(row.amount);
      if (amount === null || amount <= minAmount) continue;
      if (row.denomination !== "tao" && row.denomination !== "alpha") continue;
      out.push({
        address,
        netuid:
          row.denomination === "alpha" ? (finite(row.netuid) ?? null) : null,
        denomination: row.denomination,
        amount,
        observed_at:
          typeof row.observed_at === "string" ? row.observed_at : null,
        source_urls: Array.isArray(wallet.source_urls)
          ? [...wallet.source_urls]
          : [],
        reading: READING,
      });
    }
  }
  return out;
}

export interface BurnWatchdogResult {
  /** How many declared burn addresses were watched this pass. */
  watched: number;
  findings: BurnDiscrepancy[];
  /** ok when nothing moved; `alert` on any finding. */
  verdict: "ok" | "alert" | "idle";
  detail: string;
}

/**
 * One pass.
 *
 * `idle` when there is nothing to watch, and it is DELIBERATELY NOT `ok`. Zero
 * declared burn addresses is the current state of the registry, and a lane that
 * reports success while watching nothing is indistinguishable from one that
 * watched something and found it clean -- the exact confusion that let the
 * revenue probe sit dead for two months (#10566).
 */
export function runBurnOutflowWatchdog(
  wallets: DeclaredWallet[] | null | undefined,
  rowsByAddress: Map<string, WalletFlowRow[]> | null | undefined,
  options: { minAmount?: number } = {},
): BurnWatchdogResult {
  const declared = (Array.isArray(wallets) ? wallets : []).filter(
    (w) => w?.category === "burn" && typeof w?.ss58 === "string" && w.ss58,
  );
  const findings = detectBurnOutflow(wallets, rowsByAddress, options);
  if (declared.length === 0) {
    return {
      watched: 0,
      findings: [],
      verdict: "idle",
      detail:
        "no addresses are declared category:burn, so this pass watched " +
        "nothing -- not the same claim as finding nothing",
    };
  }
  return {
    watched: declared.length,
    findings,
    verdict: findings.length > 0 ? "alert" : "ok",
    detail:
      findings.length > 0
        ? `${findings.length} outbound movement(s) from ${declared.length} declared burn address(es)`
        : `${declared.length} declared burn address(es), no outbound movement`,
  };
}
