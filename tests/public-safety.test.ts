import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import {
  isUnsafeResolvedUrl,
  isUnsafeUrl,
  normalizePublicHttpUrl,
} from "../scripts/lib.ts";
import { createRepoSandbox } from "./helpers/repo-sandbox.ts";
import type { Row } from "./row-type.ts";

// The scanner WALKS the repo (scripts/, deploy/, apps/, public/, …), so this
// needs a full working-tree copy, not just the data dirs. Everything this file
// plants now lands in that copy: it no longer mutates the shared tree, so it no
// longer needs the serial pass (#8937). ~1.6s to clone.
const sandbox = createRepoSandbox("public-safety", { scope: "full" });
const repoRoot = sandbox.root;

// ONE scan for the whole file (#8908). Every planted-fixture test below used to
// write its fixture, spawn its own `node scripts/scan-public-safety.ts`, and
// assert against that run's output. The scanner walks the entire repo, so each
// spawn cost ~3.8s and the file spent 43 of them: ~164s locally and ~350s of
// CI's 467s serial test pass -- 77% of that pass, and the single largest item
// in the whole `test` job. The previous response to that cost was to raise this
// file's per-test timeout to 45s (see SCANNER_TEST_TIMEOUT_MS below), which
// treated the symptom.
//
// The scanner reports findings as `<repo-relative path>:<line>: <rule>` (or
// `<path>:<json path>: <rule>` for fixture bodies) and prints ALL of them with
// no cap, so findings for one planted file are entirely independent of the
// others. That makes the per-test scan pure waste: give every case its own
// uniquely-named file, plant them all once, scan once, and let each test assert
// against its own path in the shared output. Same assertions, same real
// full-repo invocation, 43 spawns -> 1.
//
// Two consequences worth knowing:
//   - Cases must declare their file + content at COLLECTION time (via the
//     public*/fixture*/root* helpers below), not inside a test body, because
//     every file has to exist before the single beforeAll scan runs.
//   - Two assertions that were written as repo-wide substring checks are now
//     scoped to their own planted file, since a sibling case in the same scan
//     legitimately produces the finding they assert is absent. Both are called
//     out at their site.
//
// This file stays pinned to serial execution (package.json's test:ci exclude
// list) regardless: it plants files under public/, scripts/, deploy/,
// apps/indexer-rs/ and the R2 fixtures staging dir, which other tests' own
// full-registry scans read. Planting now spans the whole file run rather than a
// single test, which makes that pinning more load-bearing, not less.
//
// The fixtures directory below is load-bearing: scan-public-safety.ts's own
// mirroredFixturePatterns exempts dist/metagraph-r2/metagraph/fixtures/*.json
// from the soft wallet/key terminology rules (legitimate third-party API docs
// mentioning "private key"/"seed phrase" in a non-leaking context), and the
// fixture-body describe block specifically tests that exemption -- do not
// relocate it.
const FIXTURE_DIR = path.join(repoRoot, "dist/metagraph-r2/metagraph/fixtures");

// A single scan is still a real repo walk subject to process-spawn variance, so
// the generous timeout stays -- it now guards one scan in beforeAll rather than
// 43 spread across the file.
const SCANNER_TEST_TIMEOUT_MS = 45000;

vi.setConfig({ testTimeout: SCANNER_TEST_TIMEOUT_MS, hookTimeout: 60000 });

/** A file planted for the single scan, and where it lands in the output. */
interface ScanCase {
  /** Repo-relative path, exactly as the scanner reports it. */
  file: string;
  /** Absolute path, written in beforeAll and removed in afterAll. */
  absolute: string;
}

const planted: Array<{ absolute: string; content: string }> = [];
/** Directories created for a case, removed recursively in afterAll. */
const plantedDirs: string[] = [];
let scanOutput = "";

function plant(relative: string, content: string): ScanCase {
  const absolute = path.join(repoRoot, relative);
  planted.push({ absolute, content });
  return { file: relative, absolute };
}

/** A plain-text case under public/ (the old TEST_PUBLIC_PATH shape). */
function publicCase(slug: string, lines: string | string[]): ScanCase {
  const content = Array.isArray(lines) ? `${lines.join("\n")}\n` : lines;
  return plant(`public/__public_safety_${slug}__.txt`, content);
}

/** A mirrored-fixture case (the old TEST_FIXTURE_PATH shape + its `kind`). */
function fixtureCase(
  slug: string,
  body: Row,
  { kind }: { kind?: string } = {},
): ScanCase {
  return plant(
    `${path.relative(repoRoot, FIXTURE_DIR)}/__public_safety_${slug}__.json`,
    JSON.stringify({ kind, response: { body } }),
  );
}

/** A case under one of the extended target roots (scripts/, deploy/, …). */
function rootCase(relative: string, lines: string | string[]): ScanCase {
  const content = Array.isArray(lines) ? `${lines.join("\n")}\n` : lines;
  return plant(relative, content);
}

// Run the real scanner and return its combined output. The scanner walks the
// whole repo, so its exit code depends on unrelated tree state -- assertions key
// off each planted file's path in the output, which is independent of that.
function runScanOutput() {
  try {
    execFileSync("node", ["scripts/scan-public-safety.ts"], {
      cwd: sandbox.scriptCwd,
      encoding: "utf8",
      env: sandbox.env,
    });
    return "";
  } catch (err) {
    const e = err as Row;
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

beforeAll(async () => {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  for (const { absolute, content } of planted) {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
  scanOutput = runScanOutput();
});

afterAll(async () => {
  for (const { absolute } of planted) {
    await fs.rm(absolute, { force: true });
  }
  for (const dir of plantedDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  // Everything above lives inside the sandbox anyway; dropping the whole tree
  // is what actually reclaims it.
  sandbox.cleanup();
});

describe("public URL safety checks", () => {
  test("blocks private, loopback, and link-local literal targets", () => {
    const unsafeUrls = [
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://172.20.0.5/",
      "http://192.168.1.5/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
    ];

    for (const url of unsafeUrls) {
      assert.equal(isUnsafeUrl(url), true, url);
    }
  });

  test("normalizes only public non-credentialed HTTP URLs", () => {
    const unsafeUrls = [
      "http://10.0.0.1/admin/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "https://user:pass@example.com/private/",
      "https://example.com/private?token=secret",
    ];

    for (const url of unsafeUrls) {
      assert.equal(normalizePublicHttpUrl(url), null, url);
    }

    assert.equal(
      normalizePublicHttpUrl("example.com/docs/#intro"),
      "https://example.com/docs",
    );
  });

  test("blocks hostnames that resolve to private addresses", async () => {
    // Inject the resolver (the script-utils pattern) so the SSRF-resolution
    // classification is tested deterministically, with no dependency on the CI
    // runner's outbound DNS. A public-looking host that resolves to a private
    // address must still be blocked.
    const privateResolver = async () => [{ address: "10.0.0.5", family: 4 }];
    assert.equal(
      await isUnsafeResolvedUrl(
        "https://internal.example/",
        privateResolver as unknown as Parameters<typeof isUnsafeResolvedUrl>[1],
      ),
      true,
    );
  });

  test("blocks credentialed public URLs before DNS resolution", () => {
    const credentialedUrls = [
      "https://user:pass@example.com/api",
      "http://peer1-api:8080,0xPeer2@http//peer2-api:8080",
      "wss://token@example.com/socket",
    ];

    for (const url of credentialedUrls) {
      assert.equal(isUnsafeUrl(url), true, url);
    }
  });

  test("allows syntactically valid public HTTP URLs before DNS resolution", () => {
    assert.equal(isUnsafeUrl("https://example.com/api"), false);
    assert.equal(isUnsafeUrl("http://8.8.8.8/dns-query"), false);
    assert.equal(isUnsafeUrl("http://[::ffff:8.8.8.8]/dns-query"), false);
  });

  test("allows public literal IPs without DNS lookup", async () => {
    assert.equal(await isUnsafeResolvedUrl("http://8.8.8.8/dns-query"), false);
  });

  test("resolves public hosts and blocks failed DNS lookups", async () => {
    // Injected resolvers keep this deterministic and network-free: a host that
    // resolves to a public address is allowed; a host whose lookup fails (the
    // resolver throws, as Node's dns does on NXDOMAIN) is blocked.
    const publicResolver = async () => [
      { address: "93.184.216.34", family: 4 },
    ];
    const failingResolver = async () => {
      throw new Error("ENOTFOUND");
    };
    assert.equal(
      await isUnsafeResolvedUrl(
        "https://metagraph.example/",
        publicResolver as unknown as Parameters<typeof isUnsafeResolvedUrl>[1],
      ),
      false,
    );
    assert.equal(
      await isUnsafeResolvedUrl(
        "https://metagraph.invalid/",
        failingResolver as unknown as Parameters<typeof isUnsafeResolvedUrl>[1],
      ),
      true,
    );
  });
});

describe("captured-fixture body scan", () => {
  const LOCAL_SUBTENSOR = publicCase(
    "local_subtensor",
    "Use the documented local RPC at `ws://127.0.0.1:9944` for local development.\n",
  );
  test("allows only the exact documented local subtensor endpoint", () => {
    assert.equal(
      scanOutput.includes(LOCAL_SUBTENSOR.file),
      false,
      `the exact documented endpoint should be exempt; got:\n${scanOutput}`,
    );
  });

  const BYPASS_ATTEMPTS = [
    "ws://127.0.0.1:9944/admin",
    "ws://127.0.0.1:9944?token=abcdefghijklmnop",
    "ws://127.0.0.1:9944@10.0.0.1/private",
  ];
  const BYPASS = publicCase("bypass", BYPASS_ATTEMPTS);
  test("flags local subtensor allowlist prefix bypass attempts", () => {
    for (const [index] of BYPASS_ATTEMPTS.entries()) {
      assert.ok(
        scanOutput.includes(
          `${BYPASS.file}:${index + 1}: private or loopback URL`,
        ),
        `bypass attempt on line ${index + 1} must be flagged; got:\n${scanOutput}`,
      );
    }
  });

  const COMPOUND_SECRETS = [
    "client_secret=abcdefghijklmnop1234",
    "db_password=abcdefghijklmnop1234",
    "google_oauth_client_secret=abcdefghijklmnop1234",
    "secret=abcdefghijklmnop1234",
  ];
  const COMPOUND = publicCase("compound_secret", COMPOUND_SECRETS);
  test("flags secrets assigned to compound credential names", () => {
    for (const [index] of COMPOUND_SECRETS.entries()) {
      assert.ok(
        scanOutput.includes(
          `${COMPOUND.file}:${index + 1}: token-like assignment`,
        ),
        `secret on line ${index + 1} must be flagged; got:\n${scanOutput}`,
      );
    }
  });

  // ghp_ is the personal-access prefix, but gho_/ghu_/ghs_/ghr_ (OAuth,
  // user-to-server, App installation, refresh) are the same leakable family.
  // Assemble each token from a prefix + shared body at runtime so the source
  // never commits a contiguous token-shaped literal (which secret scanners
  // would flag as a leaked credential in the diff).
  const GH_TOKENS = ["ghp", "gho", "ghu", "ghs", "ghr"].map(
    (prefix) => `${prefix}_${"abcdefghijklmnopqrstuvwxyz0123456789"}`,
  );
  const GH = publicCase("github_token", GH_TOKENS);
  test("flags every GitHub token prefix, not just ghp_", () => {
    for (const [index] of GH_TOKENS.entries()) {
      assert.ok(
        scanOutput.includes(`${GH.file}:${index + 1}: github token`),
        `github token on line ${index + 1} must be flagged; got:\n${scanOutput}`,
      );
    }
  });

  // The routable `glpat-` prefix + 20+ URL-safe chars is the GitLab analog of a
  // leaked GitHub token; none of the other token rules (sk-/xox/gh) catch it.
  // Assemble the prefix + shared body at runtime so the source never commits a
  // contiguous token-shaped literal (which secret scanners flag in the diff).
  const GITLAB = publicCase(
    "gitlab_token",
    `${`glpat-${"abcdefghijklmnopqrst"}`}\n`,
  );
  test("flags a bare GitLab personal access token", () => {
    assert.ok(
      scanOutput.includes(`${GITLAB.file}:1: gitlab personal access token`),
      `GitLab personal access token must be flagged; got:\n${scanOutput}`,
    );
  });

  // The fixed `npm_` prefix + 36 base62 chars is the documented automation /
  // granular token format; a leaked one grants package publish rights (a supply-
  // chain risk) and none of the other token rules catch it. Assemble the prefix +
  // shared body at runtime so the source never commits a contiguous token literal.
  const NPM = publicCase(
    "npm_token",
    `${`npm_${"abcdefghijklmnopqrstuvwxyz0123456789"}`}\n`,
  );
  test("flags a bare npm access token", () => {
    assert.ok(
      scanOutput.includes(`${NPM.file}:1: npm access token`),
      `npm access token must be flagged; got:\n${scanOutput}`,
    );
  });

  // 169.254.169.254 is the AWS/GCP metadata endpoint — the canonical SSRF /
  // credential-theft target and unsafe per lib.ts isUnsafeUrl, so a leaked URL
  // to the 169.254.0.0/16 link-local range must be flagged like the RFC1918
  // ranges. (A bare `169.254.169.254` in prose, with no URL scheme, is not.)
  const LINK_LOCAL_LINES = [
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.42.7/admin",
  ];
  const LINK_LOCAL = publicCase("link_local", LINK_LOCAL_LINES);
  test("flags a link-local cloud-metadata URL as a private/loopback leak", () => {
    for (const [index] of LINK_LOCAL_LINES.entries()) {
      assert.ok(
        scanOutput.includes(
          `${LINK_LOCAL.file}:${index + 1}: private or loopback URL`,
        ),
        `link-local URL on line ${index + 1} must be flagged; got:\n${scanOutput}`,
      );
    }
  });

  // The signed-URL rule only catches request params; a long-term (AKIA) or
  // temporary (ASIA) access key id pasted into a doc/config is the common leak.
  // Assemble prefix + shared body at runtime so the source never commits a
  // contiguous key-shaped literal (which secret scanners flag in the diff).
  const AWS_KEYS = ["AKIA", "ASIA"].map(
    (prefix) => `${prefix}IOSFODNN7EXAMPLE`,
  );
  const AWS = publicCase("aws_key", AWS_KEYS);
  test("flags a bare AWS access key id", () => {
    for (const [index] of AWS_KEYS.entries()) {
      assert.ok(
        scanOutput.includes(`${AWS.file}:${index + 1}: aws access key id`),
        `AWS access key id on line ${index + 1} must be flagged; got:\n${scanOutput}`,
      );
    }
  });

  // src/alert-delivery.ts builds api.telegram.org/bot${token}/sendMessage, so
  // a leaked bot token is a real credential. Assemble the id:secret shape at
  // runtime so the source never commits a contiguous token-shaped literal
  // (the AWS-key case above sets this precedent).
  // The secret half is exactly 35 URL-safe chars (the real bot-token shape and
  // what the pattern matches); assemble it from parts so no contiguous
  // token-shaped literal is committed.
  const TELEGRAM_SECRET = ["AAHdqTcvCH1vGWJxfSeofSAs", "0K5PALDsaw", "x"].join(
    "",
  );
  const TELEGRAM = publicCase(
    "telegram_token",
    `${"123456789"}:${TELEGRAM_SECRET}\n`,
  );
  test("flags a bare Telegram bot token", () => {
    assert.equal(TELEGRAM_SECRET.length, 35);
    assert.ok(
      scanOutput.includes(`${TELEGRAM.file}:1: telegram bot token`),
      `Telegram bot token must be flagged; got:\n${scanOutput}`,
    );
  });

  // A Discord webhook URL is itself a bearer credential (src/alert-delivery.ts
  // buildDiscordDeliveryRequest posts to it). Assemble it from parts so the
  // source never commits a contiguous webhook-shaped literal.
  const DISCORD = publicCase(
    "discord_webhook",
    `${[
      "https://discord.com/api/webhooks/",
      "123456789012345678/",
      ["Abcd_efGH", "ijkLMNop-qrST"].join(""),
    ].join("")}\n`,
  );
  test("flags a bare Discord webhook URL", () => {
    assert.ok(
      scanOutput.includes(`${DISCORD.file}:1: discord webhook url`),
      `Discord webhook URL must be flagged; got:\n${scanOutput}`,
    );
  });

  // Regression for the publish-wedging false positive: upstream API docs
  // legitimately say "miner hotkey" / "validator hotkey path".
  const SOFT_TERMS = fixtureCase("soft_terms", {
    summary: "The miner hotkey to look up",
    detail: "Provide the validator hotkey path and coldkey wording.",
  });
  test("does not flag soft Bittensor terminology in a mirrored fixture body", () => {
    assert.equal(
      scanOutput.includes(SOFT_TERMS.file),
      false,
      `soft terminology should be exempt in mirrored fixture bodies; got:\n${scanOutput}`,
    );
  });

  const SEED_VALUE = fixtureCase("seed_value", {
    note: "seed phrase: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  });
  test("flags sensitive wallet/key wording hidden in a fixture body value", () => {
    assert.ok(
      scanOutput.includes(
        `${SEED_VALUE.file}:response.body.note: wallet/key wording`,
      ),
      `sensitive wallet/key wording must still fire on fixture body values; got:\n${scanOutput}`,
    );
  });

  const SEED_KEY = fixtureCase("seed_key", {
    "seed phrase":
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  });
  test("flags sensitive wallet/key wording hidden in a fixture body key", () => {
    assert.ok(
      scanOutput.includes(
        `${SEED_KEY.file}:response.body.seed phrase key: wallet/key wording`,
      ),
      `sensitive wallet/key wording must still fire on fixture body keys; got:\n${scanOutput}`,
    );
  });

  // The AIza-prefixed 39-char key is a distinctive, unambiguous credential
  // format that none of the URL/token rules caught.
  const GOOGLE = publicCase("google_key", `${`AIza${"b".repeat(35)}`}\n`);
  test("flags a bare Google API key", () => {
    assert.ok(
      scanOutput.includes(`${GOOGLE.file}:1: google api key`),
      `Google API key must be flagged; got:\n${scanOutput}`,
    );
  });

  const HARD_IN_BODY = fixtureCase("hard_in_body", {
    note: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  });
  test("still flags a hard secret hidden in a fixture body value", () => {
    assert.ok(
      scanOutput.includes(`${HARD_IN_BODY.file}:response.body`),
      `hard secret patterns must still fire on fixture body values; got:\n${scanOutput}`,
    );
  });

  const DESCRIPTION_SEED = fixtureCase("description_seed", {
    description:
      "seed phrase: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  });
  test("flags wallet/key wording in a generic description fixture body value", () => {
    assert.ok(
      scanOutput.includes(
        `${DESCRIPTION_SEED.file}:response.body.description: wallet/key wording`,
      ),
      `sensitive wallet/key wording must fire in generic description fields; got:\n${scanOutput}`,
    );
  });

  // Regression for the sn-97 publish wedge: a captured openapi parameter
  // description reads "…your wallet path / seed phrase…" — public API docs the
  // subnet published, not a leaked secret value.
  const DOC_FIELD = fixtureCase("doc_field", {
    paths: {
      "/user/credits": {
        get: {
          parameters: [
            {
              description:
                "Provide your wallet path or seed phrase to authenticate the request.",
            },
          ],
        },
      },
    },
  });
  test("does not flag wallet/key wording in an OpenAPI documentation field", () => {
    assert.equal(
      scanOutput.includes(DOC_FIELD.file),
      false,
      `wallet/key wording in a documentation field should be exempt; got:\n${scanOutput}`,
    );
  });

  // The doc-field exemption is soft-only: a real token in a description is
  // still caught by the hard secret patterns.
  const HARD_IN_DOC = fixtureCase("hard_in_doc", {
    info: {
      description:
        "Example call: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    },
  });
  test("still flags a hard secret even inside a documentation field", () => {
    assert.ok(
      scanOutput.includes(`${HARD_IN_DOC.file}:response.body`),
      `hard secrets must fire even inside doc fields; got:\n${scanOutput}`,
    );
  });

  // Regression for the live sn-33 publish failure (2026-07-20): a
  // WalletCreate JSON-Schema's own property name (`private_key`) and its
  // sibling `required` array entry are schema metadata, not a
  // description/summary/title documentation field, so the existing
  // isOpenApiDocumentationField exemption above doesn't reach them.
  const OPENAPI_KIND = fixtureCase(
    "openapi_kind",
    {
      components: {
        schemas: {
          WalletCreate: {
            properties: { private_key: "[redacted]" },
            required: ["name", "private_key"],
          },
        },
      },
    },
    { kind: "openapi" },
  );
  test("exempts wallet/key wording anywhere in an openapi-kind fixture body, not just doc fields", () => {
    assert.equal(
      scanOutput.includes(OPENAPI_KIND.file),
      false,
      `openapi-kind schema metadata should be exempt; got:\n${scanOutput}`,
    );
  });

  // Regression for the live sn-58 publish failure (2026-07-20): a
  // quick-start step showing how to generate a brand-new wallet locally
  // (`Wallet.createRandom()`) legitimately mentions "privateKey" while
  // disclosing no actual secret. Not OpenAPI-shaped at all, so
  // isOpenApiDocumentationField's isOpenApiBody gate never applies here.
  const SUBNET_API_KIND = fixtureCase(
    "subnet_api_kind",
    {
      quick_start: {
        step2_wallet:
          "node -e \"const w=require('ethers').Wallet.createRandom();console.log(w.address, w.privateKey)\"",
      },
    },
    { kind: "subnet-api" },
  );
  test("exempts wallet/key wording in a subnet-api-kind quick-start tutorial", () => {
    assert.equal(
      scanOutput.includes(SUBNET_API_KIND.file),
      false,
      `subnet-api-kind quick-start prose should be exempt; got:\n${scanOutput}`,
    );
  });

  // data-artifact fixtures are live operational data (e.g. a genomics
  // subnet's arbitrary per-miner submitted log text), not the operator's
  // own curated docs -- wallet/key wording must still be caught there.
  const DATA_ARTIFACT_KIND = fixtureCase(
    "data_artifact_kind",
    {
      note: "seed phrase: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    },
    { kind: "data-artifact" },
  );
  test("does not extend the curated-kind exemption to data-artifact fixtures", () => {
    assert.ok(
      scanOutput.includes(
        `${DATA_ARTIFACT_KIND.file}:response.body.note: wallet/key wording`,
      ),
      `data-artifact fixtures must still be scanned; got:\n${scanOutput}`,
    );
  });

  // Regression for the generated MCP server-card prose: the slash form
  // "hotkey/coldkey" and the "coldkey-only" behaviour descriptor are standard
  // Bittensor API vocabulary explaining public read-only behaviour — the same
  // safe class as the already-allowed "hotkey or coldkey" phrase, just written
  // differently. Neither carries any secret.
  const API_PROSE = publicCase("api_prose", [
    "The hotkey/coldkey owning the account, base58, 47-48 chars.",
    "A coldkey-only SS58 address won't appear in the hotkey-attributed rollup.",
  ]);
  test("allows the hotkey/coldkey and coldkey-only API-prose forms", () => {
    assert.equal(
      scanOutput.includes(API_PROSE.file),
      false,
      `hotkey/coldkey and coldkey-only API prose should be exempt; got:\n${scanOutput}`,
    );
  });

  const CSV_HEADERS = publicCase("csv_headers", [
    "uid,hotkey,coldkey,active,validator_permit",
    "hotkey,coldkey,coldkey_count,subnet_count,uid_count",
  ]);
  test("allows generated CSV headers with a coldkey column", async () => {
    assert.equal(
      scanOutput.includes(CSV_HEADERS.file),
      false,
      `generated CSV headers should be exempt; got:\n${scanOutput}`,
    );

    // Import the module in-process too: its CLI-entrypoint guard means this is
    // side-effect-free, and it keeps the module's own top-level definitions
    // covered by the in-process collector (the subprocess scans above are
    // invisible to it).
    await import("../scripts/scan-public-safety.ts");
  });

  // The coldkey-only exemption is the exact phrase, not a blanket `coldkey-`
  // strip: a hyphenated secret attempt must still trip the terminology guard.
  const HYPHEN_SMUGGLE = publicCase(
    "hyphen_smuggle",
    "Set coldkey-only-seedphrase to 5xyzABCDEFGHabcdefgh in your config.\n",
  );
  test("still flags suspicious coldkey prose that a hyphen can't smuggle past", () => {
    assert.ok(
      scanOutput.includes(
        `${HYPHEN_SMUGGLE.file}:1: Bittensor key terminology`,
      ),
      `a hyphenated coldkey secret attempt must still be flagged; got:\n${scanOutput}`,
    );
  });

  const SQL_NULL = publicCase("sql_null", [
    "WHERE netuid = ${netuid} AND coldkey IS NOT NULL",
    "WHERE coldkey IS NULL",
  ]);
  test("allows the coldkey IS [NOT] NULL SQL comparison, same class as coldkey =", () => {
    assert.equal(
      scanOutput.includes(SQL_NULL.file),
      false,
      `coldkey IS [NOT] NULL SQL comparisons should be exempt; got:\n${scanOutput}`,
    );
  });

  // The IS [NOT] NULL exemption requires the literal SQL keyword, not just
  // "is"/"is not" -- prose using the same words must still be flagged.
  const SQL_PROSE = publicCase(
    "sql_prose",
    "The coldkey is not something you should ever share.\n",
  );
  test("does not let 'coldkey is not' prose without the literal NULL keyword slip past", () => {
    assert.ok(
      scanOutput.includes(`${SQL_PROSE.file}:1: Bittensor key terminology`),
      `prose without the literal NULL keyword must still be flagged; got:\n${scanOutput}`,
    );
  });

  // ext.coldkey.is_some() / .clone() / .unwrap() -- Rust has no `?.` operator,
  // so the existing coldkey?. optional-chaining exemption (TS/JS-specific)
  // doesn't cover this extremely common Option-field-check idiom in
  // apps/indexer-rs's own test code.
  const RUST_FIELD = publicCase("rust_field", [
    "assert!(ext.coldkey.is_some());",
    "let c = row.coldkey.clone();",
    "let c = row.coldkey.unwrap();",
  ]);
  test("allows Rust field-access + method-call syntax on a coldkey field (#6718)", () => {
    assert.equal(
      scanOutput.includes(RUST_FIELD.file),
      false,
      `coldkey.method() Rust syntax should be exempt; got:\n${scanOutput}`,
    );
  });

  // The new coldkey.[a-z_]+( allowance requires an opening paren -- a
  // capitalized word or a word with no trailing paren after "coldkey." must
  // still be flagged, so this can't be used to smuggle real prose past the
  // guard by appending an unrelated identifier after a dot.
  const RUST_PROSE = publicCase(
    "rust_prose",
    "The coldkey.owner field should never be logged in plaintext.\n",
  );
  test("does not let 'coldkey.' followed by prose (not a real method call) slip past", () => {
    assert.ok(
      scanOutput.includes(`${RUST_PROSE.file}:1: Bittensor key terminology`),
      `prose after "coldkey." without a real method call must still be flagged; got:\n${scanOutput}`,
    );
  });

  const COMPOUND_WALLET = publicCase("compound_wallet", [
    "seed-phrase",
    "seedphrase",
    "seed_phrase",
    "private-key",
    "privatekey",
    "wallet-path",
    "walletpath",
  ]);
  test("flags hyphenated/compound wallet-key wording a literal-space regex would miss", () => {
    for (let line = 1; line <= 7; line += 1) {
      assert.ok(
        scanOutput.includes(
          `${COMPOUND_WALLET.file}:${line}: wallet/key wording`,
        ),
        `line ${line} should be flagged as wallet/key wording; got:\n${scanOutput}`,
      );
    }
  });

  // \b after the optional separator still requires a real word boundary --
  // continuing into more identifier characters must not match.
  const PREFIX_ONLY = publicCase("prefix_only", [
    "privateKeyRef",
    "seedphrases",
    "walletpathfinder",
  ]);
  test("does not flag a compound word that only shares a prefix, not the full phrase", () => {
    assert.equal(
      scanOutput.includes(PREFIX_ONLY.file),
      false,
      `a partial/continued word must not trip wallet/key wording; got:\n${scanOutput}`,
    );
  });

  const COMPOUND_HOTKEY = publicCase("compound_hotkey", [
    "wallet-hotkey",
    "hotkey-path",
    "hotkey-seed-phrase",
  ]);
  test("flags hyphenated/compound sensitive hotkey wording a literal-space regex would miss", () => {
    for (let line = 1; line <= 3; line += 1) {
      assert.ok(
        scanOutput.includes(
          `${COMPOUND_HOTKEY.file}:${line}: sensitive hotkey wording`,
        ),
        `line ${line} should be flagged as sensitive hotkey wording; got:\n${scanOutput}`,
      );
    }
  });

  const HEADER_NAME = publicCase("header_name", [
    "X-Validator-Hotkey",
    "X-Miner-Hotkey",
    "Requires the X-Validator-Hotkey and X-Validator-Signature headers.",
  ]);
  test("does not flag a real X-Role-Hotkey HTTP header name", () => {
    assert.equal(
      scanOutput.includes(HEADER_NAME.file),
      false,
      `a real X-Role-Hotkey header name must not trip sensitive hotkey wording; got:\n${scanOutput}`,
    );
  });

  // The allowlist strips only the exact "X-Role-Hotkey" shape -- lowercase
  // or space-joined wording using the same words, even on an adjacent line
  // in the same file, must still trip the rule untouched.
  const HEADER_MIXED = publicCase("header_mixed", [
    "X-Validator-Hotkey",
    "share your validator hotkey with us",
    "x-validator-hotkey",
  ]);
  test("still flags validator/miner hotkey prose alongside a real header name on other lines", () => {
    assert.ok(
      !scanOutput.includes(`${HEADER_MIXED.file}:1: sensitive hotkey wording`),
      `line 1 (real header name) must not be flagged; got:\n${scanOutput}`,
    );
    assert.ok(
      scanOutput.includes(`${HEADER_MIXED.file}:2: sensitive hotkey wording`),
      `line 2 (space-joined prose) should still be flagged; got:\n${scanOutput}`,
    );
    assert.ok(
      scanOutput.includes(`${HEADER_MIXED.file}:3: sensitive hotkey wording`),
      `line 3 (lowercase header-shaped text) should still be flagged; got:\n${scanOutput}`,
    );
  });
});

// scripts/, deploy/, and apps/indexer-rs/ joined targetRoots in the same PR
// that added these tests (#5147) -- before that, a leak in any of the three
// (a real internal box hostname + container name shipped in deploy/README.md
// and two scripts/backfill-*-postgres.mjs files, redacted by hand in PR
// #5064, CI never had a chance to catch it) went entirely unscanned. These
// tests model that exact regression: a fixture placed in each of the three
// newly-covered roots must still be scanned, not just the pattern that
// catches it.
describe("extended target-root coverage (apps/indexer-rs, scripts, deploy)", () => {
  // A bare AWS access key id (a hard pattern, not terminology) placed in
  // each of the three newly-covered roots. If any root were still
  // unwalked, this would silently pass -- exactly how the real leaks went
  // undetected before this PR.
  const AWS_TOKEN = `${"AKIA"}IOSFODNN7EXAMPLE\n`;
  const ROOT_CASES = [
    rootCase("scripts/__public_safety_roots__.mjs", AWS_TOKEN),
    rootCase("deploy/__public_safety_roots__.md", AWS_TOKEN),
    rootCase("apps/indexer-rs/__public_safety_roots__.rs", AWS_TOKEN),
  ];
  test("scans scripts/, deploy/, and apps/indexer-rs/ for a real secret shape", () => {
    for (const { file } of ROOT_CASES) {
      assert.ok(
        scanOutput.includes(`${file}:1: aws access key id`),
        `${file} should have been scanned and flagged; got:\n${scanOutput}`,
      );
    }
  });

  const BOX_LINES = [
    "ssh indexeradmin@meta-indexer-01-us-lax1",
    "ssh archiveadmin@meta-archive-01-us-nyc1",
    "docker exec metagraphed-indexer-postgres-1 psql -U metagraphed",
    "docker exec metagraphed-registry-redis-1 redis-cli",
  ];
  const BOX = rootCase("deploy/__public_safety_box__.md", BOX_LINES);
  test("flags the exact internal box hostname / container name shape from the real PR #5064 leak", () => {
    for (const [index] of BOX_LINES.entries()) {
      assert.ok(
        scanOutput.includes(
          `${BOX.file}:${index + 1}: internal box or container identifier`,
        ),
        `line ${index + 1} should be flagged; got:\n${scanOutput}`,
      );
    }
  });

  const BOX_PROSE = rootCase(
    "deploy/__public_safety_box_prose__.md",
    "See the metagraphed-ui repo for frontend work.\n",
  );
  test("does not flag an unrelated metagraphed-prefixed name outside the two known shapes", () => {
    // SCOPED TO THIS FILE (was a repo-wide `includes("internal box or
    // container identifier")` check). Under the single shared scan the
    // PR #5064 case above legitimately produces that finding for its own
    // file, so the repo-wide form would now always fail. Asserting this
    // file contributes no finding at all is the same guarantee, stated
    // against the case that is actually under test.
    assert.equal(
      scanOutput.includes(BOX_PROSE.file),
      false,
      `ordinary "metagraphed-" prose should not be flagged; got:\n${scanOutput}`,
    );
  });

  const CGNAT_LINES = [
    "ws://100.106.70.94:9944",
    "https://100.99.0.1/admin",
    "https://100.63.255.255/not-cgnat",
    "https://100.128.0.1/not-cgnat-either",
  ];
  const CGNAT = rootCase("deploy/__public_safety_cgnat__.md", CGNAT_LINES);
  test("flags a Tailscale CGNAT (100.64.0.0/10) URL as private/loopback, but not an adjacent public 100.x address", () => {
    assert.ok(
      scanOutput.includes(`${CGNAT.file}:1: private or loopback URL`),
      `CGNAT line 1 should be flagged; got:\n${scanOutput}`,
    );
    assert.ok(
      scanOutput.includes(`${CGNAT.file}:2: private or loopback URL`),
      `CGNAT line 2 should be flagged; got:\n${scanOutput}`,
    );
    assert.equal(
      scanOutput.includes(`${CGNAT.file}:3:`),
      false,
      `100.63.x is outside the CGNAT range and must not be flagged; got:\n${scanOutput}`,
    );
    assert.equal(
      scanOutput.includes(`${CGNAT.file}:4:`),
      false,
      `100.128.x is outside the CGNAT range and must not be flagged; got:\n${scanOutput}`,
    );
  });

  const MAGICDNS_LINES = [
    "box-one.some-tailnet.ts.net",
    "login.tailscale.com/a/xyz123",
  ];
  const MAGICDNS = rootCase(
    "deploy/__public_safety_magicdns__.md",
    MAGICDNS_LINES,
  );
  test("flags a Tailscale MagicDNS hostname and the device-auth URL", () => {
    for (const [index] of MAGICDNS_LINES.entries()) {
      assert.ok(
        scanOutput.includes(
          `${MAGICDNS.file}:${index + 1}: Tailscale device identity`,
        ),
        `line ${index + 1} should be flagged; got:\n${scanOutput}`,
      );
    }
  });

  // This file is not scripts/worker-test.ts or a deploy/wss-lb/test/*.test.mjs
  // file (the two known, verified-safe test fixtures that get a file-level
  // exemption below), so an ordinary loopback URL with an arbitrary port/path
  // here must still be flagged -- proving the fix for those two files' false
  // positives didn't become a blanket "any 127.0.0.1 is fine" relaxation, which
  // would defeat the userinfo-smuggling bypass protection "flags local
  // subtensor allowlist prefix bypass attempts" (above) exists to guard.
  const LOOPBACK_LINES = [
    "http://127.0.0.1:5173/healthz",
    "ws://localhost:9944/some/other/path",
  ];
  const LOOPBACK = rootCase(
    "deploy/__public_safety_loopback__.md",
    LOOPBACK_LINES,
  );
  test("does NOT broadly exempt loopback outside the two known-safe files/literals", () => {
    for (const [index] of LOOPBACK_LINES.entries()) {
      assert.ok(
        scanOutput.includes(
          `${LOOPBACK.file}:${index + 1}: private or loopback URL`,
        ),
        `line ${index + 1} should still be flagged; got:\n${scanOutput}`,
      );
    }
  });

  test("exempts the two known-safe local-server test files, but not an arbitrary third file", () => {
    // scripts/worker-test.ts and deploy/wss-lb/test/*.test.mjs are, by
    // inspection, entirely either (a) a local test server bootstrapped on
    // 127.0.0.1, or (b) an explicit "these must be rejected" unsafe-URL array
    // -- verified content, not a blanket file-type exemption. Asserts against
    // the real files in the shared scan, since the exemption is keyed by exact
    // path.
    assert.equal(
      scanOutput.includes("scripts/worker-test.ts:"),
      false,
      `scripts/worker-test.ts's own unsafe-URL test fixtures must not be flagged; got:\n${scanOutput}`,
    );
    assert.equal(
      scanOutput.includes("deploy/wss-lb/test/"),
      false,
      `deploy/wss-lb/test/'s own local-server bootstrapping must not be flagged; got:\n${scanOutput}`,
    );
  });

  const NODE_MODULES_DIR = path.join(repoRoot, "deploy", "node_modules");
  plantedDirs.push(NODE_MODULES_DIR);
  const NODE_MODULES = rootCase(
    "deploy/node_modules/__public_safety_skipped__.md",
    AWS_TOKEN,
  );
  const NODE_MODULES_SIBLING = rootCase(
    "deploy/__public_safety_sibling__.md",
    AWS_TOKEN,
  );
  test("skips node_modules-style directories under a newly-covered root", () => {
    // SCOPED TO THIS FILE (was a repo-wide `includes("node_modules")` check).
    // The planted path is what the walker must never reach; asserting on it
    // directly is the same guarantee and cannot be perturbed by an unrelated
    // finding elsewhere in the shared scan that merely mentions the word.
    assert.equal(
      scanOutput.includes(NODE_MODULES.file),
      false,
      `a file under a node_modules-named directory must not be walked at all; got:\n${scanOutput}`,
    );
    assert.ok(
      scanOutput.includes(`${NODE_MODULES_SIBLING.file}:1: aws access key id`),
      `the sibling file outside node_modules must still be scanned; got:\n${scanOutput}`,
    );
  });
});
