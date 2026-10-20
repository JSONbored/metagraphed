/** Node-driver-only fixture manufacture. Never imported into the Worker. */
import { createHash } from "node:crypto";
import { constants, deflateRawSync, gzipSync } from "node:zlib";

export type Fixture = {
  name: string;
  wire: Uint8Array;
  accepted: boolean;
  expectedBytes?: number;
  expectedSha256?: string;
  compare?: boolean;
};

export function crc32(bytes: Uint8Array) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function little32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}

export function gzip(
  data: Uint8Array,
  options: {
    flags?: number;
    extra?: Uint8Array;
    name?: Uint8Array;
    comment?: Uint8Array;
    raw?: Uint8Array;
    mtime?: number;
    xfl?: number;
    os?: number;
  } = {},
) {
  const flags = options.flags ?? 0;
  const parts: Uint8Array[] = [
    Buffer.from([
      0x1f,
      0x8b,
      8,
      flags,
      0,
      0,
      0,
      0,
      options.xfl ?? 0,
      options.os ?? 255,
    ]),
  ];
  parts[0]!.set(little32(options.mtime ?? 0), 4);
  if (flags & 4) {
    const extra = options.extra ?? Buffer.from([0x41, 0x42, 0, 0]);
    if (extra.length > 65_535) throw new Error("Invalid test XLEN");
    parts.push(Buffer.from([extra.length & 255, extra.length >>> 8]), extra);
  }
  if (flags & 8) parts.push(options.name ?? Buffer.from("name"), Buffer.of(0));
  if (flags & 16)
    parts.push(options.comment ?? Buffer.from("comment"), Buffer.of(0));
  let header = Buffer.concat(parts);
  if (flags & 2) {
    const crc = crc32(header) & 0xffff;
    header = Buffer.concat([header, Buffer.from([crc & 255, crc >>> 8])]);
  }
  return Buffer.concat([
    header,
    options.raw ?? deflateRawSync(data),
    little32(crc32(data)),
    little32(data.byteLength),
  ]);
}

export function valid(
  name: string,
  data: Uint8Array,
  wire = gzip(data),
): Fixture {
  return {
    name,
    wire,
    accepted: true,
    expectedBytes: data.byteLength,
    expectedSha256: createHash("sha256").update(data).digest("hex"),
    compare: wire.byteLength <= 3_145_728 && data.byteLength <= 65_536,
  };
}

function invalid(name: string, wire: Uint8Array): Fixture {
  return { name, wire, accepted: false, compare: wire.byteLength <= 16_384 };
}

function mutated(wire: Uint8Array, at: number, byte: number) {
  const copy = Buffer.from(wire);
  copy[at] = byte;
  return copy;
}

/** Byte-aligned stored blocks, with arbitrary genuine empty deflate blocks. */
export function stored(data: Uint8Array, leadingEmpty = 0, trailingEmpty = 0) {
  const blocks: Buffer[] = [];
  function block(part: Uint8Array, final: boolean) {
    const n = part.byteLength;
    if (n > 65_535) throw new Error("Stored block exceeds LEN");
    blocks.push(
      Buffer.from([
        final ? 1 : 0,
        n & 255,
        n >>> 8,
        ~n & 255,
        (~n >>> 8) & 255,
      ]),
      Buffer.from(part),
    );
  }
  for (let i = 0; i < leadingEmpty; i++) block(Buffer.alloc(0), false);
  if (data.length === 0) {
    block(data, trailingEmpty === 0);
  } else {
    for (let at = 0; at < data.length; at += 65_535) {
      const end = Math.min(data.length, at + 65_535);
      block(data.subarray(at, end), end === data.length && trailingEmpty === 0);
    }
  }
  for (let i = 0; i < trailingEmpty; i++)
    block(Buffer.alloc(0), i === trailingEmpty - 1);
  return Buffer.concat(blocks);
}

export function smallAndFramingFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  const text = Buffer.from("Strict gzip \u0000 Unicode: café 🦊\n");
  for (let flags = 0; flags < 32; flags++) {
    fixtures.push(
      valid(`all-defined-flags-${flags}`, text, gzip(text, { flags })),
    );
  }
  for (const [name, options] of [
    ["empty-fextra", { flags: 4, extra: Buffer.alloc(0) }],
    [
      "empty-fname-comment",
      { flags: 24, name: Buffer.alloc(0), comment: Buffer.alloc(0) },
    ],
    [
      "eight-bit-fname-comment",
      {
        flags: 26,
        name: Buffer.from([0x80, 0xff]),
        comment: Buffer.from([1, 0xfe]),
      },
    ],
    ["max-fextra-fhcrc", { flags: 6, extra: Buffer.alloc(65_535, 0xa5) }],
    ["huge-fname-fhcrc", { flags: 10, name: Buffer.alloc(1_048_576, 0x61) }],
    [
      "huge-fcomment-fhcrc",
      { flags: 18, comment: Buffer.alloc(1_048_576, 0x62) },
    ],
    [
      "huge-all-fields",
      {
        flags: 31,
        extra: Buffer.alloc(65_535, 0xa5),
        name: Buffer.alloc(1_048_576, 0x61),
        comment: Buffer.alloc(1_048_576, 0x62),
      },
    ],
    ["arbitrary-metadata", { mtime: 0xffff_ffff, xfl: 255, os: 42 }],
  ] as const)
    fixtures.push(valid(name, text, gzip(text, options)));

  const empty = Buffer.alloc(0);
  fixtures.push(valid("empty-native-deflate", empty));
  fixtures.push(
    valid("empty-stored", empty, gzip(empty, { raw: stored(empty) })),
  );
  fixtures.push(
    valid(
      "many-empty-blocks",
      empty,
      gzip(empty, {
        raw: stored(empty, 20_000, 20_000),
      }),
    ),
  );
  fixtures.push(
    valid(
      "no-output-before-and-after",
      text,
      gzip(text, {
        raw: stored(text, 20_000, 20_000),
      }),
    ),
  );
  for (const [name, raw] of [
    ["stored", deflateRawSync(text, { level: 0 })],
    ["fixed", deflateRawSync(text, { strategy: constants.Z_FIXED })],
    ["default", deflateRawSync(text)],
  ] as const)
    fixtures.push(valid(`raw-${name}`, text, gzip(text, { raw })));
  const varied = Buffer.from(
    Array.from({ length: 20_000 }, (_, i) => (i % 17 === 0 ? 0 : 97 + (i % 7))),
  );
  const dynamicRaw = deflateRawSync(varied);
  if (((dynamicRaw[0]! >>> 1) & 3) !== 2)
    throw new Error("Review fixture: expected a genuine dynamic Huffman block");
  fixtures.push(
    valid("dynamic-huffman", varied, gzip(varied, { raw: dynamicRaw })),
  );

  // Raw consumed length, not total gzip length, determines the write boundary.
  // Cover all eight trailer splits plus an exact start on a new 4096-byte write.
  for (let rawBytes = 4088; rawBytes <= 4104; rawBytes++) {
    const data = Buffer.alloc(rawBytes - 5, 0x71);
    const wire = gzip(data, { raw: stored(data) });
    fixtures.push(valid(`trailer-boundary-raw-${rawBytes}`, data, wire));
    fixtures.push(
      invalid(
        `trailer-boundary-corrupt-${rawBytes}`,
        mutated(wire, wire.length - 8, wire[wire.length - 8]! ^ 1),
      ),
    );
    fixtures.push(
      invalid(
        `trailer-boundary-truncated-${rawBytes}`,
        wire.subarray(0, wire.length - 1),
      ),
    );
  }
  const canonical = gzip(text);
  for (let end = 0; end < canonical.length; end++)
    fixtures.push(
      invalid(`truncate-every-byte-${end}`, canonical.subarray(0, end)),
    );
  for (const bit of [0x20, 0x40, 0x80])
    fixtures.push(
      invalid(`reserved-header-bit-${bit}`, mutated(canonical, 3, bit)),
    );
  fixtures.push(invalid("bad-magic-0", mutated(canonical, 0, 0)));
  fixtures.push(invalid("bad-magic-1", mutated(canonical, 1, 0)));
  fixtures.push(invalid("bad-method", mutated(canonical, 2, 0)));
  fixtures.push(
    invalid(
      "bad-crc32",
      mutated(
        canonical,
        canonical.length - 8,
        canonical[canonical.length - 8]! ^ 1,
      ),
    ),
  );
  fixtures.push(
    invalid(
      "bad-isize",
      mutated(
        canonical,
        canonical.length - 4,
        canonical[canonical.length - 4]! ^ 1,
      ),
    ),
  );
  const headerCrc = gzip(text, { flags: 31 });
  const headerLength = headerCrc.length - deflateRawSync(text).length - 8;
  fixtures.push(
    invalid(
      "bad-fhcrc",
      mutated(headerCrc, headerLength - 1, headerCrc[headerLength - 1]! ^ 1),
    ),
  );
  fixtures.push(
    invalid(
      "fhcrc-header-byte-corruption",
      mutated(headerCrc, 4, headerCrc[4]! ^ 1),
    ),
  );
  const headerOnly = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
  fixtures.push(
    invalid(
      "fextra-length-overflow",
      Buffer.concat([
        mutated(headerOnly, 3, 4),
        Buffer.from([255, 255]),
        Buffer.alloc(8),
      ]),
    ),
  );
  // Header cursors exactly at the reserved trailer boundary must still fail
  // for missing deflate bytes; one byte beyond must fail header admission.
  for (const length of [1, 2])
    fixtures.push(
      invalid(
        `fextra-reserved-trailer-boundary-${length}`,
        Buffer.concat([
          mutated(headerOnly, 3, 4),
          Buffer.from([length, 0, 0x41]),
          Buffer.alloc(8),
        ]),
      ),
    );
  const emptyHeaderCrc = gzip(empty, { flags: 2 });
  for (const end of [18, 19, 20, 21])
    fixtures.push(
      invalid(
        `fhcrc-reserved-trailer-boundary-${end}`,
        emptyHeaderCrc.subarray(0, end),
      ),
    );
  for (const flag of [8, 16])
    fixtures.push(
      invalid(
        `unterminated-header-${flag}`,
        Buffer.concat([
          mutated(headerOnly, 3, flag),
          Buffer.alloc(100, 65),
          Buffer.alloc(8),
        ]),
      ),
    );
  fixtures.push(
    invalid(
      "missing-fhcrc",
      Buffer.concat([mutated(headerOnly, 3, 2), Buffer.alloc(8)]),
    ),
  );
  fixtures.push(
    invalid(
      "valid-fhcrc-overlaps-reserved-trailer",
      gzip(empty, { flags: 2 }).subarray(0, 18),
    ),
  );
  fixtures.push(
    invalid(
      "reserved-deflate-block-type",
      gzip(text, {
        raw: Buffer.from([7]),
      }),
    ),
  );
  const invalidStored = stored(text);
  invalidStored[3] = invalidStored[3]! ^ 1;
  fixtures.push(
    invalid(
      "stored-length-complement-corruption",
      gzip(text, {
        raw: invalidStored,
      }),
    ),
  );
  for (const [name, tail] of [
    ["trailing-byte", Buffer.of(1)],
    ["trailing-zero", Buffer.of(0)],
    ["trailing-many-zeros", Buffer.alloc(8193)],
    ["trailing-garbage", Buffer.from("garbage")],
    ["concatenated-members", gzip(text)],
    ["concatenated-empty-member", gzip(empty)],
  ] as const)
    fixtures.push(invalid(name, Buffer.concat([canonical, tail])));
  return fixtures;
}

export function maximumExpansionFixture(decodedBytes: number) {
  // Entire original input exists only in Node. The Worker sees wire bytes.
  const original = Buffer.alloc(decodedBytes, 0x78);
  return valid("maximum-expansion", original, gzipSync(original, { level: 9 }));
}
