// The subnet-hyperparams + account-identity write paths, against D1 (the
// #9157 dual-write pattern applied to the last two Postgres-only sync lanes).
//
// Both lanes were box-Postgres-only; with the box wiped, every poller tick
// fails until they land here instead. The SHAPE deliberately mirrors the
// Postgres side of workers/data-api.ts's handleSubnetHyperparamsSync /
// handleAccountIdentitySync statement for statement: the same upsert keys,
// the same `captured_at <= excluded.captured_at` staleness guard, the same
// batch-covers-all-netuids prune (hyperparams only), and the same append-only
// diff-and-append histories -- the handler computes each store's history diff
// against THAT store's own latest hashes and passes the resulting rows in, so
// this module never reads.
//
// Statement building and the Workers-binding parameter budget (#9173: 100
// bound params per statement on the BINDING, batches sliced at 1,000
// statements) are shared from src/neurons-d1-write.ts, not duplicated -- one
// place owns that arithmetic.
import {
  batchInSlices,
  buildLatestHashGuard,
  chunkStatements,
  type D1Like,
  type D1PreparedStatement,
} from "./neurons-d1-write.ts";
import { SUBNET_HYPERPARAMS_INSERT_COLUMNS } from "./subnet-hyperparams.ts";
import {
  ACCOUNT_IDENTITY_INSERT_COLUMNS,
  IDENTITY_FIELDS,
} from "./account-identity.ts";

type Row = Record<string, unknown>;

/**
 * Columns of `subnet_hyperparams_history` (minus its AUTOINCREMENT id): the
 * netuid/block_number/observed_at keying plus the 33 hyperparameter fields --
 * SUBNET_HYPERPARAMS_INSERT_COLUMNS with netuid (front) and
 * block_number/captured_at (back) stripped, exactly the derivation the
 * Postgres write path uses -- and the diff hash.
 */
export const SUBNET_HYPERPARAMS_HISTORY_COLUMNS = [
  "netuid",
  "block_number",
  "observed_at",
  ...SUBNET_HYPERPARAMS_INSERT_COLUMNS.slice(1, -2),
  "hyperparams_hash",
];

/** Columns of `account_identity_history` (minus its AUTOINCREMENT id). */
export const ACCOUNT_IDENTITY_HISTORY_COLUMNS = [
  "account",
  "observed_at",
  ...IDENTITY_FIELDS,
  "identity_hash",
];

/**
 * The batch-coverage prune: every successful upstream hyperparams fetch
 * covers ALL active subnets, so a netuid absent from the batch is
 * deregistered (see handleSubnetHyperparamsSync's header for why this is a
 * plain NOT IN, unlike neurons-sync's per-netuid captured_at prune).
 *
 * The netuids are interpolated as INTEGER LITERALS, not bound: a full batch
 * is ~129 netuids and the Workers binding allows only 100 bound parameters
 * per statement (#9173), so a bound `NOT IN (?, ...)` would fail exactly at
 * production scale while passing every small test. NOT IN cannot be chunked
 * (each chunk would delete the other chunks' netuids), so literals are the
 * only shape that fits the budget -- guarded by revalidating every value as
 * a non-negative integer here, independent of the handler's own validation.
 */
export function buildHyperparamsPrune(netuids: number[]): string {
  const literals = netuids.map((netuid) => {
    if (!Number.isInteger(netuid) || netuid < 0) {
      throw new Error(
        `refusing to interpolate a non-integer netuid: ${netuid}`,
      );
    }
    return String(netuid);
  });
  return `DELETE FROM subnet_hyperparams WHERE netuid NOT IN (${literals.join(", ")})`;
}

export interface SubnetHyperparamsWrite {
  /** Coerced latest-only rows, SUBNET_HYPERPARAMS_INSERT_COLUMNS shape. */
  rows: Row[];
  /** Every netuid the batch covers -- the prune's keep-list. */
  netuids: number[];
  /** This store's diff result, SUBNET_HYPERPARAMS_HISTORY_COLUMNS shape. */
  historyRows: Row[];
}

/**
 * Write one hyperparams sync batch to D1: upsert the latest-only table,
 * prune netuids the batch no longer covers, append the pre-diffed history
 * rows -- in that order, the Postgres transaction's own order, with the
 * prune never ahead of the upserts it depends on (batchInSlices preserves
 * statement order; see its header for the per-slice atomicity trade).
 */
export async function writeSubnetHyperparamsToD1(
  db: D1Like,
  { rows, netuids, historyRows }: SubnetHyperparamsWrite,
): Promise<{ statements: number }> {
  const statements: D1PreparedStatement[] = chunkStatements(
    db,
    "subnet_hyperparams",
    SUBNET_HYPERPARAMS_INSERT_COLUMNS,
    ["netuid"],
    rows,
  );
  if (netuids.length) {
    statements.push(db.prepare(buildHyperparamsPrune(netuids)).bind());
  }
  statements.push(
    // Guarded against the committed latest hash, not just against the JS diff
    // above -- see buildLatestHashGuard (metagraphed-infra#358).
    ...chunkStatements(
      db,
      "subnet_hyperparams_history",
      SUBNET_HYPERPARAMS_HISTORY_COLUMNS,
      [],
      historyRows,
      buildLatestHashGuard(
        "subnet_hyperparams_history",
        SUBNET_HYPERPARAMS_HISTORY_COLUMNS,
        "netuid",
        "hyperparams_hash",
      ),
    ),
  );
  if (statements.length) await batchInSlices(db, statements);
  return { statements: statements.length };
}

export interface AccountIdentityWrite {
  /** Sanitized+coerced latest-only rows, ACCOUNT_IDENTITY_INSERT_COLUMNS shape. */
  rows: Row[];
  /** This store's diff result, ACCOUNT_IDENTITY_HISTORY_COLUMNS shape. */
  historyRows: Row[];
}

/**
 * Write one account-identity sync batch to D1: upsert the latest-only table,
 * append the pre-diffed history rows. NO prune, deliberately -- an identity
 * is a property of the owning account, not of currently having an active
 * neuron, matching the Postgres write path.
 */
export async function writeAccountIdentityToD1(
  db: D1Like,
  { rows, historyRows }: AccountIdentityWrite,
): Promise<{ statements: number }> {
  const statements: D1PreparedStatement[] = [
    ...chunkStatements(
      db,
      "account_identity",
      ACCOUNT_IDENTITY_INSERT_COLUMNS,
      ["account"],
      rows,
    ),
    // As above (metagraphed-infra#358). This lane needs it MORE: it has no
    // block_number, so there is no column set a unique constraint could use.
    ...chunkStatements(
      db,
      "account_identity_history",
      ACCOUNT_IDENTITY_HISTORY_COLUMNS,
      [],
      historyRows,
      buildLatestHashGuard(
        "account_identity_history",
        ACCOUNT_IDENTITY_HISTORY_COLUMNS,
        "account",
        "identity_hash",
      ),
    ),
  ];
  if (statements.length) await batchInSlices(db, statements);
  return { statements: statements.length };
}
