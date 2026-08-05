import { describe, expect, it } from "vitest";
import {
  summarizableCallKeys,
  summarizableEventKeys,
  summarizeCall,
  summarizeEvent,
} from "./chain-summaries";
import { formatTao, shortHash } from "./format";

// Every fixture below is a real decoded call_args/args shape captured live
// from api.metagraph.sh during #8371's investigation, not synthesized --
// the top-level array-of-{name,value} shape and the nested flat-object
// shape are both exercised since real extrinsics use either depending on
// nesting depth (callArgValue handles both). Expected amounts/addresses are
// computed via the real formatTao/shortHash rather than hand-typed, so a
// fixture change can't silently drift from those functions' own tiering.

// A realistic-length SS58 (48 chars) so asAddress()'s >40-char check passes
// the same way a real address would -- a short placeholder like "5hot"
// would silently fail that check and mask a real bug behind a wrong test.
const SIGNER = "5GQiwGCkfJfLTrCLuJKZKKZKKZKKZKKZKKZKKZKKZKKZsQQ";
const HOTKEY = "5HotkeyPlaceholderAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DEST = "5DestPlaceholderBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const REAL_ACCT = "5RealAcctPlaceholderCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const FROM_ACCT = "5FromPlaceholderDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const TO_ACCT = "5ToPlaceholderEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const label = (addr: string) => shortHash(addr) ?? addr;
const tao = (rao: number) => formatTao(rao / 1e9);

describe("summarizeCall", () => {
  it("returns null for pallet.method with no template", () => {
    expect(summarizeCall("SomeUnknownPallet", "some_function", [], {})).toBeNull();
  });

  it("returns null when module or function is missing", () => {
    expect(summarizeCall(null, "set_weights", [], {})).toBeNull();
    expect(summarizeCall("SubtensorModule", null, [], {})).toBeNull();
  });

  it("commit_timelocked_mechanism_weights -- the issue's own worked example", () => {
    const args = [
      { name: "netuid", value: 89 },
      { name: "mecid", value: 0 },
      { name: "commit", value: "0xabc" },
      { name: "reveal_round", value: 30777610 },
      { name: "commit_reveal_version", value: 4 },
    ];
    expect(
      summarizeCall("SubtensorModule", "commit_timelocked_mechanism_weights", args, {
        signer: SIGNER,
      }),
    ).toBe(
      `${label(SIGNER)} committed time-locked weights for SN89, revealing at round 30,777,610.`,
    );
  });

  it("commit_timelocked_weights (no mecid) uses the same template", () => {
    const args = [
      { name: "netuid", value: 126 },
      { name: "commit", value: "0xabc" },
      { name: "reveal_round", value: 30790038 },
      { name: "commit_reveal_version", value: 4 },
    ];
    expect(
      summarizeCall("SubtensorModule", "commit_timelocked_weights", args, {
        signer: SIGNER,
      }),
    ).toBe(
      `${label(SIGNER)} committed time-locked weights for SN126, revealing at round 30,790,038.`,
    );
  });

  it("commit_timelocked_weights returns null when reveal_round is missing", () => {
    expect(
      summarizeCall(
        "SubtensorModule",
        "commit_timelocked_weights",
        [{ name: "netuid", value: 1 }],
        {},
      ),
    ).toBeNull();
  });

  it("commit_mechanism_weights / reveal_mechanism_weights", () => {
    const args = [
      { name: "netuid", value: 5 },
      { name: "mecid", value: 0 },
    ];
    expect(
      summarizeCall("SubtensorModule", "commit_mechanism_weights", args, {
        signer: SIGNER,
      }),
    ).toBe(`${label(SIGNER)} committed weights for SN5.`);
    expect(
      summarizeCall("SubtensorModule", "reveal_mechanism_weights", args, {
        signer: SIGNER,
      }),
    ).toBe(`${label(SIGNER)} revealed weights for SN5.`);
  });

  it("set_weights includes the neuron count when dests is present", () => {
    const args = [
      { name: "netuid", value: 118 },
      { name: "dests", value: [0, 1, 2] },
      { name: "weights", value: [10, 20, 30] },
      { name: "version_key", value: 1 },
    ];
    expect(summarizeCall("SubtensorModule", "set_weights", args, { signer: SIGNER })).toBe(
      `${label(SIGNER)} set weights for SN118 across 3 neurons.`,
    );
  });

  it("set_weights without dests degrades to a netuid-only sentence", () => {
    expect(
      summarizeCall("SubtensorModule", "set_weights", [{ name: "netuid", value: 118 }], {
        signer: SIGNER,
      }),
    ).toBe(`${label(SIGNER)} set weights for SN118.`);
  });

  it("set_mechanism_weights mirrors set_weights", () => {
    const args = {
      netuid: 118,
      mecid: 0,
      dests: [1, 2],
      weights: [5, 5],
      version_key: 1,
    };
    expect(
      summarizeCall("SubtensorModule", "set_mechanism_weights", args, {
        signer: SIGNER,
      }),
    ).toBe(`${label(SIGNER)} set weights for SN118 across 2 neurons.`);
  });

  it("Drand.write_pulse reads the first pulse's round", () => {
    const args = [
      {
        name: "pulses_payload",
        value: {
          public: { Sr25519: "0x.." },
          pulses: [{ round: 30790023, signature: "0x..", randomness: "0x.." }],
          block_number: 8714765,
        },
      },
      { name: "signature", value: "0x.." },
    ];
    expect(summarizeCall("Drand", "write_pulse", args, {})).toBe(
      "Recorded a randomness beacon pulse (round 30,790,023).",
    );
  });

  it("Drand.write_pulse degrades gracefully with no pulses", () => {
    expect(summarizeCall("Drand", "write_pulse", [{ name: "pulses_payload", value: {} }], {})).toBe(
      "Recorded a randomness beacon pulse.",
    );
  });

  it("Ethereum.transact is a fixed generic sentence", () => {
    expect(summarizeCall("Ethereum", "transact", [{ name: "transaction", value: {} }], {})).toBe(
      "Submitted an EVM transaction.",
    );
  });

  it("Commitments.set_commitment", () => {
    const args = [
      { name: "netuid", value: 123 },
      { name: "info", value: { fields: [{ Raw100: "https://example.com" }] } },
    ];
    expect(summarizeCall("Commitments", "set_commitment", args, { signer: SIGNER })).toBe(
      `${label(SIGNER)} published a commitment for SN123.`,
    );
  });

  it("MevShield.submit_encrypted / announce_next_key", () => {
    expect(
      summarizeCall("MevShield", "submit_encrypted", [{ name: "ciphertext", value: "0x.." }], {
        signer: SIGNER,
      }),
    ).toBe(`${label(SIGNER)} submitted an encrypted MEV-shield bid.`);
    expect(
      summarizeCall("MevShield", "announce_next_key", [{ name: "enc_key", value: "0x.." }], {
        signer: SIGNER,
      }),
    ).toBe(`${label(SIGNER)} announced the next MEV-shield key.`);
  });

  it("Timestamp.set is a fixed generic sentence", () => {
    expect(summarizeCall("Timestamp", "set", [{ name: "now", value: 1785173448000 }], {})).toBe(
      "Set the chain timestamp.",
    );
  });

  it("add_stake_limit", () => {
    const args = [
      { name: "hotkey", value: HOTKEY },
      { name: "netuid", value: 1 },
      { name: "amount_staked", value: 1_000_000_000 },
      { name: "limit_price", value: 8472101 },
      { name: "allow_partial", value: true },
    ];
    expect(
      summarizeCall("SubtensorModule", "add_stake_limit", args, {
        signer: SIGNER,
      }),
    ).toBe(`${label(SIGNER)} staked ${tao(1_000_000_000)} to ${label(HOTKEY)} on SN1.`);
  });

  it("remove_stake -- real captured shape", () => {
    const args = [
      { name: "hotkey", value: HOTKEY },
      { name: "netuid", value: 62 },
      { name: "amount_unstaked", value: 126719638931 },
    ];
    expect(
      summarizeCall("SubtensorModule", "remove_stake", args, {
        signer: SIGNER,
      }),
    ).toBe(`${label(SIGNER)} unstaked ${tao(126719638931)} from ${label(HOTKEY)} on SN62.`);
  });

  it("remove_stake_limit / remove_stake_full_limit share the same template", () => {
    const args = { hotkey: HOTKEY, netuid: 4, amount_unstaked: 500_000_000 };
    const expected = `${label(SIGNER)} unstaked ${tao(500_000_000)} from ${label(HOTKEY)} on SN4.`;
    expect(
      summarizeCall("SubtensorModule", "remove_stake_limit", args, {
        signer: SIGNER,
      }),
    ).toBe(expected);
    expect(
      summarizeCall("SubtensorModule", "remove_stake_full_limit", args, {
        signer: SIGNER,
      }),
    ).toBe(expected);
  });

  it("stake templates return null without a readable amount or netuid", () => {
    expect(
      summarizeCall("SubtensorModule", "add_stake", [{ name: "hotkey", value: HOTKEY }], {}),
    ).toBeNull();
  });

  it("Balances.transfer_keep_alive / transfer_allow_death -- real captured shape", () => {
    const args = [
      { name: "dest", value: DEST },
      { name: "value", value: 2571528859 },
    ];
    const expected = `${label(SIGNER)} transferred ${tao(2571528859)} to ${label(DEST)}.`;
    expect(
      summarizeCall("Balances", "transfer_allow_death", args, {
        signer: SIGNER,
      }),
    ).toBe(expected);
    expect(
      summarizeCall("Balances", "transfer_keep_alive", args, {
        signer: SIGNER,
      }),
    ).toBe(expected);
  });

  it("Balances.transfer_all", () => {
    expect(
      summarizeCall("Balances", "transfer_all", [{ name: "dest", value: DEST }], {
        signer: SIGNER,
      }),
    ).toBe(`${label(SIGNER)} transferred their full balance to ${label(DEST)}.`);
  });

  it("Utility.batch_all -- real captured nested shape, flat object call_args", () => {
    const args = [
      {
        name: "calls",
        value: [
          {
            call_module: "SubtensorModule",
            call_function: "remove_stake_limit",
            call_args: {
              hotkey: HOTKEY,
              netuid: "0x1b",
              limit_price: 1,
              allow_partial: true,
              amount_unstaked: 100_000_000,
            },
          },
          {
            call_module: "Balances",
            call_function: "transfer_allow_death",
            call_args: { dest: DEST, value: 226855 },
          },
        ],
      },
    ];
    const result = summarizeCall("Utility", "batch_all", args, {
      signer: SIGNER,
    });
    expect(result).toContain(`${label(SIGNER)} submitted a batch of 2 calls:`);
    expect(result).toContain("(+1 more)");
    // Nested netuid arrives as a hex string ("0x1b" = 27) -- confirms parseNetuidLike's hex path.
    expect(result).toContain("SN27");
  });

  it("Utility.batch / force_batch share the batch template", () => {
    const args = {
      calls: [{ call_module: "System", call_function: "remark", call_args: {} }],
    };
    expect(summarizeCall("Utility", "batch", args, { signer: SIGNER })).toBe(
      `${label(SIGNER)} submitted a batch of 1 call: ${label(SIGNER)} submitted an on-chain remark.`,
    );
    expect(summarizeCall("Utility", "force_batch", args, { signer: SIGNER })).toContain(
      `${label(SIGNER)} submitted a batch of 1 call:`,
    );
  });

  it("Utility.batch_all returns null with no calls", () => {
    expect(summarizeCall("Utility", "batch_all", [{ name: "calls", value: [] }], {})).toBeNull();
    expect(
      summarizeCall("Utility", "batch_all", [{ name: "calls", value: "not-an-array" }], {}),
    ).toBeNull();
  });

  it("Utility.batch_all with an unrecognized inner call still produces a sentence", () => {
    const args = {
      calls: [
        {
          call_module: "SomeWeirdPallet",
          call_function: "do_thing",
          call_args: {},
        },
      ],
    };
    expect(summarizeCall("Utility", "batch_all", args, { signer: SIGNER })).toBe(
      `${label(SIGNER)} submitted a batch of 1 call: SomeWeirdPallet.do_thing`,
    );
  });

  it("Proxy.proxy -- real captured triple-nested shape, acting-as switches the inner sentence's signer", () => {
    const args = {
      real: REAL_ACCT,
      force_proxy_type: "Staking",
      call: {
        call_module: "SubtensorModule",
        call_function: "remove_stake",
        call_args: { hotkey: HOTKEY, netuid: 4, amount_unstaked: 100_000_000 },
      },
    };
    expect(summarizeCall("Proxy", "proxy", args, { signer: SIGNER })).toBe(
      `${label(SIGNER)} acted as proxy for ${label(REAL_ACCT)}: ${label(REAL_ACCT)} unstaked ${tao(100_000_000)} from ${label(HOTKEY)} on SN4.`,
    );
  });

  it("Proxy.proxy with an unrecognized inner call falls back to module.function", () => {
    const args = {
      real: REAL_ACCT,
      call: { call_module: "Weird", call_function: "thing", call_args: {} },
    };
    expect(summarizeCall("Proxy", "proxy", args, { signer: SIGNER })).toBe(
      `${label(SIGNER)} acted as proxy for ${label(REAL_ACCT)}: Weird.thing`,
    );
  });

  it("Proxy.proxy with a malformed call arg falls back to 'an unrecognized call'", () => {
    expect(
      summarizeCall("Proxy", "proxy", { real: REAL_ACCT, call: null }, { signer: SIGNER }),
    ).toBe(`${label(SIGNER)} acted as proxy for ${label(REAL_ACCT)}: an unrecognized call`);
  });

  it("System.set_heap_pages -- real captured shape", () => {
    expect(summarizeCall("System", "set_heap_pages", [{ name: "pages", value: 0 }], {})).toBe(
      "Set the node heap page allocation to 0.",
    );
  });

  it("System.remark", () => {
    expect(summarizeCall("System", "remark", [], { signer: SIGNER })).toBe(
      `${label(SIGNER)} submitted an on-chain remark.`,
    );
  });

  it("swallows a template that throws and returns null rather than crashing", () => {
    const throwingArgs = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    expect(summarizeCall("System", "set_heap_pages", throwingArgs, {})).toBeNull();
  });

  it("summarizableCallKeys reports every registered call template", () => {
    const keys = summarizableCallKeys();
    expect(keys).toContain("SubtensorModule.commit_timelocked_mechanism_weights");
    expect(keys).toContain("Utility.batch_all");
    expect(keys.length).toBeGreaterThanOrEqual(20);
  });

  // #9525. get_sudo and get_governance_config_changes filter to exactly the
  // Sudo and AdminUtils pallets, and neither had a single template -- so
  // `summary` was null on 100% of both feeds while the global >=95% coverage
  // bar stayed green on SubtensorModule-dominated traffic.
  //
  // Every call_args fixture below was captured live from api.metagraph.sh
  // (get_sudo / get_governance_config_changes, 2026-08-05), same discipline as
  // the fixtures above.
  describe("governance pallets (#9525)", () => {
    const SIGNER = "5DA2vLrSXZxnT9G4Yrywx1Fpi4RXwMH1Ah7r8DTTWS7UZZBM";

    it("AdminUtils.sudo_set_* renders the parameter and its new value", () => {
      expect(
        summarizeCall(
          "AdminUtils",
          "sudo_set_weights_version_key",
          [
            { name: "netuid", type: "NetUid", value: 107 },
            { name: "weights_version_key", type: "u64", value: 20 },
          ],
          { signer: SIGNER },
        ),
      ).toBe("Set weights version key for SN107 to 20.");
    });

    // A multi-value setter must name every value it changed: reporting only
    // the first would understate the call.
    it("renders every non-netuid arg, not just the first", () => {
      expect(
        summarizeCall(
          "AdminUtils",
          "sudo_set_mechanism_emission_split",
          [
            { name: "netuid", value: 89 },
            { name: "maybe_split", value: [52428, 13107] },
          ],
          { signer: SIGNER },
        ),
      ).toBe("Set mechanism emission split for SN89 to [52,428, 13,107].");
    });

    it("renders a boolean hyperparameter literally", () => {
      expect(
        summarizeCall(
          "AdminUtils",
          "sudo_set_network_registration_allowed",
          [
            { name: "netuid", value: 92 },
            { name: "registration_allowed", value: false },
          ],
          { signer: SIGNER },
        ),
      ).toBe("Set network registration allowed for SN92 to false.");
    });

    it("omits the subnet clause for a network-wide setter", () => {
      expect(
        summarizeCall("AdminUtils", "sudo_set_tx_rate_limit", { tx_rate_limit: 1000 }, {}),
      ).toBe("Set tx rate limit to 1,000.");
    });

    // The refusal half of the contract: a value with no faithful one-line form
    // declines the sentence rather than half-rendering it.
    it("declines rather than half-rendering an unstatable value", () => {
      expect(
        summarizeCall(
          "AdminUtils",
          "sudo_set_something",
          [
            { name: "netuid", value: 1 },
            { name: "opaque", value: { nested: "object" } },
          ],
          {},
        ),
      ).toBeNull();
      // No args beyond netuid: nothing to report as the new value.
      expect(
        summarizeCall("AdminUtils", "sudo_set_x", [{ name: "netuid", value: 1 }], {}),
      ).toBeNull();
      // Not a setter, so the pattern does not claim it.
      expect(summarizeCall("AdminUtils", "some_other_call", { a: 1 }, {})).toBeNull();
    });

    // Every observed get_sudo row is a wrapper; a flat sentence would say
    // "someone used sudo" and omit what they actually did.
    it("Sudo.sudo recurses into the wrapped call", () => {
      expect(
        summarizeCall(
          "Sudo",
          "sudo",
          [
            {
              name: "call",
              type: "RuntimeCall",
              value: {
                call_module: "AdminUtils",
                call_function: "sudo_set_weights_set_rate_limit",
                call_args: { netuid: 6, weights_set_rate_limit: 10 },
              },
            },
          ],
          { signer: SIGNER },
        ),
      ).toBe(
        `${shortHash(SIGNER)} executed a root call: Set weights set rate limit for SN6 to 10.`,
      );
    });

    // An inner pallet with no template still names the call rather than
    // vanishing -- describeInner's existing raw fallback.
    it("falls back to the raw inner call name when the inner pallet has no template", () => {
      expect(
        summarizeCall(
          "Sudo",
          "sudo",
          [
            {
              name: "call",
              value: {
                call_module: "Swap",
                call_function: "toggle_user_liquidity",
                call_args: { enable: true, netuid: 30 },
              },
            },
          ],
          { signer: SIGNER },
        ),
      ).toBe(`${shortHash(SIGNER)} executed a root call: Swap.toggle_user_liquidity`);
    });

    it("Sudo.sudo_as attributes the inner call to `who`, not the sudo key", () => {
      const who = "5CfSg4e23Z3aTXvc2XZie8ZE1xkqRPoyVRFdWUuyyjGxJrMA";
      expect(
        summarizeCall(
          "Sudo",
          "sudo_as",
          [
            { name: "who", value: who },
            {
              name: "call",
              value: {
                call_module: "System",
                call_function: "remark",
                call_args: {},
              },
            },
          ],
          { signer: SIGNER },
        ),
      ).toBe(
        `${shortHash(SIGNER)} executed a root call as ${shortHash(who)}: ${shortHash(who)} submitted an on-chain remark.`,
      );
    });

    it("Sudo key management reads as key management, not as a wrapper", () => {
      const next = "5CfSg4e23Z3aTXvc2XZie8ZE1xkqRPoyVRFdWUuyyjGxJrMA";
      expect(
        summarizeCall("Sudo", "set_key", [{ name: "new", value: next }], { signer: SIGNER }),
      ).toBe(`${shortHash(SIGNER)} transferred the sudo key to ${shortHash(next)}.`);
      expect(summarizeCall("Sudo", "remove_key", [], { signer: SIGNER })).toBe(
        `${shortHash(SIGNER)} removed the sudo key, permanently disabling root calls.`,
      );
    });

    it("Sudo.sudo_unchecked_weight recurses like Sudo.sudo", () => {
      expect(
        summarizeCall(
          "Sudo",
          "sudo_unchecked_weight",
          [
            {
              name: "call",
              value: {
                call_module: "AdminUtils",
                call_function: "sudo_set_tempo",
                call_args: { netuid: 3, tempo: 360 },
              },
            },
            { name: "weight", value: { ref_time: 1 } },
          ],
          { signer: SIGNER },
        ),
      ).toBe(`${shortHash(SIGNER)} executed a root call: Set tempo for SN3 to 360.`);
    });
  });
});

describe("summarizeEvent", () => {
  it("returns null for pallet.method with no template", () => {
    expect(summarizeEvent("SomeUnknownPallet", "SomeEvent", {})).toBeNull();
  });

  it("returns null when pallet or method is missing", () => {
    expect(summarizeEvent(null, "Transfer", {})).toBeNull();
  });

  it("Balances.Transfer with both sides", () => {
    const args = { from: FROM_ACCT, to: TO_ACCT, amount: 1_000_000_000 };
    expect(summarizeEvent("Balances", "Transfer", args)).toBe(
      `Transferred ${tao(1_000_000_000)} from ${label(FROM_ACCT)} to ${label(TO_ACCT)}.`,
    );
  });

  it("Balances.Transfer returns null without a readable amount", () => {
    expect(summarizeEvent("Balances", "Transfer", { from: FROM_ACCT })).toBeNull();
  });

  it("Balances.Deposit / Withdraw / Issued reuse the amount-only template", () => {
    expect(
      summarizeEvent("Balances", "Deposit", {
        who: FROM_ACCT,
        amount: 500_000_000,
      }),
    ).toBe(`${label(FROM_ACCT)} received a deposit of ${tao(500_000_000)}.`);
    expect(
      summarizeEvent("Balances", "Withdraw", {
        who: FROM_ACCT,
        amount: 500_000_000,
      }),
    ).toBe(`${label(FROM_ACCT)} withdrew ${tao(500_000_000)}.`);
    expect(summarizeEvent("Balances", "Issued", { amount: 500_000_000 })).toBe(
      `Triggered the issuance of ${tao(500_000_000)}.`,
    );
  });

  it("Balances.Endowed -- real captured shape: {account, free_balance}, not {who, amount}", () => {
    expect(
      summarizeEvent("Balances", "Endowed", {
        account: FROM_ACCT,
        free_balance: [500_000_000],
      }),
    ).toBe(`${label(FROM_ACCT)} was endowed with ${tao(500_000_000)}.`);
    expect(summarizeEvent("Balances", "Endowed", { account: FROM_ACCT })).toBeNull();
  });

  it("TransactionPayment.TransactionFeePaid", () => {
    expect(
      summarizeEvent("TransactionPayment", "TransactionFeePaid", {
        who: FROM_ACCT,
        actual_fee: 1_000_000,
      }),
    ).toBe(`${label(FROM_ACCT)} paid a transaction fee of ${tao(1_000_000)}.`);
  });

  it("System.ExtrinsicSuccess / ExtrinsicFailed / NewAccount / KilledAccount are fixed sentences", () => {
    expect(summarizeEvent("System", "ExtrinsicSuccess", {})).toBe(
      "Extrinsic executed successfully.",
    );
    expect(summarizeEvent("System", "ExtrinsicFailed", {})).toBe("Extrinsic failed.");
    expect(summarizeEvent("System", "NewAccount", {})).toBe("A new account was created.");
    expect(summarizeEvent("System", "KilledAccount", {})).toBe("An account was removed.");
  });

  it("WeightsSet -- real captured shape: positional [[netuid], version_key]", () => {
    expect(summarizeEvent("SubtensorModule", "WeightsSet", [[89], 122])).toBe(
      "Weights were set for SN89.",
    );
    expect(summarizeEvent("SubtensorModule", "WeightsSet", {})).toBeNull();
    expect(summarizeEvent("SubtensorModule", "WeightsSet", [])).toBeNull();
  });

  it("TimelockedWeightsCommitted -- real captured shape: positional [who, [mecid], commit_hash, reveal_round]", () => {
    expect(
      summarizeEvent("SubtensorModule", "TimelockedWeightsCommitted", [
        SIGNER,
        [4183],
        "0xabc",
        30790577,
      ]),
    ).toBe(`${label(SIGNER)} committed time-locked weights, revealing at round 30,790,577.`);
    expect(summarizeEvent("SubtensorModule", "TimelockedWeightsCommitted", [SIGNER])).toBeNull();
  });

  it("TimelockedWeightsRevealed -- real captured shape: positional [[netuid], who]", () => {
    expect(summarizeEvent("SubtensorModule", "TimelockedWeightsRevealed", [[101], SIGNER])).toBe(
      `${label(SIGNER)} revealed time-locked weights for SN101.`,
    );
    expect(summarizeEvent("SubtensorModule", "TimelockedWeightsRevealed", [[101]])).toBeNull();
  });

  it("NeuronRegistered -- real captured shape: positional [[netuid], uid, hotkey]", () => {
    expect(summarizeEvent("SubtensorModule", "NeuronRegistered", [[32], 97, HOTKEY])).toBe(
      `${label(HOTKEY)} registered a neuron on SN32.`,
    );
    expect(summarizeEvent("SubtensorModule", "NeuronRegistered", [[32], 97])).toBe(
      "A neuron registered on SN32.",
    );
    expect(summarizeEvent("SubtensorModule", "NeuronRegistered", [])).toBeNull();
  });

  it("IncentiveAlphaEmittedToMiners / Commitments.Commitment stay keyed-object, unaffected by the positional fixes", () => {
    expect(
      summarizeEvent("SubtensorModule", "IncentiveAlphaEmittedToMiners", {
        netuid: 5,
      }),
    ).toBe("Incentive alpha was emitted to miners on SN5.");
    expect(summarizeEvent("Commitments", "Commitment", { netuid: 5 })).toBe(
      "A commitment was published for SN5.",
    );
  });

  it("SubtensorModule.RootClaimed -- real captured shape: {coldkey} only, no netuid field", () => {
    expect(summarizeEvent("SubtensorModule", "RootClaimed", { coldkey: FROM_ACCT })).toBe(
      `${label(FROM_ACCT)} claimed root.`,
    );
    expect(summarizeEvent("SubtensorModule", "RootClaimed", {})).toBeNull();
  });

  it("StakeRemoved / StakeAdded -- real captured shape: positional [coldkey, hotkey, [amount], [amount2], [netuid], version]", () => {
    const args = [FROM_ACCT, HOTKEY, [100_000_000], [100_000_000], [4], 3524834];
    expect(summarizeEvent("SubtensorModule", "StakeRemoved", args)).toBe(
      `${label(HOTKEY)} unstaked ${tao(100_000_000)} on SN4.`,
    );
    expect(summarizeEvent("SubtensorModule", "StakeAdded", args)).toBe(
      `${label(HOTKEY)} staked ${tao(100_000_000)} on SN4.`,
    );
    expect(summarizeEvent("SubtensorModule", "StakeRemoved", [])).toBeNull();
  });

  it("SubtensorModule.AutoStakeAdded -- real captured shape: {owner, hotkey, netuid, incentive, destination}", () => {
    expect(
      summarizeEvent("SubtensorModule", "AutoStakeAdded", {
        owner: FROM_ACCT,
        hotkey: HOTKEY,
        netuid: [96],
        incentive: [100_000_000],
        destination: TO_ACCT,
      }),
    ).toBe(`${label(HOTKEY)} auto-staked ${tao(100_000_000)} on SN96.`);
    expect(summarizeEvent("SubtensorModule", "AutoStakeAdded", { hotkey: HOTKEY })).toBeNull();
  });

  it("SubtensorModule.StakeMoved / StakeSwapped have no registered template (dual-netuid, ambiguous position order)", () => {
    expect(summarizeEvent("SubtensorModule", "StakeMoved", [])).toBeNull();
    expect(summarizeEvent("SubtensorModule", "StakeSwapped", [])).toBeNull();
  });

  it("SubtensorModule.StakeTransferred -- real captured shape: positional [from, to, hotkey, [netuid], [dest_netuid], [amount]]", () => {
    const args = [FROM_ACCT, TO_ACCT, HOTKEY, [4], [0], [100_000_000]];
    expect(summarizeEvent("SubtensorModule", "StakeTransferred", args)).toBe(
      `${label(FROM_ACCT)} transferred ${tao(100_000_000)} of stake to ${label(TO_ACCT)} on SN4.`,
    );
    expect(
      summarizeEvent("SubtensorModule", "StakeTransferred", [
        FROM_ACCT,
        null,
        HOTKEY,
        [4],
        [0],
        [100_000_000],
      ]),
    ).toBe(`${label(FROM_ACCT)} transferred ${tao(100_000_000)} of stake on SN4.`);
    expect(summarizeEvent("SubtensorModule", "StakeTransferred", [])).toBeNull();
  });

  it("fixed-sentence events with no dynamic fields", () => {
    expect(summarizeEvent("Drand", "NewPulse", {})).toBe(
      "A new randomness beacon pulse was recorded.",
    );
    expect(summarizeEvent("Ethereum", "Executed", {})).toBe("An EVM transaction was executed.");
    expect(summarizeEvent("Utility", "ItemCompleted", {})).toBe("A batched call completed.");
    expect(summarizeEvent("Utility", "BatchCompleted", {})).toBe("A batch of calls completed.");
    expect(summarizeEvent("MevShield", "EncryptedSubmitted", {})).toBe(
      "An encrypted MEV-shield bid was submitted.",
    );
    expect(summarizeEvent("Proxy", "ProxyExecuted", {})).toBe("A proxied call was executed.");
  });

  it("summarizableEventKeys reports every registered event template", () => {
    const keys = summarizableEventKeys();
    expect(keys).toContain("Balances.Transfer");
    expect(keys).toContain("SubtensorModule.StakeAdded");
    expect(keys.length).toBeGreaterThanOrEqual(20);
  });
});
