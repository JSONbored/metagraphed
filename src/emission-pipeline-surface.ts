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
