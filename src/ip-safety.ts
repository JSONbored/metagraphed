// Shared IPv6 parsing for the SSRF guards in webhooks.mjs and health-prober.ts.
// Leaf module: imports nothing, so either guard can use it without an import
// cycle (mirrors the de-monolith leaf-module discipline in workers/storage.mjs).
//
// Several IPv6 textual forms embed an IPv4 address. A guard that only string- or
// prefix-matches IPv6 cannot see the tunnelled v4, so an attacker reaches a
// loopback / RFC1918 target it would otherwise block:
//   ::ffff:127.0.0.1   IPv4-mapped     (::ffff:0:0/96)
//   ::127.0.0.1        IPv4-compatible (::/96, deprecated)
//   2002:7f00:1::      6to4            (2002::/16, v4 in the next 32 bits)
//   64:ff9b::7f00:1    NAT64           (64:ff9b::/96 well-known prefix)
// The WHATWG URL parser re-serialises the v4 tail into hextets (e.g. [::127.0.0.1]
// becomes ::7f00:1), so the caller can't string-match it either. We parse to the
// 16 address bytes and return the embedded v4 octets so the caller can apply its
// own private-range policy.

// Parse an IPv6 literal to its 16 bytes, or null if it is not a valid IPv6
// address. Handles "::" zero-compression and an optional trailing dotted-quad
// IPv4 (the standard x:x:x:x:x:x:d.d.d.d notation). A zone id (%eth0) is ignored.
export function ipv6ToBytes(value: unknown): number[] | null {
  let host = String(value || "")
    .trim()
    .toLowerCase();
  if (!host.includes(":")) return null;
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);

  // At most one "::" run is allowed.
  const halves = host.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const parts = segment.split(":");
    const bytes: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.includes(".")) {
        // A dotted-quad IPv4 is only valid as the final group.
        if (i !== parts.length - 1) return null;
        const octets = part.split(".");
        if (octets.length !== 4) return null;
        for (const octet of octets) {
          if (!/^\d{1,3}$/.test(octet)) return null;
          const n = Number(octet);
          if (n > 255) return null;
          bytes.push(n);
        }
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      const n = Number.parseInt(part, 16);
      bytes.push((n >> 8) & 0xff, n & 0xff);
    }
    return bytes;
  };

  const head = parseGroups(halves[0]);
  if (head === null) return null;

  if (halves.length === 2) {
    const tail = parseGroups(halves[1]);
    if (tail === null) return null;
    const fill = 16 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...new Array(fill).fill(0), ...tail];
  }

  // No "::" — the address must be fully specified.
  return head.length === 16 ? head : null;
}

// Return the IPv4 octets [a,b,c,d] embedded in an IPv6 literal for the mapped /
// compatible / 6to4 / NAT64 forms, or null when the address embeds no IPv4 the
// caller should re-check. `::` and `::1` embed 0.0.0.0 / 0.0.0.1, which a v4
// private-range check already rejects, so they need no special-casing here.
export function ipv6EmbeddedIpv4(value: unknown): number[] | null {
  const bytes = ipv6ToBytes(value);
  if (!bytes) return null;
  const isZero = (start: number, end: number) =>
    bytes.slice(start, end).every((b) => b === 0);
  const v4At = (i: number) => bytes.slice(i, i + 4);

  // IPv4-mapped ::ffff:0:0/96
  if (isZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff)
    return v4At(12);
  // IPv4-compatible ::/96 (the high 96 bits are zero)
  if (isZero(0, 12)) return v4At(12);
  // 6to4 2002::/16 — the v4 is the 32 bits after the 2002 prefix
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return v4At(2);
  // NAT64 64:ff9b::/96 well-known prefix
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    isZero(4, 12)
  ) {
    return v4At(12);
  }
  return null;
}
