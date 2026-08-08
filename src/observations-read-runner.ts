// Which store answers an observation READ (#10086).
//
// ## Why an adapter rather than a second set of loaders
//
// Every observation read already funnels through ONE call shape --
// `d1All(db, sql, params)` over the structural `ObservationsReadDb`
// (`prepare(sql).bind(...).all()`). So the whole read path moves by handing
// those loaders a different `db`, and not one query has to be written twice.
//
// That is only safe because the SQL is genuinely portable now. It was not
// until #10086: `surface_checks.ok` is INTEGER in D1 and BOOLEAN in Neon, and
// six spellings compared it to a number. An adapter alone would have moved the
// reads onto a store that rejects them.
//
// `createPgSql().unsafe` already rewrites `?` -> `$n` (#9821), so the statement
// text carries over verbatim -- which is the point: a difference between the
// two stores cannot come from asking them different questions.
//
// ## Why the whole family or none
//
// `neonOwnsObservations` requires all five tables together, and this follows
// it rather than deciding per table. Two of the writes are
// `INSERT ... SELECT FROM surface_checks` -- they aggregate INSIDE the store --
// so a split family would have a rollup reading one store and its source rows
// living in the other, and the rollup would quietly aggregate nothing.
//
// ## Reading is not writing
//
// A read against the wrong store returns stale or empty rows; `d1All` already
// degrades any read failure to zero rows and bumps the fallback generation so
// the payload is not edge-cached as fresh. So this selector is allowed to fall
// back to D1 silently, which is NOT true of the write path in
// src/observations-neon.ts -- a probe not stored is gone.
import type { ObservationsReadDb } from "./analytics-live.ts";
import { neonOwnsObservations } from "./observations-neon.ts";
import { neonOwnsTable } from "./neon-write.ts";
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";

/** The minimal Postgres runner this needs, so a test can hand it a fake. */
export interface ReadRunnerSql {
  unsafe(text: string, values?: unknown[]): Promise<unknown>;
}

/**
 * Present a Postgres runner as the D1 read surface the loaders expect.
 *
 * `d1All` accepts either a bare array or `{ results }`, and `unsafe` resolves
 * to the array, so no row-shape translation is needed on the way back either.
 */
export function pgObservationsReadDb(sql: ReadRunnerSql): ObservationsReadDb {
  return {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          return {
            all: () => sql.unsafe(text, values),
          };
        },
        // BOTH SHAPES, because D1 has both and this codebase uses both.
        // src/top-holders-holdings.ts calls `prepare(sql).all?.()` with no
        // bind at all -- its statement carries no parameters -- and an adapter
        // offering only the bind path would throw there rather than fall back,
        // turning a store swap into a route outage.
        all: () => sql.unsafe(text, []),
      };
    },
  };
}

export interface ObservationsReadDeps {
  /** Injected runner, for tests. */
  sql?: ReadRunnerSql | null;
}

/**
 * The store that should answer observation reads.
 *
 * Neon once it owns the family and Hyperdrive is bound and there is a `ctx` to
 * park the connection teardown on; the D1 binding otherwise. Returns whatever
 * `METAGRAPH_HEALTH_DB` is when Neon is not eligible -- including `undefined`,
 * which `d1All` already treats as zero rows.
 */
export function observationsReadDb(
  env: Record<string, unknown> | null | undefined,
  // Optional-`waitUntil` on purpose: the serving handlers pass an EdgeCacheCtx,
  // whose waitUntil is itself optional, and a ctx that cannot defer work is not
  // a ctx for this purpose -- see the guard below.
  ctx?: Partial<WaitUntilLike> | null,
  deps: ObservationsReadDeps = {},
): ObservationsReadDb | undefined {
  const d1 = env?.METAGRAPH_HEALTH_DB as ObservationsReadDb | undefined;
  if (!neonOwnsObservations(env, neonOwnsTable)) return d1;
  const injected = deps.sql;
  if (injected) return pgObservationsReadDb(injected);
  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  // neonOwnsObservations already proved the connection string is there; the
  // ctx is the part it cannot see. createPgSql returns its connection via
  // waitUntil, so an absent one leaks a connection per request rather than
  // releasing it -- and a leak on a serving path is worse than a stale read.
  // `{}` reaches here from every handler defaulting `ctx: EdgeCacheCtx = {}`,
  // which is why this tests the METHOD and not just the object.
  if (typeof ctx?.waitUntil !== "function") return d1;
  return pgObservationsReadDb(createPgSql(hyperdrive!, ctx as WaitUntilLike));
}
