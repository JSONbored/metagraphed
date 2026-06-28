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
});
