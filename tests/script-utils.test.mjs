import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import {
  evaluateArtifactBudgets,
  summarizeArtifactBudgets,
} from "../scripts/artifact-budgets.mjs";
import {
  buildEndpointPoolArtifact,
  buildRpcEndpointArtifact,
  buildTimestamp,
  classifyNativeName,
  flattenSurfaces,
  hashJson,
  isHtmlContentType,
  isJsonContentType,
  isUnsafeHostname,
  isUnsafeUrl,
  isUnsafeUrlResolved,
  isValidUrl,
  listJsonFiles,
  listJsonFilesRecursive,
  loadCandidates,
  loadVerification,
  nativeDisplayName,
  nativeNameQuality,
  normalizePublicUrl,
  readJson,
  registrySurfaceKey,
  repoRoot,
  sha256Hex,
  slugify,
  stableStringify,
  writeJson,
} from "../scripts/lib.mjs";
import { buildCanonicalOpenApiArtifact } from "../scripts/openapi-components.mjs";
import {
  buildIssueIntakeReport,
  classifyPrScope,
  extractSingleCandidate,
  issueLabels,
  normalizeAuth,
  normalizeChangedFiles,
  normalizeGitHubLogin,
  normalizeKind,
  parseIssueFields,
  unsafeTextReasons,
  validateCandidateForSubmission,
  validateSubmissionProvenance,
} from "../scripts/submission-policy.mjs";

const native = {
  subnets: [
    { netuid: 7, name: "Allways" },
    { netuid: 74, name: "Gittensor" },
  ],
};
const providers = [{ id: "allways" }, { id: "gittensor" }];

describe("script utility contracts", () => {
  test("reads, writes, and lists JSON files deterministically", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "metagraphed-test-"));
    try {
      const nested = path.join(dir, "nested");
      await writeJson(path.join(dir, "b.json"), { b: 1, a: 2 });
      await writeJson(path.join(nested, "a.json"), { ok: true });
      await writeJson(path.join(dir, "ignore.txt"), { ignored: true });

      assert.deepEqual(await readJson(path.join(dir, "b.json")), {
        a: 2,
        b: 1,
      });
      assert.deepEqual(
        (await listJsonFiles(dir)).map((file) => path.basename(file)),
        ["b.json"],
      );
      assert.deepEqual(
        (await listJsonFilesRecursive(dir)).map((file) =>
          path.relative(dir, file).replace(/\\/g, "/"),
        ),
        ["b.json", "nested/a.json"],
      );
      assert.deepEqual(await listJsonFiles(path.join(dir, "missing")), []);
      assert.deepEqual(
        await listJsonFilesRecursive(path.join(dir, "missing")),
        [],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads checked-in candidates and verification fallback contracts", async () => {
    const candidates = await loadCandidates();
    const verification = await loadVerification();

    assert.equal(candidates.length > 0, true);
    assert.equal(verification.schema_version, 1);
    assert.equal(path.basename(repoRoot), "metagraphed");
  });

  test("normalizes names, URLs, keys, hashes, and slugs deterministically", () => {
    assert.deepEqual(classifyNativeName("unknown", 87), {
      raw_name: "unknown",
      quality: "placeholder",
    });
    assert.equal(classifyNativeName("", 1).quality, "empty");
    assert.equal(classifyNativeName("Luminar Network", 87).quality, "chain");
    assert.equal(
      nativeNameQuality({ raw_name: "Subnet 42", netuid: 42 }),
      "placeholder",
    );
    assert.equal(
      nativeDisplayName({ raw_name: "unknown", netuid: 87 }, "Luminar Network"),
      "Luminar Network",
    );

    assert.equal(isValidUrl("https://metagraph.sh"), true);
    assert.equal(isValidUrl("ftp://metagraph.sh"), false);
    assert.equal(isValidUrl("not a url"), false);
    assert.equal(isUnsafeUrl("http://127.0.0.1:9944"), true);
    assert.equal(isUnsafeUrl("ftp://metagraph.sh"), true);
    assert.equal(isUnsafeUrl("http://172.16.0.1"), true);
    assert.equal(isUnsafeUrl("http://[::1]"), true);
    assert.equal(isUnsafeUrl("http://[fd00::1]"), true);
    assert.equal(isUnsafeUrl("http://[fe80::1]"), true);
    assert.equal(isUnsafeUrl("http://[::ffff:127.0.0.1]"), true);
    assert.equal(isUnsafeHostname("[::1]"), true);
    assert.equal(isUnsafeHostname("::ffff:7f00:1"), true);
    assert.equal(isUnsafeUrl("not a url"), true);
    assert.equal(isUnsafeUrl("https://metagraph.sh"), false);
    assert.equal(
      normalizePublicUrl("metagraph.sh/docs/"),
      "https://metagraph.sh/docs",
    );
    assert.equal(
      normalizePublicUrl("<https://metagraph.sh/docs/#section>"),
      "https://metagraph.sh/docs",
    );
    assert.equal(normalizePublicUrl(""), null);
    assert.equal(normalizePublicUrl(null), null);
    assert.equal(normalizePublicUrl("notaurl"), null);
    assert.equal(normalizePublicUrl("http://10.0.0.1"), null);
    assert.equal(isJsonContentType("application/openapi+json"), true);
    assert.equal(isHtmlContentType("text/html; charset=utf-8"), true);
    assert.equal(sha256Hex("metagraphed").length, 64);
    assert.equal(buildTimestamp(), "1970-01-01T00:00:00.000Z");

    assert.equal(
      stableStringify({ b: 1, a: { d: 2, c: 3 } }),
      '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}',
    );
    assert.equal(hashJson({ b: 1, a: 2 }), hashJson({ a: 2, b: 1 }));
    assert.equal(
      registrySurfaceKey({
        netuid: 7,
        kind: "docs",
        url: "https://docs.all-ways.io/",
      }),
      "7|docs|https://docs.all-ways.io/",
    );
    assert.equal(slugify("TAO / Metagraph: Build"), "tao-metagraph-build");
  });

  test("resolves hostnames before treating probe URLs as safe", async () => {
    const privateResolver = async () => [
      { address: "192.168.1.10", family: 4 },
    ];
    const publicResolver = async () => [
      { address: "93.184.216.34", family: 4 },
    ];

    assert.equal(
      await isUnsafeUrlResolved("https://metadata.example", privateResolver),
      true,
    );
    assert.equal(
      await isUnsafeUrlResolved("https://metagraph.example", publicResolver),
      false,
    );
  });

  test("builds RPC endpoint and pool artifacts from surface health", () => {
    const surfaces = flattenSurfaces([
      {
        netuid: 0,
        slug: "root",
        name: "Root",
        surfaces: [
          {
            id: "root-rpc",
            kind: "subtensor-rpc",
            url: "https://rpc.example.com",
            provider: "example",
            authority: "provider-claimed",
            auth_required: false,
            public_safe: true,
            probe: { method: "chain_getHeader" },
          },
          {
            id: "root-docs",
            kind: "docs",
            url: "https://docs.example.com",
            provider: "example",
            authority: "provider-claimed",
            auth_required: false,
            public_safe: true,
          },
          {
            id: "root-wss",
            kind: "subtensor-wss",
            url: "wss://rpc.example.com",
            provider: "example",
            authority: "provider-claimed",
            auth_required: true,
            public_safe: true,
          },
          {
            id: "root-failed-rpc",
            kind: "subtensor-rpc",
            url: "https://failed.example.com",
            provider: "failed",
            authority: "provider-claimed",
            auth_required: false,
            public_safe: true,
          },
        ],
      },
    ]);
    const rpc = buildRpcEndpointArtifact({
      surfaces,
      healthSurfaces: [
        {
          surface_id: "root-rpc",
          status: "ok",
          classification: "live",
          latency_ms: 50,
          archive_support: true,
          latest_block: 100,
          methods_supported: { chain_getHeader: true, rpc_methods: true },
          verified_at: "1970-01-01T00:00:00.000Z",
        },
        {
          surface_id: "root-wss",
          status: "degraded",
          classification: "transient",
          latency_ms: 2500,
          methods_supported: ["chain_getHeader", "system_health"],
          last_checked: "1970-01-01T00:00:00.000Z",
        },
        {
          surface_id: "root-failed-rpc",
          status: "failed",
          classification: "dead",
          latency_ms: null,
        },
      ],
      generatedAt: "1970-01-01T00:00:00.000Z",
      contractVersion: "test",
      source: "fixture",
    });

    assert.equal(rpc.summary.endpoint_count, 3);
    assert.equal(rpc.summary.archive_supported_count, 1);
    assert.equal(rpc.endpoints[0].method_tested, "chain_getHeader");

    const pools = buildEndpointPoolArtifact({
      generatedAt: "1970-01-01T00:00:00.000Z",
      contractVersion: "test",
      rpcArtifact: rpc,
    });
    assert.equal(pools.disabled_proxy_contract.enabled, false);
    assert.equal(
      pools.pools.find((pool) => pool.id === "finney-rpc").eligible_count,
      1,
    );
    assert.equal(
      pools.pools.find((pool) => pool.id === "finney-archive").eligible_count,
      1,
    );
    assert.equal(
      pools.pools.find((pool) => pool.id === "finney-wss").eligible_count,
      0,
    );
  });

  test("evaluates artifact budgets with wildcard matching", () => {
    const results = evaluateArtifactBudgets([
      { path: "candidates.json", size_bytes: 100 },
      { path: "health/history/2026-06-06.json", size_bytes: 500_000 },
      { path: "custom.json", size_bytes: 1_500_000 },
    ]);

    assert.deepEqual(
      results.map((result) => result.status),
      ["ok", "warn", "fail"],
    );
    assert.deepEqual(summarizeArtifactBudgets(results), {
      fail_count: 1,
      ok_count: 1,
      warn_count: 1,
    });
  });

  test("loads canonical OpenAPI component schemas", async () => {
    const openapi = await buildCanonicalOpenApiArtifact(
      "1970-01-01T00:00:00.000Z",
    );

    assert.equal(openapi.openapi, "3.1.0");
    assert.equal(Boolean(openapi.components.schemas.ApiIndexArtifact), true);
    assert.equal(
      openapi.components.schemas.GeneratedOpenApiMarker.properties.generated_at
        .const,
      "1970-01-01T00:00:00.000Z",
    );
  });
});

describe("submission policy helpers", () => {
  test("parses and normalizes contributor intake values", () => {
    const fields = parseIssueFields(
      [
        "### Netuid",
        "7",
        "### Rate limits or access notes",
        "_No response_",
      ].join("\n\n"),
    );
    assert.equal(fields.netuid, "7");
    assert.equal(fields["rate limits or access notes"], "");
    assert.equal(normalizeKind("docs"), "docs");
    assert.equal(normalizeKind("made-up"), null);
    assert.deepEqual(normalizeAuth("no"), { value: false, manualReason: null });
    assert.equal(
      normalizeAuth("yes").manualReason,
      "authenticated interfaces require review",
    );
    assert.equal(normalizeAuth("unknown").value, false);
    assert.equal(normalizeAuth("maybe").value, null);
    assert.deepEqual(issueLabels({ labels: ["b", { name: "a" }, {}] }), [
      "a",
      "b",
    ]);
    assert.equal(normalizeGitHubLogin("@JSONbored"), "jsonbored");
    assert.equal(
      normalizeGitHubLogin("https://github.com/JSONbored/"),
      "jsonbored",
    );
    assert.deepEqual(normalizeChangedFiles("b\n./a\n"), ["a", "b"]);
  });

  test("flags invalid candidate documents and unsafe submission text", () => {
    assert.equal(
      classifyPrScope([
        "registry/candidates/community/a.json",
        "registry/candidates/community/b.json",
      ]).errors[0].category,
      "unsupported-shape",
    );
    assert.equal(
      extractSingleCandidate(null).errors[0].category,
      "unsupported-shape",
    );
    assert.equal(
      extractSingleCandidate({ schema_version: 2, candidates: [] }).errors
        .length,
      2,
    );
    assert.equal(
      unsafeTextReasons("github_pat_abcdefghijklmnopqrstuvwxyz123456 token")
        .length,
      1,
    );
    assert.equal(
      validateSubmissionProvenance({
        submitter: "jsonbored",
        document: {
          submission: {
            submitted_by: "someone-else",
            submitted_by_url: "https://github.com/someone-else",
          },
        },
      }).some((error) => error.message.includes("must match")),
      true,
    );
    assert.equal(
      validateSubmissionProvenance({
        submitter: null,
        document: { submission: {} },
      }).length,
      2,
    );
  });

  test("validates candidate submission edge cases", () => {
    const baseCandidate = {
      schema_version: 1,
      id: "candidate-one",
      netuid: 7,
      state: "schema-valid",
      name: "Candidate one",
      kind: "docs",
      url: "docs.all-ways.io/path/",
      source_url: "https://docs.all-ways.io/source/",
      source_type: "community-pr-intake",
      source_tier: "community-docs",
      confidence: "medium",
      provider: "allways",
      auth_required: false,
      public_safe: true,
    };

    const valid = validateCandidateForSubmission({
      candidate: baseCandidate,
      document: {
        submission: {
          submitted_by: "jsonbored",
          submitted_by_url: "https://github.com/jsonbored",
        },
      },
      submitter: "jsonbored",
      native,
      providers,
      existingCandidates: [],
      existingSubnets: [],
    });
    assert.equal(valid.errors.length, 0);
    assert.equal(valid.warnings.length, 2);

    const invalid = validateCandidateForSubmission({
      candidate: {
        schema_version: 2,
        id: "Bad ID",
        netuid: 999,
        kind: "bad-kind",
        url: "http://127.0.0.1",
        source_url: "",
        provider: "missing",
        public_safe: false,
        state: "maintainer-review",
        auth_required: true,
        source_tier: "native-chain",
        source_type: "random",
      },
      document: { submission: {} },
      submitter: null,
      native,
      providers,
      existingCandidates: [],
      existingSubnets: [],
    });
    assert.equal(invalid.errors.length >= 10, true);
    assert.equal(invalid.manual_reasons.length >= 2, true);
    assert.equal(invalid.warnings.length, 1);

    const duplicate = validateCandidateForSubmission({
      candidate: {
        ...baseCandidate,
        url: "https://docs.all-ways.io/path",
      },
      document: {
        submission: {
          submitted_by: "jsonbored",
          submitted_by_url: "https://github.com/jsonbored",
        },
      },
      submitter: "jsonbored",
      native,
      providers,
      existingCandidates: [{ ...baseCandidate, id: "other-candidate" }],
      existingSubnets: [
        {
          netuid: 7,
          slug: "allways",
          name: "Allways",
          surfaces: [
            {
              id: "curated-docs",
              netuid: 7,
              kind: "docs",
              url: "https://docs.all-ways.io/path",
            },
          ],
        },
      ],
    });
    assert.equal(
      duplicate.errors.filter((error) => error.category === "duplicate").length,
      2,
    );
  });

  test("builds issue intake states for valid, manual, and invalid submissions", () => {
    const validBody = [
      "### Netuid",
      "7",
      "### Interface kind",
      "docs",
      "### Public URL",
      "https://docs.all-ways.io/community",
      "### Source URL",
      "https://docs.all-ways.io/how-it-works.html",
      "### Provider or team",
      "allways",
      "### Does this interface require authentication?",
      "no",
    ].join("\n\n");
    const valid = buildIssueIntakeReport({
      issue: {
        number: 7,
        title: "interface: docs",
        user: { login: "jsonbored" },
        labels: [{ name: "interface-submission" }],
        body: validBody,
      },
      native,
      providers,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });
    assert.equal(valid.public_state, "submit_pr");
    assert.equal(valid.import_allowed, false);

    const manual = buildIssueIntakeReport({
      issue: {
        number: 8,
        title: "interface: rpc",
        user: { login: "jsonbored" },
        labels: [],
        body: validBody.replace("docs", "subtensor-rpc"),
      },
      native,
      providers,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });
    assert.equal(manual.public_state, "manual_review");

    const authManual = buildIssueIntakeReport({
      issue: {
        number: 10,
        title: "interface: authenticated docs",
        user: { login: "jsonbored" },
        labels: [],
        body: validBody.replace("no", "yes"),
      },
      native,
      providers,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });
    assert.equal(authManual.public_state, "manual_review");

    const invalid = buildIssueIntakeReport({
      issue: {
        number: 9,
        title: "bad",
        user: { login: "jsonbored" },
        labels: [],
        body: "### Netuid\n999",
      },
      native,
      providers,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });
    assert.equal(invalid.public_state, "fix_required");
    assert.equal(invalid.candidate, null);
  });
});
