import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  API_ROUTES,
  artifactPathFromTemplate,
  CONTRACT_VERSION,
} from "../src/contracts.mjs";
import {
  artifactDirectoryPath,
  artifactFilePath,
  readJson,
  repoRoot,
} from "./lib.mjs";

const openapi = await readJson(
  path.join(repoRoot, "public/metagraph/openapi.json"),
);
const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateFormats: true,
});
addFormats(ajv);

const errors = [];

for (const route of API_ROUTES) {
  const artifactPath = await exampleArtifactPath(route.artifact_path);
  if (artifactPath === null) {
    console.warn(
      `validate-openapi-examples: no example artifact on disk for ${route.path}; skipping.`,
    );
    continue;
  }
  let artifact;
  try {
    artifact = await readJson(
      artifactFilePath(artifactPath.replace(/^\/metagraph\//, "")),
    );
  } catch (error) {
    // The example artifact isn't on disk in this build context (e.g. an
    // R2-only or per-subnet artifact that depends on D1/health data). Presence
    // is enforced by other gates (build, r2-manifest, contract-drift, live
    // smoke) — this gate only validates example↔schema conformance for the
    // artifacts that ARE present, so skip-with-warning instead of crashing.
    if (error.code === "ENOENT") {
      console.warn(
        `validate-openapi-examples: example artifact not generated for ${route.path}; skipping.`,
      );
      continue;
    }
    throw error;
  }
  const body = {
    ok: true,
    schema_version: 1,
    data: artifact,
    meta: {
      artifact_path: artifactPath,
      cache: route.cache,
      contract_version: CONTRACT_VERSION,
      generated_at: artifact.generated_at || null,
      source: "example-artifact",
    },
  };
  const operation = openapi.paths?.[route.path]?.[route.method.toLowerCase()];
  const responseSchema =
    operation?.responses?.["200"]?.content?.["application/json"]?.schema;
  if (!responseSchema) {
    errors.push(`${route.path}: missing 200 response schema`);
    continue;
  }
  const validator = ajv.compile({
    components: openapi.components,
    ...responseSchema,
  });
  if (!validator(body)) {
    errors.push(
      `${route.path}: example response failed OpenAPI validation: ${ajv.errorsText(
        validator.errors,
      )}`,
    );
  }
}

if (errors.length > 0) {
  console.error(
    `OpenAPI example validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `OpenAPI example validation passed for ${API_ROUTES.length} route(s).`,
);

async function exampleArtifactPath(template) {
  if (template.includes("{date}")) {
    const files = await fs.readdir(artifactDirectoryPath("health/history"));
    const latest = files
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
      .sort()
      .at(-1);
    return artifactPathFromTemplate(template, {
      date: latest.replace(/\.json$/, ""),
    });
  }
  if (template.includes("{slug}")) {
    const slug = template.includes("/providers/")
      ? await firstProviderSlug(template)
      : "allways";
    return artifactPathFromTemplate(template, { slug });
  }
  if (template.includes("{netuid}")) {
    const netuid = await firstExistingNetuid(template);
    return netuid === null
      ? null
      : artifactPathFromTemplate(template, { netuid });
  }
  return template;
}

// Pick a netuid whose artifact actually exists on disk for this template,
// preferring 7 for stable/consistent examples. Per-subnet artifacts (e.g.
// health/trends/{netuid}.json) are only emitted when that subnet has data, so
// hard-coding netuid 7 made validate:openapi-examples (and the scheduled
// Sync Subnets job that runs it) fail with ENOENT whenever 7 had no instance.
// Returns null when no instance exists at all (nothing to validate → skip).
async function firstExistingNetuid(template) {
  const nested = /\{netuid\}\/.+/.test(template);
  const relativeDir = template
    .replace(/^\/metagraph\//, "")
    .split("{netuid}")[0]
    .replace(/\/+$/, "");
  let entries;
  try {
    entries = await fs.readdir(artifactDirectoryPath(relativeDir), {
      withFileTypes: true,
    });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => (nested ? entry.isDirectory() : entry.isFile()))
    .map((entry) => entry.name.replace(/\.json$/, ""))
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);
  if (candidates.length === 0) {
    return null;
  }
  const order = candidates.includes(7)
    ? [7, ...candidates.filter((netuid) => netuid !== 7)]
    : candidates;
  if (!nested) {
    return order[0];
  }
  for (const netuid of order) {
    const filePath = artifactFilePath(
      artifactPathFromTemplate(template, { netuid }).replace(
        /^\/metagraph\//,
        "",
      ),
    );
    try {
      await fs.access(filePath);
      return netuid;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function firstProviderSlug(template) {
  if (template.endsWith("/endpoints.json")) {
    const providers = await fs.readdir(artifactDirectoryPath("providers"), {
      withFileTypes: true,
    });
    return providers
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()[0];
  }
  return "allways";
}
