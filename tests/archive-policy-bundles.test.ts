import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  BUNDLE_FAMILIES,
  validateArchiveBundles,
  type ArchiveBundleContract,
  type ArchiveBundleMapping,
  type BundleCatalogColumn,
  type BundleSourceColumn,
} from "../scripts/archive-policy-bundles.ts";

type Rule = ArchiveBundleContract["families"]["capture"]["columns"][string];
type Value = ArchiveBundleContract["values"][string];
const text = (nullable = false): Value => ({ kind: "string", nullable });
const decimal = (nullable = false): Value => ({
  kind: "decimal-string",
  nullable,
});
const integer = (min: number, max: number): Value => ({
  kind: "integer",
  nullable: false,
  min,
  max,
});
const path = (
  udt: string,
  from: "row" | "capture" | "parent" | "receipt",
  value: string,
  nullable = false,
  integerBounds?: { min: number; max: number },
): Rule => ({
  udt,
  nullable,
  binding: { kind: "path", from, path: value },
  ...(integerBounds ? { integerBounds } : {}),
});
const length = (value: string, min: number, max: number): Rule => ({
  udt: "numeric",
  nullable: false,
  integerBounds: { min, max },
  binding: { kind: "array-length", path: value },
});

function sourceTable(
  table: string,
  columns: [string, string, boolean][],
): BundleSourceColumn[] {
  return columns.map(([column, udt, nullable]) => ({
    table,
    column,
    udt,
    nullable,
  }));
}

// Synthetic metadata only. Nothing in this fixture names a provisioned table
// or constitutes a production policy, deployment receipt or coverage claim.
function fixture() {
  const source = [
    ...sourceTable("fixture_capture", [
      ["capture_id", "uuid", false],
      ["height", "numeric", false],
      ["page_count", "numeric", false],
    ]),
    ...sourceTable("fixture_pages", [
      ["capture_id", "uuid", false],
      ["page_index", "numeric", false],
    ]),
    ...sourceTable("fixture_funds", [
      ["capture_id", "uuid", false],
      ["hotkey", "text", false],
      ["first_block", "numeric", true],
      ["holdings_count", "numeric", false],
      ["targets_count", "numeric", false],
    ]),
    ...sourceTable("fixture_holdings", [
      ["capture_id", "uuid", false],
      ["hotkey", "text", false],
      ["netuid", "numeric", false],
      ["quantity", "numeric", false],
    ]),
    ...sourceTable("fixture_targets", [
      ["capture_id", "uuid", false],
      ["hotkey", "text", false],
      ["weight", "numeric", false],
    ]),
    ...sourceTable("fixture_completion", [
      ["capture_id", "uuid", false],
      ["digest", "text", false],
      ["accepted_at", "numeric", false],
    ]),
  ];
  const fields: ArchiveBundleContract["index"]["fields"] = [
    ["schema_version", "int"],
    ["network", "string"],
    ["network_genesis_hash", "string"],
    ["decoder_version", "string"],
    ["capture_id", "string"],
    ["finalized_block_hash", "string"],
    ["finalized_block", "string"],
    ["finalized_block_order", "string"],
    ["runtime_spec_version", "long"],
    ["runtime_api_version", "int"],
    ["metadata_sha256", "string"],
    ["started_at_ms", "string"],
    ["finished_at_ms", "string"],
    ["accepted_at_ms", "string"],
    ["archived_at_ms", "string"],
    ["content_sha256", "string"],
    ["bundle_sha256", "string"],
    ["bundle_key", "string"],
    ["bundle_bytes", "int"],
    ["manifest_sha256", "string"],
    ["manifest_key", "string"],
    ["capture_count", "int"],
    ["page_count", "int"],
    ["fund_count", "int"],
    ["holding_count", "int"],
    ["target_count", "int"],
    ["completion_count", "int"],
  ].map(([column, type], position) => ({
    column: column!,
    type: type!,
    field_id: position + 1,
    required: true,
  }));
  const contract: ArchiveBundleContract = {
    version: 1,
    capturePath: "capture",
    receiptPath: "receipt",
    values: {
      "capture.capture_id": text(),
      "capture.height": decimal(),
      "capture.pages[].page_index": integer(0, 1),
      "capture.funds[].hotkey": text(),
      "capture.funds[].baseline.first_block": decimal(true),
      "capture.funds[].holdings[].netuid": integer(0, 65535),
      "capture.funds[].holdings[].quantity": decimal(),
      "capture.funds[].targets[].weight": integer(0, 65535),
      "receipt.capture_id": text(),
      "receipt.digest": text(),
      "receipt.accepted_at": decimal(),
      "manifest.counts.captures": integer(1, 1),
      "manifest.counts.pages": integer(1, 2),
      "manifest.counts.funds": integer(0, 4),
      "manifest.counts.holdings": integer(0, 32),
      "manifest.counts.targets": integer(0, 32),
      "manifest.counts.completions": integer(1, 1),
    },
    arrays: {
      "capture.pages[]": { min: 1, max: 2 },
      "capture.funds[]": { min: 0, max: 4 },
      "capture.funds[].holdings[]": { min: 0, max: 8 },
      "capture.funds[].targets[]": { min: 0, max: 8 },
    },
    families: {
      capture: {
        rows: "capture",
        columns: {
          capture_id: path("uuid", "row", "capture.capture_id"),
          height: path("numeric", "row", "capture.height"),
          page_count: length("capture.pages[]", 1, 2),
        },
        count: {
          manifestPath: "manifest.counts.captures",
          indexColumn: "capture_count",
          bounds: { min: 1, max: 1 },
        },
      },
      pages: {
        rows: "capture.pages[]",
        parent: "capture",
        columns: {
          capture_id: path("uuid", "capture", "capture.capture_id"),
          page_index: path(
            "numeric",
            "row",
            "capture.pages[].page_index",
            false,
            { min: 0, max: 1 },
          ),
        },
        count: {
          manifestPath: "manifest.counts.pages",
          indexColumn: "page_count",
          bounds: { min: 1, max: 2 },
        },
      },
      funds: {
        rows: "capture.funds[]",
        parent: "capture",
        columns: {
          capture_id: path("uuid", "capture", "capture.capture_id"),
          hotkey: path("text", "row", "capture.funds[].hotkey"),
          first_block: path(
            "numeric",
            "row",
            "capture.funds[].baseline.first_block",
            true,
          ),
          holdings_count: length("capture.funds[].holdings[]", 0, 8),
          targets_count: length("capture.funds[].targets[]", 0, 8),
        },
        count: {
          manifestPath: "manifest.counts.funds",
          indexColumn: "fund_count",
          bounds: { min: 0, max: 4 },
        },
      },
      holdings: {
        rows: "capture.funds[].holdings[]",
        parent: "capture.funds[]",
        columns: {
          capture_id: path("uuid", "capture", "capture.capture_id"),
          hotkey: path("text", "parent", "capture.funds[].hotkey"),
          netuid: path(
            "numeric",
            "row",
            "capture.funds[].holdings[].netuid",
            false,
            { min: 0, max: 65535 },
          ),
          quantity: path(
            "numeric",
            "row",
            "capture.funds[].holdings[].quantity",
          ),
        },
        count: {
          manifestPath: "manifest.counts.holdings",
          indexColumn: "holding_count",
          bounds: { min: 0, max: 32 },
        },
      },
      targets: {
        rows: "capture.funds[].targets[]",
        parent: "capture.funds[]",
        columns: {
          capture_id: path("uuid", "capture", "capture.capture_id"),
          hotkey: path("text", "parent", "capture.funds[].hotkey"),
          weight: path(
            "numeric",
            "row",
            "capture.funds[].targets[].weight",
            false,
            { min: 0, max: 65535 },
          ),
        },
        count: {
          manifestPath: "manifest.counts.targets",
          indexColumn: "target_count",
          bounds: { min: 0, max: 32 },
        },
      },
      completion: {
        rows: "receipt",
        columns: {
          capture_id: path("uuid", "receipt", "receipt.capture_id"),
          digest: path("text", "receipt", "receipt.digest"),
          accepted_at: path("numeric", "receipt", "receipt.accepted_at"),
        },
        count: {
          manifestPath: "manifest.counts.completions",
          indexColumn: "completion_count",
          bounds: { min: 1, max: 1 },
        },
      },
    },
    receipt: {
      captureId: "receipt.capture_id",
      digest: "receipt.digest",
      acceptedAt: "receipt.accepted_at",
    },
    index: {
      fields,
      receipt: {
        captureId: "capture_id",
        digest: "content_sha256",
        acceptedAt: "accepted_at_ms",
      },
    },
  };
  const mapping: ArchiveBundleMapping = {
    contract: "fixture-v1",
    version: 1,
    namespace: "chain",
    indexTable: "fixture_index",
    sources: {
      capture: "fixture_capture",
      pages: "fixture_pages",
      funds: "fixture_funds",
      holdings: "fixture_holdings",
      targets: "fixture_targets",
      completion: "fixture_completion",
    },
  };
  const catalog: BundleCatalogColumn[] = fields.map((field) => ({
    ...field,
    table: "fixture_index",
  }));
  const policies: Record<string, string> = Object.fromEntries(
    source.map((column) => [column.table, "bundled"]),
  );
  return {
    source,
    catalog,
    policies,
    contracts: { "fixture-v1": contract } as Record<
      string,
      ArchiveBundleContract
    >,
    mappings: [mapping],
  };
}

type Fixture = ReturnType<typeof fixture>;
const definition = (input: Fixture): ArchiveBundleContract =>
  input.contracts["fixture-v1"]!;
const association = (input: Fixture): ArchiveBundleMapping =>
  input.mappings[0]!;

describe("complete capture bundle archive mappings", () => {
  test("validates complete families, source/header/parent paths, nested fields and original receipts", () => {
    const input = fixture();
    assert.deepEqual(validateArchiveBundles(input), []);
    assert.equal(input.catalog.length, 27);
    assert.equal(Object.keys(definition(input).families).length, 6);
    assert.ok(input.catalog.every((field) => field.required));
  });

  test("empty child arrays remain represented by explicit zero-capable receipt counts", () => {
    const input = fixture();
    for (const family of ["funds", "holdings", "targets"] as const) {
      const count =
        definition(input).values[
          definition(input).families[family].count.manifestPath
        ];
      assert.equal(count?.kind, "integer");
      assert.ok(count && "min" in count && count.min === 0);
    }
    assert.deepEqual(validateArchiveBundles(input), []);
  });

  test("distinguishes per-parent array lengths from whole-capture counts and explicit global caps", () => {
    const input = fixture();
    const contract = definition(input);
    assert.equal(contract.arrays["capture.funds[].holdings[]"]!.max, 8);
    assert.equal(contract.families.holdings.count.bounds.max, 32);
    assert.deepEqual(validateArchiveBundles(input), []);
    // A smaller whole-capture cap is a separate contract assertion, not an
    // inference from either the source numeric type or one parent's length.
    contract.families.holdings.count.bounds.max = 12;
    contract.values["manifest.counts.holdings"] = integer(0, 12);
    assert.deepEqual(validateArchiveBundles(input), []);
    contract.families.holdings.count.bounds.max = 33;
    contract.values["manifest.counts.holdings"] = integer(0, 33);
    assert.match(
      validateArchiveBundles(input).join("\n"),
      /count binding for holdings/,
    );
  });

  test("rejects aliased columns, nested traversal and repeated index receipt roles", () => {
    const aliased = fixture();
    definition(aliased).families.capture.columns.height!.binding = {
      kind: "path",
      from: "row",
      path: "capture.capture_id",
    };
    assert.match(
      validateArchiveBundles(aliased).join("\n"),
      /different source columns share one value/,
    );
    const nested = fixture();
    definition(nested).families.capture.columns.page_count!.binding = {
      kind: "array-length",
      path: "capture.funds[].holdings[]",
    };
    assert.match(
      validateArchiveBundles(nested).join("\n"),
      /declared child array/,
    );
    const receipt = fixture();
    definition(receipt).index.receipt.digest = "capture_id";
    assert.match(
      validateArchiveBundles(receipt).join("\n"),
      /receipt bindings must be distinct/,
    );
  });

  test("rejects scalar parents and inconsistent array/object path declarations", () => {
    for (const path of [
      "capture.height.units",
      "capture.funds.hotkey",
      "capture.funds",
    ]) {
      const input = fixture();
      definition(input).values[path] = text();
      assert.match(
        validateArchiveBundles(input).join("\n"),
        /conflicting bundle path shape/,
        path,
      );
    }
    const arrayValue = fixture();
    definition(arrayValue).values["capture.funds[]"] = integer(0, 4);
    assert.match(
      validateArchiveBundles(arrayValue).join("\n"),
      /invalid value path/,
    );
  });

  test("does not infer a bundle policy, catalog table or deployment from definitions", () => {
    const input = fixture();
    input.mappings = [];
    const problems = validateArchiveBundles(input);
    assert.ok(
      problems.some((problem) => problem.includes("contract has no mapping")),
    );
    assert.equal(
      problems.filter((problem) =>
        problem.includes("policy has no complete bundle mapping"),
      ).length,
      6,
    );
    assert.deepEqual(
      validateArchiveBundles({
        source: [],
        catalog: [],
        policies: {},
        contracts: {},
        mappings: [],
      }),
      [],
    );
  });

  const failures: [string, (input: Fixture) => void, RegExp][] = [
    [
      "unknown contract",
      (input) => {
        association(input).contract = "missing";
      },
      /unknown bundle contract/,
    ],
    [
      "unknown contract version",
      (input) => {
        definition(input).version = 2;
      },
      /unsupported.*version/,
    ],
    [
      "incompatible mapping version",
      (input) => {
        association(input).version = 2;
      },
      /incompatible.*version/,
    ],
    [
      "missing source family",
      (input) => {
        Reflect.deleteProperty(association(input).sources, "holdings");
      },
      /missing \[holdings\]/,
    ],
    [
      "missing contract family",
      (input) => {
        Reflect.deleteProperty(definition(input).families, "completion");
      },
      /missing \[completion\]/,
    ],
    [
      "extra family",
      (input) => {
        Object.assign(association(input).sources, {
          current: "fixture_current",
        });
      },
      /extra \[current\]/,
    ],
    [
      "source table absent",
      (input) => {
        input.source = input.source.filter(
          (column) => column.table !== "fixture_targets",
        );
      },
      /source table is absent.*fixture_targets/,
    ],
    [
      "new source column",
      (input) => {
        input.source.push({
          table: "fixture_holdings",
          column: "new_quantity",
          udt: "numeric",
          nullable: false,
        });
      },
      /unmapped source column: fixture_holdings.new_quantity/,
    ],
    [
      "stale source column",
      (input) => {
        input.source = input.source.filter(
          (column) => column.column !== "height",
        );
      },
      /stale source column mapping.*height/,
    ],
    [
      "source type change",
      (input) => {
        input.source.find((column) => column.column === "quantity")!.udt =
          "float8";
      },
      /source type\/nullability changed/,
    ],
    [
      "source nullability change",
      (input) => {
        input.source.find(
          (column) => column.column === "first_block",
        )!.nullable = false;
      },
      /source type\/nullability changed/,
    ],
    [
      "source duplicate metadata",
      (input) => {
        input.source.push({ ...input.source[0]! });
      },
      /duplicate source column/,
    ],
    [
      "source claimed twice",
      (input) => {
        association(input).sources.targets = "fixture_holdings";
      },
      /source table is mapped more than once/,
    ],
    [
      "sensitive source policy",
      (input) => {
        input.policies.fixture_holdings = "sensitive";
      },
      /must explicitly use bundled policy/,
    ],
    [
      "nonexistent catalog",
      (input) => {
        input.catalog = [];
      },
      /index table is absent/,
    ],
    [
      "dropped catalog column",
      (input) => {
        input.catalog = input.catalog.filter(
          (field) => field.column !== "manifest_sha256",
        );
      },
      /index manifest_sha256 must have field ID/,
    ],
    [
      "changed field ID",
      (input) => {
        input.catalog[4]!.field_id = 99;
      },
      /index capture_id must have field ID 5/,
    ],
    [
      "changed exact type",
      (input) => {
        input.catalog[8]!.type = "int";
      },
      /runtime_spec_version.*type long/,
    ],
    [
      "changed requiredness",
      (input) => {
        input.catalog[13]!.required = false;
      },
      /accepted_at_ms.*required=true/,
    ],
    [
      "extra catalog column",
      (input) => {
        input.catalog.push({
          table: "fixture_index",
          column: "extra",
          field_id: 28,
          type: "string",
          required: true,
        });
      },
      /unmapped catalog column: extra/,
    ],
    [
      "duplicate catalog ID",
      (input) => {
        input.catalog[1]!.field_id = 1;
      },
      /duplicate catalog field/,
    ],
    [
      "duplicate expected field",
      (input) => {
        definition(input).index.fields.push({
          ...definition(input).index.fields[0]!,
        });
      },
      /invalid or duplicate index field/,
    ],
    [
      "duplicate catalog association",
      (input) => {
        input.mappings.push(structuredClone(association(input)));
      },
      /catalog table is assigned to more than one/,
    ],
    [
      "unprovisioned definition",
      (input) => {
        input.contracts.unused = structuredClone(definition(input));
      },
      /unused: bundle contract has no mapping/,
    ],
    [
      "missing value path",
      (input) => {
        Reflect.deleteProperty(definition(input).values, "capture.height");
      },
      /missing value definition.*height/,
    ],
    [
      "wrong capture origin",
      (input) => {
        definition(input).families.holdings.columns.capture_id!.binding = {
          kind: "path",
          from: "row",
          path: "capture.capture_id",
        };
      },
      /invalid row binding/,
    ],
    [
      "wrong parent origin",
      (input) => {
        definition(input).families.holdings.parent = "capture.pages[]";
      },
      /invalid row\/parent path/,
    ],
    [
      "nullable wire value",
      (input) => {
        definition(input).values["capture.height"] = decimal(true);
      },
      /no lossless representation.*height/,
    ],
    [
      "numeric falsely treated as bounded",
      (input) => {
        definition(input).values["capture.height"] = integer(0, 65535);
      },
      /base numeric alone does not prove integer bounds/,
    ],
    [
      "integer range narrowed",
      (input) => {
        definition(input).values["capture.funds[].targets[].weight"] = integer(
          0,
          255,
        );
      },
      /no lossless representation.*weight/,
    ],
    [
      "unsafe declared integer bound",
      (input) => {
        definition(input).families.targets.columns.weight!.integerBounds!.max =
          Number.MAX_SAFE_INTEGER + 1;
      },
      /no lossless representation.*weight/,
    ],
    [
      "missing bounded array",
      (input) => {
        Reflect.deleteProperty(
          definition(input).arrays,
          "capture.funds[].holdings[]",
        );
      },
      /count must reference a declared child array/,
    ],
    [
      "count outside source family",
      (input) => {
        definition(input).families.funds.columns.holdings_count!.binding = {
          kind: "array-length",
          path: "capture.pages[]",
        };
      },
      /count must reference a declared child array/,
    ],
    [
      "missing original receipt source binding",
      (input) => {
        definition(input).families.completion.columns.accepted_at!.binding = {
          kind: "path",
          from: "row",
          path: "receipt.accepted_at",
        };
      },
      /original completion receipt acceptedAt/,
    ],
    [
      "receipt bound to request metadata",
      (input) => {
        definition(input).receipt.acceptedAt = "request.generated_at";
      },
      /original completion receipt acceptedAt/,
    ],
    [
      "missing receipt index field",
      (input) => {
        definition(input).index.receipt.digest = "missing";
      },
      /original completion receipt digest/,
    ],
    [
      "repeated receipt roles",
      (input) => {
        definition(input).receipt.acceptedAt = "receipt.digest";
      },
      /receipt bindings must be distinct/,
    ],
    [
      "count from wrong manifest path",
      (input) => {
        definition(input).families.capture.count.manifestPath =
          "capture.height";
      },
      /original manifest\/index count binding/,
    ],
    [
      "count binding shared",
      (input) => {
        definition(input).families.targets.count = {
          ...definition(input).families.holdings.count,
        };
      },
      /count binding is shared/,
    ],
    [
      "count index uses float",
      (input) => {
        definition(input).index.fields.find(
          (field) => field.column === "target_count",
        )!.type = "double";
      },
      /original manifest\/index count binding for targets/,
    ],
    [
      "nullable count index",
      (input) => {
        definition(input).index.fields.find(
          (field) => field.column === "target_count",
        )!.required = false;
      },
      /original manifest\/index count binding for targets/,
    ],
    [
      "invalid path syntax",
      (input) => {
        definition(input).values["capture..height"] = decimal();
      },
      /invalid value path/,
    ],
    [
      "invalid array bounds",
      (input) => {
        definition(input).arrays["capture.pages[]"]!.min = -1;
      },
      /invalid bounded array/,
    ],
  ];
  for (const [name, mutate, expected] of failures) {
    test(`rejects ${name}`, () => {
      const input = fixture();
      mutate(input);
      assert.match(validateArchiveBundles(input).join("\n"), expected);
    });
  }

  test("accepts exact primitive representations and rejects unknown/lossy source types", () => {
    for (const [udt, value, valid] of [
      ["bool", { kind: "boolean", nullable: false }, true],
      ["varchar", text(), true],
      ["int2", integer(-32768, 32767), true],
      ["int4", integer(-(2 ** 31), 2 ** 31 - 1), true],
      ["int8", decimal(), true],
      ["int2", decimal(), true],
      ["int4", decimal(), true],
      ["int8", integer(0, Number.MAX_SAFE_INTEGER), false],
      ["float8", decimal(), false],
    ] as const) {
      const input = fixture();
      input.source.find((column) => column.column === "height")!.udt = udt;
      definition(input).families.capture.columns.height!.udt = udt;
      definition(input).values["capture.height"] = value;
      const problems = validateArchiveBundles(input);
      assert.equal(
        problems.length === 0,
        valid,
        `${udt}: ${problems.join("\n")}`,
      );
    }
  });

  test("requires all six families even when a source table is empty", () => {
    assert.deepEqual(BUNDLE_FAMILIES, [
      "capture",
      "pages",
      "funds",
      "holdings",
      "targets",
      "completion",
    ]);
    const input = fixture();
    Reflect.deleteProperty(association(input).sources, "targets");
    input.policies.fixture_targets = "transient";
    assert.match(
      validateArchiveBundles(input).join("\n"),
      /complete group.*targets/,
    );
  });
});
