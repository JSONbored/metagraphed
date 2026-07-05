import { describe, expect, it } from "vitest";
import { safeExternalUrl } from "./external-link";

describe("safeExternalUrl", () => {
  it("allows ordinary public http(s) URLs", () => {
    expect(safeExternalUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(safeExternalUrl("http://docs.example.com/")).toBe("http://docs.example.com/");
  });

  it("blocks non-http schemes and credentialed URLs", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalUrl("data:text/html,hi")).toBeUndefined();
    expect(safeExternalUrl("file:///etc/passwd")).toBeUndefined();
    expect(safeExternalUrl("https://user:pass@example.com/")).toBeUndefined();
    expect(safeExternalUrl("https://user@example.com/")).toBeUndefined();
  });

  it("returns undefined for missing, empty, or malformed input without throwing", () => {
    expect(safeExternalUrl(undefined)).toBeUndefined();
    expect(safeExternalUrl("")).toBeUndefined();
    expect(safeExternalUrl("   ")).toBeUndefined();
    expect(() => safeExternalUrl("not a url")).not.toThrow();
    expect(safeExternalUrl("not a url")).toBeUndefined();
    expect(() => safeExternalUrl("//evil.com/no-protocol")).not.toThrow();
    expect(safeExternalUrl("//evil.com/no-protocol")).toBeUndefined();
    expect(() => safeExternalUrl("http://")).not.toThrow();
    expect(safeExternalUrl("http://")).toBeUndefined();
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(safeExternalUrl("  https://example.com/  ")).toBe("https://example.com/");
  });

  it("normalizes hostname case and trailing dot before matching private hosts", () => {
    expect(safeExternalUrl("http://LOCALHOST/")).toBeUndefined();
    expect(safeExternalUrl("http://localhost./")).toBeUndefined();
    expect(safeExternalUrl("http://sub.localhost/")).toBeUndefined();
    expect(safeExternalUrl("http://EXAMPLE.com/")).toBe("http://example.com/");
  });

  it("blocks private, reserved, and local host targets", () => {
    const unsafe = [
      "http://localhost/",
      "http://service.local/",
      "http://0.0.0.0/",
      "http://10.0.0.1/",
      "http://100.64.0.1/",
      "http://127.0.0.1/",
      "http://169.254.169.254/",
      "http://172.16.0.1/",
      "http://192.0.2.1/",
      "http://192.168.0.1/",
      "http://198.18.0.1/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://224.0.0.1/",
      "http://[::1]/",
      "http://[::ffff:7f00:1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
    ];

    for (const href of unsafe) {
      expect(safeExternalUrl(href), href).toBeUndefined();
    }
  });
});
