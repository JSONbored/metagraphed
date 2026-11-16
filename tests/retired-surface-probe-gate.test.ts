// The retirement gate (infra#873, recorded 2026-11-16): a surface whose dated
// availability note marks it retired or dead MUST carry probe.enabled:false,
// because `call_subnet_surface` refuses a surface on exactly that flag and
// nothing else. The gap this closes was found by custody on #13207's review:
// a p3a route-gone surface with no probe block at all stayed tool-callable
// with only its note marking the retirement (sn-58-handshake58-validator-
// registry-api). The 2026-11-16 backfill added the missing blocks; this test
// is the checks-as-code half -- any future registry batch that lands a
// retirement note without the disabling block fails here, not in review.
//
// The note classes below are the exact strings the infra#873 sweeps wrote
// (p2 dns-gone, p3a/p3b route-gone 404, provider-confirmed 410, custody's
// host-unavailable corrections). A NEW retirement class must be added here in
// the same change that first writes it -- this list refusing an unknown class
// is deliberate: prose-only retirement is the defect, not an option.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

const SUBNETS_DIR = "registry/subnets";

/** One pattern per sweep-written retirement class; matching any marks the
 * surface retired/dead for the gate. Relaxations (expect json->any, auth
 * flips) are deliberately NOT here -- they change expectations, not life. */
export const RETIREMENT_NOTE_CLASSES: readonly RegExp[] = [
  /retired from the callable set/, // p2 dns-gone, p3 410s
  /retired pending redeploy evidence/, // custody host-unavailable corrections
  /provider-confirmed gone/, // 410s
  /declared route answers 404 on an alive host/, // p3a/p3b route-gone
];

/** Deliberately-internal exceptions, reviewed one by one. Empty today: every
 * retired surface carries its disabled probe block after the backfill. */
const ALLOWLIST: ReadonlySet<string> = new Set();

type Row = Record<string, unknown>;

function* surfaces(node: unknown): Generator<Row> {
  if (Array.isArray(node)) {
    for (const value of node) yield* surfaces(value);
  } else if (node && typeof node === "object") {
    const row = node as Row;
    if (typeof row.id === "string" && typeof row.url === "string") yield row;
    for (const value of Object.values(row)) yield* surfaces(value);
  }
}

test("every surface a dated note marks retired/dead carries probe.enabled:false", () => {
  const violations: string[] = [];
  let retired = 0;
  for (const file of readdirSync(SUBNETS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data: unknown = JSON.parse(
      readFileSync(join(SUBNETS_DIR, file), "utf8"),
    );
    for (const surface of surfaces(data)) {
      const notes = surface.notes;
      if (typeof notes !== "string") continue;
      if (!RETIREMENT_NOTE_CLASSES.some((rule) => rule.test(notes))) continue;
      retired++;
      if (ALLOWLIST.has(surface.id as string)) continue;
      const probe = surface.probe as Row | undefined;
      if (!probe || probe.enabled !== false) {
        violations.push(`${file}: ${surface.id as string}`);
      }
    }
  }
  // The gate is only meaningful while the predicate actually matches the
  // sweep's notes; a rewrite of the note grammar that silently matched
  // nothing would make this test pass on an ungated registry.
  assert.ok(
    retired >= 600,
    `retirement-note predicate matched only ${retired} surfaces -- the note grammar changed; update RETIREMENT_NOTE_CLASSES in the same change`,
  );
  assert.deepEqual(
    violations,
    [],
    `retired surfaces missing probe.enabled:false (add the disabled probe block at retirement):\n${violations.join("\n")}`,
  );
});
