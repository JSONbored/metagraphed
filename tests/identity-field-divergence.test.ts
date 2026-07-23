import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  collectDivergentIdentityFields,
  findDivergentIdentityFields,
} from "../scripts/identity-field-divergence.ts";

const providersById = new Map([
  ["compelle", { id: "compelle", kind: "subnet-team" }],
  ["nexisgen", { id: "nexisgen", kind: "subnet-team" }],
  ["tensorclaw", { id: "tensorclaw", kind: "subnet-team" }],
  ["taomarketcap", { id: "taomarketcap", kind: "data-provider" }],
]);

describe("findDivergentIdentityFields", () => {
  test("flags a top-level dashboard_url that shadows a first-party same-kind surface (#6329)", () => {
    const document = {
      dashboard_url: "https://taomarketcap.com/subnets/82",
      surfaces: [
        {
          id: "sn-82-compelle-status-dashboard",
          kind: "dashboard",
          provider: "compelle",
          url: "https://compelle.com/status",
        },
      ],
    };
    assert.deepEqual(findDivergentIdentityFields(document, providersById), [
      {
        field: "dashboard_url",
        kind: "dashboard",
        top_level_url: "https://taomarketcap.com/subnets/82",
        surface_id: "sn-82-compelle-status-dashboard",
        surface_url: "https://compelle.com/status",
      },
    ]);
  });

  test("flags a website_url www-mismatch against its first-party website surface", () => {
    const document = {
      website_url: "https://nexisgen.ai/",
      surfaces: [
        {
          id: "sn-70-nexisgen-website",
          kind: "website",
          provider: "nexisgen",
          url: "https://www.nexisgen.ai/",
        },
      ],
    };
    const finding = findDivergentIdentityFields(document, providersById);
    assert.equal(finding.length, 1);
    assert.equal(finding[0].surface_url, "https://www.nexisgen.ai/");
  });

  test("does not flag when the top-level field matches its first-party surface (post-fix)", () => {
    const document = {
      dashboard_url: "https://compelle.com/status",
      surfaces: [
        {
          id: "sn-82-compelle-status-dashboard",
          kind: "dashboard",
          provider: "compelle",
          url: "https://compelle.com/status",
        },
      ],
    };
    assert.deepEqual(findDivergentIdentityFields(document, providersById), []);
  });

  test("ignores a third-party aggregator surface; only first-party is the curated link (tensorclaw case)", () => {
    // Top-level is already the real first-party dashboard; the TaoMarketCap
    // dashboard is a deliberately-retained third-party directory entry sitting
    // first in surfaces[]. Comparing against it would be a false positive.
    const document = {
      dashboard_url: "https://www.tensorclaw.ai/dashboard",
      surfaces: [
        {
          id: "sn-92-taomarketcap-dashboard",
          kind: "dashboard",
          provider: "taomarketcap",
          url: "https://taomarketcap.com/subnets/92",
        },
        {
          id: "sn-92-tensorclaw-dashboard",
          kind: "dashboard",
          provider: "tensorclaw",
          url: "https://www.tensorclaw.ai/dashboard",
        },
      ],
    };
    assert.deepEqual(findDivergentIdentityFields(document, providersById), []);
  });

  test("does not flag an absent top-level field (it already defers to the surface)", () => {
    const document = {
      surfaces: [
        {
          id: "x",
          kind: "dashboard",
          provider: "compelle",
          url: "https://example.com/",
        },
      ],
    };
    assert.deepEqual(findDivergentIdentityFields(document, providersById), []);
  });

  test("does not flag when there is no first-party same-kind surface to diverge from", () => {
    const document = {
      dashboard_url: "https://example.com/dash",
      surfaces: [
        {
          id: "x",
          kind: "dashboard",
          provider: "taomarketcap",
          url: "https://taomarketcap.com/x",
        },
      ],
    };
    assert.deepEqual(findDivergentIdentityFields(document, providersById), []);
  });

  test("handles a document with no surfaces block", () => {
    assert.deepEqual(
      findDivergentIdentityFields(
        { dashboard_url: "https://example.com/" },
        providersById,
      ),
      [],
    );
  });
});

describe("collectDivergentIdentityFields (real registry)", () => {
  test("the #6329 files are reconciled — none still shadow their curated surface", async () => {
    const report = await collectDivergentIdentityFields();
    const fixed = new Set([
      "bitstarter-1.json",
      "compelle.json",
      "hone.json",
      "itsai.json",
      "mainframe.json",
      "mvtrx.json",
      "sparket.json",
      "nexisgen.json",
      "ninja.json",
    ]);
    const stillFlagged = report.subnets.filter((s) => fixed.has(s.file));
    assert.deepEqual(stillFlagged, []);
  });
});
