import { describe, expect, it } from "vitest";
import { subnetPositionDestination } from "@/lib/metagraphed/subnet-position-link";

// #6431: AccountFootprintSection and SubnetPerformanceTable each render one row
// per subnet membership and linked SN{netuid} to the bare subnet page, while the
// row's own uid sat unlinked in the next cell -- even though subnets.$netuid.tsx
// already reads `tab`/`uid` to render that neuron's detail card. Both rows now
// build their complete route destination through this one helper, so their
// selected-record state and focus anchor cannot drift apart again.
describe("subnetPositionDestination (#6431)", () => {
  it("deep-links to the row's neuron card when a uid is present", () => {
    expect(subnetPositionDestination(3)).toEqual({
      search: { tab: "records", uid: 3 },
      hash: "neuron",
    });
  });

  it("keeps uid 0, which is a real neuron, not an absent one", () => {
    // The guard is `!= null`, not truthiness -- uid 0 is the first neuron.
    expect(subnetPositionDestination(0)).toEqual({
      search: { tab: "records", uid: 0 },
      hash: "neuron",
    });
  });

  it("falls back to the bare subnet link when the row has no uid", () => {
    // accounts.$ss58.tsx renders "—" for a null uid; the link must stay as it
    // was rather than deep-linking to a neuron that isn't there.
    expect(subnetPositionDestination(null)).toBeUndefined();
    expect(subnetPositionDestination(undefined)).toBeUndefined();
  });

  it("targets the metagraph tab, the one that renders the neuron card", () => {
    expect(subnetPositionDestination(7)?.search.tab).toBe("records");
    expect(subnetPositionDestination(7)?.hash).toBe("neuron");
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
      const destination = subnetPositionDestination(uid);
      expect(validate(destination?.search.uid)).toBe(uid);
    }
  });
});
