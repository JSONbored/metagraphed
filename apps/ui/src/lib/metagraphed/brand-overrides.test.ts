import { describe, it, expect } from "vitest";
import { normalizePublicProxyHost, isIpLiteral } from "./brand-overrides";

// normalizePublicProxyHost is the client-side SSRF pre-filter for the icon proxy:
// only public-looking DNS names are forwarded. IP literals, localhost-ish names,
// and private/reserved TLDs are rejected.
describe("normalizePublicProxyHost", () => {
  it("rejects nullish / empty input", () => {
    expect(normalizePublicProxyHost(undefined)).toBeNull();
    expect(normalizePublicProxyHost(null)).toBeNull();
    expect(normalizePublicProxyHost("")).toBeNull();
    expect(normalizePublicProxyHost("   ")).toBeNull();
  });

  it("rejects IPv4 literals", () => {
    expect(normalizePublicProxyHost("127.0.0.1")).toBeNull();
    expect(normalizePublicProxyHost("10.0.0.5")).toBeNull();
    expect(normalizePublicProxyHost("169.254.1.1")).toBeNull();
  });

  it("rejects IPv6 literals", () => {
    expect(normalizePublicProxyHost("[::1]")).toBeNull();
    expect(normalizePublicProxyHost("::1")).toBeNull();
    expect(normalizePublicProxyHost("[fe80::1]")).toBeNull();
  });

  it("rejects localhost-ish names and private/reserved TLDs", () => {
    expect(normalizePublicProxyHost("foo.localhost")).toBeNull();
    expect(normalizePublicProxyHost("svc.internal")).toBeNull();
    expect(normalizePublicProxyHost("printer.local")).toBeNull();
  });

  it("rejects bare single-label hosts", () => {
    expect(normalizePublicProxyHost("localhost")).toBeNull();
    expect(normalizePublicProxyHost("intranet")).toBeNull();
  });

  it("rejects malformed labels and over-long hosts", () => {
    expect(normalizePublicProxyHost("-bad.example.com")).toBeNull();
    expect(normalizePublicProxyHost("bad-.example.com")).toBeNull();
    expect(normalizePublicProxyHost("under_score.example.com")).toBeNull();
    expect(normalizePublicProxyHost("a".repeat(64) + ".com")).toBeNull(); // label > 63
    expect(normalizePublicProxyHost("a." + "b".repeat(300) + ".com")).toBeNull(); // > 253
  });

  it("accepts valid public hosts, normalising case / www. / trailing dot", () => {
    expect(normalizePublicProxyHost("example.com")).toBe("example.com");
    expect(normalizePublicProxyHost("API.Metagraph.SH")).toBe("api.metagraph.sh");
    expect(normalizePublicProxyHost("www.example.com")).toBe("example.com");
    expect(normalizePublicProxyHost("example.com.")).toBe("example.com");
    expect(normalizePublicProxyHost("  taostats.io  ")).toBe("taostats.io");
    expect(normalizePublicProxyHost("a.b.c.example.org")).toBe("a.b.c.example.org");
  });
});

describe("isIpLiteral", () => {
  it("is true for IPv4 dotted quads", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("255.255.255.255")).toBe(true);
    expect(isIpLiteral("0.0.0.0")).toBe(true);
  });

  it("is true for IPv6 (bracketed or colon-bearing)", () => {
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("fe80::1")).toBe(true);
    expect(isIpLiteral("::ffff:1.2.3.4")).toBe(true);
  });

  it("is false for DNS names and out-of-range / malformed quads", () => {
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("256.0.0.1")).toBe(false); // octet > 255
    expect(isIpLiteral("1.2.3")).toBe(false); // too few octets
    expect(isIpLiteral("1.2.3.4.5")).toBe(false); // too many octets
  });
});
