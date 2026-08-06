// MCP tool `get_health_history` (types-epic E batch 2, #8065). Mirrors GET
// /api/v1/health/history/{date}, which is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// shallow, from the hand-written literal it replaces (src/health-history-mcp.ts).
// Enum values hardcoded from src/contracts.ts's QUERY_ENUMS.{surfaceKind,
// healthStatus,healthClassification} and API_QUERY_COLLECTIONS["health-surfaces"]
// .sort_fields at the time of writing (mirrors the pilot batch's
// ECONOMICS_SORT_FIELDS precedent -- not cross-imported).
import { z } from "zod";
import {
  OpenObjectArraySchema,
  OpenObjectSchema,
  fieldsStringSchema,
  kindSchema,
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  providerSlugSchema,
  sortSchema,
} from "./shared.ts";

const SURFACE_KIND = [
  "archive",
  "dashboard",
  "data-artifact",
  "docs",
  "example",
  "openapi",
  "repo-registry",
  "sdk",
  "source-repo",
  "sse",
  "subnet-api",
  "subtensor-rpc",
  "subtensor-wss",
  "website",
] as const;
const HEALTH_STATUS = ["ok", "degraded", "failed", "unknown"] as const;
const HEALTH_CLASSIFICATION = [
  "auth-required",
  "content-mismatch",
  "dead",
  "live",
  "rate-limited",
  "redirected",
  "timeout",
  "transient",
  "unsupported",
  "unsafe",
  "wrong-chain",
] as const;
const HEALTH_SURFACE_SORT_FIELDS = [
  "classification",
  "kind",
  "last_checked",
  "last_ok",
  "latency_ms",
  "netuid",
  "provider",
  "status",
  "status_code",
  "surface_id",
  "verified_at",
] as const;

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
    netuid: netuidSchema().optional(),
    kind: kindSchema(SURFACE_KIND).optional(),
    provider: providerSlugSchema().optional(),
    status: z
      .enum(HEALTH_STATUS)
      .optional()
      .describe("Restrict to rows with this health status.")
      .meta({ examples: [HEALTH_STATUS[0]] }),
    classification: z
      .enum(HEALTH_CLASSIFICATION)
      .optional()
      .describe(
        "Why a probe ended as it did — the reason behind the status, not the status itself.",
      )
      .meta({ examples: [HEALTH_CLASSIFICATION[0]] }),
    sort: sortSchema(HEALTH_SURFACE_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(1000).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type GetHealthHistoryInput = z.infer<typeof GetHealthHistoryInputSchema>;

export const GetHealthHistoryOutputSchema = z
  .object({
    date: z.string().nullable(),
    summary: OpenObjectSchema.nullable().optional(),
    surfaces: OpenObjectArraySchema,
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type GetHealthHistoryOutput = z.infer<
  typeof GetHealthHistoryOutputSchema
>;
