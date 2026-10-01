import { rpcUrlForNetwork, type ChainNetworkId } from "./chain-network.ts";
import { chainRpc, chainRpcBatch } from "./chain-rpc.ts";
import { NATIVE_RUNTIME_LIMITS } from "./native-runtime-metadata.ts";
import type { BasketRpc } from "./root-basket-runtime.ts";

const METHODS=new Set(["chain_getFinalizedHead","chain_getHeader","chain_getBlockHash","state_getRuntimeVersion","state_getMetadata","state_getStorage","state_getStorageHash","state_getKeysPaged","state_call"]);
/** Existing correlated transport and trusted endpoints; the byte budget is
 * sized for native metadata, independently of the smaller basket contract. */
export function nativeRuntimeRpc(network:ChainNetworkId,fetchImpl:typeof fetch=fetch):BasketRpc{
  const url=rpcUrlForNetwork(network);
  const options={fetchImpl,timeoutMs:5000,maxResponseBytes:2*NATIVE_RUNTIME_LIMITS.metadataBytes+65_536};
  const validate=(method:string)=>{if(!METHODS.has(method))throw new Error("Native RPC is read-only");};
  const read:BasketRpc=async(method,params)=>{validate(method);return chainRpc(url,method,params,options);};
  read.batch=async(calls)=>{
    if(calls.length>16)throw new Error("Native RPC batch exceeds work budget");
    calls.forEach((call)=>validate(call.method));
    const values=await chainRpcBatch(url,calls,options);
    return values.map((value)=>{if(!value.ok)throw new Error("Native RPC batch failed");return value.result;});
  };
  return read;
}
