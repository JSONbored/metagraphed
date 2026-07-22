import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, repoRoot, stableStringify } from "./lib.mjs";
import path from "node:path";

type Row = Record<string, unknown>;
type SchemaMap = Record<string, Row>;

const schemaPath = "schemas/api-components.schema.json";

interface EnumChangeEntry {
  component: string;
  added_values: unknown[];
  removed_values: unknown[];
}

// Classify the component-schema delta between two OpenAPI component maps into
// additive / risky / breaking buckets for PR review (docs/api-stability.md).
// Pure + exported so it is unit-testable without invoking git or the CLI.
export function classifyContractChanges(
  previousSchemas: SchemaMap = {},
  currentSchemas: SchemaMap = {},
): Row {
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
    .map((name) =>
      enumChange(name, previousSchemas[name], currentSchemas[name]),
    )
    .filter((entry): entry is EnumChangeEntry => Boolean(entry));
  const breaking = [
    ...removed.map((name) => ({
      component: name,
      reason: "component_removed",
    })),
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
  // A changed component is risky when a NON-enum part of its schema changed. An
  // enum-only delta (added/removed values) is already surfaced as additive/
  // breaking, so a component with an enum delta is excluded from `risky` ONLY
  // when that delta fully accounts for the change (the enum-stripped bodies are
  // equal). If the schema also changed structurally alongside the enum edit
  // (e.g. a new `deprecated`/`required`/type constraint), that structural change
  // must still surface as risky rather than be swallowed as merely additive.
  const risky = changed
    .filter((name) => {
      if (!enumChanges.some((entry) => entry.component === name)) {
        return true;
      }
      const { enum: _previousEnum, ...previousRest } = previousSchemas[name];
      const { enum: _currentEnum, ...currentRest } = currentSchemas[name];
      return stableStringify(previousRest) !== stableStringify(currentRest);
    })
    .map((name) => ({ component: name, reason: "schema_changed" }));

  return {
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
  };
}

function enumChange(
  component: string,
  previousSchema: Row | undefined,
  currentSchema: Row | undefined,
): EnumChangeEntry | null {
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

function readPreviousSchema(ref: string): Row | null {
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

// CLI: diff the committed contract against a base ref and print the summary.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const baseRef =
    process.env.METAGRAPH_CONTRACT_BASE_REF ||
    (process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : "HEAD~1");
  const current: Row = await readJson(path.join(repoRoot, schemaPath));
  const previous = readPreviousSchema(baseRef);

  if (!previous) {
    console.log(
      stableStringify({
        schema_version: 1,
        source: "contract-change-summary",
        base_ref: baseRef,
        status: "base_unavailable",
        current_component_count: Object.keys(
          ((current.components as Row).schemas as Row) || {},
        ).length,
        notes: [
          "Set METAGRAPH_CONTRACT_BASE_REF to compare against a specific branch or commit.",
        ],
      }),
    );
    process.exit(0);
  }

  console.log(
    stableStringify({
      schema_version: 1,
      source: "contract-change-summary",
      base_ref: baseRef,
      status: "ok",
      ...classifyContractChanges(
        ((previous.components as Row)?.schemas as SchemaMap) || {},
        ((current.components as Row)?.schemas as SchemaMap) || {},
      ),
    }),
  );
}
