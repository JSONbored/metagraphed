// MCP tool `get_health_history` (types-epic E batch 2, #8065). Mirrors GET
// /api/v1/health/history/{date}, which is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// shallow, from the hand-written literal it replaces
// (src/health-history-mcp.ts).
// Enum values hardcoded from src/contracts.ts's QUERY_ENUMS.{surfaceKind,
// healthStatus,healthClassification} and
// API_QUERY_COLLECTIONS["health-surfaces"]
// .sort_fields at the time of writing (mirrors the pilot batch's
// ECONOMICS_SORT_FIELDS precedent -- not cross-imported).
import { z } from "zod";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  fieldsSchema,
  kindSchema,
  limitSchema,
  numericCursorSchema,
  orderSchema,
  providerSlugSchema,
  sortSchema,
} from "./shared.ts";
import { SURFACE_KIND_VALUES } from "../routes/subnet-detail.ts";
import { HEALTH_STATUS_VALUES } from "../shared.ts";
import {
  HealthHistorySummarySchema,
  HealthHistorySurfaceSchema,
} from "../routes/health-surfaces.ts";
import { HEALTH_CLASSIFICATION_VALUES } from "./shared.ts";

const SURFACE_KIND = SURFACE_KIND_VALUES;
const HEALTH_STATUS = HEALTH_STATUS_VALUES;
export const GetHealthHistoryInputSchema = z
  .object({
    // `format` as an ANNOTATION, keeping the existing pattern as the enforced
    // part (#9659). Not `z.iso.date()`: that emits a full calendar-validity
    // pattern which rejects 2026-02-30, while the handler's own gate is
    // DAY_PATTERN -- the shape only. Publishing the stricter pattern would make
    // a generated client refuse input this server accepts, the same defect as
    // declaring a page-size ceiling a route does not enforce.
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("A single UTC day, `YYYY-MM-DD`.")
      .meta({ format: "date", examples: ["2026-08-05"] }),
    netuid:
      API_QUERY_COLLECTIONS["health-surfaces"].filter_schemas.netuid.optional(),
    kind: kindSchema(SURFACE_KIND).optional(),
    provider: providerSlugSchema().optional(),
    status: API_QUERY_COLLECTIONS["health-surfaces"].filter_schemas.status
      .optional()
      .describe("Restrict to rows with this health status.")
      .meta({ examples: [HEALTH_STATUS[0]] }),
    classification: API_QUERY_COLLECTIONS[
      "health-surfaces"
    ].filter_schemas.classification
      .optional()
      .describe(
        "Why a probe ended as it did — the reason behind the status, not the status itself.",
      )
      .meta({ examples: [HEALTH_CLASSIFICATION_VALUES[0]] }),
    sort: sortSchema(
      API_QUERY_COLLECTIONS["health-surfaces"].sort_fields,
    ).optional(),
    order: orderSchema().optional(),
    fields: fieldsSchema().optional(),
    limit: limitSchema(1000, 20).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type GetHealthHistoryInput = z.infer<typeof GetHealthHistoryInputSchema>;

export const GetHealthHistoryOutputSchema = z
  .object({
    date: z.string().nullable(),
    // Typed from the route's own schemas (#9797). Verified against production
    // 2026-08-07, whole and projected.
    summary: HealthHistorySummarySchema.nullable().optional(),
    // PARTIAL: this tool advertises `fields`, so a caller can project a row
    // down to one column and a strict row schema would break the tool's own
    // contract the moment they do (#9884).
    surfaces: z.array(HealthHistorySurfaceSchema.partial()),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .strict();
export type GetHealthHistoryOutput = z.infer<
  typeof GetHealthHistoryOutputSchema
>;
