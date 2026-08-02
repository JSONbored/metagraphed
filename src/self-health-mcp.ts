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
// So the live tier comes first, matching REST byte for byte. The artifact is
// deliberately KEPT as a fallback rather than deleted: it is what dev, test
// and any fixture-backed environment load, and it costs nothing to honour a
// baked file if one ever appears. The schema-stable empty shape is the floor.
//
// #8987 -- AND THAT REORDER DID NOT ACTUALLY FIX IT. The ordering above landed
// in #8633, but readSelfHealthTier then required an `{ ok, data }` envelope the
// DATA_API binding has never emitted, so the newly-promoted branch returned
// null on every call and both surfaces kept serving the empty shape. The
// paragraphs above described a working fix for over a month while production
// behaved exactly as before it. See readSelfHealthTier for the detail; the
// lesson worth keeping is that the test which should have caught it asserted
// the envelope the CODE expected rather than the one the PRODUCER emits.

import { z } from "zod";
import type { StorageReadResult } from "../workers/storage.ts";
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
 * The live verdict, from the same place GET /api/v1/self-health gets it.
 *
 * Reached by asking the DATA_API binding for that very route rather than by
 * re-implementing the query: `handleSelfHealth` does
 * `tryPostgresTier(env, request, "METAGRAPH_SELF_HEALTH_SOURCE")`, which
 * forwards the request by PATH, so the honest way to share it is to send the
 * path. One source of truth; no second copy of the aggregation to drift.
 *
 * Returns null rather than throwing on every failure, so the caller can fall
 * through instead of surfacing plumbing to an agent.
 *
 * #8987 -- THE BINDING RETURNS THE DOCUMENT BARE. This previously required an
 * `{ ok, data }` envelope and unwrapped `payload.data`. No such envelope ever
 * arrives here: workers/data-api.ts's `json()` helper serializes the value
 * directly, and the self-health route returns `json(buildSelfHealth(...))`, so
 * `payload.ok` was `undefined` on every call and this function returned null
 * unconditionally. `get_self_health` and the GraphQL `selfHealth` field both
 * served the all-null degraded shape in production for over a month while
 * GET /api/v1/self-health returned `verdict: "operational"` beside them.
 *
 * The `{ ok, data }` envelope is added by the API Worker's response wrapper on
 * the way OUT to the public; it is not what a service binding hands back. The
 * sibling workers/postgres-tier.ts `tryPostgresTier` gets this right and does
 * no `ok` check at all.
 *
 * What replaces it is a SHAPE check, not another envelope guess: a self-health
 * document has a `components` array. That keeps the "don't hand an agent
 * nonsense" property the old check accidentally provided -- an unexpected body
 * still degrades rather than being served -- without inventing a wrapper the
 * producer does not emit. It is also self-correcting in the direction that
 * matters: if the payload shape ever changes, this degrades loudly to the
 * empty verdict rather than silently serving a body no consumer understands.
 */
function isSelfHealthDocument(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { components?: unknown }).components)
  );
}

async function readSelfHealthTier(env: Env): Promise<unknown | null> {
  if (env.METAGRAPH_SELF_HEALTH_SOURCE !== "postgres" || !env.DATA_API) {
    return null;
  }
  try {
    const upstream = await env.DATA_API.fetch(
      new Request("https://api.metagraph.sh/api/v1/self-health", {
        method: "GET",
        headers: { accept: "application/json" },
      }),
    );
    if (!upstream.ok) return null;
    const payload = await upstream.json();
    return isSelfHealthDocument(payload) ? payload : null;
  } catch {
    return null;
  }
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
  // 1. Live tier — what REST serves, so the three surfaces agree.
  const live = await readSelfHealthTier(ctx.env);
  if (live) return live;

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
