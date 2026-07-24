import path from "node:path";
import { QUERY_ENUMS } from "../src/contracts.ts";
import { readJson, repoRoot } from "./lib.ts";

// Reads from the final PUBLISHED document (public/metagraph/openapi.json),
// not schemas/api-components.schema.json -- the latter bundles only the
// hand-edited schemas/components/*.schema.json files and deliberately
// excludes Zod-generated components (see scripts/openapi-components.ts's
// loadOpenApiComponentSchemas(), which merges Zod output OVER that bundle
// one layer later). types-epic B (#7860) migrates components from
// hand-edited to Zod-generated one batch at a time; reading the bundle
// alone would report every migrated enum component as entirely missing
// (caught in PR #8054 review: SurfaceKind/EndpointLayer/CurationLevel/
// HealthStatus/Classification/Authority all went from real drift-checks to
// false "missing_from_schema=[everything]" the moment they left the
// hand-edited bundle). The published document is a strict superset of the
// bundle for any given component, so this is a pure widening, not a
// behavior change for still-hand-edited components.
const openApiDocument = await readJson(
  path.join(repoRoot, "public/metagraph/openapi.json"),
);
const candidateSchema = await readJson(
  path.join(repoRoot, "schemas/candidate-surface.schema.json"),
);
const subnetSchema = await readJson(
  path.join(repoRoot, "schemas/subnet-manifest.schema.json"),
);

const componentSchemas = openApiDocument.components.schemas;
const errors: string[] = [];

compareComponent("SurfaceKind", QUERY_ENUMS.surfaceKind);
compareComponent("EndpointLayer", QUERY_ENUMS.endpointLayer);
compareComponent(
  "EndpointPublicationState",
  QUERY_ENUMS.endpointPublicationState,
);
compareComponent("CoverageLevel", QUERY_ENUMS.coverageLevel);
compareComponent("CurationLevel", QUERY_ENUMS.curationLevel);
compareComponent("CandidateState", QUERY_ENUMS.candidateState);
compareComponent("HealthStatus", QUERY_ENUMS.healthStatus);
compareComponent(
  "Classification",
  QUERY_ENUMS.healthClassification,
  new Set(["unknown"]),
);
compareComponent("ProviderKind", QUERY_ENUMS.providerKind);
compareComponent("Authority", QUERY_ENUMS.providerAuthority);
compareComponent(
  "SubnetStatus",
  QUERY_ENUMS.subnetStatus,
  new Set(["unknown"]),
);
compareComponent("SubnetType", QUERY_ENUMS.subnetType);

// These enums are surfaced as inline property enums on response components
// rather than standalone schema components, so they need an explicit
// component.property path. Each guards a contract surface that compareComponent
// (which only resolves top-level components) left unchecked.
comparePropertyEnum("SubnetProfile", "profile_level", QUERY_ENUMS.profileLevel);
comparePropertyEnum("CoverageDepthRow", "tier", QUERY_ENUMS.coverageDepthTier);
comparePropertyEnum(
  "AgentReadinessStatus",
  "status",
  QUERY_ENUMS.agentReadinessStatus,
);
comparePropertyEnum(
  "AgentReadinessStatus",
  "blocker_level",
  QUERY_ENUMS.agentBlockerLevel,
);
comparePropertyEnum(
  "EndpointIncident",
  "severity",
  QUERY_ENUMS.endpointIncidentSeverity,
);
comparePropertyEnum(
  "EndpointIncident",
  "state",
  QUERY_ENUMS.endpointIncidentState,
);
comparePropertyEnum(
  "ReviewAdapterCandidate",
  "recommended_adapter_kind",
  QUERY_ENUMS.recommendedAdapterKind,
);

compareSchemaEnum(
  "candidate-surface kind",
  candidateSchema.properties.kind.enum,
  QUERY_ENUMS.surfaceKind,
);
compareSchemaEnum(
  "subnet-manifest surface kind",
  subnetSchema.$defs.surface.properties.kind.enum,
  QUERY_ENUMS.surfaceKind,
);

if (errors.length > 0) {
  console.error(
    `Schema enum validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Schema enum validation passed.");

function compareComponent(
  componentName: string,
  queryValues: unknown[],
  schemaOnlyValues: Set<unknown> = new Set(),
): void {
  const schemaValues = (componentSchemas[componentName]?.enum || []).filter(
    (value: unknown) => !schemaOnlyValues.has(value),
  );
  compareSchemaEnum(componentName, schemaValues, queryValues);
}

function comparePropertyEnum(
  componentName: string,
  propertyName: string,
  queryValues: unknown[],
  schemaOnlyValues: Set<unknown> = new Set(),
): void {
  const schemaValues = (
    componentSchemas[componentName]?.properties?.[propertyName]?.enum || []
  ).filter((value: unknown) => !schemaOnlyValues.has(value));
  compareSchemaEnum(
    `${componentName}.${propertyName}`,
    schemaValues,
    queryValues,
  );
}

function compareSchemaEnum(
  label: string,
  schemaValues: unknown[] = [],
  queryValues: unknown[] = [],
): void {
  const schemaSet = new Set(schemaValues);
  const querySet = new Set(queryValues);
  const missingFromSchema = [...querySet].filter(
    (value) => !schemaSet.has(value),
  );
  const missingFromQuery = [...schemaSet].filter(
    (value) => !querySet.has(value),
  );
  if (missingFromSchema.length || missingFromQuery.length) {
    errors.push(
      `${label} enum drift: missing_from_schema=[${missingFromSchema.join(
        ", ",
      )}], missing_from_query=[${missingFromQuery.join(", ")}]`,
    );
  }
}
