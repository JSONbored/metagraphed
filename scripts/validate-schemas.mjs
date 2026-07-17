import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { existsSync } from "node:fs";
import path from "node:path";
import { PUBLIC_ARTIFACTS } from "../src/contracts.mjs";
import {
  listJsonFiles,
  listJsonFilesRecursive,
  loadCandidates,
  loadProviders,
  loadSubnets,
  readJson,
  repoRoot,
} from "./lib.mjs";
import {
  R2_STAGING_RELATIVE_ROOT,
  artifactStorageTierForPath,
} from "../src/artifact-storage.mjs";
import { createComponentValidatorCompiler } from "./lib/component-validator.mjs";

// Artifacts whose schema describes a live-computed API response with no static
// file on disk (served from D1/KV). Their schema is exercised by validate-api's
// per-route response validation, not by validating files here.
const COMPUTED_ARTIFACTS = new Set([
  "health-trends",
  "health-trends-bulk",
  "health-percentiles",
  "health-incidents",
  "subnet-trajectory",
  "subnet-concentration",
  "subnet-concentration-history",
  "subnet-performance",
  "subnet-performance-history",
  "subnet-turnover",
  "subnet-stake-flow",
  "subnet-alpha-volume",
  "subnet-ohlc",
  "subnet-stake-quote",
  "subnet-weights",
  "subnet-weight-setters",
  "subnet-serving",
  "subnet-prometheus",
  "subnet-stake-moves",
  "subnet-stake-transfers",
  "subnet-registrations",
  "subnet-axon-removals",
  "subnet-deregistrations",
  "subnet-movers",
  "subnet-yield",
  "subnet-yield-history",
  "global-validators",
  "accounts-list",
  "validator-detail",
  "validator-nominators",
  "validator-history",
  "subnet-uptime",
  "subnet-metagraph",
  "subnet-neuron",
  "subnet-hyperparameters",
  "subnet-hyperparameters-history",
  "subnet-validators",
  "subnet-events",
  "subnet-event-summary",
  "subnet-neuron-history",
  "subnet-history",
  "subnet-identity-history",
  "account-summary",
  "account-events",
  "account-history",
  "account-extrinsics",
  "account-transfers",
  "account-counterparties",
  "account-stake-flow",
  "account-stake-moves",
  "account-weight-setters",
  "account-registrations",
  "account-serving",
  "account-axon-removals",
  "account-prometheus",
  "account-deregistrations",
  "account-subnets",
  "account-portfolio",
  "account-positions",
  "account-subnet-position-history",
  "account-balance",
  "account-identity",
  "account-identity-history",
  "sudo-key",
  "subnet-recycled",
  "blocks-feed",
  "blocks-summary",
  "block-detail",
  "block-extrinsics",
  "block-events",
  "extrinsics-feed",
  "extrinsic-detail",
  "sudo-calls",
  "governance-config-changes",
  "runtime-versions",
  "chain-activity",
  "chain-calls",
  "chain-signers",
  "chain-fees",
  "chain-transfers",
  "chain-transfer-pairs",
  "chain-stake-flow",
  "chain-alpha-volume",
  "chain-weights",
  "chain-weight-setters",
  "chain-serving",
  "chain-prometheus",
  "chain-axon-removals",
  "chain-registrations",
  "chain-deregistrations",
  "chain-stake-moves",
  "chain-stake-transfers",
  "chain-concentration",
  "chain-performance",
  "chain-identity-history",
  "chain-yield",
  "chain-turnover",
  // Postgres-backed all-events tier (ADR 0013): served live by the data Worker,
  // never written as files.
  "chain-events-feed",
  "chain-events-stats",
  "block-chain-events",
  // Network-wide economics time series (#1307): aggregated live from D1.
  "economics-trends",
  "registry-leaderboards",
  "compare",
  "compare-validators",
  "rpc-usage",
  "global-incidents",
  // Live-only operational health (served from KV/D1, no static file on disk).
  "health-latest",
  "health-summary",
  "health-subnet",
]);

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateFormats: true,
});
addFormats(ajv);

const providerSchema = await readJson(
  path.join(repoRoot, "schemas/provider.schema.json"),
);
const subnetSchema = await readJson(
  path.join(repoRoot, "schemas/subnet-manifest.schema.json"),
);
const candidateSchema = await readJson(
  path.join(repoRoot, "schemas/candidate-surface.schema.json"),
);
const providerSubmissionSchema = await readJson(
  path.join(repoRoot, "schemas/provider-submission.schema.json"),
);
// #5551: public-artifacts.schema.json documents the top-level shape of every
// generated artifact served from metagraph.sh/metagraph (schema_version: 1,
// network: "finney", the required per-kind properties). Registered explicitly
// so it's addSchema'd under its $id here — rather than only ajv.compile()'d for
// syntax by the generic loop below — and its `$defs` can be $ref'd to validate
// real artifact data against it (see the public-artifact loop after the
// per-component validation).
const publicArtifactsSchema = await readJson(
  path.join(repoRoot, "schemas/public-artifacts.schema.json"),
);
const openapi = await readJson(
  path.join(repoRoot, "public/metagraph/openapi.json"),
);

for (const schema of [
  providerSchema,
  subnetSchema,
  candidateSchema,
  providerSubmissionSchema,
  publicArtifactsSchema,
]) {
  ajv.addSchema(schema, schema.$id);
}
const explicitlyRegisteredSchemaIds = new Set([
  providerSchema.$id,
  subnetSchema.$id,
  candidateSchema.$id,
  providerSubmissionSchema.$id,
  publicArtifactsSchema.$id,
]);
for (const schemaPath of await listJsonFiles(path.join(repoRoot, "schemas"))) {
  const schema = await readJson(schemaPath);
  if (!explicitlyRegisteredSchemaIds.has(schema.$id)) {
    ajv.compile(schema);
  }
}
ajv.addSchema(
  {
    $id: "https://metagraph.sh/openapi-components.schema.json",
    components: openapi.components,
  },
  "https://metagraph.sh/openapi-components.schema.json",
);

const compileComponentValidator = createComponentValidatorCompiler(ajv);

const validators = {
  provider: ajv.getSchema(providerSchema.$id),
  subnet: ajv.getSchema(subnetSchema.$id),
  candidate: ajv.getSchema(candidateSchema.$id),
  providerSubmission: ajv.getSchema(providerSubmissionSchema.$id),
};

const errors = [];

for (const provider of await loadProviders()) {
  validate(validators.provider, provider, `provider:${provider.id}`);
}

for (const subnet of await loadSubnets()) {
  validate(validators.subnet, subnet, `subnet:${subnet.slug}`);
}

for (const candidate of await loadCandidates()) {
  validate(validators.candidate, candidate, `candidate:${candidate.id}`);
}

// #5476: enforce the direct-provider-profile intake fixture against its actual
// schema (patterns, additionalProperties:false, the nested provider sub-schema)
// rather than validate-intake.mjs's weaker presence-only checks. The authority
// narrowing to community/provider-claimed stays enforced there, on top of this.
const providerSubmissionExample = await readJson(
  path.join(repoRoot, "docs/examples/submissions/direct-provider-profile.json"),
);
validate(
  validators.providerSubmission,
  providerSubmissionExample,
  "direct-provider-profile example",
);

const artifactTargets = await artifactValidationTargets();
for (const artifact of artifactTargets) {
  const validator = compileComponentValidator(artifact.schema_ref);
  validate(
    validator,
    await readJson(artifact.file_path),
    `artifact:${artifact.label}`,
  );
}

// #5551: additionally validate each real artifact against
// public-artifacts.schema.json's own top-level contract, keyed by the artifact
// id (hyphens -> underscores) to the schema property of the same name — e.g.
// `api-index` -> `api_index` -> `$defs.genericArtifact`, `contracts` ->
// `$defs.contractsArtifact`. This enforces the constraints that schema promises
// (schema_version: 1, network: "finney", required per-kind fields), which were
// previously only ajv.compile()-syntax-checked and fs.access()-existence-checked
// (scripts/validate.mjs), never validated against real data. Artifacts the
// schema does not document (e.g. openapi) carry no matching property and are
// skipped; the per-component schema_ref check above still covers every artifact.
const publicArtifactProperties = publicArtifactsSchema.properties || {};
const publicArtifactValidators = new Map();
for (const artifact of artifactTargets) {
  const propertyKey = artifact.label.split(":")[0].replace(/-/g, "_");
  const propertyRef = publicArtifactProperties[propertyKey]?.$ref;
  if (!propertyRef) {
    continue;
  }
  if (!publicArtifactValidators.has(propertyRef)) {
    publicArtifactValidators.set(
      propertyRef,
      ajv.compile({ $ref: publicArtifactsSchema.$id + propertyRef }),
    );
  }
  validate(
    publicArtifactValidators.get(propertyRef),
    await readJson(artifact.file_path),
    `public-artifact:${artifact.label}`,
  );
}

if (errors.length > 0) {
  console.error(`Schema validation failed with ${errors.length} issue(s):`);
  for (const error of errors.slice(0, 80)) {
    console.error(`- ${error}`);
  }
  if (errors.length > 80) {
    console.error(`- ... ${errors.length - 80} more`);
  }
  process.exit(1);
}

console.log("JSON Schema validation passed.");

async function artifactValidationTargets() {
  const targets = [];
  for (const artifact of PUBLIC_ARTIFACTS) {
    if (!artifact.schema_ref || COMPUTED_ARTIFACTS.has(artifact.id)) {
      continue;
    }

    if (
      artifact.path.includes("{netuid}") ||
      artifact.path.includes("{slug}") ||
      artifact.path.includes("{date}") ||
      artifact.path.includes("{surface_id}")
    ) {
      const filePaths =
        artifact.id === "provider-endpoints"
          ? (
              await listJsonFilesRecursive(
                templatedArtifactDirectory(artifact.id),
              )
            ).filter((filePath) => path.basename(filePath) === "endpoints.json")
          : (
              await listJsonFiles(templatedArtifactDirectory(artifact.id))
            ).filter(
              // capture-fixtures.mjs writes this report/summary file alongside
              // the real per-surface fixture-detail records in the same
              // directory (build-artifacts.mjs already excludes it the same
              // way when reading fixtures back in) -- it has no request/
              // response and was never meant to validate as one.
              (filePath) => path.basename(filePath) !== "_capture-report.json",
            );
      for (const filePath of filePaths) {
        targets.push({
          file_path: filePath,
          label: `${artifact.id}:${path.basename(filePath)}`,
          schema_ref: artifact.schema_ref,
        });
      }
      continue;
    }

    targets.push({
      file_path: artifactFilePath(artifact.path),
      label: artifact.id,
      schema_ref: artifact.schema_ref,
    });
  }
  return targets.sort((a, b) => a.label.localeCompare(b.label));
}

function artifactFilePath(artifactPath) {
  const relativePath = artifactPath.replace(/^\/metagraph\//, "");
  const tier = artifactStorageTierForPath(artifactPath);
  const r2Path = path.join(repoRoot, R2_STAGING_RELATIVE_ROOT, relativePath);
  if (tier === "r2" && existsSync(r2Path)) {
    return r2Path;
  }
  return path.join(repoRoot, "public/metagraph", relativePath);
}

function templatedArtifactDirectory(artifactId) {
  const directories = {
    ...netuidArtifactDirectories(),
    ...slugArtifactDirectories(),
    "health-history": "health/history",
    "schema-snapshot": "schemas",
    "fixture-detail": "fixtures",
  };
  const relativeDir = directories[artifactId];
  const template = PUBLIC_ARTIFACTS.find(
    (artifact) => artifact.id === artifactId,
  )?.path;
  const tier = artifactStorageTierForPath(template || "");
  const r2Dir = path.join(repoRoot, R2_STAGING_RELATIVE_ROOT, relativeDir);
  if (tier === "r2" && existsSync(r2Dir)) {
    return r2Dir;
  }
  return path.join(repoRoot, "public/metagraph", relativeDir);
}

function netuidArtifactDirectories() {
  return {
    "agent-catalog-subnet": "agent-catalog",
    "candidates-subnet": "candidates",
    "endpoints-subnet": "endpoints",
    "evidence-subnet": "evidence",
    "subnet-overview": "overview",
    "health-badge": "health/badges",
    "health-subnet": "health/subnets",
    "profile-detail": "profiles",
    "subnet-detail": "subnets",
    "subnet-gaps": "review/gaps",
    "surfaces-subnet": "surfaces",
    "verification-subnet": "verification/subnets",
  };
}

function slugArtifactDirectories() {
  return {
    adapter: "adapters",
    "provider-detail": "providers",
    "provider-endpoints": "providers",
  };
}

function validate(validator, value, label) {
  if (!validator(value)) {
    for (const error of validator.errors || []) {
      errors.push(
        `${label}${error.instancePath}: ${formatErrorMessage(error, value)}`,
      );
    }
  }
}

// ajv's default `error.message` for an `enum` keyword is the unhelpful "must
// be equal to one of the allowed values" with no indication of what those
// values actually are. Reproduce: set a surface's `kind` to an invalid value,
// run `node scripts/validate-schemas.mjs`, and see the bare message. Fix:
// append the allowed values (and the offending value, when resolvable) for
// enum-keyword errors only; every other keyword's message is unchanged.
function formatErrorMessage(error, value) {
  if (error.keyword !== "enum") {
    return error.message;
  }
  const allowed = (error.params?.allowedValues || []).join(", ");
  const actual = valueAtInstancePath(value, error.instancePath);
  const gotSuffix =
    actual === undefined ? "" : ` (got ${JSON.stringify(actual)})`;
  return `${error.message}: ${allowed}${gotSuffix}`;
}

function valueAtInstancePath(document, instancePath) {
  if (!instancePath) return undefined;
  const segments = instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let value = document;
  for (const segment of segments) {
    if (value == null) return undefined;
    value = value[segment];
  }
  return value;
}
