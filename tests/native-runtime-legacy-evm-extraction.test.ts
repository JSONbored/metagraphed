// Temporary remote-only older release extraction; removed after verified handoff.
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
import eras from "./fixtures/native-runtime-legacy-compiled.ts";
import { NativeScaleReader, decodeNativeMetadata, NATIVE_RUNTIME_LIMITS, unwrapNativeMetadata } from "../src/native-runtime-metadata.ts";
import { evmRuntimeCatalogue as existing } from "../src/evm-runtime-catalogue.ts";
import { evmRuntimeOutputs as existingOutputs } from "../src/evm-runtime-outputs.ts";
import inputReference from "./fixtures/evm-runtime-reference.ts";
import outputReference from "./fixtures/evm-runtime-output-reference.ts";
type Param = { name: string; type: string; components?: Param[] };
type Function = { type: string; name: string; inputs: Param[]; outputs: Param[]; stateMutability: string };
const run = promisify(execFile);
async function download(url: string, maxBuffer = 250000) {
  const result = await run("curl", ["--fail", "--location", "--max-time", "30", "--silent", "--show-error", url], { maxBuffer, encoding: "buffer" });
  return result.stdout;
}
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const canonicalType = (param: Param): string => param.type.startsWith("tuple") ? `(${param.components!.map(canonicalType).join(",")})${param.type.slice(5)}` : param.type;
const dynamicOutput = (param: Param): boolean => param.type.endsWith("[]") || param.type === "bytes" || param.type === "string" || (param.type === "tuple" && param.components!.some(dynamicOutput));
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
function expandedRustType(raw:string,source:string):string {
  let type=raw.trim();
  for(let depth=0;depth<10;depth++) {
    if(!/^\w+$/.test(type))return type;
    const alias=new RegExp(`(?:pub\\s+)?type\\s+${type}\\s*=\\s*([^]*?);`).exec(source);
    if(!alias)return type;type=alias[1].trim();
  }
  throw new Error("Recursive Rust return alias");
}
function rustParam(raw:string,source:string,depth=0):Param {
  assert.ok(depth<10,raw);
  const type=expandedRustType(raw,source);
  const scalar:Record<string,string>={u8:"uint8",u16:"uint16",u32:"uint32",u64:"uint64",u128:"uint128",U256:"uint256",H256:"bytes32",Address:"address",bool:"bool",UnboundedBytes:"bytes",UnboundedString:"string",String:"string"};
  if(scalar[type])return {name:"",type:scalar[type]};
  if(type==="Bytes4"){assert.match(source,/pub struct Bytes4\(\[u8; 4\]\)/);assert.ok(source.includes("word[..4].copy_from_slice(&value.0)"));return {name:"",type:"bytes4"};}
  if(type.startsWith("(")&&type.endsWith(")"))return {name:"",type:"tuple",components:splitTypes(type.slice(1,-1)).map(row=>rustParam(row,source,depth+1))};
  const vector=/^Vec<([^]+)>$/.exec(type);
  if(vector){const item=rustParam(vector[1],source,depth+1);return {...item,type:item.type+"[]"};}
  const body=new RegExp(`(?:pub\\s+)?struct\\s+${type}\\s*\\{([^]*?)\\}`).exec(source);
  assert.ok(body,`Unknown Rust output ${type}`);
  const fields=body[1].replace(/\/\/[^\n]*/g,"");
  const components=splitTypes(fields).map(row=>{const match=/^(?:pub\s+)?(\w+)\s*:\s*([^]+)$/.exec(row);assert.ok(match,`${type} ${row}`);return {...rustParam(match[2],source,depth+1),name:match[1]};});
  assert.ok(components.length,type);return {name:"",type:"tuple",components};
}


const escape = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
async function optionalSource(url: string) {
  try { return await download(url); }
  catch (error) {
    if (String((error as {stderr?:unknown}).stderr).includes("404")) return null;
    throw error;
  }
}
function inputSample(type: string): unknown { return sample({name:"",type}); }

test("extract older published EVM addresses, actual Rust signatures and returns on remote CI", async () => {
  if (!process.env.CI) return;
  const scratch=await mkdtemp(join(tmpdir(),"legacy-evm-"));
  try {
    const metadata=JSON.parse((await download("https://registry.npmjs.org/ethers/6.15.0")).toString()) as {dist:{tarball:string;integrity:string}};
    assert.equal(metadata.dist.tarball,"https://registry.npmjs.org/ethers/-/ethers-6.15.0.tgz");
    assert.equal(metadata.dist.integrity,inputReference.reference.integrity);
    assert.equal(metadata.dist.integrity,outputReference.reference.integrity);
    const tar=await download(metadata.dist.tarball,4000000);
    assert.equal(`sha512-${createHash("sha512").update(tar).digest("base64")}`,metadata.dist.integrity);
    await writeFile(join(scratch,"ethers.tgz"),tar);
    execFileSync("tar",["xzf",join(scratch,"ethers.tgz"),"-C",scratch,"package/dist/ethers.min.js"]);
    await writeFile(join(scratch,"reference.mjs"),await readFile(join(scratch,"package/dist/ethers.min.js")));
    const {Interface,id}=await import(pathToFileURL(join(scratch,"reference.mjs")).href);
    const catalogue=structuredClone(existing), returns=structuredClone(existingOutputs);
    const input=structuredClone(inputReference), output=structuredClone(outputReference);
    const functionIds=new Map(catalogue.functions.map((entry,index)=>[JSON.stringify(entry),index]));
    const precompileIds=new Map(catalogue.precompiles.map((entry,index)=>[JSON.stringify(entry),index]));
    const outputIds=new Map(returns.outputs.map((entry,index)=>[JSON.stringify(entry),index]));
    const bindingIds=new Map(returns.bindings.map((entry,index)=>[JSON.stringify(entry),index]));
    const failures:{spec:number;message:string}[]=[];
    for(const era of eras) {
      try {
      const model=decodeNativeMetadata(new NativeScaleReader(unwrapNativeMetadata(era.v15)!, NATIVE_RUNTIME_LIMITS.metadataBytes));
      const hasEvm=model.pallets.some(pallet=>pallet.name==="EVM");
      if(!hasEvm) {
        assert.equal(era.spec,205);
        catalogue.releases.push([era.spec,era.commit,[]]);returns.releases.push([era.spec,era.commit,[]]);
        input.manifests.push({spec:era.spec,files:[],addresses:0,functions:0});output.manifests.push({spec:era.spec,files:[],functions:0});
        console.log("LEGACY_EVM_RELEASE",JSON.stringify({spec:era.spec,commit:era.commit,addresses:0,functions:0,metadata_evm:false}));continue;
      }
      const base=`https://raw.githubusercontent.com/RaoFoundation/subtensor/${era.commit}/`;
      let prefix="precompiles/src/",libPath="lib.rs",libBytes=await optionalSource(base+prefix+libPath);
      if(libBytes===null) {prefix="runtime/src/precompiles/";libPath="mod.rs";libBytes=await download(base+prefix+libPath);}
      const lib=libBytes.toString(), files:[string,string][]=[[prefix+libPath,digest(libBytes)]];
      const used=/fn used_addresses\(\)[^{]+\{\s*\[([^]*?)\]\s*\}/.exec(lib);
      assert.ok(used,`used addresses ${era.spec}`);
      const addresses=[...used[1].matchAll(/hash\(([^)]+)\)/g)].map(match=>match[1]);
      const exports=new Map<string,string>();
      for(const match of lib.matchAll(/(?:pub\s+)?use (?:crate::)?(\w+)::([^;]+);/g))for(const name of match[2].match(/\b[A-Z]\w*/g)??[])exports.set(name,match[1]);
      const modules=[...lib.matchAll(/^use (?:crate::)?(\w+)::\*;/gm)].map(match=>match[1]);
      const sources=new Map<string,string>(),abiCache=new Map<string,Function[]>();
      async function moduleSource(path:string) {
        let source=sources.get(path);
        if(source===undefined) {const bytes=await download(base+prefix+path+".rs");source=bytes.toString();sources.set(path,source);files.push([prefix+path+".rs",digest(bytes)]);}
        return source;
      }
      // Older wildcard exports are resolved against the actual compiled module declarations.
      for(const path of modules) {const source=await moduleSource(path);for(const match of source.matchAll(/pub(?:\([^)]*\))?\s+struct (\w+)/g))exports.set(match[1],path);}
      const entries:number[]=[],returnEntries:number[]=[];
      let count=0,manual=0;
      for(const address of addresses) {
        const dispatch=new RegExp(`a if a == hash\\(${escape(address)}\\) =>([^]*?)(?=a if|_ =>)`).exec(lib);
        assert.ok(dispatch,`${era.spec} dispatch ${address}`);
        const klass=address.includes("::") ? address.split("::")[0] : /Some\((\w+)(?:::<[^>]+>)?::execute/.exec(dispatch[1])?.[1];
        assert.ok(klass,`${era.spec} class ${address}`);
        assert.match(dispatch[1],new RegExp(`\\b${klass}(?:::<[^>]+>)?::(?:try_)?execute(?:::<[^>]+>)?\\(`),`${era.spec} compiled dispatcher ${klass}`);
        let index:number,rust="",path="";
        if(/^\d+$/.test(address))index=Number(address);
        else {
          path=exports.get(klass)!;assert.ok(path,`${era.spec} module ${klass}`);rust=await moduleSource(path);
          if(address.endsWith("::INDEX")) {
            const declaration=new RegExp(`\\bfor ${klass}(?=[<\\s{])[^]*?const INDEX:\\s*u64\\s*=\\s*(\\d+);`).exec(rust);
            assert.ok(declaration,`${era.spec} index ${klass}`);index=Number(declaration[1]);
          } else {const declaration=new RegExp(`const ${address}:\\s*u64\\s*=\\s*(\\d+);`).exec(rust);assert.ok(declaration,`${era.spec} constant ${address}`);index=Number(declaration[1]);}
        }
        const name=klass.replace(/Precompile(?=V\d+$|$)/,""),methodIds:number[]=[],outputBindings:[number,number][]=[];
        if(rust && !["Ed25519Verify","Sr25519Verify","StorageQueryPrecompile"].includes(klass)) {
          const starts=[...rust.matchAll(/#\[precompile_utils::precompile\]\s*impl(?:<[^>]+>)?\s+(\w+)/g)], start=starts.find(row=>row[1]===klass);
          const end=start ? starts.find(row=>row.index!>start.index!)?.index??rust.length : rust.length;
          const body=start ? rust.slice(start.index!,end):rust;
          const signatures=start ? [...body.matchAll(/#\[precompile::public\("([^"]+)"\)\]/g)].map(row=>row[1]):[...body.matchAll(/get_method_id\("([^"]+)"\)/g)].map(row=>row[1]);
          assert.ok(signatures.length,`${era.spec} ABI ${klass}`);assert.equal(new Set(signatures).size,signatures.length);
          const filename=name==="PrecompileRegistry" ? "registry":name[0].toLowerCase()+name.slice(1);
          let abi=abiCache.get(filename);
          if(!abi) {
            const abiPath=prefix+`solidity/${filename}.abi`,bytes=await optionalSource(base+abiPath);
            abi=[];
            if(bytes!==null) {
              files.push([abiPath,digest(bytes)]);
              try {abi=JSON.parse(bytes.toString()) as Function[];}
              catch(error) {if(!(error instanceof SyntaxError))throw error;console.log("LEGACY_EVM_RUST_ABI",JSON.stringify({spec:era.spec,path:abiPath,reason:"invalid published JSON",sha256:digest(bytes)}));}
            } else console.log("LEGACY_EVM_RUST_ABI",JSON.stringify({spec:era.spec,path:abiPath,reason:"missing published ABI"}));
            abiCache.set(filename,abi);
          }
          for(const signature of signatures) {
            const matches=abi.filter(row=>row.type==="function"&&`${row.name}(${row.inputs.map(canonicalType).join(",")})`===signature);
            let names:string[],actual:Param[],returnType="";
            if(start) {
              const publicStart=body.indexOf(`#[precompile::public("${signature}")]`);
              const declaration=/\bfn \w+\s*\(([^]*?)\)\s*->\s*EvmResult<([^]*?)>\s*\{/.exec(body.slice(publicStart));
              assert.ok(declaration,`${era.spec} ${klass} ${signature} declaration`);
              names=[...declaration[1].matchAll(/(?:^|[,\n])\s*(\w+)\s*:(?!:)/g)].map(row=>row[1]).slice(1);
              returnType=expandedRustType(declaration[2],rust);
              const param=rustParam(returnType,rust);
              actual=returnType==="()"?[]:returnType.startsWith("(")?param.components!:[param];
              if(matches.length===1&&(JSON.stringify(matches[0].outputs.map(canonicalType))===JSON.stringify(actual.map(canonicalType))||(returnType.startsWith("(")&&!dynamicOutput(param)&&matches[0].outputs.length===1&&canonicalType(matches[0].outputs[0])===canonicalType(param))))actual=matches[0].outputs.map(clean);
            } else {
              assert.equal(matches.length,1,`${era.spec} manual ABI ${signature}`);
              names=matches[0].inputs.map(param=>param.name);actual=matches[0].outputs.map(clean);manual++;
              const selected=new RegExp(`get_method_id\\("${escape(signature)}"\\)[^]*?Self::(\\w+)`).exec(body);
              const functionBody=(source:string,name:string)=>new RegExp(`fn ${name}\\([^]*?(?=\\n\\s*(?:pub )?fn |\\n})`).exec(source)?.[0];
              const implementation=functionBody(body,selected?.[1]??"execute");
              assert.ok(implementation,`${era.spec} manual implementation ${signature}`);
              if(actual.length===0) {
                const direct=[...implementation.matchAll(/output:\s*([^,\n]+)/g)];
                if(direct.length) assert.ok(direct.every(row=>["vec![]","Default::default()"].includes(row[1].trim())),`${era.spec} manual direct empty output ${signature}`);
                else {
                  const delegated=implementation.includes("try_dispatch_runtime_call(") ? functionBody(lib,"try_dispatch_runtime_call") : implementation.includes("Self::dispatch(") ? functionBody(body,"dispatch") : undefined;
                  assert.ok(delegated,`${era.spec} manual delegated output ${signature}`);
                  const outputs=[...delegated.matchAll(/output:\s*([^,\n]+)/g)];
                  assert.ok(outputs.length>0&&outputs.every(row=>["vec![]","Default::default()"].includes(row[1].trim())),`${era.spec} manual delegated empty output ${signature}`);
                }
              } else {
                assert.ok(["MetagraphPrecompile","StakingPrecompile","SubnetPrecompile","NeuronPrecompile"].includes(klass),`${era.spec} manual value ${klass}`);
                assert.ok(actual.every(param=>!dynamicOutput(param)),`${era.spec} manual static output ${signature}`);
                assert.ok(selected,`${era.spec} manual value dispatch ${signature}`);
                const staticWords=(param:Param):number=>param.type==="tuple"?param.components!.reduce((total,row)=>total+staticWords(row),0):1;
                const expectedBytes=actual.reduce((total,param)=>total+32*staticWords(param),0);
                if(actual.length===1&&actual[0].type==="bytes32") {
                  assert.match(implementation,/output: (?:hotkey|coldkey)\.as_slice\(\)\.into\(\)/);
                } else {
                  const arrays=[...implementation.matchAll(/let mut result = \[0_u8; (\d+)\]/g)];
                  assert.equal(arrays.length,1,`${era.spec} manual allocation ${signature}`);
                  assert.equal(Number(arrays[0][1]),expectedBytes,`${era.spec} manual size ${signature}`);
                  assert.match(implementation,/U256::to_big_endian/);
                  assert.match(implementation,/output: result\.into\(\)/);
                }
              }
            }
            const types=signature.slice(signature.indexOf("(")+1,-1).split(",").filter(Boolean);
            assert.equal(names.length,types.length,`${era.spec} ${signature} arity`);
            const fn:[string,string[],string]=[signature,names,id(signature).slice(0,10)],key=JSON.stringify(fn);
            let fnId=functionIds.get(key);
            if(fnId===undefined) {fnId=catalogue.functions.length;catalogue.functions.push(fn);functionIds.set(key,fnId);const args=types.map(inputSample),iface=new Interface([`function ${signature}`]);input.vectors.push([iface.encodeFunctionData(signature,args),args]);}
            methodIds.push(fnId);
            const outputKey=JSON.stringify(actual);let outputId=outputIds.get(outputKey);
            if(outputId===undefined) {
              outputId=returns.outputs.length;returns.outputs.push(actual);outputIds.set(outputKey,outputId);
              const args=actual.map(sample),iface=new Interface([{type:"function",name:signature.split("(")[0],stateMutability:"view",inputs:types.map(type=>({name:"",type})),outputs:actual}]);
              const encoded=iface.encodeFunctionResult(signature,args);assert.equal(iface.encodeFunctionResult(signature,iface.decodeFunctionResult(signature,encoded)),encoded);
              output.vectors.push([encoded,actual.map((param,i)=>jsonValue(param,args[i]))]);
            }
            outputBindings.push([fnId,outputId]);count++;
          }
        }
        assert.equal(new Set(methodIds.map(id=>catalogue.functions[id][2])).size,methodIds.length);
        const precompile:[string,number,number[]]=[name,index,methodIds],key=JSON.stringify(precompile);let precompileId=precompileIds.get(key);
        if(precompileId===undefined){precompileId=catalogue.precompiles.length;catalogue.precompiles.push(precompile);precompileIds.set(key,precompileId);}entries.push(precompileId);
        if(methodIds.length) {const binding:[number,[number,number][]]=[precompileId,outputBindings],key=JSON.stringify(binding);let bindingId=bindingIds.get(key);if(bindingId===undefined){bindingId=returns.bindings.length;returns.bindings.push(binding);bindingIds.set(key,bindingId);}returnEntries.push(bindingId);}
      }
      assert.equal(new Set(entries.map(id=>catalogue.precompiles[id][1])).size,entries.length);
      catalogue.releases.push([era.spec,era.commit,entries]);returns.releases.push([era.spec,era.commit,returnEntries]);
      input.manifests.push({spec:era.spec,files:files.sort(),addresses:entries.length,functions:count});output.manifests.push({spec:era.spec,files:files.sort(),functions:count});
      console.log("LEGACY_EVM_RELEASE",JSON.stringify({spec:era.spec,commit:era.commit,source:prefix,addresses:entries.length,functions:count,manual,metadata_evm:true}));
      } catch(error) {
        const message=String(error instanceof Error ? error.message : error).slice(0,240);
        failures.push({spec:era.spec,message});console.log("LEGACY_EVM_EXTRACTION_FAILURE",JSON.stringify({spec:era.spec,commit:era.commit,message}));
      }
    }
    assert.deepEqual(failures,[],"Every older compiled EVM source must qualify before generation");
    assert.equal(catalogue.releases.length,90);assert.equal(returns.releases.length,90);
    assert.deepEqual(catalogue.releases.slice(0,25),existing.releases);assert.deepEqual(returns.releases.slice(0,25),existingOutputs.releases);
    function fixture(value:unknown,annotation:string,type:string) {
      const data=brotliCompressSync(Buffer.from(JSON.stringify(value)),{params:{[constants.BROTLI_PARAM_QUALITY]:6}}).toString("base64");
      return `// ${annotation}\nimport { brotliDecompressSync } from "node:zlib";\nconst compressed=[${data.match(/.{1,120}/g)!.map(part=>JSON.stringify(part)).join(",")}].join("");\nexport default JSON.parse(brotliDecompressSync(Buffer.from(compressed,"base64")).toString()) as ${type};\n`;
    }
    const generated:[string,string][]=[
      ["src/evm-runtime-catalogue.ts",`// Official published release-bound input ABIs, independently qualified on remote CI.\n// Shared entries preserve historical signatures and modern release behavior.\nexport const evmRuntimeCatalogue: { functions: [string,string[],string][]; precompiles:[string,number,number[]][];releases:[number,string,number[]][] }=${JSON.stringify(catalogue)};\n`],
      ["src/evm-runtime-outputs.ts",`// Official published release-bound Rust return layouts, qualified on remote CI.\nexport type RuntimeEvmOutput={name:string;type:string;components?:RuntimeEvmOutput[]};\nexport const evmRuntimeOutputs:{outputs:RuntimeEvmOutput[][];bindings:[number,[number,number][]][];releases:[number,string,number[]][]}=${JSON.stringify(returns)};\n`],
      ["tests/fixtures/evm-runtime-reference.ts",fixture(input,"Independent ethers input vectors and compiled-source provenance.","{reference:{version:string;integrity:string};vectors:[string,unknown[]][];manifests:{spec:number;files:[string,string][];addresses:number;functions:number}[]}")],
      ["tests/fixtures/evm-runtime-output-reference.ts",fixture(output,"Independent ethers output vectors and compiled-source provenance.","{reference:{version:string;integrity:string};vectors:[string,unknown[]][];manifests:{spec:number;files:[string,string][];functions:number}[]}")]
    ];
    for(const [path,raw] of generated) {const data=Buffer.from(await format(raw,{...(await resolveConfig(path)),filepath:path})),encoded=gzipSync(data).toString("base64");console.log("LEGACY_EVM_FILE",path,data.length,digest(data));for(let offset=0;offset<encoded.length;offset+=16000)console.log("LEGACY_EVM_DATA",path,offset/16000,encoded.slice(offset,offset+16000));}
  } finally {await rm(scratch,{recursive:true,force:true});}
},1200000);
