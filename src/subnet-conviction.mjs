// Live subnet-ownership-contest ("conviction") leaderboard (#6638, part of
// the conviction/ownership-contest tracker epic #4302) -- rolls each
// captured subnet_locks row forward from its own last_update to "now" using
// the CURRENT (live-queried) UnlockRate/MaturityRate, replicating the
// pallet's own ConvictionModel::roll_forward_lock/exp_decay math (verified
// byte-for-byte against pallets/subtensor/src/staking/lock.rs and live
// chain-state samples 2026-07-18 -- see docs/conviction-lock-mechanism.md
// and this module's own tests for the specific reconciliation numbers).
// Pure shaping (buildSubnetConviction) over raw subnet_locks rows + a live
// {unlock_rate, maturity_rate} pair -- mirrors src/subnet-ohlc.mjs's own
// "unaggregated rows, shaped in JS" convention. Null-safe: a subnet with no
// captured lock rows yields an empty leaderboard (never throws), matching
// the sibling live tiers.

// exp(-dt/tau), matching the pallet's own I64F64::exp with its -40 exponent
// floor (prevents underflow past a threshold; anything below floors to 0).
// dt=0 -> 1 (no time has passed, nothing decayed); tau=0 -> 0 (an
// instantaneous/zero-width decay window, i.e. maximally decayed already).
const EXP_MIN_EXPONENT = -40;

function expDecay(dt, tau) {
  if (dt === 0) return 1;
  if (tau === 0) return 0;
  const exponent = Math.max(-dt / tau, EXP_MIN_EXPONENT);
  const decay = Math.exp(exponent);
  return decay < 0 ? 0 : decay;
}

// Replicates calculate_decayed_mass_and_conviction (lock.rs): returns the
// rolled-forward {lockedMass, conviction} pair for one sub-aggregate row.
// The three-way branch on unlockRate vs. maturityRate mirrors the pallet's
// own piecewise formula exactly -- do not simplify to a single case, since
// UnlockRate and MaturityRate are independently governance-adjustable and
// have already been observed live to differ (confirmed 2026-07-18:
// MaturityRate=311622 vs UnlockRate=934866 on mainnet).
function decayMassAndConviction(
  lockedMass,
  conviction,
  dt,
  unlockRate,
  maturityRate,
  isPerpetual,
) {
  const unlockDecay = expDecay(dt, unlockRate);
  const maturityDecay = expDecay(dt, maturityRate);

  const newLockedMass = isPerpetual
    ? lockedMass
    : Math.floor(unlockDecay * lockedMass);

  const convictionFromExisting = maturityDecay * conviction;

  let convictionFromMass;
  if (isPerpetual) {
    convictionFromMass = lockedMass * (1 - maturityDecay);
  } else if (unlockRate === maturityRate) {
    convictionFromMass =
      maturityRate > 0 ? lockedMass * (dt / maturityRate) * maturityDecay : 0;
  } else if (unlockRate === 0 || maturityRate === 0) {
    convictionFromMass = 0;
  } else {
    const gamma =
      (unlockRate * (unlockDecay - maturityDecay)) /
      (unlockRate - maturityRate);
    convictionFromMass = gamma <= 0 ? 0 : lockedMass * gamma;
  }

  return {
    lockedMass: newLockedMass,
    conviction: convictionFromExisting + convictionFromMass,
  };
}

// Replicates roll_forward_lock (lock.rs): rolls one row forward to `now`,
// then applies the owner special-case (conviction := locked_mass exactly --
// verified live 2026-07-18: a real OwnerLock row's conviction.bits / 2**64
// matched its own locked_mass almost exactly, modulo the sub-block rounding
// the pallet's own roll-forward introduces between reads).
function rollForwardLock(row, now, unlockRate, maturityRate) {
  const lastUpdate = row.last_update ?? now;
  let lockedMass = row.locked_mass;
  let conviction = row.conviction;

  if (now > lastUpdate) {
    const dt = now - lastUpdate;
    const rolled = decayMassAndConviction(
      lockedMass,
      conviction,
      dt,
      unlockRate,
      maturityRate,
      row.is_perpetual,
    );
    lockedMass = rolled.lockedMass;
    conviction = rolled.conviction;
  }

  if (row.is_owner) {
    conviction = lockedMass;
  }

  if (lockedMass <= 0 && conviction <= 0) {
    lockedMass = 0;
    conviction = 0;
  }

  return { lockedMass, conviction };
}

// One raw subnet_locks row -> {lockedMass, conviction} as JS numbers.
// conviction_bits arrives as a Postgres NUMERIC (u128 decimal string) --
// split whole/remainder in BigInt space before dividing (mirrors src/
// network-parameters.mjs's u64f64ToFloat, generalized from u64 to u128 --
// same precision reasoning: a naive Number(bits)/Number(2**64) routes the
// numerator through double rounding before dividing at all).
const U64F64_SCALE = 2n ** 64n;

function u64f64BitsToFloat(bitsStr) {
  let bits;
  try {
    bits = BigInt(bitsStr ?? "0");
  } catch {
    return 0;
  }
  const whole = bits / U64F64_SCALE;
  const remainder = bits % U64F64_SCALE;
  return Number(whole) + Number(remainder) / Number(U64F64_SCALE);
}

function toNumbers(row) {
  return {
    ...row,
    locked_mass: Number(row.locked_mass) || 0,
    conviction: u64f64BitsToFloat(row.conviction_bits),
  };
}

// Groups the perpetual + decaying sub-aggregate rows for the same
// (netuid, hotkey, is_owner) identity, rolls EACH forward independently
// (they decay -- or don't -- on their own rule; summing raw before rolling
// would be wrong), then sums the rolled results into one leaderboard entry.
function combineSubAggregates(rows, now, unlockRate, maturityRate) {
  const byIdentity = new Map();
  for (const row of rows) {
    const key = `${row.hotkey}:${row.is_owner}`;
    if (!byIdentity.has(key)) {
      byIdentity.set(key, {
        hotkey: row.hotkey,
        is_owner: row.is_owner,
        rolled: [],
      });
    }
    byIdentity
      .get(key)
      .rolled.push(
        rollForwardLock(toNumbers(row), now, unlockRate, maturityRate),
      );
  }
  return [...byIdentity.values()].map((entry) => {
    const lockedMass = entry.rolled.reduce((sum, r) => sum + r.lockedMass, 0);
    const conviction = entry.rolled.reduce((sum, r) => sum + r.conviction, 0);
    return {
      hotkey: entry.hotkey,
      is_owner: entry.is_owner,
      locked_mass: lockedMass,
      conviction,
    };
  });
}

// `rows` are raw subnet_locks rows for one netuid (all is_owner/is_perpetual
// combinations); `unlockRate`/`maturityRate` are the CURRENT live-queried
// governance values (never hardcode -- see module header); `now` is the
// current block height. Empty/absent rows -> the schema-stable empty-
// leaderboard shape, never a 404 -- most subnets have no active challengers.
export function buildSubnetConviction(
  rows,
  netuid,
  { now, unlockRate, maturityRate } = {},
) {
  const combined = combineSubAggregates(
    rows ?? [],
    now ?? 0,
    unlockRate ?? 0,
    maturityRate ?? 0,
  )
    .filter((entry) => entry.locked_mass > 0 || entry.conviction > 0)
    .sort((a, b) => b.conviction - a.conviction);

  return {
    schema_version: 1,
    netuid,
    queried_at_block: now ?? null,
    unlock_rate: unlockRate ?? null,
    maturity_rate: maturityRate ?? null,
    king: combined[0]?.hotkey ?? null,
    count: combined.length,
    leaderboard: combined,
  };
}

// ─── Live UnlockRate / MaturityRate + current block (RPC) ──────────────────
//
// Both are plain StorageValues -- twox128("SubtensorModule") ++
// twox128(<item name>), no further hashing, hardcoded below (mirrors
// sudo-key.mjs/network-parameters.mjs's own precedent, since twox128 needs
// XXHash64, not in Node's built-in crypto). Both declared `ValueQuery` with
// a compiled-in default (`StorageValue<_, u64, ValueQuery, DefaultXxxRate<T>>`
// in lib.rs) -- IMPORTANT, confirmed live 2026-07-18: a raw state_getStorage
// read on UnlockRate returns null (never explicitly governance-set on
// mainnet), which is NOT the same as "unset means 0" the way an OptionQuery
// item like Burn(netuid) works elsewhere in this codebase -- ValueQuery
// means the runtime falls back to the compiled default instead. Confirmed
// via substrate-interface's high-level query() (which correctly applies
// this fallback from the chain's own metadata): the effective UnlockRate is
// 934866. MaturityRate's raw storage IS explicitly set (311622, genuinely
// different from UnlockRate -- exactly why both are live-queried on every
// call, never hardcoded as a single shared "default"), so it decodes
// directly with no fallback needed today -- but the same fallback constant
// is applied defensively in case it's ever cleared back to unset.
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";
export const CONVICTION_RATES_RPC_TIMEOUT_MS = 5000;
// The compiled DefaultUnlockRate/DefaultMaturityRate value, used ONLY when
// raw storage is unset (see comment above) -- not a live value itself.
const RATE_VALUE_QUERY_DEFAULT = 934_866;

// twox128("SubtensorModule") ++ twox128("UnlockRate").
const UNLOCK_RATE_STORAGE_KEY =
  "0x658faa385070e074c85bf6b568cf05554c758f6a2be5bef862df918db3e8cadb";
// twox128("SubtensorModule") ++ twox128("MaturityRate").
const MATURITY_RATE_STORAGE_KEY =
  "0x658faa385070e074c85bf6b568cf0555fee4fedba075f0cd6daea164181ed3cb";

// Decode a "0x"-prefixed, 16-hex-char (8-byte) little-endian u64 into a
// plain Number (both rates are small block-count integers, well under
// Number.MAX_SAFE_INTEGER -- no BigInt needed for these two specifically).
function decodeLeU64Number(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{16}$/.test(hex)) {
    return null;
  }
  let value = 0n;
  for (let i = hex.length - 2; i >= 2; i -= 2) {
    value = (value << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  }
  return Number(value);
}

async function rpcCall(method, params, timeoutMs) {
  try {
    const res = await fetch(FINNEY_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.result ?? null;
  } catch {
    return null;
  }
}

// Unlike an OptionQuery item elsewhere in this codebase (e.g. Burn(netuid)
// in subnet-burn.mjs, where "unset" is a real, meaningful 0), both
// UnlockRate and MaturityRate are ValueQuery -- raw-unset storage means
// "use the compiled default", not "the value is zero" (see module header).
// A zero decay-rate constant would be a serious correctness bug here: it
// would make exp_decay(dt, 0) evaluate to 0 for every roll-forward, treating
// every lock as already fully decayed to nothing on every single call.
async function fetchStorageU64Number(storageKey, timeoutMs) {
  const raw = await rpcCall("state_getStorage", [storageKey], timeoutMs);
  const value = decodeLeU64Number(raw);
  if (value != null) return value;
  if (raw === null) return RATE_VALUE_QUERY_DEFAULT;
  return null;
}

// chain_getHeader's `number` field is a plain hex-string block height (NOT
// a SCALE-encoded storage blob -- no byte-reversal, unlike decodeLeU64Number
// above), e.g. "0x83f1ad". Used as "now" for the roll-forward math -- a
// live tip within the last few seconds is comfortably fresh enough given
// UnlockRate/MaturityRate's decay time constants are on the order of
// hundreds of thousands of blocks.
async function fetchCurrentBlock(timeoutMs) {
  const header = await rpcCall("chain_getHeader", [], timeoutMs);
  const hex = header?.number;
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) return null;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : null;
}

// The three live values buildSubnetConviction's `now`/`unlockRate`/
// `maturityRate` options need, fetched in parallel. Each is independently
// null on its own RPC failure (schema-stable, never throws) -- mirrors
// network-parameters.mjs's own loadNetworkParameters shape.
export async function fetchConvictionRates(
  timeoutMs = CONVICTION_RATES_RPC_TIMEOUT_MS,
) {
  const [unlockRate, maturityRate, now] = await Promise.all([
    fetchStorageU64Number(UNLOCK_RATE_STORAGE_KEY, timeoutMs),
    fetchStorageU64Number(MATURITY_RATE_STORAGE_KEY, timeoutMs),
    fetchCurrentBlock(timeoutMs),
  ]);
  return { unlockRate, maturityRate, now };
}
