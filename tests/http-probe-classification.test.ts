import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifyHttpProbe,
  isContentMismatch,
} from "../scripts/http-probe-classification.ts";

type ProbeArg = Parameters<typeof isContentMismatch>[0];

describe("isContentMismatch", () => {
  test("never a mismatch without a candidate or on a non-ok probe", () => {
    // No candidate to compare against.
    assert.equal(
      isContentMismatch(
        { ok: true, content_type: "text/html" } as ProbeArg,
        null,
      ),
      false,
    );
    // A non-ok probe carries no trustworthy content-type to judge.
    assert.equal(
      isContentMismatch({ ok: false, content_type: "text/html" } as ProbeArg, {
        kind: "openapi",
      }),
      false,
    );
  });

  test("openapi candidates require a JSON content-type", () => {
    const openapi = { kind: "openapi" };
    for (const ct of ["application/json", "application/openapi+json", "JSON"]) {
      assert.equal(
        isContentMismatch({ ok: true, content_type: ct } as ProbeArg, openapi),
        false,
        ct,
      );
    }
    for (const ct of ["text/html", "text/plain", "", undefined]) {
      assert.equal(
        isContentMismatch({ ok: true, content_type: ct } as ProbeArg, openapi),
        true,
        String(ct),
      );
    }
  });

  test("subnet-api candidates accept any machine-readable content-type", () => {
    const api = { kind: "subnet-api" };
    for (const ct of [
      "application/json",
      "text/plain; charset=utf-8",
      "text/event-stream",
      "application/octet-stream",
    ]) {
      assert.equal(
        isContentMismatch({ ok: true, content_type: ct } as ProbeArg, api),
        false,
        ct,
      );
    }
    for (const ct of ["text/html", "image/png", ""]) {
      assert.equal(
        isContentMismatch({ ok: true, content_type: ct } as ProbeArg, api),
        true,
        ct,
      );
    }
  });

  test("sse candidates require an event-stream content-type", () => {
    const sse = { kind: "sse" };
    assert.equal(
      isContentMismatch(
        { ok: true, content_type: "text/event-stream" } as ProbeArg,
        sse,
      ),
      false,
    );
    assert.equal(
      isContentMismatch(
        { ok: true, content_type: "application/json" } as ProbeArg,
        sse,
      ),
      true,
    );
  });

  test("unscoped kinds (website, docs, …) are never a content mismatch", () => {
    for (const kind of ["website", "docs", "source-repo", "dashboard"]) {
      assert.equal(
        isContentMismatch({ ok: true, content_type: "text/html" } as ProbeArg, {
          kind,
        }),
        false,
        kind,
      );
    }
  });
});

describe("classifyHttpProbe routes content mismatch", () => {
  test("a live openapi surface serving HTML is content-mismatch, not live", () => {
    assert.equal(
      classifyHttpProbe(
        { ok: true, status_code: 200, content_type: "text/html" },
        { kind: "openapi" },
      ),
      "content-mismatch",
    );
    assert.equal(
      classifyHttpProbe(
        { ok: true, status_code: 200, content_type: "application/json" },
        { kind: "openapi" },
      ),
      "live",
    );
  });
});
