import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { ipv6EmbeddedIpv4, ipv6ToBytes } from "../src/ip-safety.mjs";

describe("ipv6ToBytes", () => {
  test("returns null for non-IPv6 input", () => {
    assert.equal(ipv6ToBytes(""), null);
    assert.equal(ipv6ToBytes(null), null);
    assert.equal(ipv6ToBytes("127.0.0.1"), null);
    assert.equal(ipv6ToBytes("example.com"), null);
  });

  test("expands :: zero-compression to 16 bytes", () => {
    assert.deepEqual(
      ipv6ToBytes("::1"),
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    );
    assert.deepEqual(ipv6ToBytes("::"), new Array(16).fill(0));
    assert.deepEqual(
      ipv6ToBytes("2002:7f00:1::"),
      [0x20, 0x02, 0x7f, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
  });

  test("parses a trailing dotted-quad IPv4 group", () => {
    assert.deepEqual(
      ipv6ToBytes("::ffff:127.0.0.1"),
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1],
    );
  });

  test("parses a fully-specified address without ::", () => {
    assert.deepEqual(
      ipv6ToBytes("2606:4700:4700:0:0:0:0:1111"),
      [0x26, 0x06, 0x47, 0x00, 0x47, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x11],
    );
  });

  test("rejects malformed input", () => {
    assert.equal(ipv6ToBytes("1:2:3::4::5"), null); // two "::" runs
    assert.equal(ipv6ToBytes("gggg::1"), null); // non-hex group
    assert.equal(ipv6ToBytes("1:2:3:4:5:6:7"), null); // too few groups, no ::
    assert.equal(ipv6ToBytes("::1.2.3"), null); // truncated dotted-quad
    assert.equal(ipv6ToBytes("::1.2.3.999"), null); // octet out of range
  });

  // SSRF-guard regression edges: a dotted-quad smuggled mid-address, a
  // non-numeric octet, and a :: that overruns 16 bytes must all be rejected
  // (return null) so a caller can never be tricked into treating a malformed
  // literal as a routable global-unicast address.
  test("rejects a dotted-quad that is not the final group", () => {
    // The IPv4 tail is only legal as the LAST group (x:x:x:x:x:x:d.d.d.d).
    assert.equal(ipv6ToBytes("::1.2.3.4:5"), null);
    assert.equal(ipv6ToBytes("1.2.3.4:1::"), null);
  });

  test("rejects a dotted-quad with a non-numeric octet", () => {
    // Four octets present, but one is non-numeric — must fail the /^\d{1,3}$/
    // octet check (distinct from the truncated-quad length check).
    assert.equal(ipv6ToBytes("::1.2.x.4"), null);
    assert.equal(ipv6ToBytes("::ffff:1.2.3.f"), null);
  });

  test("rejects a :: whose head+tail overflow 16 bytes (fill < 0)", () => {
    // head (8 hextets = 16 bytes) + a non-empty tail leaves a negative fill, so
    // the "::" cannot expand to a valid address — must be rejected, never
    // silently truncated into a routable-looking literal.
    assert.equal(ipv6ToBytes("1:2:3:4:5:6:7:8::9"), null);
    assert.equal(ipv6ToBytes("1:2:3:4:5::6:7:8:9:a"), null);
  });

  test("ignores a zone id", () => {
    assert.deepEqual(ipv6ToBytes("fe80::1%eth0"), ipv6ToBytes("fe80::1"));
  });
});

describe("ipv6EmbeddedIpv4", () => {
  test("extracts the embedded v4 for each tunnelling form", () => {
    assert.deepEqual(ipv6EmbeddedIpv4("::ffff:127.0.0.1"), [127, 0, 0, 1]); // mapped
    assert.deepEqual(ipv6EmbeddedIpv4("::ffff:7f00:1"), [127, 0, 0, 1]); // mapped, hex tail
    assert.deepEqual(ipv6EmbeddedIpv4("::127.0.0.1"), [127, 0, 0, 1]); // compatible
    assert.deepEqual(ipv6EmbeddedIpv4("::7f00:1"), [127, 0, 0, 1]); // compatible, normalised
    assert.deepEqual(ipv6EmbeddedIpv4("2002:7f00:1::"), [127, 0, 0, 1]); // 6to4
    assert.deepEqual(ipv6EmbeddedIpv4("64:ff9b::7f00:1"), [127, 0, 0, 1]); // NAT64
    assert.deepEqual(
      ipv6EmbeddedIpv4("::ffff:169.254.169.254"),
      [169, 254, 169, 254],
    );
  });

  test("returns null for a global-unicast address with no embedded v4", () => {
    assert.equal(ipv6EmbeddedIpv4("2606:4700:4700::1111"), null);
    assert.equal(ipv6EmbeddedIpv4("fe80::1"), null);
    assert.equal(ipv6EmbeddedIpv4("fd00::1"), null);
  });

  test("returns null for non-IPv6 input", () => {
    assert.equal(ipv6EmbeddedIpv4("8.8.8.8"), null);
    assert.equal(ipv6EmbeddedIpv4("example.com"), null);
  });
});
