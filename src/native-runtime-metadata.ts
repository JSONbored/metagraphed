// Portable metadata is the native contract, rather than a second hand-kept
// list of storage layouts. This reader is independent of the capture pipeline.
// Frame metadata V14/V15 and scale-info define the wire format; all allocation
// and recursion limits apply before decoding untrusted RPC data.
export const NATIVE_RUNTIME_LIMITS = {
  metadataBytes: 2_097_152,
  valueBytes: 262_144,
  types: 16_384,
  items: 16_384,
  depth: 64,
  text: 65_536,
  page: 64,
} as const;

export class NativeScaleReader {
  readonly bytes: Uint8Array;
  offset = 0;
  constructor(
    hex: unknown,
    maxBytes: number = NATIVE_RUNTIME_LIMITS.valueBytes,
  ) {
    if (
      typeof hex !== "string" ||
      hex.length > 2 + maxBytes * 2 ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)
    )
      throw new Error("Invalid or oversized native SCALE data");
    this.bytes = Buffer.from(hex.slice(2), "hex");
  }
  take(length: number) {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.bytes.length
    )
      throw new Error("Truncated native SCALE data");
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  uint(length: number) {
    let result = 0n;
    const bytes = this.take(length);
    for (let index = bytes.length - 1; index >= 0; index--)
      result = (result << 8n) | BigInt(bytes[index]!);
    return result;
  }
  byte() {
    return Number(this.uint(1));
  }
  compact() {
    const first = this.byte();
    const mode = first & 3;
    let result: bigint;
    if (mode === 0) return BigInt(first >> 2);
    if (mode === 1) result = (BigInt(first) | (this.uint(1) << 8n)) >> 2n;
    else if (mode === 2) result = (BigInt(first) | (this.uint(3) << 8n)) >> 2n;
    else {
      const length = (first >> 2) + 4;
      if (length > 32) throw new Error("Native compact integer exceeds u256");
      const bytes = this.take(length);
      if (bytes[length - 1] === 0)
        throw new Error("Noncanonical native compact integer");
      result = 0n;
      for (let index = length - 1; index >= 0; index--)
        result = (result << 8n) | BigInt(bytes[index]!);
    }
    const minimum = mode === 1 ? 64n : mode === 2 ? 16_384n : 1_073_741_824n;
    if (result < minimum)
      throw new Error("Noncanonical native compact integer");
    return result;
  }
  count(limit: number = NATIVE_RUNTIME_LIMITS.items) {
    const value = this.compact();
    if (value > BigInt(limit))
      throw new Error("Native SCALE collection exceeds work budget");
    return Number(value);
  }
  vector<T>(read: () => T, limit: number = NATIVE_RUNTIME_LIMITS.items): T[] {
    return Array.from({ length: this.count(limit) }, read);
  }
  forEach(read: () => void, limit: number = NATIVE_RUNTIME_LIMITS.items) {
    for (let remaining = this.count(limit); remaining > 0; remaining--)
      read();
  }
  option<T>(read: () => T): T | null {
    const tag = this.byte();
    if (tag === 0) return null;
    if (tag !== 1) throw new Error("Invalid native SCALE option");
    return read();
  }
  text() {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      this.take(this.count(NATIVE_RUNTIME_LIMITS.text)),
    );
  }
  blob() {
    return `0x${Buffer.from(this.take(this.count(NATIVE_RUNTIME_LIMITS.metadataBytes))).toString("hex")}`;
  }
  finish<T>(value: T) {
    if (this.offset !== this.bytes.length)
      throw new Error("Trailing native SCALE data");
    return value;
  }
}

export type NativeField = import("zod").infer<
  typeof import("../schemas-src/routes/native-runtime.ts").NativeFieldSchema
>;
export type NativeDefinition = import("zod").infer<
  typeof import("../schemas-src/routes/native-runtime.ts").NativeDefinitionSchema
>;
export type NativeType = import("zod").infer<
  typeof import("../schemas-src/routes/native-runtime.ts").NativePortableTypeSchema
>;
export interface NativeStorage {
  name: string;
  optional: boolean;
  value: number;
  key: number | null;
  hashers: number[];
  fallback: string;
}
export interface NativeConstant {
  name: string;
  type: number;
  value: string;
}
export interface NativePallet {
  name: string;
  prefix: string;
  index: number;
  calls: number | null;
  storage: NativeStorage[];
  constants: NativeConstant[];
}
export interface NativeRuntimeMethod {
  name: string;
  inputs: NativeField[];
  output: number;
}
export interface NativeRuntimeApi {
  name: string;
  methods: NativeRuntimeMethod[];
}
export interface NativeMetadata {
  version: 14 | 15;
  types: Map<number, NativeType>;
  pallets: NativePallet[];
  apis: NativeRuntimeApi[];
  extrinsicVersion: number;
  signedExtensions: { name: string; type: number; additional: number }[];
}

/** Drop documentation while reading it: it must not inflate tool context or
 * leave the cursor at a guessed offset. Type names and indices remain exact. */
export function decodeNativeMetadata(hex: unknown): NativeMetadata {
  const reader =
    hex instanceof NativeScaleReader
      ? hex
      : new NativeScaleReader(hex, NATIVE_RUNTIME_LIMITS.metadataBytes);
  if (
    reader.offset !== 0 ||
    reader.bytes.length > NATIVE_RUNTIME_LIMITS.metadataBytes
  )
    throw new Error("Invalid or oversized native metadata reader");
  if (Buffer.from(reader.take(4)).toString("hex") !== "6d657461")
    throw new Error("Invalid native metadata magic");
  const version = reader.byte();
  if (version !== 14 && version !== 15)
    throw new Error("Unsupported native metadata format");
  const id = () => reader.count(NATIVE_RUNTIME_LIMITS.types - 1);
  const docs = () => {
    reader.forEach(() => reader.text());
  };
  const field = (): NativeField => {
    const name = reader.option(() => reader.text());
    const type = id();
    reader.option(() => reader.text());
    docs();
    return { name, type };
  };
  const types = new Map<number, NativeType>();
  reader.forEach(() => {
    const typeId = id();
    const path = reader.vector(() => reader.text());
    reader.forEach(() => {
      reader.text();
      reader.option(id);
    });
    const tag = reader.byte();
    let definition: NativeDefinition;
    switch (tag) {
      case 0:
        definition = { kind: "composite", fields: reader.vector(field) };
        break;
      case 1:
        definition = {
          kind: "variant",
          variants: reader.vector(() => {
            const name = reader.text();
            const fields = reader.vector(field);
            const index = reader.byte();
            docs();
            return { name, fields, index };
          }),
        };
        break;
      case 2:
        definition = { kind: "sequence", type: id() };
        break;
      case 3: {
        const length = Number(reader.uint(4));
        definition = { kind: "array", length, type: id() };
        break;
      }
      case 4:
        definition = { kind: "tuple", types: reader.vector(id) };
        break;
      case 5: {
        const primitive = reader.byte();
        if (primitive > 14) throw new Error("Invalid native primitive");
        definition = { kind: "primitive", primitive };
        break;
      }
      case 6:
        definition = { kind: "compact", type: id() };
        break;
      case 7:
        definition = { kind: "bits", store: id(), order: id() };
        break;
      default:
        throw new Error("Invalid native type definition");
    }
    docs();
    if (types.has(typeId)) throw new Error("Duplicate native type identity");
    types.set(typeId, { id: typeId, path, definition });
  }, NATIVE_RUNTIME_LIMITS.types);
  const pallets = reader.vector((): NativePallet => {
    const name = reader.text();
    const storage = reader.option(() => {
      const prefix = reader.text();
      const entries = reader.vector((): NativeStorage => {
        const item = reader.text();
        const modifier = reader.byte();
        if (modifier > 1) throw new Error("Invalid native storage modifier");
        const tag = reader.byte();
        let value: number,
          key: number | null = null,
          hashers: number[] = [];
        if (tag === 0) value = id();
        else if (tag === 1) {
          hashers = reader.vector(() => {
            const hasher = reader.byte();
            if (hasher > 6) throw new Error("Invalid native storage hasher");
            return hasher;
          }, 64);
          if (hashers.length === 0)
            throw new Error("Empty native storage hashers");
          key = id();
          value = id();
        } else throw new Error("Invalid native storage type");
        const fallback = reader.blob();
        docs();
        return {
          name: item,
          optional: modifier === 0,
          value,
          key,
          hashers,
          fallback,
        };
      });
      return { prefix, entries };
    });
    const calls = reader.option(id);
    reader.option(id);
    const constants = reader.vector((): NativeConstant => {
      const item = reader.text();
      const type = id();
      const value = reader.blob();
      docs();
      return { name: item, type, value };
    });
    reader.option(id);
    const index = reader.byte();
    if (version === 15) docs();
    return {
      name,
      index,
      prefix: storage?.prefix ?? name,
      calls,
      storage: storage?.entries ?? [],
      constants,
    };
  }, 256);
  let extrinsicVersion: number;
  if (version === 14) {
    id();
    extrinsicVersion = reader.byte();
  } else {
    extrinsicVersion = reader.byte();
    id();
    id();
    id();
    id();
  }
  const signedExtensions = reader.vector(
    () => ({ name: reader.text(), type: id(), additional: id() }),
    64,
  );
  id();
  const apis =
    version === 14
      ? []
      : reader.vector((): NativeRuntimeApi => {
          const name = reader.text();
          const methods = reader.vector((): NativeRuntimeMethod => {
            const method = reader.text();
            const inputs = reader.vector(
              () => ({ name: reader.text(), type: id() }),
              64,
            );
            const output = id();
            docs();
            return { name: method, inputs, output };
          });
          docs();
          return { name, methods };
        }, 256);
  if (version === 15) {
    id();
    id();
    id();
    reader.forEach(() => {
      reader.text();
      id();
      reader.blob();
    });
  }
  return reader.finish({
    version,
    types,
    pallets,
    apis,
    extrinsicVersion,
    signedExtensions,
  });
}

/** Metadata_metadata_at_version returns Option<OpaqueMetadata>, whose Some
 * payload is a SCALE byte vector. Default state_getMetadata returns bare meta. */
export function unwrapNativeMetadata(hex: unknown) {
  const reader = new NativeScaleReader(
    hex,
    NATIVE_RUNTIME_LIMITS.metadataBytes + 8,
  );
  return reader.finish(reader.option(() => reader.blob()));
}
