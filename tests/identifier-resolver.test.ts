// The explorer's identifier resolver (metagraphed-infra#362).
//
// What is worth testing here is not that a regex matches. It is the two
// judgement calls the resolver makes, because both are places where the
// obvious implementation is wrong:
//
//   1. AMBIGUITY IS RETURNED, NOT RESOLVED. A 64-hex string is a block hash or
//      an extrinsic hash; a small integer is a netuid and a block height. Both
//      readings are real, and picking one sends roughly half of those users to
//      a 404 for something that exists under the other reading.
//   2. SHAPE IS NOT ENOUGH FOR AN ACCOUNT. A 48-character base58 string that
//      fails its checksum is a typo. Offering it anyway produces an empty
//      account page, which reads as "this address has no activity" rather than
//      "you mistyped it".
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSearchResolve,
  resolveIdentifier,
  RESOLVER_MAX_NETUID,
} from "../src/identifier-resolver.ts";

// Alice — the same canonical dev address the live smoke substitutes for {ss58}.
const ALICE = "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM";
const kinds = (q: unknown) => resolveIdentifier(q).map((r) => r.kind);

describe("accounts are checksum-verified, not shape-matched", () => {
  test("a valid ss58 resolves to exactly one account", () => {
    const [hit, ...rest] = resolveIdentifier(ALICE);
    assert.equal(rest.length, 0, "an address is unambiguous");
    assert.deepEqual(hit, {
      kind: "account",
      value: ALICE,
      api_path: `/api/v1/accounts/${ALICE}`,
      ui_path: `/accounts/${ALICE}`,
      exact: true,
    });
  });

  test("one wrong character resolves to nothing", () => {
    // The checksum is the whole point: this differs from ALICE in the last
    // character only, and a shape check would happily offer it.
    const typo = `${ALICE.slice(0, -1)}X`;
    assert.equal(typo.length, ALICE.length);
    assert.deepEqual(resolveIdentifier(typo), []);
  });

  test("returning nothing is the signal to fall through to corpus search", () => {
    // Prose must not be claimed by the resolver -- semantic search is the right
    // tool for it, and an empty result is how the caller knows to use it.
    for (const q of ["inference", "subnet 74", "who validates allways", ""]) {
      assert.deepEqual(resolveIdentifier(q), [], JSON.stringify(q));
    }
  });
});

describe("a 32-byte hash is two things, and says so", () => {
  const hash = `0x${"a".repeat(64)}`;

  test("offers block AND extrinsic, neither marked exact", () => {
    const hits = resolveIdentifier(hash);
    assert.deepEqual(
      hits.map((h) => h.kind),
      ["block", "extrinsic"],
    );
    // `exact: false` is the instruction to the UI: show both, do not redirect.
    assert.equal(
      hits.every((h) => h.exact === false),
      true,
    );
    assert.equal(
      hits.every((h) => h.value === hash),
      true,
    );
  });

  test("normalises case and a missing 0x", () => {
    const upper = `0x${"A".repeat(64)}`;
    const bare = "a".repeat(64);
    for (const variant of [upper, bare]) {
      const hits = resolveIdentifier(variant);
      assert.deepEqual(
        hits.map((h) => h.value),
        [hash, hash],
        `${variant.slice(0, 12)}… must normalise to ${hash.slice(0, 12)}…`,
      );
    }
  });

  test("a 20-byte hex is an EVM account, and needs its 0x", () => {
    assert.deepEqual(kinds(`0x${"b".repeat(40)}`), ["evm-account"]);
    // Without 0x, 40 hex characters are far more likely to be something else
    // pasted by accident than a bare EVM address.
    assert.deepEqual(kinds("b".repeat(40)), []);
  });

  test("a hash of the wrong length is not a hash", () => {
    assert.deepEqual(kinds(`0x${"a".repeat(63)}`), []);
    assert.deepEqual(kinds(`0x${"a".repeat(65)}`), []);
  });

  test("non-hex characters are rejected", () => {
    assert.deepEqual(kinds(`0x${"g".repeat(64)}`), []);
  });
});

describe("a bare integer is a block height AND maybe a netuid", () => {
  test("a small number offers both, block first", () => {
    // 7 is subnet 7 and block 7. Both are real and always have been.
    const hits = resolveIdentifier("7");
    assert.deepEqual(
      hits.map((h) => h.kind),
      ["block", "subnet"],
    );
    assert.equal(
      hits.every((h) => h.exact === false),
      true,
      "neither reading is certain",
    );
  });

  test("a number above the netuid ceiling is unambiguously a block", () => {
    const hits = resolveIdentifier("5000000");
    assert.deepEqual(
      hits.map((h) => h.kind),
      ["block"],
    );
    assert.equal(hits[0]!.exact, true);
  });

  test("the ceiling is sized for growth, not for today's subnet count", () => {
    // ~129 subnets exist. A ceiling tuned to that would silently stop offering
    // the subnet reading the day subnet 130 registered.
    assert.equal(RESOLVER_MAX_NETUID > 129, true);
    assert.deepEqual(kinds(String(RESOLVER_MAX_NETUID)), ["block", "subnet"]);
    assert.deepEqual(kinds(String(RESOLVER_MAX_NETUID + 1)), ["block"]);
  });

  test("block zero is genesis, not a falsy miss", () => {
    // `0` is a real block and a real netuid (root). A truthiness check on the
    // parsed number would drop both.
    assert.deepEqual(kinds("0"), ["block", "subnet"]);
  });
});

describe("netuid:uid", () => {
  test("resolves to one neuron", () => {
    const [hit, ...rest] = resolveIdentifier("74:12");
    assert.equal(rest.length, 0);
    assert.equal(hit!.kind, "neuron");
    assert.equal(hit!.value, "74:12");
    assert.equal(hit!.api_path, "/api/v1/subnets/74/neurons/12");
    assert.equal(hit!.exact, true);
  });

  test("is checked before the integer branch, or the uid would be lost", () => {
    assert.equal(resolveIdentifier("74:0")[0]!.kind, "neuron");
  });

  test("a netuid above the ceiling is not a neuron", () => {
    assert.deepEqual(kinds(`${RESOLVER_MAX_NETUID + 1}:1`), []);
  });
});

describe("the resolver is safe on hostile input", () => {
  test("a very long string is rejected without work", () => {
    // Nothing legitimate is longer than an ss58 address. This is about not
    // base58-decoding or hashing a megabyte to learn it is not an address.
    assert.deepEqual(resolveIdentifier("a".repeat(100_000)), []);
    assert.deepEqual(resolveIdentifier(`0x${"a".repeat(100_000)}`), []);
  });

  test("non-strings never throw", () => {
    for (const bad of [null, undefined, 7, {}, [], true]) {
      assert.deepEqual(resolveIdentifier(bad), [], String(bad));
    }
  });

  test("surrounding whitespace is tolerated, since it comes from a paste", () => {
    assert.deepEqual(kinds(`  ${ALICE}  `), ["account"]);
    assert.deepEqual(kinds("\t74:12\n"), ["neuron"]);
  });

  test("every result carries a usable api and ui path", () => {
    for (const q of [ALICE, `0x${"a".repeat(64)}`, "7", "74:12"]) {
      for (const hit of resolveIdentifier(q)) {
        assert.match(hit.api_path, /^\/api\/v1\//, `${q}: ${hit.kind}`);
        assert.match(hit.ui_path, /^\//, `${q}: ${hit.kind}`);
      }
    }
  });
});

describe("buildSearchResolve, the served payload", () => {
  test("unambiguous is true only for a single EXACT candidate", () => {
    // This is the one field a UI acts on: true means navigate, false means
    // render the choice. Getting it wrong sends users to a 404 for an entity
    // that exists under the other reading.
    assert.equal(buildSearchResolve(ALICE).unambiguous, true, "one account");
    assert.equal(buildSearchResolve("74:12").unambiguous, true, "one neuron");
    assert.equal(
      buildSearchResolve("5000000").unambiguous,
      true,
      "above the netuid ceiling, a number is only a block",
    );
    assert.equal(
      buildSearchResolve("7").unambiguous,
      false,
      "a block AND a subnet",
    );
    assert.equal(
      buildSearchResolve(`0x${"a".repeat(64)}`).unambiguous,
      false,
      "a block hash AND an extrinsic hash",
    );
  });

  test("a single NON-exact candidate is still ambiguous", () => {
    // The flag is about certainty, not arity. A lone shape-only match must not
    // trigger navigation just because nothing else matched.
    const single = buildSearchResolve("7").matches.filter(
      (m) => m.kind === "block",
    );
    assert.equal(single[0]!.exact, false);
  });

  test("an empty result is a complete, valid answer", () => {
    // Not an error: it means "not an identifier", and the caller falls through
    // to corpus search.
    const payload = buildSearchResolve("which subnet does speech to text");
    assert.deepEqual(payload.matches, []);
    assert.equal(payload.match_count, 0);
    assert.equal(payload.unambiguous, false);
    assert.equal(payload.schema_version, 1);
  });

  test("match_count always agrees with matches", () => {
    for (const q of [ALICE, "7", `0x${"a".repeat(64)}`, "nope", "74:12"]) {
      const payload = buildSearchResolve(q);
      assert.equal(payload.match_count, payload.matches.length, q);
    }
  });

  test("echoes the trimmed query, and survives a non-string", () => {
    assert.equal(buildSearchResolve("  74:12  ").query, "74:12");
    // The route reads `q` from a URL, which yields null when absent -- so this
    // is the real production path, not a defensive nicety.
    for (const bad of [null, undefined, 7, {}]) {
      const payload = buildSearchResolve(bad);
      assert.equal(payload.query, "");
      assert.deepEqual(payload.matches, []);
      assert.equal(payload.unambiguous, false);
    }
  });
});
