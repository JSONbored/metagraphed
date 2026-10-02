// Temporary remote-only release fixture extraction; removed before release.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { test } from "vitest";
import { decompress } from "fzstd";
import { TypeRegistry } from "@polkadot/types/create";
import { decodeNativeMetadata, unwrapNativeMetadata } from "../src/native-runtime-metadata.ts";
import { format, resolveConfig } from "prettier";

const releases = [
  [430, "9c8e26e7fccc76327ab5204f7978aa2e4d86efd6"],
  [431, "32f3b652cfa74df5f8f595a5be051bf5bb86925f"],
  [432, "8586e65ec279644a6837cf25b12333064c77474e"],
  [437, "2d52647c415aa987ab93dbd7de4ddc5eaf7aa083"],
  [438, "c1463f2cc62e7de70aa3379ee53cfc5f060bde42"],
  [439, "cda8fd76ad2a7014cac632933237abf1ddaa9b30"],
  [440, "e4ffa2e1325c6c7db618dbceaf396310a170990c"],
  [441, "8b9d55c723e00d0d713eed799de627e94603dfd4"],
  [442, "ec112cb0e68469fa1c5e5ae67dece043033f6673"],
  [443, "c02a376ecee28718970962562fece409b695df72"],
  [445, "d3f40e44bda9019c606aeb0c907bb52ba7fe386c"],
  [446, "52d7e7cf66c6fdcc76f62fd4b00732aa506afb2c"],
  [447, "1f090af85d1771c5d8ece1f0910576fbd129906e"],
  [448, "e18ca67f1a00b35c7d5986888d1cc388da8c095f"],
  [450, "9540b3af59179b88af99f8e0d03add5d96512e3f"],
  [452, "da06f033663896ef2fdbbfc3ecc68ca908fba0f5"],
  [453, "823bdcbc58a29f60b243be4737a7c72b34ac7d93"],
  [454, "14cde6410fe8ec81a940e290c56f94a632a0988d"],
  [459, "70378404b56c12a85bc8cd163aca2f32cf4d1b80"],
  [464, "5cd66b8597b3ce5f9f2bade2b11c91af57df923d"],
  [466, "cdffbe2f7ab0c37ab07884387bfbd6443dca178d"],
  [467, "c6bcb4a7400764c94c1d1b1938514c6c2dd3d33b"],
  [468, "30c70d90f8a3708d85cf95ae992b7a3fe30d2c4c"],
  [469, "370bac46fa8cf602c4f8283a0635b3a8b4675394"],
  [470, "923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d"],
] as const;

function download(url: string, maxBuffer: number) {
  return execFileSync("curl", ["--fail", "--location", "--max-time", "30", "--silent", "--show-error", url], { maxBuffer });
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

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
  let instance: WebAssembly.Instance;
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
  instance = await WebAssembly.instantiate(module, imports);
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

test("extract compiled historical release contracts on remote CI only", async () => {
  if (!process.env.CI) return;
  const fixtures = [];
  for (const [spec, commit] of releases) fixtures.push(await extract(spec, commit));
  const compressed = brotliCompressSync(Buffer.from(JSON.stringify(fixtures)), { params: { [constants.BROTLI_PARAM_QUALITY]: 6, [constants.BROTLI_PARAM_LGWIN]: 24 } }).toString("base64");
  const source = `// Checksum-verified official Subtensor release WASM metadata, v430–v470.\n// Extracted on remote CI; no deployed state, contract execution or submission.\n// Source: https://github.com/RaoFoundation/subtensor/releases\nimport { brotliDecompressSync } from "node:zlib";\nexport interface CompiledRuntimeEra {\n  spec: number;\n  commit: string;\n  wasm_sha256: string;\n  runtimeVersion: { specName: string; specVersion: number; transactionVersion: number; apis: [string, number][] };\n  v14: string;\n  v14_sha256: string;\n  v15: string;\n  v15_sha256: string;\n}\nconst compressed = [\n${compressed.match(/.{1,120}/g)!.map((part) => JSON.stringify(part)).join(",\n")}\n].join("");\nexport default JSON.parse(brotliDecompressSync(Buffer.from(compressed, "base64")).toString()) as CompiledRuntimeEra[];\n`;
  const name = "tests/fixtures/native-runtime-eras-compiled.ts";
  const formatted = await format(source, { ...(await resolveConfig(name)), filepath: name });
  const encoded = gzipSync(formatted).toString("base64");
  console.log("NATIVE_RELEASE_FIXTURE_SIZE", { releases: fixtures.length, committed_bytes: Buffer.byteLength(formatted) });
  for (let offset = 0; offset < encoded.length; offset += 16000) console.log(`NATIVE_RELEASE_FIXTURE_HANDOFF ${offset / 16000} ${encoded.slice(offset, offset + 16000)}`);
}, 360000);
