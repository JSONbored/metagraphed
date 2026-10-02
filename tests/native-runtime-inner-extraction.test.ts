// Temporary pinned-source extraction; removed after the verified remote handoff.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";
import { TypeRegistry } from "@polkadot/types/create";
import { test } from "vitest";
import eras from "./fixtures/native-runtime-legacy-compiled.ts";
import { sampleNativeValue } from "./fixtures/native-compiled-values.ts";
import { decodeNativeMetadata, unwrapNativeMetadata, type NativeType, type NativeDefinition } from "../src/native-runtime-metadata.ts";
import { encodeNativeValue, nativeHex } from "../src/native-runtime-values.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sourceDownload = promisify(execFile);
const families = {
  DelegateInfoRuntimeApi: "delegate_info",
  NeuronInfoRuntimeApi: "neuron_info",
  SubnetInfoRuntimeApi: "subnet_info",
  StakeInfoRuntimeApi: "stake_info",
};
function block(source: string, start: number) {
  assert.equal(source[start], "{");
  let depth = 1, end = start + 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  assert.equal(depth, 0);
  return source.slice(start + 1, end - 1);
}
function split(source: string, separator = ",") {
  const parts: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < source.length; i++) {
    if ("<([".includes(source[i]!)) depth++;
    if (">)]".includes(source[i]!)) depth--;
    if (source[i] === separator && depth === 0) { parts.push(source.slice(start, i)); start = i + 1; }
  }
  parts.push(source.slice(start));
  return parts.map(row => row.trim()).filter(Boolean);
}
function independent(types: NativeType[]) {
  const registry = new TypeRegistry();
  const ref = (id: number) => `Inner${id}`;
  const fields = (rows: { name: string | null; type: number }[]) => rows.every(row => row.name !== null)
    ? Object.fromEntries(rows.map(row => [row.name!, ref(row.type)]))
    : `(${rows.map(row => ref(row.type)).join(",")}${rows.length === 1 ? "," : ""})`;
  registry.register(Object.fromEntries(types.map(type => {
    const d = type.definition;
    let shape: unknown;
    if (d.kind === "primitive") shape = ["bool", "char", "String", "u8", "u16", "u32", "u64", "u128", "u256", "i8", "i16", "i32", "i64", "i128", "i256"][d.primitive];
    else if (d.kind === "compact") shape = `Compact<${ref(d.type)}>`;
    else if (d.kind === "sequence") shape = `Vec<${ref(d.type)}>`;
    else if (d.kind === "array") shape = `[${ref(d.type)};${d.length}]`;
    else if (d.kind === "tuple") shape = `(${d.types.map(ref).join(",")}${d.types.length === 1 ? "," : ""})`;
    else if (d.kind === "composite") shape = fields(d.fields);
    else if (d.kind === "variant") {
      assert.deepEqual(d.variants.map(row => row.index), d.variants.map((_, index) => index));
      shape = { _enum: Object.fromEntries(d.variants.map(row => [row.name, row.fields.length === 0 ? "Null" : row.fields.length === 1 && row.fields[0]!.name === null ? ref(row.fields[0]!.type) : fields(row.fields)])) };
    } else throw new Error("Unexpected bit layout in legacy inner records");
    return [ref(type.id), shape];
  })) as Parameters<TypeRegistry["register"]>[0]);
  return registry;
}

test("extract all 112 legacy opaque record layouts from exact compiled source and independently check their SCALE", async () => {
  assert.ok(process.env.CI, "Source extraction belongs on authorized remote CI");
  const releases: unknown[] = [];
  for (const era of eras.slice(0, 8)) {
    const sourceFiles = ["runtime/src/lib.rs", ...Object.values(families).map(name => `pallets/subtensor/src/rpc_info/${name}.rs`)];
    const loaded = await Promise.all(sourceFiles.map(async path => {
      const response = await sourceDownload("curl", ["--fail", "--location", "--proto", "=https", "--max-time", "30", "--silent", "--show-error", `https://raw.githubusercontent.com/RaoFoundation/subtensor/${era.commit}/${path}`], { maxBuffer: 1000000, encoding: "buffer", timeout: 35000 });
      const bytes = new Uint8Array(response.stdout); assert.ok(bytes.length < 1000000);
      return { path, sha256: sha(bytes), text: new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "") };
    }));
    const runtime = loaded[0]!.text, bare = unwrapNativeMetadata(era.v15)!;
    const metadata = decodeNativeMetadata(bare);
    const structs = new Map<string, { name: string; type: string }[]>();
    for (const file of loaded.slice(1)) {
      for (const match of file.text.matchAll(/pub\s+struct\s+(\w+)(?:<[^{}]+>)?\s*\{/g)) {
        const body = block(file.text, match.index! + match[0].length - 1);
        const prefix = file.text.slice(Math.max(0, match.index! - 160), match.index!);
        assert.match(prefix, /derive\([^)]*Encode/);
        const fields = split(body).map(row => {
          const field = /^(?:pub\s+)?(\w+)\s*:\s*([\s\S]+)$/.exec(row); assert.ok(field, row);
          return { name: field[1]!, type: field[2]!.replace(/\s+/g, "") };
        });
        assert.ok(!structs.has(match[1]!)); structs.set(match[1]!, fields);
      }
    }
    const types: NativeType[] = [], ids = new Map<string, number>();
    const reserve = (key: string, path: string[], definition: () => NativeDefinition) => {
      const old = ids.get(key); if (old !== undefined) return old;
      const id = types.length; ids.set(key, id); types.push({ id, path, definition: { kind: "tuple", types: [] } });
      types[id]!.definition = definition(); return id;
    };
    const copy = (old: number): number => reserve(`metadata:${old}`, metadata.types.get(old)!.path, () => {
      const d = metadata.types.get(old)!.definition;
      if (d.kind === "primitive") return d;
      if (d.kind === "composite") return { ...d, fields: d.fields.map(field => ({ ...field, type: copy(field.type) })) };
      if (d.kind === "variant") return { ...d, variants: d.variants.map(row => ({ ...row, fields: row.fields.map(field => ({ ...field, type: copy(field.type) })) })) };
      if (d.kind === "tuple") return { ...d, types: d.types.map(copy) };
      if (d.kind === "bits") return { ...d, store: copy(d.store), order: copy(d.order) };
      return { ...d, type: copy(d.type) };
    });
    const resolve = (raw: string): number => {
      const name = raw.replace(/<T>/g, "");
      return reserve(`rust:${name}`, ["subtensor_legacy_inner", name], () => {
        const primitives = ["bool", "char", "String", "u8", "u16", "u32", "u64", "u128", "u256", "i8", "i16", "i32", "i64", "i128", "i256"];
        if (primitives.includes(name)) return { kind: "primitive", primitive: primitives.indexOf(name) };
        const generic = /^(Vec|Compact|Option)<([\s\S]+)>$/.exec(name);
        if (generic) {
          const child = resolve(generic[2]!);
          if (generic[1] === "Option") return { kind: "variant", variants: [{ name: "None", index: 0, fields: [] }, { name: "Some", index: 1, fields: [{ name: null, type: child }] }] };
          return { kind: generic[1] === "Vec" ? "sequence" : "compact", type: child };
        }
        const array = /^\[(.+);(\d+)\]$/.exec(name);
        if (array) return { kind: "array", type: resolve(array[1]!), length: Number(array[2]) };
        if (name.startsWith("(") && name.endsWith(")")) return { kind: "tuple", types: split(name.slice(1, -1)).map(resolve) };
        const fields = structs.get(name);
        if (fields) return { kind: "composite", fields: fields.map(field => ({ name: field.name, type: resolve(field.type) })) };
        const target = name === "T::AccountId" ? "AccountId32" : name;
        const matches = [...metadata.types.values()].filter(type => type.path.at(-1) === target);
        assert.equal(matches.length, 1, `Ambiguous or missing metadata dependency ${target}`);
        return { kind: "composite", fields: [{ name: null, type: copy(matches[0]!.id) }] };
      });
    };
    const methods: { api: string; member: string; root_type: number; empty_is_none: boolean; rust_result: string }[] = [];
    for (const [api, name] of Object.entries(families)) {
      const file = loaded.find(row => row.path.endsWith(`/${name}.rs`))!;
      const apiStart = new RegExp(`impl[^{}]*${api}[^{}]*for Runtime\\s*\\{`).exec(runtime); assert.ok(apiStart, api);
      const apiBody = block(runtime, apiStart.index + apiStart[0].length - 1);
      for (const method of metadata.apis.find(row => row.name === api)!.methods) {
        const signature = new RegExp(`pub\\s+fn\\s+${method.name}\\s*\\([^{}]*?\\)\\s*->\\s*([^{}]+)\\{`).exec(file.text); assert.ok(signature, `${api}_${method.name}`);
        const runtimeMethod = new RegExp(`fn\\s+${method.name}\\s*\\([^{}]*?\\)\\s*->\\s*Vec<u8>\\s*\\{`).exec(apiBody); assert.ok(runtimeMethod);
        const body = block(apiBody, runtimeMethod.index + runtimeMethod[0].length - 1); assert.match(body, /\.encode\(\)/);
        const rust = signature[1]!.replace(/\s+/g, "");
        const nullable = /^Option<([\s\S]+)>$/.exec(rust);
        if (nullable) assert.match(body, /vec!\[\]/);
        methods.push({ api, member: method.name, root_type: resolve(nullable ? nullable[1]! : rust), empty_is_none: !!nullable, rust_result: rust });
      }
    }
    assert.equal(methods.length, 14); assert.ok(types.length < 256);
    const inner = { ...metadata, types: new Map(types.map(type => [type.id, type])) }, registry = independent(types);
    for (const method of methods) {
      const encoded = encodeNativeValue(inner, method.root_type, sampleNativeValue(inner, method.root_type));
      const check = registry.createTypeUnsafe(`Inner${method.root_type}`, [encoded]);
      assert.equal(check.encodedLength, encoded.length); assert.equal(nativeHex(check.toU8a()), nativeHex(encoded));
    }
    releases.push({ spec: era.spec, commit: era.commit, metadata_sha256: [sha(Buffer.from(unwrapNativeMetadata(era.v14)!.slice(2), "hex")), sha(Buffer.from(bare.slice(2), "hex"))], files: loaded.map(({ path, sha256 }) => ({ path, sha256 })), types, methods });
    console.log("NATIVE_INNER_SOURCE_ERA", JSON.stringify({ spec: era.spec, commit: era.commit, methods: methods.length, types: types.length, fixture: true, production: false }));
  }
  const path = "src/native-runtime-inner-catalogue.ts";
  const body = `// Source-derived inner SCALE records from eight published compiled runtimes.\n// Generated and independently qualified on remote CI.\nimport type { NativeType } from "./native-runtime-metadata.ts";\nexport interface NativeRuntimeInnerRelease {\n spec: number; commit: string; metadata_sha256: string[];\n files: {path:string;sha256:string}[]; types: NativeType[];\n methods: {api:string;member:string;root_type:number;empty_is_none:boolean;rust_result:string}[];\n}\nexport const nativeRuntimeInnerCatalogue: NativeRuntimeInnerRelease[] = ${JSON.stringify(releases)};\n`;
  const bytes = Buffer.from(await format(body, { ...(await resolveConfig(path)), filepath: path })); writeFileSync(path, bytes);
  console.log("NATIVE_INNER_SOURCE_FILE", JSON.stringify({ path, bytes: bytes.length, sha256: sha(bytes), encoding: "gzip-base64" }));
  const encoded = gzipSync(bytes).toString("base64");
  for (let offset = 0; offset < encoded.length; offset += 16000) console.log("NATIVE_INNER_SOURCE_CHUNK", JSON.stringify({ index: offset / 16000, data: encoded.slice(offset, offset + 16000) }));
}, 180000);
