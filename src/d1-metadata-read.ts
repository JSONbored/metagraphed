import { selectedD1Store } from "./d1-store.ts";

/** Undefined means unselected; a selected owner's failure never revives SQL scans. */
export async function readD1Metadata<Row = Record<string, unknown>>(
  env: unknown,
  table: string,
  sql: string,
  values: unknown[] = [],
): Promise<Row[] | null | undefined> {
  try {
    const store = selectedD1Store(env, [table]);
    return store ? await store.query<Row>(sql, values) : undefined;
  } catch {
    return null;
  }
}
