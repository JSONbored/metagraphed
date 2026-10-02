import { blake2b } from "@noble/hashes/blake2.js";

// Read implementations audited at Subtensor v470, commit
// 923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d, runtime/src/lib.rs.
// V14 does not publish runtime method signatures. Only these named reads may
// use caller-encoded SCALE; never admit execution/keystore/submission methods
// or EVM/Wasm simulations that need decoded gas/Weight admission.
export const SCALE_READ_API_METHODS: Readonly<
  Record<string, readonly string[]>
> = {
  Core: ["version"],
  Metadata: ["metadata", "metadata_at_version", "metadata_versions"],
  AuraApi: ["slot_duration", "authorities"],
  BabeApi: [
    "configuration",
    "current_epoch_start",
    "current_epoch",
    "next_epoch",
    "generate_key_ownership_proof",
  ],
  GrandpaApi: [
    "grandpa_authorities",
    "current_set_id",
    "generate_key_ownership_proof",
  ],
  SessionKeys: ["decode_session_keys"],
  GenesisBuilder: ["get_preset", "preset_names"],
  AccountNonceApi: ["account_nonce"],
  TransactionPaymentApi: [
    "query_info",
    "query_fee_details",
    "query_weight_to_fee",
    "query_length_to_fee",
  ],
  TransactionPaymentCallApi: [
    "query_call_info",
    "query_call_fee_details",
    "query_weight_to_fee",
    "query_length_to_fee",
  ],
  DelegateInfoRuntimeApi: ["get_delegates", "get_delegate", "get_delegated"],
  NeuronInfoRuntimeApi: [
    "get_neurons",
    "get_neuron",
    "get_neurons_lite",
    "get_neuron_lite",
  ],
  SubnetInfoRuntimeApi: [
    "get_subnet_info",
    "get_subnets_info",
    "get_subnet_info_v2",
    "get_subnets_info_v2",
    "get_subnet_hyperparams",
    "get_subnet_hyperparams_v2",
    "get_subnet_hyperparams_v3",
    "get_dynamic_info",
    "get_metagraph",
    "get_mechagraph",
    "get_subnet_state",
    "get_all_metagraphs",
    "get_all_mechagraphs",
    "get_all_dynamic_info",
    "get_selective_metagraph",
    "get_selective_mechagraph",
    "get_subnet_to_prune",
    "get_coldkey_auto_stake_hotkey",
    "get_subnet_account_id",
    "get_next_epoch_start_block",
    "get_block_emission",
  ],
  StakeInfoRuntimeApi: [
    "get_stake_info_for_coldkey",
    "get_stake_info_for_coldkeys",
    "get_stake_info_for_hotkey_coldkey_netuid",
    "get_stake_availability_for_coldkeys",
    "get_stake_fee",
    "get_coldkey_lock",
    "get_hotkey_conviction",
    "get_most_convicted_hotkey_on_subnet",
  ],
  SubnetRegistrationRuntimeApi: ["get_network_registration_cost"],
  BetaBasketRuntimeApi: [
    "get_root_basket_owed",
    "get_basket_payout",
    "get_validator_basket_nav",
    "get_validator_basket",
    "get_root_basket_total_nav",
    "get_validator_basket_summary",
    "get_all_validator_baskets",
    "get_root_basket_positions",
    "get_basket_position",
    "get_root_basket_portfolio",
    "get_beta_pricing",
    "get_all_beta_pricing",
    "get_beta_index",
    "get_beta_position",
    "get_beta_portfolio",
    "get_basket_trading_status",
    "get_basket_claim_preview",
    "get_root_basket_claim_previews",
  ],
  ProxyFilterRuntimeApi: ["get_proxy_types", "get_proxy_filters"],
  SwapRuntimeApi: [
    "current_alpha_price",
    "current_alpha_price_all",
    "sim_swap_tao_for_alpha",
    "sim_swap_alpha_for_tao",
  ],
  EthereumRuntimeRPCApi: [
    "chain_id",
    "account_basic",
    "gas_price",
    "account_code_at",
    "author",
    "storage_at",
    "current_transaction_statuses",
    "current_block",
    "current_receipts",
    "current_all",
    "extrinsic_filter",
    "elasticity",
    "gas_limit_multiplier_support",
  ],
  ConvertTransactionRuntimeApi: ["convert_transaction"],
  ContractsApi: ["get_storage"],
  ShieldApi: ["try_decode_shielded_tx", "is_shielded_using_current_key"],
};

/** Official RuntimeVersion API identifiers are blake2b-64 of the API name. */
export const runtimeApiId = (name: string) =>
  `0x${Buffer.from(blake2b(Buffer.from(name), { dkLen: 8 })).toString("hex")}`;
const MIN_API_VERSION: Readonly<Record<string, number>> = {
  "SubnetInfoRuntimeApi.get_subnet_hyperparams_v3": 2,
  "BetaBasketRuntimeApi.get_basket_position": 2,
  "BetaBasketRuntimeApi.get_root_basket_portfolio": 2,
  "BetaBasketRuntimeApi.get_beta_pricing": 3,
  "BetaBasketRuntimeApi.get_all_beta_pricing": 3,
  "BetaBasketRuntimeApi.get_beta_index": 3,
  "BetaBasketRuntimeApi.get_beta_position": 3,
  "BetaBasketRuntimeApi.get_beta_portfolio": 3,
  "BetaBasketRuntimeApi.get_basket_trading_status": 4,
  "BetaBasketRuntimeApi.get_basket_claim_preview": 5,
  "BetaBasketRuntimeApi.get_root_basket_claim_previews": 5,
};
export function scaleReadMethods(
  api: string,
  version = Number.MAX_SAFE_INTEGER,
): readonly string[] {
  const methods = Object.hasOwn(SCALE_READ_API_METHODS, api)
    ? SCALE_READ_API_METHODS[api]!
    : [];
  return methods.filter(
    (member) => version >= (MIN_API_VERSION[`${api}.${member}`] ?? 1),
  );
}
