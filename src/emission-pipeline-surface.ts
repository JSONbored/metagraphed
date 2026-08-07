// The emission-pipeline surface, shared by REST, GraphQL, and MCP (#8744).
//
// src/emission-decomposition.ts owns the arithmetic; this module owns the two
// things all three surfaces must do IDENTICALLY around it — resolve the
// economics tier the same way, and project the decomposition the same way —
// so tri-surface parity is a property of the code rather than of three
// hand-kept copies. Each surface keeps only its own error idiom (a 503, a
// GraphQLError, a tool error), because that is the one part that genuinely
// differs between a REST response, a GraphQL field, and an MCP tool result.
//
// Deliberately a projection, not a second implementation: nothing here
// recomputes a share, a tolerance, or an identity check.
import {
  buildEmissionDecomposition,
  EMISSION_FIELD_SOURCES,
  type DecompositionChainState,
  type EconomicsPipelineRow,
  type EmissionDecomposition,
} from "./emission-decomposition.ts";
import { resolveLiveEconomics } from "./health-serving.ts";
import {
  parseFieldsParam,
  projectRows,
  unknownAgainstRows,
  type Row,
} from "./field-projection.ts";

/**
 * The per-subnet columns this surface can rank by (#9720).
 *
 * `final_share` leads deliberately. #9707 established that it, not
 * `emission_share`, is the number that answers "where is the emission" --
 * `emission_share` is the v440 STAGE-1 PRICE SHARE, and 52 subnets carry a
 * positive one while receiving nothing. A ranking that offered only the
 * stage-1 share would reproduce, on a new parameter, the exact defect that
 * issue fixed on the leaderboard.
 */
export const EMISSION_PIPELINE_SORT_FIELDS = [
  "final_share",
  "emission_share",
  "weighted_share",
  "gated_share",
  "gate_delta",
  "distance_to_bar",
  "tao_in_emission",
  "excess_tao",
  "tao_total",
  "liquidity_fraction",
  "miner_burned",
  "netuid",
] as const;
export type EmissionPipelineSortField =
  (typeof EMISSION_PIPELINE_SORT_FIELDS)[number];

export interface EmissionPipelineNarrowing {
  sort?: EmissionPipelineSortField | null;
  order?: "asc" | "desc" | null;
  limit?: number | null;
  /** Already-parsed field names, or null for the full row. */
  fields?: string[] | null;
}

/**
 * Parse `?sort/order/limit/fields` for this surface.
 *
 * One parser for all three surfaces, same reason the projection is shared: the
 * REST route, the GraphQL field and the MCP tool must not disagree about which
 * values are legal. `fields` is validated against the ROWS rather than a fixed
 * list, reusing the shared projection helper, so a column added to the
 * decomposition is projectable the day it appears.
 */
export function parseEmissionPipelineNarrowing(
  params: URLSearchParams,
  rows: Row[],
  { limitMax }: { limitMax: number },
):
  | EmissionPipelineNarrowing
  | { error: { parameter: string; message: string } } {
  const sort = params.get("sort");
  if (
    sort != null &&
    !EMISSION_PIPELINE_SORT_FIELDS.includes(sort as EmissionPipelineSortField)
  ) {
    return {
      error: {
        parameter: "sort",
        message: `"${sort}" is not a supported sort. Supported: ${EMISSION_PIPELINE_SORT_FIELDS.join(", ")}.`,
      },
    };
  }
  const order = params.get("order");
  if (order != null && order !== "asc" && order !== "desc") {
    return {
      error: {
        parameter: "order",
        message: `"${order}" is not a supported order. Supported: asc, desc.`,
      },
    };
  }
  const rawLimit = params.get("limit");
  let limit: number | null = null;
  if (rawLimit != null && rawLimit !== "") {
    const parsed = Number(rawLimit);
    // Rejected rather than clamped: a caller who asked for 5000 and silently
    // received 129 has a truncated list they believe is complete.
    if (
      !/^\d+$/.test(rawLimit.trim()) ||
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > limitMax
    ) {
      return {
        error: {
          parameter: "limit",
          message: `limit must be an integer between 1 and ${limitMax}.`,
        },
      };
    }
    limit = parsed;
  }
  const fields = parseFieldsParam(
    params,
    unknownAgainstRows(rows),
    "emission pipeline subnets",
  );
  if (fields.error) return { error: fields.error };
  return {
    sort: sort as EmissionPipelineSortField | null,
    order,
    limit,
    fields: fields.fields,
  };
}

/**
 * Why a capture with no `chain_state` is served as an error rather than as a
 * body. Every share in the decomposition is reconstructed from inputs pinned
 * to one block; without knowing which block, none of it can be checked, and
 * ADR 0023 decision 5 makes provenance a contract rather than a nice-to-have.
 *
 * Shared verbatim so the three surfaces say the same thing — a consumer that
 * hits this through MCP and then through REST should not get two different
 * explanations of the same condition.
 */
export const EMISSION_PIPELINE_UNAVAILABLE_MESSAGE =
  "The emission decomposition needs the block its inputs were pinned to, " +
  "and the current economics capture carries none. Every share here is " +
  "reconstructed; without the block it cannot be verified, so nothing " +
  "is served rather than something unverifiable.";

/** The error code REST/MCP report; GraphQL uppercases it for `extensions.code`. */
export const EMISSION_PIPELINE_UNAVAILABLE_CODE =
  "emission_pipeline_unavailable";

/**
 * The decomposition plus its in-band provenance map. ADR 0023 decision 3:
 * reconstructed fields are labelled as reconstructed IN THE CONTRACT, not only
 * in prose a client never reads.
 */
export interface EmissionPipelineSurface extends EmissionDecomposition {
  /**
   * The artifact's own version. This route is COMPUTED_LIVE with no static
   * file, so the body carries its version itself rather than inheriting
   * ArtifactBase's `generated_at` + `schema_version` — the same shape
   * /api/v1/economics/trends and /api/v1/compare take.
   */
  schema_version: 1;
  field_sources: typeof EMISSION_FIELD_SOURCES;
  /** Present only when {@link narrowEmissionPipeline} actually narrowed. */
  matched_subnet_count?: number;
  returned_subnet_count?: number;
}

interface EconomicsBlob {
  chain_state?: DecompositionChainState | null;
  subnets?: unknown;
}

/**
 * The economics blob every surface decomposes: the live KV tier first, the
 * committed R2 artifact as a real fallback so this can never 404.
 *
 * Same precedence and the same `resolveLiveEconomics` gate REST's own
 * /api/v1/economics uses — a blob whose row count or emission_share sum
 * disagrees with its summary silently falls through to R2 rather than being
 * decomposed.
 */
export async function resolveEmissionPipelineEconomics(opts: {
  env: Env;
  readHealthKv?: (env: Env, key: string) => Promise<unknown>;
  contractVersion: unknown;
  readArtifact: () => Promise<unknown>;
}): Promise<unknown> {
  const live = await resolveLiveEconomics({
    readHealthKv: opts.readHealthKv,
    env: opts.env,
    contractVersion: opts.contractVersion,
  });
  if (live?.data) return live.data;
  return await opts.readArtifact();
}

/**
 * Project a resolved economics blob into the served decomposition, optionally
 * narrowed to one subnet.
 *
 * Null — never a partial body — when the capture carries no `chain_state`;
 * the caller turns that into its own surface's error. `netuid` filters the
 * per-subnet rows only: the aggregate and the identity checks stay
 * network-wide, because a one-subnet slice of an identity that holds across
 * the whole distribution is not a thing that can be verified.
 */
export function projectEmissionPipeline(
  economics: unknown,
  netuid: number | null = null,
): EmissionPipelineSurface | null {
  const blob = economics as EconomicsBlob | null | undefined;
  const chainState = blob?.chain_state;
  if (!chainState) return null;

  const rows = (
    Array.isArray(blob.subnets) ? blob.subnets : []
  ) as EconomicsPipelineRow[];
  const decomposition = buildEmissionDecomposition({
    subnets: rows,
    chainState,
  });

  return {
    schema_version: 1,
    ...decomposition,
    subnets:
      netuid === null
        ? decomposition.subnets
        : decomposition.subnets.filter((subnet) => subnet.netuid === netuid),
    field_sources: EMISSION_FIELD_SOURCES,
  };
}

/**
 * Apply `sort`/`order`/`limit`/`fields` to an already-projected surface (#9720).
 *
 * Separate from the projection above, and downstream of it, for two reasons.
 * The `fields` allow-list is derived from the DECOMPOSED rows, so the rows have
 * to exist before the parameter can be validated -- and taking the surface
 * rather than the blob means the caller projects once, never twice, so there is
 * no second null-return to handle that cannot happen.
 *
 * NARROWING THE RESPONSE NEVER NARROWS THE MEASUREMENT. `aggregate` and
 * `verification` arrive already computed over EVERY subnet and are passed
 * through untouched, so a caller asking for ten rows still receives
 * verification covering the whole distribution. An identity evaluated over a
 * ten-row slice is not a thing that can be verified -- the same reason the
 * pre-existing `netuid` filter leaves the aggregate network-wide.
 */
export function narrowEmissionPipeline(
  surface: EmissionPipelineSurface,
  narrowing: EmissionPipelineNarrowing = {},
): EmissionPipelineSurface {
  const matched = surface.subnets.length;
  let subnets = surface.subnets;

  if (narrowing.sort) {
    const key = narrowing.sort;
    // Largest-first by default for every key here: each is a magnitude ("how
    // much of the emission", "how much TAO"), so desc is what the question
    // means in all twelve cases -- unlike the concentration ranking, whose
    // measures point in opposite directions and need per-key defaults.
    const factor = narrowing.order === "asc" ? 1 : -1;
    subnets = [...subnets].sort((a, b) => {
      const left = (a as unknown as Row)[key];
      const right = (b as unknown as Row)[key];
      // A row missing the sort column sinks in EITHER direction rather than
      // riding a null to the top of an ascending list.
      const leftMissing = left == null || !Number.isFinite(Number(left));
      const rightMissing = right == null || !Number.isFinite(Number(right));
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
      if (!leftMissing && Number(left) !== Number(right)) {
        return (Number(left) - Number(right)) * factor;
      }
      return a.netuid - b.netuid;
    });
  }

  const limited =
    narrowing.limit != null ? subnets.slice(0, narrowing.limit) : subnets;
  const narrowed = narrowing.limit != null || narrowing.fields != null;

  return {
    ...surface,
    subnets: projectRows(
      limited as unknown as Row[],
      narrowing.fields,
    ) as unknown as typeof surface.subnets,
    // Published only when the list was actually narrowed, so today's body is
    // byte-for-byte unchanged for every caller who does not narrow it -- and
    // when they do, a 20-row page and a network that really has 20 subnets stop
    // being the same response.
    ...(narrowed
      ? { matched_subnet_count: matched, returned_subnet_count: limited.length }
      : {}),
  };
}
