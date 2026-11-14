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
