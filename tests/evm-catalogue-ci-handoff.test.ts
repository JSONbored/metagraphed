// Temporary remote-only catalogue/reference extraction; removed before release.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { format, resolveConfig } from "prettier";
import { test } from "vitest";
import eras from "./fixtures/native-runtime-eras-compiled.ts";

const run = promisify(execFile);
async function download(url: string, maxBuffer = 250000) {
  const result = await run("curl", ["--fail", "--location", "--max-time", "30", "--silent", "--show-error", url], { maxBuffer, encoding: "buffer" });
  return result.stdout;
}
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function sample(type: string): unknown {
  if (type.endsWith("[]")) return [sample(type.slice(0, -2)), sample(type.slice(0, -2))];
  if (type === "address") return `0x${"ab".repeat(20)}`;
  if (type === "bool") return true;
  if (type === "bytes") return "0x0001feff";
  if (type === "string") return "Subnet \u03bb \ud83d\ude80";
  const fixed = /^bytes(\d+)$/.exec(type);
  if (fixed) return `0x${"bc".repeat(Number(fixed[1]))}`;
  const integer = /^uint(\d+)$/.exec(type);
  assert.ok(integer, type);
  const value = (1n << BigInt(integer[1])) - 1n;
  return Number(integer[1]) <= 32 ? Number(value) : value.toString();
}

test("extract version-bound official precompile catalogues and independent ethers ABI vectors on remote CI", async () => {
  if (!process.env.CI) return;
  const scratch = await mkdtemp(join(tmpdir(), "evm-catalogue-"));
  try {
    const metadata = JSON.parse((await download("https://registry.npmjs.org/ethers/6.15.0", 250000)).toString()) as { dist: { tarball: string; integrity: string } };
    assert.equal(metadata.dist.tarball, "https://registry.npmjs.org/ethers/-/ethers-6.15.0.tgz");
    const tar = await download(metadata.dist.tarball, 4000000);
    assert.equal(`sha512-${createHash("sha512").update(tar).digest("base64")}`, metadata.dist.integrity);
    await writeFile(join(scratch, "ethers.tgz"), tar);
    execFileSync("tar", ["xzf", join(scratch, "ethers.tgz"), "-C", scratch, "package/dist/ethers.min.js"]);
    await writeFile(join(scratch, "reference.mjs"), await readFile(join(scratch, "package/dist/ethers.min.js")));
    const { Interface, id } = await import(pathToFileURL(join(scratch, "reference.mjs")).href);
    const functions: [string, string[], string][] = [];
    const precompiles: [string, number, number[]][] = [];
    const releases: [number, string, number[]][] = [];
    const manifests: { spec: number; files: [string, string][]; addresses: number; functions: number }[] = [];
    const vectors: [string, unknown[]][] = [];
    const functionIds = new Map<string, number>();
    const precompileIds = new Map<string, number>();
    for (const era of eras) {
      const base = `https://raw.githubusercontent.com/RaoFoundation/subtensor/${era.commit}/precompiles/src/`;
      const libBytes = await download(`${base}lib.rs`);
      const lib = libBytes.toString();
      const used = /fn used_addresses\(\)[^{]+\{\s*\[([\s\S]*?)\]\s*\}/.exec(lib);
      assert.ok(used, `used addresses ${era.spec}`);
      const bindings = [...used[1].matchAll(/hash\(([^)]+)\)/g)].map((match) => match[1]);
      const exports = new Map<string, string>();
      for (const match of lib.matchAll(/pub use (\w+)::([^;]+);/g)) {
        for (const name of match[2].match(/\b[A-Z]\w*/g) ?? []) exports.set(name, match[1]);
      }
      const classes = bindings.filter((name) => !/^\d+$/.test(name)).map((name) => name.split("::")[0]);
      const paths = [...new Set(classes.map((name) => exports.get(name)!))];
      assert.ok(paths.every(Boolean), `exports ${era.spec}`);
      const files = new Map<string, string>();
      const hashes: [string, string][] = [["lib.rs", digest(libBytes)]];
      // Four bounded public-source reads at a time; no node or production API.
      for (let offset = 0; offset < paths.length; offset += 4) {
        await Promise.all(paths.slice(offset, offset + 4).map(async (path) => {
          const bytes = await download(`${base}${path}.rs`);
          files.set(path, bytes.toString());
          hashes.push([`${path}.rs`, digest(bytes)]);
        }));
      }
      const releaseEntries: number[] = [];
      let functionCount = 0;
      for (const binding of bindings) {
        let index: number;
        let name: string;
        const methodIds: number[] = [];
        if (/^\d+$/.test(binding)) {
          index = Number(binding);
          const dispatch = new RegExp(`a if a == hash\\(${index}\\) => Some\\((\\w+)`).exec(lib);
          assert.ok(dispatch, `raw dispatch ${era.spec} ${index}`);
          name = dispatch[1];
        } else {
          const klass = binding.split("::")[0];
          const source = files.get(exports.get(klass)!)!;
          const ext = new RegExp(`\\bfor ${klass}[^]*?const INDEX:\\s*u64\\s*=\\s*(\\d+);`).exec(source);
          assert.ok(ext, `index ${era.spec} ${klass}`);
          index = Number(ext[1]);
          name = klass.replace(/Precompile(?=V\d+$|$)/, "");
          const starts = [...source.matchAll(/#\[precompile_utils::precompile\]\s*impl(?:<[^>]+>)?\s+(\w+)/g)];
          const start = starts.find((row) => row[1] === klass);
          if (start) {
            const end = starts.find((row) => row.index! > start.index!)?.index ?? source.length;
            const body = source.slice(start.index!, end);
            for (const match of body.matchAll(/#\[precompile::public\("([^"]+)"\)\]/g)) {
              const signature = match[1];
              const declaration = /\bfn \w+\s*\(([\s\S]*?)\)\s*->/.exec(body.slice(match.index!));
              assert.ok(declaration, `declaration ${era.spec} ${signature}`);
              const names = [...declaration[1].matchAll(/(?:^|[,\n])\s*(\w+)\s*:(?!:)/g)].map((row) => row[1]).slice(1);
              const types = signature.slice(signature.indexOf("(") + 1, -1).split(",").filter(Boolean);
              assert.equal(names.length, types.length, `${era.spec} ${signature} ${names}`);
              const selector = id(signature).slice(0, 10);
              const entry: [string, string[], string] = [signature, names, selector];
              const key = JSON.stringify(entry);
              let functionId = functionIds.get(key);
              if (functionId === undefined) {
                functionId = functions.length;
                functionIds.set(key, functionId);
                functions.push(entry);
                const args = types.map(sample);
                const iface = new Interface([`function ${signature}`]);
                const input = iface.encodeFunctionData(signature, args);
                assert.equal(input.slice(0, 10), selector);
                vectors.push([input, args]);
              }
              methodIds.push(functionId);
            }
          } else {
            assert.ok(["Ed25519Verify", "Sr25519Verify", "StorageQueryPrecompile"].includes(klass), `missing ABI ${era.spec} ${klass}`);
          }
        }
        assert.equal(new Set(methodIds.map((entry) => functions[entry][2])).size, methodIds.length, `${era.spec} ${name} collision`);
        functionCount += methodIds.length;
        const entry: [string, number, number[]] = [name, index, methodIds];
        const key = JSON.stringify(entry);
        let precompileId = precompileIds.get(key);
        if (precompileId === undefined) {
          precompileId = precompiles.length;
          precompileIds.set(key, precompileId);
          precompiles.push(entry);
        }
        releaseEntries.push(precompileId);
      }
      releases.push([era.spec, era.commit, releaseEntries]);
      manifests.push({ spec: era.spec, files: hashes.sort(), addresses: bindings.length, functions: functionCount });
      console.log("EVM_CATALOGUE_RELEASE", era.spec, bindings.length, functionCount);
    }
    const catalogue = `// Official release-bound precompile ABI, generated and reference-qualified on CI.\n// Source: https://github.com/RaoFoundation/subtensor/tree/v470/precompiles/src\n// Shared entries avoid repeating unchanged signatures across release tags.\nexport const evmRuntimeCatalogue: { functions: [string, string[], string][]; precompiles: [string, number, number[]][]; releases: [number, string, number[]][] } = ${JSON.stringify({ functions, precompiles, releases })};\n`;
    const compressed = brotliCompressSync(Buffer.from(JSON.stringify({ reference: { version: "ethers@6.15.0", integrity: metadata.dist.integrity }, vectors, manifests })), { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }).toString("base64");
    const fixture = `// Independently encoded ethers@6.15.0 reference vectors; remote-only extraction.\nimport { brotliDecompressSync } from "node:zlib";\nconst compressed = [${compressed.match(/.{1,120}/g)!.map((part) => JSON.stringify(part)).join(",")}].join("");\nexport default JSON.parse(brotliDecompressSync(Buffer.from(compressed, "base64")).toString()) as { reference: { version: string; integrity: string }; vectors: [string, unknown[]][]; manifests: {spec: number; files: [string,string][]; addresses: number; functions: number}[] };\n`;
    for (const [path, source] of [["src/evm-runtime-catalogue.ts", catalogue], ["tests/fixtures/evm-runtime-reference.ts", fixture]]) {
      const formatted = await format(source, { ...(await resolveConfig(path)), filepath: path });
      const encoded = gzipSync(formatted).toString("base64");
      console.log("EVM_CATALOGUE_HANDOFF_FILE", path, Buffer.byteLength(formatted), digest(Buffer.from(formatted)));
      for (let offset = 0; offset < encoded.length; offset += 16000) console.log(`EVM_CATALOGUE_HANDOFF ${path} ${offset / 16000} ${encoded.slice(offset, offset + 16000)}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 720000);
