// Whole-capture representations have a different seam from same-name mirrors.
// This checks declarations against committed metadata, never deployed coverage.
export const BUNDLE_FAMILIES = [
  "capture",
  "pages",
  "funds",
  "holdings",
  "targets",
  "completion",
] as const;
type Family = (typeof BUNDLE_FAMILIES)[number];
type Bounds = { min: number; max: number };
type Value = { nullable: boolean } & (
  | { kind: "string" | "boolean" | "decimal-string" }
  | ({ kind: "integer" } & Bounds)
);
type Binding =
  | {
      kind: "path";
      from: "row" | "capture" | "parent" | "receipt";
      path: string;
    }
  | { kind: "array-length"; path: string };
type ColumnRule = {
  udt: string;
  nullable: boolean;
  // A versioned contract assertion, not something base `numeric` in a source
  // snapshot proves. Unconstrained numeric values need decimal strings.
  integerBounds?: Bounds;
  binding: Binding;
};
type Receipt = { captureId: string; digest: string; acceptedAt: string };
type FamilyRule = {
  rows: string;
  parent?: string;
  columns: Record<string, ColumnRule>;
  // Whole-capture totals can differ from per-parent array lengths. Bounds are
  // explicit versioned contract assertions, including any global row cap.
  count: { manifestPath: string; indexColumn: string; bounds: Bounds };
};

export interface BundleSourceColumn {
  table: string;
  column: string;
  udt: string;
  nullable: boolean;
}
export interface BundleCatalogColumn {
  table: string;
  column: string;
  field_id: number;
  type: string;
  required: boolean;
}
export interface ArchiveBundleContract {
  version: number;
  capturePath: string;
  receiptPath: string;
  values: Record<string, Value>;
  arrays: Record<string, Bounds>;
  families: Record<Family, FamilyRule>;
  receipt: Receipt;
  index: {
    fields: Omit<BundleCatalogColumn, "table">[];
    receipt: Receipt;
  };
}
export interface ArchiveBundleMapping {
  contract: string;
  version: number;
  // The existing catalog snapshot is scoped to `chain` and keyed by bare table
  // name. Another namespace needs snapshot support, not a guessed association.
  namespace: "chain";
  indexTable: string;
  sources: Record<Family, string>;
}

const PATH = /^[a-z][a-z0-9_]*(?:\[\])?(?:\.[a-z][a-z0-9_]*(?:\[\])?)*$/;
const NAME = /^[a-z][a-z0-9_]*$/;
const isBounds = (bounds: Bounds): boolean =>
  Number.isSafeInteger(bounds.min) &&
  Number.isSafeInteger(bounds.max) &&
  bounds.min <= bounds.max;
const encloses = (outer: Bounds, inner: Bounds): boolean =>
  outer.min <= inner.min && outer.max >= inner.max;
const below = (path: string, base: string): boolean =>
  path.startsWith(`${base}.`) && !path.slice(base.length).includes("[]");
const childArray = (path: string, base: string): boolean =>
  path.endsWith("[]") && below(path.slice(0, -2), base);

function countFitsFamily(
  contract: ArchiveBundleContract,
  family: Family,
  rule: FamilyRule,
): boolean {
  const bounds = rule.count.bounds;
  if (!isBounds(bounds) || bounds.min < 0) return false;
  if (family === "capture" || family === "completion")
    return bounds.min === 1 && bounds.max === 1;
  const array = contract.arrays[rule.rows];
  const parent =
    family === "holdings" || family === "targets"
      ? contract.arrays[contract.families.funds?.rows]
      : { min: 1, max: 1 };
  if (
    !array ||
    !parent ||
    !isBounds(array) ||
    !isBounds(parent) ||
    array.min < 0 ||
    parent.min < 0
  )
    return false;
  // BigInt avoids overflowing while comparing safe declared global limits
  // against the product of two independently bounded arrays.
  return (
    BigInt(bounds.min) >= BigInt(array.min) * BigInt(parent.min) &&
    BigInt(bounds.max) <= BigInt(array.max) * BigInt(parent.max)
  );
}

function lossless(source: ColumnRule, value: Value): boolean {
  if (source.nullable !== value.nullable) return false;
  if (source.integerBounds && !isBounds(source.integerBounds)) return false;
  if (value.kind === "integer" && !isBounds(value)) return false;
  switch (source.udt) {
    case "bool":
      return value.kind === "boolean";
    case "uuid":
    case "text":
    case "varchar":
      return value.kind === "string";
    case "numeric":
      return (
        value.kind === "decimal-string" ||
        (value.kind === "integer" &&
          source.integerBounds !== undefined &&
          encloses(value, source.integerBounds))
      );
    case "int2":
    case "int4": {
      const width = source.udt === "int2" ? 16 : 32;
      return (
        value.kind === "decimal-string" ||
        (value.kind === "integer" &&
          encloses(value, {
            min: -(2 ** (width - 1)),
            max: 2 ** (width - 1) - 1,
          }))
      );
    }
    // A JS number cannot carry every int8. Do not widen the legacy mirror's
    // numeric -> double rule to make an exact bundle declaration pass.
    case "int8":
      return value.kind === "decimal-string";
    default:
      return false;
  }
}

function indexFits(
  value: Value,
  field: Omit<BundleCatalogColumn, "table">,
): boolean {
  if (!field.required || value.nullable) return false;
  if (value.kind === "string" || value.kind === "decimal-string")
    return field.type === "string";
  if (value.kind === "boolean") return field.type === "boolean";
  return (
    value.kind === "integer" &&
    isBounds(value) &&
    (field.type === "long" ||
      (field.type === "int" &&
        value.min >= -(2 ** 31) &&
        value.max <= 2 ** 31 - 1))
  );
}

/**
 * Pure metadata audit. Definitions describe a versioned representation;
 * mappings associate that representation with actual source/catalog entities.
 * An empty production mapping is not an archive declaration or debt exemption.
 */
export function validateArchiveBundles(input: {
  source: readonly BundleSourceColumn[];
  catalog: readonly BundleCatalogColumn[];
  policies: Readonly<Record<string, string>>;
  contracts: Readonly<Record<string, ArchiveBundleContract>>;
  mappings: readonly ArchiveBundleMapping[];
}): string[] {
  const problems: string[] = [];
  const declaredSources = new Set<string>();
  const declaredIndexes = new Set<string>();
  const usedContracts = new Set<string>();
  for (const mapping of input.mappings) {
    const label = `${mapping.contract} -> ${mapping.namespace}.${mapping.indexTable}`;
    const fail = (message: string): void => {
      problems.push(`${label}: ${message}`);
    };
    const contract = input.contracts[mapping.contract];
    if (!contract) {
      fail("unknown bundle contract");
      continue;
    }
    usedContracts.add(mapping.contract);
    if (contract.version !== 1 || mapping.version !== contract.version) {
      fail("unsupported or incompatible bundle contract version");
      continue;
    }
    if (mapping.namespace !== "chain" || !NAME.test(mapping.indexTable))
      fail("unsupported catalog table identity");
    if (declaredIndexes.has(mapping.indexTable))
      fail("catalog table is assigned to more than one bundle mapping");
    declaredIndexes.add(mapping.indexTable);
    for (const [kind, keys] of [
      ["contract families", Object.keys(contract.families)],
      ["source families", Object.keys(mapping.sources)],
    ] as const) {
      const missing = BUNDLE_FAMILIES.filter(
        (family) => !keys.includes(family),
      );
      const extra = keys.filter(
        (key) => !BUNDLE_FAMILIES.some((family) => family === key),
      );
      if (missing.length || extra.length)
        fail(
          `${kind} must cover the complete group; missing [${missing}], extra [${extra}]`,
        );
    }
    if (
      !PATH.test(contract.capturePath) ||
      contract.capturePath.includes("[]") ||
      !PATH.test(contract.receiptPath) ||
      contract.receiptPath.includes("[]") ||
      contract.capturePath === contract.receiptPath
    )
      fail("capture and original receipt need distinct object paths");
    const shape = new Map<string, string>();
    const declareShape = (path: string, terminal: "value" | "object"): void => {
      let parent = "";
      const parts = path.split(".");
      for (const [position, part] of parts.entries()) {
        const array = part.endsWith("[]");
        const key = `${parent}${array ? part.slice(0, -2) : part}`;
        const kind = array
          ? "array"
          : position === parts.length - 1
            ? terminal
            : "object";
        if (shape.has(key) && shape.get(key) !== kind)
          fail(`conflicting bundle path shape: ${key}`);
        shape.set(key, kind);
        parent += `${part}.`;
      }
    };
    declareShape(contract.capturePath, "object");
    declareShape(contract.receiptPath, "object");
    for (const [path, value] of Object.entries(contract.values)) {
      if (
        !PATH.test(path) ||
        path.endsWith("[]") ||
        (value.kind === "integer" && !isBounds(value))
      )
        fail(`invalid value path or integer bounds: ${path}`);
      declareShape(path, "value");
    }
    for (const [path, array] of Object.entries(contract.arrays)) {
      if (
        !PATH.test(path) ||
        !path.endsWith("[]") ||
        !isBounds(array) ||
        array.min < 0
      )
        fail(`invalid bounded array: ${path}`);
      declareShape(path, "object");
    }

    const actualFields = input.catalog.filter(
      (field) => field.table === mapping.indexTable,
    );
    if (!actualFields.length)
      fail("index table is absent from the committed catalog snapshot");
    const expectedNames = new Set<string>();
    const expectedIds = new Set<number>();
    const actualNames = new Set<string>();
    const actualIds = new Set<number>();
    for (const field of contract.index.fields) {
      if (
        !NAME.test(field.column) ||
        !Number.isSafeInteger(field.field_id) ||
        field.field_id < 1 ||
        expectedNames.has(field.column) ||
        expectedIds.has(field.field_id)
      )
        fail(`invalid or duplicate index field: ${field.column}`);
      expectedNames.add(field.column);
      expectedIds.add(field.field_id);
      const actual = actualFields.find((item) => item.column === field.column);
      if (
        !actual ||
        actual.field_id !== field.field_id ||
        actual.type !== field.type ||
        actual.required !== field.required
      ) {
        fail(
          `index ${field.column} must have field ID ${field.field_id}, type ${field.type}, required=${field.required}`,
        );
      }
    }
    for (const field of actualFields) {
      if (!expectedNames.has(field.column))
        fail(`unmapped catalog column: ${field.column}`);
      if (actualNames.has(field.column) || actualIds.has(field.field_id))
        fail(`duplicate catalog field: ${field.column}`);
      actualNames.add(field.column);
      actualIds.add(field.field_id);
    }
    const countColumns = new Set<string>();
    const countPaths = new Set<string>();
    const rowPaths = new Set<string>();
    for (const family of BUNDLE_FAMILIES) {
      const rule = contract.families[family];
      const table = mapping.sources[family];
      if (!rule || !table) continue; // The complete-group error above owns this.
      if (!NAME.test(table)) fail(`invalid source table for ${family}`);
      if (declaredSources.has(table))
        fail(`source table is mapped more than once: ${table}`);
      declaredSources.add(table);
      if (input.policies[table] !== "bundled")
        fail(`${table} must explicitly use bundled policy`);
      const source = input.source.filter((column) => column.table === table);
      if (!source.length)
        fail(`source table is absent from the committed snapshot: ${table}`);
      const expectedParent =
        family === "holdings" || family === "targets"
          ? contract.families.funds?.rows
          : contract.capturePath;
      const objectFamily = family === "capture" || family === "completion";
      const expectedObject =
        family === "capture" ? contract.capturePath : contract.receiptPath;
      if (
        !PATH.test(rule.rows) ||
        (objectFamily
          ? rule.rows !== expectedObject
          : !expectedParent ||
            !childArray(rule.rows, expectedParent) ||
            !contract.arrays[rule.rows]) ||
        (!objectFamily && rule.parent !== expectedParent)
      )
        fail(`invalid row/parent path for ${family}`);
      if (rowPaths.has(rule.rows))
        fail(`row path is shared by different families: ${family}`);
      rowPaths.add(rule.rows);

      const sourceNames = new Set<string>();
      for (const column of source) {
        if (sourceNames.has(column.column))
          fail(`duplicate source column: ${table}.${column.column}`);
        sourceNames.add(column.column);
        if (!rule.columns[column.column])
          fail(`unmapped source column: ${table}.${column.column}`);
      }
      const projectionPaths = new Set<string>();
      for (const [column, projection] of Object.entries(rule.columns)) {
        const sourceColumn = source.find((item) => item.column === column);
        if (!sourceColumn)
          fail(`stale source column mapping: ${table}.${column}`);
        else if (
          sourceColumn.udt !== projection.udt ||
          sourceColumn.nullable !== projection.nullable
        )
          fail(`source type/nullability changed: ${table}.${column}`);
        const binding = projection.binding;
        if (projectionPaths.has(binding.path))
          fail(`different source columns share one value: ${table}.${column}`);
        projectionPaths.add(binding.path);
        let value: Value | undefined;
        if (binding.kind === "array-length") {
          const array = contract.arrays[binding.path];
          if (!array || !childArray(binding.path, rule.rows))
            fail(
              `count must reference a declared child array: ${table}.${column}`,
            );
          else value = { kind: "integer", nullable: false, ...array };
        } else {
          const scope = {
            row: rule.rows,
            capture: contract.capturePath,
            parent: rule.parent,
            receipt: contract.receiptPath,
          }[binding.from];
          if (!scope || !below(binding.path, scope))
            fail(`invalid ${binding.from} binding for ${table}.${column}`);
          value = contract.values[binding.path];
        }
        if (!value)
          fail(
            `missing value definition for ${table}.${column}: ${binding.path}`,
          );
        else if (!lossless(projection, value))
          fail(
            `no lossless representation for ${table}.${column}; base numeric alone does not prove integer bounds`,
          );
      }
      const count = contract.values[rule.count.manifestPath];
      const indexField = contract.index.fields.find(
        (field) => field.column === rule.count.indexColumn,
      );
      if (
        !rule.count.manifestPath.startsWith("manifest.counts.") ||
        !count ||
        count.kind !== "integer" ||
        count.nullable ||
        !isBounds(count) ||
        !countFitsFamily(contract, family, rule) ||
        count.min !== rule.count.bounds.min ||
        count.max !== rule.count.bounds.max ||
        !indexField ||
        !indexFits(count, indexField)
      )
        fail(`invalid original manifest/index count binding for ${family}`);
      if (
        countColumns.has(rule.count.indexColumn) ||
        countPaths.has(rule.count.manifestPath)
      )
        fail(`count binding is shared by different families: ${family}`);
      countColumns.add(rule.count.indexColumn);
      countPaths.add(rule.count.manifestPath);
    }
    const receiptPaths = Object.values(contract.receipt);
    if (
      new Set(receiptPaths).size !== 3 ||
      new Set(Object.values(contract.index.receipt)).size !== 3
    )
      fail("original receipt bindings must be distinct");
    for (const role of ["captureId", "digest", "acceptedAt"] as const) {
      const path = contract.receipt[role];
      const value = contract.values[path];
      const field = contract.index.fields.find(
        (item) => item.column === contract.index.receipt[role],
      );
      const completion = contract.families.completion;
      if (
        !below(path, contract.receiptPath) ||
        !value ||
        !field ||
        !indexFits(value, field) ||
        !completion ||
        !Object.values(completion.columns).some(
          (column) =>
            column.binding.kind === "path" &&
            column.binding.from === "receipt" &&
            column.binding.path === path,
        )
      ) {
        fail(
          `original completion receipt ${role} must bind source, bundle and required index field`,
        );
      }
    }
  }
  for (const [table, policy] of Object.entries(input.policies)) {
    if (policy === "bundled" && !declaredSources.has(table))
      problems.push(`${table}: bundled policy has no complete bundle mapping`);
  }
  for (const name of Object.keys(input.contracts)) {
    if (!usedContracts.has(name))
      problems.push(
        `${name}: bundle contract has no mapping; keep unprovisioned definitions in fixtures`,
      );
  }
  return problems;
}
