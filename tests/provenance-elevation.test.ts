// Unit tests for provenance auto-elevation (Move A): a callable API that is live
// AND on the subnet's own on-chain-asserted domain is trustworthy without a human.
// computeProvenanceElevations + buildProvenanceReviewQueue are pure, so they are
// exercised here with synthetic fixtures (no network, no committed-data coupling).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  computeProvenanceElevations,
  buildProvenanceReviewQueue,
} from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const nativeSubnets = [
  { netuid: 1, chain_identity: { subnet_url: "https://acme.ai" } },
  { netuid: 2, chain_identity: { subnet_url: "https://other.io" } },
  { netuid: 3, chain_identity: {} }, // no asserted url
];

// content-type matched + live unless noted
const live = (candidate_id: string, over: Row = {}) => ({
  candidate_id,
  classification: "live",
  quality_signals: { content_type_matches_kind: true },
  ...over,
});

describe("computeProvenanceElevations", () => {
  test("elevates a live API on the subnet's on-chain-asserted domain", () => {
    const candidates = [
      {
        id: "c1",
        netuid: 1,
        kind: "subnet-api",
        url: "https://api.acme.ai/",
        source_type: "github-readme-link",
      },
      {
        id: "c2",
        netuid: 1,
        kind: "openapi",
        url: "https://api.acme.ai/openapi.json",
        source_type: "openapi-probe",
      },
    ];
    const out = computeProvenanceElevations({
      candidates,
      nativeSubnets,
      verificationResults: [live("c1"), live("c2")],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].netuid, 1);
    assert.equal(out[0].domain, "acme.ai");
    assert.deepEqual(out[0].kinds, ["openapi", "subnet-api"]);
    assert.deepEqual(out[0].source_urls, [
      "https://api.acme.ai/",
      "https://api.acme.ai/openapi.json",
    ]);
  });

  test("excludes a candidate NOT on the on-chain-asserted domain", () => {
    const out = computeProvenanceElevations({
      candidates: [
        {
          id: "c",
          netuid: 2,
          kind: "subnet-api",
          url: "https://api.elsewhere.com/",
          source_type: "github-readme-link",
        },
      ],
      nativeSubnets,
      verificationResults: [live("c")],
    });
    assert.equal(out.length, 0);
  });

  test("excludes blind common-path guesses (openapi and subnet-api)", () => {
    const out = computeProvenanceElevations({
      candidates: [
        {
          id: "o",
          netuid: 1,
          kind: "openapi",
          url: "https://acme.ai/openapi.json",
          source_type: "project-website-common-path",
        },
        {
          id: "a",
          netuid: 1,
          kind: "subnet-api",
          url: "https://acme.ai/api",
          source_type: "project-website-common-path",
        },
      ],
      nativeSubnets,
      verificationResults: [live("o"), live("a")],
    });
    assert.equal(out.length, 0);
  });

  test("excludes subnets with no on-chain asserted url", () => {
    const out = computeProvenanceElevations({
      candidates: [
        {
          id: "c",
          netuid: 3,
          kind: "subnet-api",
          url: "https://api.acme.ai/",
          source_type: "github-readme-link",
        },
      ],
      nativeSubnets,
      verificationResults: [live("c")],
    });
    assert.equal(out.length, 0);
  });

  test("excludes dead / content-mismatch / unverified candidates", () => {
    const candidates = [
      {
        id: "dead",
        netuid: 1,
        kind: "subnet-api",
        url: "https://api.acme.ai/a",
        source_type: "github-readme-link",
      },
      {
        id: "mismatch",
        netuid: 1,
        kind: "subnet-api",
        url: "https://api.acme.ai/b",
        source_type: "github-readme-link",
      },
      {
        id: "none",
        netuid: 1,
        kind: "subnet-api",
        url: "https://api.acme.ai/c",
        source_type: "github-readme-link",
      },
    ];
    const out = computeProvenanceElevations({
      candidates,
      nativeSubnets,
      verificationResults: [
        live("dead", { classification: "dead" }),
        live("mismatch", {
          quality_signals: { content_type_matches_kind: false },
        }),
        // "none" has no verification result at all
      ],
    });
    assert.equal(out.length, 0);
  });

  test("sorts multiple elevated netuids ascending and back-fills a missing slug from a later candidate", () => {
    // Two subnets so the sort comparator (a.netuid - b.netuid) actually runs,
    // emitted out-of-order to prove the ascending sort. For netuid 1 the first
    // candidate carries no slug and a later same-netuid candidate supplies it,
    // exercising the slug back-fill.
    const candidates = [
      {
        id: "b",
        netuid: 2,
        kind: "subnet-api",
        url: "https://api.other.io/",
        source_type: "github-readme-link",
        slug: "other",
      },
      {
        id: "a1",
        netuid: 1,
        kind: "subnet-api",
        url: "https://api.acme.ai/",
        source_type: "github-readme-link",
        // no slug on the first candidate for netuid 1
      },
      {
        id: "a2",
        netuid: 1,
        kind: "openapi",
        url: "https://api.acme.ai/openapi.json",
        source_type: "openapi-probe",
        slug: "acme", // later candidate supplies the slug
      },
    ];
    const out = computeProvenanceElevations({
      candidates,
      nativeSubnets,
      verificationResults: [live("b"), live("a1"), live("a2")],
    });
    assert.equal(out.length, 2);
    // ascending netuid order (input was 2, then 1)
    assert.deepEqual(
      out.map((e) => e.netuid),
      [1, 2],
    );
    // slug back-filled onto netuid 1 from the second candidate
    assert.equal(out[0].slug, "acme");
    assert.deepEqual(out[0].kinds, ["openapi", "subnet-api"]);
    assert.equal(out[1].slug, "other");
  });

  test("non-API kinds (docs, website, dashboard) are never elevated", () => {
    const out = computeProvenanceElevations({
      candidates: [
        {
          id: "d",
          netuid: 1,
          kind: "docs",
          url: "https://docs.acme.ai/",
          source_type: "github-readme-link",
        },
      ],
      nativeSubnets,
      verificationResults: [live("d")],
    });
    assert.equal(out.length, 0);
  });
});

describe("buildProvenanceReviewQueue", () => {
  const candidates = [
    {
      id: "c1",
      netuid: 1,
      kind: "subnet-api",
      url: "https://api.acme.ai/",
      source_type: "github-readme-link",
    },
  ];
  const verificationResults = [live("c1")];

  test("queues an elevation when the subnet is below the top trust tier", () => {
    const doc = buildProvenanceReviewQueue({
      candidates,
      nativeSubnets,
      verificationResults,
      subnets: [
        { netuid: 1, slug: "acme", curation: { level: "machine-verified" } },
      ],
    });
    const queue = doc.queue as Row[];
    assert.equal(queue.length, 1);
    assert.equal(queue[0].netuid, 1);
    assert.equal(queue[0].slug, "acme");
    assert.equal(queue[0].current_level, "machine-verified");
  });

  test("omits subnets already at maintainer-reviewed or adapter-backed", () => {
    for (const level of ["maintainer-reviewed", "adapter-backed"]) {
      const doc = buildProvenanceReviewQueue({
        candidates,
        nativeSubnets,
        verificationResults,
        subnets: [{ netuid: 1, slug: "acme", curation: { level } }],
      });
      assert.equal((doc.queue as Row[]).length, 0, level);
    }
  });
});
