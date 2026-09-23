import { NativeTopHoldersFlowSchema } from "../schemas-src/projection-artifact.ts";
import type { ChainNetworkId } from "./chain-network.ts";
import {
  nativeProjectionsEnabled,
  NATIVE_PROJECTION_STALE_MS,
} from "./native-projection-store.ts";
import {
  readArtifactObject,
  type ArtifactStoreEnv,
} from "./projection-store.ts";

/** A selected native owner declines missing proof without re-entering SQL. */
export async function loadNativeTopHoldersFlow(
  env: ArtifactStoreEnv,
  network: ChainNetworkId,
  now: number,
) {
  if (!nativeProjectionsEnabled(env)) return undefined;
  const body = await readArtifactObject(
    env,
    "metagraph/projections/chain-stake-flow.json",
    network,
    NativeTopHoldersFlowSchema,
  );
  if (!body) return null;
  const generatedAt = Date.parse(body.generated_at);
  if (generatedAt > now || now - generatedAt > NATIVE_PROJECTION_STALE_MS)
    return null;
  return { generatedAt, rows: body.top_holders_flow_rows };
}
