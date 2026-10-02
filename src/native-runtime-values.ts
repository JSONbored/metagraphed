import { blake2b } from "@noble/hashes/blake2.js";
import {
  storageMapPrefix,
  twox64Concat,
  twox128,
  xxh64,
} from "./twox-storage-key.ts";
import {
  NativeScaleReader,
  NATIVE_RUNTIME_LIMITS,
  type NativeMetadata,
  type NativeField,
  type NativeStorage,
} from "./native-runtime-metadata.ts";

export type NativeValue =
  | null
  | boolean
  | string
  | number
  | NativeValue[]
  | { [key: string]: NativeValue };
const WIDTHS = [1, 2, 4, 8, 16, 32];
export function nativeHex(bytes: Uint8Array) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}
function join(parts: Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  if (length > NATIVE_RUNTIME_LIMITS.valueBytes)
    throw new Error("Native encoded value exceeds byte budget");
  return Buffer.concat(parts, length);
}
function unsigned(value: bigint, length: number) {
  if (value < 0n || value >= 1n << BigInt(length * 8))
    throw new Error("Native integer out of range");
  const out = Buffer.alloc(length);
  for (let index = 0; index < length; index++) {
    out[index] = Number(value & 255n);
    value >>= 8n;
  }
  return out;
}
function integer(value: NativeValue) {
  if (typeof value === "number" && Number.isSafeInteger(value))
    return BigInt(value);
  if (
    typeof value !== "string" ||
    !/^-?(0|[1-9]\d*)$/.test(value) ||
    value.length > 79
  )
    throw new Error(
      "Native integers require exact decimal strings or safe integers",
    );
  return BigInt(value);
}
export function nativeCompact(value: bigint) {
  if (value < 0n || value >= 1n << 256n)
    throw new Error("Native compact integer out of range");
  if (value < 64n) return unsigned(value << 2n, 1);
  if (value < 16_384n) return unsigned((value << 2n) | 1n, 2);
  if (value < 1_073_741_824n) return unsigned((value << 2n) | 2n, 4);
  const length = Math.ceil(value.toString(2).length / 8);
  return join([
    unsigned(BigInt(((length - 4) << 2) | 3), 1),
    unsigned(value, length),
  ]);
}
function getType(metadata: NativeMetadata, id: number) {
  const type = metadata.types.get(id);
  if (!type) throw new Error("Missing native portable type");
  return type.definition;
}
export function nativeUnsignedWidth(metadata: NativeMetadata, id: number, depth = 0): number {
  if (depth > NATIVE_RUNTIME_LIMITS.depth)
    throw new Error("Native type recursion exceeds work budget");
  const type = getType(metadata, id);
  if (type.kind === "primitive" && type.primitive >= 3 && type.primitive <= 8)
    return WIDTHS[type.primitive - 3]!;
  if (type.kind === "composite" && type.fields.length === 1)
    return nativeUnsignedWidth(metadata, type.fields[0]!.type, depth + 1);
  throw new Error("Native compact/bit storage must be unsigned integer");
}
function fieldsValue(
  fields: NativeField[],
  values: NativeValue[],
): NativeValue {
  if (fields.length === 1 && fields[0]!.name === null) return values[0]!;
  if (fields.every((field) => field.name !== null))
    return Object.fromEntries(
      fields.map((field, index) => [field.name!, values[index]!]),
    );
  return values;
}
function fieldsInput(fields: NativeField[], value: NativeValue): NativeValue[] {
  if (fields.length === 1 && fields[0]!.name === null) return [value];
  if (fields.every((field) => field.name !== null)) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== fields.length ||
      !fields.every((field) => Object.hasOwn(value, field.name!))
    )
      throw new Error("Native fields do not match the runtime contract");
    return fields.map((field) => value[field.name!]!);
  }
  if (!Array.isArray(value) || value.length !== fields.length)
    throw new Error("Native tuple does not match the runtime contract");
  return value;
}
/** Exact portable values, with no float amounts or per-byte JSON arrays.
 * Enum values retain their variant; fixed-point/newtype values retain raw bits.
 * Runtime-specific display conversion belongs to the relevant feature view. */
export function decodeNativeValue(
  metadata: NativeMetadata,
  id: number,
  hex: unknown,
): NativeValue {
  const partial = hex instanceof NativeScaleReader;
  const reader = partial ? hex : new NativeScaleReader(hex);
  const value = nativeValueReader(metadata, reader)(id);
  return partial ? value : reader.finish(value);
}

/** One allocation budget shared by all values retained in an explicit page. */
export function nativeValueReader(
  metadata: NativeMetadata,
  reader: NativeScaleReader,
  initialWork = 0,
) {
  if (
    reader.bytes.length > NATIVE_RUNTIME_LIMITS.valueBytes ||
    !Number.isSafeInteger(reader.offset) ||
    reader.offset < 0 ||
    reader.offset > reader.bytes.length
  )
    throw new Error("Invalid or oversized native value reader");
  let work = initialWork;
  const read = (typeId: number, depth = 0): NativeValue => {
    if (
      depth > NATIVE_RUNTIME_LIMITS.depth ||
      ++work > NATIVE_RUNTIME_LIMITS.items
    )
      throw new Error("Native value exceeds work budget");
    const type = getType(metadata, typeId);
    const child = (next: number) => read(next, depth + 1);
    switch (type.kind) {
      case "composite":
        return fieldsValue(
          type.fields,
          type.fields.map((field) => child(field.type)),
        );
      case "tuple":
        return type.types.map(child);
      case "variant": {
        const index = reader.byte();
        const variant = type.variants.find(
          (candidate) => candidate.index === index,
        );
        if (!variant) throw new Error("Invalid native enum variant");
        return {
          variant: variant.name,
          fields: fieldsValue(
            variant.fields,
            variant.fields.map((field) => child(field.type)),
          ),
        };
      }
      case "array":
      case "sequence": {
        const element = getType(metadata, type.type);
        const raw = element.kind === "primitive" && element.primitive === 3;
        const limit = raw
          ? NATIVE_RUNTIME_LIMITS.valueBytes
          : NATIVE_RUNTIME_LIMITS.items;
        const length =
          type.kind === "array" ? type.length : reader.count(limit);
        if (length > limit) throw new Error("Native value exceeds work budget");
        // Raw bytes use one bulk slice; only recursively decoded items use
        // the collection work budget. The reader still enforces valueBytes.
        if (raw) return nativeHex(reader.take(length));
        return Array.from({ length }, () => child(type.type));
      }
      case "compact": {
        const value = reader.compact();
        if (value >= 1n << BigInt(nativeUnsignedWidth(metadata, type.type) * 8))
          throw new Error("Native compact integer out of range");
        return value.toString();
      }
      case "bits": {
        const length = reader.count();
        const width = nativeUnsignedWidth(metadata, type.store);
        if (width > 8) throw new Error("Invalid native bit storage width");
        return {
          bit_length: length,
          bytes_hex: nativeHex(
            reader.take(Math.ceil(length / (width * 8)) * width),
          ),
        };
      }
      case "primitive": {
        const primitive = type.primitive;
        if (primitive === 0) {
          const value = reader.byte();
          if (value > 1) throw new Error("Invalid native boolean");
          return value === 1;
        }
        if (primitive === 1) {
          const code = Number(reader.uint(4));
          if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
            throw new Error("Invalid native character");
          return String.fromCodePoint(code);
        }
        if (primitive === 2) return reader.text();
        const signed = primitive >= 9;
        const width = WIDTHS[primitive - (signed ? 9 : 3)]!;
        let value = reader.uint(width);
        if (signed && value >= 1n << BigInt(width * 8 - 1))
          value -= 1n << BigInt(width * 8);
        return value.toString();
      }
    }
  };
  return read;
}

export function encodeNativeValue(
  metadata: NativeMetadata,
  id: number,
  value: NativeValue,
): Uint8Array {
  let work = 0;
  const encode = (
    typeId: number,
    input: NativeValue,
    depth = 0,
  ): Uint8Array => {
    if (
      depth > NATIVE_RUNTIME_LIMITS.depth ||
      ++work > NATIVE_RUNTIME_LIMITS.items
    )
      throw new Error("Native value exceeds work budget");
    const type = getType(metadata, typeId);
    const child = (next: number, part: NativeValue) =>
      encode(next, part, depth + 1);
    let result: Uint8Array;
    switch (type.kind) {
      case "composite": {
        const parts = fieldsInput(type.fields, input);
        result = join(
          type.fields.map((field, index) => child(field.type, parts[index]!)),
        );
        break;
      }
      case "tuple": {
        if (!Array.isArray(input) || input.length !== type.types.length)
          throw new Error("Native tuple does not match the runtime contract");
        result = join(
          type.types.map((next, index) => child(next, input[index]!)),
        );
        break;
      }
      case "variant": {
        if (
          input === null ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).length !== 2
        )
          throw new Error("Native enum requires variant and fields");
        const variant = type.variants.find(
          (candidate) => candidate.name === input.variant,
        );
        if (!variant || !Object.hasOwn(input, "fields"))
          throw new Error("Invalid native enum variant");
        const parts = fieldsInput(variant.fields, input.fields!);
        result = join([
          unsigned(BigInt(variant.index), 1),
          ...variant.fields.map((field, index) =>
            child(field.type, parts[index]!),
          ),
        ]);
        break;
      }
      case "array":
      case "sequence": {
        const element = getType(metadata, type.type);
        let body: Uint8Array, length: number;
        if (
          typeof input === "string" &&
          element.kind === "primitive" &&
          element.primitive === 3
        ) {
          const bytes = new NativeScaleReader(input);
          body = bytes.bytes;
          length = body.length;
        } else {
          if (
            !Array.isArray(input) ||
            input.length > NATIVE_RUNTIME_LIMITS.items
          )
            throw new Error(
              "Native sequence exceeds work budget or has invalid shape",
            );
          length = input.length;
          body = join(input.map((part) => child(type.type, part)));
        }
        if (type.kind === "array" && length !== type.length)
          throw new Error(
            "Native array length does not match the runtime contract",
          );
        result =
          type.kind === "sequence"
            ? join([nativeCompact(BigInt(length)), body])
            : body;
        break;
      }
      case "compact": {
        const amount = integer(input);
        unsigned(amount, nativeUnsignedWidth(metadata, type.type));
        result = nativeCompact(amount);
        break;
      }
      case "bits": {
        if (
          input === null ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).length !== 2 ||
          typeof input.bit_length !== "number" ||
          !Number.isSafeInteger(input.bit_length) ||
          input.bit_length < 0 ||
          input.bit_length > NATIVE_RUNTIME_LIMITS.items
        )
          throw new Error("Invalid native bit sequence");
        const width = nativeUnsignedWidth(metadata, type.store);
        if (width > 8) throw new Error("Invalid native bit storage width");
        const bytes = new NativeScaleReader(input.bytes_hex).bytes;
        if (bytes.length !== Math.ceil(input.bit_length / (width * 8)) * width)
          throw new Error("Invalid native bit sequence length");
        result = join([nativeCompact(BigInt(input.bit_length)), bytes]);
        break;
      }
      case "primitive": {
        const primitive = type.primitive;
        if (primitive === 0) {
          if (typeof input !== "boolean")
            throw new Error("Invalid native boolean");
          result = unsigned(input ? 1n : 0n, 1);
          break;
        }
        if (primitive === 1) {
          if (typeof input !== "string" || Array.from(input).length !== 1)
            throw new Error("Invalid native character");
          const code = input.codePointAt(0)!;
          if (code >= 0xd800 && code <= 0xdfff)
            throw new Error("Invalid native character");
          result = unsigned(BigInt(code), 4);
          break;
        }
        if (primitive === 2) {
          if (typeof input !== "string")
            throw new Error("Invalid native string");
          if (!input.isWellFormed())
            throw new Error(
              "Native strings must contain valid Unicode scalar values",
            );
          const bytes = new TextEncoder().encode(input);
          if (bytes.length > NATIVE_RUNTIME_LIMITS.text)
            throw new Error("Native text exceeds work budget");
          result = join([nativeCompact(BigInt(bytes.length)), bytes]);
          break;
        }
        const signed = primitive >= 9,
          width = WIDTHS[primitive - (signed ? 9 : 3)]!,
          bits = BigInt(width * 8);
        let amount = integer(input);
        if (signed) {
          if (amount < -(1n << (bits - 1n)) || amount >= 1n << (bits - 1n))
            throw new Error("Native integer out of range");
          if (amount < 0n) amount += 1n << bits;
        }
        result = unsigned(amount, width);
        break;
      }
    }
    return result;
  };
  return encode(id, value);
}

export function nativeStorageKey(
  metadata: NativeMetadata,
  prefix: string,
  item: NativeStorage,
  args: NativeValue[],
  partial = false,
) {
  const keys =
    item.key === null
      ? []
      : item.hashers.length === 1
        ? [item.key]
        : (() => {
            const type = getType(metadata, item.key!);
            if (type.kind !== "tuple")
              throw new Error("Native multi-map key must be a tuple");
            return type.types;
          })();
  if (
    keys.length !== item.hashers.length ||
    (partial ? args.length > keys.length : args.length !== keys.length)
  )
    throw new Error("Native storage key arity mismatch");
  const parts = keys.slice(0, args.length).map((key, index) => {
    const encoded = encodeNativeValue(metadata, key, args[index]!);
    switch (item.hashers[index]) {
      case 0:
        return blake2b(encoded, { dkLen: 16 });
      case 1:
        return blake2b(encoded, { dkLen: 32 });
      case 2:
        return join([blake2b(encoded, { dkLen: 16 }), encoded]);
      case 3:
        return twox128(encoded);
      case 4:
        return join(
          [0n, 1n, 2n, 3n].map((seed) => unsigned(xxh64(encoded, seed), 8)),
        );
      case 5:
        return twox64Concat(encoded);
      case 6:
        return encoded;
      default:
        throw new Error("Invalid native storage hasher");
    }
  });
  return nativeHex(join([storageMapPrefix(prefix, item.name), ...parts]));
}

/** Recover keys for reversible hashers. Hash-only components remain their
 * exact digest: an irreversible hash must never be presented as an account. */
export function nativeStorageEntryKeys(
  metadata: NativeMetadata,
  prefix: string,
  item: NativeStorage,
  key: string,
): NativeValue[] {
  if (item.key === null)
    throw new Error("Native entries require a storage map");
  const base = nativeHex(storageMapPrefix(prefix, item.name));
  if (!key.startsWith(base))
    throw new Error("Native storage entry has the wrong prefix");
  const reader = new NativeScaleReader(`0x${key.slice(base.length)}`);
  const definition = getType(metadata, item.key);
  const keys =
    item.hashers.length === 1
      ? [item.key]
      : definition.kind === "tuple"
        ? definition.types
        : [];
  if (keys.length !== item.hashers.length)
    throw new Error("Native multi-map key arity mismatch");
  const parts = keys.map((type, index): NativeValue => {
    const hasher = item.hashers[index]!;
    const lengths = [16, 32, 16, 16, 32, 8, 0];
    const length = lengths[hasher];
    if (length === undefined) throw new Error("Invalid native storage hasher");
    const digest = reader.take(length);
    if ([0, 1, 3, 4].includes(hasher))
      return { hash: nativeHex(digest), hasher };
    const offset = reader.offset;
    const value = decodeNativeValue(metadata, type, reader);
    const encoded = reader.bytes.subarray(offset, reader.offset);
    const expected =
      hasher === 2
        ? blake2b(encoded, { dkLen: 16 })
        : hasher === 5
          ? twox64Concat(encoded).subarray(0, 8)
          : digest;
    if (nativeHex(expected) !== nativeHex(digest))
      throw new Error("Native storage key digest mismatch");
    return { value };
  });
  return reader.finish(parts);
}
