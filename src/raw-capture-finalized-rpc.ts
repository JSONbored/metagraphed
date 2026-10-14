import {
  chainRpc,
  chainRpcBatch,
  type ChainRpcBatchCall,
} from "./chain-rpc.ts";
import type { ChainRpcAdmission } from "./chain-rpc-admission.ts";
import type { ChainNetworkId } from "./chain-network.ts";
import {
  RAW_CAPTURE_GENESIS,
  type RawCaptureCheckpoint,
  type CanonicalCaptureCheckpoint,
  type FinalizedAnchor,
} from "./raw-capture-provenance.ts";
import {
  substrateHash,
  substrateHeader,
  SUBSTRATE_ZERO_HASH,
} from "./substrate-header.ts";

interface Transport {
  fetchImpl: typeof fetch;
  admission?: ChainRpcAdmission;
}
async function hashes(
  url: string,
  calls: ChainRpcBatchCall[],
  transport: Transport,
): Promise<unknown[]> {
  const replies = await chainRpcBatch(url, calls, {
    ...transport,
    timeoutMs: 10_000,
  });
  return replies.map((reply) => {
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  });
}

/** Pin the endpoint's finalized assertion and check every existing durable anchor. */
export async function finalizedCaptureContext(
  url: string,
  network: ChainNetworkId,
  checkpoint: RawCaptureCheckpoint | null,
  floor: number,
  transport: Transport,
): Promise<{
  finalized: FinalizedAnchor;
  previousHash: string;
  previousHeight: number;
  genesis: string;
}> {
  const height = checkpoint?.height ?? floor - 1;
  if (!Number.isInteger(height) || height < -1 || height > 0xffff_ffff)
    throw new Error("Invalid raw capture predecessor");
  const genesis = RAW_CAPTURE_GENESIS[network];
  if (
    checkpoint?.genesis !== null &&
    checkpoint?.genesis !== undefined &&
    checkpoint.genesis !== genesis
  )
    throw new Error("Raw capture chain identity changed");
  const calls: ChainRpcBatchCall[] = [
    { method: "chain_getBlockHash", params: [0] },
    { method: "chain_getFinalizedHead", params: [] },
  ];
  if (height >= 0)
    calls.push({ method: "chain_getBlockHash", params: [height] });
  if (checkpoint?.genesis)
    calls.push({
      method: "chain_getBlockHash",
      params: [checkpoint.finalizedHeight],
    });
  const values = await hashes(url, calls, transport);
  if (substrateHash(values[0]) !== genesis)
    throw new Error("Raw capture endpoint genesis differs");
  const finalizedHash = substrateHash(values[1]);
  const previousHash =
    height < 0 ? SUBSTRATE_ZERO_HASH : substrateHash(values[2]);
  if (
    checkpoint?.genesis &&
    (previousHash !== checkpoint.hash ||
      substrateHash(values[height >= 0 ? 3 : 2]) !== checkpoint.finalizedHash)
  )
    throw new Error("Raw capture endpoint anchor differs");
  const header = substrateHeader(
    await chainRpc(url, "chain_getHeader", [finalizedHash], {
      ...transport,
      timeoutMs: 10_000,
    }),
  );
  if (header.hash !== finalizedHash)
    throw new Error("Raw capture finalized header hash differs");
  if (
    header.height < height ||
    (checkpoint?.finalizedHeight !== null &&
      checkpoint?.finalizedHeight !== undefined &&
      header.height < checkpoint.finalizedHeight)
  )
    throw new Error("Raw capture finalized head regressed");
  const checks: ChainRpcBatchCall[] = [
    { method: "chain_getBlockHash", params: [header.height] },
  ];
  if (!checkpoint?.genesis && height >= 0)
    checks.push({ method: "chain_getHeader", params: [previousHash] });
  const checked = await hashes(url, checks, transport);
  if (substrateHash(checked[0]) !== finalizedHash)
    throw new Error("Raw capture finalized canonical hash differs");
  if (checks.length > 1) {
    const predecessor = substrateHeader(checked[1]);
    if (predecessor.height !== height || predecessor.hash !== previousHash)
      throw new Error("Raw capture bootstrap header differs");
  }
  return {
    genesis,
    previousHash,
    previousHeight: height,
    finalized: { height: header.height, hash: finalizedHash },
  };
}

/** Requalify the actual predecessor before each chunk, including a failover. */
export async function qualifyCaptureEndpoint(
  url: string,
  checkpoint: CanonicalCaptureCheckpoint,
  finalized: FinalizedAnchor,
  transport: Transport,
): Promise<void> {
  if (
    finalized.height < checkpoint.finalizedHeight ||
    finalized.height < checkpoint.height
  )
    throw new Error("Raw capture finalized head regressed");
  const calls: ChainRpcBatchCall[] = [
    { method: "chain_getBlockHash", params: [0] },
    { method: "chain_getBlockHash", params: [finalized.height] },
  ];
  if (checkpoint.height >= 0)
    calls.push({ method: "chain_getBlockHash", params: [checkpoint.height] });
  calls.push({
    method: "chain_getBlockHash",
    params: [checkpoint.finalizedHeight],
  });
  const values = await hashes(url, calls, transport);
  if (
    substrateHash(values[0]) !== checkpoint.genesis ||
    substrateHash(values[1]) !== finalized.hash ||
    (checkpoint.height >= 0 && substrateHash(values[2]) !== checkpoint.hash) ||
    substrateHash(values[checkpoint.height >= 0 ? 3 : 2]) !==
      checkpoint.finalizedHash
  )
    throw new Error("Raw capture endpoint anchor differs");
}
