// #8749: hold the emission reconstruction against LIVE chain state.
//
//     STEP=emission-drift-check node scripts/check-emission-drift.ts
//
// Thin shell over src/emission-drift-check.ts, which carries the whole
// read-reconstruct-judge sequence -- shared verbatim with the Worker cron
// that replaced the 30-minute Actions schedule. This shell owns only the
// script-caller policy: env handling, the summary line on stdout, ALERT
// lines + optional webhook on divergence, and the non-zero exit.
//
// Zero alerts is the correct steady state and means the reconstruction still
// holds -- not that the monitor is broken. It prints a summary line every run
// for exactly that reason.

import { checkEmissionDrift } from "../src/emission-drift-check.ts";

// Required, with no committed default -- scan:public-safety bans private and
// loopback URLs in the repo, and a baked-in host is wrong for every deployment
// but one. Must be a node AT CHAIN TIP: an unsynced node would reconstruct
// months-old state as if it were current.
function requiredRpcUrl(): string {
  const url = process.env.EMISSION_DRIFT_RPC_URL;
  if (url) return url;
  console.error(
    "EMISSION_DRIFT_RPC_URL is required: the RPC endpoint of a node AT CHAIN TIP.",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const { summary, reasons } = await checkEmissionDrift({
    rpcUrl: requiredRpcUrl(),
    timeoutMs: Number(process.env.EMISSION_DRIFT_RPC_TIMEOUT_MS ?? 20_000),
  });

  console.log(JSON.stringify(summary));
  if (reasons.length === 0) return;

  for (const reason of reasons) console.error(`ALERT: ${reason}`);

  // Same optional-webhook convention as sample-emission-gate.ts: quietly
  // no-ops when unset rather than failing the run.
  const webhook = process.env.LIVE_ALERT_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          content:
            `🚨 metagraphed: the v440 emission reconstruction diverged at block ${summary.block_number}.\n` +
            reasons.map((r) => `• ${r}`).join("\n") +
            `\nOne of: our capture broke, a runtime upgrade changed the pipeline, ` +
            `or a dormant switch was flipped (#8750). Published emission ` +
            `decomposition is suspect until this is explained (#8749).`,
        }),
      });
    } catch (err) {
      console.error(
        `alert webhook failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Non-zero exit so the calling harness records a failure -- a monitor whose
  // alerts only go to a webhook is invisible when the webhook is misconfigured.
  process.exit(1);
}

await main();
