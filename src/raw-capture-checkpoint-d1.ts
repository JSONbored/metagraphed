import type { D1StoreBinding } from "./d1-store.ts";
import type { ChainNetworkId } from "./chain-network.ts";
import type {
  CanonicalCaptureCheckpoint,
  CanonicalCaptureCommit,
  CanonicalCaptureStore,
  RawCaptureCheckpoint,
} from "./raw-capture-provenance.ts";
import { substrateHash } from "./substrate-header.ts";

export const CHECKPOINT_MATCH =
  "c.network=? AND c.last_contiguous_block=? AND c.genesis_hash=? AND c.frontier_hash=? AND c.verified_from=? AND c.finalized_height=? AND c.finalized_hash=? AND c.checkpoint_revision=?";
export function checkpointValues(
  c: CanonicalCaptureCheckpoint,
): (string | number)[] {
  return [
    c.network,
    c.height,
    c.genesis,
    c.hash,
    c.verifiedFrom,
    c.finalizedHeight,
    c.finalizedHash,
    c.revision,
  ];
}

export function rawCheckpointD1(db: D1StoreBinding, publicationSql: string) {
  const read = async (
    network: ChainNetworkId,
  ): Promise<RawCaptureCheckpoint | null> => {
    const row = await db
      .prepare(
        "SELECT network,last_contiguous_block AS height,genesis_hash AS genesis,frontier_hash AS hash,verified_from AS verifiedFrom,finalized_height AS finalizedHeight,finalized_hash AS finalizedHash,checkpoint_revision AS revision FROM raw_capture_state WHERE network=?",
      )
      .bind(network)
      .first<RawCaptureCheckpoint>();
    if (!row) return null;
    if (
      row.network !== network ||
      !Number.isInteger(row.height) ||
      row.height < -1 ||
      row.height > 0xffff_ffff ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0
    )
      throw new Error("Invalid raw capture checkpoint");
    if (row.genesis === null) {
      if (
        [
          row.hash,
          row.verifiedFrom,
          row.finalizedHeight,
          row.finalizedHash,
        ].some((value) => value !== null) ||
        row.revision !== 0
      )
        throw new Error("Partial raw capture checkpoint");
    } else {
      substrateHash(row.genesis);
      substrateHash(row.hash);
      substrateHash(row.finalizedHash);
      if (
        !Number.isInteger(row.verifiedFrom) ||
        row.verifiedFrom! < 0 ||
        row.verifiedFrom! > row.height + 1 ||
        !Number.isInteger(row.finalizedHeight) ||
        row.finalizedHeight! < row.height ||
        row.finalizedHeight! > 0xffff_ffff
      )
        throw new Error("Invalid raw capture checkpoint");
    }
    return row;
  };
  const bootstrap: CanonicalCaptureStore["bootstrap"] = async (input) => {
    const { network, previousHeight, height, now } = input;
    const hash = substrateHash(input.hash),
      genesis = substrateHash(input.genesis);
    const finalized = {
      height: input.finalized.height,
      hash: substrateHash(input.finalized.hash),
    };
    if (
      !Number.isInteger(height) ||
      height < -1 ||
      height > 0xffff_ffff ||
      !Number.isInteger(finalized.height) ||
      finalized.height < height ||
      finalized.height > 0xffff_ffff ||
      !Number.isSafeInteger(now) ||
      now <= 0 ||
      (previousHeight !== null && previousHeight !== height)
    )
      throw new Error("Invalid raw capture bootstrap");
    substrateHash(hash);
    substrateHash(genesis);
    substrateHash(finalized.hash);
    await db.batch([
      db
        .prepare(
          "INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at,genesis_hash,frontier_hash,verified_from,finalized_height,finalized_hash,checkpoint_revision) SELECT ?,?,?,?,?,?,?,?,0 WHERE ? IS NULL AND NOT EXISTS(SELECT 1 FROM raw_capture_state WHERE network=?) ON CONFLICT(network) DO NOTHING",
        )
        .bind(
          network,
          height,
          now,
          genesis,
          hash,
          height + 1,
          finalized.height,
          finalized.hash,
          previousHeight,
          network,
        ),
      db
        .prepare(
          "UPDATE raw_capture_state SET genesis_hash=?,frontier_hash=?,verified_from=?,finalized_height=?,finalized_hash=?,checkpoint_revision=0 WHERE network=? AND last_contiguous_block=? AND genesis_hash IS NULL AND ? IS NOT NULL",
        )
        .bind(
          genesis,
          hash,
          height + 1,
          finalized.height,
          finalized.hash,
          network,
          height,
          previousHeight,
        ),
    ]);
    const row = await read(network);
    if (
      !row ||
      row.genesis !== genesis ||
      row.verifiedFrom !== height + 1 ||
      row.height < height
    )
      throw new Error("Raw capture bootstrap was not committed");
    return row as CanonicalCaptureCheckpoint;
  };
  /** A receipt plus a guarded descendant frontier resolves lost replies after archival. */
  const acknowledged = async (
    key: string,
    digest: string,
    chainDigest: string,
    proof: CanonicalCaptureCommit,
  ): Promise<CanonicalCaptureCheckpoint | null> => {
    const { checkpoint: c } = proof;
    const found = await db
      .prepare(
        `SELECT f.revision FROM raw_capture_finality f JOIN raw_capture_publications p ON p.key=f.key AND p.chain_sha256=f.chain_sha256 JOIN raw_capture_state c ON c.network=f.network AND c.genesis_hash=f.genesis_hash AND c.verified_from=f.verified_from AND c.checkpoint_revision>=f.revision AND c.last_contiguous_block>=f.last_block WHERE p.key=? AND p.sha256=? AND f.chain_sha256=? AND f.network=? AND f.genesis_hash=? AND f.parent_hash=? AND f.first_block=? AND EXISTS(${publicationSql})`,
      )
      .bind(
        key,
        digest,
        chainDigest,
        c.network,
        c.genesis,
        c.hash,
        c.height + 1,
        key,
        digest,
        key,
        digest,
      )
      .first<{ revision: number }>();
    if (!found) return null;
    const current = await read(c.network);
    if (
      !current ||
      current.genesis !== c.genesis ||
      current.verifiedFrom !== c.verifiedFrom ||
      current.revision < found.revision
    )
      throw new Error("Raw capture checkpoint acknowledgment changed");
    return current as CanonicalCaptureCheckpoint;
  };
  const statements = (
    key: string,
    digest: string,
    chainDigest: string,
    last: number,
    lastHash: string,
    proof: CanonicalCaptureCommit,
  ) => {
    const { checkpoint: c, finalized: f } = proof;
    return [
      db
        .prepare(
          `INSERT INTO raw_capture_finality(network,revision,key,sha256,chain_sha256,genesis_hash,first_block,last_block,parent_hash,frontier_hash,finalized_height,finalized_hash,verified_from)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? FROM raw_capture_publications p WHERE p.key=? AND p.sha256=? AND p.chain_sha256=? AND EXISTS(SELECT 1 FROM raw_capture_state c WHERE ${CHECKPOINT_MATCH}) ON CONFLICT DO NOTHING`,
        )
        .bind(
          c.network,
          c.revision + 1,
          key,
          digest,
          chainDigest,
          c.genesis,
          c.height + 1,
          last,
          c.hash,
          lastHash,
          f.height,
          f.hash,
          c.verifiedFrom,
          key,
          digest,
          chainDigest,
          ...checkpointValues(c),
        ),
    ];
  };
  return { read, bootstrap, acknowledged, statements };
}
