import assert from "node:assert/strict";
import type { NativeMetadata } from "../../src/native-runtime-metadata.ts";
import type { NativeValue } from "../../src/native-runtime-values.ts";

export class UninhabitedType extends Error {
  constructor(readonly id: number) {
    super(`Uninhabited compiled type ${id}`);
  }
}

// Synthetic ABI values only. No storage, execution or transaction is implied.
export function sampleNativeValue(
  model: NativeMetadata,
  id: number,
  depth = 0,
): NativeValue {
  assert.ok(depth < 32, `Unexpected recursive sample type ${id}`);
  const type = model.types.get(id)!.definition;
  const child = (next: number) => sampleNativeValue(model, next, depth + 1);
  const fields = (
    rows: { name: string | null; type: number }[],
  ): NativeValue => {
    if (rows.length === 1 && rows[0]!.name === null)
      return child(rows[0]!.type);
    if (rows.every((row) => row.name !== null))
      return Object.fromEntries(
        rows.map((row) => [row.name!, child(row.type)]),
      );
    return rows.map((row) => child(row.type));
  };
  switch (type.kind) {
    case "primitive":
      return type.primitive === 0
        ? false
        : type.primitive === 1
          ? "A"
          : type.primitive === 2
            ? ""
            : "0";
    case "compact":
      return "0";
    case "bits":
      return { bit_length: 0, bytes_hex: "0x" };
    case "sequence":
      return [];
    case "array": {
      const element = model.types.get(type.type)!.definition;
      return element.kind === "primitive" && element.primitive === 3
        ? `0x${"00".repeat(type.length)}`
        : Array.from({ length: type.length }, () => child(type.type));
    }
    case "tuple":
      return type.types.map(child);
    case "composite":
      return fields(type.fields);
    case "variant": {
      const variants = [...type.variants].sort(
        (a, b) => Number(b.name === "None") - Number(a.name === "None"),
      );
      for (const variant of variants) {
        try {
          return { variant: variant.name, fields: fields(variant.fields) };
        } catch (error) {
          if (!(error instanceof UninhabitedType)) throw error;
        }
      }
      throw new UninhabitedType(id);
    }
  }
}
