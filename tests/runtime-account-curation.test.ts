import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AccountEventsRow } from "../generated/lakehouse/types.ts";
import {
  RUNTIME_CURATED_EVENT_KINDS,
  RUNTIME_CURATION_FIRST_BLOCK,
  type RuntimeAccountCuration,
} from "../schemas-src/artifacts/runtime-account-curation.ts";
import {
  loadRuntimeAccountCuration,
  readRuntimeCurationObject,
  isRuntimeCorrectedRow,
  excludeRuntimeCorrectedRows,
  validateRuntimeCorrectedRows,
} from "../src/runtime-account-curation.ts";
import {
  loadIndexedAccountFeedPage,
  loadIndexedAccountFeedAggregate,
  loadRuntimeAccountSummaryGroups,
} from "../src/indexed-account-feeds.ts";
import { readSelectedHistoryBlock } from "../src/indexed-history-store.ts";
import { parquetReadBudget, r2ParquetSource } from "../src/indexed-parquet.ts";
import { currentIndexedHistoryFailureGeneration } from "../src/indexed-history-status.ts";
import type { IndexedAccountFeedEntry } from "../src/history-account-feed.ts";
import * as generationReader from "../src/history-generation.ts";

import {
  loadAccountSummaryProjection,
  accountHistoryFloorMs,
  ACCOUNT_SUMMARY_POINTER_KEY,
  accountSummaryShardKey,
} from "../src/account-summary-projection.ts";

const original = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/account-feeds/runtime-correction.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  correction: RuntimeAccountCuration;
  old: AccountEventsRow[];
  corrected: AccountEventsRow[];
  tail: AccountEventsRow[];
  objects: Record<string, { etag: string; base64: string }>;
};
const first = RUNTIME_CURATION_FIRST_BLOCK.mainnet;
const selector = { side: "all" as const, account: "*" };
const pointerKey = "metagraph/runtime-account-curation/v1/mainnet/current.json";
const ceilingKey =
  "metagraph/indexed-history/v1/mainnet/account_events/source-ceiling.json";
const compare = (a: AccountEventsRow, b: AccountEventsRow) =>
  b.observed_at! - a.observed_at! ||
  b.block_number! - a.block_number! ||
  b.event_index! - a.event_index!;
const expected = [
  ...original.old.filter(
    (r) => r.event_kind === "Transfer" || r.block_number! < first,
  ),
  ...original.corrected,
  ...original.tail,
].sort(compare);

function fixture() {
  const objects = new Map(
    Object.entries(original.objects).map(([key, value]) => [
      key,
      { raw: Buffer.from(value.base64, "base64"), etag: value.etag },
    ]),
  );
  const sizes = new Map<string, number>();
  const put = (key: string, value: unknown) => {
    const raw = Buffer.from(JSON.stringify(value)),
      etag = createHash("md5").update(raw).digest("hex");
    objects.set(key, { raw, etag });
    return { key, etag, bytes: raw.length };
  };
  const manifest = structuredClone(original.correction);
  const key = `metagraph/runtime-account-curation/v1/mainnet/${manifest.selection.generation}/manifest.json`;
  const pointer = {
    version: 1,
    network: "mainnet",
    manifest: put(key, manifest),
  };
  const save = () => {
    pointer.manifest = put(key, manifest);
    put(pointerKey, pointer);
  };
  save();
  const get = vi.fn(async (key: string, options?: R2GetOptions) => {
    const value = objects.get(key);
    if (!value) return null;
    const range =
      options?.range && "offset" in options.range ? options.range : undefined;
    const offset = range?.offset ?? 0,
      length = range?.length ?? value.raw.length;
    return {
      etag: value.etag,
      size: sizes.get(key) ?? value.raw.length,
      range: { offset, length },
      body: new Response(value.raw.subarray(offset, offset + length)).body,
      json: async () => JSON.parse(value.raw.toString()),
    };
  });
  const bucket = { get } as unknown as Pick<R2Bucket, "get">;
  return {
    objects,
    sizes,
    manifest,
    key,
    pointer,
    put,
    save,
    get,
    bucket,
    source: r2ParquetSource(bucket),
    env: { METAGRAPH_ARCHIVE: bucket },
  };
}

describe("qualified runtime account corrections", () => {
  it("merges exact native pages without losing physical duplicates, legacy unknowns or forward rows", async () => {
    const f = fixture();
    expect(await loadIndexedAccountFeedPage(f.env, [selector], 20)).toEqual(
      expected,
    );
    expect(await loadIndexedAccountFeedPage(f.env, [selector], 3, 2)).toEqual(
      expected.slice(2, 5),
    );
    const after = expected[1];
    expect(
      await loadIndexedAccountFeedPage(
        f.env,
        [
          {
            ...selector,
            cursor: [
              after.observed_at!,
              after.block_number!,
              after.event_index!,
            ],
          },
        ],
        20,
      ),
    ).toEqual(expected.filter((r) => compare(r, after) > 0));
    expect(
      await loadIndexedAccountFeedPage(
        f.env,
        [{ ...selector, kind: "BasketDeposited" }],
        20,
      ),
    ).toEqual(expected.filter((r) => r.event_kind === "BasketDeposited"));
    expect(
      await loadIndexedAccountFeedPage(
        f.env,
        [
          { side: "hotkey", account: "alice" },
          { side: "coldkey", account: "bob" },
        ],
        20,
      ),
    ).toEqual(expected);
    const rows = await loadIndexedAccountFeedAggregate(
      f.env,
      [selector],
      async (stream) => {
        const result: AccountEventsRow[] = [];
        for await (const row of stream) result.push(row);
        return result;
      },
    );
    expect(rows).toEqual(expected);
    expect(expected.filter((r) => r.event_kind === "Transfer")).toHaveLength(2);
    expect(
      expected.find((r) => r.block_number === first - 1)?.amount_tao,
    ).toBeNull();
  });

  it("uses the same corrected Parquet for block reads on both sides of the closed range", async () => {
    const f = fixture();
    for (const block of [
      first - 1,
      first,
      first + 1,
      first + 2,
      first + 3,
      first + 4,
      first + 5,
    ]) {
      const rows = await readSelectedHistoryBlock(
        f.env,
        "account_events",
        block,
      );
      expect(rows).toEqual(expected.filter((r) => r.block_number === block));
    }
  });

  it("preserves the prior contract before selection and skips nonintersecting correction feeds", async () => {
    const f = fixture();
    f.objects.delete(pointerKey);
    expect(
      await loadIndexedAccountFeedPage(
        f.env,
        [{ ...selector, kind: "BasketDeposited" }],
        20,
      ),
    ).toBeUndefined();
    expect(
      await loadIndexedAccountFeedPage(
        f.env,
        [{ ...selector, kind: "RootClaimed" }],
        20,
      ),
    ).toEqual(
      [...original.old, ...original.tail]
        .filter((r) => r.event_kind === "RootClaimed")
        .sort(compare),
    );
    expect(await loadIndexedAccountFeedPage(f.env, [selector], 20)).toEqual(
      [...original.old, ...original.tail].sort(compare),
    );
    expect(
      await readSelectedHistoryBlock(f.env, "account_events", first),
    ).toEqual(original.old.filter((r) => r.block_number === first));
    f.save();
    f.objects.delete(f.manifest.accountManifest.key);
    for (const bounds of [
      { blockStart: 0, blockEnd: first - 1 },
      { blockStart: first + 4, blockEnd: first + 5 },
    ])
      expect(
        await loadIndexedAccountFeedPage(
          f.env,
          [{ ...selector, ...bounds }],
          20,
        ),
      ).toEqual(
        expected.filter(
          (r) =>
            r.block_number! >= bounds.blockStart &&
            r.block_number! <= bounds.blockEnd,
        ),
      );
  });

  it("declines publication that outruns ordinary account coverage", async () => {
    const f = fixture();
    const ceiling = JSON.parse(f.objects.get(ceilingKey)!.raw.toString()) as {
      through: number;
    };
    ceiling.through = first + 2;
    f.put(ceilingKey, ceiling);
    expect(
      await loadIndexedAccountFeedPage(f.env, [selector], 20),
    ).toBeUndefined();
  });

  it("fails explicitly on malformed, oversized or out-of-scope selected metadata", async () => {
    const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
      (f) => {
        f.sizes.set(pointerKey, 8193);
      },
      (f) => {
        f.put(pointerKey, { ...f.pointer, network: "testnet" });
      },
      (f) => {
        f.put(pointerKey, {
          ...f.pointer,
          manifest: { ...f.pointer.manifest, key: "elsewhere.json" },
        });
      },
      (f) => {
        f.put(pointerKey, {
          ...f.pointer,
          manifest: { ...f.pointer.manifest, bytes: 16385 },
        });
      },
      (f) => {
        f.manifest.network = "testnet";
        f.save();
      },
      (f) => {
        f.manifest.selection.network = "testnet";
        f.save();
      },
      (f) => {
        f.manifest.selection.firstBlock++;
        f.save();
      },
      (f) => {
        f.manifest.selection.lastBlock = first - 1;
        f.save();
      },
      (f) => {
        f.manifest.selection.hashManifest = f.manifest.selection.blockManifest;
        f.save();
      },
      (f) => {
        f.manifest.selection.blockManifest.key = "wrong";
        f.save();
      },
      (f) => {
        f.manifest.accountManifest.key = "wrong";
        f.save();
      },
      (f) => {
        f.manifest.sourceProof.key = "wrong";
        f.save();
      },
      (f) => {
        f.manifest.rows++;
        f.save();
      },
      (f) => {
        f.manifest.selection.generation = "e".repeat(64);
        f.manifest.selection.blockManifest.key = `metagraph/indexed-history/v1/mainnet/account_events/generations/${f.manifest.selection.generation}/block-manifest.json`;
        f.manifest.accountManifest.key = `metagraph/indexed-history/v1/mainnet/account_events/generations/${f.manifest.selection.generation}/accounts/v1/manifest.json`;
        f.save();
      },
      (f) => {
        const v = f.objects.get(f.key)!;
        v.raw = Buffer.from("{");
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      const before = currentIndexedHistoryFailureGeneration();
      expect(
        await loadIndexedAccountFeedPage(f.env, [selector], 20),
      ).toBeNull();
      expect(currentIndexedHistoryFailureGeneration()).toBeGreaterThan(before);
    }
  });

  it("requires matching source snapshots and physical row censuses for both corrected indexes", async () => {
    for (const which of [
      "feed-rows",
      "feed-snapshot",
      "block-rows",
      "block-snapshot",
    ] as const) {
      const f = fixture();
      const descriptor = which.startsWith("feed")
        ? f.manifest.accountManifest
        : f.manifest.selection.blockManifest;
      const value = JSON.parse(
        f.objects.get(descriptor.key)!.raw.toString(),
      ) as { rows: number; sourceSnapshot: string };
      if (which.endsWith("rows")) value.rows++;
      else value.sourceSnapshot = "123";
      const updated = f.put(descriptor.key, value);
      if (which.startsWith("feed")) f.manifest.accountManifest = updated;
      else {
        f.manifest.selection.blockManifest = updated;
        const feed = JSON.parse(
          f.objects.get(f.manifest.accountManifest.key)!.raw.toString(),
        ) as { selection: RuntimeAccountCuration["selection"] };
        feed.selection = f.manifest.selection;
        f.manifest.accountManifest = f.put(
          f.manifest.accountManifest.key,
          feed,
        );
      }
      f.save();
      expect(
        await loadIndexedAccountFeedPage(f.env, [selector], 20),
      ).toBeNull();
      if (which.startsWith("block"))
        expect(
          await readSelectedHistoryBlock(f.env, "account_events", first),
        ).toBeNull();
    }
  });

  it("checks testnet's independent runtime floor and closes filtered streams on early exit", async () => {
    const f = fixture();
    const correction = structuredClone(f.manifest);
    correction.network = correction.selection.network = "testnet";
    correction.selection.firstBlock = RUNTIME_CURATION_FIRST_BLOCK.testnet;
    correction.selection.lastBlock = correction.selection.firstBlock + 3;
    const replace = (key: string) => key.replace("/mainnet/", "/testnet/");
    correction.selection.blockManifest.key = replace(
      correction.selection.blockManifest.key,
    );
    correction.accountManifest.key = replace(correction.accountManifest.key);
    correction.sourceProof.key = replace(correction.sourceProof.key);
    f.put(replace(pointerKey), {
      version: 1,
      network: "testnet",
      manifest: f.put(replace(f.key), correction),
    });
    expect(
      await loadRuntimeAccountCuration(
        f.bucket,
        f.source,
        "testnet",
        parquetReadBudget(),
      ),
    ).toEqual(correction);
    let closed = false;
    async function* entries() {
      try {
        for (const row of original.old) yield { row, token: "entry" };
      } finally {
        closed = true;
      }
    }
    const stream = excludeRuntimeCorrectedRows(entries(), f.manifest);
    expect((await stream.next()).value?.row.block_number).toBe(first - 1);
    await stream.return(undefined);
    expect(closed).toBe(true);
  });

  it("keeps unknown legacy values and rejects unrelated correction rows without masking failure", async () => {
    const f = fixture();
    for (const row of [
      {},
      { block_number: "8765684", event_kind: "RootClaimed" },
      { block_number: first - 1, event_kind: "RootClaimed" },
      { block_number: first + 4, event_kind: "RootClaimed" },
      { block_number: first },
      { block_number: first, event_kind: "Transfer" },
    ])
      expect(isRuntimeCorrectedRow(f.manifest, row)).toBe(false);
    for (const event_kind of RUNTIME_CURATED_EVENT_KINDS)
      expect(
        isRuntimeCorrectedRow(f.manifest, { block_number: first, event_kind }),
      ).toBe(true);
    async function* entries(
      rows: AccountEventsRow[],
    ): AsyncGenerator<IndexedAccountFeedEntry> {
      for (const row of rows) yield { row, token: "entry" };
    }
    const valid: AccountEventsRow[] = [];
    for await (const entry of validateRuntimeCorrectedRows(
      entries(original.corrected),
      f.manifest,
    ))
      valid.push(entry.row);
    expect(valid).toEqual(original.corrected);
    await expect(
      validateRuntimeCorrectedRows(entries(original.old), f.manifest).next(),
    ).rejects.toThrow("unrelated");
    await expect(
      readRuntimeCurationObject(
        f.source,
        { key: "oversize", etag: "x", bytes: 16385 },
        parquetReadBudget(),
      ),
    ).rejects.toThrow("budget");
    const broken = vi
      .spyOn(generationReader, "readHistoryBlock")
      .mockResolvedValue([{ block_number: first, event_kind: "Transfer" }]);
    try {
      expect(
        await readSelectedHistoryBlock(f.env, "account_events", first),
      ).toBeNull();
    } finally {
      broken.mockRestore();
    }
  });
});

function summaryFixture(accounts: Record<string, unknown>) {
  const f = fixture();
  const through = new Date(original.corrected[0].observed_at!)
    .toISOString()
    .slice(0, 10);
  f.put(ACCOUNT_SUMMARY_POINTER_KEY, {
    schema_version: 1,
    generation: "legacy",
    shard_count: 16,
    generated_at: new Date().toISOString(),
    account_count: Object.keys(accounts).length,
    through,
  });
  for (const account of ["alice", "bob", "absent"])
    f.put(accountSummaryShardKey(account, 16, "legacy"), { accounts });
  return f;
}

const legacyGroup = {
  kind: "Transfer",
  netuid: null,
  count: 2,
  fb: original.old[2].block_number,
  lb: original.old[2].block_number,
  fo: original.old[2].observed_at,
  lo: original.old[2].observed_at,
};

describe("runtime corrections and legacy lifetime summaries", () => {
  it("adds recovered kinds to an existing lifetime fold without recounting root claims", async () => {
    const f = summaryFixture({
      alice: [legacyGroup],
      bob: [{ ...legacyGroup, kind: "RootClaimed", count: 3 }],
    });
    const summary = await loadAccountSummaryProjection(f.env, "alice");
    expect(summary).toMatchObject({
      groups: [legacyGroup, { kind: "BasketDeposited", count: 1 }],
      recent: null,
    });
    expect(await accountHistoryFloorMs(f.env, "alice")).toBe(legacyGroup.fo);
    expect(await loadAccountSummaryProjection(f.env, "bob")).toMatchObject({
      groups: [{ kind: "RootClaimed", count: 3 }],
      recent: null,
    });
    expect(await loadAccountSummaryProjection(f.env, "absent")).toMatchObject({
      absent: true,
    });
    expect(
      await loadRuntimeAccountSummaryGroups(
        f.env,
        "alice",
        original.corrected[0].observed_at!,
      ),
    ).toEqual([]);
  });

  it("replaces an old absence receipt with recovered historical activity and its true floor", async () => {
    const f = summaryFixture({});
    const summary = await loadAccountSummaryProjection(f.env, "alice");
    expect(summary).toMatchObject({
      groups: [{ kind: "BasketDeposited", count: 1 }],
      recent: null,
    });
    expect(await accountHistoryFloorMs(f.env, "alice")).toBe(
      original.corrected[1].observed_at,
    );
    f.objects.delete(pointerKey);
    expect(await loadAccountSummaryProjection(f.env, "alice")).toMatchObject({
      absent: true,
    });
  });

  it("keeps unavailable corrections distinct from unselected and empty corrections", async () => {
    expect(
      await loadRuntimeAccountSummaryGroups(undefined, "alice", Date.now()),
    ).toBeUndefined();
    expect(
      await loadRuntimeAccountSummaryGroups({}, "alice", Date.now()),
    ).toBeUndefined();
    const f = summaryFixture({ alice: [legacyGroup] });
    f.objects.delete(f.manifest.accountManifest.key);
    expect(
      await loadRuntimeAccountSummaryGroups(f.env, "alice", Date.now()),
    ).toBeNull();
    expect(await loadAccountSummaryProjection(f.env, "alice")).toBeNull();
    f.objects.delete(pointerKey);
    expect(await loadAccountSummaryProjection(f.env, "alice")).toMatchObject({
      groups: [legacyGroup],
    });
  });

  it("requires matching correction and block-feed censuses for lifetime augmentation", async () => {
    for (const [field, value] of [
      ["rows", 9],
      ["sourceSnapshot", "changed"],
    ] as const) {
      for (const key of [
        original.correction.accountManifest.key,
        original.correction.selection.blockManifest.key,
      ]) {
        const f = fixture();
        const body = JSON.parse(f.objects.get(key)!.raw.toString());
        body[field] = value;
        const descriptor = f.put(key, body);
        if (key === f.manifest.accountManifest.key)
          f.manifest.accountManifest = descriptor;
        else f.manifest.selection.blockManifest = descriptor;
        f.save();
        expect(
          await loadRuntimeAccountSummaryGroups(f.env, "alice", Date.now()),
        ).toBeNull();
      }
    }
  });
});
