import path from "node:path";
import { QUERY_ENUMS } from "../src/contracts.ts";
import { readJson, repoRoot } from "./lib.ts";

const schemaBundle = await readJson(
  path.join(repoRoot, "schemas/api-components.schema.json"),
);
const candidateSchema = await readJson(
  path.join(repoRoot, "schemas/candidate-surface.schema.json"),
);
const subnetSchema = await readJson(
  path.join(repoRoot, "schemas/subnet-manifest.schema.json"),
);

const componentSchemas = schemaBundle.components.schemas;
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
