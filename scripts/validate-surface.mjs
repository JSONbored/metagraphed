// Fast, local fail-fast validator for a contributor's subnet file, to run BEFORE
// pushing. Validates registry/subnets/<slug>.json against
// schemas/subnet-manifest.schema.json, checks each surface's `provider` slug is
// registered, and requires a `review.state` on any community-authority surface
// (the single-file contribution model). Quick subset of `npm run validate`.
//
//   npm run validate:surface -- registry/subnets/<slug>.json
//   npm run validate:surface          # validates every subnet file
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import path from "node:path";
import {
  classifyNativeName,
  listJsonFiles,
  loadProviders,
  readJson,
  repoRoot,
} from "./lib.mjs";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schema = await readJson(
  path.join(repoRoot, "schemas/subnet-manifest.schema.json"),
);
const validate = ajv.compile(schema);
const providerIds = new Set(
  (await loadProviders()).map((provider) => provider.id),
);

const fileArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const files =
  fileArgs.length > 0
    ? fileArgs.map((arg) => path.resolve(arg))
    : await listJsonFiles(path.join(repoRoot, "registry/subnets"));

const errors = [];
let surfaceCount = 0;
for (const file of files) {
  let document;
  try {
    document = await readJson(file);
  } catch (error) {
    errors.push(`${path.basename(file)}: not readable JSON — ${error.message}`);
    continue;
  }
  if (!validate(document)) {
    errors.push(`${path.basename(file)}: ${ajv.errorsText(validate.errors)}`);
    continue;
  }
  // Reject placeholder display names (e.g. "Team TBC", "Subnet 86") unless the
  // maintainer has deliberately tagged the subnet "identity-placeholder" — the
  // documented escape hatch for subnets that genuinely have no on-chain identity.
  if (
    classifyNativeName(document.name, document.netuid).quality !== "chain" &&
    !(document.categories || []).includes("identity-placeholder")
  ) {
    errors.push(
      `${path.basename(file)}: subnet name ${JSON.stringify(document.name)} is a placeholder — ` +
        'set a real curated display name, or tag the subnet "identity-placeholder" if it genuinely has no on-chain identity.',
    );
  }
  for (const surface of document.surfaces || []) {
    surfaceCount += 1;
    const label = `${path.basename(file)} (${surface.id})`;
    if (surface.provider && !providerIds.has(surface.provider)) {
      errors.push(
        `${label}: provider "${surface.provider}" is not a registered slug — ` +
          "run `npm run providers:list`, or `npm run provider:new` to add it.",
      );
    }
    if (surface.authority === "community" && !surface.review?.state) {
      errors.push(
        `${label}: a community surface must carry review.state ` +
          '(e.g. "community-submitted"). Use `npm run surface:add`.',
      );
    }
  }
}

if (errors.length > 0) {
  console.error(`Surface validation failed (${errors.length} issue(s)):`);
  for (const error of errors) console.error(`- ${error}`);
  console.error(
    "\nThis is a fast local pre-check; `npm run validate` runs the full registry validation in CI.",
  );
  process.exit(1);
}
console.log(
  `Surface validation passed: ${surfaceCount} surface(s) across ${files.length} subnet file(s).`,
);
