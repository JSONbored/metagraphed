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
  [
    "v1.1.7",
    "e6683abcdc46e24e4739d087614e88b19a03fbd0",
    "",
    594914
  ],
  [
    "v1.1.9",
    "4e2c494cd089de268a4c4169f34c1754190fd9ba",
    "",
    837078
  ],
  [
    "v1.1.10",
    "44d6859723fdd977e6c0928ed7ea99b1e354fdb3",
    "",
    836799
  ],
  [
    "v1.1.11",
    "7364b184cbed523f4184e9db35a2cd9ea23afcca",
    "",
    836800
  ],
  [
    "v1.2.2",
    "205025194588599fc21a2af7e63356a3072a3a21",
    "",
    980351
  ],
  [
    "v1.2.3",
    "c1c25e28d44dea4a0062628a71283760839cbd00",
    "",
    983621
  ],
  [
    "v1.2.4",
    "d4d8182eb99c564d707c81f65f1236c33ccda24b",
    "",
    984116
  ],
  [
    "v1.2.5",
    "8f39a58329f2d195f029793942d1de3388b3edeb",
    "",
    984108
  ],
  [
    "v2.0.0",
    "e2b8367b8be2d9ce60ae5858c49138fa05f44a68",
    "",
    1047605
  ],
  [
    "v2.0.1",
    "f95810a25d8b7f402189c9b39e1d73f8a4e4f90a",
    "",
    1047608
  ],
  [
    "v2.0.2",
    "f9254ea63c72586270700d0edc0e75804404ba4c",
    "",
    1049397
  ],
  [
    "v2.0.3",
    "85f72d9dc4773f82019016e770238a44a89b8185",
    "",
    1049874
  ],
  [
    "v2.0.4",
    "5073ade602c367471f5124329b9d7ccf8e972d69",
    "",
    1083973
  ],
  [
    "v2.0.5",
    "17b6ef3fe3a19809b48f278ab306b5bf0064b95f",
    "",
    1079521
  ],
  [
    "v2.0.6",
    "a27fff2918adab7dbe9da19c08657752698989da",
    "",
    1079839
  ],
  [
    "v2.0.7",
    "27de7d5f9266a75cf6c603757a8556ba5b9e5011",
    "",
    1084723
  ],
  [
    "v2.0.8",
    "b61dd30202ff6e970a18b5a5231b62183b6ba972",
    "",
    1093509
  ],
  [
    "v2.0.9",
    "8de0d23ca7dc94f5d4c595626f126ec6eb63dbb6",
    "",
    1119765
  ],
  [
    "v2.0.10",
    "719a6f5e9ecacd0e9cd95d5d7d190f9c2021d75f",
    "",
    1119786
  ],
  [
    "v2.0.11",
    "6b86ebf30d3fb83f9d43ed4ce713c43204394e67",
    "",
    1163848
  ],
  [
    "v3.0.0",
    "a1bf521444a80c86c37f1573af2e8860700c0b79",
    "",
    1164191
  ],
  [
    "v3.1.0",
    "1b0c63a71251e2ba68cc6fdd8ff40566c952b802",
    "",
    1197153
  ],
  [
    "v3.1.2",
    "4c9836f8cc199bc323956509f59d86d1761dd021",
    "sha256:f3f1d440032690cc1a74134b2a3a2f5e2b9189b45075a871bf5ee19955b987bb",
    1197243
  ],
  [
    "v3.1.3",
    "0e9f293d076713885a4efa996eaf52f24a45ae57",
    "sha256:69f12ab11f101d6ef961ecc1e850fe6df6e3fc2b39a9bfdb31cfed3d997e9b57",
    1197890
  ],
  [
    "v3.1.4",
    "18379a4cd99ac78d62e4d2bd4ff3276cd06725e4",
    "sha256:f86272cda1ef4ce4ce746f604b15fd0c4a14c4358ab10b5f0e4b5f1415dcb235",
    1198165
  ],
  [
    "v3.2.0",
    "c39063b4756a9ec7854069e9f04b4b86ad490803",
    "sha256:07d63b625c0b016125f8e07b03759ce7556a2b59adc0fd5f324eed5f8cf1156c",
    1308149
  ],
  [
    "v3.2.1",
    "9f33e759acd763497135043504dc048dcc599c31",
    "sha256:0d262e60b8a9cfba657783434924ca850dba4dd87a9dd620c590ba8e228abf73",
    1309052
  ],
  [
    "v3.2.2",
    "7b541095b057a68e0090d8348bdc96a70dc56be8",
    "sha256:cf994066362288d92a64cac240e173136346ac510414681488662b72fc345a1e",
    1321851
  ],
  [
    "v3.2.3",
    "6309d35929e484ebff70c7da68547fb9c60f0d11",
    "sha256:c1c8fa6d0c640bd96bb5833ab372ceb37aa8e578c1a402f6e8d2585912539b12",
    1326282
  ],
  [
    "v3.2.4",
    "312c0be95983a98bed4120526351a94219d00449",
    "sha256:252fd3342909c8152b530a249579439e6c293df7071a662a2c6bf5f76b118b2a",
    1488779
  ],
  [
    "v3.2.5",
    "67c7ac6923b498c15f5541fd0e9ddcbeed38c3b7",
    "sha256:bf47233a00fb922ba63eeb2c2f36a2e5064d747b7dc7d4f098d5d45cd3e21aed",
    1493673
  ],
  [
    "v3.2.6",
    "737e4acb173cddbe6fde9c6085853ef8b8f02a80",
    "sha256:8af1973b94bcbed8976df4ab5dbd8ab9e54c35e893647bbb5f1b0be35251333d",
    1500264
  ],
  [
    "v3.2.7",
    "81ee047fd124f8837555fd79e8a3957688c5b0c6",
    "sha256:6eb6f212e5838377287e32cb1e0644698a4b8eef1eaa0f9c75edd9cf52a5c335",
    1502404
  ],
  [
    "v3.2.8-320",
    "835a2c90294705b5963043f5ef31460304df2475",
    "sha256:05836f3355ce09ecba279944216e8b6119b120e94e8d180004993ab4aaebc203",
    1567532
  ],
  [
    "v3.2.9-323",
    "79010a36cdb8391bb5de5c86acd0387d71f462c9",
    "sha256:81084f7a0046b58c2645fbcf8971eb33bf4041c3d77badaaba6f8efa3d67be1f",
    1569269
  ],
  [
    "v3.2.9-326",
    "ae2b37364ce53cf9af44d4088f4ef53ad859f8b8",
    "sha256:8d5a5e7a6036e60896fd4540ee6c6d6fd45a704e431abae571ef54ee93e9b43b",
    1659177
  ],
  [
    "v3.2.10-334",
    "6218ecc5cdab527a649c8fa5b0194db3f884571c",
    "sha256:bf395821692d572e9396e27955a881e36ac24c0f3275c6ad1a0d75beea121aa4",
    2186299
  ],
  [
    "v3.2.11-338",
    "1f520ed9587ce588994d48937aca0de8262cf784",
    "sha256:a8dc28f00d371bee3230a9b336496bbb46e4b9f3232c034f7ae4c93c5b7419cf",
    2186687
  ],
  [
    "v3.2.12-342",
    "6a76ecc0d576c13f32189393360f2d95fb4a78f2",
    "sha256:b3ab9c0ce672b7287a0573080a6d78dad6e27a47ccced6afcb662c0ca93645db",
    2182116
  ],
  [
    "v3.2.13-343",
    "b179867c306fb6a28345896f422910e603799d70",
    "sha256:b84fa52c29d534d63711ac3d2a465993e1fce91d446ffcf740989f09945416db",
    2184713
  ],
  [
    "3.2.14-345",
    "8f33f8cbf6b958b9ec215424a50d96cd2fc5e5ae",
    "sha256:b0b4092b7b79b72453b9439435d23d80f910c56a921a0ef081b2c2d3375fa5ba",
    2184188
  ],
  [
    "v3.2.15-347",
    "6304dbedc34c6b271546a9338d9b870ceb1ac625",
    "sha256:f0e47a0a3820ed30d82ceaede132cdf790ef7e326fec822cdf0253d33cd3f809",
    2184694
  ],
  [
    "v3.2.15-348",
    "459fa72d1468b6dc7485de7392996de50169fbf8",
    "sha256:88c9d5d77b282d5e0ed549cca796f2a1f1fa7cf01e1798f84492be28b30ed92a",
    2184775
  ],
  [
    "v3.2.16-349",
    "20cbabc70fb2528d166ab2a296a1d656a6e5a106",
    "sha256:9bab82cbc2e613757b1b5103f62ea137542c52b987cf95645c58250d0a3eca82",
    2183691
  ],
  [
    "v3.2.17-350",
    "4d3a7ab3422f587c3f3faa855dd03d73ccbcbfdf",
    "sha256:146ec7ea4d87b65967ebedee1414ff88a2c39f249cc887cfa987ef73096859a0",
    2183772
  ],
  [
    "v3.2.19-352",
    "024a3049157b83329e041f3e60ae3da611a022bb",
    "sha256:c2e6f13e223925fc7e6da64b64beeef4d569b58b90fbca5d79c94d94a4371e10",
    2183530
  ],
  [
    "v3.3.0-361",
    "52378dc3e911cdfc7b8e3cf1160a6e0e4dde4fd6",
    "sha256:c5c2b17c37ee2866fb8f1552eb5f24c47ece7f4dc372ddfa4e87b9772f8cb6cd",
    2180265
  ],
  [
    "v3.3.1-362",
    "8834a7c737583c8ab8d6c3abdbd4865e039e24a9",
    "sha256:039e4d79a4e9577126b71ff8630eab06d077bc591bbe495fe1d8c5d056dd59a8",
    2180002
  ],
  [
    "v3.3.2-365",
    "6e3d24cea446b3241524bb319b72bf506e8e8eb4",
    "sha256:83c3e767e65c292336effccea610a8f4838627b183d31ad49a6f83ea113100e4",
    2137480
  ],
  [
    "v3.3.4-367",
    "8f13194c6e56f218910b4a9c708199cc38f64c40",
    "sha256:323aac618e07c26c4a5189ab0eb4c3c942fdfcae16edf86d929d30a5138a7c81",
    2136394
  ],
  [
    "v3.3.5-372",
    "f74d69ed52e66c42476c94cdbeac8018f5c5567b",
    "sha256:2258126d5ebbc8da39eac2fa6a64a129f01072ade8a18462bd7ca7abc223bcbd",
    2143047
  ],
  [
    "v3.3.7-373",
    "206e7c890d2ac4268257cfd205bcf80100225241",
    "sha256:f40a2a9670517f2360ffa1d2d8d0168900f37f6cf3c65c1faf3f4052dfd4bb5a",
    2139919
  ],
  [
    "v3.3.8-374",
    "54504b674929bbce60845aa16110baff3105f90c",
    "sha256:6827f82eac90b2b8e4ebb144b472b3fc8c968a9cc7ec1bf8615c01b65f4a27a7",
    2141258
  ],
  [
    "v3.3.12-391",
    "7a727dd4d219a953391e91ed2f7aa942050938f1",
    "sha256:4d7635b8eb30a525564703ea55f46650401b5444854381fc6f60781b9081401f",
    2167247
  ],
  [
    "v3.3.14-401",
    "40a451f366900d00ec0b3781e4c5a4a92ba9a6b6",
    "sha256:97117a2c79e6e5363d0615e42dc38e97cfd2d26dcf55c9f9f1d7ca024eeedb37",
    2207774
  ],
  [
    "v3.4.0-411",
    "486037ba45b87a453b1d660177cc1b105d0298c6",
    "sha256:9c1598568d5e0f0b1e6529bdf4ce1aa9611339b71c30897a8e7ebeed4e1e5a0f",
    2240623
  ],
  [
    "v3.4.1-413",
    "ec2212c53fc7c0252af80c28e50a959cce2f9890",
    "sha256:669c1a4a4788cabb2a859f1006604294f3e2bda3a591680168b21b7861b8031b",
    2249723
  ],
  [
    "v3.4.2-415",
    "1104f2aab5acdf69fe967a787c7ae1cc5fdf170c",
    "sha256:fc3be3f5e428167f8e77c484695925208576765b060e64fbb876edb9471182b7",
    2256783
  ],
  [
    "v3.4.3-416",
    "3c5aff01d9508a31a01fca2231ee7c6d0b14905a",
    "sha256:39dc60f96a0a44242f7cc16273c4b1d7f735e7faf214bd62cc350eb7a949585d",
    2262044
  ],
  [
    "v3.4.4-417",
    "49164bd68afd71e48e3c80d268ed80f22b98a2b1",
    "sha256:f667b6e353e32ff7da4450aa23a55e7969199a966f7408f47e82d7804e7c3793",
    2263054
  ],
  [
    "v3.4.5-419",
    "fa83646297f45a1a8108f70ba2ebf32d4f35b5c2",
    "sha256:e6506f6a361946b2d74a524c9e80b9357df4f921b31ba3f91313e0f521ed1695",
    2264622
  ],
  [
    "v3.4.6-421",
    "6016381e4fb230d17643cca948afe296eb06faac",
    "sha256:6f42162ca270e56f008b3b90933bda176a953517d43ca023883575c45bb0bffe",
    2263977
  ],
  [
    "v3.4.7-422",
    "e367ae64709a22cfeb7ec114814a14f0db137a83",
    "sha256:037cb0e809b088e1753ddcf98df3637e2c32cd1cab0f624650e262a4ae663023",
    2264489
  ],
  [
    "v3.4.8-423",
    "06032d518fbaead1ddc2039e9e6aa55715026364",
    "sha256:b05172092a7cbb0a79cccd6fc5fee11fa015c922525fefa9fc256452268e8dc8",
    2282880
  ],
  [
    "v3.4.9-424",
    "6d81084c5c13413d9e3637586280125c0bfc1948",
    "sha256:df6b74e5812f8bc406e16476245a6382476984f9ded1bf68f5ee72db376a47c8",
    2283469
  ]
] as const;

function download(url: string, maxBuffer: number) {
  return execFileSync("curl", ["--fail", "--location", "--max-time", "30", "--silent", "--show-error", url], { maxBuffer });
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function extract(tag: string, commit: string, publishedHash: string, publishedBytes: number) {
  const base = `https://github.com/RaoFoundation/subtensor/releases/download/${tag}`;
  const manifestBytes = download(`${base}/subtensor-digest.json`, 32768);
  const manifest = JSON.parse(manifestBytes.toString());
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.info.git.commit, commit);
  assert.equal(manifest.runtimes.compressed.sha256, manifest.sha256);
  assert.equal(Number(manifest.runtimes.compressed.size), publishedBytes);
  const spec = manifest.runtimes.compressed.subwasm.core_version.specVersion;
  assert.ok(Number.isSafeInteger(spec) && spec > 0 && spec < 430);
  const blob = download(`${base}/subtensor.wasm`, 8 * 1024 * 1024);
  assert.equal(blob.length, publishedBytes);
  assert.equal(`0x${digest(blob)}`, manifest.wasm_sha256 ?? manifest.sha256);
  if (publishedHash) assert.equal(`sha256:${digest(blob)}`, publishedHash);
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
  assert.deepEqual(runtimeVersion, manifest.runtimes.compressed.subwasm.core_version);
  const metadata: Record<string, string> = {};
  for (const version of [14, 15]) {
    new DataView(memory.buffer).setUint32(ptr, version, true);
    const bytes = invoke("Metadata_metadata_at_version", 4);
    assert.notEqual(bytes.toString("hex"), "00", `${tag} does not export metadata V${version}`);
    assert.ok(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024);
    const wrapped = `0x${bytes.toString("hex")}`;
    const model = decodeNativeMetadata(unwrapNativeMetadata(wrapped)!);
    assert.equal(model.version, version);
    metadata[`v${version}`] = wrapped;
    metadata[`v${version}_sha256`] = digest(bytes);
    console.log("NATIVE_RELEASE_METADATA", JSON.stringify({ tag, spec, version, commit, wasm_sha256: digest(blob), metadata_bytes: bytes.length, metadata_sha256: digest(bytes), types: model.types.size, pallets: model.pallets.length, apis: model.apis.length, fixture: true, production: false }));
  }
  console.log("NATIVE_RELEASE_METADATA_HOSTS", JSON.stringify({ spec, hostCalls }));
  return { tag, spec, commit, wasm_sha256: digest(blob), digest_sha256: digest(manifestBytes), runtimeVersion, ...metadata };
}

test("pin the actual published legacy build identities on remote CI", () => {
  if (!process.env.CI) return;
  for (const [tag, tagCommit, publishedHash, publishedBytes] of releases) {
    const base = `https://github.com/RaoFoundation/subtensor/releases/download/${tag}`;
    const bytes = download(`${base}/subtensor-digest.json`, 32768);
    const manifest = JSON.parse(bytes.toString());
    assert.match(manifest.commit, /^[0-9a-f]{40}$/);
    assert.equal(manifest.info.git.commit, manifest.commit);
    assert.equal(manifest.runtimes.compressed.sha256, manifest.sha256);
    assert.equal(Number(manifest.runtimes.compressed.size), publishedBytes);
    if (publishedHash) assert.equal(`sha256:${manifest.sha256.slice(2)}`, publishedHash);
    console.log("NATIVE_LEGACY_BUILD_IDENTITY", JSON.stringify({ tag, tag_commit: tagCommit, commit: manifest.commit, spec: manifest.runtimes.compressed.subwasm.core_version.specVersion, digest_sha256: digest(bytes), wasm_sha256: manifest.sha256.slice(2), wasm_bytes: publishedBytes }));
  }
}, 300000);
