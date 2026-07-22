// Network-wide evidence ledger list loader for MCP parity on GET /api/v1/evidence.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/evidence-ledger.json artifact.

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS } from "./contracts.mjs";

export const EVIDENCE_LEDGER_ARTIFACT = "/metagraph/evidence-ledger.json";

const CLAIM_SORT_FIELDS = API_QUERY_COLLECTIONS.claims.sort_fields;

export interface EvidenceMcpError extends Error {
  toolError: true;
  code: string;
}

export function evidenceMcpError(
  code: string,
  message: string,
): EvidenceMcpError {
  const error = new Error(message) as EvidenceMcpError;
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(
  args: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw evidenceMcpError(
      "invalid_params",
      `Argument \`${key}\` must be a non-empty string when provided.`,
    );
  }
  return value.trim();
}

function optionalEnum(
  args: Record<string, unknown> | null | undefined,
  key: string,
  allowed: string[],
): string | null {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw evidenceMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

export function evidenceQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/evidence");
  const q = optionalString(args, "q");
  if (q) url.searchParams.set("q", q);
  const sort = optionalEnum(args, "sort", CLAIM_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  if (args?.limit !== undefined) {
    const limit = args.limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw evidenceMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 100.",
      );
    }
    url.searchParams.set("limit", String(limit));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw evidenceMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface EvidenceListResult {
  generated_at: unknown;
  schema_version: unknown;
  summary: unknown;
  claims: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadEvidenceList(
  ctx: {
    env: Env;
    readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  },
  args: Record<string, unknown> | null | undefined,
  {
    readArtifact,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  } = {},
): Promise<EvidenceListResult> {
  const queryUrl = evidenceQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, EVIDENCE_LEDGER_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw evidenceMcpError(
        "not_found",
        "Public evidence ledger snapshot unavailable.",
      );
    }
    throw evidenceMcpError(
      code,
      `Could not load ${EVIDENCE_LEDGER_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw evidenceMcpError(
      "not_found",
      "Public evidence ledger snapshot unavailable.",
    );
  }
  const transformed = applyQueryFilters(
    blob as Record<string, unknown>,
    queryUrl,
    "claims",
    [],
  );
  if (transformed.error) {
    throw evidenceMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.claims) ? (data.claims as Row[]) : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    schema_version: data.schema_version ?? null,
    summary: data.summary ?? null,
    claims: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_EVIDENCE_INSTRUCTIONS =
  "Use list_evidence to page the network-wide public evidence ledger with REST " +
  "list-query filters (q, sort, and pagination; mirrors GET /api/v1/evidence), ";

export const LIST_EVIDENCE_MCP_TOOL = {
  name: "list_evidence",
  title: "List the public evidence ledger",
  description:
    "Fetch the public evidence ledger: the append-only record of provenance " +
    "and verification evidence behind registry surfaces (what was checked, for " +
    "which subnet, and the outcome). Search with q across subject, claim, " +
    "source_url, and support_summary; sort with sort + order; project with " +
    "fields; and page with limit (1-100) / cursor. Distinct from " +
    "list_subnet_evidence (one subnet's claims). Mirrors GET /api/v1/evidence.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description:
          "Keyword search across subject, claim, source_url, and support_summary.",
      },
      sort: {
        type: "string",
        enum: CLAIM_SORT_FIELDS,
        description: "Field to sort by before paging.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction for sort (default asc).",
      },
      fields: {
        type: "string",
        description:
          "Comma-separated projection of claim row fields to return.",
      },
      limit: {
        type: "integer",
        description: "Max rows to return (1-100). Enables pagination.",
        minimum: 1,
        maximum: 100,
      },
      cursor: {
        type: "integer",
        description: "Pagination cursor from a prior response's next_cursor.",
        minimum: 0,
      },
    },
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };

export const LIST_EVIDENCE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["claims"],
  properties: {
    generated_at: NULLABLE_STRING,
    schema_version: { type: ["string", "integer", "null"] },
    summary: { type: ["object", "null"] },
    claims: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
