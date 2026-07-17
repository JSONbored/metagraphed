import { describe, expect, it } from "vitest";
import { subnetPositionSearch } from "@/lib/metagraphed/subnet-position-link";

// #6431: AccountFootprintSection and SubnetPerformanceTable each render one row
// per subnet membership and linked SN{netuid} to the bare subnet page, while the
// row's own uid sat unlinked in the next cell -- even though subnets.$netuid.tsx
// already reads `tab`/`uid` to render that neuron's detail card. Both rows now
// build their search through this one helper, so they cannot drift apart again.
describe("subnetPositionSearch (#6431)", () => {
  it("deep-links to the row's neuron card when a uid is present", () => {
    expect(subnetPositionSearch(3)).toEqual({ tab: "metagraph", uid: 3 });
  });

  it("keeps uid 0, which is a real neuron, not an absent one", () => {
    // The guard is `!= null`, not truthiness -- uid 0 is the first neuron.
    expect(subnetPositionSearch(0)).toEqual({ tab: "metagraph", uid: 0 });
  });

  it("falls back to the bare subnet link when the row has no uid", () => {
    // accounts.$ss58.tsx renders "—" for a null uid; the link must stay as it
    // was rather than deep-linking to a neuron that isn't there.
    expect(subnetPositionSearch(null)).toBeUndefined();
    expect(subnetPositionSearch(undefined)).toBeUndefined();
  });

  it("targets the metagraph tab, the one that renders the neuron card", () => {
    expect(subnetPositionSearch(7)?.tab).toBe("metagraph");
  });

  // subnets.$netuid.tsx's validateSearch keeps `uid` only when
  // Number.isInteger(uid) && uid >= 0 -- anything this helper emits must survive
  // that, or the deep link silently degrades to the overview.
  it("emits a uid that survives the target route's validateSearch", () => {
    const validate = (uid: unknown) => {
      const n = Number(uid);
      return Number.isInteger(n) && n >= 0 ? n : undefined;
    };
    for (const uid of [0, 1, 255, 1024]) {
      const search = subnetPositionSearch(uid);
      expect(validate(search?.uid)).toBe(uid);
    }
  });
});
