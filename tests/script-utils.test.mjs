import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import {
  evaluateArtifactBudgets,
  summarizeArtifactBudgets,
} from "../scripts/artifact-budgets.mjs";
import {
  buildEndpointResourceArtifact,
  buildEndpointPoolArtifact,
  buildEndpointIncidentArtifact,
  buildRpcEndpointArtifact,
  buildTimestamp,
  classifyNativeName,
  artifactFilePath,
  artifactOutputPath,
  createLocalArtifactEnv,
  flattenSurfaces,
  formatRepositoryJson,
  hashJson,
  isCredentialedUrl,
  isHtmlContentType,
  isJsonContentType,
  isUnsafeResolvedUrl,
  isUnsafeUrl,
  isValidUrl,
  listJsonFiles,
  listJsonFilesRecursive,
  loadCandidates,
  loadDetailedVerification,
  loadVerification,
  nativeDisplayName,
  nativeNameQuality,
  normalizePublicUrl,
  readJson,
  redactCredentialedUrl,
  redactCredentialedUrls,
  registrySurfaceKey,
  repoRoot,
  isReviewableReadmeLink,
  selectReviewableReadmeLinks,
  sha256Hex,
  slugify,
  stableStringify,
  writeJson,
  writeRepositoryJson,
} from "../scripts/lib.mjs";
import {
  ARTIFACT_STORAGE_TIERS,
  artifactRelativePath,
  artifactStorageTierForPath,
  artifactStorageTierForRelativePath,
  isR2OnlyArtifactPath,
  schemaDetailArtifactRelativePath,
} from "../src/artifact-storage.mjs";
import { buildCanonicalOpenApiArtifact } from "../scripts/openapi-components.mjs";
import { renderCurationBrief } from "../scripts/curation-brief.mjs";
import { renderEndpointOpsBrief } from "../scripts/endpoint-ops-brief.mjs";
import { generateBaselineOverlaySet } from "../scripts/generated-overlays.mjs";
import { classifyHttpProbe } from "../scripts/http-probe-classification.mjs";
import { preservePreviousGithubMetadata } from "../scripts/verification-quality.mjs";
import {
  buildIssueIntakeReport,
  buildEndpointStatusReportIntakeReport,
  buildProviderProfileIntakeReport,
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
import { submissionFormattingErrors } from "../scripts/submission-formatting.mjs";

const native = {
  subnets: [
    { netuid: 7, name: "Allways" },
    { netuid: 74, name: "Gittensor" },
  ],
};
const providers = [{ id: "allways" }, { id: "gittensor" }];

describe("script utility contracts", () => {
  test("classifies redirect-limit probes as unsupported", () => {
    assert.equal(
      classifyHttpProbe(
        {
          ok: false,
          error: "redirect limit exceeded",
          redirect_target: "https://example.com/api/",
          status_code: 308,
        },
        {
          kind: "subnet-api",
        },
      ),
      "unsupported",
    );
  });

  test("preserves previous GitHub metadata when source-repo API enrichment degrades", () => {
    const current = {
      candidate_id: "sn-1-native-chain-github",
      classification: "live",
      confidence_score: 45,
      kind: "source-repo",
      quality_signals: {
        public_safe: true,
        source_tier: "native-chain",
      },
      status: "ok",
    };
    const previousByCandidate = new Map([
      [
        "sn-1-native-chain-github",
        {
          candidate_id: "sn-1-native-chain-github",
          classification: "live",
          confidence_score: 80,
          kind: "source-repo",
          quality_signals: {
            archived: false,
            has_default_branch: true,
            has_recent_push_metadata: true,
            public_safe: true,
            source_tier: "native-chain",
          },
          status: "ok",
        },
      ],
    ]);

    const preserved = preservePreviousGithubMetadata(
      current,
      previousByCandidate,
    );

    assert.equal(preserved.confidence_score, 80);
    assert.deepEqual(preserved.quality_signals, {
      archived: false,
      has_default_branch: true,
      has_recent_push_metadata: true,
      public_safe: true,
      source_tier: "native-chain",
    });
  });

  test("preserves previous healthy verification when a candidate probe is retryable", () => {
    const current = {
      candidate_id: "sn-29-subnetradar-dashboard",
      classification: "timeout",
      confidence_score: 9,
      content_type: null,
      error: "probe-failed",
      kind: "dashboard",
      quality_signals: {
        public_safe: true,
        source_tier: "third-party-index",
        transient_failure: true,
      },
      status: "failed",
    };
    const previousByCandidate = new Map([
      [
        "sn-29-subnetradar-dashboard",
        {
          candidate_id: "sn-29-subnetradar-dashboard",
          classification: "live",
          confidence_score: 77,
          content_type: "text/html; charset=utf-8",
          error: null,
          kind: "dashboard",
          quality_signals: {
            content_type_matches_kind: true,
            public_safe: true,
            source_tier: "third-party-index",
            transient_failure: false,
          },
          status: "ok",
        },
      ],
    ]);

    const preserved = preservePreviousGithubMetadata(
      current,
      previousByCandidate,
    );

    assert.equal(preserved.classification, "live");
    assert.equal(preserved.status, "ok");
    assert.equal(preserved.confidence_score, 77);
    assert.equal(preserved.content_type, "text/html; charset=utf-8");
    assert.equal(preserved.quality_signals.transient_failure, false);
  });

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

  test("formats contributor JSON with repository style", async () => {
    const document = {
      schema_version: 1,
      source_urls: ["https://docs.all-ways.io/how-it-works.html"],
    };
    const formatted = await formatRepositoryJson(document);

    assert.match(
      formatted,
      /"source_urls": \["https:\/\/docs\.all-ways\.io\/how-it-works\.html"\]/,
    );
    assert.equal(formatted.endsWith("\n"), true);
    assert.deepEqual(
      await submissionFormattingErrors([
        {
          file: "registry/candidates/community/example.json",
          raw: `${JSON.stringify(document, null, 2)}\n`,
          document,
        },
      ]),
      [
        "registry/candidates/community/example.json is not formatted with the repository JSON style; run Prettier or regenerate it with npm run candidate:new/provider:new",
      ],
    );
    assert.deepEqual(
      await submissionFormattingErrors([
        {
          file: "registry/candidates/community/example.json",
          raw: formatted,
          document,
        },
      ]),
      [],
    );

    const dir = await mkdtemp(path.join(os.tmpdir(), "metagraphed-json-"));
    try {
      const filePath = path.join(dir, "candidate.json");
      await writeRepositoryJson(filePath, document);
      assert.equal(await readFile(filePath, "utf8"), formatted);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("renders a contributor curation brief from review artifacts", () => {
    const brief = renderCurationBrief({
      coverage: {
        active_netuids: 129,
        application_subnets: 128,
        curated_overlays: 129,
        native_only: 0,
        surfaces: 853,
        probed_surfaces: 852,
        candidates: 1772,
      },
      profile_summary: {
        average_completeness_score: 49,
        by_level: {
          "identity-partial": 38,
          operational: 46,
        },
        critical_gap_counts: {
          "missing-openapi": 81,
          "missing-source-repo": 44,
        },
      },
      lowest_completeness: [
        {
          netuid: 27,
          name: "Nodexo",
          completeness_score: 20,
          suggested_next_action:
            "submit official docs, website, or source repository evidence",
          gaps: ["missing-source-repo", "missing-website"],
        },
      ],
      highest_gap_priority: [
        {
          netuid: 33,
          name: "ReadyAI",
          priority_score: 93,
          suggested_next_action:
            "review promoted surfaces and mark maintainer-reviewed where provenance is strong",
          missing_kinds: ["website", "openapi"],
        },
      ],
      adapter_candidates: [
        {
          netuid: 64,
          name: "Chutes",
          adapter_score: 72,
          surface_kinds: ["data-artifact", "subnet-api"],
        },
      ],
      manual_review_kinds: ["provider profile", "archive endpoint"],
    });

    assert.match(brief, /Metagraphed Curation Brief/);
    assert.match(brief, /Active Finney netuids: 129/);
    assert.match(brief, /Profile levels: identity-partial 38, operational 46/);
    assert.match(
      brief,
      /Critical gaps: missing-openapi 81, missing-source-repo 44/,
    );
    assert.match(brief, /SN27 Nodexo - score 20/);
    assert.match(brief, /SN33 ReadyAI - priority 93/);
    assert.match(brief, /SN64 Chutes - score 72/);
    assert.match(brief, /Health, uptime, latency, incidents/);
  });

  test("renders an endpoint operations brief from pool artifacts", () => {
    const brief = renderEndpointOpsBrief({
      endpoint_summary: {
        endpoint_count: 853,
        monitored_count: 852,
        pool_eligible_count: 6,
        by_status: { degraded: 2, ok: 849, unknown: 2 },
        by_layer: {
          "bittensor-base": 6,
          "subnet-app": 232,
        },
        by_publication_state: {
          monitored: 846,
          "pool-eligible": 6,
          verified: 1,
        },
      },
      rpc_summary: {
        endpoint_count: 6,
        ok_count: 6,
        archive_supported_count: 6,
        providers: ["nodies", "onfinality", "opentensor"],
      },
      pools: [
        {
          id: "finney-rpc",
          kind: "subtensor-rpc",
          endpoint_count: 2,
          eligible_count: 2,
          best_endpoint_id: "endpoint-onfinality-finney-rpc",
          top_endpoints: [
            "onfinality/endpoint-onfinality-finney-rpc (ok, 607ms, score 89)",
          ],
        },
      ],
      provider_scores: [
        {
          provider: "onfinality",
          average_score: 89,
          endpoint_count: 2,
          ok_count: 2,
          pool_eligible_count: 2,
        },
      ],
      active_incidents: [
        {
          netuid: 33,
          subnet_name: "ReadyAI",
          kind: "data-artifact",
          status: "degraded",
          reason: "dead",
          provider: "taomarketcap",
          endpoint_id: "endpoint-sn-33-data",
        },
      ],
      disabled_proxy_contract: {
        enabled: false,
        feature_flag: "METAGRAPH_ENABLE_RPC_PROXY",
        allowed_methods: ["chain_getHeader"],
        denied_method_patterns: ["author_"],
        waf_required: true,
        rate_limit_required: true,
      },
    });

    assert.match(brief, /Metagraphed Endpoint Operations Brief/);
    assert.match(brief, /Endpoint resources: 853/);
    assert.match(brief, /finney-rpc \(subtensor-rpc\) - 2\/2 eligible/);
    assert.match(brief, /onfinality - score 89; ok 2\/2/);
    assert.match(brief, /SN33 ReadyAI data-artifact - degraded\/dead/);
    assert.match(brief, /Enabled: false/);
    assert.match(brief, /probe-derived only/);
  });

  test("refresh pipeline persists candidate discovery timestamps", async () => {
    const source = await readFile(
      path.join(repoRoot, "scripts/pipeline.mjs"),
      "utf8",
    );

    assert.match(source, /METAGRAPH_DISCOVERY_OBSERVED_AT:\s*refreshTimestamp/);
    assert.match(source, /METAGRAPH_PERSIST_DISCOVERY_OBSERVED_AT:\s*"1"/);
  });

  test("README discovery keeps project-affiliated links and collapses generic noise", () => {
    const links = [
      {
        classification: { kind: "docs", label: "docs" },
        label: "Bittensor docs",
        url: "https://docs.bittensor.com/miners",
      },
      {
        classification: { kind: "docs", label: "docs" },
        label: "Install",
        url: "https://docs.exampleproject.ai/install",
      },
      {
        classification: { kind: "docs", label: "docs" },
        label: "Advanced",
        url: "https://docs.exampleproject.ai/advanced",
      },
      {
        classification: { kind: "openapi", label: "OpenAPI surface" },
        label: "API",
        url: "https://api.exampleproject.ai/openapi.json",
      },
      {
        classification: { kind: "dashboard", label: "dashboard" },
        label: "Subnet stats",
        url: "https://grafana.public.example/d/subnet?var-subnet=42",
      },
      {
        classification: { kind: "dashboard", label: "dashboard" },
        label: "TaoStats",
        url: "https://taostats.io/subnets/42",
      },
    ];

    assert.deepEqual(
      selectReviewableReadmeLinks(links, {
        netuid: 42,
        repo: { owner: "ExampleProject", repo: "subnet-42" },
      }).map((link) => link.url),
      [
        "https://docs.exampleproject.ai/install",
        "https://api.exampleproject.ai/openapi.json",
        "https://grafana.public.example/d/subnet?var-subnet=42",
      ],
    );
  });

  test("README link review rejects malformed and generic references", () => {
    assert.equal(isReviewableReadmeLink(null), false);
    assert.equal(
      isReviewableReadmeLink({
        classification: { kind: "docs", label: "docs" },
        url: "not a url",
      }),
      false,
    );
    assert.equal(
      isReviewableReadmeLink({
        classification: { kind: "docs", label: "docs" },
        label: "Bittensor docs",
        url: "https://docs.learnbittensor.org/subnets/understanding-subnets",
      }),
      false,
    );
  });

  test("native subnet sync reports missing uvx without masking the error", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/sync-subnets.mjs", "--dry-run"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: "/nonexistent",
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Failed to fetch native Bittensor subnet snapshot/,
    );
    assert.match(result.stderr, /spawn error:/);
    assert.doesNotMatch(result.stderr, /Cannot read properties of undefined/);
  });

  test("classifies artifact storage tiers for files and route templates", async () => {
    assert.equal(
      artifactRelativePath("/metagraph/subnets/7.json"),
      "subnets/7.json",
    );
    assert.equal(
      artifactRelativePath("metagraph/latest.json"),
      "metagraph/latest.json",
    );
    assert.equal(
      artifactStorageTierForRelativePath("metagraph/latest.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
    assert.equal(
      artifactStorageTierForRelativePath("subnets/{netuid}.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
    assert.equal(
      artifactStorageTierForPath("/metagraph/health/history/{date}.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
    assert.equal(
      artifactStorageTierForRelativePath("schemas/index.json"),
      ARTIFACT_STORAGE_TIERS.dual,
    );
    assert.equal(
      artifactStorageTierForRelativePath("schemas/allways-swagger.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
    assert.equal(
      artifactStorageTierForRelativePath("candidates.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
    assert.equal(
      artifactStorageTierForRelativePath("review-queue.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
    assert.equal(
      artifactStorageTierForRelativePath("robots.txt"),
      ARTIFACT_STORAGE_TIERS.git,
    );
    assert.equal(
      isR2OnlyArtifactPath("/metagraph/verification/latest.json"),
      true,
    );
    assert.equal(isR2OnlyArtifactPath("/metagraph/contracts.json"), false);
    assert.equal(
      schemaDetailArtifactRelativePath(
        "/metagraph/schemas/sn-6-numinous-openapi-schema.json",
      ),
      "schemas/sn-6-numinous-openapi-schema.json",
    );
    assert.equal(
      schemaDetailArtifactRelativePath("schemas/allways-swagger.json"),
      "schemas/allways-swagger.json",
    );
    assert.equal(
      schemaDetailArtifactRelativePath("/metagraph/schemas/index.json"),
      null,
    );
    assert.equal(
      schemaDetailArtifactRelativePath("/metagraph/../../package.json"),
      null,
    );
    assert.equal(
      schemaDetailArtifactRelativePath("/metagraph/schemas/../package.json"),
      null,
    );
    assert.equal(
      schemaDetailArtifactRelativePath("/metagraph/schema-drift.json"),
      null,
    );

    const stagedPath = artifactOutputPath("health/history/2099-01-01.json");
    try {
      await writeJson(stagedPath, {
        schema_version: 1,
        generated_at: "1970-01-01T00:00:00.000Z",
        date: "2099-01-01",
        surfaces: [],
      });
      assert.equal(existsSync(stagedPath), true);
      assert.equal(
        artifactFilePath("health/history/2099-01-01.json"),
        stagedPath,
      );
      const env = createLocalArtifactEnv();
      const object = await env.METAGRAPH_ARCHIVE.get(
        "latest/health/history/2099-01-01.json",
      );
      assert.deepEqual(await object.json(), {
        schema_version: 1,
        generated_at: "1970-01-01T00:00:00.000Z",
        date: "2099-01-01",
        surfaces: [],
      });
      assert.equal(
        await env.METAGRAPH_ARCHIVE.get(
          "latest/health/history/2099-01-02.json",
        ),
        null,
      );
      assert.equal(
        (
          await env.ASSETS.fetch(
            new Request("https://assets.local/metagraph/contracts.json"),
          )
        ).status,
        200,
      );
      assert.equal(
        (await readFile(artifactFilePath("contracts.json"), "utf8")).includes(
          "metagraph.sh",
        ),
        true,
      );
    } finally {
      await rm(stagedPath, { force: true });
    }
  });

  test("augments manual overlays with verified baseline surfaces", async () => {
    const nativeSnapshot = {
      schema_version: 1,
      network: "finney",
      captured_at: "2026-06-08T00:00:00.000Z",
      source: { kind: "fixture", method: "test" },
      subnets: [
        {
          netuid: 25,
          name: "Mainframe",
          raw_name: "Mainframe",
          status: "active",
          subnet_type: "application",
        },
      ],
    };
    const manualOverlays = [
      {
        schema_version: 1,
        netuid: 25,
        name: "Mainframe",
        slug: "sn-25",
        status: "active",
        categories: ["identity-reviewed"],
        curation: {
          level: "maintainer-reviewed",
          review_state: "maintainer-reviewed",
          reviewed_at: "2026-06-08T00:00:00.000Z",
          verified_at: "2026-06-08T00:00:00.000Z",
          source_count: 1,
          gap_notes: [],
        },
        source_repo: "https://github.com/macrocosm-os/mainframe",
        baseline_excluded_surface_ids: ["sn-25-stale-docs"],
        surfaces: [
          {
            id: "sn-25-mainframe-source",
            name: "Mainframe source repository",
            kind: "source-repo",
            url: "https://github.com/macrocosm-os/mainframe",
            provider: "macrocosmos",
            auth_required: false,
            authority: "official",
            public_safe: true,
            source_urls: ["https://github.com/macrocosm-os/mainframe"],
            probe: { enabled: true, method: "HEAD", expect: "any" },
          },
        ],
      },
    ];
    const candidates = [
      {
        id: "sn-25-taostats-metagraph",
        netuid: 25,
        name: "Mainframe Taostats metagraph",
        kind: "dashboard",
        url: "https://taostats.io/subnets/25/metagraph",
        provider: "taostats",
        source_type: "third-party-index",
        source_tier: "third-party-index",
        source_url: "https://taostats.io/subnets/25/metagraph",
        source_urls: ["https://taostats.io/subnets/25/metagraph"],
        review_notes:
          "Universal Taostats subnet metagraph dashboard candidate.",
      },
      {
        id: "sn-25-stale-docs",
        netuid: 25,
        name: "Mainframe stale docs",
        kind: "docs",
        url: "https://example.com/stale-docs",
        provider: "taomarketcap",
        source_type: "project-website-common-path",
        source_tier: "provider-claimed",
        source_url: "https://example.com/stale-docs",
        source_urls: ["https://example.com/stale-docs"],
        review_notes: "Known stale generated candidate.",
      },
    ];
    const verification = {
      schema_version: 1,
      results: [
        {
          candidate_id: "sn-25-taostats-metagraph",
          classification: "live",
          content_type: "text/html; charset=utf-8",
          quality_signals: {
            content_type_matches_kind: true,
            public_safe: true,
            rate_limited: false,
            redirected: false,
            source_tier: "third-party-index",
            transient_failure: false,
          },
        },
        {
          candidate_id: "sn-25-stale-docs",
          classification: "live",
          content_type: "text/html; charset=utf-8",
          quality_signals: {
            content_type_matches_kind: true,
            public_safe: true,
            rate_limited: false,
            redirected: false,
            source_tier: "provider-claimed",
            transient_failure: false,
          },
        },
      ],
    };

    const overlaySet = await generateBaselineOverlaySet({
      candidates,
      existingGeneratedOverlays: [],
      manualOverlays,
      nativeSnapshot,
      verification,
    });

    assert.equal(overlaySet.generatedOverlays.length, 0);
    assert.deepEqual(
      overlaySet.manualOverlays[0].surfaces.map((surface) => surface.id),
      ["sn-25-mainframe-source", "sn-25-taostats-metagraph"],
    );
    assert.equal(
      overlaySet.manualOverlays[0].categories.includes("baseline-augmented"),
      true,
    );
    assert.equal(
      overlaySet.manualOverlays[0].dashboard_url,
      "https://taostats.io/subnets/25/metagraph",
    );
    assert.equal(manualOverlays[0].surfaces.length, 1);
  });

  test("does not promote HTML-only Swagger pages as OpenAPI surfaces", async () => {
    const nativeSnapshot = {
      captured_at: "2026-06-08T00:00:00.000Z",
      subnets: [{ netuid: 66, name: "ninja", status: "active" }],
    };
    const candidates = [
      {
        confidence: "low",
        id: "sn-66-website-common-swagger",
        kind: "openapi",
        name: "ninja Swagger",
        netuid: 66,
        provider: "taomarketcap",
        source_tier: "third-party-index",
        source_type: "project-website-common-path",
        source_url: "https://ninja.arbos.life/",
        source_urls: ["https://ninja.arbos.life/"],
        url: "https://ninja.arbos.life/swagger",
      },
      {
        confidence: "low",
        id: "sn-66-website-common-openapi-json",
        kind: "openapi",
        name: "ninja OpenAPI JSON",
        netuid: 66,
        provider: "taomarketcap",
        source_tier: "third-party-index",
        source_type: "project-website-common-path",
        source_url: "https://ninja.arbos.life/",
        source_urls: ["https://ninja.arbos.life/"],
        url: "https://ninja.arbos.life/openapi.json",
      },
    ];
    const verification = {
      schema_version: 1,
      results: [
        {
          candidate_id: "sn-66-website-common-swagger",
          classification: "live",
          content_type: "text/html",
          quality_signals: { public_safe: true },
        },
        {
          candidate_id: "sn-66-website-common-openapi-json",
          classification: "live",
          content_type: "application/json",
          quality_signals: { public_safe: true },
        },
      ],
    };

    const overlaySet = await generateBaselineOverlaySet({
      candidates,
      existingGeneratedOverlays: [],
      manualOverlays: [],
      nativeSnapshot,
      verification,
    });

    assert.deepEqual(
      overlaySet.generatedOverlays[0].surfaces.map((surface) => ({
        id: surface.id,
        schema_status: surface.schema_status,
        schema_url: surface.schema_url,
      })),
      [
        {
          id: "sn-66-website-common-openapi-json",
          schema_status: "machine-readable",
          schema_url: "https://ninja.arbos.life/openapi.json",
        },
      ],
    );
  });

  test("redacts credentialed object-storage URLs", () => {
    const signedUrl =
      "https://ams3.digitaloceanspaces.com/releases/file.dmg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=KEY%2F20260607%2Fams3%2Fs3%2Faws4_request&X-Amz-Signature=abc&x-id=GetObject";

    assert.equal(isCredentialedUrl(signedUrl), true);
    assert.equal(
      redactCredentialedUrl(signedUrl),
      "https://ams3.digitaloceanspaces.com/releases/file.dmg",
    );
    assert.equal(
      redactCredentialedUrl(`${signedUrl}#fragment`),
      "https://ams3.digitaloceanspaces.com/releases/file.dmg",
    );
    assert.deepEqual(redactCredentialedUrls({ nested: [signedUrl] }), {
      nested: ["https://ams3.digitaloceanspaces.com/releases/file.dmg"],
    });
    assert.deepEqual(redactCredentialedUrls([null, 7, false]), [
      null,
      7,
      false,
    ]);
    const oauthRedirect =
      "https://accounts.google.com/v3/signin/identifier?client_id=abc&state=volatile&nonce=random";
    assert.equal(isCredentialedUrl(oauthRedirect), true);
    assert.equal(
      redactCredentialedUrl(oauthRedirect),
      "https://accounts.google.com/v3/signin/identifier",
    );
    assert.equal(redactCredentialedUrl("not a url"), "not a url");
    assert.equal(
      redactCredentialedUrl("https://example.com/download?file=1"),
      "https://example.com/download?file=1",
    );
    assert.equal(isCredentialedUrl("not a url"), false);
    assert.equal(
      isCredentialedUrl("https://example.com/download?file=1"),
      false,
    );
  });

  test("loads checked-in candidates and verification fallback contracts", async () => {
    const candidates = await loadCandidates();
    const verification = await loadVerification();
    const compactVerification = await loadVerification({
      preferDetailed: false,
    });
    const detailedVerification = await loadDetailedVerification();

    assert.equal(candidates.length > 0, true);
    assert.equal(verification.schema_version, 1);
    assert.equal(compactVerification.schema_version, 1);
    assert.equal(detailedVerification.schema_version, 1);
    assert.equal(existsSync(path.join(repoRoot, "package.json")), true);
  });

  test("normalizes names, URLs, keys, hashes, and slugs deterministically", () => {
    assert.deepEqual(classifyNativeName("unknown", 87), {
      raw_name: "unknown",
      quality: "placeholder",
    });
    assert.equal(classifyNativeName("", 1).quality, "empty");
    assert.equal(classifyNativeName("Luminar Network", 87).quality, "chain");
    assert.equal(classifyNativeName("›", 76).quality, "placeholder");
    assert.equal(
      nativeNameQuality({ raw_name: "Subnet 42", netuid: 42 }),
      "placeholder",
    );
    assert.equal(
      nativeDisplayName({ raw_name: "›", netuid: 76 }, "Byzantium"),
      "Byzantium",
    );
    assert.equal(
      nativeDisplayName({ raw_name: "unknown", netuid: 87 }, "Luminar Network"),
      "Luminar Network",
    );

    assert.equal(isValidUrl("https://metagraph.sh"), true);
    assert.equal(isValidUrl("ftp://metagraph.sh"), false);
    assert.equal(isValidUrl("not a url"), false);
    assert.equal(isUnsafeUrl("http://127.0.0.1:9944"), true);
    assert.equal(isUnsafeUrl("http://metadata.localhost"), true);
    assert.equal(isUnsafeUrl("ftp://metagraph.sh"), true);
    assert.equal(isUnsafeUrl("http://100.64.0.1"), true);
    assert.equal(isUnsafeUrl("http://172.16.0.1"), true);
    assert.equal(isUnsafeUrl("http://[fd00::1]"), true);
    assert.equal(isUnsafeUrl("http://[fe80::1]"), true);
    assert.equal(isUnsafeUrl("http://[::ffff:127.0.0.1]"), true);
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
    assert.equal(
      stableStringify([{ b: 1, a: 2 }]),
      '[\n  {\n    "a": 2,\n    "b": 1\n  }\n]',
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
    const emptyResolver = async () => [];

    assert.equal(
      await isUnsafeResolvedUrl("https://metadata.example", privateResolver),
      true,
    );
    assert.equal(
      await isUnsafeResolvedUrl("https://metagraph.example", publicResolver),
      false,
    );
    assert.equal(
      await isUnsafeResolvedUrl("https://empty.example", emptyResolver),
      true,
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
            probe: { enabled: true, method: "chain_getHeader" },
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
            id: "root-data",
            kind: "data-artifact",
            url: "https://data.example.com/root.json",
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
            probe: { enabled: true, method: "chain_getHeader" },
          },
          {
            id: "root-degraded-rpc",
            kind: "subtensor-rpc",
            url: "https://degraded.example.com",
            provider: "degraded",
            authority: "provider-claimed",
            auth_required: false,
            public_safe: true,
            probe: { enabled: true, method: "chain_getHeader" },
          },
          {
            id: "root-private-api",
            kind: "subnet-api",
            url: "https://private.example.com",
            provider: "private",
            authority: "provider-claimed",
            auth_required: false,
            public_safe: false,
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
          status: "ok",
          classification: "live",
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
        {
          surface_id: "root-degraded-rpc",
          status: "degraded",
          classification: "rate-limited",
          latency_ms: 1500,
          methods_supported: ["chain_getHeader"],
        },
      ],
      generatedAt: "1970-01-01T00:00:00.000Z",
      contractVersion: "test",
      source: "fixture",
    });

    assert.equal(rpc.summary.endpoint_count, 4);
    assert.equal(rpc.summary.archive_supported_count, 1);
    assert.equal(rpc.endpoints[0].method_tested, "chain_getHeader");
    assert.equal(
      rpc.endpoints.find((endpoint) => endpoint.id === "root-rpc")
        .health_source,
      "probe-derived",
    );
    assert.equal(
      rpc.endpoints.find((endpoint) => endpoint.id === "root-rpc").observed_at,
      "1970-01-01T00:00:00.000Z",
    );
    assert.equal(
      rpc.endpoints.find((endpoint) => endpoint.id === "root-rpc").last_ok,
      "1970-01-01T00:00:00.000Z",
    );
    assert.equal(
      rpc.endpoints.find((endpoint) => endpoint.id === "root-failed-rpc")
        .health_stale,
      true,
    );

    const endpointResources = buildEndpointResourceArtifact({
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
          surface_id: "root-failed-rpc",
          status: "failed",
          classification: "dead",
          latency_ms: null,
          error: "connection refused",
          verified_at: "1970-01-01T00:00:00.000Z",
        },
        {
          surface_id: "root-degraded-rpc",
          status: "degraded",
          classification: "rate-limited",
          latency_ms: 1500,
          methods_supported: ["chain_getHeader"],
          verified_at: "1970-01-01T00:00:00.000Z",
        },
      ],
      generatedAt: "1970-01-01T00:00:00.000Z",
      contractVersion: "test",
      source: "fixture",
    });
    assert.equal(endpointResources.summary.endpoint_count, 7);
    assert.equal(
      endpointResources.endpoints.find(
        (endpoint) => endpoint.surface_id === "root-docs",
      ).layer,
      "docs-provider",
    );
    assert.equal(
      endpointResources.endpoints.find(
        (endpoint) => endpoint.surface_id === "root-data",
      ).layer,
      "data-provider",
    );
    assert.equal(
      endpointResources.endpoints.find(
        (endpoint) => endpoint.surface_id === "root-rpc",
      ).publication_state,
      "pool-eligible",
    );
    assert.deepEqual(
      endpointResources.endpoints.find(
        (endpoint) => endpoint.surface_id === "root-rpc",
      ).pool_eligibility_reasons,
      ["eligible"],
    );
    assert.equal(
      endpointResources.endpoints.find(
        (endpoint) => endpoint.surface_id === "root-rpc",
      ).score_reasons.length > 0,
      true,
    );
    assert.equal(
      endpointResources.endpoints.find(
        (endpoint) => endpoint.surface_id === "root-rpc",
      ).health_source,
      "probe-derived",
    );
    assert.equal(
      endpointResources.endpoints.find(
        (endpoint) => endpoint.surface_id === "root-docs",
      ).health_source,
      "not-monitored",
    );
    assert.equal(
      endpointResources.endpoints.find(
        (endpoint) => endpoint.surface_id === "root-docs",
      ).health_stale,
      false,
    );
    assert.equal(
      endpointResources.endpoints.find(
        (endpoint) => endpoint.surface_id === "root-private-api",
      ).publication_state,
      "disabled",
    );
    assert.equal(
      endpointResources.endpoints
        .find((endpoint) => endpoint.surface_id === "root-private-api")
        .pool_eligibility_reasons.includes("not-public-safe"),
      true,
    );

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
    assert.equal(
      pools.pools.find((pool) => pool.id === "finney-wss").endpoints[0].score >
        0,
      true,
    );
    assert.equal(pools.provider_scores[0].provider, "example");
    assert.equal(
      pools.pools
        .find((pool) => pool.id === "finney-rpc")
        .endpoints.every((endpoint) =>
          Array.isArray(endpoint.pool_eligibility_reasons),
        ),
      true,
    );
    assert.equal(
      pools.pools
        .find((pool) => pool.id === "finney-rpc")
        .endpoints.find((endpoint) => endpoint.id === "root-rpc").health_source,
      "probe-derived",
    );
    assert.equal(
      pools.pools
        .find((pool) => pool.id === "finney-rpc")
        .endpoints.find((endpoint) => endpoint.id === "root-rpc").last_ok,
      "1970-01-01T00:00:00.000Z",
    );
    const generalizedPools = buildEndpointPoolArtifact({
      generatedAt: "1970-01-01T00:00:00.000Z",
      contractVersion: "test",
      endpointArtifact: endpointResources,
    });
    assert.equal(generalizedPools.source, "endpoint-resource-probes");
    assert.equal(
      generalizedPools.provider_scores.some(
        (provider) => provider.provider === "degraded",
      ),
      true,
    );

    const incidents = buildEndpointIncidentArtifact({
      endpointArtifact: endpointResources,
      generatedAt: "1970-01-01T00:00:00.000Z",
      contractVersion: "test",
    });
    assert.equal(incidents.summary.incident_count, 2);
    assert.equal(
      incidents.incidents[0].endpoint_id,
      "endpoint-root-failed-rpc",
    );
    assert.equal(incidents.incidents[0].severity, "critical");
    assert.equal(
      incidents.incidents.find(
        (incident) => incident.endpoint_id === "endpoint-root-degraded-rpc",
      ).severity,
      "warning",
    );
    assert.equal(incidents.incidents[0].user_reported, false);
    assert.equal(incidents.incidents[0].source, "probe-derived");
    assert.equal(incidents.incidents[0].health_source, "probe-derived");
    assert.equal(
      incidents.incidents[0].observed_at,
      "1970-01-01T00:00:00.000Z",
    );
  });

  test("evaluates artifact budgets with wildcard matching", () => {
    const results = evaluateArtifactBudgets([
      { path: "candidates.json", size_bytes: 100 },
      { path: "health/history/2026-06-06.json", size_bytes: 700_000 },
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

  test("builds provider and status-report intake reports", () => {
    const providerReport = buildProviderProfileIntakeReport({
      fields: {
        "provider slug": "example-operator",
        "provider name": "Example Operator",
        "provider kind": "infrastructure-provider",
        "website url": "https://example.com",
        "docs url": "https://docs.example.com",
      },
      providers,
    });
    assert.equal(providerReport.state, "schema-valid");
    assert.equal(providerReport.public_state, "manual_review");
    assert.equal(providerReport.provider.id, "example-operator");
    assert.equal(providerReport.provider.authority, "community");

    const statusReport = buildEndpointStatusReportIntakeReport({
      fields: {
        netuid: "7",
        "surface id or url": "allways-api-health",
        "issue type": "degraded",
        evidence: "Public endpoint returned HTTP 503 during a read-only check.",
      },
      native,
    });
    assert.equal(statusReport.state, "schema-valid");
    assert.equal(statusReport.report.affects_observed_health, false);
    assert.equal(statusReport.next_action, "manual-review");
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
    assert.equal(
      validateSubmissionProvenance({
        submitter: "jsonbored",
        document: {
          submission: {
            submitted_by: "jsonbored",
            submitted_by_url: "https://github.com/not-jsonbored",
          },
        },
      })[0].message,
      "submission.submitted_by_url must match submitted_by",
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

    const missingCandidate = validateCandidateForSubmission({
      candidate: null,
      native,
      providers,
    });
    assert.equal(missingCandidate.errors[0].category, "unsupported-shape");

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

    const badProvenanceList = validateCandidateForSubmission({
      candidate: {
        ...baseCandidate,
        source_urls: ["https://docs.all-ways.io/extra/", "http://127.0.0.1"],
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
      existingCandidates: [],
      existingSubnets: [],
    });
    assert.equal(
      badProvenanceList.errors.some(
        (error) =>
          error.message === "candidate source_urls[1] is invalid or unsafe",
      ),
      true,
    );
    assert.equal(
      badProvenanceList.warnings.some((warning) =>
        warning.includes("source_urls[0] will be normalized"),
      ),
      true,
    );

    const nonArrayProvenanceList = validateCandidateForSubmission({
      candidate: { ...baseCandidate, source_urls: "https://docs.all-ways.io" },
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
    assert.equal(
      nonArrayProvenanceList.errors.some(
        (error) => error.message === "candidate source_urls must be an array",
      ),
      true,
    );

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
