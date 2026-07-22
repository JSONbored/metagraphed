import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import {
  isUnsafeResolvedUrl,
  isUnsafeUrl,
  normalizePublicHttpUrl,
  repoRoot,
} from "../scripts/lib.mjs";

// This exact path is load-bearing: scan-public-safety.mjs's own
// mirroredFixturePatterns exempts dist/metagraph-r2/metagraph/fixtures/*.json
// from the soft wallet/key terminology rules (legitimate third-party API docs
// mentioning "private key"/"seed phrase" in a non-leaking context), and this
// describe block specifically tests that exemption -- do not relocate it.
// It is, however, also where validate-schemas.mjs's templated-artifact lookup
// lists real artifact JSON to schema-validate, which is why this file is
// pinned to serial execution (see package.json's test:ci exclude list): under
// vitest's default parallel file execution, this test's transient fixture
// write/cleanup raced validate-error-messages.test.mjs's own (concurrent)
// validate-schemas.mjs invocation scanning the same directory, an
// intermittent ENOENT once this test's afterEach deleted the fixture before
// the other process finished reading it. validate-error-messages.test.mjs
// itself is now ALSO pinned to serial execution (2026-07-17) -- it mutates a
// real registry/subnets/*.json file in place for its validate-schemas.mjs
// enum-error-message test, which was still racing OTHER parallel full-
// registry scans (e.g. validate-surface-duplicate-url.test.mjs) even after
// this fix landed for the public-safety-vs-validate-error-messages pair
// specifically.
const FIXTURE_DIR = path.join(repoRoot, "dist/metagraph-r2/metagraph/fixtures");
const TEST_FIXTURE = "__public_safety_test__.json";
const TEST_FIXTURE_PATH = path.join(FIXTURE_DIR, TEST_FIXTURE);
const TEST_PUBLIC_FILE = "__public_safety_test__.txt";
const TEST_PUBLIC_PATH = path.join(repoRoot, "public", TEST_PUBLIC_FILE);
// Each of the 38 tests that call runScanOutput() spawns a real `node
// scripts/scan-public-safety.mjs` subprocess that walks the entire repo tree
// -- unlike this file's other (in-process) tests, its cost scales with repo
// size and is subject to real process-spawn/scheduler variance, not just
// this file's own logic. 15000ms (set when the registry was a fraction of
// today's size) left too thin a margin: a solo run now measures ~4.3s, but
// under any contention (CI runner load, other parallel test files/
// processes) that 3.5x margin evaporates, intermittently timing out tests
// that aren't actually hung. 45000ms keeps a genuine hang catchable while
// giving this subprocess-per-test pattern room to keep growing with the repo.
const SCANNER_TEST_TIMEOUT_MS = 45000;

vi.setConfig({ testTimeout: SCANNER_TEST_TIMEOUT_MS });

async function writeTestFixture(body, { kind } = {}) {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  await fs.writeFile(
    TEST_FIXTURE_PATH,
    JSON.stringify({ kind, response: { body } }),
    "utf8",
  );
}

// Run the real scanner and return its combined output. The scanner walks the
// whole repo, so its exit code depends on unrelated tree state — assertions key
// off the test fixture's path in the output, which is independent of that.
function runScanOutput() {
  try {
    execFileSync("node", ["scripts/scan-public-safety.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return "";
  } catch (err) {
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

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
      await isUnsafeResolvedUrl("https://internal.example/", privateResolver),
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
      await isUnsafeResolvedUrl("https://metagraph.example/", publicResolver),
      false,
    );
    assert.equal(
      await isUnsafeResolvedUrl("https://metagraph.invalid/", failingResolver),
      true,
    );
  });
});

describe("captured-fixture body scan", () => {
  afterEach(async () => {
    await fs.rm(TEST_FIXTURE_PATH, { force: true });
    await fs.rm(TEST_PUBLIC_PATH, { force: true });
  });

  test("allows only the exact documented local subtensor endpoint", async () => {
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      "Use the documented local RPC at `ws://127.0.0.1:9944` for local development.\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.equal(
      output.includes(TEST_PUBLIC_FILE),
      false,
      `the exact documented endpoint should be exempt; got:\n${output}`,
    );
  });

  test("flags local subtensor allowlist prefix bypass attempts", async () => {
    const bypassAttempts = [
      "ws://127.0.0.1:9944/admin",
      "ws://127.0.0.1:9944?token=abcdefghijklmnop",
      "ws://127.0.0.1:9944@10.0.0.1/private",
    ];

    await fs.writeFile(
      TEST_PUBLIC_PATH,
      `${bypassAttempts.join("\n")}\n`,
      "utf8",
    );
    const output = runScanOutput();
    for (const [index] of bypassAttempts.entries()) {
      assert.ok(
        output.includes(
          `${TEST_PUBLIC_FILE}:${index + 1}: private or loopback URL`,
        ),
        `bypass attempt on line ${index + 1} must be flagged; got:\n${output}`,
      );
    }
  });

  test("flags secrets assigned to compound credential names", async () => {
    const leaks = [
      "client_secret=abcdefghijklmnop1234",
      "db_password=abcdefghijklmnop1234",
      "google_oauth_client_secret=abcdefghijklmnop1234",
      "secret=abcdefghijklmnop1234",
    ];
    await fs.writeFile(TEST_PUBLIC_PATH, `${leaks.join("\n")}\n`, "utf8");
    const output = runScanOutput();
    for (const [index] of leaks.entries()) {
      assert.ok(
        output.includes(
          `${TEST_PUBLIC_FILE}:${index + 1}: token-like assignment`,
        ),
        `secret on line ${index + 1} must be flagged; got:\n${output}`,
      );
    }
  });

  test("flags every GitHub token prefix, not just ghp_", async () => {
    // ghp_ is the personal-access prefix, but gho_/ghu_/ghs_/ghr_ (OAuth,
    // user-to-server, App installation, refresh) are the same leakable family.
    // Assemble each token from a prefix + shared body at runtime so the source
    // never commits a contiguous token-shaped literal (which secret scanners
    // would flag as a leaked credential in the diff).
    const body = "abcdefghijklmnopqrstuvwxyz0123456789";
    const leaks = ["ghp", "gho", "ghu", "ghs", "ghr"].map(
      (prefix) => `${prefix}_${body}`,
    );
    await fs.writeFile(TEST_PUBLIC_PATH, `${leaks.join("\n")}\n`, "utf8");
    const output = runScanOutput();
    for (const [index] of leaks.entries()) {
      assert.ok(
        output.includes(`${TEST_PUBLIC_FILE}:${index + 1}: github token`),
        `github token on line ${index + 1} must be flagged; got:\n${output}`,
      );
    }
  });

  test("flags a bare GitLab personal access token", async () => {
    // The routable `glpat-` prefix + 20+ URL-safe chars is the GitLab analog of a
    // leaked GitHub token; none of the other token rules (sk-/xox/gh) catch it.
    // Assemble the prefix + shared body at runtime so the source never commits a
    // contiguous token-shaped literal (which secret scanners flag in the diff).
    const token = `glpat-${"abcdefghijklmnopqrst"}`;
    await fs.writeFile(TEST_PUBLIC_PATH, `${token}\n`, "utf8");
    const output = runScanOutput();
    assert.ok(
      output.includes(`${TEST_PUBLIC_FILE}:1: gitlab personal access token`),
      `GitLab personal access token must be flagged; got:\n${output}`,
    );
  });

  test("flags a bare npm access token", async () => {
    // The fixed `npm_` prefix + 36 base62 chars is the documented automation /
    // granular token format; a leaked one grants package publish rights (a supply-
    // chain risk) and none of the other token rules catch it. Assemble the prefix +
    // shared body at runtime so the source never commits a contiguous token literal.
    const token = `npm_${"abcdefghijklmnopqrstuvwxyz0123456789"}`; // npm_ + 36 chars
    await fs.writeFile(TEST_PUBLIC_PATH, `${token}\n`, "utf8");
    const output = runScanOutput();
    assert.ok(
      output.includes(`${TEST_PUBLIC_FILE}:1: npm access token`),
      `npm access token must be flagged; got:\n${output}`,
    );
  });

  test("flags a link-local cloud-metadata URL as a private/loopback leak", async () => {
    // 169.254.169.254 is the AWS/GCP metadata endpoint — the canonical SSRF /
    // credential-theft target and unsafe per lib.mjs isUnsafeUrl, so a leaked URL
    // to the 169.254.0.0/16 link-local range must be flagged like the RFC1918
    // ranges. (A bare `169.254.169.254` in prose, with no URL scheme, is not.)
    const lines = [
      "http://169.254.169.254/latest/meta-data/",
      "https://169.254.42.7/admin",
    ];
    await fs.writeFile(TEST_PUBLIC_PATH, `${lines.join("\n")}\n`, "utf8");
    const output = runScanOutput();
    for (const [index] of lines.entries()) {
      assert.ok(
        output.includes(
          `${TEST_PUBLIC_FILE}:${index + 1}: private or loopback URL`,
        ),
        `link-local URL on line ${index + 1} must be flagged; got:\n${output}`,
      );
    }
  });

  test("flags a bare AWS access key id", async () => {
    // The signed-URL rule only catches request params; a long-term (AKIA) or
    // temporary (ASIA) access key id pasted into a doc/config is the common leak.
    // Assemble prefix + shared body at runtime so the source never commits a
    // contiguous key-shaped literal (which secret scanners flag in the diff).
    const leaks = ["AKIA", "ASIA"].map((prefix) => `${prefix}IOSFODNN7EXAMPLE`);
    await fs.writeFile(TEST_PUBLIC_PATH, `${leaks.join("\n")}\n`, "utf8");
    const output = runScanOutput();
    for (const [index] of leaks.entries()) {
      assert.ok(
        output.includes(`${TEST_PUBLIC_FILE}:${index + 1}: aws access key id`),
        `AWS access key id on line ${index + 1} must be flagged; got:\n${output}`,
      );
    }
  });

  test("does not flag soft Bittensor terminology in a mirrored fixture body", async () => {
    // Regression for the publish-wedging false positive: upstream API docs
    // legitimately say "miner hotkey" / "validator hotkey path".
    await writeTestFixture({
      summary: "The miner hotkey to look up",
      detail: "Provide the validator hotkey path and coldkey wording.",
    });
    const output = runScanOutput();
    assert.equal(
      output.includes(TEST_FIXTURE),
      false,
      `soft terminology should be exempt in mirrored fixture bodies; got:\n${output}`,
    );
  });

  test("flags sensitive wallet/key wording hidden in a fixture body value", async () => {
    await writeTestFixture({
      note: "seed phrase: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    });
    const output = runScanOutput();
    assert.ok(
      output.includes(`${TEST_FIXTURE}:response.body.note: wallet/key wording`),
      `sensitive wallet/key wording must still fire on fixture body values; got:\n${output}`,
    );
  });

  test("flags sensitive wallet/key wording hidden in a fixture body key", async () => {
    await writeTestFixture({
      "seed phrase":
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    });
    const output = runScanOutput();
    assert.ok(
      output.includes(
        `${TEST_FIXTURE}:response.body.seed phrase key: wallet/key wording`,
      ),
      `sensitive wallet/key wording must still fire on fixture body keys; got:\n${output}`,
    );
  });

  test("flags a bare Google API key", async () => {
    // The AIza-prefixed 39-char key is a distinctive, unambiguous credential
    // format that none of the URL/token rules caught.
    const key = `AIza${"b".repeat(35)}`;
    await fs.writeFile(TEST_PUBLIC_PATH, `${key}\n`, "utf8");
    const output = runScanOutput();
    assert.ok(
      output.includes(`${TEST_PUBLIC_FILE}:1: google api key`),
      `Google API key must be flagged; got:\n${output}`,
    );
  });

  test("still flags a hard secret hidden in a fixture body value", async () => {
    await writeTestFixture({
      note: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    const output = runScanOutput();
    assert.ok(
      output.includes(`${TEST_FIXTURE}:response.body`),
      `hard secret patterns must still fire on fixture body values; got:\n${output}`,
    );
  });

  test("flags wallet/key wording in a generic description fixture body value", async () => {
    await writeTestFixture({
      description:
        "seed phrase: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    });
    const output = runScanOutput();
    assert.ok(
      output.includes(
        `${TEST_FIXTURE}:response.body.description: wallet/key wording`,
      ),
      `sensitive wallet/key wording must fire in generic description fields; got:\n${output}`,
    );
  });

  test("does not flag wallet/key wording in an OpenAPI documentation field", async () => {
    // Regression for the sn-97 publish wedge: a captured openapi parameter
    // description reads "…your wallet path / seed phrase…" — public API docs the
    // subnet published, not a leaked secret value.
    await writeTestFixture({
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
    const output = runScanOutput();
    assert.equal(
      output.includes(TEST_FIXTURE),
      false,
      `wallet/key wording in a documentation field should be exempt; got:\n${output}`,
    );
  });

  test("still flags a hard secret even inside a documentation field", async () => {
    // The doc-field exemption is soft-only: a real token in a description is
    // still caught by the hard secret patterns.
    await writeTestFixture({
      info: {
        description:
          "Example call: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
    });
    const output = runScanOutput();
    assert.ok(
      output.includes(`${TEST_FIXTURE}:response.body`),
      `hard secrets must fire even inside doc fields; got:\n${output}`,
    );
  });

  test("exempts wallet/key wording anywhere in an openapi-kind fixture body, not just doc fields", async () => {
    // Regression for the live sn-33 publish failure (2026-07-20): a
    // WalletCreate JSON-Schema's own property name (`private_key`) and its
    // sibling `required` array entry are schema metadata, not a
    // description/summary/title documentation field, so the existing
    // isOpenApiDocumentationField exemption above doesn't reach them.
    await writeTestFixture(
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
    const output = runScanOutput();
    assert.equal(
      output.includes(TEST_FIXTURE),
      false,
      `openapi-kind schema metadata should be exempt; got:\n${output}`,
    );
  });

  test("exempts wallet/key wording in a subnet-api-kind quick-start tutorial", async () => {
    // Regression for the live sn-58 publish failure (2026-07-20): a
    // quick-start step showing how to generate a brand-new wallet locally
    // (`Wallet.createRandom()`) legitimately mentions "privateKey" while
    // disclosing no actual secret. Not OpenAPI-shaped at all, so
    // isOpenApiDocumentationField's isOpenApiBody gate never applies here.
    await writeTestFixture(
      {
        quick_start: {
          step2_wallet:
            "node -e \"const w=require('ethers').Wallet.createRandom();console.log(w.address, w.privateKey)\"",
        },
      },
      { kind: "subnet-api" },
    );
    const output = runScanOutput();
    assert.equal(
      output.includes(TEST_FIXTURE),
      false,
      `subnet-api-kind quick-start prose should be exempt; got:\n${output}`,
    );
  });

  test("does not extend the curated-kind exemption to data-artifact fixtures", async () => {
    // data-artifact fixtures are live operational data (e.g. a genomics
    // subnet's arbitrary per-miner submitted log text), not the operator's
    // own curated docs -- wallet/key wording must still be caught there.
    await writeTestFixture(
      {
        note: "seed phrase: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      },
      { kind: "data-artifact" },
    );
    const output = runScanOutput();
    assert.ok(
      output.includes(`${TEST_FIXTURE}:response.body.note: wallet/key wording`),
      `data-artifact fixtures must still be scanned; got:\n${output}`,
    );
  });

  test("allows the hotkey/coldkey and coldkey-only API-prose forms", async () => {
    // Regression for the generated MCP server-card prose: the slash form
    // "hotkey/coldkey" and the "coldkey-only" behaviour descriptor are standard
    // Bittensor API vocabulary explaining public read-only behaviour — the same
    // safe class as the already-allowed "hotkey or coldkey" phrase, just written
    // differently. Neither carries any secret.
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      [
        "The hotkey/coldkey owning the account, base58, 47-48 chars.",
        "A coldkey-only SS58 address won't appear in the hotkey-attributed rollup.",
      ].join("\n") + "\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.equal(
      output.includes(TEST_PUBLIC_FILE),
      false,
      `hotkey/coldkey and coldkey-only API prose should be exempt; got:\n${output}`,
    );
  });

  test("allows generated CSV headers with a coldkey column", async () => {
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      [
        "uid,hotkey,coldkey,active,validator_permit",
        "hotkey,coldkey,coldkey_count,subnet_count,uid_count",
      ].join("\n") + "\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.equal(
      output.includes(TEST_PUBLIC_FILE),
      false,
      `generated CSV headers should be exempt; got:\n${output}`,
    );

    await import("../scripts/scan-public-safety.mjs");
  });

  test("still flags suspicious coldkey prose that a hyphen can't smuggle past", async () => {
    // The coldkey-only exemption is the exact phrase, not a blanket `coldkey-`
    // strip: a hyphenated secret attempt must still trip the terminology guard.
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      "Set coldkey-only-seedphrase to 5xyzABCDEFGHabcdefgh in your config.\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.ok(
      output.includes(`${TEST_PUBLIC_FILE}:1: Bittensor key terminology`),
      `a hyphenated coldkey secret attempt must still be flagged; got:\n${output}`,
    );
  });

  test("allows the coldkey IS [NOT] NULL SQL comparison, same class as coldkey =", async () => {
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      [
        "WHERE netuid = ${netuid} AND coldkey IS NOT NULL",
        "WHERE coldkey IS NULL",
      ].join("\n") + "\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.equal(
      output.includes(TEST_PUBLIC_FILE),
      false,
      `coldkey IS [NOT] NULL SQL comparisons should be exempt; got:\n${output}`,
    );
  });

  test("does not let 'coldkey is not' prose without the literal NULL keyword slip past", async () => {
    // The IS [NOT] NULL exemption requires the literal SQL keyword, not just
    // "is"/"is not" -- prose using the same words must still be flagged.
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      "The coldkey is not something you should ever share.\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.ok(
      output.includes(`${TEST_PUBLIC_FILE}:1: Bittensor key terminology`),
      `prose without the literal NULL keyword must still be flagged; got:\n${output}`,
    );
  });

  test("allows Rust field-access + method-call syntax on a coldkey field (#6718)", async () => {
    // ext.coldkey.is_some() / .clone() / .unwrap() -- Rust has no `?.` operator,
    // so the existing coldkey?. optional-chaining exemption (TS/JS-specific)
    // doesn't cover this extremely common Option-field-check idiom in
    // apps/indexer-rs's own test code.
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      [
        "assert!(ext.coldkey.is_some());",
        "let c = row.coldkey.clone();",
        "let c = row.coldkey.unwrap();",
      ].join("\n") + "\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.equal(
      output.includes(TEST_PUBLIC_FILE),
      false,
      `coldkey.method() Rust syntax should be exempt; got:\n${output}`,
    );
  });

  test("does not let 'coldkey.' followed by prose (not a real method call) slip past", async () => {
    // The new coldkey.[a-z_]+( allowance requires an opening paren -- a
    // capitalized word or a word with no trailing paren after "coldkey." must
    // still be flagged, so this can't be used to smuggle real prose past the
    // guard by appending an unrelated identifier after a dot.
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      "The coldkey.owner field should never be logged in plaintext.\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.ok(
      output.includes(`${TEST_PUBLIC_FILE}:1: Bittensor key terminology`),
      `prose after "coldkey." without a real method call must still be flagged; got:\n${output}`,
    );
  });

  test("flags hyphenated/compound wallet-key wording a literal-space regex would miss", async () => {
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      [
        "seed-phrase",
        "seedphrase",
        "seed_phrase",
        "private-key",
        "privatekey",
        "wallet-path",
        "walletpath",
      ].join("\n") + "\n",
      "utf8",
    );
    const output = runScanOutput();
    for (let line = 1; line <= 7; line += 1) {
      assert.ok(
        output.includes(`${TEST_PUBLIC_FILE}:${line}: wallet/key wording`),
        `line ${line} should be flagged as wallet/key wording; got:\n${output}`,
      );
    }
  });

  test("does not flag a compound word that only shares a prefix, not the full phrase", async () => {
    // \b after the optional separator still requires a real word boundary --
    // continuing into more identifier characters must not match.
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      ["privateKeyRef", "seedphrases", "walletpathfinder"].join("\n") + "\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.equal(
      output.includes(TEST_PUBLIC_FILE),
      false,
      `a partial/continued word must not trip wallet/key wording; got:\n${output}`,
    );
  });

  test("flags hyphenated/compound sensitive hotkey wording a literal-space regex would miss", async () => {
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      ["wallet-hotkey", "hotkey-path", "hotkey-seed-phrase"].join("\n") + "\n",
      "utf8",
    );
    const output = runScanOutput();
    for (let line = 1; line <= 3; line += 1) {
      assert.ok(
        output.includes(
          `${TEST_PUBLIC_FILE}:${line}: sensitive hotkey wording`,
        ),
        `line ${line} should be flagged as sensitive hotkey wording; got:\n${output}`,
      );
    }
  });

  test("does not flag a real X-Role-Hotkey HTTP header name", async () => {
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      [
        "X-Validator-Hotkey",
        "X-Miner-Hotkey",
        "Requires the X-Validator-Hotkey and X-Validator-Signature headers.",
      ].join("\n") + "\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.equal(
      output.includes(TEST_PUBLIC_FILE),
      false,
      `a real X-Role-Hotkey header name must not trip sensitive hotkey wording; got:\n${output}`,
    );
  });

  test("still flags validator/miner hotkey prose alongside a real header name on other lines", async () => {
    // The allowlist strips only the exact "X-Role-Hotkey" shape -- lowercase
    // or space-joined wording using the same words, even on an adjacent line
    // in the same file, must still trip the rule untouched.
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      [
        "X-Validator-Hotkey",
        "share your validator hotkey with us",
        "x-validator-hotkey",
      ].join("\n") + "\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.ok(
      !output.includes(`${TEST_PUBLIC_FILE}:1: sensitive hotkey wording`),
      `line 1 (real header name) must not be flagged; got:\n${output}`,
    );
    assert.ok(
      output.includes(`${TEST_PUBLIC_FILE}:2: sensitive hotkey wording`),
      `line 2 (space-joined prose) should still be flagged; got:\n${output}`,
    );
    assert.ok(
      output.includes(`${TEST_PUBLIC_FILE}:3: sensitive hotkey wording`),
      `line 3 (lowercase header-shaped text) should still be flagged; got:\n${output}`,
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
  const TEST_SCRIPTS_FIXTURE = path.join(
    repoRoot,
    "scripts",
    "__public_safety_test__.mjs",
  );
  const TEST_DEPLOY_FIXTURE = path.join(
    repoRoot,
    "deploy",
    "__public_safety_test__fixture__.md",
  );
  const TEST_INDEXER_RS_FIXTURE = path.join(
    repoRoot,
    "apps/indexer-rs",
    "__public_safety_test__.rs",
  );
  const TEST_NODE_MODULES_DIR = path.join(repoRoot, "deploy", "node_modules");
  const TEST_NODE_MODULES_FIXTURE = path.join(
    TEST_NODE_MODULES_DIR,
    "__public_safety_test__.md",
  );

  afterEach(async () => {
    await fs.rm(TEST_SCRIPTS_FIXTURE, { force: true });
    await fs.rm(TEST_DEPLOY_FIXTURE, { force: true });
    await fs.rm(TEST_INDEXER_RS_FIXTURE, { force: true });
    await fs.rm(TEST_NODE_MODULES_DIR, { recursive: true, force: true });
  });

  test("scans scripts/, deploy/, and apps/indexer-rs/ for a real secret shape", async () => {
    // A bare AWS access key id (a hard pattern, not terminology) placed in
    // each of the three newly-covered roots. If any root were still
    // unwalked, this would silently pass -- exactly how the real leaks went
    // undetected before this PR.
    const token = "AKIA" + "IOSFODNN7EXAMPLE";
    await fs.writeFile(TEST_SCRIPTS_FIXTURE, `${token}\n`, "utf8");
    await fs.writeFile(TEST_DEPLOY_FIXTURE, `${token}\n`, "utf8");
    await fs.writeFile(TEST_INDEXER_RS_FIXTURE, `${token}\n`, "utf8");
    const output = runScanOutput();
    for (const path_ of [
      "scripts/__public_safety_test__.mjs",
      "deploy/__public_safety_test__fixture__.md",
      "apps/indexer-rs/__public_safety_test__.rs",
    ]) {
      assert.ok(
        output.includes(`${path_}:1: aws access key id`),
        `${path_} should have been scanned and flagged; got:\n${output}`,
      );
    }
  });

  test("flags the exact internal box hostname / container name shape from the real PR #5064 leak", async () => {
    const lines = [
      "ssh indexeradmin@meta-indexer-01-us-lax1",
      "ssh archiveadmin@meta-archive-01-us-nyc1",
      "docker exec metagraphed-indexer-postgres-1 psql -U metagraphed",
      "docker exec metagraphed-registry-redis-1 redis-cli",
    ];
    await fs.writeFile(TEST_DEPLOY_FIXTURE, `${lines.join("\n")}\n`, "utf8");
    const output = runScanOutput();
    for (const [index] of lines.entries()) {
      assert.ok(
        output.includes(
          `deploy/__public_safety_test__fixture__.md:${index + 1}: internal box or container identifier`,
        ),
        `line ${index + 1} should be flagged; got:\n${output}`,
      );
    }
  });

  test("does not flag an unrelated metagraphed-prefixed name outside the two known shapes", async () => {
    await fs.writeFile(
      TEST_DEPLOY_FIXTURE,
      "See the metagraphed-ui repo for frontend work.\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.equal(
      output.includes("internal box or container identifier"),
      false,
      `ordinary "metagraphed-" prose should not be flagged; got:\n${output}`,
    );
  });

  test("flags a Tailscale CGNAT (100.64.0.0/10) URL as private/loopback, but not an adjacent public 100.x address", async () => {
    const lines = [
      "ws://100.106.70.94:9944",
      "https://100.99.0.1/admin",
      "https://100.63.255.255/not-cgnat",
      "https://100.128.0.1/not-cgnat-either",
    ];
    await fs.writeFile(TEST_DEPLOY_FIXTURE, `${lines.join("\n")}\n`, "utf8");
    const output = runScanOutput();
    assert.ok(
      output.includes(
        "deploy/__public_safety_test__fixture__.md:1: private or loopback URL",
      ),
      `CGNAT line 1 should be flagged; got:\n${output}`,
    );
    assert.ok(
      output.includes(
        "deploy/__public_safety_test__fixture__.md:2: private or loopback URL",
      ),
      `CGNAT line 2 should be flagged; got:\n${output}`,
    );
    assert.equal(
      output.includes("deploy/__public_safety_test__fixture__.md:3:"),
      false,
      `100.63.x is outside the CGNAT range and must not be flagged; got:\n${output}`,
    );
    assert.equal(
      output.includes("deploy/__public_safety_test__fixture__.md:4:"),
      false,
      `100.128.x is outside the CGNAT range and must not be flagged; got:\n${output}`,
    );
  });

  test("flags a Tailscale MagicDNS hostname and the device-auth URL", async () => {
    const lines = [
      "box-one.some-tailnet.ts.net",
      "login.tailscale.com/a/xyz123",
    ];
    await fs.writeFile(TEST_DEPLOY_FIXTURE, `${lines.join("\n")}\n`, "utf8");
    const output = runScanOutput();
    for (const [index] of lines.entries()) {
      assert.ok(
        output.includes(
          `deploy/__public_safety_test__fixture__.md:${index + 1}: Tailscale device identity`,
        ),
        `line ${index + 1} should be flagged; got:\n${output}`,
      );
    }
  });

  test("does NOT broadly exempt loopback outside the two known-safe files/literals", async () => {
    // deploy/__public_safety_test__fixture__.md is not scripts/worker-test.mjs or a
    // deploy/wss-lb/test/*.test.mjs file (the two known, verified-safe test
    // fixtures that get a file-level exemption below), so an ordinary loopback
    // URL with an arbitrary port/path here must still be flagged -- proving
    // the fix for those two files' false positives didn't become a blanket
    // "any 127.0.0.1 is fine" relaxation, which would defeat the userinfo-
    // smuggling bypass protection "flags local subtensor allowlist prefix
    // bypass attempts" (above) exists to guard.
    const lines = [
      "http://127.0.0.1:5173/healthz",
      "ws://localhost:9944/some/other/path",
    ];
    await fs.writeFile(TEST_DEPLOY_FIXTURE, `${lines.join("\n")}\n`, "utf8");
    const output = runScanOutput();
    for (const [index] of lines.entries()) {
      assert.ok(
        output.includes(
          `deploy/__public_safety_test__fixture__.md:${index + 1}: private or loopback URL`,
        ),
        `line ${index + 1} should still be flagged; got:\n${output}`,
      );
    }
  });

  test("exempts the two known-safe local-server test files, but not an arbitrary third file", async () => {
    // scripts/worker-test.mjs and deploy/wss-lb/test/*.test.mjs are, by
    // inspection, entirely either (a) a local test server bootstrapped on
    // 127.0.0.1, or (b) an explicit "these must be rejected" unsafe-URL array
    // -- verified content, not a blanket file-type exemption. Scan the real
    // files directly rather than a throwaway fixture, since the exemption is
    // keyed by exact path.
    const output = runScanOutput();
    assert.equal(
      output.includes("scripts/worker-test.mjs:"),
      false,
      `scripts/worker-test.mjs's own unsafe-URL test fixtures must not be flagged; got:\n${output}`,
    );
    assert.equal(
      output.includes("deploy/wss-lb/test/"),
      false,
      `deploy/wss-lb/test/'s own local-server bootstrapping must not be flagged; got:\n${output}`,
    );
  });

  test("skips node_modules-style directories under a newly-covered root", async () => {
    await fs.mkdir(TEST_NODE_MODULES_DIR, { recursive: true });
    const token = "AKIA" + "IOSFODNN7EXAMPLE";
    await fs.writeFile(TEST_NODE_MODULES_FIXTURE, `${token}\n`, "utf8");
    await fs.writeFile(TEST_DEPLOY_FIXTURE, `${token}\n`, "utf8");
    const output = runScanOutput();
    assert.equal(
      output.includes("node_modules"),
      false,
      `a file under a node_modules-named directory must not be walked at all; got:\n${output}`,
    );
    assert.ok(
      output.includes(
        "deploy/__public_safety_test__fixture__.md:1: aws access key id",
      ),
      `the sibling file outside node_modules must still be scanned; got:\n${output}`,
    );
  });
});
