import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import {
  artifactDirectoryPath,
  artifactFilePath,
  createLocalArtifactEnv,
  MULTI_TENANT_HOST_SUFFIXES,
  nativeContactHandle,
  nativeContactUrl,
  deriveDomainTags,
  publicMetagraphRoot,
  r2StagingRoot,
  registrySurfaceKey,
  isSurfaceStale,
} from "../scripts/lib.mjs";
import { handleRequest } from "../workers/api.mjs";

// The committed digests the forged-build tests snapshot + restore (so a forged
// rebuild never dirties version-controlled files). Only r2-manifest.json stays
// committed (publish infra); changelog + build-summary moved to R2-only (#1003)
// — they live in dist/ (gitignored, freely regenerated) and need no preservation.
const SUPPORT_ARTIFACT_PATHS = ["public/metagraph/r2-manifest.json"];

function runNode(script) {
  execFileSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    // The committed artifacts are an inert cold-start seed (ADR 0006) that drifts
    // from live source between publishes. This no-build suite validates structure;
    // committed-vs-fresh freshness parity is gated in CI (post-build) instead.
    env: { ...process.env, METAGRAPH_ALLOW_SEED_DRIFT: "1" },
  });
}

// Snapshot/restore the served public/ tree so the build-running tests below leave
// the working tree exactly as they found it. build-artifacts.mjs regenerates from
// current source (which drifts from the committed seed), so restoring exact bytes
// keeps `npm test` idempotent — a contributor can't accidentally commit drift.
const PUBLIC_TREE = path.join(process.cwd(), "public");

function walkFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function snapshotPublicTree() {
  if (!existsSync(PUBLIC_TREE)) {
    return new Map();
  }
  return new Map(
    walkFilesRecursive(PUBLIC_TREE).map((file) => [file, readFileSync(file)]),
  );
}

function restorePublicTree(snapshot) {
  if (existsSync(PUBLIC_TREE)) {
    for (const file of walkFilesRecursive(PUBLIC_TREE)) {
      if (!snapshot.has(file)) {
        rmSync(file);
      }
    }
  }
  for (const [file, bytes] of snapshot) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
}

let publicTreeSnapshot;
beforeAll(() => {
  publicTreeSnapshot = snapshotPublicTree();
});
afterAll(() => {
  restorePublicTree(publicTreeSnapshot);
});

test("registry validates", () => {
  runNode("scripts/validate.mjs");
});

test("registry validation accepts the community-seeded curation level", () => {
  const overlayPath = "registry/subnets/test-community-seeded-sn-1.json";
  const fixture = tamperedOverlayFixture("sn-1-community-seeded");
  fixture.curation.level = "community-seeded";
  fixture.curation.review_state = "unreviewed";

  let result;
  try {
    writeFileSync(overlayPath, `${JSON.stringify(fixture, null, 2)}\n`);
    result = spawnSync(process.execPath, ["scripts/validate.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, METAGRAPH_ALLOW_SEED_DRIFT: "1" },
    });
  } finally {
    rmSync(overlayPath, { force: true });
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.doesNotMatch(
    output,
    /sn-1-community-seeded: invalid curation\.level/,
    "community-seeded must be an accepted curation.level (added to schema in #1822)",
  );
});

test("registry validation warns but does not block on cross-netuid on-chain name collisions", () => {
  const nativePath = "registry/native/finney-subnets.json";
  const original = readFileSync(nativePath, "utf8");
  const nativeSnapshot = JSON.parse(original);
  const attackerControlledSubnet = nativeSnapshot.subnets.find(
    (subnet) => subnet.netuid === 1,
  );
  assert(
    attackerControlledSubnet,
    "expected native fixture to include netuid 1",
  );
  attackerControlledSubnet.chain_identity ||= {};
  attackerControlledSubnet.chain_identity.subnet_name = "Templar";

  let result;
  try {
    writeFileSync(nativePath, `${JSON.stringify(nativeSnapshot, null, 2)}\n`);
    result = spawnSync(process.execPath, ["scripts/validate.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, METAGRAPH_ALLOW_SEED_DRIFT: "1" },
    });
  } finally {
    writeFileSync(nativePath, original);
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.match(
    output,
    /sn-3: curated name "Templar" .*possible mis-keyed overlay/,
  );
  assert.doesNotMatch(
    output,
    /Validation failed[^]*- sn-3: curated name "Templar"/,
  );
});

test("registry validation rejects registry-observed surfaces without verification evidence", () => {
  const overlayPath = "registry/subnets/test-tampered-sn-1.json";
  const tampered = tamperedOverlayFixture("sn-1-unverified-registry-observed");

  tampered.surfaces.push({
    id: "sn-1-unverified-registry-observed",
    name: "Unverified registry-observed surface",
    kind: "website",
    url: "https://example.invalid/unverified-registry-observed",
    provider: "taomarketcap",
    auth_required: false,
    authority: "registry-observed",
    public_safe: true,
    source_urls: ["https://example.invalid/source"],
  });

  let failure;
  try {
    writeFileSync(overlayPath, `${JSON.stringify(tampered, null, 2)}\n`);
    runNode("scripts/validate.mjs");
  } catch (error) {
    failure = error;
  } finally {
    rmSync(overlayPath, { force: true });
  }

  assert(
    failure,
    "expected validation to reject a registry-observed surface without verification evidence",
  );
  assert.match(
    `${failure.stdout || ""}\n${failure.stderr || ""}`,
    /registry-observed surface requires verification evidence/,
  );
});

test("registry validation rejects registry-observed surfaces with only inline verification", () => {
  const overlayPath = "registry/subnets/test-tampered-sn-1.json";
  const tampered = tamperedOverlayFixture("sn-1-forged-inline-verification");

  tampered.surfaces.push({
    id: "sn-1-forged-inline-verification",
    name: "Forged inline verification surface",
    kind: "website",
    url: "https://example.invalid/forged-inline-verification",
    provider: "taomarketcap",
    auth_required: false,
    authority: "registry-observed",
    public_safe: true,
    source_urls: ["https://example.invalid/source"],
    verification: {
      classification: "live",
      verified_at: "2999-01-01T00:00:00.000Z",
    },
  });

  let failure;
  try {
    writeFileSync(overlayPath, `${JSON.stringify(tampered, null, 2)}\n`);
    runNode("scripts/validate.mjs");
  } catch (error) {
    failure = error;
  } finally {
    rmSync(overlayPath, { force: true });
  }

  assert(
    failure,
    "expected validation to reject forged inline verification without ledger evidence",
  );
  assert.match(
    `${failure.stdout || ""}\n${failure.stderr || ""}`,
    /registry-observed surface requires verification evidence/,
  );
});

function tamperedOverlayFixture(slug) {
  return {
    categories: ["test"],
    curation: {
      gap_notes: [],
      level: "machine-verified",
      review_state: "maintainer-reviewed",
      reviewed_at: "2026-06-07T00:00:00.000Z",
      source_count: 1,
      verified_at: null,
    },
    links: [],
    name: `Tampered ${slug}`,
    netuid: 1,
    notes: "Temporary validation fixture.",
    schema_version: 1,
    slug,
    status: "active",
    surfaces: [],
  };
}

test("registry validation rejects tampered per-subnet artifacts", () => {
  const artifactPath = artifactFilePath("subnets/0.json");
  const original = readFileSync(artifactPath, "utf8");
  const tampered = JSON.parse(original);
  tampered.phishing_url = "https://example.invalid/phish";

  let failure;
  try {
    writeFileSync(artifactPath, `${JSON.stringify(tampered, null, 2)}\n`);
    runNode("scripts/validate.mjs");
  } catch (error) {
    failure = error;
  } finally {
    writeFileSync(artifactPath, original);
  }

  assert(failure, "expected validation to reject tampered subnet artifact");
  assert.match(
    `${failure.stdout || ""}\n${failure.stderr || ""}`,
    /per-subnet detail artifact is not reproducible from registry inputs/,
  );
});

test("artifact build does not preserve forged endpoint index health", () => {
  const endpointsPath = artifactFilePath("endpoints.json");
  const cachePath = ".cache/metagraphed/health/latest.json";
  const original = readFileSync(endpointsPath, "utf8");
  const originalCache = existsSync(cachePath)
    ? readFileSync(cachePath, "utf8")
    : null;
  const supportArtifacts = snapshotSupportArtifacts();
  rmSync(cachePath, { force: true });
  const tampered = JSON.parse(original);
  const target = tampered.endpoints.find(
    (endpoint) => endpoint.public_safe === true,
  );
  assert(target, "expected a public-safe endpoint row to tamper");

  target.health_source = "probe-derived";
  target.monitoring_status = "monitored";
  target.status = "ok";
  target.classification = "live";
  target.last_checked = "2999-01-01T00:00:00.000Z";
  target.last_ok = "2999-01-01T00:00:00.000Z";
  target.observed_at = "2999-01-01T00:00:00.000Z";
  target.latency_ms = 7;
  target.latest_block = 4242424242;
  target.archive_support = true;

  try {
    writeFileSync(endpointsPath, `${JSON.stringify(tampered, null, 2)}\n`);
    execFileSync(process.execPath, ["scripts/build-artifacts.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, METAGRAPH_PRESERVE_PROBE_HEALTH: "1" },
      stdio: "pipe",
    });

    const rebuilt = JSON.parse(readFileSync(endpointsPath, "utf8"));
    const rebuiltTarget = rebuilt.endpoints.find(
      (endpoint) => endpoint.surface_id === target.surface_id,
    );
    assert.equal(rebuiltTarget.status, "unknown");
    assert.equal(rebuiltTarget.classification, "unknown");
    assert.equal(rebuiltTarget.last_checked, null);
    assert.equal(rebuiltTarget.latency_ms, null);
    assert.equal(rebuiltTarget.latest_block, null);
    assert.equal(rebuiltTarget.archive_support, null);
    assert.equal(rebuiltTarget.health_source, "missing-probe");
  } finally {
    writeFileSync(endpointsPath, original);
    if (originalCache === null) {
      rmSync(cachePath, { force: true });
    } else {
      writeFileSync(cachePath, originalCache);
    }
    execFileSync(process.execPath, ["scripts/build-artifacts.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        METAGRAPH_PRESERVE_PROBE_HEALTH: "1",
      },
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/generate-types.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/generate-client.mjs", "--write"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/r2-manifest.mjs", "--write"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    restoreSupportArtifacts(supportArtifacts);
  }
}, 30_000);

test("artifact build does not preserve forged schema snapshot metadata", () => {
  const schemaDriftPath = artifactFilePath("schema-drift.json");
  const schemaIndexPath = artifactFilePath("schemas/index.json");
  const originalSchemaDrift = existsSync(schemaDriftPath)
    ? readFileSync(schemaDriftPath, "utf8")
    : null;
  const originalSchemaIndex = readFileSync(schemaIndexPath, "utf8");
  const supportArtifacts = snapshotSupportArtifacts();
  const schemaDrift = originalSchemaDrift
    ? JSON.parse(originalSchemaDrift)
    : null;
  const schemaIndex = JSON.parse(originalSchemaIndex);
  const driftTarget = schemaDrift?.surfaces?.[0];
  const indexTarget =
    schemaIndex.schemas?.find(
      (schema) => schema.surface_id === driftTarget?.surface_id,
    ) || schemaIndex.schemas?.find((schema) => schema.status === "captured");
  assert(indexTarget, "expected a schema index entry to tamper");

  const forgedMarker = "AUTOVALIDATOR_FORGED_METADATA_SHOULD_NOT_SURVIVE_BUILD";
  if (driftTarget) {
    driftTarget.netuid = 999999;
    driftTarget.subnet_slug = forgedMarker;
    driftTarget.url = "https://attacker.invalid/openapi";
    driftTarget.schema_url = "https://attacker.invalid/openapi.json";
    driftTarget.hash = "forged-hash";
  }
  indexTarget.netuid = 999999;
  indexTarget.subnet_slug = forgedMarker;
  indexTarget.url = "https://attacker.invalid/openapi";
  indexTarget.schema_url = "https://attacker.invalid/openapi.json";
  indexTarget.hash = "forged-hash";
  indexTarget.path = "/metagraph/schemas/forged-by-autovalidator.json";
  indexTarget.snapshot = {
    ...indexTarget.snapshot,
    netuid: 999999,
    subnet_slug: forgedMarker,
    surface_url: "https://attacker.invalid/openapi",
    schema_url: "https://attacker.invalid/openapi.json",
    hash: "forged-hash",
    title: forgedMarker,
  };

  try {
    if (schemaDrift) {
      writeFileSync(
        schemaDriftPath,
        `${JSON.stringify(schemaDrift, null, 2)}\n`,
      );
    }
    writeFileSync(schemaIndexPath, `${JSON.stringify(schemaIndex, null, 2)}\n`);
    execFileSync(process.execPath, ["scripts/build-artifacts.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });

    const rebuiltSchemaDrift = existsSync(schemaDriftPath)
      ? readFileSync(schemaDriftPath, "utf8")
      : "";
    const rebuiltSchemaIndex = readFileSync(schemaIndexPath, "utf8");
    assert.equal(rebuiltSchemaDrift.includes(forgedMarker), false);
    assert.equal(rebuiltSchemaIndex.includes(forgedMarker), false);
    if (rebuiltSchemaDrift) {
      assert.equal(JSON.parse(rebuiltSchemaDrift).source, "artifact-build");
    }
    assert.equal(JSON.parse(rebuiltSchemaIndex).source, "artifact-build");
  } finally {
    if (originalSchemaDrift) {
      writeFileSync(schemaDriftPath, originalSchemaDrift);
    } else {
      rmSync(schemaDriftPath, { force: true });
    }
    writeFileSync(schemaIndexPath, originalSchemaIndex);
    execFileSync(process.execPath, ["scripts/build-artifacts.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/generate-types.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/generate-client.mjs", "--write"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/r2-manifest.mjs", "--write"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    restoreSupportArtifacts(supportArtifacts);
  }
}, 30_000);

// #510 refactor invariant: the artifact build is deterministic, so two
// consecutive builds (epoch timestamp, no METAGRAPH_BUILD_TIMESTAMP) must emit a
// byte-identical R2 staging tree. This is the regression guard that lets the
// build-artifacts/lib decomposition stay safe — any future code-motion that
// silently reorders keys, changes a number, or drops an artifact flips this hash.
// It deliberately compares the whole staging tree (not a hardcoded golden), so it
// never needs touching when the committed source data legitimately refreshes.
function digestArtifactTree(root) {
  const hash = createHash("sha256");
  for (const file of walkFilesRecursive(root)
    .filter((file) => path.basename(file) !== ".DS_Store") // OS noise, not an artifact
    .sort()) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

test("artifact build is deterministic (byte-identical across rebuilds)", () => {
  const supportArtifacts = snapshotSupportArtifacts();
  const buildEnv = { ...process.env, METAGRAPH_PRESERVE_PROBE_HEALTH: "1" };
  delete buildEnv.METAGRAPH_BUILD_TIMESTAMP; // force the reproducible epoch
  const runBuild = () =>
    execFileSync(process.execPath, ["scripts/build-artifacts.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: buildEnv,
      stdio: "pipe",
    });
  try {
    runBuild();
    const firstDigest = digestArtifactTree(r2StagingRoot);

    // The build must actually produce the artifacts whose derivation was
    // extracted to scripts/lib/ — a broken import would yield empty/missing
    // output, which this asserts before the cheaper hash comparison.
    for (const relativePath of [
      "endpoints.json",
      "rpc-endpoints.json",
      "economics.json",
      "endpoint-pools.json",
      "endpoint-incidents.json",
    ]) {
      const artifact = readArtifact(relativePath);
      assert.ok(
        artifact && typeof artifact === "object",
        `${relativePath} should build to a non-empty object`,
      );
    }

    runBuild();
    const secondDigest = digestArtifactTree(r2StagingRoot);

    assert.equal(
      secondDigest,
      firstDigest,
      "two consecutive builds must emit a byte-identical R2 staging tree",
    );
  } finally {
    runBuild();
    restoreSupportArtifacts(supportArtifacts);
  }
}, 30_000);

test("artifact build preserves committed schema index without R2 schema details", () => {
  const schemaIndexPath = artifactFilePath("schemas/index.json");
  const originalSchemaIndex = readFileSync(schemaIndexPath, "utf8");
  const originalSchemaIndexJson = JSON.parse(originalSchemaIndex);
  const supportArtifacts = snapshotSupportArtifacts();
  const backupDir = mkdtempSync(`${tmpdir()}/metagraphed-schema-r2-`);
  const stagingBackup = `${backupDir}/metagraph-r2`;
  const hadStagingRoot = existsSync(r2StagingRoot);
  if (hadStagingRoot) {
    cpSync(r2StagingRoot, stagingBackup, { recursive: true });
  }

  assert.equal(originalSchemaIndexJson.source, "openapi-snapshot");
  assert.equal(originalSchemaIndexJson.schemas.length > 0, true);

  try {
    rmSync(r2StagingRoot, { recursive: true, force: true });
    execFileSync(process.execPath, ["scripts/build-artifacts.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });

    const rebuiltSchemaIndex = readFileSync(schemaIndexPath, "utf8");
    assert.deepEqual(JSON.parse(rebuiltSchemaIndex), originalSchemaIndexJson);
  } finally {
    writeFileSync(schemaIndexPath, originalSchemaIndex);
    rmSync(r2StagingRoot, { recursive: true, force: true });
    if (hadStagingRoot) {
      cpSync(stagingBackup, r2StagingRoot, { recursive: true });
    }
    restoreSupportArtifacts(supportArtifacts);
    rmSync(backupDir, { recursive: true, force: true });
  }
}, 30_000);

test("committed R2 manifest does not use fallback history keys", () => {
  // Read the git-committed manifest, not the working-tree copy: the Validate
  // test/checks jobs run `npm run build` before the suite, which regenerates
  // r2-manifest.json with the 1970 epoch placeholder (no METAGRAPH_BUILD_TIMESTAMP).
  // This guard is about the committed publish lockfile, which must carry the real
  // timestamp written by the publish workflow.
  const manifest = JSON.parse(
    execFileSync("git", ["show", "HEAD:public/metagraph/r2-manifest.json"], {
      encoding: "utf8",
    }),
  );

  assert.notEqual(manifest.generated_at, "1970-01-01T00:00:00.000Z");
  assert.notEqual(manifest.run_prefix, "runs/1970-01-01T00-00-00-000Z/");
  assert.ok(
    manifest.artifacts.every(
      (artifact) => !artifact.key.startsWith("runs/1970-01-01T00-00-00-000Z/"),
    ),
  );
});

test("r2 manifest dry-run reuses the committed timestamp for staged artifacts", () => {
  const timestamp = "2026-06-08T12:34:56.789Z";
  const expectedRunPrefix = "runs/2026-06-08T12-34-56-789Z/";
  const originalManifest = readFileSync(
    "public/metagraph/r2-manifest.json",
    "utf8",
  );
  const backupDir = mkdtempSync(`${tmpdir()}/metagraphed-r2-manifest-`);
  const stagingBackup = `${backupDir}/metagraph-r2`;
  const hadStagingRoot = existsSync(r2StagingRoot);
  if (hadStagingRoot) {
    cpSync(r2StagingRoot, stagingBackup, { recursive: true });
  }

  try {
    rmSync(r2StagingRoot, { recursive: true, force: true });
    execFileSync(process.execPath, ["scripts/r2-manifest.mjs", "--write"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        METAGRAPH_BUILD_TIMESTAMP: timestamp,
      },
      stdio: "pipe",
    });

    const dryRunEnv = { ...process.env };
    delete dryRunEnv.METAGRAPH_BUILD_TIMESTAMP;
    const output = execFileSync(process.execPath, ["scripts/r2-manifest.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: dryRunEnv,
      stdio: "pipe",
    });
    const summary = JSON.parse(output);

    assert.equal(summary.run_prefix, expectedRunPrefix);
  } finally {
    writeFileSync("public/metagraph/r2-manifest.json", originalManifest);
    rmSync(r2StagingRoot, { recursive: true, force: true });
    if (hadStagingRoot) {
      cpSync(stagingBackup, r2StagingRoot, { recursive: true });
    }
    rmSync(backupDir, { recursive: true, force: true });
  }
});

test("public artifacts are internally consistent", () => {
  const native = JSON.parse(
    readFileSync("registry/native/finney-subnets.json", "utf8"),
  );
  const subnets = readArtifact("subnets.json");
  const surfaces = readArtifact("surfaces.json");
  const candidates = readArtifact("candidates.json");
  const curation = readArtifact("curation.json");
  const gaps = readArtifact("gaps.json");
  const reviewQueue = readArtifact("review-queue.json");
  const verification = readArtifact("verification/latest.json");
  const latestHealthHistoryDate = latestArtifactDate("health/history");
  const healthHistory = readArtifact(
    `health/history/${latestHealthHistoryDate}.json`,
  );
  const rpcEndpoints = readArtifact("rpc-endpoints.json");
  const endpoints = readArtifact("endpoints.json");
  const profiles = readArtifact("profiles.json");
  const subnetProfile = readArtifact("profiles/7.json");
  const subnetEndpoints = readArtifact("endpoints/7.json");
  const coverage = readArtifact("coverage.json");
  const coverageDepth = readArtifact("coverage-depth.json");
  const economics = readArtifact("economics.json");
  const contracts = readArtifact("contracts.json");
  const apiIndex = readArtifact("api-index.json");
  const changelog = readArtifact("changelog.json");
  const search = readArtifact("search.json");
  const freshness = readArtifact("freshness.json");
  const sourceHealth = readArtifact("source-health.json");
  const sourceSnapshots = readArtifact("source-snapshots.json");
  const evidenceLedger = readArtifact("evidence-ledger.json");
  const endpointPools = readArtifact("endpoint-pools.json");
  const endpointIncidents = readArtifact("endpoint-incidents.json");
  const rpcEndpointPools = readArtifact("rpc/pools.json");
  const providerEndpoints = readArtifact("providers/allways/endpoints.json");
  const providersArtifact = readArtifact("providers.json");
  const agentCatalog = readArtifact("agent-catalog.json");
  const lineage = readArtifact("lineage.json");
  const fixturesIndex = readArtifact("fixtures.json");
  const agentResources = readArtifact("agent-resources.json");
  const r2Manifest = readArtifact("r2-manifest.json");
  const schemaDrift = readArtifact("schema-drift.json");
  const schemaIndex = readArtifact("schemas/index.json");
  const reviewCuration = readArtifact("review/curation.json");
  const gapPriorities = readArtifact("review/gap-priorities.json");
  const profileCompleteness = readArtifact("review/profile-completeness.json");
  const adapterCandidates = readArtifact("review/adapter-candidates.json");
  const genericAdapter = readArtifact("adapters/numinous.json");
  const schemaOnlyGenericAdapter = readArtifact("adapters/sn-46.json");
  const enrichmentQueue = readArtifact("review/enrichment-queue.json");
  const enrichmentEvidence = readArtifact("review/enrichment-evidence.json");
  const enrichmentTargets = readArtifact("review/enrichment-targets.json");
  const reviewDecisions = readArtifact("review/maintainer-decisions.json");
  const generatedCandidateDiscovery = JSON.parse(
    readFileSync("registry/candidates/generated/public-sources.json", "utf8"),
  );

  assert.equal(subnets.subnets.length, native.subnets.length);

  // Chain Discord contact on the index (issue #344). Display-only fields sourced
  // from on-chain SubnetIdentitiesV3: a raw handle-or-URL (sanitized), a
  // normalized invite URL, and the contact_present flag.
  const nativeByNetuid = new Map(
    native.subnets.map((subnet) => [subnet.netuid, subnet]),
  );
  let handleOnlyCount = 0;
  let discordUrlCount = 0;
  let contactPresentCount = 0;
  for (const entry of subnets.subnets) {
    const chain = nativeByNetuid.get(entry.netuid)?.chain_identity || {};
    assert.equal(
      typeof entry.contact_present,
      "boolean",
      `subnet ${entry.netuid}: contact_present must be a boolean`,
    );
    assert.equal(
      entry.contact_present,
      Boolean(chain.contact_present),
      `subnet ${entry.netuid}: contact_present must mirror the chain flag`,
    );
    // discord is an exact, reproducible projection of the allowlisted chain
    // value, and discord_url is exactly its explicit-URL subset (no curated
    // overlay carries a discord_url yet — when one does, this needs the
    // overlay-aware expectation).
    assert.equal(
      entry.discord,
      nativeContactHandle(chain.discord),
      `subnet ${entry.netuid}: discord must reproduce nativeContactHandle(chain.discord)`,
    );
    assert.equal(
      entry.discord_url,
      nativeContactUrl(entry.discord),
      `subnet ${entry.netuid}: discord_url must be the URL subset of discord`,
    );
    assert.ok(
      entry.discord_url === null || /^https?:\/\//.test(entry.discord_url),
      `subnet ${entry.netuid}: discord_url must be null or an http(s) URL`,
    );
    if (entry.discord_url) discordUrlCount += 1;
    if (entry.discord && !entry.discord_url) handleOnlyCount += 1;
    if (entry.contact_present) contactPresentCount += 1;
  }
  // The whole point of #344: handles (not just invite links) reach a team, and
  // the contact_present flag is surfaced. Guard against a regression that nulls
  // everything or only keeps the URL subset.
  assert.ok(
    handleOnlyCount > 0,
    "expected subnets with a Discord handle but no invite URL",
  );
  assert.ok(
    discordUrlCount > 0,
    "expected subnets with a normalized Discord invite URL",
  );
  assert.equal(
    contactPresentCount,
    native.subnets.filter((s) => s.chain_identity?.contact_present).length,
    "contact_present count must match the native snapshot",
  );

  // The profile's native_identity uses the same shared contact projection as
  // the index (regression: normalizePublicUrl alone puffed the dotted handle
  // "dev.alveuslabs" into a fake https://dev.alveuslabs/ discord_url and
  // silently dropped plain handles).
  for (const profile of profiles.profiles) {
    const identity = profile.native_identity;
    if (!identity) continue;
    const chain = nativeByNetuid.get(profile.netuid)?.chain_identity || {};
    assert.equal(
      identity.discord,
      nativeContactHandle(chain.discord),
      `profile ${profile.netuid}: native_identity.discord must reproduce nativeContactHandle(chain.discord)`,
    );
    assert.equal(
      identity.discord_url,
      nativeContactUrl(identity.discord),
      `profile ${profile.netuid}: native_identity.discord_url must be the URL subset of discord`,
    );
  }

  // Derived domain tags (issue #345): index + profile carry the same shared
  // projection, reproducible from chain text + curated categories, and the
  // values are always drawn from the controlled vocabulary.
  let derivedTagCount = 0;
  const profileByNetuid = new Map(profiles.profiles.map((p) => [p.netuid, p]));
  for (const entry of subnets.subnets) {
    const chain = nativeByNetuid.get(entry.netuid)?.chain_identity || {};
    const expected = deriveDomainTags({
      description: chain.description,
      additional: chain.additional,
      categories: entry.categories,
    });
    assert.deepEqual(
      entry.derived_categories,
      expected,
      `subnet ${entry.netuid}: derived_categories must reproduce deriveDomainTags`,
    );
    const profile = profileByNetuid.get(entry.netuid);
    if (profile) {
      assert.deepEqual(
        profile.derived_categories,
        expected,
        `profile ${entry.netuid}: derived_categories must match the index projection`,
      );
    }
    if (entry.derived_categories.length) derivedTagCount += 1;
  }
  assert.ok(
    derivedTagCount > 0,
    "expected at least some subnets to carry a derived domain tag",
  );

  // derived_description (issue #346): a fallback blurb ONLY where the curated
  // description is null — never alongside a real description, and matching
  // between index and profile.
  let derivedDescCount = 0;
  for (const entry of subnets.subnets) {
    if (entry.description) {
      assert.equal(
        entry.derived_description,
        null,
        `subnet ${entry.netuid}: derived_description must be null when description is present`,
      );
    } else if (entry.derived_description) {
      assert.equal(typeof entry.derived_description, "string");
      derivedDescCount += 1;
    }
    const profile = profileByNetuid.get(entry.netuid);
    if (profile) {
      assert.equal(
        profile.derived_description ?? null,
        entry.derived_description ?? null,
        `profile ${entry.netuid}: derived_description must match the index`,
      );
    }
  }
  assert.ok(
    derivedDescCount > 0,
    "expected at least some null-description subnets to get a derived_description",
  );

  // Provider enrichment (issue #347): each provider record carries the netuids
  // it operates, counts, and a non-generic cluster id.
  const GENERIC_CLUSTER_HOSTS = new Set([
    "github.com",
    "gitlab.com",
    "huggingface.co",
    "discord.com",
    "discord.gg",
    "x.com",
    "twitter.com",
  ]);
  // Authoritative multi-tenant host set — shared with lib.mjs / build-artifacts
  // so the assertion can't drift from the cluster derivation (issue #419).
  const GENERIC_CLUSTER_HOST_SUFFIXES = [...MULTI_TENANT_HOST_SUFFIXES];
  let providersWithNetuids = 0;
  for (const provider of providersArtifact.providers) {
    assert.ok(
      Array.isArray(provider.netuids),
      `provider ${provider.id}: netuids must be an array`,
    );
    // sorted, unique, integer
    const sorted = [...provider.netuids].sort((a, b) => a - b);
    assert.deepEqual(
      provider.netuids,
      sorted,
      `provider ${provider.id}: sorted`,
    );
    assert.equal(
      provider.netuids.length,
      new Set(provider.netuids).size,
      `provider ${provider.id}: netuids unique`,
    );
    assert.equal(
      provider.subnet_count,
      provider.netuids.length,
      `provider ${provider.id}: subnet_count == netuids.length`,
    );
    assert.equal(typeof provider.surface_count, "number");
    assert.equal(typeof provider.endpoint_count, "number");
    assert.equal(typeof provider.cluster_id, "string");
    assert.ok(
      !GENERIC_CLUSTER_HOSTS.has(provider.cluster_id),
      `provider ${provider.id}: cluster_id must not be a generic host`,
    );
    assert.ok(
      !GENERIC_CLUSTER_HOST_SUFFIXES.some(
        (suffix) =>
          provider.cluster_id === suffix ||
          provider.cluster_id.endsWith(`.${suffix}`),
      ),
      `provider ${provider.id}: cluster_id must not be a multi-tenant host`,
    );
    if (provider.netuids.length) providersWithNetuids += 1;
  }
  assert.ok(
    providersWithNetuids > 0,
    "expected providers to be linked to the subnets they operate",
  );

  // Honest first-party substrate (issue #348): per-subnet official /
  // registry-observed counts + first_party flag, reconciled with coverage.
  let indexOfficialSum = 0;
  let firstPartySubnets = 0;
  for (const entry of subnets.subnets) {
    assert.equal(typeof entry.official_surface_count, "number");
    assert.equal(typeof entry.registry_observed_count, "number");
    assert.equal(
      entry.first_party,
      entry.official_surface_count > 0,
      `subnet ${entry.netuid}: first_party must mean official_surface_count > 0`,
    );
    indexOfficialSum += entry.official_surface_count;
    if (entry.first_party) firstPartySubnets += 1;
  }
  assert.equal(
    indexOfficialSum,
    coverage.official_surface_count,
    "coverage official_surface_count must equal the sum across the index",
  );
  assert.equal(
    firstPartySubnets,
    coverage.first_party_subnet_count,
    "coverage first_party_subnet_count must match the index",
  );
  assert.equal(
    coverage.subnets_without_official_surface,
    subnets.subnets.length - firstPartySubnets,
    "subnets_without_official_surface is the curation-target count",
  );
  assert.ok(
    coverage.official_surface_count < coverage.surface_count,
    "first-party surfaces must be an honest subset of all surfaces",
  );

  // Real published_at + deterministic content_hash on agent payloads (issue
  // #349): generated_at stays the deterministic stamp; published_at is real (or
  // null), never a misleading 1970 stamp; content_hash is a stable fingerprint.
  assert.ok(
    "published_at" in agentCatalog,
    "agent-catalog must expose published_at",
  );
  assert.ok(
    agentCatalog.published_at === null ||
      !Number.isNaN(Date.parse(agentCatalog.published_at)),
    "agent-catalog published_at must be null or a real ISO timestamp",
  );
  assert.equal(
    typeof agentCatalog.content_hash,
    "string",
    "agent-catalog must carry a deterministic content_hash",
  );
  assert.ok(agentCatalog.content_hash.length >= 16);
  assert.equal(
    agentCatalog.total_subnet_count,
    agentCatalog.subnet_count + agentCatalog.blocked_subnet_count,
    "agent-catalog callable + blocked counts must cover every subnet",
  );
  assert.ok(
    Array.isArray(agentCatalog.blocked_subnets) &&
      agentCatalog.blocked_subnets.length > 0,
    "agent-catalog must explain blocked/non-callable subnets",
  );
  assert.equal(
    agentCatalog.blocked_subnet_count,
    agentCatalog.blocked_subnets.length,
    "blocked_subnet_count must match blocked_subnets length",
  );
  assert.ok(
    agentCatalog.subnets.every(
      (entry) => entry.agent_readiness?.status === "callable",
    ),
    "callable agent-catalog entries must carry callable readiness status",
  );
  const blockedRecall = agentCatalog.blocked_subnets.find(
    (entry) => entry.netuid === 31,
  );
  assert.ok(blockedRecall, "SN31 should be represented as a blocked subnet");
  assert.equal(blockedRecall.agent_readiness.status, "blocked");
  assert.ok(
    blockedRecall.agent_readiness.blockers.some(
      (blocker) => blocker.code === "missing-callable-service",
    ),
    "blocked subnets must explain the missing callable service",
  );
  const rootBlocker = agentCatalog.blocked_subnets.find(
    (entry) => entry.netuid === 0,
  );
  assert.equal(rootBlocker.agent_readiness.status, "base-layer");
  assert.ok(
    rootBlocker.agent_readiness.blockers.some(
      (blocker) => blocker.code === "base-layer-only",
    ),
    "root subnet must explain the base-layer-only boundary",
  );
  assert.ok(
    agentCatalog.blocker_summary.by_code["missing-callable-service"] > 0,
    "blocker summary must count missing callable service blockers",
  );
  assert.equal(
    coverageDepth.subnet_count,
    subnets.subnets.length,
    "coverage-depth must score every subnet",
  );
  assert.equal(
    coverageDepth.summary.row_count,
    coverageDepth.rows.length,
    "coverage-depth row summary must match rows",
  );
  assert.ok(
    coverageDepth.rows.every(
      (row, index, rows) => index === 0 || rows[index - 1].netuid < row.netuid,
    ),
    "coverage-depth rows must be sorted by netuid",
  );
  assert.equal(
    Object.values(coverageDepth.summary.tier_counts).reduce(
      (sum, count) => sum + count,
      0,
    ),
    coverageDepth.rows.length,
    "coverage-depth tier counts must cover every row",
  );
  assert.equal(
    coverageDepth.summary.queue_count,
    coverageDepth.ranked_queue.length,
    "coverage-depth queue_count must match the ranked queue",
  );
  assert.ok(
    coverageDepth.ranked_queue.every(
      (entry, index, rows) =>
        index === 0 ||
        rows[index - 1].priority_score > entry.priority_score ||
        (rows[index - 1].priority_score === entry.priority_score &&
          (rows[index - 1].score < entry.score ||
            (rows[index - 1].score === entry.score &&
              rows[index - 1].netuid < entry.netuid))),
    ),
    "coverage-depth ranked_queue must have deterministic priority order",
  );
  assert.ok(
    coverageDepth.summary.severity_counts["missing-data"] > 0,
    "coverage-depth must summarize missing-data gaps",
  );
  assert.ok(
    coverageDepth.summary.tier_counts["hard-blocked"] > 0,
    "coverage-depth must separate hard-blocked subnets",
  );
  const coverageDepthAllways = coverageDepth.rows.find(
    (entry) => entry.netuid === 7,
  );
  assert.ok(coverageDepthAllways, "SN7 must have a coverage-depth row");
  assert.equal(coverageDepthAllways.agent_status, "callable");
  assert.ok(
    coverageDepthAllways.dimensions.callable_service_count > 0,
    "SN7 coverage-depth row must count callable services",
  );
  assert.ok(
    coverageDepthAllways.top_gap_codes.includes("missing-fixture"),
    "SN7 coverage-depth row must expose deterministic fixture absence",
  );
  const coverageDepthRecall = coverageDepth.rows.find(
    (entry) => entry.netuid === 31,
  );
  assert.equal(coverageDepthRecall.agent_status, "blocked");
  assert.ok(
    coverageDepthRecall.top_gap_codes.includes("missing-callable-service"),
    "SN31 coverage-depth row must carry missing callable-service blocker",
  );
  assert.ok(
    coverageDepth.ranked_queue.some(
      (entry) =>
        entry.top_gap_codes.includes("missing-fixture") ||
        entry.top_gap_codes.includes("missing-schema") ||
        entry.top_gap_codes.includes("candidate-api-needs-review"),
    ),
    "coverage-depth queue must contain actionable enrichment gaps",
  );
  const catalog31 = readArtifact("agent-catalog/31.json");
  assert.equal(catalog31.agent_readiness.status, "blocked");
  assert.ok(
    catalog31.agent_readiness.missing_fields.includes("surfaces"),
    "per-subnet detail must expose blocker missing_fields",
  );
  const callableAgentServices = agentCatalog.subnets.flatMap((subnet) =>
    readArtifact(`agent-catalog/${subnet.netuid}.json`).services.filter(
      (service) => service.eligibility?.callable,
    ),
  );
  const callableWithoutSchema = callableAgentServices.filter(
    (service) => !service.schema_artifact,
  );
  // The callable-service population grows with every community surface addition,
  // so we assert the schema-projection invariants rather than freezing an
  // absolute count (a frozen count red-flagged legitimate single-file data PRs
  // for every callable surface added). The concrete projection behaviour is
  // pinned per-surface below (SN7/56/110/64).
  assert.ok(
    callableAgentServices.length > 0,
    "agent-catalog must project callable services",
  );
  assert.ok(
    callableWithoutSchema.length > 0 &&
      callableWithoutSchema.length < callableAgentServices.length,
    "same-origin schema projection should reduce — but not eliminate — callable services without schema artifacts",
  );
  assert.ok(
    callableAgentServices
      .filter((service) => service.kind === "sse")
      .every(
        (service) => service.schema_source?.match !== "same-origin-openapi",
      ),
    "SSE streams should not inherit same-origin OpenAPI schemas implicitly",
  );
  const serviceById = (catalog, surfaceId) =>
    catalog.services.find((service) => service.surface_id === surfaceId);
  const catalog7 = readArtifact("agent-catalog/7.json");
  const allwaysHealth = serviceById(catalog7, "allways-api-health");
  assert.equal(
    allwaysHealth.schema_artifact,
    "/metagraph/schemas/allways-swagger.json",
    "SN7 endpoint rows should inherit the same-origin captured OpenAPI artifact",
  );
  assert.equal(allwaysHealth.schema_source.match, "same-origin-openapi");
  assert.equal(
    allwaysHealth.schema_source.url,
    "https://api.all-ways.io/swagger-json",
  );
  const allwaysSse = serviceById(catalog7, "allways-sse");
  assert.equal(
    allwaysSse.schema_artifact,
    null,
    "SSE streams require an explicit schema match",
  );
  const catalog56 = readArtifact("agent-catalog/56.json");
  const gradientsPerformance = serviceById(
    catalog56,
    "sn-56-gradients-last-boss-battle",
  );
  assert.equal(
    gradientsPerformance.schema_source.match,
    "schema-url",
    "SN56 endpoint rows with schema_url should resolve by exact schema URL",
  );
  const catalog110 = readArtifact("agent-catalog/110.json");
  const greenComputeChat = serviceById(
    catalog110,
    "sn-110-green-compute-chat-completions-api",
  );
  assert.equal(
    greenComputeChat.schema_source.match,
    "same-origin-openapi",
    "SN110 endpoint rows should resolve through same-origin OpenAPI",
  );
  const catalog64ForSchemas = readArtifact("agent-catalog/64.json");
  const chutesPricing = serviceById(
    catalog64ForSchemas,
    "sn-64-chutes-pricing-api",
  );
  assert.equal(
    chutesPricing.schema_artifact,
    null,
    "explicit not-captured schema statuses must not be overridden",
  );
  assert.equal(chutesPricing.schema_status, "not-captured");

  // Cross-network lineage (issue #353): mainnet ↔ testnet mapping, with the
  // profile's lineage reconciled against the standalone artifact.
  assert.equal(lineage.source_network, "mainnet");
  assert.equal(lineage.target_network, "testnet");
  assert.equal(Array.isArray(lineage.links), true);
  assert.ok(lineage.link_count > 0, "expected lineage links between networks");
  assert.equal(lineage.link_count, lineage.links.length);
  const lineageMainnetNetuids = new Set();
  for (const link of lineage.links) {
    assert.equal(typeof link.mainnet_netuid, "number");
    assert.equal(typeof link.testnet_netuid, "number");
    assert.ok(["github_repo", "chain_name"].includes(link.matched_by));
    lineageMainnetNetuids.add(link.mainnet_netuid);
  }
  assert.equal(lineage.graduated_subnet_count, lineageMainnetNetuids.size);

  // Captured-fixtures index (issue #352): well-formed and self-consistent. The
  // deterministic build has no capture, so the count is 0 here; the per-surface
  // bodies + populated index arrive via the capture:fixtures refresh step.
  assert.equal(typeof fixturesIndex.fixture_count, "number");
  assert.equal(Array.isArray(fixturesIndex.fixtures), true);
  assert.equal(fixturesIndex.fixture_count, fixturesIndex.fixtures.length);
  assert.equal(
    fixturesIndex.candidate_count,
    fixturesIndex.coverage.length,
    "fixture candidate_count must match coverage rows",
  );
  assert.equal(
    fixturesIndex.missing_count,
    fixturesIndex.coverage.filter((entry) => entry.status !== "available")
      .length,
    "fixture missing_count must summarize non-available coverage rows",
  );
  assert.equal(
    fixturesIndex.status_counts.missing,
    fixturesIndex.candidate_count,
    "deterministic no-capture builds should classify fixture candidates as missing",
  );
  const allwaysFixtureCandidate = fixturesIndex.coverage.find(
    (entry) => entry.surface_id === "allways-api-health",
  );
  assert.equal(allwaysFixtureCandidate.status, "missing");
  const allwaysFixtureService = readArtifact(
    "agent-catalog/7.json",
  ).services.find((service) => service.surface_id === "allways-api-health");
  assert.equal(allwaysFixtureService.fixture_status.status, "missing");
  const allwaysSseFixtureService = readArtifact(
    "agent-catalog/7.json",
  ).services.find((service) => service.surface_id === "allways-sse");
  assert.equal(
    allwaysSseFixtureService.fixture_status.status,
    "unsupported-kind",
  );
  const allwaysHistoryFixtureService = readArtifact(
    "agent-catalog/7.json",
  ).services.find((service) => service.surface_id === "allways-crown-history");
  assert.equal(allwaysHistoryFixtureService.fixture_status.status, "non-get");

  // AI-resources index: the copyable agent + the live MCP tool list + resources.
  assert.match(agentResources.copyable_agent.url, /\/agent\.md$/);
  assert.match(agentResources.mcp.install, /^claude mcp add/);
  assert.ok(agentResources.mcp.tools.length > 5, "expected MCP tools listed");
  assert.ok(
    agentResources.mcp.tools.some((t) => t.name === "how_do_i_call"),
    "MCP tool list must reflect the live server tools",
  );
  assert.ok(
    agentResources.resources.some((r) => r.id === "agent"),
    "resources must include the copyable agent",
  );
  assert.ok(
    agentResources.resources.some((r) => r.id === "agent-workflows"),
    "resources must include the public agent workflow guide",
  );
  assert.ok(agentResources.resources.every((r) => r.id && r.title && r.url));
  // every profile that claims to have graduated appears in the lineage artifact
  for (const profile of profiles.profiles) {
    if (profile.lineage) {
      assert.equal(profile.lineage.graduated_from_testnet, true);
      assert.ok(profile.lineage.also_on.length > 0);
      assert.ok(
        lineageMainnetNetuids.has(profile.netuid),
        `profile ${profile.netuid}: lineage must be reflected in lineage.json`,
      );
    }
  }
  // The domain coverage facet sums the per-subnet tags.
  assert.equal(typeof coverage.domain_coverage, "object");
  const facetSum = Object.values(coverage.domain_coverage).reduce(
    (a, b) => a + b,
    0,
  );
  const tagSum = subnets.subnets.reduce(
    (a, s) => a + s.derived_categories.length,
    0,
  );
  assert.equal(
    facetSum,
    tagSum,
    "domain_coverage counts must sum to the total derived tags on the index",
  );

  assert.equal(surfaces.surfaces.length, coverage.surface_count);
  assert.equal(
    rpcEndpoints.endpoints.length,
    surfaces.surfaces.filter((surface) =>
      ["subtensor-rpc", "subtensor-wss"].includes(surface.kind),
    ).length,
  );
  assert.equal(
    rpcEndpoints.endpoints.every((endpoint) => endpoint.netuid === 0),
    true,
  );
  assert.equal(endpoints.endpoints.length, surfaces.surfaces.length);
  assert.equal(profiles.profiles.length, native.subnets.length);
  const candidateDiscoverySource = freshness.sources.find(
    (source) => source.id === "candidate-discovery",
  );
  const expectedCandidateDiscoveryAsOf =
    generatedCandidateDiscovery.observed_at ||
    generatedCandidateDiscovery.last_observed_at ||
    (generatedCandidateDiscovery.generated_at &&
    generatedCandidateDiscovery.generated_at !== "1970-01-01T00:00:00.000Z"
      ? generatedCandidateDiscovery.generated_at
      : null);
  assert.equal(
    freshness.summary.candidate_discovery_as_of,
    expectedCandidateDiscoveryAsOf,
  );
  assert.equal(candidateDiscoverySource.as_of, expectedCandidateDiscoveryAsOf);
  assert.equal(
    candidateDiscoverySource.status,
    expectedCandidateDiscoveryAsOf ? "captured" : "missing",
  );
  if (schemaDrift.source === "openapi-snapshot") {
    const schemaSnapshotAsOf =
      schemaDrift.observed_at || schemaDrift.generated_at;
    assert.equal(freshness.summary.schema_snapshot_as_of, schemaSnapshotAsOf);
    assert.equal(
      freshness.sources.find((source) => source.id === "schema-drift")?.as_of,
      schemaSnapshotAsOf,
    );
  }
  assert.equal(
    profiles.profiles.every(
      (profile) =>
        Number.isInteger(profile.completeness_score) &&
        profile.completeness_score >= 0 &&
        profile.completeness_score <= 100 &&
        ["none", "directory", "partial", "complete"].includes(
          profile.identity_level,
        ) &&
        Number.isInteger(profile.identity_surface_count) &&
        profile.identity_surface_count >= 0 &&
        profile.identity_surface_count <= 3 &&
        Array.isArray(profile.missing_identity) &&
        profile.identity_surface_count + profile.missing_identity.length ===
          3 &&
        Array.isArray(profile.missing_required) &&
        Array.isArray(profile.missing_operational) &&
        Array.isArray(profile.gap_reasons) &&
        Array.isArray(profile.suggested_submission_kinds) &&
        profile.gap_reasons.length === profile.completeness.gap_reasons.length,
    ),
    true,
  );
  assert.equal(
    profileCompleteness.profiles.every(
      (profile) =>
        Array.isArray(profile.missing_required) &&
        Array.isArray(profile.missing_identity) &&
        Array.isArray(profile.missing_operational) &&
        Array.isArray(profile.supported_interface_kinds) &&
        ["none", "directory", "partial", "complete"].includes(
          profile.identity_level,
        ) &&
        Number.isInteger(profile.identity_surface_count) &&
        Number.isInteger(profile.source_count) &&
        Number.isInteger(profile.operational_interface_count) &&
        typeof profile.curation_level === "string" &&
        typeof profile.review_state === "string" &&
        ["chain", "placeholder", "empty"].includes(profile.native_name_quality),
    ),
    true,
  );
  assert.equal(subnetProfile.profile.netuid, 7);
  assert.equal(subnetProfile.profile.profile_level, "adapter-backed");
  assert.equal(
    subnetProfile.profile.operational_interface_kinds.includes("subnet-api"),
    true,
  );
  assert.equal(
    endpoints.endpoints.every(
      (endpoint) =>
        endpoint.publication_state === "pool-eligible" ||
        endpoint.publication_state === "monitored" ||
        endpoint.publication_state === "verified" ||
        endpoint.publication_state === "disabled",
    ),
    true,
  );
  assert.equal(
    endpoints.endpoints.filter((endpoint) => endpoint.pool_eligible).length <=
      endpointPools.pools.reduce((sum, pool) => sum + pool.eligible_count, 0),
    true,
  );
  assert.equal(Array.isArray(endpointPools.provider_scores), true);
  assert.equal(
    endpoints.endpoints.every((endpoint) =>
      Array.isArray(endpoint.pool_eligibility_reasons),
    ),
    true,
  );
  assert.equal(
    endpoints.endpoints.every((endpoint) =>
      Array.isArray(endpoint.score_reasons),
    ),
    true,
  );
  assert.equal(
    endpointIncidents.summary.incident_count,
    endpointIncidents.incidents.length,
  );
  assert.equal(
    endpointIncidents.incidents.every(
      (incident) =>
        incident.source === "probe-derived" && !incident.user_reported,
    ),
    true,
  );
  assert.equal(
    subnetEndpoints.endpoints.every((endpoint) => endpoint.netuid === 7),
    true,
  );
  assert.equal(
    providerEndpoints.endpoints.every(
      (endpoint) => endpoint.provider === "allways",
    ),
    true,
  );
  assert.equal(healthHistory.date, latestHealthHistoryDate);
  assert.equal(
    healthHistory.surfaces.length,
    surfaces.surfaces.filter(
      (surface) => surface.probe?.enabled && surface.public_safe,
    ).length,
  );
  assert.equal(
    healthHistory.surfaces.every((surface) => !Object.hasOwn(surface, "url")),
    true,
  );
  // #1006: per-field provenance. Every served surface exposes last_verified_at
  // (string|null) + a `stale` boolean, and `stale` is reproducible from the
  // helper against the committed native-snapshot captured_at.
  const surfaceNowMs = Date.parse(native.captured_at);
  for (const surface of surfaces.surfaces) {
    assert.ok(
      surface.last_verified_at === null ||
        typeof surface.last_verified_at === "string",
      `surface ${surface.id} last_verified_at must be a string or null`,
    );
    assert.equal(
      typeof surface.stale,
      "boolean",
      `surface ${surface.id} must carry a boolean stale flag`,
    );
    assert.equal(
      surface.stale,
      isSurfaceStale(surface.last_verified_at, surface.kind, surfaceNowMs),
      `surface ${surface.id} stale flag must match the freshness helper`,
    );
  }
  // The curation→surface verified_at join must actually populate timestamps, not
  // leave every surface unverified (guard against a silent no-op).
  assert.ok(
    surfaces.surfaces.some((surface) => surface.last_verified_at !== null),
    "expected at least one surface to carry a last_verified_at timestamp",
  );
  // #1008: code-examples entity. example-kind surfaces are indexed + surfaced in
  // the agent-catalog (per-subnet `examples` + `example_count`); they also flow
  // into every subnet's profile via supported_interface_kinds.
  const exampleSurfaces = surfaces.surfaces.filter(
    (surface) => surface.kind === "example",
  );
  assert.ok(
    exampleSurfaces.length >= 5,
    `expected >=5 example surfaces, got ${exampleSurfaces.length}`,
  );
  assert.equal(
    exampleSurfaces.every((surface) => /^https?:\/\//.test(surface.url)),
    true,
    "example surfaces must carry an http(s) url",
  );
  // The agent-catalog index carries example_count, and the per-subnet detail
  // lists the examples. SN64 (chutes) has both a callable service and an example.
  assert.equal(
    agentCatalog.subnets.every((entry) =>
      Number.isInteger(entry.example_count),
    ),
    true,
    "every agent-catalog index entry must carry an integer example_count",
  );
  const catalog64 = readArtifact("agent-catalog/64.json");
  assert.ok(
    catalog64.example_count >= 1 && catalog64.examples.length >= 1,
    "SN64 agent-catalog must surface its example",
  );
  assert.equal(catalog64.examples.length, catalog64.example_count);
  assert.equal(
    catalog64.examples.every(
      (example) => example.surface_id && /^https?:\/\//.test(example.url),
    ),
    true,
    "agent-catalog examples must carry a surface_id + http(s) url",
  );
  // Examples reach the subnet profile through supported_interface_kinds.
  const profile64 = readArtifact("profiles/64.json").profile;
  assert.equal(
    profile64.supported_interface_kinds.includes("example"),
    true,
    "a subnet with an example surface must list it in supported_interface_kinds",
  );
  assert.equal(coverage.chain_subnet_count, native.subnets.length);
  assert.equal(coverage.curated_overlay_count, native.subnets.length);
  assert.equal(coverage.native_only_count, 0);
  assert.equal(coverage.candidate_count, candidates.candidates.length);
  assert.equal(coverage.candidate_subnet_count, native.subnets.length);
  // Public completeness scoreboard (the trustworthy-coverage moat metric).
  assert.equal(
    coverage.completeness.scored_subnet_count,
    profiles.profiles.length,
  );
  assert.ok(coverage.completeness.average_score >= 0);
  assert.ok(coverage.completeness.average_score <= 100);
  assert.equal(
    typeof coverage.completeness.dimension_coverage.docs.pct,
    "number",
  );
  assert.equal(
    Object.values(coverage.completeness.score_distribution).reduce(
      (sum, value) => sum + value,
      0,
    ),
    coverage.completeness.scored_subnet_count,
  );
  assert.equal(curation.curation.length, native.subnets.length);
  assert.equal(gaps.gaps.length, native.subnets.length);
  assert.equal(verification.candidate_count, verification.results.length);
  assert.equal(
    verification.results.length <= candidates.candidates.length,
    true,
  );
  const candidateIds = new Set(
    candidates.candidates.map((candidate) => candidate.id),
  );
  assert.equal(
    verification.results.every((result) =>
      candidateIds.has(result.candidate_id),
    ),
    true,
  );
  assert.equal(reviewQueue.count, reviewQueue.candidates.length);
  // #1002: candidate ↔ curated-surface dedup. Every candidate carries a
  // superseded_by field; when set it points to the curated surface that shares
  // its (netuid, kind, normalized-url) identity, and such candidates are
  // excluded from the review/enrichment queue so duplicates are not re-targeted.
  const surfaceIdByRegistryKey = new Map(
    surfaces.surfaces.map((surface) => [
      registrySurfaceKey(surface),
      surface.id,
    ]),
  );
  for (const candidate of candidates.candidates) {
    assert.ok(
      "superseded_by" in candidate,
      `candidate ${candidate.id} is missing the superseded_by field`,
    );
    if (candidate.superseded_by) {
      assert.equal(
        candidate.superseded_by,
        surfaceIdByRegistryKey.get(registrySurfaceKey(candidate)),
        `candidate ${candidate.id} superseded_by must equal the curated surface sharing its identity`,
      );
    } else {
      assert.equal(
        surfaceIdByRegistryKey.has(registrySurfaceKey(candidate)),
        false,
        `candidate ${candidate.id} has no superseded_by yet a curated surface shares its identity`,
      );
    }
  }
  assert.equal(
    reviewQueue.candidates.some((candidate) => candidate.superseded_by),
    false,
    "review queue must not contain candidates superseded by a curated surface",
  );
  // Guard against a no-op: the dedup must actually fire on real registry data.
  assert.ok(
    candidates.candidates.some((candidate) => candidate.superseded_by),
    "expected at least one candidate to be superseded by a curated surface",
  );
  // #1002 PR2: count propagation. A surface-superseded candidate is the curated
  // surface already present in `surfaces`, so it must not be counted or listed as
  // a distinct candidate. coverage keeps the raw registry totals (mirroring
  // candidates.json), but every per-subnet count/list, profile, overview, and the
  // enrichment/curation leaderboards drop the dupe.
  const activeCandidates = candidates.candidates.filter(
    (candidate) => !candidate.superseded_by,
  );
  const activeByNetuid = new Map();
  for (const candidate of activeCandidates) {
    activeByNetuid.set(
      candidate.netuid,
      (activeByNetuid.get(candidate.netuid) || 0) + 1,
    );
  }
  const subnetNetuids = new Set(subnets.subnets.map((subnet) => subnet.netuid));
  const perSubnetCandidateTotal = subnets.subnets.reduce(
    (sum, subnet) => sum + subnet.candidate_count,
    0,
  );
  assert.equal(
    perSubnetCandidateTotal,
    activeCandidates.filter((candidate) => subnetNetuids.has(candidate.netuid))
      .length,
    "per-subnet candidate_count must sum to the active (non-superseded) candidate count",
  );
  assert.ok(
    perSubnetCandidateTotal < candidates.candidates.length,
    "per-subnet candidate_count must exclude superseded candidates (dedup must fire)",
  );
  // coverage stays raw — its candidate_count mirrors the full candidates.json
  // registry, so it is intentionally larger than the deduplicated per-subnet sum.
  assert.ok(
    coverage.candidate_count > perSubnetCandidateTotal,
    "coverage.candidate_count (raw registry) must exceed the deduplicated per-subnet sum",
  );
  // Every subnet's index candidate_count equals its non-superseded candidate count.
  for (const subnet of subnets.subnets) {
    assert.equal(
      subnet.candidate_count,
      activeByNetuid.get(subnet.netuid) || 0,
      `subnet ${subnet.netuid} candidate_count must equal its non-superseded candidate count`,
    );
  }
  // Detail, profile, and overview agree on the deduplicated count and never
  // re-list a candidate that collides with a curated surface. netuid 7 has
  // superseded candidates, so this exercises the dedup, not a vacuous pass.
  const subnetDetail7 = readArtifact("subnets/7.json");
  const overview7 = readArtifact("overview/7.json");
  const subnet7Index = subnets.subnets.find((subnet) => subnet.netuid === 7);
  const rawCandidateCount7 = candidates.candidates.filter(
    (candidate) => candidate.netuid === 7,
  ).length;
  assert.ok(
    subnet7Index.candidate_count < rawCandidateCount7,
    "netuid 7 candidate_count must drop its superseded candidates",
  );
  assert.equal(
    subnetDetail7.candidate_surfaces.length,
    subnet7Index.candidate_count,
  );
  assert.equal(subnetDetail7.candidates.length, subnet7Index.candidate_count);
  assert.equal(overview7.counts.candidates, subnet7Index.candidate_count);
  assert.equal(
    subnetProfile.profile.candidate_count,
    subnet7Index.candidate_count,
  );
  assert.equal(
    subnetProfile.candidate_surfaces.length,
    subnet7Index.candidate_count,
  );
  assert.equal(
    subnetProfile.candidate_surfaces.every(
      (candidate) => !candidate.superseded_by,
    ),
    true,
    "profile candidate_surfaces must exclude superseded candidates",
  );
  for (const candidate of subnetDetail7.candidate_surfaces) {
    assert.equal(
      surfaceIdByRegistryKey.has(registrySurfaceKey(candidate)),
      false,
      `subnets/7 candidate_surfaces must exclude candidate ${candidate.id} colliding with a curated surface`,
    );
  }
  // Leaderboards: the curation review counts the active candidates exactly; the
  // enrichment queue never exceeds them (it further drops baseline-excluded ids).
  for (const priority of reviewCuration.gap_priorities) {
    assert.equal(
      priority.candidate_count,
      activeByNetuid.get(priority.netuid) || 0,
      `curation review netuid ${priority.netuid} candidate_count must equal its non-superseded candidate count`,
    );
  }
  for (const entry of enrichmentQueue.queue) {
    assert.ok(
      entry.candidate_count <= (activeByNetuid.get(entry.netuid) || 0),
      `enrichment queue netuid ${entry.netuid} candidate_count must not exceed its non-superseded candidate count`,
    );
  }
  // #1007: corroboration — every candidate carries confirmed_by (distinct
  // discovery sources from source_urls); some are corroborated by 2+ sources.
  for (const candidate of candidates.candidates) {
    assert.ok(
      Array.isArray(candidate.confirmed_by),
      `candidate ${candidate.id} confirmed_by must be an array`,
    );
  }
  assert.ok(
    candidates.candidates.some(
      (candidate) => (candidate.confirmed_by || []).length >= 2,
    ),
    "expected at least one candidate corroborated by 2+ distinct sources",
  );
  // #1009: economics entity — per-subnet validator/economic rows + summary.
  assert.ok(Array.isArray(economics.subnets), "economics.subnets is an array");
  assert.equal(
    economics.subnets.length,
    economics.summary.with_economics_count,
    "economics summary count matches the rows",
  );
  assert.ok(
    economics.subnets.length > 0,
    "expected economics rows from the chain snapshot",
  );
  for (const row of economics.subnets) {
    assert.equal(typeof row.netuid, "number");
    assert.equal(typeof row.validator_count, "number");
    assert.equal(typeof row.miner_count, "number");
    assert.ok(
      row.emission_share === null ||
        (row.emission_share >= 0 && row.emission_share <= 1),
      `emission_share in [0,1] or null for SN${row.netuid}`,
    );
  }
  // Rows are ordered by emission share, highest first.
  assert.equal(
    economics.subnets.every(
      (row, i) =>
        i === 0 ||
        (row.emission_share ?? -1) <=
          (economics.subnets[i - 1].emission_share ?? -1),
    ),
    true,
    "economics rows ordered by emission_share desc",
  );
  // Price-weighted shares sum to ~1 across all priced subnets.
  const economicsShareSum = economics.subnets.reduce(
    (sum, row) => sum + (row.emission_share || 0),
    0,
  );
  assert.ok(
    Math.abs(economicsShareSum - 1) < 0.001,
    `emission_share sums to ~1 (got ${economicsShareSum})`,
  );
  assert.equal(contracts.primary_domain, "api.metagraph.sh");
  assert.equal(contracts.status_domain, null);
  assert.equal(
    contracts.artifacts.some(
      (artifact) =>
        artifact.id === "contracts" &&
        artifact.schema_ref === "#/components/schemas/ContractsArtifact",
    ),
    true,
  );
  assert.equal(
    contracts.artifacts.some(
      (artifact) =>
        artifact.id === "health-history" &&
        artifact.schema_ref === "#/components/schemas/HealthHistoryArtifact",
    ),
    true,
  );
  assert.equal(
    contracts.artifacts.some(
      (artifact) =>
        artifact.id === "endpoint-incidents" &&
        artifact.schema_ref ===
          "#/components/schemas/EndpointIncidentsArtifact",
    ),
    true,
  );
  assert.equal(
    new Set(contracts.artifacts.map((artifact) => artifact.id)).size,
    contracts.artifacts.length,
  );
  assert.equal(
    apiIndex.routes.some((route) => route.path === "/api/v1/subnets"),
    true,
  );
  assert.equal(
    apiIndex.routes.some((route) => route.path === "/api/v1/changelog"),
    true,
  );
  assert.equal(
    apiIndex.routes.some((route) => route.path === "/api/v1/source-snapshots"),
    true,
  );
  assert.equal(changelog.source, "generated-artifact-diff");
  assert.equal(search.document_count, search.documents.length);
  // Slim search index (roadmap Finding 8): the same documents as search.json
  // minus the per-document `tokens` keyword blobs, for a much lighter browser
  // payload. It must stay in lock-step with the full index (same count + ids,
  // same display fields) and carry no token blobs.
  const searchIndex = readArtifact("search-index.json");
  assert.equal(searchIndex.document_count, search.document_count);
  assert.equal(searchIndex.documents.length, search.documents.length);
  assert.equal(
    searchIndex.documents.every(
      (document) => !Object.hasOwn(document, "tokens"),
    ),
    true,
    "slim search index documents must not carry token blobs",
  );
  assert.deepEqual(
    searchIndex.documents.map((document) => document.id),
    search.documents.map((document) => document.id),
    "slim search index must preserve the full index's documents and order",
  );
  for (const slimDocument of searchIndex.documents) {
    const fullDocument = search.documents.find(
      (document) => document.id === slimDocument.id,
    );
    const { tokens: _tokens, ...expected } = fullDocument;
    assert.deepEqual(
      slimDocument,
      expected,
      `slim search document ${slimDocument.id} must equal the full document minus tokens`,
    );
  }
  const nodexoSearchDocument = search.documents.find(
    (document) => document.id === "subnet:27",
  );
  // subnet:27 is indexed with a title + non-empty tokens. The specific token
  // WORDS derive from the live chain description (which changes over time), so
  // assert structure here, not volatile content — semantic/meaningful-word
  // tokenization is covered by tests/search-quality.test.mjs.
  assert.equal(typeof nodexoSearchDocument?.title, "string");
  assert.equal(
    Array.isArray(nodexoSearchDocument?.tokens) &&
      nodexoSearchDocument.tokens.length > 0,
    true,
  );
  assert.equal(
    freshness.summary.native_snapshot_captured_at,
    native.captured_at,
  );
  assert.equal(freshness.summary.native_data_as_of, native.captured_at);
  assert.equal(
    freshness.summary.blocking_source_count,
    freshness.sources.filter((source) => source.stale_behavior === "block")
      .length,
  );
  assert.equal(
    freshness.summary.missing_blocking_source_count,
    freshness.sources.filter(
      (source) =>
        source.stale_behavior === "block" && source.status === "missing",
    ).length,
  );
  for (const source of freshness.sources) {
    assert.equal(source.as_of, source.timestamp);
    assert.equal(typeof source.required_for_publish, "boolean");
    assert.equal(["block", "warn"].includes(source.stale_behavior), true);
  }
  // surface-health is warn-only now: operational health is served LIVE from the
  // 2-minute cron prober (D1/KV), so the 6h full-surface probe is a fallback and
  // must never block publish. This is the decoupling that fixed the cascade.
  assert.equal(
    freshness.sources.some(
      (source) =>
        source.id === "surface-health" &&
        source.lane === "health-probe" &&
        source.stale_behavior === "warn" &&
        source.required_for_publish === false,
    ),
    true,
  );
  assert.equal(sourceHealth.summary.provider_count > 0, true);
  assert.equal(
    sourceSnapshots.summary.source_count,
    sourceSnapshots.sources.length,
  );
  assert.equal(
    sourceSnapshots.sources.some((source) => source.id === "native-subnets"),
    true,
  );
  assert.equal(
    evidenceLedger.summary.claim_count,
    evidenceLedger.claims.length,
  );
  assert.equal(endpointPools.pools.length >= 3, true);
  assert.equal(rpcEndpointPools.pools.length >= 3, true);
  assert.equal(r2Manifest.artifact_count, r2Manifest.artifacts.length);
  assert.equal(
    schemaDrift.openapi_surface_count ?? schemaDrift.summary?.surface_count,
    surfaces.surfaces.filter((surface) => surface.kind === "openapi").length,
  );
  assert.equal(Array.isArray(schemaIndex.schemas), true);
  assert.equal(reviewCuration.summary.subnet_count, native.subnets.length);
  assert.equal(gapPriorities.priorities.length, native.subnets.length);
  assert.equal(profileCompleteness.profiles.length, native.subnets.length);
  assert.equal(enrichmentQueue.summary.subnet_count, native.subnets.length);
  assert.equal(enrichmentQueue.summary.queue_count, native.subnets.length);
  assert.equal(enrichmentQueue.queue.length, native.subnets.length);
  assert.equal(enrichmentEvidence.summary.subnet_count, native.subnets.length);
  assert.equal(enrichmentEvidence.entries.length, native.subnets.length);
  assert.equal(
    enrichmentTargets.summary.target_count,
    enrichmentTargets.targets.length,
  );
  assert.equal(
    enrichmentTargets.groups.reduce(
      (sum, group) => sum + group.target_count,
      0,
    ),
    enrichmentTargets.targets.length,
  );
  assert.equal(
    new Set(enrichmentTargets.targets.map((target) => target.target_id)).size,
    enrichmentTargets.targets.length,
  );
  const enrichmentQueueByNetuid = new Map(
    enrichmentQueue.queue.map((entry) => [entry.netuid, entry]),
  );
  assert.equal(
    enrichmentTargets.targets.every((target) => {
      const queueEntry = enrichmentQueueByNetuid.get(target.netuid);
      return (
        queueEntry &&
        target.queue_context &&
        target.queue_context.candidate_count === queueEntry.candidate_count &&
        target.queue_context.completeness_score ===
          queueEntry.completeness_score &&
        target.queue_context.review_state === queueEntry.review_state &&
        target.queue_context.surface_count === queueEntry.surface_count
      );
    }),
    true,
  );
  assert.equal(
    enrichmentTargets.targets.filter(
      (target) => target.target_type === "surface-candidate",
    ).length,
    enrichmentQueue.queue.reduce(
      (sum, entry) => sum + entry.direct_submission_kinds.length,
      0,
    ),
  );
  assert.equal(
    enrichmentTargets.targets.every((target) =>
      target.target_type === "surface-candidate"
        ? target.kind && target.candidate_command?.startsWith("npm run ")
        : target.kind === null && target.candidate_command === null,
    ),
    true,
  );
  assert.equal(
    enrichmentTargets.targets.some(
      (target) =>
        target.target_type === "surface-candidate" &&
        target.kind === "openapi" &&
        target.submission_route === "direct-candidate-pr",
    ),
    true,
  );
  assert.equal(
    enrichmentTargets.targets.some(
      (target) => target.target_type === "adapter-review",
    ),
    true,
  );
  assert.equal(
    enrichmentTargets.targets.every((target) => {
      if (target.target_type !== "surface-candidate") {
        return true;
      }
      if (!target.candidate_evidence?.candidate_count) {
        return (
          target.evidence_action === "submit-new-evidence" &&
          target.target_action === "submit-new-candidate"
        );
      }
      if (target.candidate_evidence.live_or_redirected_count > 0) {
        return (
          target.evidence_action === "review-existing-evidence" &&
          target.target_action === "review-existing-candidate"
        );
      }
      if (target.candidate_evidence.stale_or_failed_count > 0) {
        return (
          target.evidence_action === "replace-stale-evidence" &&
          target.target_action === "replace-stale-candidate"
        );
      }
      return (
        target.evidence_action === "verify-existing-evidence" &&
        target.target_action === "verify-existing-candidate"
      );
    }),
    true,
  );
  assert.equal(
    enrichmentTargets.targets.some(
      (target) =>
        target.target_type === "surface-candidate" &&
        target.evidence_action === "submit-new-evidence" &&
        target.candidate_evidence?.candidate_count === 0,
    ),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.some((entry) => entry.lane === "direct-submission"),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.some((entry) => entry.manual_review_required),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.every((entry) =>
      Array.isArray(entry.direct_submission_kinds),
    ),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.every(
      (entry) =>
        entry.candidate_evidence_summary &&
        typeof entry.candidate_evidence_summary === "object",
    ),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.some(
      (entry) => entry.evidence_action === "replace-stale-evidence",
    ),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.every((entry) =>
      Number.isInteger(entry.stale_candidate_count),
    ),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.every(
      (entry) =>
        Array.isArray(entry.sample_live_candidate_ids) &&
        Array.isArray(entry.sample_stale_candidate_ids) &&
        Array.isArray(entry.sample_target_candidate_ids),
    ),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.some(
      (entry) => entry.sample_target_candidate_ids.length > 0,
    ),
    true,
  );
  assert.equal(
    enrichmentEvidence.entries.some(
      (entry) => entry.candidate_evidence_by_kind["source-repo"],
    ),
    true,
  );
  assert.deepEqual(
    Object.fromEntries(
      enrichmentQueue.queue.map((entry) => [
        entry.netuid,
        entry.candidate_evidence_summary,
      ]),
    ),
    Object.fromEntries(
      enrichmentEvidence.entries.map((entry) => [
        entry.netuid,
        entry.candidate_evidence_summary,
      ]),
    ),
  );
  assert.deepEqual(
    profileCompleteness.summary.by_profile_level,
    profileCompleteness.profiles.reduce((counts, profile) => {
      counts[profile.profile_level] = (counts[profile.profile_level] || 0) + 1;
      return counts;
    }, {}),
  );
  assert.equal(
    profiles.profiles.every(
      (profile) =>
        profile.identity_evidence &&
        profile.identity_evidence.curated_identity_count ===
          profile.identity_evidence.curated_identity_kinds.length &&
        profile.identity_evidence.native_identity_count ===
          profile.identity_evidence.native_identity_kinds.length,
    ),
    true,
  );
  assert.equal(
    profileCompleteness.profiles.every(
      (profile) =>
        profile.identity_evidence &&
        profile.identity_promotion_kind_count ===
          profile.identity_promotion_kinds.length &&
        profile.identity_promotion_kind_count ===
          profile.identity_evidence.needs_promotion_kinds.length,
    ),
    true,
  );
  assert.equal(
    profileCompleteness.summary.identity_promotion_candidate_count,
    profileCompleteness.profiles.filter(
      (profile) => profile.identity_promotion_kind_count > 0,
    ).length,
  );
  assert.equal(
    profiles.summary.identity_promotion_candidate_count,
    profiles.profiles.filter(
      (profile) => profile.identity_evidence.needs_promotion_kinds.length > 0,
    ).length,
  );
  assert.deepEqual(
    profiles.summary.by_identity_level,
    profiles.profiles.reduce((counts, profile) => {
      counts[profile.identity_level] =
        (counts[profile.identity_level] || 0) + 1;
      return counts;
    }, {}),
  );
  assert.deepEqual(
    profileCompleteness.summary.by_identity_level,
    profileCompleteness.profiles.reduce((counts, profile) => {
      counts[profile.identity_level] =
        (counts[profile.identity_level] || 0) + 1;
      return counts;
    }, {}),
  );
  assert.deepEqual(
    enrichmentQueue.summary.identity_level_counts,
    enrichmentQueue.queue.reduce((counts, entry) => {
      counts[entry.identity_level] = (counts[entry.identity_level] || 0) + 1;
      return counts;
    }, {}),
  );
  assert.equal(
    Object.values(profileCompleteness.summary.by_profile_level).reduce(
      (sum, count) => sum + count,
      0,
    ),
    native.subnets.length,
  );
  assert.equal(
    profileCompleteness.summary.by_profile_level["adapter-backed"] >= 2,
    true,
  );
  assert.equal(genericAdapter.snapshot.adapter_kind, "generic-openapi");
  assert.equal(
    genericAdapter.extensions.generic_adapter.kind,
    "generic-openapi",
  );
  assert.equal(
    genericAdapter.snapshot.dimensions.openapi_schemas.captured_count > 0,
    true,
  );
  assert.equal(
    genericAdapter.snapshot.dimensions.openapi_schemas.total_operation_count >
      0,
    true,
  );
  assert.equal(schemaOnlyGenericAdapter.snapshot.status, "captured");
  assert.equal(
    schemaOnlyGenericAdapter.snapshot.dimensions.public_api_surfaces
      .surface_count,
    0,
  );
  assert.equal(
    profileCompleteness.summary.by_profile_level["identity-partial"] > 0,
    true,
  );
  assert.equal(
    profileCompleteness.summary.by_profile_level.operational > 0,
    true,
  );
  assert.equal(
    profileCompleteness.summary.critical_gap_counts["missing-openapi"] > 0,
    true,
  );
  assert.equal(Array.isArray(adapterCandidates.candidates), true);
  assert.equal(
    adapterCandidates.summary.candidate_count,
    adapterCandidates.candidates.length,
  );
  assert.equal(
    adapterCandidates.candidates.every(
      (candidate) =>
        Array.isArray(candidate.operational_surface_ids) &&
        Array.isArray(candidate.candidate_api_ids) &&
        Array.isArray(candidate.candidate_api_kinds) &&
        Array.isArray(candidate.reason_codes) &&
        typeof candidate.recommended_adapter_kind === "string" &&
        typeof candidate.suggested_next_action === "string",
    ),
    true,
  );
  assert.equal(
    adapterCandidates.candidates.some((candidate) =>
      candidate.reason_codes.includes("openapi-surface"),
    ),
    true,
  );
  assert.equal(adapterCandidates.summary.openapi_backed_count > 0, true);
  assert.equal(Array.isArray(reviewDecisions.decisions), true);
  assert.equal(coverage.probed_count, native.subnets.length);
  const generatedSurfaces = surfaces.surfaces.filter(
    (surface) => surface.authority === "registry-observed",
  );
  assert.equal(generatedSurfaces.length > 0, true);
  assert.equal(
    generatedSurfaces.some((surface) => surface.verification !== undefined),
    false,
  );
  assert.deepEqual(
    subnets.subnets.map((subnet) => subnet.netuid),
    native.subnets.map((subnet) => subnet.netuid),
  );
  assert.equal(
    subnets.subnets.find((subnet) => subnet.netuid === 0).subnet_type,
    "root",
  );
  assert.equal(
    subnets.subnets.find((subnet) => subnet.netuid === 7).coverage_level,
    "probed",
  );
  assert.equal(
    subnets.subnets.find((subnet) => subnet.netuid === 74).coverage_level,
    "probed",
  );

  for (const subnet of native.subnets) {
    assert.equal(
      existsSync(artifactFilePath(`subnets/${subnet.netuid}.json`)),
      true,
    );
    // Per-subnet health is live-only (no static health/subnets artifact); only
    // the badge fallback is committed.
    assert.equal(
      existsSync(artifactFilePath(`health/badges/${subnet.netuid}.json`)),
      true,
    );
    assert.equal(
      existsSync(artifactFilePath(`endpoints/${subnet.netuid}.json`)),
      true,
    );
    assert.equal(
      existsSync(artifactFilePath(`profiles/${subnet.netuid}.json`)),
      true,
    );
  }
});

test("R2-only generated artifacts stay out of the public git tree", () => {
  for (const relativePath of [
    "candidates.json",
    "profiles/7.json",
    "review-queue.json",
  ]) {
    assert.equal(
      existsSync(`${publicMetagraphRoot}/${relativePath}`),
      false,
      `${relativePath} should not be committed under public/metagraph`,
    );
    assert.equal(
      existsSync(`${r2StagingRoot}/${relativePath}`),
      true,
      `${relativePath} should be generated into the R2 staging tree`,
    );
  }
});

test("R2 history upload writes every planned run-prefix artifact", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "metagraphed-r2-upload-"),
  );
  const wranglerPath = path.join(temporaryDirectory, "wrangler");
  const putLogPath = path.join(temporaryDirectory, "put-log.jsonl");
  const manifestPath = path.join(r2StagingRoot, "r2-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(
    wranglerPath,
    String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] !== "r2" || args[1] !== "object") {
  process.exit(2);
}
if (args[2] === "get") {
  writeFileSync(1, readFileSync(process.env.FAKE_REMOTE_MANIFEST));
  process.exit(0);
}
if (args[2] === "put") {
  appendFileSync(
    process.env.FAKE_PUT_LOG,
    JSON.stringify({ key: args[3].slice(args[3].indexOf("/") + 1) }) + "\n",
  );
  process.exit(0);
}
process.exit(2);
`,
  );
  chmodSync(wranglerPath, 0o755);

  try {
    const output = execFileSync(
      process.execPath,
      ["scripts/r2-upload.mjs", "--write"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_PUT_LOG: putLogPath,
          FAKE_REMOTE_MANIFEST: manifestPath,
          METAGRAPH_ALLOW_R2_UPLOAD: "1",
          METAGRAPH_R2_UPLOAD_CONCURRENCY: "16",
          METAGRAPH_R2_UPLOAD_HISTORY: "1",
          METAGRAPH_WRANGLER_BIN: wranglerPath,
        },
        stdio: "pipe",
      },
    );
    const summary = JSON.parse(output);
    const putKeys = readFileSync(putLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).key);

    assert.equal(summary.remote_manifest_status, "found");
    assert.equal(summary.changed_artifact_count, 0);
    assert.equal(summary.skipped_artifact_count, manifest.artifacts.length);
    assert.equal(summary.uploaded_latest_count, 0);
    assert.equal(summary.uploaded_control_count, 3);
    assert.equal(
      summary.uploaded_history_count,
      manifest.artifacts.length + summary.uploaded_control_count,
    );
    assert.equal(
      putKeys.filter((key) => key.startsWith(manifest.run_prefix)).length,
      manifest.artifacts.length + summary.uploaded_control_count,
    );
    assert(
      putKeys.includes(manifest.artifacts.at(-1).key),
      "expected history upload to include artifacts unchanged in latest",
    );
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}, 30_000);

test("limited R2 upload dry run skips control manifests", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/r2-upload.mjs", "--dry-run"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        METAGRAPH_R2_UPLOAD_LIMIT: "5",
      },
      stdio: "pipe",
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.limited_artifact_count, 5);
  assert.equal(summary.control_artifact_count, 0);
  assert.equal(summary.skipped_control_artifact_count, 3);
  assert.equal(summary.planned_object_count, 5);
});

test("enrichment guidance ignores maintainer-excluded candidate IDs", () => {
  const queue = readArtifact("review/enrichment-queue.json");
  const ditto = queue.queue.find((entry) => entry.netuid === 118);

  assert(ditto, "expected SN118 Ditto enrichment queue entry");
  // SN118's maintainer-excluded source-repo candidates (ditto.json
  // `baseline_excluded_surface_ids`) must never surface as enrichment targets —
  // even when a separate, non-excluded community candidate legitimately exists
  // (the flywheel keeps adding candidates; assert the exclusion, not emptiness).
  for (const excluded of [
    "sn-118-taomarketcap-source-repo",
    "sn-118-tensorplex-source-repo-1",
  ]) {
    assert.equal(
      ditto.sample_target_candidate_ids.includes(excluded),
      false,
      `excluded ${excluded} must not be an enrichment target`,
    );
    assert.equal(
      ditto.sample_live_candidate_ids.includes(excluded),
      false,
      `excluded ${excluded} must not be a live candidate`,
    );
  }
});

test("enrichment guidance ignores maintainer-excluded candidate URLs", () => {
  const queue = readArtifact("review/enrichment-queue.json");
  const colosseum = queue.queue.find((entry) => entry.netuid === 38);

  assert(colosseum, "expected SN38 colosseum enrichment queue entry");
  assert.equal(colosseum.evidence_action, "submit-new-evidence");
  assert.equal(
    colosseum.sample_target_candidate_ids.includes(
      "sn-38-native-chain-website",
    ),
    false,
  );
  assert.equal(
    colosseum.sample_live_candidate_ids.includes("sn-38-native-chain-website"),
    false,
  );
  assert.equal(
    colosseum.candidate_evidence_summary.live_kinds.includes("website"),
    false,
  );
});

test("Worker API serves public artifact envelopes", async () => {
  const env = createLocalArtifactEnv();

  const response = await handleRequest(
    new Request("https://metagraph.sh/api/v1/subnets/7"),
    env,
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(
    response.headers.get("x-metagraph-contract-version"),
    "2026-06-06.1",
  );
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.subnet.netuid, 7);
});

function readArtifact(relativePath) {
  return JSON.parse(readFileSync(artifactFilePath(relativePath), "utf8"));
}

function latestArtifactDate(relativePath) {
  return readdirSync(artifactDirectoryPath(relativePath))
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .map((file) => file.replace(/\.json$/, ""))
    .sort()
    .at(-1);
}

function snapshotSupportArtifacts() {
  return new Map(
    SUPPORT_ARTIFACT_PATHS.map((filePath) => [
      filePath,
      readFileSync(filePath, "utf8"),
    ]),
  );
}

function restoreSupportArtifacts(snapshot) {
  for (const [filePath, content] of snapshot) {
    writeFileSync(filePath, content);
  }
  execFileSync(process.execPath, ["scripts/r2-manifest.mjs", "--write"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    stdio: "pipe",
  });
  for (const [filePath, content] of snapshot) {
    writeFileSync(filePath, content);
  }
}

test("#745 social accounts stay display-only and never feed completeness", () => {
  const index = JSON.parse(
    readFileSync(artifactFilePath("subnets.json"), "utf8"),
  );
  const withSocial = index.subnets.filter((subnet) => subnet.social);
  // The on-chain `additional` corpus currently yields a handful of handles. If a
  // snapshot ever yields zero, the lib-helpers unit tests still pin extraction;
  // this invariant guards the build wiring whenever the data is present.
  for (const entry of withSocial) {
    assert.deepEqual(
      Object.keys(entry.social).filter(
        (key) => !["x", "telegram", "reddit", "youtube"].includes(key),
      ),
      [],
      `SN${entry.netuid} social carries unexpected keys`,
    );

    // The detail artifact must embed the same social object as the index.
    const detail = JSON.parse(
      readFileSync(artifactFilePath(`subnets/${entry.netuid}.json`), "utf8"),
    );
    assert.deepEqual(
      detail.subnet.social,
      entry.social,
      `SN${entry.netuid} detail/index social disagree`,
    );

    // The completeness + gap surface must never reference social — it is not a
    // gap signal and must not move completeness_score (#343 flywheel gate).
    const profilePath = artifactFilePath(`profiles/${entry.netuid}.json`);
    if (!existsSync(profilePath)) {
      continue;
    }
    const { profile } = JSON.parse(readFileSync(profilePath, "utf8"));
    const completenessSurface = JSON.stringify({
      completeness: profile.completeness,
      completeness_score: profile.completeness_score,
      gap_reasons: profile.gap_reasons,
      missing_identity: profile.missing_identity,
      missing_operational: profile.missing_operational,
      missing_required: profile.missing_required,
      missing_critical_count: profile.missing_critical_count,
      primary_links: profile.primary_links,
      suggested_submission_kinds: profile.suggested_submission_kinds,
    });
    assert.doesNotMatch(
      completenessSurface,
      /social/i,
      `SN${entry.netuid} completeness surface must not reference social`,
    );
  }
});

test("#745 provider social is display-only and borrows from a single subnet", () => {
  const { providers } = JSON.parse(
    readFileSync(artifactFilePath("providers.json"), "utf8"),
  );
  const subnetSocialByNetuid = new Map(
    JSON.parse(readFileSync(artifactFilePath("subnets.json"), "utf8"))
      .subnets.filter((subnet) => subnet.social)
      .map((subnet) => [subnet.netuid, subnet.social]),
  );

  for (const provider of providers.filter((entry) => entry.social)) {
    assert.deepEqual(
      Object.keys(provider.social).filter(
        (key) => !["x", "telegram", "reddit", "youtube"].includes(key),
      ),
      [],
      `provider ${provider.id} social carries unexpected keys`,
    );
    // A single-subnet provider with no curated override borrows that subnet's
    // social verbatim (mirrors the logo_url borrow). When the subnet it operates
    // also carries social, the two must agree.
    if (provider.netuids.length === 1) {
      const borrowed = subnetSocialByNetuid.get(provider.netuids[0]);
      if (borrowed) {
        assert.deepEqual(
          provider.social,
          borrowed,
          `provider ${provider.id} should borrow SN${provider.netuids[0]} social`,
        );
      }
    }
  }
});
