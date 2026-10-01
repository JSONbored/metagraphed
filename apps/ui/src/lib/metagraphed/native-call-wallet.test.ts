import { expect, test, vi } from "vitest";
import type { ApiPromise } from "@polkadot/api";
import type { Signer } from "@polkadot/api/types";
import type { SignerPayloadJSON } from "@polkadot/types/types";
import { guardNativeSigner, previewNativeCall, revalidateNativeCall } from "./native-call-wallet";
import type { NativeArtifact } from "./native-runtime";

const block = `0x${"33".repeat(32)}` as const,
  genesis = `0x${"44".repeat(32)}` as const,
  codeHash = `0x${"55".repeat(32)}` as const;
const integer = (value: bigint) => ({
  toNumber: () => Number(value),
  toBigInt: () => value,
  toString: () => value.toString(),
});
function fixture() {
  const source: NativeArtifact["source"] = {
    network: "finney",
    network_genesis_hash: genesis,
    finalized_block_hash: block,
    finalized_block: "500",
    runtime_spec_version: 470,
    runtime_transaction_version: 1,
    runtime_code_hash: codeHash,
    metadata_version: 15,
    metadata_sha256: codeHash,
  };
  const call = {
    section: "subtensorModule",
    toHex: vi.fn(() => "0x0700"),
    argsEntries: [["amount", { toString: () => "9007199254740993" }]],
    meta: { name: { toString: () => "fixture_call" } },
  };
  const extrinsic = {
    method: call,
    paymentInfo: vi.fn(async () => ({ partialFee: integer(101n) })),
  };
  const api = {
    genesisHash: { toHex: () => genesis },
    runtimeVersion: { specVersion: integer(470n), transactionVersion: integer(1n) },
    registry: { createType: vi.fn(() => call) },
    tx: vi.fn(() => extrinsic),
    rpc: {
      chain: {
        getFinalizedHead: vi.fn(async () => block),
        getHeader: vi.fn(async () => ({ number: integer(502n) })),
        getBlockHash: vi.fn(async () => ({ toHex: () => block })),
      },
      state: {
        getRuntimeVersion: vi.fn(async () => ({
          specVersion: integer(470n),
          transactionVersion: integer(1n),
        })),
        getStorageHash: vi.fn(async () => ({
          toHex: (): string => codeHash,
        })),
      },
      system: { accountNextIndex: vi.fn(async () => integer(4294967295n)) },
    },
    query: {
      system: {
        account: vi.fn(async () => ({
          data: { free: integer(9007199254740993n), frozen: integer(100n) },
        })),
      },
    },
  };
  const artifact: NativeArtifact = {
    schema_version: 1,
    source,
    types: [],
    results: [
      {
        kind: "prepare",
        pallet: "SubtensorModule",
        member: "fixture_call",
        call_data: "0x0700",
        contract: {},
      },
    ],
  };
  return { api, connection: api as unknown as ApiPromise, artifact, call, extrinsic };
}

test("method bytes use the Call codec overload and retain exact amounts, nonce and fee review", async () => {
  const f = fixture();
  const preview = await previewNativeCall(f.connection, f.artifact, 0, "fixture-account");
  expect(f.api.registry.createType).toHaveBeenCalledWith("Call", "0x0700");
  expect(f.api.tx).toHaveBeenCalledWith(f.call);
  expect(preview.arguments).toEqual([{ name: "amount", value: "9007199254740993" }]);
  expect(preview.balanceRao).toBe(9007199254740893n);
  expect(preview.nonce).toBe("4294967295");
  expect(preview.feeRao).toBe(101n);
  expect(preview.maxFeeRao).toBe(112n);
  expect(f.extrinsic.paymentInfo).toHaveBeenCalledWith("fixture-account");
  expect(f.api.rpc.chain.getBlockHash).toHaveBeenCalledWith("500");
  await expect(revalidateNativeCall(f.connection, preview)).resolves.toBeUndefined();
});

test("wrong genesis, missing identity, forks, unfinalized sources and runtime changes cannot be signed", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.artifact.source.network_genesis_hash = block;
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.source.runtime_code_hash = null;
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.source.finalized_block_hash = genesis;
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.source.finalized_block = "503";
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.source.runtime_spec_version = 469;
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.source.runtime_transaction_version = 2;
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.source.runtime_code_hash = block;
    },
    (f: ReturnType<typeof fixture>) => {
      f.api.runtimeVersion.specVersion = integer(469n);
    },
    (f: ReturnType<typeof fixture>) => {
      f.api.runtimeVersion.transactionVersion = integer(2n);
    },
    (f: ReturnType<typeof fixture>) => {
      f.api.rpc.state.getStorageHash.mockResolvedValue({
        toHex: () => `0x${"00".repeat(32)}`,
      });
    },
  ]) {
    const f = fixture();
    mutate(f);
    await expect(previewNativeCall(f.connection, f.artifact, 0, "account")).rejects.toThrow();
    expect(f.api.tx).not.toHaveBeenCalled();
    expect(f.extrinsic.paymentInfo).not.toHaveBeenCalled();
  }
});

test("wallet metadata must reproduce the exact named call before a fee can be estimated", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.call.toHex.mockReturnValue("0x0701");
    },
    (f: ReturnType<typeof fixture>) => {
      f.call.meta.name.toString = () => "other_call";
    },
    (f: ReturnType<typeof fixture>) => {
      f.call.section = "balances";
    },
  ]) {
    const f = fixture();
    mutate(f);
    await expect(previewNativeCall(f.connection, f.artifact, 0, "account")).rejects.toThrow(
      /exactly/,
    );
    expect(f.api.tx).not.toHaveBeenCalled();
  }
  const f = fixture();
  await expect(previewNativeCall(f.connection, f.artifact, 1, "account")).rejects.toThrow(
    /prepared/,
  );
});

test("nonce, method bytes, fees and spendable balance are rechecked against the approved preview", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.api.rpc.system.accountNextIndex.mockResolvedValue(integer(1n));
    },
    (f: ReturnType<typeof fixture>) => {
      f.call.toHex.mockReturnValue("0x0701");
    },
    (f: ReturnType<typeof fixture>) => {
      f.extrinsic.paymentInfo.mockResolvedValue({ partialFee: integer(113n) });
    },
    (f: ReturnType<typeof fixture>) => {
      f.api.query.system.account.mockResolvedValue({
        data: { free: integer(200n), frozen: integer(100n) },
      });
    },
  ]) {
    const f = fixture();
    const preview = await previewNativeCall(f.connection, f.artifact, 0, "account");
    mutate(f);
    await expect(revalidateNativeCall(f.connection, preview)).rejects.toThrow(/again/);
  }
  const f = fixture();
  f.api.query.system.account.mockResolvedValue({
    data: { free: integer(211n), frozen: integer(100n) },
  });
  await expect(previewNativeCall(f.connection, f.artifact, 0, "account")).rejects.toThrow(
    /balance/,
  );
  f.extrinsic.paymentInfo.mockResolvedValue({ partialFee: integer(-1n) });
  await expect(previewNativeCall(f.connection, f.artifact, 0, "account")).rejects.toThrow(
    /invalid fee/,
  );
});
test("actual signing payloads are bound to reviewed bytes, account, runtime, nonce and mortality", async () => {
  const f = fixture(),
    preview = await previewNativeCall(f.connection, f.artifact, 0, "account");
  const payload: SignerPayloadJSON = {
    address: "account",
    method: "0x0700",
    genesisHash: genesis,
    specVersion: "0x1d6",
    transactionVersion: "0x01",
    nonce: "0xffffffff",
    era: "0x4000",
    blockHash: block,
    blockNumber: "0x01f6",
    tip: "0x00",
    signedExtensions: ["CheckNonce"],
    version: 4,
  };
  const signPayload = vi.fn(async () => ({ id: 1, signature: "0x1234" as `0x${string}` }));
  const recheck = vi.fn(async () => {}),
    current = vi.fn();
  const guarded = guardNativeSigner({ signPayload }, preview, current, recheck);
  await expect(guarded.signPayload!(payload)).resolves.toEqual({ id: 1, signature: "0x1234" });
  expect(current).toHaveBeenCalledTimes(3);
  expect(recheck).toHaveBeenCalledOnce();
  const patches: Partial<SignerPayloadJSON>[] = [
    { address: "other" },
    { method: "0x0701" },
    { genesisHash: block },
    { specVersion: "0x1d7" },
    { transactionVersion: "0x02" },
    { nonce: "0x01" },
    { era: "0x00" },
  ];
  for (const patch of patches) {
    signPayload.mockClear();
    await expect(guarded.signPayload!({ ...payload, ...patch })).rejects.toThrow(/differs/);
    expect(signPayload).not.toHaveBeenCalled();
  }
  expect(() => guardNativeSigner({} as Signer, preview, current, recheck)).toThrow(/signatures/);
});
test("SDK raw-signature wallets also recheck the reviewed extrinsic before and after the prompt", async () => {
  const f = fixture(),
    preview = await previewNativeCall(f.connection, f.artifact, 0, "account");
  const signRaw = vi.fn(async () => ({ id: 1, signature: "0x1234" as `0x${string}` })),
    recheck = vi.fn(async () => {});
  const guarded = guardNativeSigner({ signRaw }, preview, () => {}, recheck);
  await expect(
    guarded.signRaw!({ address: "account", type: "bytes", data: "0x0102" }),
  ).resolves.toEqual({ id: 1, signature: "0x1234" });
  expect(recheck).toHaveBeenCalledTimes(2);
  signRaw.mockClear();
  await expect(
    guarded.signRaw!({ address: "other-account", type: "bytes", data: "0x0102" }),
  ).rejects.toThrow(/differs/);
  expect(signRaw).not.toHaveBeenCalled();
});
test("a context change while the extension is signing rejects the signature before broadcast can resume", async () => {
  const f = fixture(),
    preview = await previewNativeCall(f.connection, f.artifact, 0, "account");
  let valid = true;
  const guarded = guardNativeSigner(
    {
      signPayload: async () => {
        valid = false;
        return { id: 1, signature: "0x1234" };
      },
    },
    preview,
    () => {
      if (!valid) throw new Error("context changed");
    },
    async () => {},
  );
  await expect(
    guarded.signPayload!({
      address: "account",
      method: "0x0700",
      genesisHash: genesis,
      specVersion: "0x1d6",
      transactionVersion: "0x01",
      nonce: "0xffffffff",
      era: "0x4000",
      blockHash: block,
      blockNumber: "0x01f6",
      tip: "0x00",
      signedExtensions: ["CheckNonce"],
      version: 4,
    }),
  ).rejects.toThrow(/context changed/);
});
