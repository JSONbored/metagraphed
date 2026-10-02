// Temporary remote published-release qualification and exact byte handoff.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { test } from "vitest";
import { decompress } from "fzstd";
import { TypeRegistry } from "@polkadot/types/create";
import { format, resolveConfig } from "prettier";
import { decodeNativeMetadata, unwrapNativeMetadata } from "../src/native-runtime-metadata.ts";
import eras, { type CompiledRuntimeEra } from "./fixtures/native-runtime-eras-compiled.ts";
import { evmRuntimeCatalogue as inputs } from "../src/evm-runtime-catalogue.ts";
import { evmRuntimeOutputs as outputs } from "../src/evm-runtime-outputs.ts";
import inputReference from "./fixtures/evm-runtime-reference.ts";
import outputReference from "./fixtures/evm-runtime-output-reference.ts";

function download(url: string, maxBuffer: number) {
  return execFileSync("curl", ["--fail", "--location", "--max-time", "30", "--silent", "--show-error", url], { maxBuffer });
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);
async function sourceBytes(url: string) {
  return (await run("curl", ["--fail", "--location", "--max-time", "30", "--silent", "--show-error", url], {maxBuffer:500000, encoding:"buffer", timeout:35000})).stdout;
}

async function extract(spec: number, commit: string) {
  const base = `https://github.com/RaoFoundation/subtensor/releases/download/v${spec}`;
  const manifest = JSON.parse(download(`${base}/upgrade-manifest.json`, 32768).toString());
  assert.equal(manifest.tag, `v${spec}`);
  assert.equal(manifest.spec_version, spec);
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.assets.wasm, `${base}/subtensor.wasm`);
  const blob = download(`${base}/subtensor.wasm`, 8 * 1024 * 1024);
  assert.equal(`0x${digest(blob)}`, manifest.wasm_sha256);
  assert.ok(blob.subarray(0, 8).equals(Buffer.from([82, 188, 83, 118, 70, 219, 142, 5])));
  const wasm = decompress(blob.subarray(8));
  assert.ok(wasm.length < 50 * 1024 * 1024);
  const module = await WebAssembly.compile(wasm);
  const initialMemory = new WebAssembly.Memory({ initial: 64, maximum: 2048 });
  let memory = initialMemory;
  let heap = 0;
  const malloc = (bytes: number) => {
    if (heap === 0) {
      const base = instance.exports.__heap_base;
      assert.ok(base instanceof WebAssembly.Global);
      heap = Number(base.value);
    }
    // Substrate RuntimeAllocator requires the host's eight-byte header.
    const ptr = Math.ceil(heap / 8) * 8 + 8;
    heap = ptr + Math.max(bytes, 8);
    if (heap > memory.buffer.byteLength) memory.grow(Math.ceil((heap - memory.buffer.byteLength) / 65536));
    return ptr;
  };
  const hostCalls: Record<string, number> = {};
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const item of WebAssembly.Module.imports(module)) {
    const group = imports[item.module] ??= {};
    if (item.kind === "memory") group[item.name] = initialMemory;
    else if (item.kind === "function") group[item.name] = (...args: (number | bigint)[]) => {
      hostCalls[item.name] = (hostCalls[item.name] ?? 0) + 1;
      if (item.name === "ext_allocator_malloc_version_1") return malloc(Number(args[0]));
      if (item.name === "ext_allocator_free_version_1") return;
      if (item.name === "ext_logging_max_level_version_1") return 0;
      throw new Error(`Unexpected compiled metadata host call v${spec}: ${item.name}`);
    };
    else throw new Error(`Unsupported metadata import: ${item.kind} ${item.name}`);
  }
  const instance = await WebAssembly.instantiate(module, imports);
  if (instance.exports.memory instanceof WebAssembly.Memory) memory = instance.exports.memory;
  const ptr = malloc(4);
  const invoke = (name: string, bytes: number) => {
    const call = instance.exports[name];
    assert.equal(typeof call, "function");
    const packed = BigInt((call as CallableFunction)(ptr, bytes));
    return Buffer.from(new Uint8Array(memory.buffer, Number(packed & 0xffffffffn), Number(packed >> 32n)));
  };
  const runtimeVersion = new TypeRegistry().createType("RuntimeVersion", invoke("Core_version", 0)).toJSON();
  assert.equal((runtimeVersion as { specVersion: number }).specVersion, spec);
  const metadata: Record<string, string> = {};
  for (const version of [14, 15]) {
    new DataView(memory.buffer).setUint32(ptr, version, true);
    const bytes = invoke("Metadata_metadata_at_version", 4);
    assert.ok(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024);
    const wrapped = `0x${bytes.toString("hex")}`;
    const model = decodeNativeMetadata(unwrapNativeMetadata(wrapped)!);
    assert.equal(model.version, version);
    metadata[`v${version}`] = wrapped;
    metadata[`v${version}_sha256`] = digest(bytes);
    console.log("NATIVE_RELEASE_METADATA", JSON.stringify({ spec, version, commit, wasm_sha256: digest(blob), metadata_bytes: bytes.length, metadata_sha256: digest(bytes), types: model.types.size, pallets: model.pallets.length, apis: model.apis.length, fixture: true, production: false }));
  }
  console.log("NATIVE_RELEASE_METADATA_HOSTS", JSON.stringify({ spec, hostCalls }));
  return { spec, commit, wasm_sha256: digest(blob), runtimeVersion, ...metadata };
}


function fixtureSource(path: string, value: unknown) {
  const original = readFileSync(path, "utf8");
  const prefix = original.slice(0, original.indexOf("const compressed"));
  const tail = original.slice(original.indexOf("export default"));
  assert.ok(prefix.includes('import { brotliDecompressSync }'));
  assert.ok(tail.includes('JSON.parse(brotliDecompressSync'));
  const data = brotliCompressSync(Buffer.from(JSON.stringify(value)), {params: {[constants.BROTLI_PARAM_QUALITY]: 6, [constants.BROTLI_PARAM_LGWIN]:24}}).toString("base64");
  return `${prefix.replace("v430–v470", "v430–v471")}const compressed = [${data.match(/.{1,120}/g)!.map(part => JSON.stringify(part)).join(",")}].join("");\n${tail}`;
}
function tableSource(path: string, value: unknown) {
  const original = readFileSync(path, "utf8"), start = original.indexOf(" = {");
  assert.ok(start >= 0);
  return `${original.slice(0, start)} = ${JSON.stringify(value)};\n`;
}

test("qualify published v471 metadata, identical input/return sources and basket layouts", async () => {
  if (!process.env.CI) return;
  const head = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  const commit = "c004cebf360f4088187ee49d851dfb1a1eaaf710";
  const extracted = await extract(471, commit);
  assert.equal(extracted.wasm_sha256, "04385dd7ddda37d4f70cd59a0e8360227165a4aefead0203c47adea5fc4b4aeb");
  const current = eras.find(row => row.spec === 470)!;
  assert.deepEqual(extracted.runtimeVersion, {...current.runtimeVersion, specVersion:471});
  const next = extracted as unknown as CompiledRuntimeEra;
  const projection = (era: CompiledRuntimeEra, version:14|15) => {
    const model = decodeNativeMetadata(unwrapNativeMetadata(era[`v${version}`])!);
    return {...model, types:[...model.types.values()], pallets:model.pallets.map(pallet => ({...pallet, constants:pallet.constants.map(constant => pallet.name === "System" && constant.name === "Version" ? {...constant,value:"runtime-version"}:constant)}))};
  };
  for(const version of [14,15] as const) assert.deepEqual(projection(next,version),projection(current,version));
  const inputManifest = inputReference.manifests.find(row=>row.spec===470)!;
  const outputManifest = outputReference.manifests.find(row=>row.spec===470)!;
  const files = new Map([...inputManifest.files, ...outputManifest.files]);
  const entries = [...files];
  for (let offset = 0; offset < entries.length; offset += 4) {
    await Promise.all(entries.slice(offset,offset+4).map(async ([name,sha]) => {
      assert.match(name, /^[A-Za-z0-9_/.]+$/);
      const path = name === "codec/mod.rs" ? `vendor/frontier/precompiles/src/solidity/${name}` : name.endsWith(".abi") ? `precompiles/src/solidity/${name}` : `precompiles/src/${name}`;
      assert.equal(digest(await sourceBytes(`https://raw.githubusercontent.com/RaoFoundation/subtensor/${commit}/${path}`)),sha,path);
    }));
  }
  const basketFiles = ["pallets/subtensor/runtime-api/src/lib.rs","pallets/subtensor/src/rpc_info/basket_info.rs"];
  const basketSources = basketFiles.map(path => {
    const previous = download(`https://raw.githubusercontent.com/RaoFoundation/subtensor/${current.commit}/${path}`,500000);
    const bytes = download(`https://raw.githubusercontent.com/RaoFoundation/subtensor/${commit}/${path}`,500000);
    assert.equal(digest(bytes),digest(previous),path);
    return {path,sha256:digest(bytes)};
  });
  const previousInput = inputs.releases.find(row=>row[0]===470)!, previousOutput = outputs.releases.find(row=>row[0]===470)!;
  assert.equal(inputs.releases.length,90); assert.equal(outputs.releases.length,90);
  const generated:[string,string][] = [
    ["tests/fixtures/native-runtime-eras-compiled.ts",fixtureSource("tests/fixtures/native-runtime-eras-compiled.ts",[...eras,next])],
    ["src/evm-runtime-catalogue.ts",tableSource("src/evm-runtime-catalogue.ts",{...inputs,releases:[...inputs.releases,[471,commit,previousInput[2]] ]})],
    ["src/evm-runtime-outputs.ts",tableSource("src/evm-runtime-outputs.ts",{...outputs,releases:[...outputs.releases,[471,commit,previousOutput[2]] ]})],
    ["tests/fixtures/evm-runtime-reference.ts",fixtureSource("tests/fixtures/evm-runtime-reference.ts",{...inputReference,manifests:[...inputReference.manifests,{...inputManifest,spec:471}]})],
    ["tests/fixtures/evm-runtime-output-reference.ts",fixtureSource("tests/fixtures/evm-runtime-output-reference.ts",{...outputReference,manifests:[...outputReference.manifests,{...outputManifest,spec:471}]})],
  ];
  console.log("V471_COMPILED_SOURCE_QUALIFICATION",JSON.stringify({spec:471,commit,wasm_sha256:extracted.wasm_sha256,metadata_formats:[14,15],portable_contract_equal_except_system_version:true,precompile_files_verified:files.size,precompile_addresses:inputManifest.addresses,precompile_functions:inputManifest.functions,basket_sources:basketSources,additional_chain_requests:0,fixture:true,production:false}));
  for(let file_index=0;file_index<generated.length;file_index++){
    const [path,raw]=generated[file_index]!,previous=execFileSync("git",["show",`HEAD:${path}`],{maxBuffer:10000000});
    const data=Buffer.from(await format(raw,{...(await resolveConfig(path)),filepath:path})),encoded=gzipSync(data).toString("base64");
    console.log("V471_RELEASE_HANDOFF",JSON.stringify({file_index,path,head,previous_sha256:digest(previous),bytes:data.length,sha256:digest(data),chunks:Math.ceil(encoded.length/16000),encoding:"gzip-base64"}));
    for(let offset=0;offset<encoded.length;offset+=16000)console.log("V471_RELEASE_HANDOFF_CHUNK",JSON.stringify({file_index,index:offset/16000,data:encoded.slice(offset,offset+16000)}));
  }
},180000);
