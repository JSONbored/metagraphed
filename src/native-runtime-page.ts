import type { z } from "zod";
import type { NativeValuePageRequestSchema } from "../schemas-src/routes/native-runtime.ts";
import {
  NativeScaleReader,
  NATIVE_RUNTIME_LIMITS,
  type NativeMetadata,
  type NativeField,
} from "./native-runtime-metadata.ts";
import {
  nativeHex,
  nativeUnsignedWidth,
  nativeValueReader,
  type NativeValue,
} from "./native-runtime-values.ts";

type Page = z.infer<typeof NativeValuePageRequestSchema>;
type Walk = { depth: number } & (
  | { kind: "target"; id: number; element: number; length: number | null }
  | { kind: "fields"; fields: NativeField[]; index: number; next: Walk }
  | { kind: "variant"; index: number; next: Walk }
  | { kind: "index"; element: number; length: number | null; index: number; next: Walk }
);

/** Resolve the projection against the source contract before execution. A page
 * retains one bounded collection, while every other byte is still validated.
 * Fixed-width integers/bytes can be skipped in bulk without constructing values. */
export function planNativeValuePage(metadata: NativeMetadata, root: number, page: Page) {
  const type = (id: number) => {
    const found = metadata.types.get(id);
    if (!found) throw new Error("Missing native portable type");
    return found.definition;
  };
  const depthGuard = (depth: number) => {
    if (depth > NATIVE_RUNTIME_LIMITS.depth)
      throw new Error("Native page path exceeds depth budget");
  };
  const fields = (rows: NativeField[], pos: number, depth: number, transparent = true): Walk => {
    depthGuard(depth);
    if (transparent && rows.length === 1 && rows[0]!.name === null)
      return compile(rows[0]!.type, pos, depth + 1);
    const segment = page.path[pos];
    const index = rows.every((row) => row.name !== null)
      ? rows.findLastIndex((row) => row.name === segment)
      : typeof segment === "number" ? segment : -1;
    if (index < 0 || index >= rows.length)
      throw new Error("Native page path does not select a field");
    return { depth, kind: "fields", fields: rows, index, next: compile(rows[index]!.type, pos + 1, depth + 1) };
  };
  const compile = (id: number, pos: number, depth: number): Walk => {
    depthGuard(depth);
    const d = type(id);
    if (d.kind === "sequence" || d.kind === "array") {
      const length = d.kind === "array" ? d.length : null;
      if (pos === page.path.length)
        return { depth, kind: "target", id, element: d.type, length };
      const index = page.path[pos];
      if (typeof index !== "number" || (length !== null && index >= length))
        throw new Error("Native page path requires a collection index");
      return { depth, kind: "index", index, element: d.type, length, next: compile(d.type, pos + 1, depth + 1) };
    }
    if (d.kind === "composite") return fields(d.fields, pos, depth);
    if (d.kind === "tuple")
      return fields(d.types.map((id) => ({ name: null, type: id })), pos, depth, false);
    if (d.kind === "variant") {
      const variant = d.variants.find((row) => row.name === page.path[pos]);
      if (!variant) throw new Error("Native page path requires an enum variant");
      return { depth, kind: "variant", index: variant.index, next: fields(variant.fields, pos + 1, depth) };
    }
    throw new Error("Native page path must select a sequence or array");
  };
  const walk = compile(root, 0, 0);
  const widths = new Map<number, { width: number | null; height: number }>();
  const fixedWidth = (id: number, depth = 0): number | null => {
    depthGuard(depth);
    const cached = widths.get(id);
    if (cached) {
      if (cached.width !== null) depthGuard(depth + cached.height);
      return cached.width;
    }
    const d = type(id);
    widths.set(id, { width: null, height: 0 }); // recursive layouts require ordinary bounded traversal
    let width: number | null = null;
    let height = 0;
    if (d.kind === "primitive" && d.primitive >= 3)
      width = 2 ** (d.primitive - (d.primitive >= 9 ? 9 : 3));
    else if (d.kind === "composite" || d.kind === "tuple") {
      const ids = d.kind === "composite" ? d.fields.map((row) => row.type) : d.types;
      const children = ids.map((next) => fixedWidth(next, depth + 1));
      if (children.every((size) => size !== null)) {
        width = children.reduce<number>((total, size) => total + size!, 0);
        height = ids.length === 0 ? 0 : 1 + Math.max(...ids.map((id) => widths.get(id)!.height));
      }
    } else if (d.kind === "array") {
      const element = type(d.type);
      const max = element.kind === "primitive" && element.primitive === 3
        ? NATIVE_RUNTIME_LIMITS.valueBytes : NATIVE_RUNTIME_LIMITS.items;
      const child = fixedWidth(d.type, depth + 1);
      if (d.length <= max && child !== null) {
        width = d.length * child;
        height = 1 + widths.get(d.type)!.height;
      }
    }
    widths.set(id, { width, height });
    return width;
  };
  return {
    decode(hex: unknown) {
      const partial = hex instanceof NativeScaleReader;
      const reader = partial ? hex : new NativeScaleReader(hex);
      const read = nativeValueReader(metadata, reader, 1);
      let validations = 0;
      const guard = (depth: number) => {
        depthGuard(depth);
        // This separate traversal bound does not enlarge the retained-value
        // budget. Zero-sized/nested layouts cannot cause unbounded work.
        if (++validations > NATIVE_RUNTIME_LIMITS.valueBytes * 4)
          throw new Error("Native page validation exceeds work budget");
      };
      const count = (element: number, length: number | null) => {
        const d = type(element);
        const raw = d.kind === "primitive" && d.primitive === 3;
        const max = raw ? NATIVE_RUNTIME_LIMITS.valueBytes : NATIVE_RUNTIME_LIMITS.items;
        const total = length ?? reader.count(max);
        if (total > max) throw new Error("Native collection exceeds work budget");
        return { total, raw };
      };
      const skipMany = (id: number, count: number, depth: number) => {
        if (count === 0) return;
        guard(depth);
        const width = fixedWidth(id, depth);
        if (width !== null) reader.take(width * count);
        else for (let remaining = count; remaining > 0; remaining--) skip(id, depth);
      };
      const skip = (id: number, depth: number): void => {
        guard(depth);
        const width = fixedWidth(id, depth);
        if (width !== null) { reader.take(width); return; }
        const d = type(id);
        switch (d.kind) {
          case "composite":
            for (const row of d.fields) skip(row.type, depth + 1);
            return;
          case "tuple":
            for (const id of d.types) skip(id, depth + 1);
            return;
          case "variant": {
            const tag = reader.byte();
            const variant = d.variants.find((row) => row.index === tag);
            if (!variant) throw new Error("Invalid native enum variant");
            for (const row of variant.fields) skip(row.type, depth + 1);
            return;
          }
          case "array":
          case "sequence": {
            const { total } = count(d.type, d.kind === "array" ? d.length : null);
            skipMany(d.type, total, depth + 1);
            return;
          }
          case "compact":
            if (reader.compact() >= 1n << BigInt(nativeUnsignedWidth(metadata, d.type) * 8))
              throw new Error("Native compact integer out of range");
            return;
          case "bits": {
            const length = reader.count();
            const width = nativeUnsignedWidth(metadata, d.store);
            if (width > 8) throw new Error("Invalid native bit storage width");
            reader.take(Math.ceil(length / (width * 8)) * width);
            return;
          }
          case "primitive":
            if (d.primitive === 0) {
              if (reader.byte() > 1) throw new Error("Invalid native boolean");
            } else if (d.primitive === 1) {
              const code = Number(reader.uint(4));
              if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
                throw new Error("Invalid native character");
            } else reader.text();
        }
      };
      type Result = { value: NativeValue; value_page: Page & {
        total: number; next_offset: number | null;
        collection_type: number; element_type: number; value_encoding: "hex" | "items";
      } };
      const select = (step: Walk): Result => {
        const depth = step.depth;
        guard(depth);
        if (step.kind === "fields") {
          let result: Result | undefined;
          step.fields.forEach((row, index) => {
            if (index === step.index) result = select(step.next);
            else skip(row.type, depth + 1);
          });
          return result!;
        }
        if (step.kind === "variant") {
          if (reader.byte() !== step.index)
            throw new Error("Native page path is absent in the returned variant");
          return select(step.next);
        }
        const { total, raw } = count(step.element, step.length);
        if (step.kind === "index") {
          if (step.index >= total)
            throw new Error("Native page path collection index is absent");
          skipMany(step.element, step.index, depth + 1);
          const result = select(step.next);
          skipMany(step.element, total - step.index - 1, depth + 1);
          return result;
        }
        if (page.offset > total) throw new Error("Native page offset exceeds collection length");
        const size = Math.min(page.limit, total - page.offset);
        let value: NativeValue;
        if (raw) {
          const bytes = reader.take(total);
          value = nativeHex(bytes.subarray(page.offset, page.offset + size));
        } else {
          skipMany(step.element, page.offset, depth + 1);
          value = Array.from({ length: size }, () => read(step.element, depth + 1));
          skipMany(step.element, total - page.offset - size, depth + 1);
        }
        const next = page.offset + size;
        return { value, value_page: { ...page, total,
          next_offset: next === total ? null : next,
          collection_type: step.id, element_type: step.element,
          value_encoding: raw ? "hex" : "items",
        } };
      };
      const result = select(walk);
      return partial ? result : reader.finish(result);
    },
  };
}
