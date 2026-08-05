// src/extrinsics.ts
function isDecodedCall(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof value.call_module === "string" && typeof value.call_function === "string";
}
function normalizeIndexerRsCall(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outer = value;
  if (typeof outer.name !== "string") return null;
  if (!Array.isArray(outer.values) || outer.values.length !== 1) return null;
  const inner = outer.values[0];
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;
  const innerName = inner.name;
  if (typeof innerName !== "string") return null;
  return {
    call_module: outer.name,
    call_function: innerName,
    call_args: inner.values
  };
}
function asDecodedCall(value) {
  if (isDecodedCall(value)) return value;
  return normalizeIndexerRsCall(value);
}
function callArgValue(callArgs, name) {
  if (Array.isArray(callArgs)) {
    return callArgs.find(
      (a) => a?.name === name
    )?.value;
  }
  if (callArgs && typeof callArgs === "object") {
    return callArgs[name];
  }
  return void 0;
}

// src/ss58.ts
var BLAKE2B_IV32 = new Uint32Array([
  4089235720,
  1779033703,
  2227873595,
  3144134277,
  4271175723,
  1013904242,
  1595750129,
  2773480762,
  2917565137,
  1359893119,
  725511199,
  2600822924,
  4215389547,
  528734635,
  327033209,
  1541459225
]);
var SIGMA8 = [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  14,
  10,
  4,
  8,
  9,
  15,
  13,
  6,
  1,
  12,
  0,
  2,
  11,
  7,
  5,
  3,
  11,
  8,
  12,
  0,
  5,
  2,
  15,
  13,
  10,
  14,
  3,
  6,
  7,
  1,
  9,
  4,
  7,
  9,
  3,
  1,
  13,
  12,
  11,
  14,
  2,
  6,
  5,
  10,
  4,
  0,
  15,
  8,
  9,
  0,
  5,
  7,
  2,
  4,
  10,
  15,
  14,
  1,
  11,
  12,
  6,
  8,
  3,
  13,
  2,
  12,
  6,
  10,
  0,
  11,
  8,
  3,
  4,
  13,
  7,
  5,
  15,
  14,
  1,
  9,
  12,
  5,
  1,
  15,
  14,
  13,
  4,
  10,
  0,
  7,
  6,
  3,
  9,
  2,
  8,
  11,
  13,
  11,
  7,
  14,
  12,
  1,
  3,
  9,
  5,
  0,
  15,
  4,
  8,
  6,
  2,
  10,
  6,
  15,
  14,
  9,
  11,
  3,
  0,
  8,
  12,
  2,
  13,
  7,
  1,
  4,
  10,
  5,
  10,
  2,
  8,
  4,
  7,
  6,
  1,
  5,
  15,
  11,
  9,
  14,
  3,
  12,
  13,
  0,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  14,
  10,
  4,
  8,
  9,
  15,
  13,
  6,
  1,
  12,
  0,
  2,
  11,
  7,
  5,
  3
];
var SIGMA82 = new Uint8Array(SIGMA8.map((x) => x * 2));
var v = new Uint32Array(32);
var m = new Uint32Array(32);
function add64aa(a, b) {
  const lo = v[a] + v[b];
  let hi = v[a + 1] + v[b + 1];
  if (lo >= 4294967296) hi++;
  v[a] = lo;
  v[a + 1] = hi;
}
function add64ac(a, b0, b1) {
  let lo = v[a] + b0;
  if (b0 < 0) lo += 4294967296;
  let hi = v[a + 1] + b1;
  if (lo >= 4294967296) hi++;
  v[a] = lo >>> 0;
  v[a + 1] = hi >>> 0;
}
function get32(arr, i) {
  return (arr[i] ^ arr[i + 1] << 8 ^ arr[i + 2] << 16 ^ arr[i + 3] << 24) >>> 0;
}
function mix(a, b, c, d, ix, iy) {
  const x0 = m[ix];
  const x1 = m[ix + 1];
  const y0 = m[iy];
  const y1 = m[iy + 1];
  add64aa(a, b);
  add64ac(a, x0, x1);
  let xor0 = v[d] ^ v[a];
  let xor1 = v[d + 1] ^ v[a + 1];
  v[d] = xor1;
  v[d + 1] = xor0;
  add64aa(c, d);
  xor0 = v[b] ^ v[c];
  xor1 = v[b + 1] ^ v[c + 1];
  v[b] = xor0 >>> 24 ^ xor1 << 8;
  v[b + 1] = xor1 >>> 24 ^ xor0 << 8;
  add64aa(a, b);
  add64ac(a, y0, y1);
  xor0 = v[d] ^ v[a];
  xor1 = v[d + 1] ^ v[a + 1];
  v[d] = xor0 >>> 16 ^ xor1 << 16;
  v[d + 1] = xor1 >>> 16 ^ xor0 << 16;
  add64aa(c, d);
  xor0 = v[b] ^ v[c];
  xor1 = v[b + 1] ^ v[c + 1];
  v[b] = xor1 >>> 31 ^ xor0 << 1;
  v[b + 1] = xor0 >>> 31 ^ xor1 << 1;
}
function compress(ctx, last) {
  for (let i = 0; i < 16; i++) {
    v[i] = ctx.h[i];
    v[i + 16] = BLAKE2B_IV32[i];
  }
  v[24] = (v[24] ^ ctx.t) >>> 0;
  v[25] = (v[25] ^ ctx.t / 4294967296) >>> 0;
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }
  for (let i = 0; i < 32; i++) m[i] = get32(ctx.b, 4 * i);
  for (let i = 0; i < 12; i++) {
    const o = i * 16;
    mix(0, 8, 16, 24, SIGMA82[o + 0], SIGMA82[o + 1]);
    mix(2, 10, 18, 26, SIGMA82[o + 2], SIGMA82[o + 3]);
    mix(4, 12, 20, 28, SIGMA82[o + 4], SIGMA82[o + 5]);
    mix(6, 14, 22, 30, SIGMA82[o + 6], SIGMA82[o + 7]);
    mix(0, 10, 20, 30, SIGMA82[o + 8], SIGMA82[o + 9]);
    mix(2, 12, 22, 24, SIGMA82[o + 10], SIGMA82[o + 11]);
    mix(4, 14, 16, 26, SIGMA82[o + 12], SIGMA82[o + 13]);
    mix(6, 8, 18, 28, SIGMA82[o + 14], SIGMA82[o + 15]);
  }
  for (let i = 0; i < 16; i++) ctx.h[i] = (ctx.h[i] ^ v[i] ^ v[i + 16]) >>> 0;
}
function blake2b(input, outlen = 64) {
  const ctx = {
    b: new Uint8Array(128),
    h: new Uint32Array(BLAKE2B_IV32),
    t: 0,
    c: 0
  };
  ctx.h[0] = (ctx.h[0] ^ 16842752 ^ outlen) >>> 0;
  for (let i = 0; i < input.length; i++) {
    if (ctx.c === 128) {
      ctx.t += ctx.c;
      compress(ctx, false);
      ctx.c = 0;
    }
    ctx.b[ctx.c++] = input[i];
  }
  ctx.t += ctx.c;
  while (ctx.c < 128) ctx.b[ctx.c++] = 0;
  compress(ctx, true);
  const out = new Uint8Array(outlen);
  for (let i = 0; i < outlen; i++) out[i] = ctx.h[i >> 2] >> 8 * (i & 3) & 255;
  return out;
}
var BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = carry / 58 | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = carry / 58 | 0;
    }
  }
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) leadingZeros++;
    else break;
  }
  let out = "1".repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}
function base58Decode(input) {
  const bytes = [0];
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (const char of input) {
    if (char === "1") leadingZeros++;
    else break;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[leadingZeros + bytes.length - 1 - i] = bytes[i];
  return out;
}
var SS58_PREFIX = new TextEncoder().encode("SS58PRE");
var DEFAULT_SS58_FORMAT = 42;
function encodeSs58(pubkey, format = DEFAULT_SS58_FORMAT) {
  if (pubkey.length !== 32) return null;
  const payload = new Uint8Array(1 + pubkey.length);
  payload[0] = format;
  payload.set(pubkey, 1);
  const input = new Uint8Array(SS58_PREFIX.length + payload.length);
  input.set(SS58_PREFIX);
  input.set(payload, SS58_PREFIX.length);
  const checksum = blake2b(input, 64);
  const full = new Uint8Array(payload.length + 2);
  full.set(payload);
  full.set(checksum.slice(0, 2), payload.length);
  return base58Encode(full);
}
function decodeSs58(address) {
  const bytes = base58Decode(address.trim());
  if (!bytes || bytes.length < 3) return null;
  const first = bytes[0];
  if (first >= 128) return null;
  if (first > 63) {
    return {
      valid: false,
      format: -1,
      pubkey: null,
      checksumValid: false,
      extendedFormat: true
    };
  }
  if (bytes.length !== 35) return null;
  const format = first;
  const payload = bytes.slice(0, 33);
  const checksum = bytes.slice(33, 35);
  const input = new Uint8Array(SS58_PREFIX.length + payload.length);
  input.set(SS58_PREFIX);
  input.set(payload, SS58_PREFIX.length);
  const expectedChecksum = blake2b(input, 64);
  const checksumValid = checksum[0] === expectedChecksum[0] && checksum[1] === expectedChecksum[1];
  return {
    valid: checksumValid,
    format,
    pubkey: checksumValid ? payload.slice(1) : null,
    checksumValid,
    extendedFormat: false
  };
}

// src/chain-event-args.ts
var ACCOUNT_KEYS = /* @__PURE__ */ new Set([
  "who",
  "account",
  "account_id",
  "accountid",
  "coldkey",
  "hotkey",
  "from",
  "to",
  "dest",
  "destination",
  "source",
  "delegate",
  "nominator",
  "owner",
  "target",
  "validator",
  "address"
]);
function isByteArray(v2, len) {
  return Array.isArray(v2) && v2.length === len && v2.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255);
}
function toHex(bytes) {
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}
function decode(value, keyHint) {
  if (isByteArray(value, 32)) {
    if (keyHint && ACCOUNT_KEYS.has(keyHint.toLowerCase())) {
      return encodeSs58(Uint8Array.from(value)) ?? toHex(value);
    }
    return toHex(value);
  }
  if (Array.isArray(value)) return value.map((item) => decode(item, keyHint));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, val] of Object.entries(value))
      out[k] = decode(val, k);
    return out;
  }
  return value;
}
function decodeChainEventArgs(args) {
  return decode(args, void 0);
}
function formatChainEventArgs(args) {
  if (args == null) return "\u2014";
  try {
    return JSON.stringify(decodeChainEventArgs(args)) ?? "\u2014";
  } catch {
    return "[Unserializable value]";
  }
}

// src/chain-event-summary.ts
var RAO_PER_TAO = 1e9;
var FROM_KEYS = ["from", "source", "who", "account", "coldkey", "hotkey", "sender"];
var TO_KEYS = ["to", "dest", "destination", "target", "delegate", "validator", "recipient"];
var AMOUNT_KEYS = [
  "amount",
  "amount_tao",
  "value",
  "stake",
  "actual_fee",
  "fee",
  "tip",
  "balance"
];
var NOISE_EVENTS = /* @__PURE__ */ new Set([
  "System.ExtrinsicSuccess",
  "System.ExtrinsicFailed",
  "TransactionPayment.TransactionFeePaid"
]);
function isNoiseEvent(pallet, method) {
  if (!pallet || !method) return false;
  return NOISE_EVENTS.has(`${pallet}.${method}`);
}
function unwrap(value) {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function pick(args, keys) {
  const lower = new Map(Object.entries(args).map(([k, v2]) => [k.toLowerCase(), v2]));
  for (const key of keys) {
    if (lower.has(key)) {
      const value = unwrap(lower.get(key));
      if (value != null) return value;
    }
  }
  return void 0;
}
function asAddress(value) {
  return typeof value === "string" && value.length > 40 && !value.startsWith("0x") ? value : null;
}
function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}
function summarizeChainEvent(args) {
  const decoded = asRecord(decodeChainEventArgs(args));
  if (!decoded) return { amountTao: null, from: null, to: null, netuid: null };
  const rawAmount = asNumber(pick(decoded, AMOUNT_KEYS));
  const netuid = asNumber(pick(decoded, ["netuid", "net_uid", "subnet"]));
  const from = asAddress(pick(decoded, FROM_KEYS));
  const to = asAddress(pick(decoded, TO_KEYS));
  return {
    amountTao: rawAmount == null ? null : rawAmount / RAO_PER_TAO,
    from,
    // A single-account event (e.g. Commitments.Commitment's `who`) must not
    // render the same address as both sides of a transfer.
    to: to && to !== from ? to : null,
    netuid: netuid == null ? null : Math.trunc(netuid)
  };
}

// src/format.ts
function formatTao(v2) {
  if (v2 == null || !Number.isFinite(v2)) return "\u2014";
  const magnitude = Math.abs(v2);
  if (magnitude >= 1e6) return `${(v2 / 1e6).toFixed(2)}M \u03C4`;
  if (magnitude >= 1e3) return `${(v2 / 1e3).toFixed(1)}k \u03C4`;
  if (magnitude >= 1) return `${v2.toFixed(2)} \u03C4`;
  return `${v2.toFixed(4)} \u03C4`;
}
function shortHash(value, keep = 6) {
  if (!value) return void 0;
  const v2 = value.trim();
  if (!v2) return void 0;
  if (v2.length <= keep * 2 + 1) return v2;
  return `${v2.slice(0, keep)}\u2026${v2.slice(-keep)}`;
}

// src/chain-summaries.ts
function subnetLabel(netuid) {
  const n = parseNetuidLike(netuid);
  return n == null ? null : `SN${n}`;
}
function parseNetuidLike(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string") {
    const n = value.startsWith("0x") ? Number.parseInt(value, 16) : Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function addressLabel(ss58) {
  if (typeof ss58 !== "string" || !ss58) return "an account";
  return shortHash(ss58) ?? ss58;
}
function amountLabel(rao) {
  const n = typeof rao === "number" ? rao : typeof rao === "string" ? Number(rao) : null;
  if (n == null || !Number.isFinite(n)) return null;
  return formatTao(n / 1e9);
}
function fmtNumber(value) {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null;
  return n == null || !Number.isFinite(n) ? null : n.toLocaleString("en-US");
}
function stakeMoveTemplate(verb, prep, amountKey) {
  return (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    const amount = amountLabel(callArgValue(callArgs, amountKey));
    const hotkey = callArgValue(callArgs, "hotkey");
    if (!netuid || !amount) return null;
    return `${addressLabel(ctx.signer)} ${verb} ${amount} ${prep} ${addressLabel(hotkey)} on ${netuid}.`;
  };
}
function transferTemplate(verb) {
  return (callArgs, ctx) => {
    const amount = amountLabel(callArgValue(callArgs, "value"));
    const dest = callArgValue(callArgs, "dest");
    if (!amount) return null;
    return `${addressLabel(ctx.signer)} ${verb} ${amount} to ${addressLabel(dest)}.`;
  };
}
function timelockedWeightsTemplate() {
  return (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    const round = fmtNumber(callArgValue(callArgs, "reveal_round"));
    if (!netuid || !round) return null;
    return `${addressLabel(ctx.signer)} committed time-locked weights for ${netuid}, revealing at round ${round}.`;
  };
}
function callArgEntries(callArgs) {
  if (Array.isArray(callArgs)) {
    return callArgs.filter((a) => typeof a?.name === "string").map((a) => [a.name, a.value]);
  }
  if (callArgs && typeof callArgs === "object") {
    return Object.entries(callArgs);
  }
  return null;
}
function valueLabel(value) {
  if (value === null || value === void 0) return "none";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return fmtNumber(value);
  if (typeof value === "string") {
    if (value === "") return null;
    const asNumber2 = parseNetuidLike(value);
    if (asNumber2 !== null && /^(0x[0-9a-f]+|-?\d+)$/i.test(value.trim())) {
      return fmtNumber(asNumber2);
    }
    return shortHash(value) ?? value;
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => valueLabel(item));
    if (parts.some((part) => part === null)) return null;
    return `[${parts.join(", ")}]`;
  }
  return null;
}
function humanizeParam(name) {
  return name.replace(/_/g, " ").trim();
}
function adminUtilsTemplate(callFunction) {
  const SET_PREFIX = "sudo_set_";
  if (!callFunction.startsWith(SET_PREFIX)) return null;
  const param = humanizeParam(callFunction.slice(SET_PREFIX.length));
  if (!param) return null;
  return (callArgs) => {
    const entries = callArgEntries(callArgs);
    if (!entries) return null;
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    const rest = entries.filter(([name]) => name !== "netuid");
    if (rest.length === 0) return null;
    const rendered = rest.map(([name, value]) => {
      const label = valueLabel(value);
      return label === null ? null : rest.length === 1 ? label : `${humanizeParam(name)} ${label}`;
    });
    if (rendered.some((part) => part === null)) return null;
    const target = netuid ? ` for ${netuid}` : "";
    return `Set ${param}${target} to ${rendered.join(", ")}.`;
  };
}
function patternTemplate(callModule, callFunction) {
  if (callModule === "AdminUtils") return adminUtilsTemplate(callFunction);
  return null;
}
function describeInner(call, ctx) {
  if (!call) return "an unrecognized call";
  const summary = summarizeCall(call.call_module, call.call_function, call.call_args, ctx);
  return summary ?? `${call.call_module}.${call.call_function}`;
}
var CALL_TEMPLATES = {
  "SubtensorModule.commit_timelocked_mechanism_weights": timelockedWeightsTemplate(),
  "SubtensorModule.commit_timelocked_weights": timelockedWeightsTemplate(),
  "SubtensorModule.commit_mechanism_weights": (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    return netuid ? `${addressLabel(ctx.signer)} committed weights for ${netuid}.` : null;
  },
  "SubtensorModule.reveal_mechanism_weights": (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    return netuid ? `${addressLabel(ctx.signer)} revealed weights for ${netuid}.` : null;
  },
  "SubtensorModule.set_weights": (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    const dests = callArgValue(callArgs, "dests");
    const count = Array.isArray(dests) ? dests.length : null;
    if (!netuid) return null;
    return count != null ? `${addressLabel(ctx.signer)} set weights for ${netuid} across ${count} neurons.` : `${addressLabel(ctx.signer)} set weights for ${netuid}.`;
  },
  "SubtensorModule.set_mechanism_weights": (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    const dests = callArgValue(callArgs, "dests");
    const count = Array.isArray(dests) ? dests.length : null;
    if (!netuid) return null;
    return count != null ? `${addressLabel(ctx.signer)} set weights for ${netuid} across ${count} neurons.` : `${addressLabel(ctx.signer)} set weights for ${netuid}.`;
  },
  "Drand.write_pulse": (callArgs) => {
    const payload = callArgValue(callArgs, "pulses_payload");
    const pulses = payload && typeof payload === "object" ? payload.pulses : null;
    const first = Array.isArray(pulses) ? pulses[0] : null;
    const round = first && typeof first === "object" ? fmtNumber(first.round) : null;
    return round ? `Recorded a randomness beacon pulse (round ${round}).` : "Recorded a randomness beacon pulse.";
  },
  "Ethereum.transact": () => "Submitted an EVM transaction.",
  "Commitments.set_commitment": (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    return netuid ? `${addressLabel(ctx.signer)} published a commitment for ${netuid}.` : `${addressLabel(ctx.signer)} published a commitment.`;
  },
  "MevShield.submit_encrypted": (_args, ctx) => `${addressLabel(ctx.signer)} submitted an encrypted MEV-shield bid.`,
  "MevShield.announce_next_key": (_args, ctx) => `${addressLabel(ctx.signer)} announced the next MEV-shield key.`,
  "Timestamp.set": () => "Set the chain timestamp.",
  "SubtensorModule.add_stake": stakeMoveTemplate("staked", "to", "amount_staked"),
  "SubtensorModule.add_stake_limit": stakeMoveTemplate("staked", "to", "amount_staked"),
  "SubtensorModule.remove_stake": stakeMoveTemplate("unstaked", "from", "amount_unstaked"),
  "SubtensorModule.remove_stake_limit": stakeMoveTemplate("unstaked", "from", "amount_unstaked"),
  "SubtensorModule.remove_stake_full_limit": stakeMoveTemplate(
    "unstaked",
    "from",
    "amount_unstaked"
  ),
  "Balances.transfer_keep_alive": transferTemplate("transferred"),
  "Balances.transfer_allow_death": transferTemplate("transferred"),
  "Balances.transfer_all": (_args, ctx) => {
    const dest = callArgValue(_args, "dest");
    return `${addressLabel(ctx.signer)} transferred their full balance to ${addressLabel(dest)}.`;
  },
  "Utility.batch_all": (callArgs, ctx) => batchSentence(callArgs, ctx),
  "Utility.batch": (callArgs, ctx) => batchSentence(callArgs, ctx),
  "Utility.force_batch": (callArgs, ctx) => batchSentence(callArgs, ctx),
  "Proxy.proxy": (callArgs, ctx) => {
    const real = callArgValue(callArgs, "real");
    const inner = asDecodedCall(callArgValue(callArgs, "call"));
    return `${addressLabel(ctx.signer)} acted as proxy for ${addressLabel(real)}: ${describeInner(inner, { signer: typeof real === "string" ? real : ctx.signer })}`;
  },
  "System.set_heap_pages": (callArgs) => {
    const pages = fmtNumber(callArgValue(callArgs, "pages"));
    return pages ? `Set the node heap page allocation to ${pages}.` : "Set the node heap page allocation.";
  },
  "System.remark": (_args, ctx) => `${addressLabel(ctx.signer)} submitted an on-chain remark.`,
  // Sudo is subtensor's only root-origin pathway (it has no Council/Senate).
  // Every observed get_sudo row is a WRAPPER whose payload is the interesting
  // part -- a flat sentence here would say "someone used sudo" and omit what
  // they did -- so these recurse like Utility.batch*/Proxy.proxy. The inner
  // call is usually AdminUtils, which is why this and adminUtilsTemplate ship
  // together: without the latter, a sudo-wrapped config change would still
  // bottom out in describeInner's raw `module.function` fallback.
  "Sudo.sudo": (callArgs, ctx) => `${addressLabel(ctx.signer)} executed a root call: ${describeInner(asDecodedCall(callArgValue(callArgs, "call")), ctx)}`,
  "Sudo.sudo_unchecked_weight": (callArgs, ctx) => `${addressLabel(ctx.signer)} executed a root call: ${describeInner(asDecodedCall(callArgValue(callArgs, "call")), ctx)}`,
  "Sudo.sudo_as": (callArgs, ctx) => {
    const who = callArgValue(callArgs, "who");
    return `${addressLabel(ctx.signer)} executed a root call as ${addressLabel(who)}: ${describeInner(asDecodedCall(callArgValue(callArgs, "call")), { signer: typeof who === "string" ? who : ctx.signer })}`;
  },
  "Sudo.set_key": (callArgs, ctx) => `${addressLabel(ctx.signer)} transferred the sudo key to ${addressLabel(callArgValue(callArgs, "new"))}.`,
  "Sudo.remove_key": (_args, ctx) => `${addressLabel(ctx.signer)} removed the sudo key, permanently disabling root calls.`
};
function batchSentence(callArgs, ctx) {
  const calls = callArgValue(callArgs, "calls");
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const first = asDecodedCall(calls[0]);
  const firstSentence = describeInner(first, ctx);
  const more = calls.length - 1;
  return more > 0 ? `${addressLabel(ctx.signer)} submitted a batch of ${calls.length} calls: ${firstSentence} (+${more} more).` : `${addressLabel(ctx.signer)} submitted a batch of 1 call: ${firstSentence}`;
}
function summarizeCall(callModule, callFunction, callArgs, ctx = {}) {
  if (!callModule || !callFunction) return null;
  const template = CALL_TEMPLATES[`${callModule}.${callFunction}`] ?? patternTemplate(callModule, callFunction);
  if (!template) return null;
  try {
    return template(callArgs, ctx);
  } catch {
    return null;
  }
}
function asPositionalArgs(args) {
  return Array.isArray(args) ? args : null;
}
function unwrapScalar(value) {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}
function positionalNetuid(value) {
  return subnetLabel(unwrapScalar(value));
}
function amountOnlyEvent(verb) {
  return (args) => {
    const s = summarizeChainEvent(args);
    const amount = s.amountTao == null ? null : formatTao(s.amountTao);
    if (!amount) return null;
    return s.from ? `${addressLabel(s.from)} ${verb} ${amount}.` : `${verb[0]?.toUpperCase()}${verb.slice(1)} ${amount}.`;
  };
}
function netuidOnlyEvent(sentence) {
  return (args) => {
    const s = summarizeChainEvent(args);
    return s.netuid == null ? null : `${sentence} SN${s.netuid}.`;
  };
}
function positionalStakeEvent(verb) {
  return (args) => {
    const a = asPositionalArgs(args);
    if (!a) return null;
    const hotkey = typeof a[1] === "string" ? a[1] : null;
    const amount = amountLabel(unwrapScalar(a[2]));
    const netuid = positionalNetuid(a[4]);
    if (!hotkey || !amount || !netuid) return null;
    return `${addressLabel(hotkey)} ${verb} ${amount} on ${netuid}.`;
  };
}
var EVENT_TEMPLATES = {
  "Balances.Transfer": (args) => {
    const s = summarizeChainEvent(args);
    const amount = s.amountTao == null ? null : formatTao(s.amountTao);
    if (!amount || !s.from) return null;
    return s.to ? `Transferred ${amount} from ${addressLabel(s.from)} to ${addressLabel(s.to)}.` : `Transferred ${amount} from ${addressLabel(s.from)}.`;
  },
  "Balances.Deposit": amountOnlyEvent("received a deposit of"),
  "Balances.Withdraw": amountOnlyEvent("withdrew"),
  "Balances.Issued": amountOnlyEvent("triggered the issuance of"),
  "Balances.Endowed": (args) => {
    const s = summarizeChainEvent(args);
    const record = args && typeof args === "object" && !Array.isArray(args) ? args : null;
    const amount = amountLabel(
      unwrapScalar(record?.free_balance)
    );
    return s.from && amount ? `${addressLabel(s.from)} was endowed with ${amount}.` : null;
  },
  "TransactionPayment.TransactionFeePaid": amountOnlyEvent("paid a transaction fee of"),
  "System.ExtrinsicSuccess": () => "Extrinsic executed successfully.",
  "System.ExtrinsicFailed": () => "Extrinsic failed.",
  "System.NewAccount": () => "A new account was created.",
  "System.KilledAccount": () => "An account was removed.",
  // Real args: [[netuid], version_key] -- positional, no field names.
  "SubtensorModule.WeightsSet": (args) => {
    const a = asPositionalArgs(args);
    if (!a) return null;
    const netuid = positionalNetuid(a[0]);
    return netuid ? `Weights were set for ${netuid}.` : null;
  },
  // Real args: [who, [mecid], commit_hash, reveal_round] -- mecid isn't a
  // netuid (confirmed too large for the netuid domain in live samples), so
  // this doesn't claim a subnet it can't actually name.
  "SubtensorModule.TimelockedWeightsCommitted": (args) => {
    const a = asPositionalArgs(args);
    if (!a) return null;
    const who = typeof a[0] === "string" ? a[0] : null;
    const round = fmtNumber(a[3]);
    if (!who || !round) return null;
    return `${addressLabel(who)} committed time-locked weights, revealing at round ${round}.`;
  },
  // Real args: [[netuid], who].
  "SubtensorModule.TimelockedWeightsRevealed": (args) => {
    const a = asPositionalArgs(args);
    if (!a) return null;
    const netuid = positionalNetuid(a[0]);
    const who = typeof a[1] === "string" ? a[1] : null;
    if (!netuid || !who) return null;
    return `${addressLabel(who)} revealed time-locked weights for ${netuid}.`;
  },
  // Real args: [[netuid], uid, hotkey].
  "SubtensorModule.NeuronRegistered": (args) => {
    const a = asPositionalArgs(args);
    if (!a) return null;
    const netuid = positionalNetuid(a[0]);
    const hotkey = typeof a[2] === "string" ? a[2] : null;
    if (!netuid) return null;
    return hotkey ? `${addressLabel(hotkey)} registered a neuron on ${netuid}.` : `A neuron registered on ${netuid}.`;
  },
  // Real args: {coldkey} -- no netuid field on this event at all.
  "SubtensorModule.RootClaimed": (args) => {
    const s = summarizeChainEvent(args);
    return s.from ? `${addressLabel(s.from)} claimed root.` : null;
  },
  // Real args: [coldkey, hotkey, [amount], [amount2], [netuid], version] --
  // positional, both add/remove share this exact shape.
  "SubtensorModule.StakeRemoved": positionalStakeEvent("unstaked"),
  "SubtensorModule.StakeAdded": positionalStakeEvent("staked"),
  // Real args: {owner, hotkey, netuid, incentive, destination} -- "incentive"
  // isn't in summarizeChainEvent's shared AMOUNT_KEYS (see Balances.Endowed's
  // own note), so this reads it directly rather than widening that list.
  "SubtensorModule.AutoStakeAdded": (args) => {
    const record = args && typeof args === "object" && !Array.isArray(args) ? args : null;
    if (!record) return null;
    const r = record;
    const hotkey = typeof r.hotkey === "string" ? r.hotkey : null;
    const netuid = subnetLabel(unwrapScalar(r.netuid));
    const amount = amountLabel(unwrapScalar(r.incentive));
    if (!hotkey || !netuid || !amount) return null;
    return `${addressLabel(hotkey)} auto-staked ${amount} on ${netuid}.`;
  },
  // StakeMoved/StakeSwapped carry origin AND destination netuids in a
  // positional shape distinct from StakeRemoved/Added's -- no template
  // registered rather than guessing which position means what; raw
  // rendering stays correct for these two.
  // Real args: [from_coldkey, to_coldkey, hotkey, [netuid], [dest_netuid], [amount]].
  "SubtensorModule.StakeTransferred": (args) => {
    const a = asPositionalArgs(args);
    if (!a) return null;
    const from = typeof a[0] === "string" ? a[0] : null;
    const to = typeof a[1] === "string" ? a[1] : null;
    const netuid = positionalNetuid(a[3]);
    const amount = amountLabel(unwrapScalar(a[5]));
    if (!from || !netuid || !amount) return null;
    return to ? `${addressLabel(from)} transferred ${amount} of stake to ${addressLabel(to)} on ${netuid}.` : `${addressLabel(from)} transferred ${amount} of stake on ${netuid}.`;
  },
  "SubtensorModule.IncentiveAlphaEmittedToMiners": netuidOnlyEvent(
    "Incentive alpha was emitted to miners on"
  ),
  "Drand.NewPulse": () => "A new randomness beacon pulse was recorded.",
  "Ethereum.Executed": () => "An EVM transaction was executed.",
  "Utility.ItemCompleted": () => "A batched call completed.",
  "Utility.BatchCompleted": () => "A batch of calls completed.",
  "MevShield.EncryptedSubmitted": () => "An encrypted MEV-shield bid was submitted.",
  "Commitments.Commitment": netuidOnlyEvent("A commitment was published for"),
  "Proxy.ProxyExecuted": () => "A proxied call was executed."
};
function summarizeEvent(pallet, method, args) {
  if (!pallet || !method) return null;
  const template = EVENT_TEMPLATES[`${pallet}.${method}`];
  if (!template) return null;
  try {
    return template(args);
  } catch {
    return null;
  }
}
function summarizableCallKeys() {
  return Object.keys(CALL_TEMPLATES);
}
function summarizableEventKeys() {
  return Object.keys(EVENT_TEMPLATES);
}

// src/bytes.ts
function isIntArray(value) {
  return Array.isArray(value) && value.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255);
}
function unwrapByteArray(value) {
  let current = value;
  while (Array.isArray(current) && current.length === 1 && Array.isArray(current[0])) {
    current = current[0];
  }
  return isIntArray(current) ? current : null;
}
function bytesToHex(bytes) {
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}
var TEXTUAL_FIELDS = /* @__PURE__ */ new Set(["System.remark.remark", "System.remark_with_event.remark"]);
function decodeBytesField(callModule, callFunction, fieldName, bytes) {
  const key = `${callModule ?? ""}.${callFunction ?? ""}.${fieldName}`;
  if (TEXTUAL_FIELDS.has(key)) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    } catch {
      return bytesToHex(bytes);
    }
  }
  return bytesToHex(bytes);
}

export { DEFAULT_SS58_FORMAT, NOISE_EVENTS, asDecodedCall, bytesToHex, callArgValue, decodeBytesField, decodeChainEventArgs, decodeSs58, encodeSs58, formatChainEventArgs, formatTao, isDecodedCall, isNoiseEvent, normalizeIndexerRsCall, shortHash, summarizableCallKeys, summarizableEventKeys, summarizeCall, summarizeChainEvent, summarizeEvent, unwrapByteArray };
