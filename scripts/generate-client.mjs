import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib.mjs";

const outputPath = path.join(repoRoot, "generated/metagraphed-client.ts");
const writeMode = process.argv.includes("--write");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const content = generateClientSource();
  if (writeMode) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content, "utf8");
    console.log("Generated Metagraphed API client helper.");
  } else {
    process.stdout.write(content);
  }
}

export function generateClientSource() {
  return `/**
 * This file was auto-generated from public/metagraph/openapi.json.
 * Do not make direct changes to the file.
 */

import type { components, paths } from "./metagraphed-api";

export type ApiPaths = paths;
export type ApiComponents = components;
export type ApiSchema<Name extends keyof components["schemas"]> =
  components["schemas"][Name];

export type SuccessEnvelope<Data = unknown> = Omit<
  components["schemas"]["SuccessEnvelope"],
  "data"
> & {
  data: Data;
};

export type ErrorEnvelope = components["schemas"]["ErrorEnvelope"];
export type ApiEnvelope<Data = unknown> = SuccessEnvelope<Data> | ErrorEnvelope;

export type SubnetIndexEntry = components["schemas"]["SubnetIndexEntry"];
export type SubnetDetail = components["schemas"]["SubnetDetail"];
export type Surface = components["schemas"]["Surface"];
export type CandidateSurface = components["schemas"]["CandidateSurface"];
export type EndpointResource = components["schemas"]["EndpointResource"];
export type EndpointPool = components["schemas"]["RpcPool"];
export type Provider = components["schemas"]["Provider"];
export type HealthSurface = components["schemas"]["HealthSurface"];
export type HealthSummary = components["schemas"]["HealthSummaryArtifact"];
export type EvidenceClaim = components["schemas"]["EvidenceClaim"];
export type AdapterSnapshot = components["schemas"]["AdapterArtifact"];

export type ApiPath = keyof paths;
export type GetOperation<Path extends ApiPath> =
  paths[Path] extends { get: infer Operation } ? Operation : never;
export type QueryParams<Path extends ApiPath> =
  GetOperation<Path> extends { parameters: { query?: infer Query } }
    ? Query
    : never;
export type PathParams<Path extends ApiPath> =
  GetOperation<Path> extends { parameters: { path?: infer Params } }
    ? Params
    : never;
export type JsonResponse<Path extends ApiPath> =
  GetOperation<Path> extends {
    responses: {
      200: {
        content: {
          "application/json": infer Body;
        };
      };
    };
  }
    ? Body
    : never;

export interface MetagraphedFetchOptions<Path extends ApiPath>
  extends Omit<RequestInit, "method" | "body"> {
  baseUrl?: string;
  pathParams?: PathParams<Path>;
  query?: QueryParams<Path>;
}

export async function metagraphedFetch<Path extends ApiPath>(
  path: Path,
  options: MetagraphedFetchOptions<Path> = {},
): Promise<JsonResponse<Path>> {
  const { baseUrl = "https://metagraph.sh", pathParams, query, ...init } =
    options;
  const resolvedPath = interpolatePath(
    String(path),
    pathParams as Record<string, string | number> | undefined,
  );
  const url = new URL(resolvedPath, baseUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    ...init,
    method: "GET",
    headers: {
      accept: "application/json",
      ...(init.headers || {}),
    },
  });
  return (await response.json()) as JsonResponse<Path>;
}

function interpolatePath(
  path: string,
  params: Record<string, string | number> | undefined,
) {
  if (!params) {
    return path;
  }
  return path.replace(/\\{([^}]+)\\}/g, (_match, key) => {
    const value = params[key];
    if (value === undefined || value === null) {
      throw new Error(\`Missing path parameter: \${key}\`);
    }
    return encodeURIComponent(String(value));
  });
}
`;
}
