// Zod schemas for the seven internal sync-route row shapes (#9564).
//
// WHAT THIS REPLACES, AND WHY. Each route used a `valid*SyncRow(row): boolean`
// predicate driven as `rows.every(...)`, so a batch of up to 50,000 rows was
// rejected with one sentence -- "rows must match the neuron row shape" -- and
// the reason was discarded at the exact point it was known. The producer is the
// poller Container, whose stdout is unreachable, so there is no second place to
// look: the operator sees a 400 with no coordinates and a lane that stopped
// writing. A boolean cannot carry a reason; a schema can.
//
// The rules here are a FAITHFUL translation, not a redesign. Every bound, byte
// cap, allowlist and null rule below is the one the predicate applied. Nothing
// loosens -- tests/sync-row-schemas.test.ts pins each rule against the shape it
// rejected before.
//
// COLUMN ALLOWLISTS ARE DERIVED, NEVER RESTATED. Each route's permitted keys
// come from the same *_INSERT_COLUMNS constant the writer binds, passed in by
// the caller. Enumerating ~20 neuron columns statically here would be a second
// source of truth for the row shape, which is precisely the drift that dropped
// `take` and `validator_trust` from two SELECTs (#9523). A schema that
// disagrees with the writer is worse than no schema.
//
// Kept out of workers/data-api.ts, and pure, for the same reason
// src/chain-detail-sync-payload.ts is: it is testable without a Request, an Env
// or a database.

import { z } from "zod";

type Row = Record<string, unknown>;

/** Same encoder the predicates used: the caps are UTF-8 BYTES, not code units,
 * so a multi-byte identity string cannot slip past a `.length` check. */
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Floor for a plausible epoch-MILLISECOND capture stamp.
 *
 * Carried over verbatim from `validSyncCapturedAt`, including the reason it
 * exists: one row reached production with a seconds-precision `captured_at`
 * (netuid 1, uid 0, block 8,755,038 -- 1785715160 beside an `updated_at` of
 * 1785715160521, the same instant in ms). Read as milliseconds it landed on
 * 1970-01-21, and because these tables upsert under
 * `captured_at <= excluded.captured_at`, a stamp 1,000x too small is
 * permanently "older" than any correct one -- the bad row can never be
 * corrected in place by a later capture.
 *
 * Rejected rather than coerced: a stamp in the wrong unit means the producer
 * is wrong, and silently multiplying by 1000 here would hide that while
 * inventing a capture time. A clean 400 tells the producer; a 1970 row tells
 * nobody -- and now the 400 names the field.
 */
export function capturedAtMs(minCapturedAtMs: number) {
  return z
    .number()
    .int("must be an epoch-millisecond integer")
    .min(
      minCapturedAtMs,
      "must be an epoch-millisecond stamp (a seconds-precision value is a unit error)",
    );
}

/** A non-empty key string within its route's UTF-8 byte cap. */
function keyString(maxBytes: number) {
  return z
    .string()
    .min(1, "must be a non-empty string")
    .refine(
      (v) => utf8Bytes(v) <= maxBytes,
      `must be at most ${maxBytes} UTF-8 bytes`,
    );
}

/** Reject any key the writer will not bind. Derived from the caller's
 * *_INSERT_COLUMNS so the schema cannot disagree with the INSERT. */
function onlyKnownColumns(columns: readonly string[]) {
  const allowed = new Set(columns);
  return (row: Row, ctx: z.RefinementCtx) => {
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "is not a column this route writes",
        });
      }
    }
  };
}

export interface SyncRowSchemaOptions {
  columns: readonly string[];
  minCapturedAtMs: number;
}

/**
 * neurons / neuron_daily.
 *
 * The per-value rules are uniform across the column set rather than per-column,
 * exactly as the predicate had them: every column is a TEXT/INTEGER/NUMERIC/
 * BOOLEAN scalar, so a nested object or array would otherwise surface later as
 * an opaque bind error (a 502) instead of a clean 400 here. bigint/symbol/
 * function are deliberately NOT checked -- JSON.parse, this row's only real
 * source, cannot produce them.
 */
export function neuronSyncRowSchema({
  columns,
  minCapturedAtMs,
  maxNetuid,
  maxUid,
  maxStringBytes,
}: SyncRowSchemaOptions & {
  maxNetuid: number;
  maxUid: number;
  maxStringBytes: number;
}) {
  return z
    .looseObject({
      netuid: z.number().int().min(0).max(maxNetuid),
      uid: z.number().int().min(0).max(maxUid),
      captured_at: capturedAtMs(minCapturedAtMs),
    })
    .superRefine((row, ctx) => {
      onlyKnownColumns(columns)(row as Row, ctx);
      for (const [key, value] of Object.entries(row as Row)) {
        if (typeof value === "string" && utf8Bytes(value) > maxStringBytes) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `must be at most ${maxStringBytes} UTF-8 bytes`,
          });
        }
        if (typeof value === "number" && !Number.isFinite(value)) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "must be finite",
          });
        }
        if (value !== null && typeof value === "object") {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "must be a scalar, not an object or array",
          });
        }
      }
    });
}

/** subnet_hyperparams: every column is numeric-or-null (no strings at all). */
export function subnetHyperparamsSyncRowSchema({
  columns,
  minCapturedAtMs,
  maxNetuid,
}: SyncRowSchemaOptions & { maxNetuid: number }) {
  return z
    .looseObject({
      netuid: z.number().int().min(0).max(maxNetuid),
      captured_at: capturedAtMs(minCapturedAtMs),
    })
    .superRefine((row, ctx) => {
      onlyKnownColumns(columns)(row as Row, ctx);
      for (const [key, value] of Object.entries(row as Row)) {
        if (typeof value === "number" && !Number.isFinite(value)) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "must be finite",
          });
        }
        if (value !== null && typeof value !== "number") {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "must be a number or null",
          });
        }
      }
    });
}

/**
 * account_identity.
 *
 * `captured_at` is only required to be finite here, NOT an epoch-ms integer --
 * the predicate used `Number.isFinite` for this one route alone. Preserved
 * rather than tightened: narrowing it would be a behaviour change to a write
 * path, which belongs in its own issue with its own measurement.
 */
export function accountIdentitySyncRowSchema({
  columns,
  maxStringBytes,
}: {
  columns: readonly string[];
  maxStringBytes: number;
}) {
  return z
    .looseObject({
      account: z.string().min(1, "must be a non-empty string"),
      captured_at: z.number().finite("must be a finite number"),
    })
    .superRefine((row, ctx) => {
      onlyKnownColumns(columns)(row as Row, ctx);
      for (const [key, value] of Object.entries(row as Row)) {
        if (key === "account" || key === "captured_at") continue;
        if (value === null) continue;
        if (typeof value !== "string") {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "must be a string or null",
          });
          continue;
        }
        if (utf8Bytes(value) > maxStringBytes) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `must be at most ${maxStringBytes} UTF-8 bytes`,
          });
        }
      }
    });
}

/** validator_nominator_counts. */
export function nominatorCountSyncRowSchema({
  columns,
  minCapturedAtMs,
  maxKeyBytes,
}: SyncRowSchemaOptions & { maxKeyBytes: number }) {
  return z
    .looseObject({
      hotkey: keyString(maxKeyBytes),
      nominator_count: z.number().int().min(0),
      captured_at: capturedAtMs(minCapturedAtMs),
    })
    .superRefine((row, ctx) => onlyKnownColumns(columns)(row as Row, ctx));
}

/** nominator_positions. share_fraction is a dimensionless 0..1 slice. */
export function nominatorPositionSyncRowSchema({
  columns,
  minCapturedAtMs,
  maxKeyBytes,
  maxNetuid,
}: SyncRowSchemaOptions & { maxKeyBytes: number; maxNetuid: number }) {
  return z
    .looseObject({
      coldkey: keyString(maxKeyBytes),
      hotkey: keyString(maxKeyBytes),
      netuid: z.number().int().min(0).max(maxNetuid),
      share_fraction: z
        .number()
        .finite("must be finite")
        .min(0)
        .max(1, "must be a fraction between 0 and 1"),
      captured_at: capturedAtMs(minCapturedAtMs),
    })
    .superRefine((row, ctx) => onlyKnownColumns(columns)(row as Row, ctx));
}

/** account_balances. Both amounts are non-negative TAO. */
export function accountBalanceSyncRowSchema({
  columns,
  minCapturedAtMs,
  maxKeyBytes,
}: SyncRowSchemaOptions & { maxKeyBytes: number }) {
  return z
    .looseObject({
      ss58: keyString(maxKeyBytes),
      free_tao: z.number().finite("must be finite").min(0),
      reserved_tao: z.number().finite("must be finite").min(0),
      captured_at: capturedAtMs(minCapturedAtMs),
    })
    .superRefine((row, ctx) => onlyKnownColumns(columns)(row as Row, ctx));
}

/** hotkey_alpha. Composite (hotkey, netuid) identity; no netuid ceiling here,
 * matching the predicate. */
export function hotkeyAlphaSyncRowSchema({
  columns,
  minCapturedAtMs,
  maxKeyBytes,
}: SyncRowSchemaOptions & { maxKeyBytes: number }) {
  return z
    .looseObject({
      hotkey: keyString(maxKeyBytes),
      netuid: z.number().int().min(0),
      total_alpha: z.number().finite("must be finite").min(0),
      captured_at: capturedAtMs(minCapturedAtMs),
    })
    .superRefine((row, ctx) => onlyKnownColumns(columns)(row as Row, ctx));
}

export type SyncRowsResult = { ok: true } | { ok: false; error: string };

/**
 * Validate a whole batch, reporting the FIRST failing row by index and field.
 *
 * First-failure rather than all-failures on purpose: a malformed batch is
 * usually malformed the same way in every row, so listing 50,000 issues would
 * bury the one fact the operator needs. The batch is still rejected whole --
 * that semantic is unchanged, and a half-written snapshot is exactly what these
 * routes exist to make impossible.
 */
export function validateSyncRows(
  rows: unknown[],
  schema: { safeParse(value: unknown): z.ZodSafeParseResult<unknown> },
  shapeLabel: string,
): SyncRowsResult {
  if (!rows.length) {
    return { ok: false, error: `rows must match the ${shapeLabel} row shape` };
  }
  for (const [index, row] of rows.entries()) {
    const parsed = schema.safeParse(row);
    if (parsed.success) continue;
    // A failed parse always carries at least one issue, and zod always sets its
    // message -- so neither is optional-chained here. Guarding them would add
    // branches nothing can reach, and an unreachable branch on a write path is
    // just an untested one wearing a safety costume.
    const issue = parsed.error.issues[0]!;
    // An empty path means the failure is the ROW itself rather than a field --
    // a non-object, or an array where a row was expected.
    const path = issue.path.length ? issue.path.join(".") : "row";
    return { ok: false, error: `row ${index}: ${path} ${issue.message}` };
  }
  return { ok: true };
}
