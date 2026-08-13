// The human gate on treasury readings (#10933), as a credentialed CLI.
//
// ## WHY THIS IS A SCRIPT AND NOT A SURFACE
//
// A treasury reading is published only once a maintainer has promoted it, and
// the promotion is the one action in this system that turns a machine's guess
// into a published claim about somebody's business. It must therefore be
// reachable by exactly one person and advertised to nobody:
//
//   - a route would appear in openapi.json even gated behind a secret;
//   - an MCP tool would appear in the served tool list;
//   - a Worker cron cannot make a judgement, which is the whole point.
//
// A script needing DATABASE_URL is none of those. It is the same posture
// scripts/neon-migrate.ts already has for DDL: a credential nobody else holds,
// no surface, no schedule.
//
// ## THE FINDING IS SHOWN BEFORE IT IS PUBLISHED
//
// `list` prints exactly the fields a candidate WITHHOLDS from the served card
// -- the share, the address, what it applies to -- because a review gate that
// does not show you what you are about to publish is a rubber stamp with extra
// steps. Promoting is a second, explicit command naming the row.
//
// ## WHAT PROMOTION DOES AND DOES NOT MEAN
//
// `reviewed` means: a human read the cited commit and agrees the row describes
// what that code does. It is NOT an accusation, and the card says so -- a cut
// declared in a public repo is a disclosed business model, and
// `declared_matches_observed` is published as prominently when it agrees.
//
// `rejected` means the reading is wrong, and the row stays as evidence that it
// was looked at rather than being deleted. Deleting would make a re-read
// produce the same candidate forever with nothing recording that a human had
// already dismissed it.
import pg from "pg";
import { TREASURY_REVIEW_STATES } from "../schemas-src/treasury.ts";

interface CandidateRow {
  netuid: number;
  source_url: string;
  read_at_sha: string;
  observed_at: string;
  found: boolean;
  declared_share: number | null;
  treasury_address: string | null;
  applies_to: string | null;
  evidence_path: string | null;
  review_state: string;
}

/** The states a maintainer may promote INTO. `candidate` is what the extractor
 * writes; promoting something back to it would be undoing a review rather than
 * making one, and there is no reason to do that from here. */
export const PROMOTABLE_STATES = TREASURY_REVIEW_STATES.filter(
  (state) => state !== "candidate",
);

export interface ReviewCommand {
  action: "list" | "promote";
  netuid?: number;
  sourceUrl?: string;
  state?: string;
}

/**
 * Parse argv into a command, or explain the refusal.
 *
 * PURE, so the argument rules are testable without a database. Every refusal
 * names what was wrong rather than printing usage: this is run rarely, by one
 * person, usually months apart, and "usage:" is what you read when you already
 * know what you meant.
 */
export function parseReviewArgs(
  argv: readonly string[],
): { command: ReviewCommand } | { error: string } {
  const [action, ...rest] = argv;
  if (action === "list") return { command: { action: "list" } };
  if (action !== "promote") {
    return {
      error: `unknown action ${JSON.stringify(action ?? "")}. Expected "list" or "promote".`,
    };
  }
  const [netuidArg, sourceUrl, state] = rest;
  // `Number("")` is 0 and `Number(" ")` is 0, so an omitted netuid would parse
  // as netuid 0 -- root -- and promote a reading against the wrong subnet
  // entirely. The emptiness check has to come before the numeric one.
  const netuid =
    typeof netuidArg === "string" && netuidArg.trim() !== ""
      ? Number(netuidArg)
      : Number.NaN;
  if (!Number.isInteger(netuid) || netuid < 0) {
    return {
      error: `promote needs a netuid; got ${JSON.stringify(netuidArg ?? "")}`,
    };
  }
  if (!sourceUrl) {
    return {
      error:
        "promote needs the source_url of the reading. A subnet can have more " +
        "than one, and they can disagree -- naming the subnet alone would " +
        "promote whichever the database returned first.",
    };
  }
  if (!state || !PROMOTABLE_STATES.includes(state as never)) {
    return {
      error: `promote needs a state, one of: ${PROMOTABLE_STATES.join(", ")}`,
    };
  }
  return { command: { action: "promote", netuid, sourceUrl, state } };
}

/** One candidate, printed with the fields the served card withholds. */
export function formatCandidate(row: CandidateRow): string {
  const finding = row.found
    ? [
        row.declared_share === null
          ? null
          : `share ${(row.declared_share * 100).toFixed(2)}%`,
        row.applies_to ? `of ${row.applies_to}` : null,
        row.treasury_address ? `to ${row.treasury_address}` : null,
      ]
        .filter(Boolean)
        .join(" ")
    : "read, nothing allocated";
  return [
    `netuid ${row.netuid}  [${row.review_state}]`,
    `  ${row.source_url}`,
    `  @ ${row.read_at_sha.slice(0, 12)}${
      row.evidence_path ? `  ${row.evidence_path}` : ""
    }`,
    `  FINDING: ${finding}`,
  ].join("\n");
}

const LIST_SQL = `
  SELECT netuid, source_url, read_at_sha, observed_at, found, declared_share,
         treasury_address, applies_to, evidence_path, review_state
  FROM treasury_readings
  WHERE review_state = 'candidate'
  ORDER BY netuid, source_url`;

const PROMOTE_SQL = `
  UPDATE treasury_readings
  SET review_state = $3, reviewed_at = $4
  WHERE netuid = $1 AND source_url = $2
  RETURNING netuid, source_url, review_state`;

async function main(): Promise<void> {
  const parsed = parseReviewArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Not a warning, for the same reason the migration runner refuses: a review
    // tool that "succeeds" without a database has reviewed nothing.
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (parsed.command.action === "list") {
      const { rows } = await client.query<CandidateRow>(LIST_SQL);
      if (rows.length === 0) {
        console.log("no candidate readings awaiting review");
        return;
      }
      console.log(`${rows.length} candidate reading(s) awaiting review:\n`);
      for (const row of rows) console.log(`${formatCandidate(row)}\n`);
      console.log(
        "Promote with:\n" +
          "  node scripts/review-treasury-readings.ts promote <netuid> <source_url> " +
          `<${PROMOTABLE_STATES.join("|")}>`,
      );
      return;
    }

    const { rows } = await client.query<{
      netuid: number;
      review_state: string;
    }>(PROMOTE_SQL, [
      parsed.command.netuid,
      parsed.command.sourceUrl,
      parsed.command.state,
      Date.now(),
    ]);
    if (rows.length === 0) {
      // NAMED, not silent. A promote that matched nothing usually means the
      // source_url was copied with a trailing character, and reporting success
      // would leave a candidate unreviewed while the operator believed
      // otherwise.
      console.error(
        `no reading matched netuid ${parsed.command.netuid} at ${parsed.command.sourceUrl}`,
      );
      process.exit(1);
    }
    console.log(
      `netuid ${rows[0]!.netuid} -> ${rows[0]!.review_state}` +
        (parsed.command.state === "reviewed"
          ? " (its finding is now published on /subnets/{netuid}/treasury)"
          : ""),
    );
  } finally {
    await client.end();
  }
}

// Only when run directly, so the pure helpers stay importable by tests.
if (process.argv[1]?.endsWith("review-treasury-readings.ts")) {
  main().catch((error: unknown) => {
    console.error(String(error));
    process.exit(1);
  });
}
