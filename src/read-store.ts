// Which store a READ should go to, for callers that have no ExecutionContext.
//
// ## Why this exists when createPgSql already does
//
// createPgSql hands its connection back through `ctx.waitUntil(client.end())`,
// so every caller needs an ExecutionContext. That is fine on a route handler
// and impossible on the tier readers: chain-detail-hot-tier, blocks-cold-tier,
// nominator-positions-hot-tier and the rest are `(env, ...)` functions called
// from resolvers, MCP handlers and other loaders, several layers below anything
// holding a ctx. Threading one through all of them, and through every caller of
// every one of them, is a far larger and riskier change than the reads deserve.
//
// So this takes lane-health-store's approach instead, for the same reason and
// with the same trade: each operation opens, runs and closes its own
// connection, awaiting the teardown rather than deferring it. Hyperdrive pools,
// so `connect()` is against the pool rather than a fresh TCP handshake -- which
// is what makes per-operation connections affordable here and would not be
// against a bare Postgres.
//
// ## Why the shape is `prepare().bind().all()`
//
// Every call site already spoke that shape when D1 held these tables. Keeping
// it meant the swap was the binding expression and nothing else -- no query
// rewriting, no signature changes, no behaviour to re-verify at ~60 sites
// across the tier readers. `?` placeholders are rewritten to `$n` on the way
// through, which was the only dialect difference these queries had: they are
// plain SELECTs with no SQLite-specific functions.
//
// ## All-or-nothing, deliberately
//
// A reader is handed EVERY table its statements name, and Neon has to be
// declared the owner of all of them or nothing is returned. A reader split
// across stores would run a JOIN against a store missing one side, and that
// failure is an empty result set rather than an error -- a schema-stable wrong
// answer, which is the failure mode this whole migration keeps having to
// design against.
import { Client } from "pg";
import { toPositionalPlaceholders } from "./pg-sql.ts";

/** The minimal pg client this needs, so a test can hand it a fake. */
export interface ReadStoreClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows?: unknown[]; rowCount?: number } | undefined>;
}

/** A row with no claimed shape.
 *
 * The DEFAULT for `all`/`first`, rather than `unknown`, because that is what
 * the store's own typing gave these call sites: several read a named column straight
 * off an untyped `first()`, and `unknown` would break them for no benefit --
 * neither store validates the shape, so the default is about what the caller is
 * allowed to write, not about safety. */
type Row = Record<string, unknown>;

/** The read store's surface, with OUR verbs (#10909) -- rows directly, no
 * D1 envelope. `query`/`first` are generic for the same reason the emulated
 * `all`/`first` were: the ~45 call sites read named columns off the result,
 * and a non-generic `unknown[]` would compile only after adding a cast at
 * every one of them. Loaders shared with the producer store (tao-usd,
 * pipeline-history, chain-concentration-history) consume the same verbs, so
 * one loader serves both providers with no adapter shape between them. */
/**
 * A `COUNT()`/`SUM()` result as a number, or 0.
 *
 * Lives here because the reason it exists is the DRIVER's: Postgres returns
 * COUNT as BIGINT, and node-postgres hands a bigint back as a STRING whenever
 * the value is not exactly representable (see src/pg-sql.ts's parser). So a
 * coverage row's counts are honestly `string | number | null`, and every reader
 * needs the same coercion.
 *
 * It was copy-pasted into five staleness watchdogs as `countOrZero` and into
 * src/lane-alarm.ts as `toInt` -- six identical bodies under two names, which is
 * how a coercion quietly diverges.
 *
 * Zero rather than NaN or a throw: every caller is a coverage rule, and a count
 * it cannot read must be treated as "covered nothing" so the rule alerts. NaN
 * compares false against a floor and would report healthy -- see
 * "an uncountable coverage number reads as ZERO, never as covered".
 */
export function countOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A BIGINT column as a number, preserving null.
 *
 * The sibling of `countOrZero` and for the same driver reason, but a stamp is
 * not a count: an unreadable timestamp must stay NULL, because 0 is a real
 * instant (1970) and would make a dead lane read as merely very stale rather
 * than as never having reported.
 *
 * Epoch-ms values are exactly representable, so today the driver hands these
 * back as numbers and this is a no-op. It exists because the GENERATED type
 * says `number | string` and a reader that assumes `number` is the #9782 class
 * of bug -- code and column disagreeing about a type, with nothing throwing.
 */
export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * THE MINIMAL CONTRACTS A READER CAN ASK FOR (#11207).
 *
 * Fourteen modules each declared their own `StatementClientLike`, and they were
 * not copies: six distinct shapes shared one name, so every file read as
 * duplication while actually stating a different requirement. The name is what
 * was wrong, not the narrowness -- declaring the structural minimum a call site
 * needs is the right thing to do, because it is what lets a test hand in a
 * double that implements only the half it exercises.
 *
 * So the shapes are named for what they REQUIRE and live in one place. A call
 * site picks the one it means, and the name says which. Replacing them all with
 * `ReadStoreDb` was the alternative and it is a widening: every double
 * implementing only `query` would stop satisfying its own reader.
 *
 * `Partial<>` for the optional variants rather than a hand-written `query?`,
 * so the required and optional forms cannot drift into describing different
 * methods.
 */

/** A store that can read MANY rows. */
export interface RowQuerier {
  query<T = Row>(text: string, values?: unknown[]): Promise<T[]>;
}

/**
 * A store whose rows carry NO claimed shape.
 *
 * The minimum for a reader that only ever reads columns off an untyped row and
 * never names a row type -- the watchdogs, which read `count(*)` and a verdict
 * string out of a `GROUP BY`. `RowQuerier`'s generic `query<T>` is NOT this: a
 * generic signature can only be satisfied by a generic implementation, so a
 * hand-rolled double returning `Record<string, unknown>[]` does not fit it and
 * has to be cast into place, which is the cast this exists to remove.
 *
 * The arrow points one way, as it does for `RowReader`: a `RowQuerier` (and so
 * a `ReadStoreDb`) satisfies this by instantiating `T` at the default, so the
 * real store can be handed to a reader that asks only for this.
 */
export interface UntypedRowQuerier {
  query(text: string, values?: unknown[]): Promise<Row[]>;
}

/** A store that can read ONE row.
 *
 * NON-GENERIC, and returning `unknown` rather than `T | null`, because this is
 * the MINIMUM a caller can require rather than what the real store offers. A
 * generic signature is not satisfied by a double that returns one concrete row
 * type -- `T` could be instantiated with anything -- so widening this to match
 * `ReadStoreDb` would break every fake in the completeness tests, which is the
 * precise failure that made #11207 "looks like cleanup, is a regression". */
export interface RowReader {
  first(text: string, values?: unknown[]): Promise<unknown>;
}

/** ...where the binding may be absent, so the reader degrades rather than throws. */
export type OptionalRowQuerier = Partial<RowQuerier>;
export type OptionalRowReader = Partial<RowReader>;
/** Both capabilities, either of which may be absent. */
export type OptionalRowStore = Partial<RowQuerier & RowReader>;

/** Both capabilities, required -- what `pgReadStore` actually returns.
 *
 * COMPOSED for the `query` half, which is identical, and stating the stronger
 * `first` once: the store really does return `T | null`, and ~45 call sites
 * read named columns off it. That is assignable to `RowReader`'s `unknown`, so
 * a `ReadStoreDb` still satisfies every minimal contract above -- the arrow
 * only points one way, which is what makes the minimal ones safe to require. */
export type ReadStoreDb = RowQuerier & {
  first<T = Row>(text: string, values?: unknown[]): Promise<T | null>;
};

/**
 * FOUR NAMINGS OF "COERCE TO A NUMBER OR NULL", SIDE BY SIDE (#11207).
 *
 * `toInt` was copy-pasted into six modules under one name with THREE different
 * bodies, and `numberOrNull` above is a fourth rule again. Consolidating them
 * under one implementation would silently change behaviour in whichever domain
 * lost its variant -- a negative block number becoming valid, a blank string
 * becoming zero -- which is the "looks like cleanup, is a regression" trap.
 *
 * So they keep their semantics and gain names that state them, and they live
 * together so the differences are readable rather than three files apart:
 *
 *   helper                 accepts          rejects              blank string
 *   --------------------   --------------   ------------------   ------------
 *   nonNegativeIntOrNull   0, 7, "7"        -1, 1.5, " 7 "       null
 *   safeIntOrNull          -1, 7, " 7 "     1.5, 2^53, "abc"     0
 *   integerOrNull          -1, 7, 1e300     1.5, "abc"           null
 *   numberOrNull           -1, 1.5, 1e300   "abc"                0
 *
 * Picking one is a judgement about what the READER needs, not about which is
 * strictest. A block number is non-negative and arrives as a digit string, so
 * `nonNegativeIntOrNull` refusing " 7 " is the point. A prune's row count is
 * signed and comes off the driver already trimmed, so `safeIntOrNull` coercing
 * it is the point.
 */

/**
 * A non-negative integer, or null -- with a STRING accepted only in its exact
 * digit form.
 *
 * The strictness is about where these values come from: block heights, indexes
 * and counts arriving as query parameters or JSON, where " 7 " or "7abc" means
 * a caller sent something malformed rather than a number that needs trimming.
 */
export function nonNegativeIntOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

/**
 * A safe integer, or null. Signed, and coercive the way `Number` is.
 *
 * For values off the DRIVER rather than off the wire: a delta, a row count, a
 * BIGINT the driver may have handed back as a string. Negatives are legitimate
 * and `Number("")` is 0, which is left alone because no caller here can receive
 * a blank -- see `integerOrNull` for the one that can.
 */
export function safeIntOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * An integer of any magnitude, or null, with a blank string treated as absent.
 *
 * The chain-event reader's rule. Its inputs are decoded call arguments, where a
 * field present-but-empty means "not supplied" -- `Number("")` is 0, and a zero
 * netuid is a real subnet, so the blank has to be caught before the coercion.
 * `isInteger` rather than `isSafeInteger` is deliberate here and NOT copied
 * elsewhere: these values have already been through JSON, so one beyond 2^53
 * has lost precision upstream and rejecting it would not recover it.
 */
export function integerOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * Narrow an untrusted value to a JSON object, or null.
 *
 * THE COMPANION TO THE COERCIONS ABOVE, for the shape rather than the scalar.
 * `readHealthKv` returns `Promise<unknown>` because `KV.get(key, {type:"json"})`
 * genuinely is arbitrary JSON, and `readArtifact` returns `StorageReadResult`
 * whose `.data` is `unknown` for the same reason -- an R2 object is whatever
 * was last written to it. Both are honest. What was NOT honest is that several
 * consumers DECLARED those producers as returning
 * `Promise<Record<string, unknown> | null>` and then read fields off the
 * result: a claim about untrusted bytes that nothing verified, and that
 * survived only because a cast sat between the two (metagraphed#11339).
 *
 * `null` and arrays are excluded deliberately. `typeof null === "object"` is
 * the classic hole, and an array reaching a site that then reads named fields
 * is a producer mismatch worth failing on rather than silently indexing.
 */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Narrow an untrusted value to an array of JSON objects, or an empty array.
 *
 * EMPTY, NOT NULL, because every caller is building a list response and an
 * absent collection and an empty one render identically there. A non-array
 * yields empty for the same reason: it is a producer defect, and returning
 * `[]` keeps the "absence is 404 or ok+null entity, never 200-with-zeros"
 * contract in the ROUTE's hands rather than fabricating rows here.
 *
 * Non-object members are dropped rather than passed through, so a caller that
 * reads a field off every element cannot meet a string.
 */
export function recordsOrEmpty(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const entry of value) {
    const row = recordOrNull(entry);
    if (row) rows.push(row);
  }
  return rows;
}

export interface ReadStoreDeps {
  clientFactory?: (connectionString: string) => ReadStoreClient;
}

/** The read handle over Postgres, one connection per operation. */
export function pgReadStore(
  connectionString: string,
  deps: ReadStoreDeps = {},
): ReadStoreDb {
  const run = async (text: string, values: unknown[]) => {
    const client =
      deps.clientFactory?.(connectionString) ??
      (new Client({ connectionString }) as unknown as ReadStoreClient);
    await client.connect();
    try {
      const result = await client.query(toPositionalPlaceholders(text), values);
      // ALWAYS an array. `rows` is the driver's, and a driver that answers
      // something else (a mock, a future client) would otherwise put a
      // `.length` TypeError inside every caller's decline path -- the guard
      // each of them used to carry, now stated once (#10909).
      const rows = result?.rows;
      return (Array.isArray(rows) ? rows : []) as unknown[];
    } finally {
      // Awaited, unlike createPgSql's waitUntil -- see this module's header.
      await client.end().catch(() => undefined);
    }
  };
  // The generic parameter is the CALLER's claim about the row shape: Postgres
  // hands back whatever the query selected and nothing validates it. Cast
  // here rather than at 45 call sites.
  return {
    async query<T = Row>(text: string, values: unknown[] = []) {
      return (await run(text, values)) as T[];
    },
    async first<T = Row>(text: string, values: unknown[] = []) {
      return ((await run(text, values))[0] ?? null) as T | null;
    },
  };
}

/**
 * The store to read `tables` from: Neon, once it is declared to solely own
 * every one of them and Hyperdrive is bound.
 *
 * `injected` wins outright so a test can hand in its own fake, and `undefined`
 * comes back when no store is available -- which every caller already handles,
 * because an unbound store has always been possible.
 */
/**
 * The one binding `readStore` looks for.
 *
 * `readStore` itself keeps taking `unknown` -- see its own note -- because its
 * callers hand in an `Env`, a bag, or nothing. This names the same shape for
 * COMPOSERS, which forward one env to both legs (the Neon store and the
 * lakehouse) and therefore need a type that admits either (#11339).
 */
export interface StoreEnv {
  HYPERDRIVE?: { connectionString?: string };
}

/**
 * The Hyperdrive connection string an env carries, or null.
 *
 * ONE NARROWING, SHARED. `readStore`, `laneHealthStore` and
 * `neonOwnsObservations` each did this by hand with two casts apiece
 * (`env as Record<string, unknown>`, then `?.HYPERDRIVE as HyperdriveLike`),
 * which is the whole binding-detection rule copy-pasted three times -- and it
 * is the rule that decides whether a lane writes to Neon or silently declines.
 *
 * Takes `unknown` for the reason `readStore` documents: callers hand in an
 * `Env`, a bag, or nothing. `Record<string, unknown>` READS as loose but is
 * not -- `Env` is an interface, and TypeScript never gives interfaces implicit
 * index signatures, so every caller holding a real `Env` had to write
 * `env` to get past it. That is 65 casts
 * across this repo whose only cause was a parameter type trying to be lenient
 * and landing one step too strict (#11339).
 */
export function hyperdriveConnectionString(env: unknown): string | null {
  const hyperdrive = recordOrNull(recordOrNull(env)?.HYPERDRIVE);
  const connectionString = hyperdrive?.connectionString;
  return typeof connectionString === "string" && connectionString
    ? connectionString
    : null;
}

export function readStore(
  // Deliberately loose: callers hand in an `Env`, a bag, or `unknown`, and a
  // narrower type would push a cast to every one of them.
  env: unknown,
  tables: readonly string[],
  injected?: ReadStoreDb | null,
  deps: ReadStoreDeps = {},
): ReadStoreDb | undefined {
  if (injected) return injected;
  const connectionString = hyperdriveConnectionString(env);
  if (!connectionString) return undefined;
  // Empty `tables` must never read as "Neon owns them all" -- that would send a
  // caller who forgot to declare its tables to Postgres unconditionally.
  if (tables.length === 0) return undefined;
  // the ownership check collapsed with the flag (#10051): Neon is the only store, so the question answered itself.
  return pgReadStore(connectionString, deps);
}
