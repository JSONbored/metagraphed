import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
  isUnsafeResolvedUrl,
  isUnsafeUrl,
  normalizePublicHttpUrl,
  repoRoot,
} from "../scripts/lib.mjs";

const FIXTURE_DIR = path.join(repoRoot, "dist/metagraph-r2/metagraph/fixtures");
const TEST_FIXTURE = "__public_safety_test__.json";
const TEST_FIXTURE_PATH = path.join(FIXTURE_DIR, TEST_FIXTURE);
const TEST_PUBLIC_FILE = "__public_safety_test__.txt";
const TEST_PUBLIC_PATH = path.join(repoRoot, "public", TEST_PUBLIC_FILE);

async function writeTestFixture(body) {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  await fs.writeFile(
    TEST_FIXTURE_PATH,
    JSON.stringify({ response: { body } }),
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
    assert.equal(await isUnsafeResolvedUrl("http://localhost/"), true);
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
    assert.equal(await isUnsafeResolvedUrl("https://example.com/"), false);
    assert.equal(
      await isUnsafeResolvedUrl("https://metagraphed.invalid/"),
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

  test("still flags suspicious coldkey prose that a hyphen can't smuggle past", async () => {
    // The coldkey-only exemption is the exact phrase, not a blanket `coldkey-`
    // strip: a hyphenated secret attempt must still trip the terminology guard.
    await fs.writeFile(
      TEST_PUBLIC_PATH,
      "Set coldkey-seedphrase to 5xyzABCDEFGHabcdefgh in your config.\n",
      "utf8",
    );
    const output = runScanOutput();
    assert.ok(
      output.includes(`${TEST_PUBLIC_FILE}:1: Bittensor key terminology`),
      `a hyphenated coldkey secret attempt must still be flagged; got:\n${output}`,
    );
  });
});
