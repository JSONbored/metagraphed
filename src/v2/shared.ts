import type { V2Freshness } from "../../schemas-src/v2/contracts.ts";

export interface V2QueryExecutor {
  query(sql: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

// PostgreSQL's JSON numbers are arbitrary precision. Refuse unsupported values
// before node-postgres can round them while parsing the JSON response.
export const exactJsonNumbersSql = (column: string) => `NOT EXISTS (
  SELECT 1 FROM jsonb_path_query(${column},'strict $.** ? (@.type() == "number")') decoded_number(value)
  WHERE (decoded_number.value::text)::numeric <> trunc((decoded_number.value::text)::numeric)
    OR abs((decoded_number.value::text)::numeric)>9007199254740991)`;

export class V2OperationError extends Error {
  readonly code:
    | "invalid_input"
    | "not_found"
    | "data_unavailable"
    | "authorization_required";
  constructor(
    code:
      | "invalid_input"
      | "not_found"
      | "data_unavailable"
      | "authorization_required",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

export function v2FinalizedFreshness(
  row: {
    block_number: string;
    block_hash: string;
    observed_at: string;
    finalized_observed_height: string | null;
    finalized_observed_hash: string | null;
    finalized_observed_at: string | null;
  },
  now: Date,
): V2Freshness {
  const age = now.getTime() - Date.parse(row.observed_at);
  if (!Number.isFinite(age) || age < -5000)
    throw new V2OperationError("data_unavailable", "Invalid publication clock");
  const observed = row.finalized_observed_height;
  if (observed === null) {
    if (
      row.finalized_observed_hash !== null ||
      row.finalized_observed_at !== null
    )
      throw new V2OperationError(
        "data_unavailable",
        "Incomplete finalized observation",
      );
    return {
      status: "unknown",
      age_seconds: Math.max(0, age / 1000),
      finalized_lag_blocks: null,
      target_seconds: 30,
      target_blocks: 2,
    };
  }
  if (
    row.finalized_observed_hash === null ||
    row.finalized_observed_at === null ||
    BigInt(observed) < BigInt(row.block_number) ||
    (observed === row.block_number &&
      row.finalized_observed_hash !== row.block_hash)
  )
    throw new V2OperationError(
      "data_unavailable",
      "Invalid finalized observation",
    );
  const observationAge = now.getTime() - Date.parse(row.finalized_observed_at);
  if (!Number.isFinite(observationAge) || observationAge < -5000)
    throw new V2OperationError("data_unavailable", "Invalid observation clock");
  const lag = BigInt(observed) - BigInt(row.block_number);
  return {
    status:
      age <= 30000 && observationAge <= 30000 && lag <= 2n
        ? "current"
        : "stale",
    age_seconds: Math.max(0, age / 1000),
    finalized_lag_blocks: lag.toString(),
    target_seconds: 30,
    target_blocks: 2,
  };
}
