/**
 * Instantiate an API_ROUTES template into a path the router will actually
 * match.
 *
 * ONE copy, shared by every test that reasons about the route table. There
 * were three, and they had drifted: the capability-matrix copy lacked the
 * numeric `{crowdloan_id}` substitution the addressing copy had, so
 * `/api/v1/crowdloans/{crowdloan_id}` instantiated to `/api/v1/crowdloans/x`,
 * matched no route, and 404'd. That reads as "the matrix is wrong about
 * crowdloans" when the matrix is right and the placeholder is wrong — a false
 * failure that costs real time to chase, and worse, a false PASS whenever the
 * bad substitution happens to land on the expected answer.
 *
 * Every placeholder must produce a value of the right SHAPE, because the
 * router's patterns are anchored and typed: a numeric id, an SS58 address and
 * a composite extrinsic ref are not interchangeable, and the catch-all "x"
 * silently matches nothing for all three.
 */
const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

export function concretePath(template: string): string {
  return (
    template
      .replace("{netuid}", "1")
      .replace("{ss58}", SS58)
      .replace("{hotkey}", SS58)
      .replace("{h160}", "0x0000000000000000000000000000000000000000")
      // A BLOCK ref: a block number. Never the "<block>-<index>" form, which
      // belongs to extrinsics and matches no blocks route.
      .replace("{ref}", "5870000")
      // An EXTRINSIC ref in its canonical composite form (the guaranteed
      // -present id; the 0x hash is best-effort/nullable).
      .replace("{hash}", "5870000-3")
      // A neuron uid is numeric, and an ISO date is a date. Both fell through
      // to the catch-all "x" below and matched nothing, for the same reason
      // {ref} and {hash} did.
      .replace(/\{uid\}/g, "0")
      // A crowdloan id is a u32 (#8696) — numeric, same reason as {uid}.
      .replace("{crowdloan_id}", "0")
      .replace("{date}", "2026-08-01")
      .replace(/\{[^}]+\}/g, "x")
  );
}

export { SS58 as CONCRETE_PATH_SS58 };
