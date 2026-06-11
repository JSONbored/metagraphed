import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { csvValue, toCsv, buildDatasetExports } from "../scripts/datasets.mjs";

describe("csvValue", () => {
  test("RFC-4180 quotes commas, quotes, and newlines; doubles quotes", () => {
    assert.equal(csvValue("plain"), "plain");
    assert.equal(csvValue("a,b"), '"a,b"');
    assert.equal(csvValue('he said "hi"'), '"he said ""hi"""');
    assert.equal(csvValue("line1\nline2"), '"line1\nline2"');
  });
  test("coerces null/undefined to empty and joins arrays", () => {
    assert.equal(csvValue(null), "");
    assert.equal(csvValue(undefined), "");
    assert.equal(csvValue(["a", "b"]), "a; b");
    assert.equal(csvValue(7), "7");
  });
});

describe("toCsv", () => {
  test("has a header row and quoted fields", () => {
    const rows = [
      { a: 1, b: "x,y" },
      { a: 2, b: null },
    ];
    assert.equal(toCsv(["a", "b"], rows), 'a,b\n1,"x,y"\n2,\n');
  });
});

describe("buildDatasetExports", () => {
  const input = {
    subnets: [
      { netuid: 7, slug: "allways", name: "Allways", categories: ["data"] },
    ],
    surfaces: [
      {
        id: "s1",
        netuid: 7,
        kind: "openapi",
        url: "https://x",
        probe: { status: "ok" },
      },
    ],
    providers: [{ id: "p1", name: "Prov", kind: "team" }],
    generatedAt: "1970-01-01T00:00:00.000Z",
    contractVersion: "2026-06-06.1",
  };

  test("emits one CSV per table and a manifest", () => {
    const { files, manifest } = buildDatasetExports(input);
    const paths = files.map((file) => file.relativePath).sort();
    assert.deepEqual(paths, [
      "datasets/providers.csv",
      "datasets/subnets.csv",
      "datasets/surfaces.csv",
    ]);
    assert.equal(
      files.every((file) => file.contentType === "text/csv; charset=utf-8"),
      true,
    );
    assert.equal(manifest.dataset_count, 3);
    assert.equal(manifest.generated_at, "1970-01-01T00:00:00.000Z");
    const subnets = manifest.datasets.find((d) => d.id === "subnets");
    assert.equal(subnets.rows, 1);
    assert.equal(subnets.path, "/datasets/subnets.csv");
  });

  test("flattens surface.probe.status and joins categories", () => {
    const { files } = buildDatasetExports(input);
    const surfacesCsv = files.find(
      (file) => file.relativePath === "datasets/surfaces.csv",
    ).body;
    assert.match(surfacesCsv, /probe_status/);
    assert.match(surfacesCsv, /ok/);
    const subnetsCsv = files.find(
      (file) => file.relativePath === "datasets/subnets.csv",
    ).body;
    assert.match(subnetsCsv, /allways/);
  });

  test("deterministic for fixed input", () => {
    assert.deepEqual(buildDatasetExports(input), buildDatasetExports(input));
  });
});
