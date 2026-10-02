// Temporary remote-only official output ABI extraction; removed before release.
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
import { evmRuntimeCatalogue as catalogue } from "../src/evm-runtime-catalogue.ts";

type Param = { name: string; type: string; components?: Param[] };
type Function = { type: string; name: string; inputs: Param[]; outputs: Param[]; stateMutability: string };
const run = promisify(execFile);
async function download(url: string, maxBuffer = 250000) {
  const result = await run("curl", ["--fail", "--location", "--max-time", "30", "--silent", "--show-error", url], { maxBuffer, encoding: "buffer" });
  return result.stdout;
}
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const canonicalType = (param: Param): string => param.type.startsWith("tuple") ? `(${param.components!.map(canonicalType).join(",")})${param.type.slice(5)}` : param.type;
const clean = (param: Param): Param => ({name:param.name,type:param.type,...(param.components ? {components:param.components.map(clean)}:{})});
function sample(param: Param): unknown {
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array) return Array.from({length:array[2] ? Number(array[2]):2},()=>sample({...param,type:array[1]}));
  if (param.type === "tuple") return param.components!.map(sample);
  if (param.type === "address") return `0x${"ab".repeat(20)}`;
  if (param.type === "bool") return true;
  if (param.type === "bytes") return "0x0001feff";
  if (param.type === "string") return "\ufeffSubnet λ 🚀";
  const fixed = /^bytes(\d+)$/.exec(param.type);
  if (fixed) return `0x${"bc".repeat(Number(fixed[1]))}`;
  const integer = /^(u?int)(\d+)$/.exec(param.type);
  assert.ok(integer, param.type);
  const value = (1n << BigInt(Number(integer[2])-(integer[1]==="int" ? 1:0))) - 1n;
  return Number(integer[2]) <= 32 ? Number(value) : value.toString();
}
function jsonValue(param: Param, value: unknown): unknown {
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array) return (value as unknown[]).map(item=>jsonValue({...param,type:array[1]},item));
  if (param.type === "tuple") {
    const rows=param.components!, values=(value as unknown[]).map((item,index)=>jsonValue(rows[index],item));
    return rows.every(row=>row.name) && new Set(rows.map(row=>row.name)).size===rows.length ? Object.fromEntries(rows.map((row,index)=>[row.name,values[index]])):values;
  }
  return value;
}

test("extract complete official output ABIs and independent ethers return vectors on remote CI", async () => {
  if (!process.env.CI) return;
  const scratch = await mkdtemp(join(tmpdir(), "evm-output-"));
  try {
    const metadata = JSON.parse((await download("https://registry.npmjs.org/ethers/6.15.0")).toString()) as { dist: { tarball: string; integrity: string } };
    assert.equal(metadata.dist.tarball, "https://registry.npmjs.org/ethers/-/ethers-6.15.0.tgz");
    const tar = await download(metadata.dist.tarball, 4000000);
    assert.equal(`sha512-${createHash("sha512").update(tar).digest("base64")}`, metadata.dist.integrity);
    await writeFile(join(scratch, "ethers.tgz"), tar);
    execFileSync("tar", ["xzf", join(scratch, "ethers.tgz"), "-C", scratch, "package/dist/ethers.min.js"]);
    await writeFile(join(scratch, "reference.mjs"), await readFile(join(scratch, "package/dist/ethers.min.js")));
    const { Interface } = await import(pathToFileURL(join(scratch, "reference.mjs")).href);
    const outputs: Param[][]=[], bindings:[number,[number,number][]][]=[], releases:[number,string,number[]][]=[], vectors:[string,unknown[]][]=[], manifests:{spec:number;files:[string,string][];functions:number}[]=[];
    const outputIds=new Map<string,number>(), bindingIds=new Map<string,number>(), types=new Set<string>();
    for (const release of catalogue.releases) {
      const entries:number[]=[], files:[string,string][]=[], cache=new Map<string,Function[]>();
      let count=0;
      for (const id of release[2]) {
        const precompile=catalogue.precompiles[id];
        if (!precompile[2].length) continue;
        const filename=precompile[0]==="PrecompileRegistry" ? "registry" : precompile[0][0].toLowerCase()+precompile[0].slice(1);
        let abi=cache.get(filename);
        if (!abi) {
          const data=await download(`https://raw.githubusercontent.com/RaoFoundation/subtensor/${release[1]}/precompiles/src/solidity/${filename}.abi`);
          files.push([`${filename}.abi`,digest(data)]);
          abi=JSON.parse(data.toString()) as Function[];
          cache.set(filename,abi);
        }
        const rows:[number,number][]=[];
        for (const fnId of precompile[2]) {
          const fn=catalogue.functions[fnId];
          const matches=abi.filter(row=>row.type==="function" && `${row.name}(${row.inputs.map(canonicalType).join(",")})`===fn[0]);
          assert.equal(matches.length,1,`${release[0]} ${precompile[0]} ${fn[0]} ABI binding`);
          const output=matches[0].outputs.map(clean);
          const visit=(param:Param)=>{types.add(param.type);param.components?.forEach(visit);};output.forEach(visit);
          const key=JSON.stringify(output);
          let outputId=outputIds.get(key);
          if (outputId===undefined) {
            outputId=outputs.length;outputs.push(output);outputIds.set(key,outputId);
            const args=output.map(sample), iface=new Interface([{...matches[0],outputs:output}]);
            const encoded=iface.encodeFunctionResult(fn[0],args);
            const independent=iface.decodeFunctionResult(fn[0],encoded);
            assert.equal(iface.encodeFunctionResult(fn[0],independent),encoded);
            vectors.push([encoded,output.map((param,index)=>jsonValue(param,args[index]))]);
          }
          rows.push([fnId,outputId]);count++;
        }
        const binding:[number,[number,number][]]=[id,rows], key=JSON.stringify(binding);
        let bindingId=bindingIds.get(key);
        if (bindingId===undefined) {bindingId=bindings.length;bindings.push(binding);bindingIds.set(key,bindingId);}
        entries.push(bindingId);
      }
      releases.push([release[0],release[1],entries]);manifests.push({spec:release[0],files:files.sort(),functions:count});
      console.log("EVM_OUTPUT_RELEASE",release[0],count);
    }
    console.log("EVM_OUTPUT_GRAMMAR",JSON.stringify([...types].sort()));
    const source=`// Official release-bound Solidity return types; generated and qualified on remote CI.\n// Shared output layouts and address bindings preserve release-specific changes.\nexport type RuntimeEvmOutput = { name:string;type:string;components?:RuntimeEvmOutput[] };\nexport const evmRuntimeOutputs:{outputs:RuntimeEvmOutput[][];bindings:[number,[number,number][]][];releases:[number,string,number[]][]}=${JSON.stringify({outputs,bindings,releases})};\n`;
    const compressed=brotliCompressSync(Buffer.from(JSON.stringify({reference:{version:"ethers@6.15.0",integrity:metadata.dist.integrity},vectors,manifests})),{params:{[constants.BROTLI_PARAM_QUALITY]:6}}).toString("base64");
    const fixture=`// Independent official-ABI ethers return vectors; generated on remote CI.\nimport { brotliDecompressSync } from "node:zlib";\nconst compressed=[${compressed.match(/.{1,120}/g)!.map(part=>JSON.stringify(part)).join(",")}].join("");\nexport default JSON.parse(brotliDecompressSync(Buffer.from(compressed,"base64")).toString()) as {reference:{version:string;integrity:string};vectors:[string,unknown[]][];manifests:{spec:number;files:[string,string][];functions:number}[]};\n`;
    for (const [path,raw] of [["src/evm-runtime-outputs.ts",source],["tests/fixtures/evm-runtime-output-reference.ts",fixture]]) {
      const data=Buffer.from(await format(raw,{...(await resolveConfig(path)),filepath:path}));
      console.log("EVM_OUTPUT_FILE",path,data.length,digest(data));
      const encoded=gzipSync(data).toString("base64");
      for(let offset=0;offset<encoded.length;offset+=16000)console.log(`EVM_OUTPUT_DATA ${path} ${offset/16000} ${encoded.slice(offset,offset+16000)}`);
    }
  } finally {await rm(scratch,{recursive:true,force:true});}
},720000);
