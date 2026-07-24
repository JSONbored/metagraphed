// MCP tool `get_health_history` (types-epic E batch 2, #8065). Mirrors GET
// /api/v1/health/history/{date}, which is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// shallow, from the hand-written literal it replaces (src/health-history-mcp.ts).
// Enum values hardcoded from src/contracts.ts's QUERY_ENUMS.{surfaceKind,
// healthStatus,healthClassification} and API_QUERY_COLLECTIONS["health-surfaces"]
// .sort_fields at the time of writing (mirrors the pilot batch's
// ECONOMICS_SORT_FIELDS precedent -- not cross-imported).
import { z } from "zod";
import { OpenObjectArraySchema, OpenObjectSchema } from "./shared.ts";

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
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    netuid: z.int().min(0).optional(),
    kind: z.enum(SURFACE_KIND).optional(),
    provider: z.string().optional(),
    status: z.enum(HEALTH_STATUS).optional(),
    classification: z.enum(HEALTH_CLASSIFICATION).optional(),
    sort: z.enum(HEALTH_SURFACE_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(1000).optional(),
    cursor: z.int().min(0).optional(),
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
