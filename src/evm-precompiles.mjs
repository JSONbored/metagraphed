// Bittensor EVM precompile registry + calldata decoder (epic #6725,
// issues #6726/#6727). `EVM_PRECOMPILES` is generated from opentensor/subtensor's
// real source (precompiles/src/*.rs, `main` branch as of 2026-07-19) --
// every address is `H160::from_low_u64_be(INDEX)` per that repo's own
// precompiles/src/lib.rs `hash()` helper (verified: INDEX 2051 -> subnet
// precompile, INDEX 2049/2053 -> staking V1/V2, both independently confirmed
// against docs.learnbittensor.org's own Subnet/Staking precompile pages), and
// every function's `signature` is the exact string subtensor's own
// `#[precompile::public("...")]` macro attribute declares -- the same string
// Substrate's `precompile_utils` crate hashes to derive the real on-chain
// selector, so `functionSelector` below reproduces that selector rather than
// hand-transcribing it (removing an entire class of possible transcription
// error: get the human-readable signature right and the hex selector follows
// mechanically, verified at import time against two independently known
// selectors in tests/evm-precompiles.test.mjs).
//
// Deliberately excludes 3 of the 17 total subtensor-specific precompile
// addresses: Ed25519Verify (1026), Sr25519Verify (1027), and
// StorageQueryPrecompile (2055, address 0x807). All three implement the raw
// `Precompile` trait directly (`fn execute(handle)` reading `handle.input()`
// as an opaque byte blob) rather than the `#[precompile::public(...)]`
// Solidity-ABI dispatch macro every other precompile here uses -- there is no
// function selector to decode, so they're out of scope for this table by
// construction, not an oversight. The remaining 14 files/16 addresses (2 of
// them -- staking.rs's StakingPrecompile/StakingPrecompileV2 -- share one
// file) cover every ABI-dispatched precompile call subtensor's EVM exposes.
import { keccak_256 } from "@noble/hashes/sha3.js";

const WORD_BYTES = 32;

// The one call site (decodeAbiArgs below) always passes an even-length
// "0x"-prefixed hex string (dataHex comes from decodeEthereumTransactArgs'
// own "0x" + ... construction, or a test fixture built the same way), so this
// only ever strips that guaranteed prefix -- not a general hex-or-0x-hex
// parser, same scoping note src/sudo-key.mjs's own hexToBytes carries.
function hexToBytes(hex) {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHexString(bytes) {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** The real on-chain 4-byte function selector: keccak256(signature)[0:4],
 * exactly how Substrate's precompile_utils crate (and every Solidity ABI
 * encoder) derives it from a canonical `name(type1,type2)` signature. */
export function functionSelector(signature) {
  const hash = keccak_256(new TextEncoder().encode(signature));
  return bytesToHexString(hash.slice(0, 4));
}

export const EVM_PRECOMPILES = [
  {
    name: "AddressMapping",
    index: 2060,
    address: "0x000000000000000000000000000000000000080c",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/address_mapping.rs",
    functions: [
      {
        name: "addressMapping",
        signature: "addressMapping(address)",
        argTypes: ["address"],
        argNames: ["target_address"],
      },
    ],
  },
  {
    name: "Alpha",
    index: 2056,
    address: "0x0000000000000000000000000000000000000808",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/alpha.rs",
    functions: [
      {
        name: "getAlphaPrice",
        signature: "getAlphaPrice(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getMovingAlphaPrice",
        signature: "getMovingAlphaPrice(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getTaoInPool",
        signature: "getTaoInPool(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getAlphaInPool",
        signature: "getAlphaInPool(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getAlphaOutPool",
        signature: "getAlphaOutPool(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getAlphaIssuance",
        signature: "getAlphaIssuance(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getTaoWeight",
        signature: "getTaoWeight()",
        argTypes: [],
        argNames: [],
      },
      {
        name: "getCKBurn",
        signature: "getCKBurn()",
        argTypes: [],
        argNames: [],
      },
      {
        name: "simSwapTaoForAlpha",
        signature: "simSwapTaoForAlpha(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["netuid", "tao"],
      },
      {
        name: "simSwapAlphaForTao",
        signature: "simSwapAlphaForTao(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["netuid", "alpha"],
      },
      {
        name: "getSubnetMechanism",
        signature: "getSubnetMechanism(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getRootNetuid",
        signature: "getRootNetuid()",
        argTypes: [],
        argNames: [],
      },
      {
        name: "getEMAPriceHalvingBlocks",
        signature: "getEMAPriceHalvingBlocks(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getSubnetVolume",
        signature: "getSubnetVolume(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getTaoInEmission",
        signature: "getTaoInEmission(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getAlphaInEmission",
        signature: "getAlphaInEmission(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getAlphaOutEmission",
        signature: "getAlphaOutEmission(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getSumAlphaPrice",
        signature: "getSumAlphaPrice()",
        argTypes: [],
        argNames: [],
      },
    ],
  },
  {
    name: "Balance",
    index: 2062,
    address: "0x000000000000000000000000000000000000080e",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/balance.rs",
    functions: [
      {
        name: "getFreeBalance",
        signature: "getFreeBalance(bytes32)",
        argTypes: ["bytes32"],
        argNames: ["coldkey"],
      },
    ],
  },
  {
    name: "BalanceTransfer",
    index: 2048,
    address: "0x0000000000000000000000000000000000000800",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/balance_transfer.rs",
    functions: [
      {
        name: "transfer",
        signature: "transfer(bytes32)",
        argTypes: ["bytes32"],
        argNames: ["address"],
      },
    ],
  },
  {
    name: "Crowdloan",
    index: 2057,
    address: "0x0000000000000000000000000000000000000809",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/crowdloan.rs",
    functions: [
      {
        name: "getCrowdloan",
        signature: "getCrowdloan(uint32)",
        argTypes: ["uint32"],
        argNames: ["crowdloan_id"],
      },
      {
        name: "getContribution",
        signature: "getContribution(uint32,bytes32)",
        argTypes: ["uint32", "bytes32"],
        argNames: ["crowdloan_id", "coldkey"],
      },
      {
        name: "create",
        signature: "create(uint64,uint64,uint64,uint32,address)",
        argTypes: ["uint64", "uint64", "uint64", "uint32", "address"],
        argNames: [
          "deposit",
          "min_contribution",
          "cap",
          "end",
          "target_address",
        ],
      },
      {
        name: "contribute",
        signature: "contribute(uint32,uint64)",
        argTypes: ["uint32", "uint64"],
        argNames: ["crowdloan_id", "amount"],
      },
      {
        name: "withdraw",
        signature: "withdraw(uint32)",
        argTypes: ["uint32"],
        argNames: ["crowdloan_id"],
      },
      {
        name: "finalize",
        signature: "finalize(uint32)",
        argTypes: ["uint32"],
        argNames: ["crowdloan_id"],
      },
      {
        name: "refund",
        signature: "refund(uint32)",
        argTypes: ["uint32"],
        argNames: ["crowdloan_id"],
      },
      {
        name: "dissolve",
        signature: "dissolve(uint32)",
        argTypes: ["uint32"],
        argNames: ["crowdloan_id"],
      },
      {
        name: "updateMinContribution",
        signature: "updateMinContribution(uint32,uint64)",
        argTypes: ["uint32", "uint64"],
        argNames: ["crowdloan_id", "new_min_contribution"],
      },
      {
        name: "updateEnd",
        signature: "updateEnd(uint32,uint32)",
        argTypes: ["uint32", "uint32"],
        argNames: ["crowdloan_id", "new_end"],
      },
      {
        name: "updateCap",
        signature: "updateCap(uint32,uint64)",
        argTypes: ["uint32", "uint64"],
        argNames: ["crowdloan_id", "new_cap"],
      },
    ],
  },
  {
    name: "Leasing",
    index: 2058,
    address: "0x000000000000000000000000000000000000080a",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/leasing.rs",
    functions: [
      {
        name: "getLease",
        signature: "getLease(uint32)",
        argTypes: ["uint32"],
        argNames: ["lease_id"],
      },
      {
        name: "getContributorShare",
        signature: "getContributorShare(uint32,bytes32)",
        argTypes: ["uint32", "bytes32"],
        argNames: ["lease_id", "contributor"],
      },
      {
        name: "getLeaseIdForSubnet",
        signature: "getLeaseIdForSubnet(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "createLeaseCrowdloan",
        signature:
          "createLeaseCrowdloan(uint64,uint64,uint64,uint32,uint8,bool,uint32)",
        argTypes: [
          "uint64",
          "uint64",
          "uint64",
          "uint32",
          "uint8",
          "bool",
          "uint32",
        ],
        argNames: [
          "crowdloan_deposit",
          "crowdloan_min_contribution",
          "crowdloan_cap",
          "crowdloan_end",
          "leasing_emissions_share",
          "has_leasing_end_block",
          "leasing_end_block",
        ],
      },
      {
        name: "terminateLease",
        signature: "terminateLease(uint32,bytes32)",
        argTypes: ["uint32", "bytes32"],
        argNames: ["lease_id", "hotkey"],
      },
    ],
  },
  {
    name: "Metagraph",
    index: 2050,
    address: "0x0000000000000000000000000000000000000802",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/metagraph.rs",
    functions: [
      {
        name: "getUidCount",
        signature: "getUidCount(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getStake",
        signature: "getStake(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "uid"],
      },
      {
        name: "getRank",
        signature: "getRank(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["_netuid", "_uid"],
      },
      {
        name: "getTrust",
        signature: "getTrust(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["_netuid", "_uid"],
      },
      {
        name: "getConsensus",
        signature: "getConsensus(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "uid"],
      },
      {
        name: "getIncentive",
        signature: "getIncentive(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "uid"],
      },
      {
        name: "getDividends",
        signature: "getDividends(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "uid"],
      },
      {
        name: "getEmission",
        signature: "getEmission(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "uid"],
      },
      {
        name: "getVtrust",
        signature: "getVtrust(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "uid"],
      },
      {
        name: "getValidatorStatus",
        signature: "getValidatorStatus(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "uid"],
      },
      {
        name: "getLastUpdate",
        signature: "getLastUpdate(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "uid"],
      },
      {
        name: "getIsActive",
        signature: "getIsActive(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "uid"],
      },
      {
        name: "getAxon",
        signature: "getAxon(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "uid"],
      },
      {
        name: "getHotkey",
        signature: "getHotkey(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "uid"],
      },
      {
        name: "getColdkey",
        signature: "getColdkey(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "uid"],
      },
    ],
  },
  {
    name: "Neuron",
    index: 2052,
    address: "0x0000000000000000000000000000000000000804",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/neuron.rs",
    functions: [
      {
        name: "setWeights",
        signature: "setWeights(uint16,uint16[],uint16[],uint64)",
        argTypes: ["uint16", "uint16[]", "uint16[]", "uint64"],
        argNames: ["netuid", "dests", "weights", "version_key"],
      },
      {
        name: "commitWeights",
        signature: "commitWeights(uint16,bytes32)",
        argTypes: ["uint16", "bytes32"],
        argNames: ["netuid", "commit_hash"],
      },
      {
        name: "revealWeights",
        signature: "revealWeights(uint16,uint16[],uint16[],uint16[],uint64)",
        argTypes: ["uint16", "uint16[]", "uint16[]", "uint16[]", "uint64"],
        argNames: ["netuid", "uids", "values", "salt", "version_key"],
      },
      {
        name: "burnedRegister",
        signature: "burnedRegister(uint16,bytes32)",
        argTypes: ["uint16", "bytes32"],
        argNames: ["netuid", "hotkey"],
      },
      {
        name: "registerLimit",
        signature: "registerLimit(uint16,bytes32,uint64)",
        argTypes: ["uint16", "bytes32", "uint64"],
        argNames: ["netuid", "hotkey", "limit_price"],
      },
      {
        name: "serveAxon",
        signature:
          "serveAxon(uint16,uint32,uint128,uint16,uint8,uint8,uint8,uint8)",
        argTypes: [
          "uint16",
          "uint32",
          "uint128",
          "uint16",
          "uint8",
          "uint8",
          "uint8",
          "uint8",
        ],
        argNames: [
          "netuid",
          "version",
          "ip",
          "port",
          "ip_type",
          "protocol",
          "placeholder1",
          "placeholder2",
        ],
      },
      {
        name: "servePrometheus",
        signature: "servePrometheus(uint16,uint32,uint128,uint16,uint8)",
        argTypes: ["uint16", "uint32", "uint128", "uint16", "uint8"],
        argNames: ["netuid", "version", "ip", "port", "ip_type"],
      },
    ],
  },
  {
    name: "Proxy",
    index: 2059,
    address: "0x000000000000000000000000000000000000080b",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/proxy.rs",
    functions: [
      {
        name: "createPureProxy",
        signature: "createPureProxy(uint8,uint32,uint16)",
        argTypes: ["uint8", "uint32", "uint16"],
        argNames: ["proxy_type_", "delay", "index"],
      },
      {
        name: "killPureProxy",
        signature: "killPureProxy(bytes32,uint8,uint16,uint32,uint32)",
        argTypes: ["bytes32", "uint8", "uint16", "uint32", "uint32"],
        argNames: ["spawner", "proxy_type", "index", "height", "ext_index"],
      },
      {
        name: "proxyCall",
        signature: "proxyCall(bytes32,uint8[],uint8[])",
        argTypes: ["bytes32", "uint8[]", "uint8[]"],
        argNames: ["real", "force_proxy_type", "call"],
      },
      {
        name: "addProxy",
        signature: "addProxy(bytes32,uint8,uint32)",
        argTypes: ["bytes32", "uint8", "uint32"],
        argNames: ["delegate", "proxy_type", "delay"],
      },
      {
        name: "removeProxy",
        signature: "removeProxy(bytes32,uint8,uint32)",
        argTypes: ["bytes32", "uint8", "uint32"],
        argNames: ["delegate", "proxy_type", "delay"],
      },
      {
        name: "removeProxies",
        signature: "removeProxies()",
        argTypes: [],
        argNames: [],
      },
      {
        name: "pokeDeposit",
        signature: "pokeDeposit()",
        argTypes: [],
        argNames: [],
      },
      {
        name: "getProxies",
        signature: "getProxies(bytes32)",
        argTypes: ["bytes32"],
        argNames: ["account_id"],
      },
    ],
  },
  {
    name: "StakingV2",
    index: 2053,
    address: "0x0000000000000000000000000000000000000805",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/staking.rs",
    functions: [
      {
        name: "addStake",
        signature: "addStake(bytes32,uint256,uint256)",
        argTypes: ["bytes32", "uint256", "uint256"],
        argNames: ["address", "amount_rao", "netuid"],
      },
      {
        name: "removeStake",
        signature: "removeStake(bytes32,uint256,uint256)",
        argTypes: ["bytes32", "uint256", "uint256"],
        argNames: ["address", "amount_alpha", "netuid"],
      },
      {
        name: "removeStakeFull",
        signature: "removeStakeFull(bytes32,uint256)",
        argTypes: ["bytes32", "uint256"],
        argNames: ["hotkey", "netuid"],
      },
      {
        name: "removeStakeFullLimit",
        signature: "removeStakeFullLimit(bytes32,uint256,uint256)",
        argTypes: ["bytes32", "uint256", "uint256"],
        argNames: ["hotkey", "netuid", "limit_price"],
      },
      {
        name: "moveStake",
        signature: "moveStake(bytes32,bytes32,uint256,uint256,uint256)",
        argTypes: ["bytes32", "bytes32", "uint256", "uint256", "uint256"],
        argNames: [
          "origin_hotkey",
          "destination_hotkey",
          "origin_netuid",
          "destination_netuid",
          "amount_alpha",
        ],
      },
      {
        name: "transferStake",
        signature: "transferStake(bytes32,bytes32,uint256,uint256,uint256)",
        argTypes: ["bytes32", "bytes32", "uint256", "uint256", "uint256"],
        argNames: [
          "destination_coldkey",
          "hotkey",
          "origin_netuid",
          "destination_netuid",
          "amount_alpha",
        ],
      },
      {
        name: "burnAlpha",
        signature: "burnAlpha(bytes32,uint256,uint256)",
        argTypes: ["bytes32", "uint256", "uint256"],
        argNames: ["hotkey", "amount", "netuid"],
      },
      {
        name: "getTotalColdkeyStake",
        signature: "getTotalColdkeyStake(bytes32)",
        argTypes: ["bytes32"],
        argNames: ["coldkey"],
      },
      {
        name: "getTotalHotkeyStake",
        signature: "getTotalHotkeyStake(bytes32)",
        argTypes: ["bytes32"],
        argNames: ["hotkey"],
      },
      {
        name: "getStake",
        signature: "getStake(bytes32,bytes32,uint256)",
        argTypes: ["bytes32", "bytes32", "uint256"],
        argNames: ["hotkey", "coldkey", "netuid"],
      },
      {
        name: "getAlphaStakedValidators",
        signature: "getAlphaStakedValidators(bytes32,uint256)",
        argTypes: ["bytes32", "uint256"],
        argNames: ["hotkey", "netuid"],
      },
      {
        name: "getTotalAlphaStaked",
        signature: "getTotalAlphaStaked(bytes32,uint256)",
        argTypes: ["bytes32", "uint256"],
        argNames: ["hotkey", "netuid"],
      },
      {
        name: "getNominatorMinRequiredStake",
        signature: "getNominatorMinRequiredStake()",
        argTypes: [],
        argNames: [],
      },
      {
        name: "addProxy",
        signature: "addProxy(bytes32)",
        argTypes: ["bytes32"],
        argNames: ["delegate"],
      },
      {
        name: "removeProxy",
        signature: "removeProxy(bytes32)",
        argTypes: ["bytes32"],
        argNames: ["delegate"],
      },
      {
        name: "addStakeLimit",
        signature: "addStakeLimit(bytes32,uint256,uint256,bool,uint256)",
        argTypes: ["bytes32", "uint256", "uint256", "bool", "uint256"],
        argNames: [
          "address",
          "amount_rao",
          "limit_price_rao",
          "allow_partial",
          "netuid",
        ],
      },
      {
        name: "removeStakeLimit",
        signature: "removeStakeLimit(bytes32,uint256,uint256,bool,uint256)",
        argTypes: ["bytes32", "uint256", "uint256", "bool", "uint256"],
        argNames: [
          "address",
          "amount_alpha",
          "limit_price_rao",
          "allow_partial",
          "netuid",
        ],
      },
      {
        name: "getTotalColdkeyStakeOnSubnet",
        signature: "getTotalColdkeyStakeOnSubnet(bytes32,uint256)",
        argTypes: ["bytes32", "uint256"],
        argNames: ["coldkey", "netuid"],
      },
      {
        name: "approve",
        signature: "approve(address,uint256,uint256)",
        argTypes: ["address", "uint256", "uint256"],
        argNames: ["spender_address", "origin_netuid", "amount_alpha"],
      },
      {
        name: "allowance",
        signature: "allowance(address,address,uint256)",
        argTypes: ["address", "address", "uint256"],
        argNames: ["source_address", "spender_address", "origin_netuid"],
      },
      {
        name: "increaseAllowance",
        signature: "increaseAllowance(address,uint256,uint256)",
        argTypes: ["address", "uint256", "uint256"],
        argNames: ["spender_address", "origin_netuid", "amount_alpha_increase"],
      },
      {
        name: "decreaseAllowance",
        signature: "decreaseAllowance(address,uint256,uint256)",
        argTypes: ["address", "uint256", "uint256"],
        argNames: ["spender_address", "origin_netuid", "amount_alpha_decrease"],
      },
      {
        name: "transferStakeFrom",
        signature:
          "transferStakeFrom(address,address,bytes32,uint256,uint256,uint256)",
        argTypes: [
          "address",
          "address",
          "bytes32",
          "uint256",
          "uint256",
          "uint256",
        ],
        argNames: [
          "source_address",
          "destination_address",
          "hotkey",
          "origin_netuid",
          "destination_netuid",
          "amount_alpha",
        ],
      },
    ],
  },
  {
    name: "Staking",
    index: 2049,
    address: "0x0000000000000000000000000000000000000801",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/staking.rs",
    functions: [
      {
        name: "addStake",
        signature: "addStake(bytes32,uint256)",
        argTypes: ["bytes32", "uint256"],
        argNames: ["address", "netuid"],
      },
      {
        name: "removeStake",
        signature: "removeStake(bytes32,uint256,uint256)",
        argTypes: ["bytes32", "uint256", "uint256"],
        argNames: ["address", "amount", "netuid"],
      },
      {
        name: "getTotalColdkeyStake",
        signature: "getTotalColdkeyStake(bytes32)",
        argTypes: ["bytes32"],
        argNames: ["coldkey"],
      },
      {
        name: "getTotalHotkeyStake",
        signature: "getTotalHotkeyStake(bytes32)",
        argTypes: ["bytes32"],
        argNames: ["hotkey"],
      },
      {
        name: "getStake",
        signature: "getStake(bytes32,bytes32,uint256)",
        argTypes: ["bytes32", "bytes32", "uint256"],
        argNames: ["hotkey", "coldkey", "netuid"],
      },
      {
        name: "addProxy",
        signature: "addProxy(bytes32)",
        argTypes: ["bytes32"],
        argNames: ["delegate"],
      },
      {
        name: "removeProxy",
        signature: "removeProxy(bytes32)",
        argTypes: ["bytes32"],
        argNames: ["delegate"],
      },
    ],
  },
  {
    name: "Subnet",
    index: 2051,
    address: "0x0000000000000000000000000000000000000803",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/subnet.rs",
    functions: [
      {
        name: "registerNetwork",
        signature: "registerNetwork(bytes32)",
        argTypes: ["bytes32"],
        argNames: ["hotkey"],
      },
      {
        name: "getNetworkRegistrationBlock",
        signature: "getNetworkRegistrationBlock(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getServingRateLimit",
        signature: "getServingRateLimit(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setServingRateLimit",
        signature: "setServingRateLimit(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["netuid", "serving_rate_limit"],
      },
      {
        name: "getMinDifficulty",
        signature: "getMinDifficulty(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setMinDifficulty",
        signature: "setMinDifficulty(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["netuid", "min_difficulty"],
      },
      {
        name: "getMaxDifficulty",
        signature: "getMaxDifficulty(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setMaxDifficulty",
        signature: "setMaxDifficulty(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["netuid", "max_difficulty"],
      },
      {
        name: "getWeightsVersionKey",
        signature: "getWeightsVersionKey(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setWeightsVersionKey",
        signature: "setWeightsVersionKey(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["netuid", "weights_version_key"],
      },
      {
        name: "getWeightsSetRateLimit",
        signature: "getWeightsSetRateLimit(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setWeightsSetRateLimit",
        signature: "setWeightsSetRateLimit(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["_netuid", "_weights_set_rate_limit"],
      },
      {
        name: "getAdjustmentAlpha",
        signature: "getAdjustmentAlpha(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setAdjustmentAlpha",
        signature: "setAdjustmentAlpha(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["netuid", "adjustment_alpha"],
      },
      {
        name: "getMaxWeightLimit",
        signature: "getMaxWeightLimit(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getImmunityPeriod",
        signature: "getImmunityPeriod(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setImmunityPeriod",
        signature: "setImmunityPeriod(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "immunity_period"],
      },
      {
        name: "getMinAllowedWeights",
        signature: "getMinAllowedWeights(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setMinAllowedWeights",
        signature: "setMinAllowedWeights(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "min_allowed_weights"],
      },
      {
        name: "getKappa",
        signature: "getKappa(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setKappa",
        signature: "setKappa(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "kappa"],
      },
      {
        name: "getRho",
        signature: "getRho(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getAlphaSigmoidSteepness",
        signature: "getAlphaSigmoidSteepness(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setRho",
        signature: "setRho(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "rho"],
      },
      {
        name: "setAlphaSigmoidSteepness",
        signature: "setAlphaSigmoidSteepness(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "steepness"],
      },
      {
        name: "getActivityCutoff",
        signature: "getActivityCutoff(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setActivityCutoff",
        signature: "setActivityCutoff(uint16,uint16)",
        argTypes: ["uint16", "uint16"],
        argNames: ["netuid", "activity_cutoff"],
      },
      {
        name: "getActivityCutoffFactor",
        signature: "getActivityCutoffFactor(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setActivityCutoffFactor",
        signature: "setActivityCutoffFactor(uint16,uint32)",
        argTypes: ["uint16", "uint32"],
        argNames: ["netuid", "factor_milli"],
      },
      {
        name: "getNetworkRegistrationAllowed",
        signature: "getNetworkRegistrationAllowed(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setNetworkRegistrationAllowed",
        signature: "setNetworkRegistrationAllowed(uint16,bool)",
        argTypes: ["uint16", "bool"],
        argNames: ["netuid", "registration_allowed"],
      },
      {
        name: "getNetworkPowRegistrationAllowed",
        signature: "getNetworkPowRegistrationAllowed(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setNetworkPowRegistrationAllowed",
        signature: "setNetworkPowRegistrationAllowed(uint16,bool)",
        argTypes: ["uint16", "bool"],
        argNames: ["netuid", "registration_allowed"],
      },
      {
        name: "getMinBurn",
        signature: "getMinBurn(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setMinBurn",
        signature: "setMinBurn(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["_netuid", "_min_burn"],
      },
      {
        name: "getMaxBurn",
        signature: "getMaxBurn(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setMaxBurn",
        signature: "setMaxBurn(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["_netuid", "_max_burn"],
      },
      {
        name: "getDifficulty",
        signature: "getDifficulty(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setDifficulty",
        signature: "setDifficulty(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["netuid", "difficulty"],
      },
      {
        name: "getBondsMovingAverage",
        signature: "getBondsMovingAverage(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setBondsMovingAverage",
        signature: "setBondsMovingAverage(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["netuid", "bonds_moving_average"],
      },
      {
        name: "getCommitRevealWeightsEnabled",
        signature: "getCommitRevealWeightsEnabled(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setCommitRevealWeightsEnabled",
        signature: "setCommitRevealWeightsEnabled(uint16,bool)",
        argTypes: ["uint16", "bool"],
        argNames: ["netuid", "enabled"],
      },
      {
        name: "getLiquidAlphaEnabled",
        signature: "getLiquidAlphaEnabled(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setLiquidAlphaEnabled",
        signature: "setLiquidAlphaEnabled(uint16,bool)",
        argTypes: ["uint16", "bool"],
        argNames: ["netuid", "enabled"],
      },
      {
        name: "getYuma3Enabled",
        signature: "getYuma3Enabled(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getBondsResetEnabled",
        signature: "getBondsResetEnabled(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setYuma3Enabled",
        signature: "setYuma3Enabled(uint16,bool)",
        argTypes: ["uint16", "bool"],
        argNames: ["netuid", "enabled"],
      },
      {
        name: "setBondsResetEnabled",
        signature: "setBondsResetEnabled(uint16,bool)",
        argTypes: ["uint16", "bool"],
        argNames: ["netuid", "enabled"],
      },
      {
        name: "getAlphaValues",
        signature: "getAlphaValues(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setAlphaValues",
        signature: "setAlphaValues(uint16,uint16,uint16)",
        argTypes: ["uint16", "uint16", "uint16"],
        argNames: ["netuid", "alpha_low", "alpha_high"],
      },
      {
        name: "getCommitRevealWeightsInterval",
        signature: "getCommitRevealWeightsInterval(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "setCommitRevealWeightsInterval",
        signature: "setCommitRevealWeightsInterval(uint16,uint64)",
        argTypes: ["uint16", "uint64"],
        argNames: ["netuid", "interval"],
      },
      {
        name: "toggleTransfers",
        signature: "toggleTransfers(uint16,bool)",
        argTypes: ["uint16", "bool"],
        argNames: ["netuid", "toggle"],
      },
      {
        name: "isSubnetDissolving",
        signature: "isSubnetDissolving(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
    ],
  },
  {
    name: "UidLookup",
    index: 2054,
    address: "0x0000000000000000000000000000000000000806",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/uid_lookup.rs",
    functions: [
      {
        name: "uidLookup",
        signature: "uidLookup(uint16,address,uint16)",
        argTypes: ["uint16", "address", "uint16"],
        argNames: ["netuid", "evm_address", "limit"],
      },
    ],
  },
  {
    name: "VotingPower",
    index: 2061,
    address: "0x000000000000000000000000000000000000080d",
    source:
      "https://github.com/opentensor/subtensor/blob/main/precompiles/src/voting_power.rs",
    functions: [
      {
        name: "getVotingPower",
        signature: "getVotingPower(uint16,bytes32)",
        argTypes: ["uint16", "bytes32"],
        argNames: ["netuid", "hotkey"],
      },
      {
        name: "isVotingPowerTrackingEnabled",
        signature: "isVotingPowerTrackingEnabled(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getVotingPowerDisableAtBlock",
        signature: "getVotingPowerDisableAtBlock(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getVotingPowerEmaAlpha",
        signature: "getVotingPowerEmaAlpha(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
      {
        name: "getTotalVotingPower",
        signature: "getTotalVotingPower(uint16)",
        argTypes: ["uint16"],
        argNames: ["netuid"],
      },
    ],
  },
];

// Lookup indices, built once at module load: by address (lowercase hex, for
// "is this `to` a known precompile") and by address+selector (for "which
// function was called"). `functionSelector` runs here, not baked into the
// generated table above, so a signature transcription bug would show up as a
// selector mismatch in tests rather than silently trusting a hand-typed hex
// value.
export const EVM_PRECOMPILE_BY_ADDRESS = new Map();
const FUNCTION_BY_ADDRESS_AND_SELECTOR = new Map();

for (const precompile of EVM_PRECOMPILES) {
  const address = precompile.address.toLowerCase();
  EVM_PRECOMPILE_BY_ADDRESS.set(address, precompile);
  for (const fn of precompile.functions) {
    fn.selector = functionSelector(fn.signature);
    FUNCTION_BY_ADDRESS_AND_SELECTOR.set(`${address}:${fn.selector}`, fn);
  }
}

/** Case-insensitive precompile lookup by H160 address, or undefined if
 * `address` isn't one of the 16 known precompile addresses. */
export function findEvmPrecompile(address) {
  if (typeof address !== "string") return undefined;
  return EVM_PRECOMPILE_BY_ADDRESS.get(address.toLowerCase());
}

// Decodes one 32-byte-aligned static word per the small, closed type universe
// every precompile function here actually uses (verified against the full
// extracted signature set: address, bool, bytes32, uint8/16/32/64/128/256 --
// no bytes/string/tuple/struct params anywhere in the 16 precompiles).
// Returns null on a type this table has never seen, rather than guessing.
function decodeStaticWord(type, word) {
  switch (type) {
    case "address":
      return bytesToHexString(word.slice(12, 32));
    case "bool":
      return word[31] !== 0;
    case "bytes32":
      return bytesToHexString(word);
    case "uint8":
    case "uint16":
    case "uint32": {
      // Safe as a plain Number: max uint32 (4294967295) is far below
      // Number.MAX_SAFE_INTEGER, unlike uint64/128/256 below.
      let value = 0;
      for (const b of word) value = value * 256 + b;
      return value;
    }
    case "uint64":
    case "uint128":
    case "uint256": {
      // Decimal STRING via BigInt, matching src/indexer-rs-ethereum-decode.mjs's
      // own U256 convention (ethers.js/web3.js/viem never represent these as a
      // plain JS number) -- uint64's max already exceeds MAX_SAFE_INTEGER.
      let value = 0n;
      for (const b of word) value = (value << 8n) | BigInt(b);
      return value.toString();
    }
    default:
      return null;
  }
}

function readWord(bytes, wordIndex) {
  const start = wordIndex * WORD_BYTES;
  const word = bytes.slice(start, start + WORD_BYTES);
  return word.length === WORD_BYTES ? word : null;
}

// Solidity/Frontier ABI "head-tail" decode for the closed set of shapes this
// table needs: N static or dynamic-array head slots, each 32 bytes. A static
// slot holds its value directly; a dynamic array slot holds a byte offset
// (relative to the start of the argument-encoding region, i.e. byte 0 right
// after the 4-byte selector) to a [length][element0][element1]...] region,
// every element itself still word-aligned (true of every ABI-encoded array,
// even of a narrow element type like uint8/uint16). Returns null on
// truncated/malformed calldata rather than throwing or returning partial
// data -- the same "decline rather than guess" contract every decoder in
// src/indexer-rs-ethereum-decode.mjs already follows.
export function decodeAbiArgs(argTypes, argNames, dataHex) {
  const bytes = hexToBytes(dataHex);
  const args = {};
  for (let i = 0; i < argTypes.length; i += 1) {
    const type = argTypes[i];
    const name = argNames[i];
    const headWord = readWord(bytes, i);
    if (!headWord) return null;
    if (type.endsWith("[]")) {
      const baseType = type.slice(0, -2);
      const offset = Number(decodeStaticWord("uint256", headWord));
      if (!Number.isFinite(offset) || offset % WORD_BYTES !== 0) return null;
      const lengthWord = readWord(bytes, offset / WORD_BYTES);
      if (!lengthWord) return null;
      // decodeStaticWord("uint256", ...) is a plain big-endian byte
      // accumulation -- always a non-negative, always-finite value for any
      // 32-byte input (max 2^256-1 is far below Number.MAX_VALUE), so there
      // is no separate finite/negative case to guard here.
      const length = Number(decodeStaticWord("uint256", lengthWord));
      const items = [];
      for (let j = 0; j < length; j += 1) {
        const itemWord = readWord(bytes, offset / WORD_BYTES + 1 + j);
        if (!itemWord) return null;
        items.push(decodeStaticWord(baseType, itemWord));
      }
      args[name] = items;
    } else {
      // null is decodeStaticWord's unambiguous "unrecognized type" sentinel --
      // every real decoded value (false, 0, "0", a hex string) is never
      // itself strictly null, so this can only mean the registry declared a
      // type outside the closed universe above. Never happens with the real
      // table (every one of its 158 functions is drawn from that universe,
      // verified in tests/evm-precompiles.test.mjs), but decline the whole
      // decode rather than return a silently-misleading partial object.
      const value = decodeStaticWord(type, headWord);
      if (value === null) return null;
      args[name] = value;
    }
  }
  return args;
}

/** Identifies + decodes one Ethereum.transact call's `to`/`input` against the
 * precompile registry above. Returns null when `to` isn't one of the 16 known
 * precompile addresses (an ordinary contract call, not a precompile call --
 * the common case for most captured calldata). When `to` IS a known
 * precompile but the 4-byte selector doesn't match any of its declared
 * functions (a runtime upgrade added a function this table hasn't been
 * updated for, or a malformed/adversarial call), returns the identified
 * precompile with `function: null` rather than silently dropping the match --
 * still useful signal ("this called the Subnet precompile, function unknown")
 * even without arg-level decoding. */
export function decodeEvmPrecompileCall(to, inputHex) {
  const precompile = findEvmPrecompile(to);
  if (!precompile) return null;
  if (typeof inputHex !== "string" || !/^0x[0-9a-fA-F]*$/.test(inputHex)) {
    return {
      precompile: precompile.name,
      address: precompile.address,
      function: null,
    };
  }
  const selector = inputHex.slice(0, 10).toLowerCase();
  if (selector.length !== 10) {
    return {
      precompile: precompile.name,
      address: precompile.address,
      function: null,
    };
  }
  const fn = FUNCTION_BY_ADDRESS_AND_SELECTOR.get(
    `${precompile.address}:${selector}`,
  );
  if (!fn) {
    return {
      precompile: precompile.name,
      address: precompile.address,
      function: null,
    };
  }
  const args = decodeAbiArgs(
    fn.argTypes,
    fn.argNames,
    "0x" + inputHex.slice(10),
  );
  return {
    precompile: precompile.name,
    address: precompile.address,
    function: fn.name,
    signature: fn.signature,
    args,
  };
}
