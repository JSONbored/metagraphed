import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { fetchGithubJson } from "../scripts/verification-github-fetch.mjs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("verification GitHub fetch redirect safety", () => {
  test("blocks redirects from public GitHub URLs to private addresses", async () => {
    const fetchCalls = [];
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ init, url: String(url) });
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/repos/foo/bar" },
      });
    };

    const result = await fetchGithubJson("https://api.github.com/repos/foo/bar");

    assert.equal(result.ok, false);
    assert.equal(result.private_redirect_blocked, true);
    assert.equal(result.error, "redirect target is unsafe");
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].init.redirect, "manual");
  });

  test("follows safe redirects while keeping redirects manual", async () => {
    const fetchCalls = [];
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ init, url: String(url) });
      if (fetchCalls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://api.github.com/repos/foo/bar/redirected",
          },
        });
      }
      return Response.json({ full_name: "foo/bar" });
    };

    const result = await fetchGithubJson("https://api.github.com/repos/foo/bar");

    assert.equal(result.ok, true);
    assert.equal(result.body.full_name, "foo/bar");
    assert.deepEqual(
      fetchCalls.map((call) => call.url),
      [
        "https://api.github.com/repos/foo/bar",
        "https://api.github.com/repos/foo/bar/redirected",
      ],
    );
    assert.equal(
      fetchCalls.every((call) => call.init.redirect === "manual"),
      true,
    );
  });
});
