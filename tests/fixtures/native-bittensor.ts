// Representative v470 contracts from opentensor/subtensor at
// 923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d. This reduced, independently
// encoded metadata fixture is not captured chain metadata or a live observation.
// Sources: runtime-api/src/lib.rs; pallets/subtensor/src/lib.rs;
// pallets/subtensor/src/rpc_info/subnet_info.rs; staking/lock.rs.
import { TypeRegistry } from "@polkadot/types/create";
import { nativeCompact, nativeHex } from "../../src/native-runtime-values.ts";

export function bittensorNativeFixture() {
  const registry = new TypeRegistry();
  registry.register({
    AlphaBalance: "u64",
    TaoBalance: "u64",
    U64F64: "u128",
    I32F32: "i64",
    NetUid: "u16",
    MechId: "u8",
    HyperparamValue: {
      _enum: {
        Bool: "bool",
        U16: "Compact<u16>",
        U32: "Compact<u32>",
        U64: "Compact<u64>",
        U128: "Compact<u128>",
        TaoBalance: "Compact<TaoBalance>",
        I32F32: "I32F32",
        U64F64: "U64F64",
      },
    },
    HyperparamEntry: { name: "Vec<u8>", value: "HyperparamValue" },
    MinerCollateralState: {
      locked: "AlphaBalance",
      drain_ratio: "U64F64",
      min_locked: "AlphaBalance",
      earned: "AlphaBalance",
    },
    LockState: {
      locked_mass: "AlphaBalance",
      conviction: "U64F64",
      last_update: "u64",
    },
  });
  const field = (name: string | null, type: number) => ({
    name,
    type,
    typeName: null,
    docs: [],
  });
  const types: {
    id: number;
    type: { path: string[]; params: never[]; def: unknown; docs: never[] };
  }[] = [];
  const add = (id: number, name: string, def: unknown) =>
    types.push({
      id,
      type: { path: name ? [name] : [], params: [], def, docs: [] },
    });
  for (const [id, type] of [
    [0, "U8"],
    [1, "U16"],
    [2, "U64"],
    [3, "U128"],
    [4, "I64"],
    [14, "U32"],
    [29, "Bool"],
  ] as const)
    add(id, "", { primitive: type });
  add(5, "", { sequence: { type: 0 } });
  add(6, "AccountId32", { array: { len: 32, type: 0 } });
  for (const [id, name, primitive] of [
    [7, "NetUid", 1],
    [8, "MechId", 0],
    [9, "AlphaBalance", 2],
    [10, "TaoBalance", 2],
    [11, "U64F64", 3],
    [12, "I32F32", 4],
  ] as const)
    add(id, name, { composite: { fields: [field(null, primitive)] } });
  for (const [id, type] of [
    [13, 1],
    [15, 14],
    [16, 2],
    [17, 3],
    [18, 10],
  ] as const)
    add(id, "", { compact: { type } });
  add(19, "HyperparamValue", {
    variant: {
      variants: [
        "Bool",
        "U16",
        "U32",
        "U64",
        "U128",
        "TaoBalance",
        "I32F32",
        "U64F64",
      ].map((name, index) => ({
        name,
        index,
        fields: [field(null, [29, 13, 15, 16, 17, 18, 12, 11][index]!)],
        docs: [],
      })),
    },
  });
  add(20, "HyperparamEntry", {
    composite: { fields: [field("name", 5), field("value", 19)] },
  });
  add(21, "SubnetHyperparamsV3", { sequence: { type: 20 } });
  const option = (type: number) => ({
    variant: {
      variants: [
        { name: "None", index: 0, fields: [], docs: [] },
        { name: "Some", index: 1, fields: [field(null, type)], docs: [] },
      ],
    },
  });
  add(22, "Option", option(21));
  add(23, "", { sequence: { type: 1 } });
  add(24, "Option", option(23));
  add(25, "", { tuple: [7, 6, 6] });
  add(26, "MinerCollateralState", {
    composite: {
      fields: [
        field("locked", 9),
        field("drain_ratio", 11),
        field("min_locked", 9),
        field("earned", 9),
      ],
    },
  });
  add(27, "LockState", {
    composite: {
      fields: [
        field("locked_mass", 9),
        field("conviction", 11),
        field("last_update", 2),
      ],
    },
  });
  add(28, "Option", option(27));
  add(30, "Unit", { tuple: [] });
  const map = (
    name: string,
    key: number,
    value: number,
    hashers: string[],
    optional = false,
  ) => ({
    name,
    modifier: optional ? "Optional" : "Default",
    type: { map: { key, value, hashers } },
    fallback: "0x00",
    docs: [],
  });
  const runtime = (
    name: string,
    inputs: [string, number][],
    output: number,
  ) => ({
    name,
    inputs: inputs.map(([name, type]) => ({ name, type })),
    output,
    docs: [],
  });
  const body = registry
    .createType("MetadataV15", {
      lookup: { types },
      pallets: [
        {
          name: "SubtensorModule",
          index: 7,
          storage: {
            prefix: "SubtensorModule",
            items: [
              map("MechanismCountCurrent", 7, 8, ["Twox64Concat"]),
              map("MechanismEmissionSplit", 7, 23, ["Twox64Concat"], true),
              map("CollateralLockShare", 7, 1, ["Identity"]),
              map("CollateralDrainRatio", 7, 11, ["Identity"]),
              map(
                "MinerCollateral",
                25,
                26,
                ["Identity", "Blake2_128Concat", "Blake2_128Concat"],
                true,
              ),
            ],
          },
          calls: null,
          events: null,
          errors: null,
          constants: [],
          docs: [],
        },
      ],
      extrinsic: {
        version: 4,
        addressType: 6,
        callType: 30,
        signatureType: 6,
        extraType: 30,
        signedExtensions: [],
      },
      type: 30,
      apis: [
        {
          name: "SubnetInfoRuntimeApi",
          methods: [runtime("get_subnet_hyperparams_v3", [["netuid", 7]], 22)],
          docs: [],
        },
        {
          name: "StakeInfoRuntimeApi",
          methods: [
            runtime(
              "get_coldkey_lock",
              [
                ["coldkey", 6],
                ["netuid", 7],
              ],
              28,
            ),
          ],
          docs: [],
        },
      ],
      outerEnums: { callType: 30, eventType: 30, errorType: 30 },
      custom: { map: [] },
    })
    .toU8a();
  const metadata = nativeHex(
    Buffer.concat([Buffer.from("6d6574610f", "hex"), body]),
  );
  const wrapped = nativeHex(
    Buffer.concat([
      Buffer.from([1]),
      nativeCompact(BigInt((metadata.length - 2) / 2)),
      Buffer.from(metadata.slice(2), "hex"),
    ]),
  );
  return { metadata, wrapped, registry };
}
