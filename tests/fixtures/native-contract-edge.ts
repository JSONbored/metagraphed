// Synthetic portable contracts encoded by the independent reference library.
// These exercise bounds and codec families; they are not Bittensor observations.
import { TypeRegistry } from "@polkadot/types/create";
import { nativeCompact, nativeHex } from "../../src/native-runtime-values.ts";

export function nativeContractEdgeFixture(
  large = false,
  extraApis: {
    name: string;
    methods: {
      name: string;
      inputs: { name: string; type: number }[];
      output: number;
      docs: never[];
    }[];
    docs: never[];
  }[] = [],
) {
  const registry = new TypeRegistry();
  const field = (name: string | null, type: number) => ({
    name,
    type,
    typeName: null,
    docs: [],
  });
  const type = (id: number, def: unknown, path: string[] = []) => ({
    id,
    type: { path, params: [], def, docs: [] },
  });
  const types = [
    type(0, { primitive: "U8" }),
    type(1, { primitive: "U256" }),
    type(2, { sequence: { type: 1 } }),
    type(3, { composite: { fields: [] } }, ["bitvec", "order", "Lsb0"]),
    type(4, { bitSequence: { bitStoreType: 0, bitOrderType: 3 } }),
    type(5, { tuple: [0, 1] }),
    type(6, {
      variant: {
        variants: [
          {
            name: "large_call",
            index: 0,
            fields: [field("amounts", 2), field("tail", 1)],
            docs: [],
          },
        ],
      },
    }),
  ];
  if (large)
    for (let id = 100; id < 112; id++)
      types.push(type(id, { primitive: "U8" }, ["x".repeat(50000)]));
  const bare = nativeHex(
    Buffer.concat([
      Buffer.from("6d6574610f", "hex"),
      registry
        .createType("MetadataV15", {
          lookup: { types },
          pallets: [
            {
              name: "Fixture",
              index: 42,
              storage: {
                prefix: "Fixture",
                items: [
                  {
                    name: "Amounts",
                    modifier: "Default",
                    type: { plain: 2 },
                    fallback: "0x00",
                    docs: [],
                  },
                  {
                    name: "Bits",
                    modifier: "Default",
                    type: { plain: 4 },
                    fallback: "0x00",
                    docs: [],
                  },
                  {
                    name: "Pair",
                    modifier: "Default",
                    type: { plain: 5 },
                    fallback: "0x00",
                    docs: [],
                  },
                ],
              },
              calls: { type: 6 },
              events: null,
              constants: [],
              errors: null,
              docs: [],
            },
            {
              name: "NoCalls",
              index: 43,
              storage: null,
              calls: null,
              events: null,
              constants: [],
              errors: null,
              docs: [],
            },
          ],
          extrinsic: {
            version: 4,
            addressType: 0,
            callType: 6,
            signatureType: 0,
            extraType: 0,
            signedExtensions: [],
          },
          type: 6,
          apis: [
            ...extraApis,
            {
              name: "SwapRuntimeApi",
              methods: [
                {
                  name: "fixture",
                  inputs: [
                    { name: "amounts", type: 2 },
                    { name: "tail", type: 1 },
                  ],
                  output: 0,
                  docs: [],
                },
              ],
              docs: [],
            },
            {
              name: "ShieldApi",
              methods: [
                {
                  name: "is_shielded_using_current_key",
                  inputs: [],
                  output: 0,
                  docs: [],
                },
              ],
              docs: [],
            },
            {
              name: "ContractsApi",
              methods: [
                { name: "get_storage", inputs: [], output: 0, docs: [] },
              ],
              docs: [],
            },
          ],
          outerEnums: { callType: 6, eventType: 0, errorType: 0 },
          custom: { map: new Map([["fixture", { type: 0, value: "0x01" }]]) },
        })
        .toU8a(),
    ]),
  );
  const bytes = Buffer.from(bare.slice(2), "hex");
  return {
    bare,
    wrapped: nativeHex(
      Buffer.concat([
        Buffer.from([1]),
        nativeCompact(BigInt(bytes.length)),
        bytes,
      ]),
    ),
    registry,
  };
}
