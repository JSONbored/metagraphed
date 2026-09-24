import { ACCOUNT_EVENTS_COLUMNS } from "../../generated/lakehouse/types.ts";
import { AccountEventsRowSchema } from "../../schemas-src/lakehouse.ts";

/** A validated physical row, with explicit nullable source cells. */
export function nativeAccountRow(overrides: Record<string, unknown> = {}) {
  return AccountEventsRowSchema.required().parse({
    ...Object.fromEntries(
      ACCOUNT_EVENTS_COLUMNS.map((column) => [column, null]),
    ),
    block_number: 100,
    event_index: 1,
    observed_at: 1_700_000_000_000,
    event_kind: "Transfer",
    ...overrides,
  });
}
