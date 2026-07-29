import { describe, expect, it } from "vitest";
import {
  buildPushNotificationPayload,
  relativeTime,
  resolveEntityTarget,
} from "../src/web-push-payload.ts";
import { MAX_PAYLOAD_BYTES } from "../src/web-push.ts";

const NOW = 1_785_000_000_000;

describe("buildPushNotificationPayload (#8385)", () => {
  it("prefers the T5 action sentence as the title", () => {
    const out = buildPushNotificationPayload(
      { id: 9, name: "My validator" },
      {
        action_sentence: "5Grwva…GKutQY staked 12.5 TAO to SN64",
        event_kind: "StakeAdded",
        netuid: 64,
        observed_at: NOW - 90_000,
      },
      NOW,
    );
    expect(out.title).toBe("5Grwva…GKutQY staked 12.5 TAO to SN64");
    expect(out.body).toBe("SN64 · 1m ago · alert: My validator");
    expect(out.url).toBe("/subnets/64");
    expect(out.tag).toBe("mg-alert-9");
  });

  it("falls back to the event kind when no sentence is available", () => {
    const out = buildPushNotificationPayload(
      { id: 1 },
      { event_kind: "StakeAdded", netuid: 7 },
      NOW,
    );
    expect(out.title).toBe("StakeAdded");
  });

  it("falls back to the trigger name, then a generic title — never blank", () => {
    expect(
      buildPushNotificationPayload({ id: 1, name: "Big transfers" }, {}, NOW)
        .title,
    ).toBe("Big transfers");
    // Silent push is prohibited: there is no input that yields an empty title.
    const bare = buildPushNotificationPayload(null, null, NOW);
    expect(bare.title).toBe("Chain alert");
    expect(bare.body.length).toBeGreaterThan(0);
  });

  it("does not repeat the trigger name in the body when it IS the title", () => {
    const out = buildPushNotificationPayload(
      { id: 2, name: "Big transfers" },
      { netuid: 3 },
      NOW,
    );
    expect(out.title).toBe("Big transfers");
    expect(out.body).not.toContain("alert:");
  });

  it("clamps a pathological sentence rather than blowing the payload budget", () => {
    const out = buildPushNotificationPayload(
      { id: 3, name: "x".repeat(500) },
      { action_sentence: "y".repeat(1000), netuid: 1, observed_at: NOW },
      NOW,
    );
    expect(out.title.length).toBeLessThanOrEqual(120);
    expect(out.body.length).toBeLessThanOrEqual(180);
    // The whole encoded payload must still fit the transport ceiling.
    expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThan(
      MAX_PAYLOAD_BYTES,
    );
  });
});

describe("resolveEntityTarget", () => {
  it("deep-links a subnet when netuid is present", () => {
    expect(resolveEntityTarget({ netuid: 64 })).toEqual({
      label: "SN64",
      url: "/subnets/64",
    });
  });

  it("includes root (netuid 0) rather than treating it as absent", () => {
    expect(resolveEntityTarget({ netuid: 0 })).toEqual({
      label: "SN0",
      url: "/subnets/0",
    });
  });

  it("deep-links an account, preferring hotkey, with a truncated label", () => {
    const hotkey = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    expect(resolveEntityTarget({ hotkey })).toEqual({
      label: "5Grwva…GKutQY",
      url: `/accounts/${hotkey}`,
    });
  });

  it("falls back to coldkey, then block, then home — a tap never dead-ends", () => {
    expect(resolveEntityTarget({ coldkey: "5ABC" }).url).toBe("/accounts/5ABC");
    expect(resolveEntityTarget({ block_number: 8201443 }).url).toBe(
      "/blocks/8201443",
    );
    expect(resolveEntityTarget({}).url).toBe("/");
    expect(resolveEntityTarget(null).url).toBe("/");
  });
});

describe("relativeTime", () => {
  it("renders coarse buckets", () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });

  it("never renders a negative age when the poller's clock runs ahead", () => {
    expect(relativeTime(NOW + 30_000, NOW)).toBe("just now");
  });

  it("returns null for a missing or unparseable timestamp", () => {
    for (const bad of [null, undefined, 0, -1, "abc"]) {
      expect(relativeTime(bad, NOW)).toBeNull();
    }
  });
});
