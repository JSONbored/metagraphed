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
// KNOWN GAP, and it is NOT closed by that deletion: handleSelfHealth
// (workers/request-handlers/entities.ts) grew a NEON tier in #9836 --
// loadSelfHealthNeon, where the prober writes now -- and this chain never got
// it. So REST answers from current readings while `get_self_health` and the
// GraphQL `selfHealth` field fall to the cold rollup, which ends 2026-08-02.
// That is the same divergence as #8633/#8987/#9153, for the same structural
// reason: a resolution chain maintained in parallel with the route's instead
// of shared with it. Closing it is a serving change, not a types change, so it
// is deliberately not folded in here.

import { z } from "zod";
import type { StorageReadResult } from "../workers/storage.ts";
import { loadSelfHealthColdTier } from "./self-health-cold-tier.ts";
import { loadLatestLaneHealth } from "./lane-health.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import { withLaneHealth, type SelfHealth } from "./self-health.ts";
import {
  GetSelfHealthInputSchema,
  GetSelfHealthOutputSchema,
} from "../schemas-src/mcp-tools/meta-artifacts-2.ts";

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
 * The card, from the first tier that can answer. Lane verdicts are attached by the
 * caller, not here, so that this stays a pure mirror of handleSelfHealth's tier chain
 * and the two can be compared line for line.
 */
async function resolveSelfHealthCard(
  ctx: {
    env: Env;
    readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  },
  readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>,
): Promise<unknown> {
  // 1. Lakehouse cold tier — the same one REST falls through to.
  //
  // #9153 gave the REST route this step and did not give it to us, and when
  // METAGRAPH_SELF_HEALTH_SOURCE went to "retired" the DATA_API tier that used to
  // sit above this one stopped answering for both. REST kept serving the preserved
  // 90-day rollup; this loader dropped straight past to the empty card. Measured
  // 2026-08-04, the same minute: GET /api/v1/self-health returned seven days per
  // component, `get_self_health` returned `days: []` and `uptime_90d: null` for all
  // three.
  //
  // That is the THIRD time this module has served an empty card beside a working
  // REST route (#8633 had the tiers in the wrong order, #8987 unwrapped an envelope
  // the producer never sent). The recurring cause is a resolution chain maintained
  // in parallel with the route's instead of shared with it, so the fix that matters
  // is the ordering being identical here to handleSelfHealth's, tier for tier --
  // which it is NOT today, because REST's #9836 Neon tier is still missing from
  // this chain. See the KNOWN GAP note in the module header.
  const cold = await loadSelfHealthColdTier(ctx.env);
  if (cold) return cold;

  // 2. Baked artifact — dev/test/fixture environments, and any future bake.
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, SELF_HEALTH_ARTIFACT);
  if (result?.ok) return result.data;

  const code =
    (result as { code?: string } | undefined)?.code || "artifact_unavailable";

  // 3. An ABSENT artifact is not an error: it is production's normal state,
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
  },
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
    laneHealthStore(
      ctx.env as unknown as Record<string, unknown>,
    ) as unknown as Parameters<typeof loadLatestLaneHealth>[0],
  );
  return withLaneHealth(card as SelfHealth, lanes);
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
  inputSchema: z.toJSONSchema(GetSelfHealthInputSchema, {
    target: "draft-2020-12",
  }),
};

export const GET_SELF_HEALTH_OUTPUT_SCHEMA = z.toJSONSchema(
  GetSelfHealthOutputSchema,
  {
    target: "draft-2020-12",
  },
);
