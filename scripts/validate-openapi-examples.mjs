import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  API_ROUTES,
  artifactPathFromTemplate,
  CONTRACT_VERSION,
} from "../src/contracts.mjs";
import { readJson, repoRoot } from "./lib.mjs";

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
  const artifact = await readJson(
    path.join(repoRoot, "public", artifactPath.replace(/^\/+/, "")),
  );
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
    const files = await fs.readdir(
      path.join(repoRoot, "public/metagraph/health/history"),
    );
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
    return artifactPathFromTemplate(template, { netuid: 7 });
  }
  return template;
}

async function firstProviderSlug(template) {
  if (template.endsWith("/endpoints.json")) {
    const providers = await fs.readdir(
      path.join(repoRoot, "public/metagraph/providers"),
      {
        withFileTypes: true,
      },
    );
    return providers
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()[0];
  }
  return "allways";
}
