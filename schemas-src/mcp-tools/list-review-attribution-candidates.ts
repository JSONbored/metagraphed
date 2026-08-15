// list_review_attribution_candidates (#11227): the attribution sweep's review
// queue, mirroring GET /api/v1/review/attribution-candidates.
//
// THE BOUNDS ARE THE ROUTE'S OWN, taken off ROUTE_QUERY_SCHEMAS rather than
// restated here. A tool that publishes a looser bound than the route it mirrors
// is the way round the route's limit, and a hand-written copy drifts the first
// time either side moves -- which is what validate:mcp-input-parity and
// validate:tool-route-divergence exist to catch.
import { z } from "zod";
import { AttributionCandidatesReviewArtifactSchema } from "../routes/attribution-candidates-review.ts";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";

const RouteQuery_review_attribution_candidates =
  ROUTE_QUERY_SCHEMAS["/api/v1/review/attribution-candidates"];

export const ListReviewAttributionCandidatesInputSchema = z
  .object({
    netuid: RouteQuery_review_attribution_candidates.shape.netuid,
    limit: RouteQuery_review_attribution_candidates.shape.limit,
    offset: RouteQuery_review_attribution_candidates.shape.offset,
  })
  .strict();
export type ListReviewAttributionCandidatesInput = z.infer<
  typeof ListReviewAttributionCandidatesInputSchema
>;

// THE ROUTE'S OWN SCHEMA, not a restatement of it (#10790).
export const ListReviewAttributionCandidatesOutputSchema =
  AttributionCandidatesReviewArtifactSchema;
