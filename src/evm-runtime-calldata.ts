import { evmRuntimeCatalogue } from "./evm-runtime-catalogue.ts";
import type { DecodeEvmCallOutput } from "../schemas-src/mcp-tools/evm.ts";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The release catalogue contains scalar words, bytes/string and nested dynamic
// arrays. Offsets are relative to the containing tuple, including array heads.
// Reject noncanonical scalar/padding values and truncated tails as a whole.
function decodeArguments(signature: string, names: string[], input: string) {
  const types = signature
    .slice(signature.indexOf("(") + 1, -1)
    .split(",")
    .filter(Boolean);
  const hex = input.slice(10).toLowerCase();
  if (hex.length > 65536) return null;
  const size = hex.length / 2;
  function word(offset: number): string | null {
    return offset + 32 <= size
      ? hex.slice(offset * 2, (offset + 32) * 2)
      : null;
  }
  function bounded(value: string): number | null {
    const integer = BigInt(`0x${value}`);
    return integer <= BigInt(size) ? Number(integer) : null;
  }
  function decode(
    type: string,
    head: number,
    base: number,
    headSize: number,
  ): unknown {
    const value = word(head);
    if (value === null) return null;
    if (type.endsWith("[]") || type === "bytes" || type === "string") {
      const relative = bounded(value);
      if (relative === null || relative % 32 !== 0 || relative < headSize)
        return null;
      const tail = base + relative;
      const lengthWord = word(tail);
      if (lengthWord === null) return null;
      const length = bounded(lengthWord);
      if (length === null) return null;
      const start = tail + 32;
      if (type.endsWith("[]")) {
        if (start + length * 32 > size) return null;
        const items: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const item = decode(
            type.slice(0, -2),
            start + index * 32,
            start,
            length * 32,
          );
          if (item === null) return null;
          items.push(item);
        }
        return items;
      }
      const paddedEnd = start + Math.ceil(length / 32) * 32;
      if (
        paddedEnd > size ||
        !/^0*$/.test(hex.slice((start + length) * 2, paddedEnd * 2))
      )
        return null;
      const data = hex.slice(start * 2, (start + length) * 2);
      if (type === "bytes") return `0x${data}`;
      try {
        return utf8.decode(Buffer.from(data, "hex"));
      } catch {
        return null;
      }
    }
    if (type === "address")
      return /^0{24}/.test(value) ? `0x${value.slice(24)}` : null;
    if (type === "bool")
      return /^0{63}[01]$/.test(value) ? value.endsWith("1") : null;
    const fixed = /^bytes(\d+)$/.exec(type);
    if (fixed) {
      const end = Number(fixed[1]) * 2;
      return /^0*$/.test(value.slice(end)) ? `0x${value.slice(0, end)}` : null;
    }
    const bits = Number(type.slice(4));
    const integer = BigInt(`0x${value}`);
    if (integer >= 1n << BigInt(bits)) return null;
    return bits <= 32 ? Number(integer) : integer.toString();
  }
  const entries: [string, unknown][] = [];
  for (let index = 0; index < types.length; index += 1) {
    const value = decode(types[index], index * 32, 0, types.length * 32);
    if (value === null) return null;
    entries.push([names[index], value]);
  }
  return Object.fromEntries(entries);
}

// This public, explicitly versioned decoder is separate from the protected
// captured-history decoder. Omitted MCP versions continue to use that decoder.
// Selectors are already reference-verified in the catalogue, so requests do no
// hashing or construction of a second registry.
export function decodeRuntimeEvmCall(
  spec: number,
  to: string,
  input: string,
): DecodeEvmCallOutput | undefined {
  const release = evmRuntimeCatalogue.releases.find((row) => row[0] === spec);
  if (!release) return undefined;
  const source = { runtime_spec_version: spec, source_commit: release[1] };
  const address = to.toLowerCase();
  // Every audited reserved address fits u16. Compare its numeric suffix once,
  // instead of allocating a padded address string for every candidate entry.
  const index = /^0x0{36}[0-9a-f]{4}$/.test(address)
    ? Number.parseInt(address.slice(-4), 16)
    : null;
  const precompileId = release[2].find(
    (id) => evmRuntimeCatalogue.precompiles[id][1] === index,
  );
  if (precompileId === undefined)
    return { precompile: null, address: null, function: null, ...source };
  const precompile = evmRuntimeCatalogue.precompiles[precompileId];
  const identified = {
    precompile: precompile[0],
    address,
    function: null,
    ...source,
  };
  if (!/^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*$/.test(input)) return identified;
  const selector = input.slice(0, 10).toLowerCase();
  const functionId = precompile[2].find(
    (id) => evmRuntimeCatalogue.functions[id][2] === selector,
  );
  if (functionId === undefined) return identified;
  const fn = evmRuntimeCatalogue.functions[functionId];
  return {
    ...identified,
    function: fn[0].slice(0, fn[0].indexOf("(")),
    signature: fn[0],
    args: decodeArguments(fn[0], fn[1], input),
  };
}
