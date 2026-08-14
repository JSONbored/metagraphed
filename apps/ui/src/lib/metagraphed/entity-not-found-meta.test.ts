import { describe, expect, it } from "vitest";

import { ApiError } from "./client";
import { entityNotFoundMeta, isMissingEntityError, isNotFoundMatch } from "./entity-not-found-meta";

const metaValue = (meta: ReturnType<typeof entityNotFoundMeta>["meta"], key: string) =>
  meta.find((m): m is { name: string; content: string } => "name" in m && m.name === key)?.content;

describe("entityNotFoundMeta (#6429, #8624)", () => {
  it("marks the page noindex — these URL spaces are unbounded", () => {
    const { meta } = entityNotFoundMeta("Subnet", "No such netuid.");
    expect(metaValue(meta, "robots")).toBe("noindex");
  });

  it("never asserts the junk id is a real entity in the title", () => {
    const { meta } = entityNotFoundMeta("Subnet", "No such netuid.");
    expect(meta[0]).toEqual({ title: "Subnet not found — Metagraphed" });
  });
});

describe("isMissingEntityError (#8624) — the safety property", () => {
  it("treats a 404 from our API as 'this entity does not exist'", () => {
    expect(isMissingEntityError(new ApiError("nope", { status: 404, url: "/x" }))).toBe(true);
  });

  it("does NOT treat a server error or a rate limit as missing", () => {
    // The whole point: marking a page noindex during an outage would de-index
    // real subnets and validators. Only a definitive 404 may flip a route.
    for (const status of [500, 502, 503, 429, 401, 403]) {
      expect(isMissingEntityError(new ApiError("x", { status, url: "/x" })), String(status)).toBe(
        false,
      );
    }
  });

  it("does NOT treat a network throw or an abort as missing", () => {
    expect(isMissingEntityError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isMissingEntityError(new DOMException("Aborted", "AbortError"))).toBe(false);
    expect(isMissingEntityError(undefined)).toBe(false);
    expect(isMissingEntityError({ status: 404 })).toBe(false);
  });
});

describe("isNotFoundMatch (#11204)", () => {
  it("recognizes the match router-core marks when a not-found boundary renders", () => {
    // router-core's applyFailure sets `status: "notFound"` on the boundary match
    // and answers the SSR request 404. head() still runs for that match, so this
    // is what stops it titling the page as though the entity resolved.
    expect(isNotFoundMatch({ status: "notFound" })).toBe(true);
  });

  it("is false for every match state that DID resolve", () => {
    // The failure that matters is the false positive: treating a resolved match
    // as not-found would put `noindex` on a real subnet page.
    for (const status of ["success", "pending", "error", "redirected"]) {
      expect(isNotFoundMatch({ status }), status).toBe(false);
    }
  });

  it("is false for a malformed or absent match rather than throwing", () => {
    // head() runs in the SSR path; a throw here would take down the render.
    for (const bad of [undefined, null, "notFound", 404, {}, { status: undefined }]) {
      expect(isNotFoundMatch(bad), String(bad)).toBe(false);
    }
  });
});
