import { nativeRuntimeInnerCatalogue } from "./native-runtime-inner-catalogue.ts";
import {
  NativeScaleReader,
  NATIVE_RUNTIME_LIMITS,
  type NativeMetadata,
  type NativeType,
} from "./native-runtime-metadata.ts";
import { decodeNativeValue } from "./native-runtime-values.ts";
import { planNativeValuePage } from "./native-runtime-page.ts";

/** The outer Vec<u8> is metadata-defined. Its source-derived record layout is
 * admitted only for the exact published metadata, never for a version label. */
export function nativeInnerRecord(
  metadata: NativeMetadata,
  spec: number,
  metadataSha: string,
  api: string,
  member: string,
) {
  const release = nativeRuntimeInnerCatalogue.find(
    (row) =>
      row.spec === spec &&
      row.metadata_sha256.some((sha) => metadataSha === `0x${sha}`),
  );
  const method = release?.methods.find(
    (row) => row.api === api && row.member === member,
  );
  if (!release || !method)
    throw new Error(
      "Inner SCALE decoding requires a source-qualified opaque record method",
    );
  const model = {
    ...metadata,
    types: new Map(release.types.map((type) => [type.id, type])),
  };
  const needed = new Map<number, NativeType>(),
    pending = [method.root_type];
  while (pending.length) {
    const id = pending.pop()!;
    if (needed.has(id)) continue;
    const type = model.types.get(id)!;
    needed.set(id, type);
    const d = type.definition;
    if (d.kind === "composite")
      pending.push(...d.fields.map((field) => field.type));
    else if (d.kind === "variant")
      pending.push(
        ...d.variants.flatMap((row) => row.fields.map((field) => field.type)),
      );
    else if (d.kind === "tuple") pending.push(...d.types);
    else if (d.kind === "bits") pending.push(d.store, d.order);
    else if (d.kind !== "primitive") pending.push(d.type);
  }
  const readInner = <T>(
    value: unknown,
    outer: boolean,
    decode: (hex: unknown) => T,
  ): T | null => {
    if (outer) {
      const reader = new NativeScaleReader(value);
      const length = reader.count(NATIVE_RUNTIME_LIMITS.valueBytes),
        start = reader.offset;
      reader.take(length);
      reader.finish(undefined);
      reader.offset = start;
      return reader.finish(
        method.empty_is_none && length === 0 ? null : decode(reader),
      );
    }
    if (method.empty_is_none && value === "0x") return null;
    return decode(value);
  };
  return {
    contract: {
      encoding: "scale",
      outer_encoding: "Vec<u8>",
      source_commit: release.commit,
      metadata_sha256: metadataSha,
      rust_result: method.rust_result,
      empty_is_none: method.empty_is_none,
      root_type: method.root_type,
      types: [...needed.values()],
    },
    decode(value: unknown, outer = false) {
      return readInner(value, outer, (hex) =>
        decodeNativeValue(model, method.root_type, hex),
      );
    },
    page(request: Parameters<typeof planNativeValuePage>[2]) {
      const planned = planNativeValuePage(model, method.root_type, request);
      return {
        decode(value: unknown, outer = false) {
          return readInner(value, outer, planned.decode);
        },
      };
    },
  };
}
