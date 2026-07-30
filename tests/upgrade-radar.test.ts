// Tests for src/upgrade-radar.ts (#8702).
//
// FIXTURE PROVENANCE — every payload below is a real captured response, not an
// invented shape. This repo has now shipped four bugs whose common cause was a
// fixture written to satisfy a type signature rather than recorded from the
// real producer (#8646 wrapped bytes, #8650 positional netuid, #8686 numeric
// account id, #8687 a stub that ignored the request path), and #8702's own
// definition-of-done makes recorded fixtures a completion criterion.
//
// Captured 2026-07-29:
//   RUNTIME_VERSION_MAINNET / _TESTNET
//     curl -X POST https://entrypoint-finney.opentensor.ai:443 \
//       -d '{"jsonrpc":"2.0","id":1,"method":"state_getRuntimeVersion","params":[]}'
//     (and the same against https://test.finney.opentensor.ai:443)
//   RELEASES  gh api 'repos/opentensor/subtensor/releases?per_page=100'
//   BITS      gh api repos/opentensor/bits/contents/bits
//
// The capture caught two things a hand-written fixture would have missed, and
// both are asserted below: proposed runtimes ship as `prerelease: true` (so
// GitHub's /releases/latest reported v438 while both chains ran 440), and the
// tag corpus spans three incompatible formats.

import { describe, expect, it } from "vitest";
import {
  buildUpgradeRadar,
  appendTransitions,
  bitFeedItems,
  derivePendingUpgrade,
  githubHeaders,
  releaseFeedItems,
  selectLatestRelease,
  shouldAlertSoak,
  specVersionFromRuntimeVersion,
  specVersionFromTag,
  transitionFeedItems,
  UPGRADE_FEED_TAG,
} from "../src/upgrade-radar.ts";

// Real state_getRuntimeVersion envelope, apis[] truncated to three entries
// (24 in the original) — the array is untouched by this module and the full
// list adds 20 lines of hex per fixture.
const RUNTIME_VERSION_MAINNET = {
  jsonrpc: "2.0",
  result: {
    apis: [
      ["0xdf6acb689907609b", 5],
      ["0x37e397fc7c91f5e4", 2],
      ["0x40fe3ad401f8959a", 6],
    ],
    authoringVersion: 1,
    implName: "node-subtensor",
    implVersion: 1,
    specName: "node-subtensor",
    specVersion: 440,
    stateVersion: 1,
    systemVersion: 1,
    transactionVersion: 1,
  },
  id: 1,
};

// Captured identical to mainnet on 2026-07-29 — both chains were on 440.
const RUNTIME_VERSION_TESTNET = RUNTIME_VERSION_MAINNET;

// Real releases listing, newest first, trimmed to the fields this module reads
// plus the three tag eras. html_url shows the RaoFoundation redirect verbatim.
const RELEASES = [
  {
    tag_name: "v440",
    name: "Runtime 440 (proposed)",
    published_at: "2026-07-27T13:49:31Z",
    prerelease: true,
    draft: false,
    html_url: "https://github.com/RaoFoundation/subtensor/releases/tag/v440",
  },
  {
    tag_name: "v439",
    name: "Runtime 439 (proposed)",
    published_at: "2026-07-24T20:02:07Z",
    prerelease: true,
    draft: false,
    html_url: "https://github.com/RaoFoundation/subtensor/releases/tag/v439",
  },
  {
    tag_name: "v438",
    name: "Runtime 438",
    published_at: "2026-07-23T20:34:20Z",
    prerelease: false,
    draft: false,
    html_url: "https://github.com/RaoFoundation/subtensor/releases/tag/v438",
  },
  {
    tag_name: "v3.4.9-424",
    name: "Runtime 424",
    published_at: "2026-05-14T18:02:11Z",
    prerelease: false,
    draft: false,
    html_url:
      "https://github.com/RaoFoundation/subtensor/releases/tag/v3.4.9-424",
  },
  {
    tag_name: "v3.2.7",
    name: "3.2.7",
    published_at: "2024-11-05T09:12:44Z",
    prerelease: false,
    draft: false,
    html_url: "https://github.com/RaoFoundation/subtensor/releases/tag/v3.2.7",
  },
];

// Real bits/ directory listing.
const BITS = [
  {
    name: "BIT-0000-template.md",
    type: "file",
    sha: "2bf3d445c5e2a1f0d9c8b7a6e5f4d3c2b1a09876",
    html_url:
      "https://github.com/opentensor/bits/blob/main/bits/BIT-0000-template.md",
  },
  {
    name: "BIT-0004-subnet-deregistration.md",
    type: "file",
    sha: "b6b153e8d4c3b2a1908f7e6d5c4b3a2918070605",
    html_url:
      "https://github.com/opentensor/bits/blob/main/bits/BIT-0004-subnet-deregistration.md",
  },
];

describe("specVersionFromTag", () => {
  it("parses all three real tag eras", () => {
    // Current era: bare spec.
    expect(specVersionFromTag("v440")).toBe(440);
    // Middle era: semver + spec suffix. The trap — the leading digits are 3.
    expect(specVersionFromTag("v3.4.9-424")).toBe(424);
    // One real middle-era tag has no leading "v".
    expect(specVersionFromTag("3.2.14-345")).toBe(345);
    // Oldest era: spec not encoded, so there is nothing to report.
    expect(specVersionFromTag("v3.2.7")).toBeNull();
  });

  it("never returns the semver major for a suffixed tag", () => {
    // Guards the specific regression a naive /\d+/ parser produces: reporting
    // spec 3 for every release between v3.2.8-320 and v3.4.9-424.
    for (const tag of ["v3.4.9-424", "v3.3.15-402", "v3.2.8-320"]) {
      expect(specVersionFromTag(tag)).toBeGreaterThan(300);
    }
  });

  it("rejects non-strings and unrecognized shapes", () => {
    expect(specVersionFromTag(null)).toBeNull();
    expect(specVersionFromTag(440)).toBeNull();
    expect(specVersionFromTag("")).toBeNull();
    expect(specVersionFromTag("main")).toBeNull();
    expect(specVersionFromTag("3.4.9-rc1-424")).toBeNull();
  });
});

describe("selectLatestRelease", () => {
  it("picks the highest spec version, including prereleases", () => {
    const latest = selectLatestRelease(RELEASES);
    // The load-bearing assertion: v440 is prerelease:true, and GitHub's own
    // /releases/latest returned v438 for this exact listing. Selecting by
    // GitHub's notion of "latest" would make released_undeployed unreachable.
    expect(latest?.tag).toBe("v440");
    expect(latest?.spec_version).toBe(440);
    expect(latest?.prerelease).toBe(true);
  });

  it("reports GitHub's own html_url rather than a constructed one", () => {
    // opentensor/subtensor redirects to RaoFoundation/subtensor; a URL built
    // from the queried repo name would encode an owner that no longer holds
    // the releases.
    expect(latestUrl()).toContain("RaoFoundation/subtensor");
  });

  it("skips drafts", () => {
    const withDraft = [
      { ...RELEASES[0], tag_name: "v441", draft: true },
      ...RELEASES,
    ];
    expect(selectLatestRelease(withDraft)?.tag).toBe("v440");
  });

  it("resolves a duplicated spec version to the first seen", () => {
    // v3.3.7-374 and v3.3.8-374 both exist upstream.
    const dupes = [
      { ...RELEASES[3], tag_name: "v3.3.8-374" },
      { ...RELEASES[3], tag_name: "v3.3.7-374" },
    ];
    expect(selectLatestRelease(dupes)?.tag).toBe("v3.3.8-374");
  });

  it("ignores entries with no parseable spec version", () => {
    expect(
      selectLatestRelease([{ tag_name: "v3.2.7", draft: false }]),
    ).toBeNull();
  });

  it("is total over degenerate input", () => {
    expect(selectLatestRelease(null)).toBeNull();
    expect(selectLatestRelease(undefined)).toBeNull();
    expect(selectLatestRelease([])).toBeNull();
    expect(selectLatestRelease([null, 7, "x", {}])).toBeNull();
    expect(selectLatestRelease([{ tag_name: "  " }])).toBeNull();
  });

  it("null-fills optional fields that GitHub omitted", () => {
    const sparse = selectLatestRelease([{ tag_name: "v440" }]);
    expect(sparse).toEqual({
      tag: "v440",
      spec_version: 440,
      published_at: null,
      url: null,
      name: null,
      prerelease: false,
    });
  });
});

function latestUrl(): string {
  return selectLatestRelease(RELEASES)?.url ?? "";
}

describe("specVersionFromRuntimeVersion", () => {
  it("reads the spec version from the real JSON-RPC envelope", () => {
    expect(specVersionFromRuntimeVersion(RUNTIME_VERSION_MAINNET)).toBe(440);
    expect(specVersionFromRuntimeVersion(RUNTIME_VERSION_TESTNET)).toBe(440);
  });

  it("accepts an already-unwrapped result object", () => {
    expect(specVersionFromRuntimeVersion(RUNTIME_VERSION_MAINNET.result)).toBe(
      440,
    );
  });

  it("returns null for anything that is not a reading", () => {
    expect(specVersionFromRuntimeVersion(null)).toBeNull();
    expect(specVersionFromRuntimeVersion("<html>502</html>")).toBeNull();
    expect(
      specVersionFromRuntimeVersion({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: 1,
      }),
    ).toBeNull();
    expect(
      specVersionFromRuntimeVersion({ result: { specVersion: "440" } }),
    ).toBeNull();
    expect(
      specVersionFromRuntimeVersion({ result: { specVersion: -1 } }),
    ).toBeNull();
    expect(specVersionFromRuntimeVersion({ result: null })).toBeNull();
  });
});

describe("derivePendingUpgrade", () => {
  it("reaches all three defined states", () => {
    expect(
      derivePendingUpgrade({
        mainnetSpec: 440,
        testnetSpec: 440,
        releaseSpec: 440,
      }),
    ).toBe("none");
    expect(
      derivePendingUpgrade({
        mainnetSpec: 439,
        testnetSpec: 440,
        releaseSpec: 440,
      }),
    ).toBe("testnet_soaking");
    expect(
      derivePendingUpgrade({
        mainnetSpec: 440,
        testnetSpec: 440,
        releaseSpec: 441,
      }),
    ).toBe("released_undeployed");
  });

  it("reports unknown, never none, when a reading is missing", () => {
    // The distinction the whole module exists for: a dead testnet RPC must not
    // look like "no upgrade pending".
    expect(
      derivePendingUpgrade({
        mainnetSpec: 440,
        testnetSpec: null,
        releaseSpec: 440,
      }),
    ).toBe("unknown");
    expect(
      derivePendingUpgrade({
        mainnetSpec: null,
        testnetSpec: 440,
        releaseSpec: 440,
      }),
    ).toBe("unknown");
    expect(
      derivePendingUpgrade({
        mainnetSpec: 440,
        testnetSpec: 440,
        releaseSpec: null,
      }),
    ).toBe("unknown");
    expect(
      derivePendingUpgrade({
        mainnetSpec: null,
        testnetSpec: null,
        releaseSpec: null,
      }),
    ).toBe("unknown");
  });

  it("still reports soaking when only the GitHub fetch failed", () => {
    // Positive evidence outranks a null elsewhere: two readings prove this.
    expect(
      derivePendingUpgrade({
        mainnetSpec: 439,
        testnetSpec: 440,
        releaseSpec: null,
      }),
    ).toBe("testnet_soaking");
  });

  it("will not claim released_undeployed without a testnet reading", () => {
    // A release above mainnet with testnet unknown does NOT establish that
    // testnet lacks it — asserting "undeployed" here would be unmeasured.
    expect(
      derivePendingUpgrade({
        mainnetSpec: 439,
        testnetSpec: null,
        releaseSpec: 441,
      }),
    ).toBe("unknown");
  });

  it("treats mainnet ahead of testnet as nothing pending", () => {
    expect(
      derivePendingUpgrade({
        mainnetSpec: 440,
        testnetSpec: 439,
        releaseSpec: 440,
      }),
    ).toBe("none");
  });

  it("prefers soaking over released_undeployed when both could apply", () => {
    expect(
      derivePendingUpgrade({
        mainnetSpec: 439,
        testnetSpec: 440,
        releaseSpec: 441,
      }),
    ).toBe("testnet_soaking");
  });
});

describe("buildUpgradeRadar", () => {
  const observedAt = "2026-07-29T12:00:00.000Z";

  it("assembles the live captured reading", () => {
    const radar = buildUpgradeRadar({
      mainnetSpec: specVersionFromRuntimeVersion(RUNTIME_VERSION_MAINNET),
      testnetSpec: specVersionFromRuntimeVersion(RUNTIME_VERSION_TESTNET),
      release: selectLatestRelease(RELEASES),
      observedAt,
    });
    expect(radar.mainnet).toEqual({
      network: "mainnet",
      spec_version: 440,
      observed_at: observedAt,
    });
    expect(radar.pending_upgrade).toBe("none");
    expect(radar.versions_behind).toBe(0);
    expect(radar.latest_release?.tag).toBe("v440");
  });

  it("leaves observed_at null on the reading that failed", () => {
    const radar = buildUpgradeRadar({
      mainnetSpec: 440,
      testnetSpec: null,
      release: null,
      observedAt,
    });
    expect(radar.testnet).toEqual({
      network: "testnet",
      spec_version: null,
      observed_at: null,
    });
    expect(radar.mainnet.observed_at).toBe(observedAt);
    expect(radar.pending_upgrade).toBe("unknown");
  });

  it("counts versions behind the furthest-along reading", () => {
    expect(
      buildUpgradeRadar({
        mainnetSpec: 438,
        testnetSpec: 440,
        release: null,
        observedAt,
      }).versions_behind,
    ).toBe(2);
    // Falls through to the release when testnet is dark.
    expect(
      buildUpgradeRadar({
        mainnetSpec: 438,
        testnetSpec: null,
        release: selectLatestRelease(RELEASES),
        observedAt,
      }).versions_behind,
    ).toBe(2);
  });

  it("has no versions_behind without a mainnet reading", () => {
    expect(
      buildUpgradeRadar({
        mainnetSpec: null,
        testnetSpec: 440,
        release: null,
        observedAt,
      }).versions_behind,
    ).toBeNull();
  });

  it("contains no ETA or prediction field", () => {
    // Definition-of-done criterion: zero prediction fields in the payload.
    const radar = buildUpgradeRadar({
      mainnetSpec: 439,
      testnetSpec: 440,
      release: selectLatestRelease(RELEASES),
      observedAt,
    });
    const serialized = JSON.stringify(radar).toLowerCase();
    for (const banned of [
      "eta",
      "expected",
      "forecast",
      "predict",
      "estimate",
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });
});

describe("releaseFeedItems", () => {
  it("emits one item per parseable published release", () => {
    const items = releaseFeedItems(RELEASES);
    // v3.2.7 carries no spec version, so it is dropped: 5 in, 4 out.
    expect(items).toHaveLength(4);
    expect(items[0].id).toBe("upgrade:release:v440");
    expect(items[0].title).toBe("Runtime 440 released (proposed)");
    expect(items[0].timestamp).toBe("2026-07-27T13:49:31Z");
  });

  it("links to the primary source", () => {
    const [first] = releaseFeedItems(RELEASES);
    expect(first.url).toBe(
      "https://github.com/RaoFoundation/subtensor/releases/tag/v440",
    );
  });

  it("tags every item so ?tag=upgrade works", () => {
    for (const item of releaseFeedItems(RELEASES)) {
      expect(item.tags).toContain(UPGRADE_FEED_TAG);
    }
  });

  it("produces stable ids across polls", () => {
    expect(releaseFeedItems(RELEASES)).toEqual(releaseFeedItems(RELEASES));
  });

  it("drops a release with no published_at rather than stamping now", () => {
    expect(releaseFeedItems([{ tag_name: "v441", draft: false }])).toEqual([]);
  });

  it("marks a full release without the proposed qualifier", () => {
    const item = releaseFeedItems([RELEASES[2]])[0];
    expect(item.title).toBe("Runtime 438 released");
    expect(item.summary).not.toContain("proposed");
  });

  it("falls back to a repo url when html_url is missing", () => {
    const items = releaseFeedItems(
      [{ tag_name: "v441", published_at: "2026-07-30T00:00:00Z" }],
      { repoUrl: "https://github.com/opentensor/subtensor" },
    );
    expect(items[0].url).toBe("https://github.com/opentensor/subtensor");
  });

  it("drops an item it cannot link at all", () => {
    expect(
      releaseFeedItems([
        { tag_name: "v441", published_at: "2026-07-30T00:00:00Z" },
      ]),
    ).toEqual([]);
  });

  it("is total over degenerate input", () => {
    expect(releaseFeedItems(null)).toEqual([]);
    expect(releaseFeedItems([null, 3, "x"])).toEqual([]);
    expect(releaseFeedItems([{ draft: true, tag_name: "v441" }])).toEqual([]);
  });
});

describe("appendTransitions", () => {
  it("records only forward movement, per network", () => {
    let ledger = appendTransitions(
      null,
      [
        { network: "mainnet", spec_version: 439 },
        { network: "testnet", spec_version: 439 },
      ],
      "2026-07-25T04:00:00.000Z",
    );
    expect(ledger).toHaveLength(2);

    // An unchanged poll adds nothing — this is what keeps the feed from
    // gaining two identical items an hour, forever.
    ledger = appendTransitions(
      ledger,
      [
        { network: "mainnet", spec_version: 439 },
        { network: "testnet", spec_version: 439 },
      ],
      "2026-07-25T04:30:00.000Z",
    );
    expect(ledger).toHaveLength(2);

    // Testnet moving ahead is one new entry, on testnet only.
    ledger = appendTransitions(
      ledger,
      [
        { network: "mainnet", spec_version: 439 },
        { network: "testnet", spec_version: 440 },
      ],
      "2026-07-27T14:00:00.000Z",
    );
    expect(ledger).toHaveLength(3);
    expect(ledger[2]).toEqual({
      network: "testnet",
      spec_version: 440,
      observed_at: "2026-07-27T14:00:00.000Z",
    });
  });

  it("ignores a backwards reading", () => {
    // A node serving stale state, or a rollback — not an upgrade either way.
    const ledger = appendTransitions(
      [
        {
          network: "mainnet",
          spec_version: 440,
          observed_at: "2026-07-29T00:00:00.000Z",
        },
      ],
      [{ network: "mainnet", spec_version: 439 }],
      "2026-07-29T00:30:00.000Z",
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0].spec_version).toBe(440);
  });

  it("records nothing for a null reading", () => {
    expect(
      appendTransitions(
        null,
        [{ network: "testnet", spec_version: null }],
        "2026-07-29T00:00:00.000Z",
      ),
    ).toEqual([]);
    expect(
      appendTransitions(
        null,
        [{ network: "testnet", spec_version: 1.5 as number }],
        "2026-07-29T00:00:00.000Z",
      ),
    ).toEqual([]);
  });

  it("keeps the ledger bounded, newest last", () => {
    let ledger: ReturnType<typeof appendTransitions> = [];
    for (let spec = 1; spec <= 10; spec += 1) {
      ledger = appendTransitions(
        ledger,
        [{ network: "mainnet", spec_version: spec }],
        `2026-07-29T00:${String(spec).padStart(2, "0")}:00.000Z`,
      );
    }
    const capped = appendTransitions(
      ledger,
      [{ network: "mainnet", spec_version: 11 }],
      "2026-07-29T00:11:00.000Z",
      3,
    );
    expect(capped).toHaveLength(3);
    expect(capped.map((e) => e.spec_version)).toEqual([9, 10, 11]);
  });

  it("is total over degenerate input", () => {
    expect(
      appendTransitions(undefined, [], "2026-07-29T00:00:00.000Z"),
    ).toEqual([]);
    expect(
      appendTransitions(null, [null as never], "2026-07-29T00:00:00.000Z"),
    ).toEqual([]);
  });
});

describe("transitionFeedItems", () => {
  const ledger = [
    {
      network: "mainnet",
      spec_version: 439,
      observed_at: "2026-07-25T04:11:00.000Z",
    },
    {
      network: "testnet",
      spec_version: 440,
      observed_at: "2026-07-27T14:02:00.000Z",
    },
  ];

  it("links a transition to the runtime timeline", () => {
    const items = transitionFeedItems(ledger, {
      siteUrl: "https://metagraph.sh",
    });
    expect(items).toHaveLength(2);
    expect(items[0].url).toBe("https://metagraph.sh/runtime");
    expect(items[0].title).toBe("Mainnet now on runtime 439");
    expect(items[0].id).toBe("upgrade:mainnet:spec:439");
    expect(items[1].title).toBe("Testnet now on runtime 440");
    expect(items[1].id).toBe("upgrade:testnet:spec:440");
    for (const item of items) expect(item.tags).toContain(UPGRADE_FEED_TAG);
  });

  it("says detected, not applied", () => {
    // The poll interval cannot pin the upgrade instant, and the copy must not
    // imply otherwise.
    const [item] = transitionFeedItems(ledger, {
      siteUrl: "https://metagraph.sh",
    });
    expect(item.summary).toContain("when the change was detected");
    expect(item.summary).not.toContain("applied at");
  });

  it("drops rows it cannot date, number, or attribute to a chain", () => {
    expect(
      transitionFeedItems(
        [
          { network: "mainnet", spec_version: 440, observed_at: "" },
          {
            network: "mainnet",
            spec_version: 1.5,
            observed_at: "2026-01-01T00:00:00Z",
          },
          {
            network: "devnet",
            spec_version: 440,
            observed_at: "2026-01-01T00:00:00Z",
          },
        ],
        { siteUrl: "https://metagraph.sh" },
      ),
    ).toEqual([]);
  });

  it("is total over degenerate input", () => {
    expect(transitionFeedItems(null)).toEqual([]);
    expect(transitionFeedItems(undefined, { siteUrl: "" })).toEqual([]);
    expect(
      transitionFeedItems([null as never], { siteUrl: "https://metagraph.sh" }),
    ).toEqual([]);
  });
});

describe("githubHeaders", () => {
  it("authenticates when a token is present", () => {
    const headers = githubHeaders({ GITHUB_TOKEN: "ghp_example" } as never);
    // An auth bug here is invisible until GitHub throttles, which is exactly
    // when nobody is watching.
    expect(headers.authorization).toBe("Bearer ghp_example");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
    expect(headers["user-agent"]).toBe("metagraphed-upgrade-radar");
  });

  it("omits the header entirely when no token is configured", () => {
    // Not "Bearer undefined" — GitHub 401s on a malformed Authorization header,
    // which would be strictly worse than an unauthenticated request.
    for (const env of [{}, { GITHUB_TOKEN: "" }, { GITHUB_TOKEN: "   " }]) {
      expect(githubHeaders(env as never).authorization).toBeUndefined();
    }
  });

  it("trims a token pasted with surrounding whitespace", () => {
    expect(
      githubHeaders({ GITHUB_TOKEN: " ghp_x \n" } as never).authorization,
    ).toBe("Bearer ghp_x");
  });
});

describe("bitFeedItems", () => {
  const observedAt = "2026-07-29T12:00:00.000Z";

  it("turns the real bits listing into items", () => {
    const items = bitFeedItems(BITS, { observedAt });
    expect(items).toHaveLength(2);
    expect(items[1].title).toBe("BIT-0004: subnet deregistration");
    expect(items[1].url).toContain("opentensor/bits");
    expect(items[1].id).toBe(
      "upgrade:bit:b6b153e8d4c3b2a1908f7e6d5c4b3a2918070605",
    );
    expect(items[1].tags).toContain(UPGRADE_FEED_TAG);
  });

  it("keys the id on the blob sha so an edit produces a new item", () => {
    const edited = bitFeedItems(
      [{ ...BITS[1], sha: "ffffffffffffffffffffffffffffffffffffffff" }],
      { observedAt },
    );
    expect(edited[0].id).not.toBe(bitFeedItems(BITS, { observedAt })[1].id);
  });

  it("ignores directories and non-markdown files", () => {
    expect(
      bitFeedItems(
        [
          { name: "bits", type: "dir", sha: "a", html_url: "https://x" },
          { name: "LICENSE", type: "file", sha: "b", html_url: "https://x" },
        ],
        { observedAt },
      ),
    ).toEqual([]);
  });

  it("falls back to the filename when the BIT pattern does not match", () => {
    const items = bitFeedItems(
      [
        {
          name: "README.md",
          type: "file",
          sha: "c".repeat(40),
          html_url: "https://github.com/opentensor/bits/blob/main/README.md",
        },
      ],
      { observedAt },
    );
    expect(items[0].title).toBe("README.md");
  });

  it("is total over degenerate input", () => {
    expect(bitFeedItems(null, { observedAt })).toEqual([]);
    expect(bitFeedItems([null, 5], { observedAt })).toEqual([]);
    expect(
      bitFeedItems([{ name: "a.md", type: "file" }], { observedAt }),
    ).toEqual([]);
  });
});

describe("shouldAlertSoak", () => {
  it("fires once per spec version across repeated polls", () => {
    // The #8611 quiet-channel rule, proven rather than assumed: simulate the
    // poller with a persisted key, and count the fires.
    let stored: unknown = null;
    let fires = 0;
    for (let poll = 0; poll < 20; poll += 1) {
      if (
        shouldAlertSoak({
          state: "testnet_soaking",
          testnetSpec: 441,
          lastAlertedSpec: stored,
        })
      ) {
        fires += 1;
        stored = 441;
      }
    }
    expect(fires).toBe(1);

    // A new soak on the next version fires exactly once more.
    for (let poll = 0; poll < 20; poll += 1) {
      if (
        shouldAlertSoak({
          state: "testnet_soaking",
          testnetSpec: 442,
          lastAlertedSpec: stored,
        })
      ) {
        fires += 1;
        stored = 442;
      }
    }
    expect(fires).toBe(2);
  });

  it("only alerts on the soak state", () => {
    for (const state of ["none", "released_undeployed", "unknown"] as const) {
      expect(
        shouldAlertSoak({ state, testnetSpec: 441, lastAlertedSpec: null }),
      ).toBe(false);
    }
  });

  it("cannot alert without a testnet reading", () => {
    expect(
      shouldAlertSoak({
        state: "testnet_soaking",
        testnetSpec: null,
        lastAlertedSpec: null,
      }),
    ).toBe(false);
  });

  it("errs toward one duplicate alert when the stored key is unreadable", () => {
    // A KV outage should not silence the channel entirely.
    for (const stored of [null, undefined, "", "corrupt", NaN]) {
      expect(
        shouldAlertSoak({
          state: "testnet_soaking",
          testnetSpec: 441,
          lastAlertedSpec: stored,
        }),
      ).toBe(true);
    }
  });

  it("accepts a numeric string from KV", () => {
    // KV returns text; "441" must not be read as a different version.
    expect(
      shouldAlertSoak({
        state: "testnet_soaking",
        testnetSpec: 441,
        lastAlertedSpec: "441",
      }),
    ).toBe(false);
  });
});
