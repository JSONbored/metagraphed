// Self-health loader for MCP + GraphQL parity on GET /api/v1/self-health
// (#8422, fixed #8633). Serves metagraphed's OWN uptime verdict plus each
// component's trailing-90-day daily ratios.
//
// RESOLUTION ORDER, and why it is this way round. This module originally read
// the baked /metagraph/self-health.json artifact FIRST, on the theory that
// self-health belongs to the same meta-artifact family as build/changelog/
// contracts. It does not, and the consequence was that `get_self_health` and
// the GraphQL `selfHealth` field were BOTH dead in production -- returning
// "not_found" while GET /api/v1/self-health happily returned
// verdict: "operational". Two of three surfaces down, silently.
//
// Two things make the artifact the wrong primary:
//
//  1. Nothing has ever written it. It is absent from public/metagraph/ (which
//     does carry contracts.json, openapi.json, api-index.json), and no script
//     or workflow generates it. `artifact_not_found` was not an edge case
//     here; it was the only case.
//  2. It would be wrong even if it existed. Self-health is live probe data
//     that moves every minute, which is exactly why the REST route (#8318)
//     reads the self_health_* Postgres tier and uses the artifact path only as
//     a `meta.artifact_path` LABEL -- never for data. A build-time bake would
//     serve a stale verdict.
//
// So a live tier comes first where one exists, matching REST. The artifact is
// deliberately KEPT as a fallback rather than deleted: it is what dev, test
// and any fixture-backed environment load, and it costs nothing to honour a
// baked file if one ever appears. The schema-stable empty shape is the floor.
//
// #8987 -- AND THAT REORDER DID NOT ACTUALLY FIX IT. The ordering above landed
// in #8633, but the live tier then required an `{ ok, data }` envelope the
// DATA_API binding has never emitted, so the newly-promoted branch returned
// null on every call and both surfaces kept serving the empty shape. The
// paragraphs above described a working fix for over a month while production
// behaved exactly as before it. The lesson worth keeping, for whatever live
// tier lands here next: the test that should have caught it asserted the
// envelope the CODE expected rather than the one the PRODUCER emits.
//
// That DATA_API tier is now gone from this file entirely. It was gated on
// METAGRAPH_SELF_HEALTH_SOURCE === "postgres", a var that has read "retired"
// since #9193, and it forwarded to an /api/v1/self-health route that
// workers/data-api.ts does not serve -- so it could not have answered even if
// the flag were flipped back. What remains is the cold tier, the artifact, and
// the empty floor.
//
// #10187 -- AND THE FOURTH REPEAT WAS THE NEON TIER. handleSelfHealth
// (workers/request-handlers/entities.ts) grew one in #9836 --
// loadSelfHealthNeon, where the prober writes now -- and this chain did not
// get it, so REST answered from current readings while `get_self_health` and
// the GraphQL `selfHealth` field fell to the cold rollup ending 2026-08-02.
// Measured live on 2026-08-08, both surfaces the same minute: REST said
// verdict "outage" with 3 measured components (api and publish both down),
// while get_self_health said "degraded", observed_at null, 0 measured. Not
// merely stale -- an agent asking during a real outage was told there was
// nothing to measure, which is the reassuring direction to be wrong in.
//
// So the Neon tier is now FIRST here, exactly as it is in handleSelfHealth
// once that route's own dead DATA_API step is skipped. Four repeats
// (#8633 order, #8987 envelope, #9153 cold tier, #10187 Neon) all have the
// same structural cause: a resolution chain maintained in parallel with the
// route's instead of shared with it. Until the two genuinely share one
// resolver, the tests below pin them tier-for-tier -- that pin is the only
// thing standing between here and a fifth repeat.

import type { StorageReadResult } from "../workers/storage.ts";
import { loadSelfHealthColdTier } from "./self-health-cold-tier.ts";
import { loadSelfHealthNeon } from "./self-health-neon.ts";
import { createPgSql } from "./pg-sql.ts";
import { loadLatestLaneHealth } from "./lane-health.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import { withLaneHealth, type SelfHealth } from "./self-health.ts";
import { loadLaneMaxGap, LANE_ALARM_CADENCE_WINDOW_MS } from "./lane-alarm.ts";
import {
  GetSelfHealthInputSchema,
  GetSelfHealthOutputSchema,
} from "../schemas-src/mcp-tools/meta-artifacts-2.ts";
import { inputJsonSchema, outputJsonSchema } from "./mcp-input-schema.ts";

export const SELF_HEALTH_ARTIFACT = "/metagraph/self-health.json";

export interface SelfHealthToolError extends Error {
  toolError: true;
  code: string;
}

export function selfHealthToolError(
  code: string,
  message: string,
): SelfHealthToolError {
  const error = new Error(message) as SelfHealthToolError;
  error.toolError = true;
  error.code = code;
  return error;
}

/**
 * The ExecutionContext this loader needs to reach Neon, under either of the two
 * names its callers give it.
 *
 * `createPgSql` hands its client back to Hyperdrive's pool through `waitUntil`
 * rather than awaiting it, so a caller without one genuinely cannot read Neon --
 * skipping the tier is correct there, not a degradation to paper over. The two
 * entry points spell the field differently and both are real: the MCP context
 * carries `executionCtx` (workers/api.ts hands the Worker's own ctx to every
 * /mcp request -- it is `props`, not the context, that is OAuth-only), and
 * GqlContext carries `ctx` (#10086, threaded for exactly this purpose).
 * Accepting both beats renaming one and touching every other reader of it.
 */
type SelfHealthExecutionCtx = {
  executionCtx?: { waitUntil?: (promise: Promise<unknown>) => void };
  ctx?: { waitUntil?: (promise: Promise<unknown>) => void };
};

function selfHealthNeonSql(
  ctx: { env: Env } & SelfHealthExecutionCtx,
): ReturnType<typeof createPgSql> | null {
  const waiter = ctx.executionCtx?.waitUntil
    ? ctx.executionCtx
    : ctx.ctx?.waitUntil
      ? ctx.ctx
      : null;
  if (!ctx.env?.HYPERDRIVE || !waiter) return null;
  return createPgSql(ctx.env.HYPERDRIVE, waiter as never);
}

/**
 * The card, from the first tier that can answer. Lane verdicts are attached by the
 * caller, not here, so that this stays a pure mirror of handleSelfHealth's tier chain
 * and the two can be compared line for line.
 */
async function resolveSelfHealthCard(
  ctx: {
    env: Env;
    readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  } & SelfHealthExecutionCtx,
  readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>,
): Promise<unknown> {
  // 1. Neon — where the self-health prober writes now (#9836), and the only
  //    tier that can answer "are we up RIGHT NOW". Asked first for the same
  //    reason handleSelfHealth asks it first: the cold tier below can only
  //    ever report current_ok:null, so letting it answer while Neon has a
  //    live reading is what produced #10187's "outage on REST, nothing
  //    measurable on MCP" split.
  const live = await loadSelfHealthNeon(selfHealthNeonSql(ctx));
  if (live) return live;

  // 2. Lakehouse cold tier — the same one REST falls through to.
  //
  // #9153 gave the REST route this step and did not give it to us, and when
  // METAGRAPH_SELF_HEALTH_SOURCE went to "retired" the DATA_API tier that used to
  // sit above this one stopped answering for both. REST kept serving the preserved
  // 90-day rollup; this loader dropped straight past to the empty card. Measured
  // 2026-08-04, the same minute: GET /api/v1/self-health returned seven days per
  // component, `get_self_health` returned `days: []` and `uptime_90d: null` for all
  // three.
  //
  // Kept below Neon rather than removed: those 90 days are real history nothing
  // else holds, and a deployment with no Hyperdrive binding still gets them.
  const cold = await loadSelfHealthColdTier(ctx.env);
  if (cold) return cold;

  // 3. Baked artifact — dev/test/fixture environments, and any future bake.
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, SELF_HEALTH_ARTIFACT);
  if (result?.ok) return result.data;

  const code =
    (result as { code?: string } | undefined)?.code || "artifact_unavailable";

  // 4. An ABSENT artifact is not an error: it is production's normal state,
  //    and "we have no readings" is a real answer. Returning the schema-stable
  //    empty shape (three components, current_ok null, verdict "degraded") is
  //    precisely handleSelfHealth's own documented convention -- it never 404s
  //    on a cold store either. A genuinely broken read still raises, because
  //    absence and failure are different things.
  if (code === "artifact_not_found") {
    const { buildSelfHealth } = await import("./self-health.ts");
    return buildSelfHealth([], []);
  }
  throw selfHealthToolError(
    code,
    `Could not load ${SELF_HEALTH_ARTIFACT} (${code}).`,
  );
}

export async function loadSelfHealth(
  ctx: {
    env: Env;
    readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  } & SelfHealthExecutionCtx,
  {
    readArtifact,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  } = {},
): Promise<unknown> {
  const card = await resolveSelfHealthCard(ctx, readArtifact);
  // #9330/#9340: the lane verdicts, attached the same way handleSelfHealth attaches
  // them -- from D1, on top of whichever tier answered -- so an agent asking
  // `get_self_health` sees the same lanes the REST card reports rather than a subset
  // that depends on which tier happened to be reachable.
  //
  // The cast is safe by construction and no wider than what the tiers already
  // guarantee: the cold tier and the empty floor are both buildSelfHealth output,
  // the artifact is schema-checked on read, and withLaneHealth only spreads the
  // value and appends two fields.
  const lanes = await loadLatestLaneHealth(
    // laneHealthStore, not the binding (#10148). Every other lane_health
    // reader already goes through it; this one still named D1, so self-health
    // would have reported an empty lane floor -- which renders as "no alarms"
    // -- the moment D1 went away.
    laneHealthStore(ctx.env),
  );
  // Same sample the REST twin takes (#10232/#10333), so both surfaces judge a
  // silent lane identically rather than one of them serving a dead verdict.
  const cadences = await loadLaneMaxGap(
    laneHealthStore(ctx.env),
    Date.now() - LANE_ALARM_CADENCE_WINDOW_MS,
  );
  return withLaneHealth(card as SelfHealth, lanes, { cadences });
}

export const GET_SELF_HEALTH_INSTRUCTIONS =
  "Use get_self_health to fetch metagraphed's own uptime verdict (api/site/" +
  "publish component health with trailing-90-day daily ratios; mirrors " +
  "GET /api/v1/self-health), ";

export const GET_SELF_HEALTH_MCP_TOOL = {
  name: "get_self_health",
  title: "Get self-health verdict",
  description:
    "Fetch metagraphed's OWN uptime verdict: the api/site/publish component " +
    "views with their latest probe state and trailing-90-day daily uptime " +
    "ratios, plus the rolled-up operational/degraded/outage verdict. Scoped " +
    "strictly to our own surfaces -- never third-party subnet health (that is " +
    "get_health). Mirrors GET /api/v1/self-health.",
  inputSchema: inputJsonSchema(GetSelfHealthInputSchema),
};

export const GET_SELF_HEALTH_OUTPUT_SCHEMA = outputJsonSchema(
  GetSelfHealthOutputSchema,
);
