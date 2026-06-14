// Fast, local fail-fast validator for a contributor's candidate-surface JSON,
// to run BEFORE pushing. Validates each candidate against
// schemas/candidate-surface.schema.json and checks that its `provider` slug is
// registered. This is a quick subset of `npm run validate` (which cross-checks
// the whole registry and needs built artifacts); use it for fast iteration.
//
//   npm run validate:candidate -- registry/candidates/community/<file>.json
//   npm run validate:candidate          # validates every community candidate
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadProviders, readJson, repoRoot } from "./lib.mjs";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schema = await readJson(
  path.join(repoRoot, "schemas/candidate-surface.schema.json"),
);
const validate = ajv.compile(schema);
const providerIds = new Set(
  (await loadProviders()).map((provider) => provider.id),
);

const fileArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
let files;
if (fileArgs.length > 0) {
  files = fileArgs.map((arg) => path.resolve(arg));
} else {
  const dir = path.join(repoRoot, "registry/candidates/community");
  files = (await fs.readdir(dir))
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

const errors = [];
let count = 0;
for (const file of files) {
  let document;
  try {
    document = await readJson(file);
  } catch (error) {
    errors.push(`${path.basename(file)}: not readable JSON — ${error.message}`);
    continue;
  }
  const candidates = Array.isArray(document.candidates)
    ? document.candidates
    : [document];
  for (const candidate of candidates) {
    count += 1;
    const label = `${path.basename(file)}${candidate.id ? ` (${candidate.id})` : ""}`;
    if (!validate(candidate)) {
      errors.push(`${label}: ${ajv.errorsText(validate.errors)}`);
    }
    if (candidate.provider && !providerIds.has(candidate.provider)) {
      errors.push(
        `${label}: provider "${candidate.provider}" is not a registered slug — ` +
          "run `npm run providers:list` for valid slugs, or `npm run provider:new` to add it.",
      );
    }
  }
}

if (errors.length > 0) {
  console.error(`Candidate validation failed (${errors.length} issue(s)):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  console.error(
    "\nThis is a fast local pre-check; `npm run validate` runs the full registry validation in CI.",
  );
  process.exit(1);
}
console.log(
  `Candidate validation passed: ${count} candidate(s) across ${files.length} file(s).`,
);
