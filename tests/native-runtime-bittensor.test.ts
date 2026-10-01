import assert from "node:assert/strict";
import {test} from "vitest";
import {Metadata} from "@polkadot/types/metadata";
import {queryNativeRuntime} from "../src/native-runtime.ts";
import {decodeNativeMetadata} from "../src/native-runtime-metadata.ts";
import {decodeNativeValue,nativeStorageKey} from "../src/native-runtime-values.ts";
import {bittensorNativeFixture} from "./fixtures/native-bittensor.ts";
import type {BasketRpc} from "../src/root-basket-runtime.ts";

test("v470 mechanism, collateral, dynamic hyperparameter and lock contracts decode independently encoded bytes",async()=>{
  const {metadata,wrapped,registry}=bittensorNativeFixture();
  const reference=new Metadata(registry,metadata);
  const model=decodeNativeMetadata(metadata);
  assert.equal(reference.asV15.pallets[0]!.name.toString(),"SubtensorModule");
  const account=`0x${"12".repeat(32)}`,hash=`0x${"33".repeat(32)}`;
  const collateral={locked:"9007199254740993",drain_ratio:"18446744073709551616",min_locked:"100",earned:"18446744073709551615"};
  const lock={locked_mass:"9007199254740993",conviction:"18446744073709551617",last_update:"500"};
  const hyperparams=registry.createType("Option<Vec<HyperparamEntry>>",[
    {name:"0x636f6c6c61746572616c5f6c6f636b5f7368617265",value:{U16:65535}},
    {name:"0x6e65775f72756e74696d655f6669656c64",value:{U128:"340282366920938463463374607431768211455"}},
    {name:"0x66697865645f706f6c696379",value:{U64F64:"18446744073709551617"}},
  ]).toHex();
  const pallet=model.pallets[0]!;
  const storage=new Map<string,string>();
  for(const [name,args,type,value] of [
    ["MechanismCountCurrent",[19],"MechId",2],
    ["MechanismEmissionSplit",[19],"Vec<u16>",[32767,32768]],
    ["CollateralLockShare",[19],"u16",65535],
    ["CollateralDrainRatio",[19],"U64F64","18446744073709551617"],
    ["MinerCollateral",[19,account,account],"MinerCollateralState",collateral],
  ] as const){
    const item=pallet.storage.find((row)=>row.name===name)!;
    const encoded=registry.createType(type,value).toHex();
    storage.set(nativeStorageKey(model,pallet.prefix,item,[...args]),encoded);
    assert.deepEqual(decodeNativeValue(model,item.value,encoded),typeof value==="number"?String(value):Array.isArray(value)?value.map(String):value);
  }
  const calls:{method:string;params:unknown[]}[]=[];
  const rpc:BasketRpc=async(method,params)=>{
    calls.push({method,params});
    switch(method){
      case "chain_getFinalizedHead":return hash;
      case "chain_getHeader":return {number:"0x1f4"};
      case "chain_getBlockHash":return `0x${"44".repeat(32)}`;
      case "state_getRuntimeVersion":return {specName:"node-subtensor",specVersion:470,transactionVersion:1};
      case "state_getStorage":assert.ok(storage.has(String(params[0])));return storage.get(String(params[0]));
      case "state_call":
        if(params[0]==="Metadata_metadata_at_version")return wrapped;
        if(params[0]==="SubnetInfoRuntimeApi_get_subnet_hyperparams_v3"){assert.equal(params[1],"0x1300");return hyperparams;}
        if(params[0]==="StakeInfoRuntimeApi_get_coldkey_lock"){assert.equal(params[1],account+"1300");return registry.createType("Option<LockState>",lock).toHex();}
        throw new Error("Unexpected runtime call");
      default:throw new Error("Unexpected RPC method");
    }
  };
  const result=await queryNativeRuntime({operations:[
    ...pallet.storage.map((item)=>({kind:"storage",pallet:"SubtensorModule",member:item.name,args:item.name==="MinerCollateral"?[19,account,account]:[19]})),
    {kind:"runtime",api:"SubnetInfoRuntimeApi",member:"get_subnet_hyperparams_v3",args:[19]},
    {kind:"runtime",api:"StakeInfoRuntimeApi",member:"get_coldkey_lock",args:[account,19]},
  ]},rpc);
  assert.deepEqual(result.results[4]!.value,collateral);
  assert.deepEqual(result.results[6]!.value,{variant:"Some",fields:lock});
  assert.deepEqual(result.results[5]!.value,{variant:"Some",fields:[
    {name:"0x636f6c6c61746572616c5f6c6f636b5f7368617265",value:{variant:"U16",fields:"65535"}},
    {name:"0x6e65775f72756e74696d655f6669656c64",value:{variant:"U128",fields:"340282366920938463463374607431768211455"}},
    {name:"0x66697865645f706f6c696379",value:{variant:"U64F64",fields:"18446744073709551617"}},
  ]});
  assert.ok(calls.filter((row)=>row.method==="state_getStorage").every((row)=>row.params[1]===hash));
});
