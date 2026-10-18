import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import generatedManifest from "../apps/ui/public/logos/display/manifest.json" with { type: "json" };
import {
  isOgLogoSourcePath,
  parseLogoManifest,
  resolveOgLogo,
  verifyOgLogo,
} from "../src/og-logo-manifest.ts";
import { logoManifestFixture } from "./helpers/og-logo-fixture.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]).buffer;
const manifest = () => logoManifestFixture(PNG, "curated.webp");

afterEach(() => vi.restoreAllMocks());

test("owned originals and PNG sharing paths retain the complete content identity", () => {
  const data = manifest();
  const original = resolveOgLogo(
    "https://metagraph.sh/logos/curated.webp",
    data,
  );
  assert.equal(original.intent, "expected");
  assert.ok(original.intent === "expected" && original.qualified);
  assert.equal(original.sourcePath, "/logos/curated.webp");
  assert.equal(original.path, `/logos/${data.entries[0].sharing_path}`);
  assert.equal(original.identity, original.path);
  assert.ok(original.identity.includes(data.entries[0].source_sha256));
  assert.ok(original.identity.includes(data.entries[0].sharing_sha256));
  assert.deepEqual(resolveOgLogo(original.path, data), original);
  assert.deepEqual(resolveOgLogo(original.url, data), original);
  assert.deepEqual(resolveOgLogo("/logos/curated.webp", data), original);
  const changed = logoManifestFixture(PNG, "curated.webp", "b".repeat(64));
  assert.notDeepEqual(resolveOgLogo("/logos/curated.webp", changed), original);
});

test("committed sharing metadata is usable without runtime asset reads", () => {
  assert.ok(parseLogoManifest(generatedManifest));
  const first = generatedManifest.entries[0];
  const logo = resolveOgLogo(`/logos/${first.source_path}`);
  assert.ok(logo.intent === "expected" && logo.qualified);
});

test("only actual absence is absent; missing and older manifests stay expected", () => {
  for (const value of [undefined, null, "", "  "])
    assert.deepEqual(resolveOgLogo(value), { intent: "absent" });
  for (const data of [null, { ...manifest(), version: 1 }, { entries: [] }])
    assert.deepEqual(resolveOgLogo("/logos/curated.webp", data), {
      intent: "expected",
      qualified: false,
      sourcePath: "/logos/curated.webp",
    });
  assert.deepEqual(resolveOgLogo("/logos/missing.ico", manifest()), {
    intent: "expected",
    qualified: false,
    sourcePath: "/logos/missing.ico",
  });
});

test.each([
  "https://other.example/logos/curated.webp",
  "http://metagraph.sh/logos/curated.webp",
  "https://metagraph.sh:8443/logos/curated.webp",
  "https://name@metagraph.sh/logos/curated.webp",
  "https://:secret@metagraph.sh/logos/curated.webp",
  "/logos/curated.webp?source=other",
  "/logos/curated.webp#other",
  "https://[",
])("untrusted logo location remains unqualified: %s", (value) => {
  assert.deepEqual(resolveOgLogo(value, manifest()), {
    intent: "expected",
    qualified: false,
    sourcePath: null,
  });
});

test("ICO and GIF originals use the same validated PNG derivative contract", () => {
  for (const source of ["icon.ico", "animated.gif"]) {
    const data = logoManifestFixture(PNG, source);
    const logo = resolveOgLogo(`/logos/${source}`, data);
    assert.ok(logo.intent === "expected" && logo.qualified);
    assert.ok(logo.path.endsWith(".png"));
  }
});

test("duplicate source records fail closed while identical bytes can share artwork", () => {
  const data = manifest();
  assert.equal(
    parseLogoManifest({ ...data, entries: [...data.entries, data.entries[0]] }),
    null,
  );
  data.entries.push({ ...data.entries[0], source_path: "alias.webp" });
  const original = resolveOgLogo("/logos/curated.webp", data);
  const alias = resolveOgLogo("/logos/alias.webp", data);
  assert.ok(original.intent === "expected" && original.qualified);
  assert.ok(alias.intent === "expected" && alias.qualified);
  assert.equal(original.identity, alias.identity);
});

test.each([
  ["sharing_bytes", 10],
  ["sharing_width", 2],
  ["sharing_height", 2],
] as const)("shared artwork cannot declare conflicting %s", (field, value) => {
  const data = manifest();
  const original = data.entries[0];
  const alias = { ...original, source_path: "alias.webp", [field]: value };
  const forward = { ...data, entries: [original, alias] };
  const reverse = { ...data, entries: [alias, original] };
  assert.equal(parseLogoManifest(forward), null);
  assert.equal(parseLogoManifest(reverse), null);
});

test("builder and runtime accept exactly the same source paths", () => {
  for (const path of ["curated.webp", "cache/identity.ico", "animated.gif"])
    assert.equal(isOgLogoSourcePath(path), true);
  for (const path of [
    "Curated.png",
    "curated_mark.png",
    "../curated.png",
    "display/curated.png",
    "sharing/curated.png",
  ])
    assert.equal(isOgLogoSourcePath(path), false);
});

test("invalid root and sharing policies cannot qualify any entry", () => {
  for (const value of [undefined, null, false, "manifest", [], {}])
    assert.equal(parseLogoManifest(value), null);
  const data = manifest();
  for (const sharing of [
    null,
    [],
    { ...data.sharing, version: 2 },
    { ...data.sharing, format: "webp" },
    { ...data.sharing, max_dimension: 512 },
    { ...data.sharing, max_bytes: 1048576 },
  ])
    assert.equal(parseLogoManifest({ ...data, sharing }), null);
  assert.equal(parseLogoManifest({ ...data, entries: {} }), null);
});

test.each([
  ["source_path", null],
  ["source_path", "../escape.png"],
  ["source_path", "display/curated.png"],
  ["source_path", "sharing/curated.png"],
  ["source_sha256", null],
  ["source_sha256", "A".repeat(64)],
  ["sharing_sha256", null],
  ["sharing_sha256", "invalid"],
  ["sharing_path", "sharing/v1/unrelated.png"],
  ["sharing_bytes", 8.5],
  ["sharing_bytes", 7],
  ["sharing_bytes", 524289],
  ["sharing_width", 1.5],
  ["sharing_width", 0],
  ["sharing_width", 257],
  ["sharing_height", 1.5],
  ["sharing_height", 0],
  ["sharing_height", 257],
] as const)("invalid sharing entry %s=%s fails closed", (field, value) => {
  const data = manifest();
  assert.equal(
    parseLogoManifest({
      ...data,
      entries: [{ ...data.entries[0], [field]: value }],
    }),
    null,
  );
});

test("null and array entries cannot qualify an otherwise valid manifest", () => {
  for (const entry of [null, []])
    assert.equal(parseLogoManifest({ ...manifest(), entries: [entry] }), null);
});

test("completion requires the exact PNG bytes named by the manifest", async () => {
  const expected = resolveOgLogo("/logos/curated.webp", manifest());
  const logo = { bytes: PNG, contentType: " IMAGE/PNG ; charset=binary" };
  assert.equal(await verifyOgLogo(logo, expected), true);
  assert.equal(await verifyOgLogo(null, expected), false);
  assert.equal(await verifyOgLogo(logo, { intent: "absent" }), false);
  assert.equal(
    await verifyOgLogo(logo, resolveOgLogo("/logos/missing.png", manifest())),
    false,
  );
  assert.equal(
    await verifyOgLogo({ ...logo, contentType: "image/jpeg" }, expected),
    false,
  );
  assert.equal(
    await verifyOgLogo({ ...logo, bytes: PNG.slice(0, 8) }, expected),
    false,
  );
  const invalid = new Uint8Array(PNG.slice(0));
  invalid[0] = 0;
  assert.equal(
    await verifyOgLogo({ ...logo, bytes: invalid.buffer }, expected),
    false,
  );
  invalid[0] = 137;
  invalid[8] = 2;
  assert.equal(
    await verifyOgLogo({ ...logo, bytes: invalid.buffer }, expected),
    false,
  );
  const digest = vi.spyOn(crypto.subtle, "digest");
  digest.mockRejectedValueOnce(new Error("unavailable"));
  assert.equal(await verifyOgLogo(logo, expected), false);
});
