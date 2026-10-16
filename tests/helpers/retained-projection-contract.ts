import { readFileSync } from "node:fs";
import type { ChainNetworkId } from "../../src/chain-network.ts";
import type { NativeProjectionManifest } from "../../src/native-projection-store.ts";

type RetainedProof = NonNullable<
  NativeProjectionManifest["sources"][number]["retainedBlocks"]
>;
interface ProducerCase {
  network: ChainNetworkId;
  scenario: string;
  plan: { retainedBlocks: RetainedProof };
  manifest: NativeProjectionManifest;
  readback: {
    rows: { key: string; payload: string }[];
    expectedBody: unknown;
  };
}

// Exported by the private producer's real retained plan and D1 publication
// methods on native CI. Every identity and physical row is synthetic.
export const retainedProjectionCases: ProducerCase[] = JSON.parse(
  readFileSync(
    new URL("../fixtures/native-projections/retained-contract.json", import.meta.url),
    "utf8",
  ),
).cases;
