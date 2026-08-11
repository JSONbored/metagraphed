// Curated parameterized query library -- the third MCP query modality (epic
// #6755), sitting between the fixed REST-mirror tools and the open GraphQL
// tool. Admin-curated only: SAVED_QUERY_TEMPLATES describes each template's
// id/params for discovery, SAVED_QUERY_HANDLERS is the actual dispatch table.
// Both live in this one file so they can never drift silently -- the
// self-check at the bottom throws at import time (so a broken pair fails
// every test and every cold start, not just a CI script) if a template ever
// ships without a matching handler or vice versa.
//
// Every handler wraps an existing, already-served derived-view module rather
// than authoring new query logic -- exactly the discipline #6756 asked for.
import { composeLeaderboardsData } from "../workers/request-handlers/analytics-routes.ts";
import { LEADERBOARD_BOARDS } from "./health-serving.ts";
import { loadChainRegistrationsFromArtifact } from "./chain-registrations-artifact.ts";
import {
  buildChainRegistrations,
  CHAIN_REGISTRATIONS_WINDOWS,
  DEFAULT_CHAIN_REGISTRATIONS_WINDOW,
  CHAIN_REGISTRATIONS_LIMIT_DEFAULT,
  CHAIN_REGISTRATIONS_LIMIT_MAX,
} from "./chain-registrations.ts";

type Row = Record<string, unknown>;

export interface SavedQueryError extends Error {
  toolError: true;
  code: string;
}

export function savedQueryError(
  code: string,
  message: string,
): SavedQueryError {
  const error = new Error(message) as SavedQueryError;
  error.toolError = true;
  error.code = code;
  return error;
}

interface SavedQueryParamSpec {
  name: string;
  type: "string" | "integer";
  required: boolean;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  description: string;
}

interface SavedQueryTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  params: SavedQueryParamSpec[];
  notes: string;
}

export const SAVED_QUERY_TEMPLATES: SavedQueryTemplate[] = [
  {
    id: "subnet-leaderboard",
    name: "Subnet leaderboard",
    description:
      "One registry leaderboard board (healthiest, fastest-rpc, most-complete, " +
      "most-enriched, fastest-growing, most-reliable, open-slots, " +
      "cheapest-registration, highest-emission, validator-headroom, " +
      "biggest-alpha-gain-1d, biggest-alpha-gain-7d), or every " +
      "board when omitted. Same projection as GET /api/v1/registry/leaderboards " +
      "and get_registry_leaderboards.",
    category: "leaderboard",
    params: [
      {
        name: "board",
        type: "string",
        required: false,
        enum: [...LEADERBOARD_BOARDS],
        description: "Which board to return. Omit for every board.",
      },
      {
        name: "limit",
        type: "integer",
        required: false,
        default: 20,
        minimum: 1,
        maximum: 100,
        description: "Max subnets per board (default 20).",
      },
    ],
    notes:
      "Wraps composeLeaderboardsData (workers/request-handlers/analytics-routes.ts), " +
      "the same composer GET /api/v1/registry/leaderboards, " +
      "get_registry_leaderboards, and the GraphQL registry_leaderboards " +
      "resolver all share.",
  },
  {
    id: "chain-registrations-window",
    name: "Chain registrations by window",
    description:
      "Per-subnet neuron registration counts and the network-wide registration " +
      "scorecard over a rolling window. Same projection as " +
      "GET /api/v1/chain/registrations and get_chain_registrations.",
    category: "chain-activity",
    params: [
      {
        name: "window",
        type: "string",
        required: false,
        default: DEFAULT_CHAIN_REGISTRATIONS_WINDOW,
        enum: Object.keys(CHAIN_REGISTRATIONS_WINDOWS),
        description: `Rolling window (default "${DEFAULT_CHAIN_REGISTRATIONS_WINDOW}").`,
      },
      {
        name: "limit",
        type: "integer",
        required: false,
        default: CHAIN_REGISTRATIONS_LIMIT_DEFAULT,
        minimum: 1,
        maximum: CHAIN_REGISTRATIONS_LIMIT_MAX,
        description: `Max subnets in the leaderboard (default ${CHAIN_REGISTRATIONS_LIMIT_DEFAULT}).`,
      },
    ],
    notes:
      "Wraps buildChainRegistrations (src/chain-registrations.ts) behind the " +
      "same tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) cutover the REST " +
      "route, GraphQL resolver, and MCP tool already share.",
  },
];

type SavedQueryHandler = (env: Env, params: Row) => Promise<unknown>;

export const SAVED_QUERY_HANDLERS: Record<string, SavedQueryHandler> = {
  async "subnet-leaderboard"(env, { board, limit }) {
    const { data } = await composeLeaderboardsData(env, {
      board: board as string | null | undefined,
      limit: limit as number | undefined,
    });
    return data;
  },
  async "chain-registrations-window"(env, { window, limit }) {
    // NO TIER READ (#10190): this ran tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE)
    // and fell to `buildChainRegistrations([])`. That flag reads "retired" in
    // wrangler.jsonc and is absent from DATA_API_FORWARD_FLAGS, so the tier arm
    // resolved to null on every call -- and unlike its three sibling surfaces
    // this one had NO rung under it, so run_saved_query has been answering an
    // empty leaderboard while GET /api/v1/chain/registrations served a full one
    // for the same window.
    //
    // #9146: the same chain-registrations PROJECTION the REST route, the GraphQL
    // field and the MCP tool read, so the four cannot disagree. The reader
    // declines (null) when it cannot answer faithfully, which keeps the empty
    // builder as the floor rather than the answer.
    return (
      (await loadChainRegistrationsFromArtifact(env, {
        window: window as string,
        limit: limit as number,
      })) ??
      buildChainRegistrations([], {
        window: window as string,
        limit: limit as number,
      })
    );
  },
};

function coerceAndValidateParams(
  template: SavedQueryTemplate,
  rawParams: Row | null | undefined,
): Row {
  const input = rawParams && typeof rawParams === "object" ? rawParams : {};
  const known = new Set(template.params.map((spec) => spec.name));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw savedQueryError(
        "invalid_params",
        `Unknown param "${key}" for "${template.id}". Valid params: ` +
          `${[...known].join(", ") || "(none)"}.`,
      );
    }
  }
  const validated: Row = {};
  for (const spec of template.params) {
    const raw = input[spec.name];
    if (raw === undefined || raw === null || raw === "") {
      if (spec.required) {
        throw savedQueryError(
          "invalid_params",
          `"${template.id}" requires param "${spec.name}".`,
        );
      }
      validated[spec.name] = spec.default ?? null;
      continue;
    }
    if (spec.type === "integer") {
      const num = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isInteger(num)) {
        throw savedQueryError(
          "invalid_params",
          `Param "${spec.name}" for "${template.id}" must be an integer.`,
        );
      }
      if (spec.minimum != null && num < spec.minimum) {
        throw savedQueryError(
          "invalid_params",
          `Param "${spec.name}" for "${template.id}" must be >= ${spec.minimum}.`,
        );
      }
      if (spec.maximum != null && num > spec.maximum) {
        throw savedQueryError(
          "invalid_params",
          `Param "${spec.name}" for "${template.id}" must be <= ${spec.maximum}.`,
        );
      }
      validated[spec.name] = num;
      continue;
    }
    const str = String(raw);
    if (spec.enum && !spec.enum.includes(str)) {
      throw savedQueryError(
        "invalid_params",
        `Param "${spec.name}" for "${template.id}" must be one of: ` +
          `${spec.enum.join(", ")}.`,
      );
    }
    validated[spec.name] = str;
  }
  return validated;
}

export function findSavedQueryTemplate(
  queryId: string,
): SavedQueryTemplate | undefined {
  return SAVED_QUERY_TEMPLATES.find((template) => template.id === queryId);
}

export async function runSavedQuery(
  env: Env,
  queryId: string,
  rawParams: Row | null | undefined,
): Promise<Row> {
  const template = findSavedQueryTemplate(queryId);
  if (!template) {
    throw savedQueryError(
      "not_found",
      `Unknown saved query "${queryId}". Valid ids: ` +
        `${SAVED_QUERY_TEMPLATES.map((t) => t.id).join(", ")}.`,
    );
  }
  const params = coerceAndValidateParams(template, rawParams);
  const data = await SAVED_QUERY_HANDLERS[template.id](env, params);
  return { query_id: queryId, params, data };
}

// The admin-curation integrity check #6756 asked for: a template with no
// handler (or a handler with no template) must fail loudly. Exported as a
// pure function (rather than an inline import-time block) so a unit test can
// exercise the throw branch directly with a deliberately-drifted registry --
// the real call below still runs it at import time, so a genuine drift still
// fails every cold start and every test that imports this module.
export function assertSavedQueryRegistryIntegrity(
  templates: SavedQueryTemplate[],
  handlers: Record<string, SavedQueryHandler>,
): void {
  const templateIds = templates.map((t) => t.id);
  const handlerIds = Object.keys(handlers);
  const templateIdSet = new Set(templateIds);
  const handlerIdSet = new Set(handlerIds);
  const drifted =
    templateIds.length !== templateIdSet.size ||
    templateIdSet.size !== handlerIdSet.size ||
    ![...templateIdSet].every((id) => handlerIdSet.has(id));
  if (drifted) {
    throw new Error(
      "src/saved-queries.ts: SAVED_QUERY_TEMPLATES and SAVED_QUERY_HANDLERS " +
        "have drifted -- every template id must have exactly one matching " +
        `handler. templates=[${templateIds.join(", ")}] ` +
        `handlers=[${handlerIds.join(", ")}]`,
    );
  }
}

assertSavedQueryRegistryIntegrity(SAVED_QUERY_TEMPLATES, SAVED_QUERY_HANDLERS);
