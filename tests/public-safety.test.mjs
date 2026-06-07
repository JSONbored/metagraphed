import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { isUnsafeResolvedUrl, isUnsafeUrl } from "../scripts/lib.mjs";

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

  test("blocks hostnames that resolve to private addresses", async () => {
    assert.equal(await isUnsafeResolvedUrl("http://localhost/"), true);
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
