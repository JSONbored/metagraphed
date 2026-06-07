import { spawnSync } from "node:child_process";
import { readJson, repoRoot, stableStringify } from "./lib.mjs";
import path from "node:path";

const baseRef =
  process.env.METAGRAPH_CONTRACT_BASE_REF ||
  (process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : "HEAD~1");
const schemaPath = "schemas/api-components.schema.json";
const current = await readJson(path.join(repoRoot, schemaPath));
const previous = readPreviousSchema(baseRef);

if (!previous) {
  console.log(
    stableStringify({
      schema_version: 1,
      source: "contract-change-summary",
      base_ref: baseRef,
      status: "base_unavailable",
      current_component_count: Object.keys(current.components.schemas).length,
      notes: [
        "Set METAGRAPH_CONTRACT_BASE_REF to compare against a specific branch or commit.",
      ],
    }),
  );
  process.exit(0);
}

const previousSchemas = previous.components.schemas || {};
const currentSchemas = current.components.schemas || {};
const previousNames = new Set(Object.keys(previousSchemas));
const currentNames = new Set(Object.keys(currentSchemas));

const added = [...currentNames]
  .filter((name) => !previousNames.has(name))
  .sort();
const removed = [...previousNames]
  .filter((name) => !currentNames.has(name))
  .sort();
const changed = [...currentNames]
  .filter(
    (name) =>
      previousNames.has(name) &&
      stableStringify(previousSchemas[name]) !==
        stableStringify(currentSchemas[name]),
  )
  .sort();

const enumChanges = changed
  .map((name) => enumChange(name, previousSchemas[name], currentSchemas[name]))
  .filter(Boolean);
const breaking = [
  ...removed.map((name) => ({ component: name, reason: "component_removed" })),
  ...enumChanges.flatMap((entry) =>
    entry.removed_values.map((value) => ({
      component: entry.component,
      reason: "enum_value_removed",
      value,
    })),
  ),
];
const additive = [
  ...added.map((name) => ({ component: name, reason: "component_added" })),
  ...enumChanges.flatMap((entry) =>
    entry.added_values.map((value) => ({
      component: entry.component,
      reason: "enum_value_added",
      value,
    })),
  ),
];
const risky = changed
  .filter((name) => !enumChanges.some((entry) => entry.component === name))
  .map((name) => ({ component: name, reason: "schema_changed" }));

console.log(
  stableStringify({
    schema_version: 1,
    source: "contract-change-summary",
    base_ref: baseRef,
    status: "ok",
    classification:
      breaking.length > 0
        ? "breaking"
        : risky.length > 0
          ? "risky"
          : "additive",
    counts: {
      added_components: added.length,
      removed_components: removed.length,
      changed_components: changed.length,
      additive_changes: additive.length,
      risky_changes: risky.length,
      breaking_changes: breaking.length,
    },
    additive,
    risky,
    breaking,
  }),
);

function readPreviousSchema(ref) {
  const result = spawnSync("git", ["show", `${ref}:${schemaPath}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    return null;
  }
  return JSON.parse(result.stdout);
}

function enumChange(component, previousSchema, currentSchema) {
  if (
    !Array.isArray(previousSchema?.enum) ||
    !Array.isArray(currentSchema?.enum)
  ) {
    return null;
  }
  const previousValues = new Set(previousSchema.enum);
  const currentValues = new Set(currentSchema.enum);
  const addedValues = [...currentValues]
    .filter((value) => !previousValues.has(value))
    .sort();
  const removedValues = [...previousValues]
    .filter((value) => !currentValues.has(value))
    .sort();
  if (addedValues.length === 0 && removedValues.length === 0) {
    return null;
  }
  return {
    component,
    added_values: addedValues,
    removed_values: removedValues,
  };
}
