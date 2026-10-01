import {NativeRuntimeRequestSchema} from "../../schemas-src/routes/native-runtime.ts";
import {boundedInternalJson} from "../../src/internal-json.ts";
import {queryNativeRuntime} from "../../src/native-runtime.ts";
import {networkKvKey,chainNetworkFromChainName} from "../../src/chain-network.ts";
import {resolveClientIp} from "../config.ts";
import {errorResponse} from "../http.ts";
import {dataResponse} from "../responses.ts";

export async function handleNativeRuntime(request:Request,env:Env) {
  if(request.method!=="POST")return errorResponse("method_not_allowed","POST a bounded native runtime request.",405,{}, {allow:"POST, OPTIONS"});
  let input;
  try {input=NativeRuntimeRequestSchema.parse(await boundedInternalJson(request,32_768));}
  catch {return errorResponse("invalid_params","Invalid native runtime request.",400);}
  const network=chainNetworkFromChainName(input.network);
  if(env.RPC_RATE_LIMITER?.limit){
    const {success}=await env.RPC_RATE_LIMITER.limit({key:networkKvKey(`native-runtime:${resolveClientIp(request)}`,network)});
    if(!success)return errorResponse("native_runtime_rate_limited","Too many native runtime requests; slow down.",429,{}, {"retry-after":"60"});
  }
  try {
    return dataResponse(env,await queryNativeRuntime(input));
  }catch {return errorResponse("native_runtime_failed","The finalized native runtime request could not be completed.",502);}
}
