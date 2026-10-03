// Source-derived inner SCALE records from eight published compiled runtimes.
// Generated and independently qualified on remote CI.
import type { NativeType } from "./native-runtime-metadata.ts";
export interface NativeRuntimeInnerRelease {
  spec: number;
  commit: string;
  metadata_sha256: string[];
  files: { path: string; sha256: string }[];
  types: NativeType[];
  methods: {
    api: string;
    member: string;
    root_type: number;
    empty_is_none: boolean;
    rust_result: string;
  }[];
}

const layouts: Pick<NativeRuntimeInnerRelease, "types" | "methods">[] = [
  {
    types: [
      {
        id: 0,
        path: ["subtensor_legacy_inner", "Vec<DelegateInfo>"],
        definition: { kind: "sequence", type: 1 },
      },
      {
        id: 1,
        path: ["subtensor_legacy_inner", "DelegateInfo"],
        definition: {
          kind: "composite",
          fields: [
            { name: "delegate_ss58", type: 2 },
            { name: "take", type: 6 },
            { name: "nominators", type: 8 },
            { name: "owner_ss58", type: 2 },
            { name: "registrations", type: 12 },
            { name: "validator_permits", type: 12 },
            { name: "return_per_1000", type: 10 },
            { name: "total_daily_return", type: 10 },
          ],
        },
      },
      {
        id: 2,
        path: ["subtensor_legacy_inner", "T::AccountId"],
        definition: { kind: "composite", fields: [{ name: null, type: 3 }] },
      },
      {
        id: 3,
        path: ["sp_core", "crypto", "AccountId32"],
        definition: { kind: "composite", fields: [{ name: null, type: 4 }] },
      },
      { id: 4, path: [], definition: { kind: "array", length: 32, type: 5 } },
      { id: 5, path: [], definition: { kind: "primitive", primitive: 3 } },
      {
        id: 6,
        path: ["subtensor_legacy_inner", "Compact<u16>"],
        definition: { kind: "compact", type: 7 },
      },
      {
        id: 7,
        path: ["subtensor_legacy_inner", "u16"],
        definition: { kind: "primitive", primitive: 4 },
      },
      {
        id: 8,
        path: ["subtensor_legacy_inner", "Vec<(T::AccountId,Compact<u64>)>"],
        definition: { kind: "sequence", type: 9 },
      },
      {
        id: 9,
        path: ["subtensor_legacy_inner", "(T::AccountId,Compact<u64>)"],
        definition: { kind: "tuple", types: [2, 10] },
      },
      {
        id: 10,
        path: ["subtensor_legacy_inner", "Compact<u64>"],
        definition: { kind: "compact", type: 11 },
      },
      {
        id: 11,
        path: ["subtensor_legacy_inner", "u64"],
        definition: { kind: "primitive", primitive: 6 },
      },
      {
        id: 12,
        path: ["subtensor_legacy_inner", "Vec<Compact<u16>>"],
        definition: { kind: "sequence", type: 6 },
      },
      {
        id: 13,
        path: ["subtensor_legacy_inner", "Vec<(DelegateInfo,Compact<u64>)>"],
        definition: { kind: "sequence", type: 14 },
      },
      {
        id: 14,
        path: ["subtensor_legacy_inner", "(DelegateInfo,Compact<u64>)"],
        definition: { kind: "tuple", types: [1, 10] },
      },
      {
        id: 15,
        path: ["subtensor_legacy_inner", "Vec<NeuronInfo>"],
        definition: { kind: "sequence", type: 16 },
      },
      {
        id: 16,
        path: ["subtensor_legacy_inner", "NeuronInfo"],
        definition: {
          kind: "composite",
          fields: [
            { name: "hotkey", type: 2 },
            { name: "coldkey", type: 2 },
            { name: "uid", type: 6 },
            { name: "netuid", type: 6 },
            { name: "active", type: 17 },
            { name: "axon_info", type: 18 },
            { name: "prometheus_info", type: 24 },
            { name: "stake", type: 8 },
            { name: "rank", type: 6 },
            { name: "emission", type: 10 },
            { name: "incentive", type: 6 },
            { name: "consensus", type: 6 },
            { name: "trust", type: 6 },
            { name: "validator_trust", type: 6 },
            { name: "dividends", type: 6 },
            { name: "last_update", type: 10 },
            { name: "validator_permit", type: 17 },
            { name: "weights", type: 26 },
            { name: "bonds", type: 26 },
            { name: "pruning_score", type: 6 },
          ],
        },
      },
      {
        id: 17,
        path: ["subtensor_legacy_inner", "bool"],
        definition: { kind: "primitive", primitive: 0 },
      },
      {
        id: 18,
        path: ["subtensor_legacy_inner", "AxonInfo"],
        definition: { kind: "composite", fields: [{ name: null, type: 19 }] },
      },
      {
        id: 19,
        path: ["pallet_subtensor", "pallet", "AxonInfo"],
        definition: {
          kind: "composite",
          fields: [
            { name: "block", type: 20 },
            { name: "version", type: 21 },
            { name: "ip", type: 22 },
            { name: "port", type: 23 },
            { name: "ip_type", type: 5 },
            { name: "protocol", type: 5 },
            { name: "placeholder1", type: 5 },
            { name: "placeholder2", type: 5 },
          ],
        },
      },
      { id: 20, path: [], definition: { kind: "primitive", primitive: 6 } },
      { id: 21, path: [], definition: { kind: "primitive", primitive: 5 } },
      { id: 22, path: [], definition: { kind: "primitive", primitive: 7 } },
      { id: 23, path: [], definition: { kind: "primitive", primitive: 4 } },
      {
        id: 24,
        path: ["subtensor_legacy_inner", "PrometheusInfo"],
        definition: { kind: "composite", fields: [{ name: null, type: 25 }] },
      },
      {
        id: 25,
        path: ["pallet_subtensor", "pallet", "PrometheusInfo"],
        definition: {
          kind: "composite",
          fields: [
            { name: "block", type: 20 },
            { name: "version", type: 21 },
            { name: "ip", type: 22 },
            { name: "port", type: 23 },
            { name: "ip_type", type: 5 },
          ],
        },
      },
      {
        id: 26,
        path: ["subtensor_legacy_inner", "Vec<(Compact<u16>,Compact<u16>)>"],
        definition: { kind: "sequence", type: 27 },
      },
      {
        id: 27,
        path: ["subtensor_legacy_inner", "(Compact<u16>,Compact<u16>)"],
        definition: { kind: "tuple", types: [6, 6] },
      },
      {
        id: 28,
        path: ["subtensor_legacy_inner", "Vec<NeuronInfoLite>"],
        definition: { kind: "sequence", type: 29 },
      },
      {
        id: 29,
        path: ["subtensor_legacy_inner", "NeuronInfoLite"],
        definition: {
          kind: "composite",
          fields: [
            { name: "hotkey", type: 2 },
            { name: "coldkey", type: 2 },
            { name: "uid", type: 6 },
            { name: "netuid", type: 6 },
            { name: "active", type: 17 },
            { name: "axon_info", type: 18 },
            { name: "prometheus_info", type: 24 },
            { name: "stake", type: 8 },
            { name: "rank", type: 6 },
            { name: "emission", type: 10 },
            { name: "incentive", type: 6 },
            { name: "consensus", type: 6 },
            { name: "trust", type: 6 },
            { name: "validator_trust", type: 6 },
            { name: "dividends", type: 6 },
            { name: "last_update", type: 10 },
            { name: "validator_permit", type: 17 },
            { name: "pruning_score", type: 6 },
          ],
        },
      },
      {
        id: 30,
        path: ["subtensor_legacy_inner", "SubnetInfo"],
        definition: {
          kind: "composite",
          fields: [
            { name: "netuid", type: 6 },
            { name: "rho", type: 6 },
            { name: "kappa", type: 6 },
            { name: "difficulty", type: 10 },
            { name: "immunity_period", type: 6 },
            { name: "max_allowed_validators", type: 6 },
            { name: "min_allowed_weights", type: 6 },
            { name: "max_weights_limit", type: 6 },
            { name: "scaling_law_power", type: 6 },
            { name: "subnetwork_n", type: 6 },
            { name: "max_allowed_uids", type: 6 },
            { name: "blocks_since_last_step", type: 10 },
            { name: "tempo", type: 6 },
            { name: "network_modality", type: 6 },
            { name: "network_connect", type: 31 },
            { name: "emission_values", type: 10 },
            { name: "burn", type: 10 },
            { name: "owner", type: 2 },
          ],
        },
      },
      {
        id: 31,
        path: ["subtensor_legacy_inner", "Vec<[u16;2]>"],
        definition: { kind: "sequence", type: 32 },
      },
      {
        id: 32,
        path: ["subtensor_legacy_inner", "[u16;2]"],
        definition: { kind: "array", type: 7, length: 2 },
      },
      {
        id: 33,
        path: ["subtensor_legacy_inner", "Vec<Option<SubnetInfo>>"],
        definition: { kind: "sequence", type: 34 },
      },
      {
        id: 34,
        path: ["subtensor_legacy_inner", "Option<SubnetInfo>"],
        definition: {
          kind: "variant",
          variants: [
            { name: "None", index: 0, fields: [] },
            { name: "Some", index: 1, fields: [{ name: null, type: 30 }] },
          ],
        },
      },
      {
        id: 35,
        path: ["subtensor_legacy_inner", "SubnetInfov2"],
        definition: {
          kind: "composite",
          fields: [
            { name: "netuid", type: 6 },
            { name: "rho", type: 6 },
            { name: "kappa", type: 6 },
            { name: "difficulty", type: 10 },
            { name: "immunity_period", type: 6 },
            { name: "max_allowed_validators", type: 6 },
            { name: "min_allowed_weights", type: 6 },
            { name: "max_weights_limit", type: 6 },
            { name: "scaling_law_power", type: 6 },
            { name: "subnetwork_n", type: 6 },
            { name: "max_allowed_uids", type: 6 },
            { name: "blocks_since_last_step", type: 10 },
            { name: "tempo", type: 6 },
            { name: "network_modality", type: 6 },
            { name: "network_connect", type: 31 },
            { name: "emission_values", type: 10 },
            { name: "burn", type: 10 },
            { name: "owner", type: 2 },
            { name: "identity", type: 36 },
          ],
        },
      },
      {
        id: 36,
        path: ["subtensor_legacy_inner", "Option<SubnetIdentity>"],
        definition: {
          kind: "variant",
          variants: [
            { name: "None", index: 0, fields: [] },
            { name: "Some", index: 1, fields: [{ name: null, type: 37 }] },
          ],
        },
      },
      {
        id: 37,
        path: ["subtensor_legacy_inner", "SubnetIdentity"],
        definition: { kind: "composite", fields: [{ name: null, type: 38 }] },
      },
      {
        id: 38,
        path: ["pallet_subtensor", "pallet", "SubnetIdentity"],
        definition: {
          kind: "composite",
          fields: [
            { name: "subnet_name", type: 39 },
            { name: "github_repo", type: 39 },
            { name: "subnet_contact", type: 39 },
          ],
        },
      },
      { id: 39, path: [], definition: { kind: "sequence", type: 5 } },
      {
        id: 40,
        path: ["subtensor_legacy_inner", "SubnetHyperparams"],
        definition: {
          kind: "composite",
          fields: [
            { name: "rho", type: 6 },
            { name: "kappa", type: 6 },
            { name: "immunity_period", type: 6 },
            { name: "min_allowed_weights", type: 6 },
            { name: "max_weights_limit", type: 6 },
            { name: "tempo", type: 6 },
            { name: "min_difficulty", type: 10 },
            { name: "max_difficulty", type: 10 },
            { name: "weights_version", type: 10 },
            { name: "weights_rate_limit", type: 10 },
            { name: "adjustment_interval", type: 6 },
            { name: "activity_cutoff", type: 6 },
            { name: "registration_allowed", type: 17 },
            { name: "target_regs_per_interval", type: 6 },
            { name: "min_burn", type: 10 },
            { name: "max_burn", type: 10 },
            { name: "bonds_moving_avg", type: 10 },
            { name: "max_regs_per_block", type: 6 },
            { name: "serving_rate_limit", type: 10 },
            { name: "max_validators", type: 6 },
            { name: "adjustment_alpha", type: 10 },
            { name: "difficulty", type: 10 },
            { name: "commit_reveal_weights_interval", type: 10 },
            { name: "commit_reveal_weights_enabled", type: 17 },
            { name: "alpha_high", type: 6 },
            { name: "alpha_low", type: 6 },
            { name: "liquid_alpha_enabled", type: 17 },
          ],
        },
      },
      {
        id: 41,
        path: ["subtensor_legacy_inner", "Vec<StakeInfo>"],
        definition: { kind: "sequence", type: 42 },
      },
      {
        id: 42,
        path: ["subtensor_legacy_inner", "StakeInfo"],
        definition: {
          kind: "composite",
          fields: [
            { name: "hotkey", type: 2 },
            { name: "coldkey", type: 2 },
            { name: "stake", type: 10 },
          ],
        },
      },
      {
        id: 43,
        path: ["subtensor_legacy_inner", "Vec<(T::AccountId,Vec<StakeInfo>)>"],
        definition: { kind: "sequence", type: 44 },
      },
      {
        id: 44,
        path: ["subtensor_legacy_inner", "(T::AccountId,Vec<StakeInfo>)"],
        definition: { kind: "tuple", types: [2, 41] },
      },
    ],
    methods: [
      {
        api: "DelegateInfoRuntimeApi",
        member: "get_delegates",
        root_type: 0,
        empty_is_none: false,
        rust_result: "Vec<DelegateInfo<T>>",
      },
      {
        api: "DelegateInfoRuntimeApi",
        member: "get_delegate",
        root_type: 1,
        empty_is_none: true,
        rust_result: "Option<DelegateInfo<T>>",
      },
      {
        api: "DelegateInfoRuntimeApi",
        member: "get_delegated",
        root_type: 13,
        empty_is_none: false,
        rust_result: "Vec<(DelegateInfo<T>,Compact<u64>)>",
      },
      {
        api: "NeuronInfoRuntimeApi",
        member: "get_neurons",
        root_type: 15,
        empty_is_none: false,
        rust_result: "Vec<NeuronInfo<T>>",
      },
      {
        api: "NeuronInfoRuntimeApi",
        member: "get_neuron",
        root_type: 16,
        empty_is_none: true,
        rust_result: "Option<NeuronInfo<T>>",
      },
      {
        api: "NeuronInfoRuntimeApi",
        member: "get_neurons_lite",
        root_type: 28,
        empty_is_none: false,
        rust_result: "Vec<NeuronInfoLite<T>>",
      },
      {
        api: "NeuronInfoRuntimeApi",
        member: "get_neuron_lite",
        root_type: 29,
        empty_is_none: true,
        rust_result: "Option<NeuronInfoLite<T>>",
      },
      {
        api: "SubnetInfoRuntimeApi",
        member: "get_subnet_info",
        root_type: 30,
        empty_is_none: true,
        rust_result: "Option<SubnetInfo<T>>",
      },
      {
        api: "SubnetInfoRuntimeApi",
        member: "get_subnets_info",
        root_type: 33,
        empty_is_none: false,
        rust_result: "Vec<Option<SubnetInfo<T>>>",
      },
      {
        api: "SubnetInfoRuntimeApi",
        member: "get_subnet_info_v2",
        root_type: 35,
        empty_is_none: true,
        rust_result: "Option<SubnetInfov2<T>>",
      },
      {
        api: "SubnetInfoRuntimeApi",
        member: "get_subnets_info_v2",
        root_type: 33,
        empty_is_none: false,
        rust_result: "Vec<Option<SubnetInfo<T>>>",
      },
      {
        api: "SubnetInfoRuntimeApi",
        member: "get_subnet_hyperparams",
        root_type: 40,
        empty_is_none: true,
        rust_result: "Option<SubnetHyperparams>",
      },
      {
        api: "StakeInfoRuntimeApi",
        member: "get_stake_info_for_coldkey",
        root_type: 41,
        empty_is_none: false,
        rust_result: "Vec<StakeInfo<T>>",
      },
      {
        api: "StakeInfoRuntimeApi",
        member: "get_stake_info_for_coldkeys",
        root_type: 43,
        empty_is_none: false,
        rust_result: "Vec<(T::AccountId,Vec<StakeInfo<T>>)>",
      },
    ],
  },
];
const releases: (Omit<NativeRuntimeInnerRelease, "types" | "methods"> & {
  layout: number;
})[] = [
  {
    spec: 205,
    commit: "e6683abcdc46e24e4739d087614e88b19a03fbd0",
    metadata_sha256: [
      "b6fc04ce28b5a844cb795faf31f0962a82b0a248cf46d036c7ce1df501f0cb5d",
      "7a4d7a6b8aedcd382bb278eda4479e31013f1ce96aaf5df92416be6b8ca4007e",
    ],
    files: [
      {
        path: "runtime/src/lib.rs",
        sha256:
          "4fa537cb5c24fb6e8de01d607f20420a18f3f76cbdfc4e1d976c8f7a5af0e352",
      },
      {
        path: "pallets/subtensor/src/rpc_info/delegate_info.rs",
        sha256:
          "81036e3d4848aa056f419e05416727c8e9df1d634b322f965c998a64d5dbfd47",
      },
      {
        path: "pallets/subtensor/src/rpc_info/neuron_info.rs",
        sha256:
          "4d58ae40c3bafad9112eb08ceee2810d0d0f3b5b495ab2ef1eabe418a337a4f1",
      },
      {
        path: "pallets/subtensor/src/rpc_info/subnet_info.rs",
        sha256:
          "d710e515068105ff14cacf8d2faf962cfee449337ae31e17c12100369d3fac9e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/stake_info.rs",
        sha256:
          "cce87e643aa29eab404689a1bc40962339ccd19fcd477beaad381fa5547b9d81",
      },
    ],
    layout: 0,
  },
  {
    spec: 210,
    commit: "4e2c494cd089de268a4c4169f34c1754190fd9ba",
    metadata_sha256: [
      "f92ee210e5890fc679750ed07f50f3c14308094ad8e5c6395cffa75d18c6c97b",
      "58fa422ecd053aeafab3044c9d74fcb493b81d8212cbab5eebd5663850101399",
    ],
    files: [
      {
        path: "runtime/src/lib.rs",
        sha256:
          "54f329eaa9f6deb3ffc0ede7b2b13c9927ef3346b63414237c67bf429b9da2ac",
      },
      {
        path: "pallets/subtensor/src/rpc_info/delegate_info.rs",
        sha256:
          "81036e3d4848aa056f419e05416727c8e9df1d634b322f965c998a64d5dbfd47",
      },
      {
        path: "pallets/subtensor/src/rpc_info/neuron_info.rs",
        sha256:
          "9c25fb7d65c82803a227ff55790deb5ebf2083109f5e79203c8389cdd85b475e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/subnet_info.rs",
        sha256:
          "d710e515068105ff14cacf8d2faf962cfee449337ae31e17c12100369d3fac9e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/stake_info.rs",
        sha256:
          "cce87e643aa29eab404689a1bc40962339ccd19fcd477beaad381fa5547b9d81",
      },
    ],
    layout: 0,
  },
  {
    spec: 211,
    commit: "44d6859723fdd977e6c0928ed7ea99b1e354fdb3",
    metadata_sha256: [
      "67c629fb4d41072184600857cb5e06d0dfb6cf4a1245efdc99010fe81dda5c41",
      "ece503c2a4c512f3e54166720b125782d6bef7aedca5407c9403c66db2cd626a",
    ],
    files: [
      {
        path: "runtime/src/lib.rs",
        sha256:
          "128d4e4ea882c345b6dff3839da9fa2e31f38b9a49e293421feed72f2b000b1a",
      },
      {
        path: "pallets/subtensor/src/rpc_info/delegate_info.rs",
        sha256:
          "81036e3d4848aa056f419e05416727c8e9df1d634b322f965c998a64d5dbfd47",
      },
      {
        path: "pallets/subtensor/src/rpc_info/neuron_info.rs",
        sha256:
          "9c25fb7d65c82803a227ff55790deb5ebf2083109f5e79203c8389cdd85b475e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/subnet_info.rs",
        sha256:
          "d710e515068105ff14cacf8d2faf962cfee449337ae31e17c12100369d3fac9e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/stake_info.rs",
        sha256:
          "cce87e643aa29eab404689a1bc40962339ccd19fcd477beaad381fa5547b9d81",
      },
    ],
    layout: 0,
  },
  {
    spec: 212,
    commit: "7364b184cbed523f4184e9db35a2cd9ea23afcca",
    metadata_sha256: [
      "3ac0711972264fa3be32ec5136e360d9547d9b6387426232c96e7ac63867a865",
      "00931b9b5a3a02a31d8fff18969087ec85ee68ac572b6d7b587535c06c2978e9",
    ],
    files: [
      {
        path: "runtime/src/lib.rs",
        sha256:
          "a3a6858be437c6bab526aff2cb18c46dbc23595f05bfa20a220d84f8a6cb813d",
      },
      {
        path: "pallets/subtensor/src/rpc_info/delegate_info.rs",
        sha256:
          "81036e3d4848aa056f419e05416727c8e9df1d634b322f965c998a64d5dbfd47",
      },
      {
        path: "pallets/subtensor/src/rpc_info/neuron_info.rs",
        sha256:
          "9c25fb7d65c82803a227ff55790deb5ebf2083109f5e79203c8389cdd85b475e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/subnet_info.rs",
        sha256:
          "d710e515068105ff14cacf8d2faf962cfee449337ae31e17c12100369d3fac9e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/stake_info.rs",
        sha256:
          "cce87e643aa29eab404689a1bc40962339ccd19fcd477beaad381fa5547b9d81",
      },
    ],
    layout: 0,
  },
  {
    spec: 216,
    commit: "205025194588599fc21a2af7e63356a3072a3a21",
    metadata_sha256: [
      "e7af2a517c7d2644ba6e7f50ba07ff63b24d74abf6eca4e8e71bf4c899e4c699",
      "9f2d8fae2f7831b16a3d52b78f947cbef77ab56c241dd0b5ca97eeb6883c1a62",
    ],
    files: [
      {
        path: "runtime/src/lib.rs",
        sha256:
          "487bc8dd61cfbbd39a31bd2e34384364f0e85a8b02c7a84125483add1e645c83",
      },
      {
        path: "pallets/subtensor/src/rpc_info/delegate_info.rs",
        sha256:
          "b19f1f2c1790f0ebe65b21ac4320b03e5fcc4cdcef4e0a2726a759834de5c4e0",
      },
      {
        path: "pallets/subtensor/src/rpc_info/neuron_info.rs",
        sha256:
          "9c25fb7d65c82803a227ff55790deb5ebf2083109f5e79203c8389cdd85b475e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/subnet_info.rs",
        sha256:
          "d710e515068105ff14cacf8d2faf962cfee449337ae31e17c12100369d3fac9e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/stake_info.rs",
        sha256:
          "cce87e643aa29eab404689a1bc40962339ccd19fcd477beaad381fa5547b9d81",
      },
    ],
    layout: 0,
  },
  {
    spec: 217,
    commit: "c1c25e28d44dea4a0062628a71283760839cbd00",
    metadata_sha256: [
      "0719265a4c9b56360ee35a06353c079f7341d31facb9662ec51e37ae86d7d452",
      "01dcd32bf8958faf2e61a0ef056d7bd0eb2518993a896b406d95c9c6538b1de8",
    ],
    files: [
      {
        path: "runtime/src/lib.rs",
        sha256:
          "dd7800fb53650fcbe62a961b111dcd4dc7d126fc8d0779758d87ba320b1b0a0a",
      },
      {
        path: "pallets/subtensor/src/rpc_info/delegate_info.rs",
        sha256:
          "b19f1f2c1790f0ebe65b21ac4320b03e5fcc4cdcef4e0a2726a759834de5c4e0",
      },
      {
        path: "pallets/subtensor/src/rpc_info/neuron_info.rs",
        sha256:
          "9c25fb7d65c82803a227ff55790deb5ebf2083109f5e79203c8389cdd85b475e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/subnet_info.rs",
        sha256:
          "d710e515068105ff14cacf8d2faf962cfee449337ae31e17c12100369d3fac9e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/stake_info.rs",
        sha256:
          "cce87e643aa29eab404689a1bc40962339ccd19fcd477beaad381fa5547b9d81",
      },
    ],
    layout: 0,
  },
  {
    spec: 218,
    commit: "d4d8182eb99c564d707c81f65f1236c33ccda24b",
    metadata_sha256: [
      "048500253f7906fbe637452749bf3ad5c1119c1a41a4f94a517569d87fc17dcc",
      "92388e034b8ec389139aa2286900ddb2a3cc0ce92041af2a15f73949ae697d66",
    ],
    files: [
      {
        path: "runtime/src/lib.rs",
        sha256:
          "f00be1f92251f319a2de1cdc5f5388f347d7ee42924c9b0c4aefa0f669205fa3",
      },
      {
        path: "pallets/subtensor/src/rpc_info/delegate_info.rs",
        sha256:
          "b19f1f2c1790f0ebe65b21ac4320b03e5fcc4cdcef4e0a2726a759834de5c4e0",
      },
      {
        path: "pallets/subtensor/src/rpc_info/neuron_info.rs",
        sha256:
          "9c25fb7d65c82803a227ff55790deb5ebf2083109f5e79203c8389cdd85b475e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/subnet_info.rs",
        sha256:
          "d710e515068105ff14cacf8d2faf962cfee449337ae31e17c12100369d3fac9e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/stake_info.rs",
        sha256:
          "cce87e643aa29eab404689a1bc40962339ccd19fcd477beaad381fa5547b9d81",
      },
    ],
    layout: 0,
  },
  {
    spec: 219,
    commit: "8f39a58329f2d195f029793942d1de3388b3edeb",
    metadata_sha256: [
      "823f4f1413ae2b5ae8047e59a81f8d10fd095e87b3f0da6a6d952f95326f8e00",
      "4c83e879368cfde135f1d02467e5df59216d9bfc864af444e05a22c997712f1a",
    ],
    files: [
      {
        path: "runtime/src/lib.rs",
        sha256:
          "c98f5f85a8cdcdcd85ab92999c43694fea036bbddc443f842828b620dab04a4b",
      },
      {
        path: "pallets/subtensor/src/rpc_info/delegate_info.rs",
        sha256:
          "b19f1f2c1790f0ebe65b21ac4320b03e5fcc4cdcef4e0a2726a759834de5c4e0",
      },
      {
        path: "pallets/subtensor/src/rpc_info/neuron_info.rs",
        sha256:
          "9c25fb7d65c82803a227ff55790deb5ebf2083109f5e79203c8389cdd85b475e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/subnet_info.rs",
        sha256:
          "d710e515068105ff14cacf8d2faf962cfee449337ae31e17c12100369d3fac9e",
      },
      {
        path: "pallets/subtensor/src/rpc_info/stake_info.rs",
        sha256:
          "cce87e643aa29eab404689a1bc40962339ccd19fcd477beaad381fa5547b9d81",
      },
    ],
    layout: 0,
  },
];
export const nativeRuntimeInnerCatalogue: NativeRuntimeInnerRelease[] =
  releases.map(({ layout, ...release }) => ({
    ...release,
    ...layouts[layout]!,
  }));
