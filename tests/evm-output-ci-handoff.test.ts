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
import inputReference from "./fixtures/evm-runtime-reference.ts";

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

function splitTypes(input:string) {
  const rows:string[]=[];let depth=0,start=0;
  for(let index=0;index<input.length;index++) {
    const char=input[index];if(char==="<"||char==="("||char==="[")depth++;
    if(char===">"||char===")"||char==="]")depth--;
    if(char===","&&depth===0){rows.push(input.slice(start,index).trim());start=index+1;}
  }
  const last=input.slice(start).trim();if(last)rows.push(last);assert.equal(depth,0);return rows;
}
function rustParam(raw:string,source:string,depth=0):Param {
  assert.ok(depth<10,raw);
  const type=raw.trim();
  const scalar:Record<string,string>={u8:"uint8",u16:"uint16",u32:"uint32",u64:"uint64",u128:"uint128",U256:"uint256",H256:"bytes32",Address:"address",bool:"bool",UnboundedBytes:"bytes",UnboundedString:"string",String:"string"};
  if(scalar[type])return {name:"",type:scalar[type]};
  if(type.startsWith("(")&&type.endsWith(")"))return {name:"",type:"tuple",components:splitTypes(type.slice(1,-1)).map(row=>rustParam(row,source,depth+1))};
  const vector=/^Vec<([^]+)>$/.exec(type);
  if(vector){const item=rustParam(vector[1],source,depth+1);return {...item,type:item.type+"[]"};}
  const body=new RegExp(`(?:pub\s+)?struct\s+${type}\s*\{([^]*?)\}`).exec(source);
  assert.ok(body,`Unknown Rust output ${type}`);
  const fields=body[1].replace(/\/\/[^\n]*/g,"");
  const components=splitTypes(fields).map(row=>{const match=/^(?:pub\s+)?(\w+)\s*:\s*([^]+)$/.exec(row);assert.ok(match,`${type} ${row}`);return {...rustParam(match[2],source,depth+1),name:match[1]};});
  assert.ok(components.length,type);return {name:"",type:"tuple",components};
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
      const entries:number[]=[], files:[string,string][]=[], cache=new Map<string,Function[]>(),rustCache=new Map<string,string>();
      const old=inputReference.manifests.find(row=>row.spec===release[0])!;
      const libBytes=await download(`https://raw.githubusercontent.com/RaoFoundation/subtensor/${release[1]}/precompiles/src/lib.rs`);
      assert.equal(digest(libBytes),old.files.find(row=>row[0]==="lib.rs")![1]);
      files.push(["lib.rs",digest(libBytes)]);
      const exports=new Map<string,string>();
      for(const match of libBytes.toString().matchAll(/pub use (\w+)::([^;]+);/g))for(const name of match[2].match(/\b[A-Z]\w*/g)??[])exports.set(name,match[1]);
      const codecBytes=await download(`https://raw.githubusercontent.com/RaoFoundation/subtensor/${release[1]}/vendor/frontier/precompiles/src/solidity/codec/mod.rs`);
      assert.match(codecBytes.toString(),/encode_arguments as encode_return_value/);files.push(["codec/mod.rs",digest(codecBytes)]);
      let count=0;
      for (const id of release[2]) {
        const precompile=catalogue.precompiles[id];
        if (!precompile[2].length) continue;
        const klass=[...exports.keys()].find(name=>name.replace(/Precompile(?=V\d+$|$)/,"")===precompile[0])!;
        assert.ok(klass,`${release[0]} ${precompile[0]} class`);
        const rustPath=exports.get(klass)!;
        let rust=rustCache.get(rustPath);
        if(!rust){const data=await download(`https://raw.githubusercontent.com/RaoFoundation/subtensor/${release[1]}/precompiles/src/${rustPath}.rs`);assert.equal(digest(data),old.files.find(row=>row[0]===`${rustPath}.rs`)![1]);rust=data.toString();rustCache.set(rustPath,rust);files.push([`${rustPath}.rs`,digest(data)]);}
        const starts=[...rust.matchAll(/#\[precompile_utils::precompile\]\s*impl(?:<[^>]+>)?\s+(\w+)/g)];
        const start=starts.find(row=>row[1]===klass)!;assert.ok(start,klass);
        const end=starts.find(row=>row.index!>start.index!)?.index??rust.length,body=rust.slice(start.index!,end);
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
          const publicStart=body.indexOf(`#[precompile::public("${fn[0]}")]`);
          assert.ok(publicStart>=0,`${release[0]} ${klass} ${fn[0]} Rust binding`);
          const declaration=/fn \w+\s*\([^]*?\)\s*->\s*EvmResult<([^]*?)>\s*\{/.exec(body.slice(publicStart));
          assert.ok(declaration,`${release[0]} ${klass} ${fn[0]} return`);
          const returnType=declaration[1].trim(),param=rustParam(returnType,rust);
          const actual=returnType==="()" ? [] : returnType.startsWith("(") ? param.components!:[param];
          let output=actual;
          if(matches.length===1 && JSON.stringify(matches[0].outputs.map(canonicalType))===JSON.stringify(actual.map(canonicalType)))output=matches[0].outputs.map(clean);
          else console.log("EVM_OUTPUT_SOURCE_CORRECTION",release[0],precompile[0],fn[0],JSON.stringify(actual.map(canonicalType)));
          console.log("EVM_OUTPUT_RUST_TYPE",returnType);
          const visit=(param:Param)=>{types.add(param.type);param.components?.forEach(visit);};output.forEach(visit);
          const key=JSON.stringify(output);
          let outputId=outputIds.get(key);
          if (outputId===undefined) {
            outputId=outputs.length;outputs.push(output);outputIds.set(key,outputId);
            const args=output.map(sample), iface=new Interface([{type:"function",name:fn[0].split("(")[0],stateMutability:"view",inputs:fn[0].slice(fn[0].indexOf("(")+1,-1).split(",").filter(Boolean).map(type=>({name:"",type})),outputs:output}]);
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
