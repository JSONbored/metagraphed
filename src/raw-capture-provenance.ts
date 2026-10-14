import type { ChainNetworkId } from "./chain-network.ts";

export interface FinalizedAnchor {
  height: number;
  hash: string;
}

/** A missing anchor denotes legacy coverage, never an implicitly verified prefix. */
export interface RawCaptureCheckpoint {
  network: ChainNetworkId;
  height: number;
  genesis: string | null;
  hash: string | null;
  verifiedFrom: number | null;
  finalizedHeight: number | null;
  finalizedHash: string | null;
  revision: number;
}

export interface CanonicalCaptureCheckpoint extends RawCaptureCheckpoint {
  genesis: string;
  hash: string;
  verifiedFrom: number;
  finalizedHeight: number;
  finalizedHash: string;
}

export interface CanonicalCaptureCommit {
  checkpoint: CanonicalCaptureCheckpoint;
  finalized: FinalizedAnchor;
}

/** Bytes, immutable publication proof and CAS frontier share one native owner. */
export interface CanonicalCaptureStore {
  read(network: ChainNetworkId): Promise<RawCaptureCheckpoint | null>;
  bootstrap(input: {
    network: ChainNetworkId;
    previousHeight: number | null;
    height: number;
    hash: string;
    genesis: string;
    finalized: FinalizedAnchor;
    now: number;
  }): Promise<CanonicalCaptureCheckpoint>;
  commit(
    key: string,
    value: string,
    proof: CanonicalCaptureCommit,
  ): Promise<CanonicalCaptureCheckpoint>;
}

// Official public endpoints, frozen source evidence captured 2026-10-13/14.
// Network labels alone do not establish chain identity.
export const RAW_CAPTURE_GENESIS: Readonly<Record<ChainNetworkId, string>> = {
  mainnet: "0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03",
  testnet: "0x8f9cf856bf558a14440e75569c9e58594757048d7b3a84b5d25f6bd978263105",
};
