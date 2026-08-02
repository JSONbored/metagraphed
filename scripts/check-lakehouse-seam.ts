// Is the block seam still where the lakehouse actually ends? (#9161)
//
// `DEFAULT_BLOCKS_SEAM` routes every cold block read: at or below it the
// lakehouse answers with the full column set, above it D1's `blocks_head`
// answers with five columns and no `author`/`spec_version`/`event_count`. So a
// seam that lags the lakehouse does not fail — it quietly serves reduced rows
// for a range where verified ones exist, and silently narrows any filter on
// those columns (see `d1CanServe`).
//
// It went stale exactly that way: the decoder extended the lakehouse 2,338
// blocks past the constant and nothing re-measured it. `docs/disaster-recovery.md`
// already warned that "a stale one silently mis-routes reads" — the warning
// was right and unenforced, which is what this check fixes.
//
// Deriving the seam per request would be the WRONG fix, and blocks-cold-tier.ts
// argues that case correctly: a fixed height makes each block come from exactly
// one source, so the boundary is reproducible instead of depending on what the
// poller happened to retain. The seam stays a constant; this makes it
// impossible for that constant to drift unnoticed.
import { fileURLToPath } from "node:url";
import { r2SqlQuery } from "../src/r2-sql.ts";
import { DEFAULT_BLOCKS_SEAM } from "../src/blocks-cold-tier.ts";

export interface SeamVerdict {
  reasons: string[];
  summary: Record<string, unknown>;
}

/**
 * The whole decision, as a pure function of what was measured (#9161).
 *
 * Split out so the rule is testable without a lakehouse — same split as
 * `evaluateSafeMode` and `evaluateFreshness`.
 */
export function evaluateSeam({
  seam,
  lo,
  hi,
  count,
}: {
  seam: number;
  lo: number | null;
  hi: number | null;
  count: number | null;
}): SeamVerdict {
  const reasons: string[] = [];
  if (lo === null || hi === null || count === null) {
    // A failed read is not a passing check: staying quiet here would make an
    // unreachable lakehouse indistinguishable from a healthy one.
    reasons.push(
      "could not measure chain.blocks — the lakehouse is unreachable or the query failed",
    );
    return { reasons, summary: { seam, lo, hi, count } };
  }

  // count == hi - lo + 1 proves contiguity: no gaps AND no duplicates. A gap
  // below the seam is worse than a stale ceiling, because the seam sends those
  // reads to a source that does not have them at all.
  const expected = hi - lo + 1;
  if (count !== expected) {
    reasons.push(
      `chain.blocks is NOT contiguous: ${lo}..${hi} should hold ${expected} rows but holds ${count} ` +
        `(${expected - count} missing) — a gap below the seam is unreadable from either tier`,
    );
  }

  if (seam !== hi) {
    const drift = hi - seam;
    reasons.push(
      drift > 0
        ? `the seam lags the lakehouse by ${drift} block(s): DEFAULT_BLOCKS_SEAM is ${seam} but chain.blocks reaches ${hi}. ` +
            `Blocks ${seam + 1}..${hi} would be served from D1 blocks_head with null author/spec_version/event_count, ` +
            "and any filter on those columns silently narrows the answer, though the lakehouse holds full rows for them"
        : `the seam is ${-drift} block(s) AHEAD of the lakehouse: DEFAULT_BLOCKS_SEAM is ${seam} but chain.blocks stops at ${hi}. ` +
            `Blocks ${hi + 1}..${seam} route to a lakehouse that cannot answer, so they read as missing`,
    );
  }

  return {
    reasons,
    summary: {
      seam,
      lakehouse_lo: lo,
      lakehouse_hi: hi,
      lakehouse_count: count,
      contiguous: count === expected,
      drift: hi - seam,
    },
  };
}

async function main(): Promise<void> {
  // Reuses the Worker's own R2 SQL client rather than a second implementation,
  // so this measures through the same request shape, timeout and guards the
  // serving path uses.
  const env = {
    R2_SQL_TOKEN: process.env.R2_SQL_TOKEN,
    R2_SQL_ACCOUNT_ID: process.env.R2_SQL_ACCOUNT_ID,
    R2_SQL_WAREHOUSE: process.env.R2_SQL_WAREHOUSE,
  } as unknown as Parameters<typeof r2SqlQuery>[0];

  const rows = await r2SqlQuery(
    env,
    "SELECT min(block_number) AS lo, max(block_number) AS hi, count(*) AS n FROM chain.blocks",
  );
  const row = rows?.[0];
  const num = (value: unknown) =>
    value === null || value === undefined ? null : Number(value);

  const { reasons, summary } = evaluateSeam({
    seam: DEFAULT_BLOCKS_SEAM,
    lo: num(row?.lo),
    hi: num(row?.hi),
    count: num(row?.n),
  });

  console.log(JSON.stringify(summary, null, 2));

  if (reasons.length === 0) {
    console.log(
      `OK: the seam is exactly max(chain.blocks) and the range is contiguous.`,
    );
    return;
  }

  for (const reason of reasons) console.error(`ALERT: ${reason}`);

  const webhook = process.env.LIVE_ALERT_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          content:
            `⚠️ metagraphed: the lakehouse block seam no longer matches the lakehouse.\n` +
            reasons.map((reason) => `• ${reason}`).join("\n") +
            `\nRe-measure and update DEFAULT_BLOCKS_SEAM, or set ICEBERG_BLOCKS_MAX (#9161).`,
        }),
      });
    } catch (err) {
      console.error(
        `alert webhook failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Non-zero so the workflow records a failure -- a monitor whose alerts only
  // reach a webhook is invisible when the webhook is misconfigured.
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
