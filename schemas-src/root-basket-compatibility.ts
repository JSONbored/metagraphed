// Exact official release identities, audited against each tag's runtime API,
// basket_info.rs and (where present) BetaBaselineOf/BetaIndexSnapshotOf.
// A spec number between two entries is not evidence of a compatible layout.
export const ROOT_BASKET_RUNTIME_ADAPTERS = [
  {
    spec: 441,
    api: 1,
    commit: "8b9d55c723e00d0d713eed799de627e94603dfd4",
    decoder: "subtensor-v441-8b9d55c7-v1",
  },
  {
    spec: 442,
    api: 1,
    commit: "ec112cb0e68469fa1c5e5ae67dece043033f6673",
    decoder: "subtensor-v442-ec112cb0-v1",
  },
  {
    spec: 443,
    api: 1,
    commit: "c02a376ecee28718970962562fece409b695df72",
    decoder: "subtensor-v443-c02a376e-v1",
  },
  {
    spec: 445,
    api: 1,
    commit: "d3f40e44bda9019c606aeb0c907bb52ba7fe386c",
    decoder: "subtensor-v445-d3f40e44-v1",
  },
  {
    spec: 446,
    api: 1,
    commit: "52d7e7cf66c6fdcc76f62fd4b00732aa506afb2c",
    decoder: "subtensor-v446-52d7e7cf-v1",
  },
  {
    spec: 447,
    api: 1,
    commit: "1f090af85d1771c5d8ece1f0910576fbd129906e",
    decoder: "subtensor-v447-1f090af8-v1",
  },
  {
    spec: 448,
    api: 1,
    commit: "e18ca67f1a00b35c7d5986888d1cc388da8c095f",
    decoder: "subtensor-v448-e18ca67f-v1",
  },
  {
    spec: 450,
    api: 3,
    commit: "9540b3af59179b88af99f8e0d03add5d96512e3f",
    decoder: "subtensor-v450-9540b3af-v1",
  },
  {
    spec: 452,
    api: 3,
    commit: "da06f033663896ef2fdbbfc3ecc68ca908fba0f5",
    decoder: "subtensor-v452-da06f033-v1",
  },
  {
    spec: 453,
    api: 3,
    commit: "823bdcbc58a29f60b243be4737a7c72b34ac7d93",
    decoder: "subtensor-v453-823bdcbc-v1",
  },
  {
    spec: 454,
    api: 3,
    commit: "14cde6410fe8ec81a940e290c56f94a632a0988d",
    decoder: "subtensor-v454-14cde641-v1",
  },
  {
    spec: 459,
    api: 3,
    commit: "70378404b56c12a85bc8cd163aca2f32cf4d1b80",
    decoder: "subtensor-v459-70378404-v1",
  },
  {
    spec: 464,
    api: 4,
    commit: "5cd66b8597b3ce5f9f2bade2b11c91af57df923d",
    decoder: "subtensor-v464-5cd66b85-v1",
  },
  {
    spec: 466,
    api: 4,
    commit: "cdffbe2f7ab0c37ab07884387bfbd6443dca178d",
    decoder: "subtensor-v466-cdffbe2f-v1",
  },
  {
    spec: 467,
    api: 4,
    commit: "c6bcb4a7400764c94c1d1b1938514c6c2dd3d33b",
    decoder: "subtensor-v467-c6bcb4a7-v1",
  },
  {
    spec: 468,
    api: 5,
    commit: "30c70d90f8a3708d85cf95ae992b7a3fe30d2c4c",
    decoder: "subtensor-v468-30c70d90-v1",
  },
  {
    spec: 469,
    api: 5,
    commit: "370bac46fa8cf602c4f8283a0635b3a8b4675394",
    decoder: "subtensor-v469-370bac46-v1",
  },
  {
    spec: 470,
    api: 5,
    commit: "923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d",
    decoder: "subtensor-v470-923fd1fa-v1",
  },
] as const;

export function rootBasketCapabilities(api: 1 | 3 | 4 | 5) {
  return {
    pricing: api >= 3,
    beta_positions: api >= 3,
    target_weights: api < 4,
    trading_status: api >= 4,
    claim_preview: api >= 5,
  };
}
