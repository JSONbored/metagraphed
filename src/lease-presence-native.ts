import { z } from "zod";
import { artifactBucket, type ArtifactStoreEnv } from "./projection-store.ts";
import type { ChainNetworkId } from "./chain-network.ts";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const Manifest = z.strictObject({
  version: z.literal(1),
  state: z.literal("complete"),
  network: z.enum(["mainnet", "testnet"]),
  table: z.literal("chain_events"),
  generation: hash,
  generatedAt: integer,
  sourceFiles: integer.max(32768),
  sourceRows: integer,
  source: z.strictObject({
    table_uuid: z.string().min(1),
    snapshot: z.string().regex(/^[0-9]+$/),
    sequence: integer,
    coverage: z.string().nullable(),
    identity: hash,
  }),
  counts: z.strictObject({
    SubnetLeaseCreated: integer,
    SubnetLeaseTerminated: integer,
  }),
});

/** Absence requires a complete retained-snapshot census. Once selected, an
 * invalid proof declines without falling back to a warehouse scan. */
export async function loadNativeLeasePresence(
  env: ArtifactStoreEnv | null | undefined,
  network: ChainNetworkId,
  now = Date.now(),
): Promise<boolean | null | undefined> {
  const bucket = artifactBucket(env);
  if (!bucket) return undefined;
  const root = `metagraph/lease-presence-native/v1/${network}`;
  try {
    const selected = await bucket.get(`${root}/current.json`);
    if (!selected) return undefined;
    if (
      typeof selected.size !== "number" ||
      selected.size <= 0 ||
      selected.size > 65536
    )
      return null;
    const manifest = Manifest.parse(await selected.json());
    const events =
      manifest.counts.SubnetLeaseCreated +
      manifest.counts.SubnetLeaseTerminated;
    if (
      manifest.network !== network ||
      manifest.generatedAt > now ||
      now - manifest.generatedAt > 2 * 60 * 60 * 1000 ||
      manifest.sourceRows < events ||
      manifest.sourceFiles > manifest.sourceRows ||
      (manifest.sourceFiles === 0 && manifest.sourceRows !== 0)
    )
      return null;
    const proof = await bucket.get(
      `${root}/${manifest.generation}/manifest.json`,
    );
    if (
      !proof ||
      proof.size !== selected.size ||
      JSON.stringify(Manifest.parse(await proof.json())) !==
        JSON.stringify(manifest)
    )
      return null;
    return events > 0;
  } catch {
    return null;
  }
}
