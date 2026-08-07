// One source for published schemas: schemas-src (#9830).
//
// Every component in public/metagraph/openapi.json's components.schemas comes
// from schemas-src/openapi-registry.ts. Before #9830 that was only MOSTLY
// true -- a hand-written JSON Schema layer under schemas/components/ supplied
// 27 of them, and scripts/openapi-components.ts merged the two with the Zod
// side overlaid on top. Nothing detected divergence between a component and
// the route it described, because half of them were never type-checked
// against anything.
//
// This gate keeps the single source single. It fails on four things, each of
// which is a way the second source came back:
//
//   1. A hand-written component file reappearing anywhere under schemas/.
//   2. A bundler being re-added to rebuild one.
//   3. A published component that the registry does not declare -- i.e. a
//      component injected into the document by some path other than
//      schemas-src.
//   4. A registry name that never reaches the published document, which means
//      a register() call silently stopped taking effect.
//
// (3) and (4) are the load-bearing pair: (1) and (2) catch the specific shape
// the old layer had, but a set-equality check between "what schemas-src
// declares" and "what the contract publishes" catches ANY second source,
// including one nobody has thought of yet.
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateOpenApiZodComponents } from "./generate-openapi-zod-components.ts";
import { readJson, repoRoot } from "./lib.ts";

type Row = Record<string, unknown>;

const errors: string[] = [];

// The document carries exactly one component the registry does not: the build
// marker scripts/openapi-components.ts stamps on so a consumer can tell which
// build produced the contract.
const GENERATED_MARKER = "GeneratedOpenApiMarker";

// Retired: the directory the hand-written component layer lived in, and the
// bundle it was compiled into. Named rather than pattern-matched so the
// failure message can say what the file IS.
const RETIRED_PATHS = [
  "schemas/components",
  "schemas/api-components.schema.json",
  "scripts/bundle-schemas.ts",
];

for (const relativePath of RETIRED_PATHS) {
  if (await exists(path.join(repoRoot, relativePath))) {
    errors.push(
      `${relativePath} is back. Published components live in schemas-src/ and nowhere else (#9830) -- ` +
        "add the schema there and register it in schemas-src/openapi-registry.ts.",
    );
  }
}

// A hand-written component file could reappear under a different name, so the
// shape is checked too: any JSON under schemas/ carrying a components.schemas
// map is a second source regardless of what it is called. schemas/ still
// legitimately holds INPUT schemas (subnet-manifest, provider, entity,
// candidate-surface, saved-query, provider-submission, public-artifacts) --
// those validate registry files people write by hand, and none of them
// declares an OpenAPI component map.
for (const entry of await fs.readdir(path.join(repoRoot, "schemas"), {
  withFileTypes: true,
  recursive: true,
})) {
  if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
  const absolutePath = path.join(entry.parentPath, entry.name);
  const relativePath = path.relative(repoRoot, absolutePath);
  // The OpenAPI 3.1 meta-schema is a copy of the spec's own document schema;
  // it DESCRIBES a components block rather than declaring one.
  if (relativePath === "schemas/openapi-3.1-meta-schema.json") continue;
  const document = (await readJson(absolutePath)) as Row;
  const components = (document.components as Row | undefined)?.schemas;
  if (components && typeof components === "object") {
    errors.push(
      `${relativePath} declares components.schemas (${Object.keys(components).length} name(s)). ` +
        "That is a second source for the published contract (#9830) -- move the schemas to schemas-src/ and register them.",
    );
  }
}

// Set equality between what schemas-src declares and what the contract
// publishes. Read from the COMMITTED document, not a fresh build: this asks
// what consumers actually receive.
const openapi = (await readJson(
  path.join(repoRoot, "public/metagraph/openapi.json"),
)) as Row;
const published = new Set(
  Object.keys(((openapi.components as Row)?.schemas as Row) || {}),
);
published.delete(GENERATED_MARKER);
const declared = new Set(Object.keys(generateOpenApiZodComponents()));

const undeclared = [...published].filter((name) => !declared.has(name)).sort();
if (undeclared.length > 0) {
  errors.push(
    `Published component(s) that schemas-src does not declare: ${undeclared.join(", ")}. ` +
      "Something other than schemas-src/openapi-registry.ts is injecting components into the contract (#9830).",
  );
}

const unpublished = [...declared].filter((name) => !published.has(name)).sort();
if (unpublished.length > 0) {
  errors.push(
    `schemas-src declares component(s) the contract does not publish: ${unpublished.join(", ")}. ` +
      "A register() call stopped taking effect, or public/metagraph/openapi.json is stale -- run npm run build.",
  );
}

if (errors.length > 0) {
  console.error(
    `Single-schema-source validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Single-schema-source validation passed: ${declared.size} published components, all declared in schemas-src.`,
);

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}
