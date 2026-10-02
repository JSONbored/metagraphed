import { evmRuntimeCatalogue as catalogue } from "./evm-runtime-catalogue.ts";
import { evmRuntimeOutputs } from "./evm-runtime-outputs.ts";

function releaseAt(spec: number) {
  const release = catalogue.releases.find((row) => row[0] === spec);
  if (!release)
    throw new Error("EVM ABI is not qualified for this runtime source");
  return release;
}
function precompileAt(
  release: (typeof catalogue.releases)[number],
  to: string,
) {
  const index = /^0x0{36}[0-9a-f]{4}$/.test(to)
    ? Number.parseInt(to.slice(-4), 16)
    : -1;
  const id = release[2].find((id) => catalogue.precompiles[id][1] === index);
  if (id === undefined)
    throw new Error("Unknown EVM precompile at this source");
  return id;
}
function outputsAt(release: (typeof catalogue.releases)[number], precompile: number, fn: number) {
  const source = evmRuntimeOutputs.releases.find(row => row[0] === release[0] && row[1] === release[1])!;
  const bindingId = source[2].find(id => evmRuntimeOutputs.bindings[id][0] === precompile)!;
  const binding = evmRuntimeOutputs.bindings[bindingId];
  return evmRuntimeOutputs.outputs[binding[1].find(row => row[0] === fn)![1]];
}
const argumentTypes = (signature: string) =>
  signature
    .slice(signature.indexOf("(") + 1, -1)
    .split(",")
    .filter(Boolean);

/** Page only the selected release/address. The shared catalogue stays on the
 * server; clients need neither its full ABI nor a separate selector registry. */
export function describeRuntimeEvm(
  spec: number,
  to: true | string,
  offset: number,
  limit: number,
) {
  const release = releaseAt(spec);
  const precompileId = to === true ? null : precompileAt(release, to);
  const precompile = precompileId === null ? null : catalogue.precompiles[precompileId];
  const ids = precompile ? precompile[2] : release[2];
  const value = ids.slice(offset, offset + limit).map((id) => {
    if (precompile) {
      const fn = catalogue.functions[id];
      return {
        kind: "evm_function",
        signature: fn[0],
        selector: fn[2],
        args: argumentTypes(fn[0]).map((type, i) => ({ name: fn[1][i], type })),
        outputs: outputsAt(release, precompileId!, id),
      };
    }
    const row = catalogue.precompiles[id];
    return {
      kind: "evm_precompile",
      name: row[0],
      address: `0x${row[1].toString(16).padStart(40, "0")}`,
      functions: row[2].length,
    };
  });
  return {
    value,
    contract: {
      encoding: "solidity-abi",
      source_commit: release[1],
      total: ids.length,
      next_offset: offset + limit < ids.length ? offset + limit : null,
    },
  };
}

/** Encode only release-qualified signatures. Count every output word and byte
 * before allocation; the byte budget also bounds recursive array work. */
export function encodeRuntimeEvmCall(
  spec: number,
  to: string,
  signature: string,
  values: unknown[],
) {
  const release = releaseAt(spec);
  const precompileId = precompileAt(release, to);
  const precompile = catalogue.precompiles[precompileId];
  const id = precompile[2].find(
    (id) => catalogue.functions[id][0] === signature,
  );
  if (id === undefined) throw new Error("Unknown EVM signature at this source");
  const fn = catalogue.functions[id];
  let bytes = 4;
  function reserve(size: number) {
    bytes += size;
    if (bytes > 32768) throw new Error("EVM calldata exceeds byte budget");
  }
  function word(value: bigint) {
    reserve(32);
    return Buffer.from(value.toString(16).padStart(64, "0"), "hex");
  }
  const dynamic = (type: string) =>
    type.endsWith("[]") || type === "bytes" || type === "string";
  function tuple(types: string[], args: unknown[], repeat = false): Buffer {
    if (!repeat && types.length !== args.length)
      throw new Error("EVM argument arity mismatch");
    const heads: Buffer[] = [],
      tails: Buffer[] = [];
    let tail = args.length * 32;
    for (let i = 0; i < args.length; i++) {
      const type = types[repeat ? 0 : i]!,
        value = args[i];
      if (dynamic(type)) {
        heads.push(word(BigInt(tail)));
        const encoded = encode(type, value);
        tails.push(encoded);
        tail += encoded.length;
      } else heads.push(encode(type, value));
    }
    return Buffer.concat([...heads, ...tails]);
  }
  function encode(type: string, value: unknown): Buffer {
    if (type.endsWith("[]")) {
      if (!Array.isArray(value))
        throw new Error("EVM array argument must be an array");
      if (value.length > 4096)
        throw new Error("EVM arguments exceed work budget");
      return Buffer.concat([
        word(BigInt(value.length)),
        tuple([type.slice(0, -2)], value, true),
      ]);
    }
    if (type === "bytes" || type === "string") {
      if (typeof value !== "string")
        throw new Error("EVM bytes/string argument must be a string");
      let length: number;
      if (type === "bytes") {
        if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value))
          throw new Error("EVM bytes must be even-length hex");
        length = (value.length - 2) / 2;
      } else {
        if (!value.isWellFormed())
          throw new Error("EVM string contains an unpaired surrogate");
        length = Buffer.byteLength(value);
      }
      const prefix = word(BigInt(length));
      const padded = Math.ceil(length / 32) * 32;
      reserve(padded);
      const body = Buffer.alloc(padded);
      if (type === "bytes") body.write(value.slice(2), 0, "hex");
      else body.write(value, 0, "utf8");
      return Buffer.concat([prefix, body]);
    }
    if (type === "bool") {
      if (typeof value !== "boolean")
        throw new Error("EVM bool argument must be boolean");
      return word(value ? 1n : 0n);
    }
    if (type === "address") {
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
        throw new Error("EVM address must be 20-byte hex");
      return word(BigInt(value));
    }
    const fixed = /^bytes(\d+)$/.exec(type);
    if (fixed) {
      const length = Number(fixed[1]);
      if (
        typeof value !== "string" ||
        !new RegExp(`^0x[0-9a-fA-F]{${length * 2}}$`).test(value)
      )
        throw new Error("EVM fixed bytes length mismatch");
      reserve(32);
      return Buffer.from(value.slice(2).padEnd(64, "0"), "hex");
    }
    if (
      (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    )
      throw new Error("EVM integer must be an exact nonnegative decimal");
    const integer = BigInt(value as string | number);
    if (integer >= 1n << BigInt(type.slice(4)))
      throw new Error("EVM integer exceeds its declared width");
    return word(integer);
  }
  const data = tuple(argumentTypes(signature), values);
  return {
    input: `${fn[2]}${data.toString("hex")}`,
    precompile: precompile[0],
    address: to,
    signature,
    selector: fn[2],
    source_commit: release[1],
    outputs: outputsAt(release, precompileId, id),
  };
}
