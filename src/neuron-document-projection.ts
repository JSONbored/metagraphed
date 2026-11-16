import type {
  createSqliteDocumentDecoder,
  SqliteDocumentValue,
} from "./sqlite-document-decoder.ts";

type Decoder = ReturnType<typeof createSqliteDocumentDecoder>;
const neuronMetrics = [
  "active",
  "validator_permit",
  "rank",
  "trust",
  "validator_trust",
  "consensus",
  "incentive",
  "dividends",
  "emission_tao",
  "stake_tao",
  "registered_at_block",
  "is_immunity_period",
  "axon",
  "block_number",
  "captured_at",
  "take",
] as const;
const accountMetrics = [
  "uid",
  "coldkey",
  "active",
  "validator_permit",
  "rank",
  "trust",
  "incentive",
  "dividends",
  "stake_tao",
  "emission_tao",
  "captured_at",
  "updated_at",
] as const;

export interface NeuronDocumentMember {
  netuid: bigint;
  uid: bigint;
  hotkey: string | null;
  coldkey: string | null;
}
export interface DailyNeuronDocumentMember extends NeuronDocumentMember {
  snapshot_date: string;
}
export interface AccountDocumentMember {
  account: string;
  netuid: bigint;
  snapshot_date: string;
}

function fields(
  decoder: Decoder,
  payload: Uint8Array,
  key: string,
  names: readonly string[],
  kind: "live" | "audit",
): Record<string, SqliteDocumentValue> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      decoder.extract(payload, `$."${key}".${name}`, kind),
    ]),
  );
}

/** The caller selects the original member/document join in PostgreSQL. Extract
 * at the query owner so first-key SQLite semantics and dynamic scalars survive;
 * parsing the document into a JavaScript object here would change duplicates. */
export function projectNeuronDocument(
  decoder: Decoder,
  member: NeuronDocumentMember | DailyNeuronDocumentMember,
  payload: Uint8Array,
  kind: "live" | "audit" = "live",
): Record<string, SqliteDocumentValue> {
  const row = {
    ...member,
    ...fields(decoder, payload, member.uid.toString(), neuronMetrics, kind),
  };
  if ("snapshot_date" in member)
    return {
      ...row,
      updated_at: decoder.extract(
        payload,
        `$."${member.uid}".updated_at`,
        kind,
      ),
    };
  return row;
}

export function projectAccountDocument(
  decoder: Decoder,
  member: AccountDocumentMember,
  payload: Uint8Array,
): Record<string, SqliteDocumentValue> {
  // SQLite hex(TEXT) encodes UTF-8 bytes and uses uppercase hexadecimal.
  const key =
    "k" + Buffer.from(member.account, "utf8").toString("hex").toUpperCase();
  return {
    ...member,
    ...fields(decoder, payload, key, accountMetrics, "live"),
  };
}
