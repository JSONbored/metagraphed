import { describe, expect, it } from "vitest";

import { apiSnippet } from "./endpoint-snippet";

describe("apiSnippet", () => {
  it("shell-quotes curl snippets for URLs containing command characters", () => {
    const url = "https://api.example/v1/' ; rm -rf ~ #";

    expect(apiSnippet("curl", url)).toBe("curl -sS 'https://api.example/v1/'\\'' ; rm -rf ~ #'");
  });

  it("JSON-quotes JavaScript and Python snippets", () => {
    const url = "https://api.example/v1?x='\"";

    expect(apiSnippet("js", url)).toBe(`fetch(${JSON.stringify(url)}).then((r) => r.json())`);
    expect(apiSnippet("python", url)).toBe(`requests.get(${JSON.stringify(url)}).json()`);
  });

  it("builds a POST request (with body) for every language when options.body is present", () => {
    const url = "https://api.example/v1/ask";
    const body = { question: "which subnet does image generation?" };

    expect(apiSnippet("curl", url, { body })).toBe(
      `curl -sS -X POST -H 'content-type: application/json' -d '${JSON.stringify(body)}' '${url}'`,
    );
    expect(apiSnippet("js", url, { body })).toContain('method: "POST"');
    expect(apiSnippet("js", url, { body })).toContain(JSON.stringify(body));
    expect(apiSnippet("python", url, { body })).toBe(
      `requests.post(${JSON.stringify(url)}, json=${JSON.stringify(body)}).json()`,
    );
    // The URL tab alone would read as a GET otherwise -- the method is
    // spelled out rather than silently omitting the body it needs.
    expect(apiSnippet("url", url, { body })).toBe(`POST ${url}`);
  });

  it("converts JSON true/false/null to Python's True/False/None in a POST body", () => {
    const url = "https://api.example/v1/ask";
    expect(apiSnippet("python", url, { body: { verbose: true, limit: null } })).toBe(
      `requests.post(${JSON.stringify(url)}, json={"verbose":True,"limit":None}).json()`,
    );
  });

  it("omitting options.body keeps every existing GET snippet byte-for-byte unchanged", () => {
    const url = "https://api.example/v1/subnets/7";
    expect(apiSnippet("curl", url, {})).toBe(apiSnippet("curl", url));
    expect(apiSnippet("url", url, {})).toBe(url);
  });
});
