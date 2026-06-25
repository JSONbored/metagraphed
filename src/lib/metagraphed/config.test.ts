import { describe, it, expect } from "vitest";
import { sanitizeApiBase } from "./config";

// sanitizeApiBase is the XSS taint barrier: a persisted / user-supplied API base
// must never reach an href as an executable URL. Only http(s) origins pass.
describe("sanitizeApiBase", () => {
  it("rejects nullish / empty input", () => {
    expect(sanitizeApiBase(undefined)).toBeNull();
    expect(sanitizeApiBase(null)).toBeNull();
    expect(sanitizeApiBase("")).toBeNull();
    expect(sanitizeApiBase("   ")).toBeNull();
  });

  it("rejects dangerous / non-http schemes", () => {
    expect(sanitizeApiBase("javascript:alert(1)")).toBeNull();
    expect(sanitizeApiBase("JavaScript:alert(1)")).toBeNull();
    expect(sanitizeApiBase("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(sanitizeApiBase("vbscript:msgbox(1)")).toBeNull();
    expect(sanitizeApiBase("file:///etc/passwd")).toBeNull();
    expect(sanitizeApiBase("ws://example.com")).toBeNull();
    expect(sanitizeApiBase("ftp://example.com")).toBeNull();
    // A leading-space trick must not smuggle javascript: past the trim+regex.
    expect(sanitizeApiBase("  javascript:alert(1)")).toBeNull();
  });

  it("rejects an http scheme with no host", () => {
    expect(sanitizeApiBase("https:")).toBeNull();
    expect(sanitizeApiBase("http://")).toBeNull();
  });

  it("accepts valid http(s) origins, trimming whitespace + trailing slash", () => {
    expect(sanitizeApiBase("https://api.metagraph.sh")).toBe("https://api.metagraph.sh");
    expect(sanitizeApiBase("http://localhost:8787")).toBe("http://localhost:8787");
    expect(sanitizeApiBase("  https://api.metagraph.sh/  ")).toBe("https://api.metagraph.sh");
    expect(sanitizeApiBase("https://example.com/api/v1")).toBe("https://example.com/api/v1");
  });

  it("accepts HTTPS regardless of scheme casing", () => {
    expect(sanitizeApiBase("HTTPS://api.metagraph.sh")).toBe("HTTPS://api.metagraph.sh");
  });
});
