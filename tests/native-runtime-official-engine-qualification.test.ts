// Temporary remote-only official compiled-runtime execution qualification.
// No chain endpoint, production state, container, dependency or service is used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { test } from "vitest";
import { decompress } from "fzstd";
import { blake2b } from "@noble/hashes/blake2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { decodeNativeMetadata, unwrapNativeMetadata } from "../src/native-runtime-metadata.ts";
import { encodeNativeValue, nativeHex, nativeCompact, nativeStorageKey, type NativeValue } from "../src/native-runtime-values.ts";
import { xxh64 } from "../src/twox-storage-key.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import { sampleNativeValue } from "./fixtures/native-compiled-values.ts";
import eras from "./fixtures/native-runtime-eras-compiled.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const era = eras.find(row => row.spec === 471)!;
const model = decodeNativeMetadata(unwrapNativeMetadata(era.v15)!);
const sample = (id: number) => sampleNativeValue(model, id);
const hash = `0x${"33".repeat(32)}`;
const origin = `0x${"11".repeat(32)}`;
const from = `0x${"11".repeat(20)}`;
const target = `0x${"22".repeat(20)}`;

async function compiledRuntime() {
  const blob = execFileSync("curl", ["--fail", "--location", "--max-time", "30", "--silent", "--show-error", "https://github.com/RaoFoundation/subtensor/releases/download/v471/subtensor.wasm"], { maxBuffer: 8 * 1024 * 1024 });
  assert.equal(sha(blob), era.wasm_sha256);
  assert.ok(blob.subarray(0,8).equals(Buffer.from([82,188,83,118,70,219,142,5])));
  const wasm = decompress(blob.subarray(8));
  assert.ok(wasm.length < 50 * 1024 * 1024);
  const module = await WebAssembly.compile(wasm);
  let memory = new WebAssembly.Memory({initial:64,maximum:2048});
  let instance: WebAssembly.Instance;
  let heap = 0, totalHostCalls = 0;
  let state = new Map<string, Buffer>();
  const transactions: Map<string,Buffer>[] = [];
  const hostCalls: Record<string,number> = {};
  const malloc = (length: number) => {
    assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= 2 * 1024 * 1024);
    if (!heap) {const base=instance.exports.__heap_base;assert.ok(base instanceof WebAssembly.Global);heap=Number(base.value);}
    const ptr=Math.ceil(heap/8)*8+8;heap=ptr+Math.max(length,8);
    assert.ok(heap <= 100 * 1024 * 1024);
    if(heap>memory.buffer.byteLength) memory.grow(Math.ceil((heap-memory.buffer.byteLength)/65536));
    return ptr;
  };
  const span = (value: number|bigint) => ({ptr:Number(BigInt(value)&0xffffffffn),size:Number(BigInt(value)>>32n)});
  const bytes = (value: number|bigint) => {const {ptr,size}=span(value);assert.ok(size>=0&&size<=2*1024*1024&&ptr+size<=memory.buffer.byteLength);return Buffer.from(new Uint8Array(memory.buffer,ptr,size));};
  const put = (value: Uint8Array) => {const ptr=malloc(value.length);new Uint8Array(memory.buffer,ptr,value.length).set(value);return ptr;};
  const packed = (value: Uint8Array) => BigInt(put(value)) | BigInt(value.length)<<32n;
  const option = (value: Buffer|undefined) => packed(value===undefined?Buffer.from([0]):Buffer.concat([Buffer.from([1]),nativeCompact(BigInt(value.length)),value]));
  const hashWords = (value: Uint8Array,count: number) => Buffer.concat(Array.from({length:count},(_,i)=>{const out=Buffer.alloc(8);out.writeBigUInt64LE(xxh64(value,BigInt(i)));return out;}));
  const imports: Record<string,Record<string,WebAssembly.ImportValue>>={};
  for(const item of WebAssembly.Module.imports(module)) {
    const group=imports[item.module]??={};
    if(item.kind==="memory") group[item.name]=memory;
    else if(item.kind==="function") group[item.name]=(...args:(number|bigint)[])=>{
      assert.ok(++totalHostCalls<=100000);
      hostCalls[item.name]=(hostCalls[item.name]??0)+1;
      if(item.name==="ext_allocator_malloc_version_1")return malloc(Number(args[0]));
      if(item.name==="ext_allocator_free_version_1")return;
      if(item.name==="ext_logging_max_level_version_1")return 0;
      // The official host ABI returns u64::MAX when proof recording is disabled.
      // This in-memory fixture does not claim trie-proof or production gas costs.
      if(item.name==="ext_storage_proof_size_storage_proof_size_version_1")return -1n;
      if(item.name==="ext_storage_get_version_1")return option(state.get(bytes(args[0]!).toString("hex")));
      if(item.name==="ext_storage_read_version_1") {
        const value=state.get(bytes(args[0]!).toString("hex"));if(value===undefined)return packed(Buffer.from([0]));
        const out=span(args[1]!);const offset=Number(args[2]);assert.ok(offset>=0);
        const remaining=Math.max(0,value.length-offset);new Uint8Array(memory.buffer,out.ptr,Math.min(out.size,remaining)).set(value.subarray(offset,offset+out.size));
        const result=Buffer.alloc(5);result[0]=1;result.writeUInt32LE(remaining,1);return packed(result);
      }
      if(item.name==="ext_storage_set_version_1") {state.set(bytes(args[0]!).toString("hex"),bytes(args[1]!));assert.ok(state.size<=1024);return;}
      if(item.name==="ext_storage_clear_version_1") {state.delete(bytes(args[0]!).toString("hex"));return;}
      if(item.name==="ext_storage_exists_version_1")return state.has(bytes(args[0]!).toString("hex"))?1:0;
      if(item.name==="ext_storage_next_key_version_1") {const key=bytes(args[0]!).toString("hex");const next=[...state.keys()].sort().find(row=>row>key);return option(next===undefined?undefined:Buffer.from(next,"hex"));}
      if(item.name==="ext_storage_start_transaction_version_1") {assert.ok(transactions.length<32);transactions.push(new Map(state));return;}
      if(item.name==="ext_storage_rollback_transaction_version_1") {assert.ok(transactions.length);state=transactions.pop()!;return;}
      if(item.name==="ext_storage_commit_transaction_version_1") {assert.ok(transactions.length);transactions.pop();return;}
      if(item.name==="ext_hashing_blake2_128_version_1")return put(blake2b(bytes(args[0]!),{dkLen:16}));
      if(item.name==="ext_hashing_blake2_256_version_1")return put(blake2b(bytes(args[0]!),{dkLen:32}));
      if(item.name==="ext_hashing_keccak_256_version_1")return put(keccak_256(bytes(args[0]!)));
      if(item.name==="ext_hashing_sha2_256_version_1")return put(createHash("sha256").update(bytes(args[0]!)).digest());
      if(item.name==="ext_hashing_twox_64_version_1")return put(hashWords(bytes(args[0]!),1));
      if(item.name==="ext_hashing_twox_128_version_1")return put(hashWords(bytes(args[0]!),2));
      if(item.name==="ext_hashing_twox_256_version_1")return put(hashWords(bytes(args[0]!),4));
      throw new Error(`Unimplemented required compiled execution host: ${item.name}`);
    };
    else throw new Error(`Unsupported import ${item.kind} ${item.name}`);
  }
  instance=await WebAssembly.instantiate(module,imports);
  if(instance.exports.memory instanceof WebAssembly.Memory)memory=instance.exports.memory;
  const invoke=(name:string,input:Uint8Array)=>{
    const call=instance.exports[name];assert.equal(typeof call,"function",name);
    const ptr=put(input),before=new Map(state);const result=(call as CallableFunction)(ptr,input.length);
    assert.equal(transactions.length,0,"compiled API must balance every storage transaction");
    const returned=bytes(result);state=before;return nativeHex(returned);
  };
  const setStorage=(palletName:string,itemName:string,args:NativeValue[],value:NativeValue)=>{
    const pallet=model.pallets.find(row=>row.name===palletName)!;assert.ok(pallet,palletName);
    const item=pallet.storage.find(row=>row.name===itemName)!;assert.ok(item,itemName);
    state.set(nativeStorageKey(model,pallet.prefix,item,args).slice(2),Buffer.from(encodeNativeValue(model,item.value,value)));
  };
  setStorage("System","Number",[],"500");
  let executions=0;
  const rpc:BasketRpc=async(method,params=[])=>{
    if(method==="chain_getFinalizedHead")return hash;
    if(method==="chain_getHeader")return {number:"0x1f4"};
    if(method==="chain_getBlockHash")return `0x${"44".repeat(32)}`;
    if(method==="state_getRuntimeVersion")return era.runtimeVersion;
    if(method==="state_getStorageHash")return nativeHex(blake2b(blob,{dkLen:32}));
    if(method==="state_call"&&params[0]==="Metadata_metadata_at_version")return era.v15;
    if(method==="state_call") {executions++;assert.match(String(params[0]),/^(EthereumRuntimeRPCApi|ContractsApi)_/);return invoke(String(params[0]),Buffer.from(String(params[1]).slice(2),"hex"));}
    if(method==="state_getStorage")return nativeHex(state.get(String(params[0]).slice(2))??Buffer.from([0]));
    throw new Error(`Unexpected fixture RPC ${method}`);
  };
  return {rpc,setStorage,hostCalls,get executions(){return executions;},stateKeys:()=>state.size};
}

const evmArgs = (to: string) => model.apis.find(row=>row.name==="EthereumRuntimeRPCApi")!.methods.find(row=>row.name==="call")!.inputs.map(field=>
  field.name==="from" ? from : field.name==="to" ? to : field.name==="data" ? "0x" : field.name==="value" ? ["0","0","0","0"] : field.name==="gas_limit" ? ["100000","0","0","0"] : field.name==="estimate" ? false : sample(field.type),
);

test("official compiled v471 executes exact EVM return, revert and typed timestamp precompile in isolated fixture state", async()=>{
  if(!process.env.CI)return;
  const runtime=await compiledRuntime();
  runtime.setStorage("EVM","AccountCodes",[target],"0x602a60005260206000f3");
  const operation={kind:"runtime",api:"EthereumRuntimeRPCApi",member:"call",args:evmArgs(target)};
  const returned=await queryNativeRuntime({operations:[operation,operation]},runtime.rpc);
  const value=returned.results[0]!.value as {variant:string;fields:{value:string;exit_reason:{variant:string;fields:{variant:string}}}};
  assert.equal(value.variant,"Ok");assert.equal(value.fields.exit_reason.variant,"Succeed");assert.equal(value.fields.exit_reason.fields.variant,"Returned");
  assert.equal(value.fields.value,`0x${"2a".padStart(64,"0")}`);
  assert.deepEqual(returned.results[0],returned.results[1]);assert.equal(runtime.executions,1);
  runtime.setStorage("EVM","AccountCodes",[target],"0x60006000fd");
  const reverted=await queryNativeRuntime({operations:[operation]},runtime.rpc);
  const revert=reverted.results[0]!.value as {variant:string;fields:{exit_reason:{variant:string}}};
  assert.equal(revert.variant,"Ok");assert.equal(revert.fields.exit_reason.variant,"Revert");
  const to="0x0000000000000000000000000000000000000811";
  const precompile=await queryNativeRuntime({operations:[{...operation,args:evmArgs(to),evm_call:{signature:"getTimestamp()",args:[]}}]},runtime.rpc);
  assert.deepEqual(precompile.results[0]!.evm_result,{status:"decoded",values:["0"]});
  assert.equal(runtime.executions,3);
  console.log("NATIVE_OFFICIAL_EVM_ENGINE_FIXTURE",JSON.stringify({head:execFileSync("git",["rev-parse","HEAD"]).toString().trim(),spec:471,commit:era.commit,wasm_sha256:era.wasm_sha256,cases:3,duplicate_execution_count:1,return_word:"42",revert_preserved:true,typed_timestamp:"0",fixture_state_keys:runtime.stateKeys(),host_calls:runtime.hostCalls,fixture:true,production:false,chain_requests:0}));
},180000);

function simpleContract() {
  // WASM section lengths and vectors use unsigned LEB128, not SCALE compact.
  const leb=(value:number)=>{const out:number[]=[];do{let byte=value&127;value>>>=7;if(value)byte|=128;out.push(byte);}while(value);return out;};
  const name=(text:string)=>{const bytes=[...Buffer.from(text)];return [...leb(bytes.length),...bytes];};
  const section=(id:number,value:number[])=>[id,...leb(value.length),...value];
  const body=[0,0x41,0,0x41,0,0x41,0,0x10,0,0x0b];
  // Two exports invoke seal_return(0,0,0); no user data, writes or external call.
  return nativeHex(Uint8Array.from([
    0,97,115,109,1,0,0,0,
    ...section(1,[2,0x60,3,0x7f,0x7f,0x7f,0,0x60,0,0]),
    ...section(2,[2,...name("seal0"),...name("seal_return"),0,0,...name("env"),...name("memory"),2,1,16,16]),
    ...section(3,[2,1,1]),
    ...section(7,[2,...name("deploy"),0,1,...name("call"),0,2]),
    ...section(10,[2,...leb(body.length),...body,...leb(body.length),...body]),
  ]));
}

test("official compiled v471 accepts and instantiates a valid minimal Wasm contract in isolated fixture state",async()=>{
  if(!process.env.CI)return;
  const runtime=await compiledRuntime();
  const account=model.pallets.find(row=>row.name==="System")!.storage.find(row=>row.name==="Account")!;
  const info=sample(account.value) as {providers:NativeValue;data:{free:NativeValue;flags?:NativeValue}};
  info.providers=1;info.data.free="1000000000000000";if(info.data.flags!==undefined)info.data.flags=(1n<<127n).toString();
  runtime.setStorage("System","Account",[origin],info);runtime.setStorage("Balances","TotalIssuance",[],"1000000000000000");
  const code=simpleContract();const none={variant:"None",fields:{}};
  const uploaded=await queryNativeRuntime({operations:[{kind:"runtime",api:"ContractsApi",member:"upload_code",args:[origin,code,none,{variant:"Enforced",fields:{}}]}]},runtime.rpc);
  const upload=uploaded.results[0]!.value as {variant:string;fields:{code_hash:string;deposit:string}};
  assert.equal(upload.variant,"Ok");assert.equal(upload.fields.code_hash,nativeHex(blake2b(Buffer.from(code.slice(2),"hex"),{dkLen:32})));assert.ok(BigInt(upload.fields.deposit)>0n);
  const instantiated=await queryNativeRuntime({operations:[{kind:"runtime",api:"ContractsApi",member:"instantiate",args:[origin,"0",{variant:"Some",fields:{ref_time:"50000000000",proof_size:"65536"}},none,{variant:"Upload",fields:code},"0x","0x"]}]},runtime.rpc);
  const value=instantiated.results[0]!.value as {result:{variant:string;fields:{result:{flags:NativeValue;data:string};account_id:string}}};
  assert.equal(value.result.variant,"Ok");assert.equal(value.result.fields.result.data,"0x");assert.equal(String(value.result.fields.result.flags),"0");assert.match(value.result.fields.account_id,/^0x[0-9a-f]{64}$/);
  console.log("NATIVE_OFFICIAL_WASM_ENGINE_FIXTURE",JSON.stringify({head:execFileSync("git",["rev-parse","HEAD"]).toString().trim(),spec:471,commit:era.commit,wasm_sha256:era.wasm_sha256,cases:2,contract_bytes:(code.length-2)/2,valid_upload:true,constructor_return:"0x",fixture_state_keys:runtime.stateKeys(),host_calls:runtime.hostCalls,fixture:true,production:false,chain_requests:0}));
},180000);
