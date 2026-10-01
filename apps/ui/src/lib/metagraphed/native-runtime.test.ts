import { expect, test } from "vitest";
import { describedMembers, featureOperations, memberOperation, nativeTypeLabel, nativeValueRows, nativePageOffset, type NativeArtifact } from "./native-runtime";

const key=`0x${"12".repeat(32)}`;
const artifact:NativeArtifact={schema_version:1,source:{network:"finney",network_genesis_hash:key,finalized_block_hash:key,finalized_block:"500",runtime_spec_version:470,runtime_transaction_version:1,metadata_version:15,metadata_sha256:key},types:[{id:0,path:[],definition:{kind:"primitive",primitive:6}},{id:1,path:["NetUid"],definition:{kind:"composite",fields:[{name:null,type:0}]}},{id:2,path:[],definition:{kind:"tuple",types:[0,1]}}],results:[]};
test("feature inputs preserve upstream key order and exact values",()=>{
  expect(featureOperations("mechanisms","19").map((row)=>"member" in row?row.member:null)).toEqual(["MechanismCountCurrent","MechanismEmissionSplit"]);
  expect(featureOperations("collateral","19").map((row)=>"member" in row?row.member:null)).toEqual(["CollateralLockShare","CollateralDrainRatio"]);
  expect(featureOperations("hyperparameters","19")[0]).toMatchObject({api:"SubnetInfoRuntimeApi",member:"get_subnet_hyperparams_v3",args:[19]});
  expect(featureOperations("lock","19",key)[0]).toMatchObject({args:[key,19]});
  expect(featureOperations("auto-stake","19",key)[0]).toMatchObject({args:[key,19]});
  expect(featureOperations("pending-children","19","",key)[0]).toMatchObject({args:[19,key]});
  expect(featureOperations("miner-collateral","19",key,key)[0]).toMatchObject({args:[19,key,key]});
  for(const netuid of ["","-1","01","65536","1.5","1e3"])
    expect(()=>featureOperations("mechanisms",netuid)).toThrow(/subnet number/);
  expect(()=>featureOperations("lock","0","invalid")).toThrow(/public key/);
});
test("storage map arguments respect single tuple keys and multiple hashers",()=>{
  const rows=describedMembers({...artifact,results:[{kind:"describe",contract:{next_offset:32},value:[{kind:"storage",pallet:"P",member:"One",key_type:2,key_parts:1},{kind:"storage",pallet:"P",member:"Two",key_type:2,key_parts:2},{kind:"storage",pallet:"P",member:"Plain",key_type:null,key_parts:0},{kind:"runtime",api:"A",member:"Read",args:[{name:"amount",type:0}]},{kind:"prepare",pallet:"P",member:"Call",args:[{name:null,type:1}]},{kind:"constant",pallet:"P",member:"C"},null,{kind:"api",name:"A"}]}]});
  expect(rows.map((row)=>row.args.map((arg)=>arg.type))).toEqual([[2],[0,1],[],[0],[1],[]]);
  expect(memberOperation(rows[0],'[["9007199254740993","19"]]')).toMatchObject({kind:"storage",args:[["9007199254740993","19"]]});
  expect(memberOperation(rows[3],'["9007199254740993"]')).toEqual({kind:"runtime",api:"A",member:"Read",args:["9007199254740993"]});
  expect(memberOperation(rows[4],'["19"]')).toMatchObject({kind:"prepare",args:["19"]});
  expect(memberOperation(rows[5],'[]')).toEqual({kind:"constant",pallet:"P",member:"C"});
  for(const text of ["{}","[]","[9007199254740993]","[1e400]","[[1e400]]",'{'.repeat(32769)]) expect(()=>memberOperation(rows[3],text)).toThrow();
  expect(describedMembers(artifact)).toEqual([]);
  expect(nativeTypeLabel(artifact,0)).toBe("u64");
  expect(nativeTypeLabel(artifact,1)).toBe("NetUid");
  expect(nativeTypeLabel(artifact,2)).toBe("tuple (type 2)");
  expect(nativeTypeLabel(artifact,99)).toBe("Type 99");
  expect(nativePageOffset(artifact)).toBeNull();
  expect(nativePageOffset({...artifact,results:[{kind:"describe",contract:{next_offset:32}}]})).toBe(32);
});
test("result tables retain every exact field, enum tag, empty value and unsigned byte",()=>{
  const rows=nativeValueRows({...artifact,results:[{kind:"storage",pallet:"P",member:"Lock",contract:{},value:{amount:"9007199254740993",variant:"None",fields:{},optional:null,items:[]}},{kind:"prepare",pallet:"P",member:"Call",contract:{},call_data:"0x0102"}]});
  expect(rows.map((row)=>row.value)).toEqual(["9007199254740993","None","{}","Absent","[]","0x0102"]);
  expect(new Set(rows.map((row)=>row.key)).size).toBe(rows.length);
});
