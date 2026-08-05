// Unit tests for the contract↔prose-doc drift gate. The pure functions are
// exercised with synthetic catalogs and doc text, so no git/network is touched.
//
// The fixtures deliberately reproduce the shape of the real defect (#9562): an
// entry whose description moved from "not live / one-shot materialization" to
// "composed live, declines while unproven" while its doc bullet stayed put.

import { describe, expect, it } from "vitest";
import {
  CLAIM_TOKENS,
  claimVector,
  descriptionsFromCatalog,
  docBulletFor,
  evaluateContractDocSync,
  headReadRef,
  resolveDiffBase,
} from "../scripts/validate-contract-doc-sync.ts";

const STALE_DESCRIPTION =
  "Balance-based top-holder leaderboard. free_tao/delegated_tao/total_tao are " +
  "not live: those three sorts answer from the one-shot 2026-08-02 materialization.";
const LIVE_DESCRIPTION =
  "Balance-based top-holder leaderboard. The holdings sorts are composed live " +
  "from D1 and served only while the producer's most recent pass is recorded " +
  "complete; while an input is unproven that sort declines to a fixed " +
  "materialization.";

const DOC_WITH_STALE_BULLET = [
  "## Public Artifacts",
  "",
  "- `/metagraph/accounts.json`: the hotkey leaderboard, served live from D1.",
  "- `/metagraph/top-holders.json`: the coldkey counterpart to " +
    "`/metagraph/accounts.json` above. The three holdings sorts answer from the " +
    "frozen 2026-08-02 materialization.",
  "",
].join("\n");

const DOC_WITH_UPDATED_BULLET = DOC_WITH_STALE_BULLET.replace(
  "The three holdings sorts answer from the frozen 2026-08-02 materialization.",
  "The three holdings sorts are composed live, gated per column on a complete pass.",
);

function catalog(entries: { path: string; description: string }[]): unknown {
  return { artifacts: entries };
}

describe("claimVector", () => {
  it("captures the tier/liveness vocabulary a bullet commits to", () => {
    expect(claimVector(STALE_DESCRIPTION)).toEqual([
      "live",
      "not-live",
      "materialization",
    ]);
    expect(claimVector(LIVE_DESCRIPTION)).toEqual([
      "live",
      "materialization",
      "declines",
      "unproven",
      "complete-pass",
      "d1",
    ]);
  });

  it("ignores a description edit that changes no claim", () => {
    const before = "Fetch the per-UID metagraph, served live from the D1 tier.";
    const after =
      "Fetch the per-UID metagraph, served live from the D1 tier; " +
      "?format=csv returns the same rows as CSV.";
    expect(claimVector(after)).toEqual(claimVector(before));
  });

  it("declares every token with a distinct name", () => {
    const names = CLAIM_TOKENS.map((token) => token.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("descriptionsFromCatalog", () => {
  it("maps path → description for the requested collection", () => {
    const map = descriptionsFromCatalog(
      { routes: [{ path: "/api/v1/x", description: "x" }] },
      "routes",
    );
    expect(map.get("/api/v1/x")).toBe("x");
  });

  it("tolerates a missing collection and a description-less entry", () => {
    expect(descriptionsFromCatalog({}, "artifacts").size).toBe(0);
    expect(descriptionsFromCatalog(null, "artifacts").size).toBe(0);
    expect(
      descriptionsFromCatalog({ artifacts: [{ path: "/a" }] }, "artifacts").get(
        "/a",
      ),
    ).toBe("");
  });
});

describe("docBulletFor", () => {
  it("finds the bullet whose leading token is the path", () => {
    const bullet = docBulletFor(
      DOC_WITH_STALE_BULLET,
      "/metagraph/top-holders.json",
    );
    expect(bullet?.line).toBe(4);
  });

  it("does not attribute a bullet to a path merely quoted inside it", () => {
    // Positive control: the accounts path IS present in the top-holders bullet
    // (line 4), so a substring match would resolve it to the wrong line.
    expect(DOC_WITH_STALE_BULLET.split("\n")[3]).toContain(
      "/metagraph/accounts.json",
    );
    expect(
      docBulletFor(DOC_WITH_STALE_BULLET, "/metagraph/accounts.json"),
    ).toMatchObject({ line: 3 });
  });

  it("returns null when nothing documents the path", () => {
    expect(docBulletFor(DOC_WITH_STALE_BULLET, "/metagraph/nope.json")).toBe(
      null,
    );
  });
});

describe("evaluateContractDocSync", () => {
  const base = descriptionsFromCatalog(
    catalog([
      {
        path: "/metagraph/top-holders.json",
        description: STALE_DESCRIPTION,
      },
    ]),
    "artifacts",
  );
  const head = descriptionsFromCatalog(
    catalog([
      { path: "/metagraph/top-holders.json", description: LIVE_DESCRIPTION },
    ]),
    "artifacts",
  );

  it("fails when the claim vector moved and the doc bullet did not", () => {
    const result = evaluateContractDocSync({
      baseDescriptions: base,
      headDescriptions: head,
      baseDoc: DOC_WITH_STALE_BULLET,
      headDoc: DOC_WITH_STALE_BULLET,
    });
    expect(result.ok).toBe(false);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toMatchObject({
      path: "/metagraph/top-holders.json",
      docLine: 4,
    });
    expect(result.drift[0].gained).toContain("declines");
    expect(result.drift[0].lost).toContain("not-live");
  });

  it("passes once the doc bullet is updated in the same diff", () => {
    const result = evaluateContractDocSync({
      baseDescriptions: base,
      headDescriptions: head,
      baseDoc: DOC_WITH_STALE_BULLET,
      headDoc: DOC_WITH_UPDATED_BULLET,
    });
    expect(result.ok).toBe(true);
    expect(result.drift).toEqual([]);
  });

  it("does not fire on a description edit that keeps the same claims", () => {
    const reworded = descriptionsFromCatalog(
      catalog([
        {
          path: "/metagraph/top-holders.json",
          description: `${STALE_DESCRIPTION} Limit caps the list.`,
        },
      ]),
      "artifacts",
    );
    // Positive control: the description really did change, so a plain
    // description-inequality gate would have fired here.
    expect(reworded.get("/metagraph/top-holders.json")).not.toBe(
      base.get("/metagraph/top-holders.json"),
    );
    const result = evaluateContractDocSync({
      baseDescriptions: base,
      headDescriptions: reworded,
      baseDoc: DOC_WITH_STALE_BULLET,
      headDoc: DOC_WITH_STALE_BULLET,
    });
    expect(result.ok).toBe(true);
  });

  it("does not fire for an entry that is new in this diff", () => {
    const added = descriptionsFromCatalog(
      catalog([
        { path: "/metagraph/top-holders.json", description: STALE_DESCRIPTION },
        { path: "/metagraph/brand-new.json", description: LIVE_DESCRIPTION },
      ]),
      "artifacts",
    );
    const result = evaluateContractDocSync({
      baseDescriptions: base,
      headDescriptions: added,
      baseDoc: DOC_WITH_STALE_BULLET,
      headDoc: DOC_WITH_STALE_BULLET,
    });
    expect(result.ok).toBe(true);
  });

  it("skips an entry the doc does not give a bullet of its own", () => {
    const undocumented = descriptionsFromCatalog(
      catalog([
        { path: "/metagraph/hidden.json", description: STALE_DESCRIPTION },
      ]),
      "artifacts",
    );
    const undocumentedHead = descriptionsFromCatalog(
      catalog([
        { path: "/metagraph/hidden.json", description: LIVE_DESCRIPTION },
      ]),
      "artifacts",
    );
    const result = evaluateContractDocSync({
      baseDescriptions: undocumented,
      headDescriptions: undocumentedHead,
      baseDoc: DOC_WITH_STALE_BULLET,
      headDoc: DOC_WITH_STALE_BULLET,
    });
    expect(result.ok).toBe(true);
  });
});

describe("head-side source (#9575)", () => {
  it("reads the explicit head ref when CI supplies one", () => {
    // On a pull_request the checkout is the MERGE commit, so reading the
    // working tree would diff the base branch's own changes as this PR's.
    expect(headReadRef("abc123")).toBe("abc123");
  });

  it("falls back to the working tree locally, so an uncommitted edit counts", () => {
    expect(headReadRef(undefined)).toBe(null);
    expect(headReadRef("")).toBe(null);
  });
});

describe("bullet already agrees (#9575)", () => {
  // A description corrected to match prose that was already right: the bullet
  // says D1, the description finally does too. Editing the bullet to satisfy a
  // gate would degrade a correct line.
  const correctBullet =
    "- `/metagraph/x.json`: served live from the `neurons` D1 tier.";
  const staleDescription = "Served live from the Postgres-backed neurons tier.";
  const fixedDescription = "Served live from the neurons D1 tier.";

  it("does not fire when the bullet already carries the gained claims", () => {
    // Positive control: the claim vector really did move (postgres -> d1), so
    // the pre-#9575 rule would have reported drift here.
    expect(claimVector(staleDescription)).toContain("postgres");
    expect(claimVector(fixedDescription)).toContain("d1");

    const result = evaluateContractDocSync({
      baseDescriptions: new Map([["/metagraph/x.json", staleDescription]]),
      headDescriptions: new Map([["/metagraph/x.json", fixedDescription]]),
      baseDoc: correctBullet,
      headDoc: correctBullet,
    });
    expect(result.ok).toBe(true);
  });

  it("still fires when the bullet keeps a claim the description dropped", () => {
    const staleBullet =
      "- `/metagraph/x.json`: not live — answers from the frozen materialization.";
    const result = evaluateContractDocSync({
      baseDescriptions: new Map([["/metagraph/x.json", STALE_DESCRIPTION]]),
      headDescriptions: new Map([["/metagraph/x.json", LIVE_DESCRIPTION]]),
      baseDoc: staleBullet,
      headDoc: staleBullet,
    });
    expect(result.ok).toBe(false);
    expect(result.drift[0].lost).toContain("not-live");
  });

  it("still fires when the bullet is missing a claim the description gained", () => {
    const thinBullet = "- `/metagraph/x.json`: the top-holder leaderboard.";
    const result = evaluateContractDocSync({
      baseDescriptions: new Map([["/metagraph/x.json", staleDescription]]),
      headDescriptions: new Map([
        ["/metagraph/x.json", "Served from the frozen lakehouse export."],
      ]),
      baseDoc: thinBullet,
      headDoc: thinBullet,
    });
    expect(result.ok).toBe(false);
    expect(result.drift[0].gained).toContain("lakehouse");
  });
});

describe("resolveDiffBase", () => {
  it("uses an explicit base when given one", () => {
    const calls: string[][] = [];
    const resolved = resolveDiffBase({
      explicitBase: "abc123",
      baseRef: "main",
      headRef: "HEAD",
      gitFn: (args) => {
        calls.push(args);
        return "merge-base-sha\n";
      },
    });
    expect(resolved).toBe("merge-base-sha");
    expect(calls).toEqual([["merge-base", "abc123", "HEAD"]]);
  });

  it("falls back from origin/<ref> to the bare ref", () => {
    const resolved = resolveDiffBase({
      explicitBase: undefined,
      baseRef: "main",
      headRef: "HEAD",
      gitFn: (args) => {
        if (args[1] === "origin/main") throw new Error("no remote ref");
        return "local-base\n";
      },
    });
    expect(resolved).toBe("local-base");
  });

  it("returns null when no base is resolvable, so the gate can skip", () => {
    const resolved = resolveDiffBase({
      explicitBase: undefined,
      baseRef: "main",
      headRef: "HEAD",
      gitFn: () => {
        throw new Error("shallow clone");
      },
    });
    expect(resolved).toBe(null);
  });
});
