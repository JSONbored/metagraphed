// One implementation of "turn a request path into a BOUNDED label", shared by
// every telemetry surface that labels by path.
//
// Why it is shared rather than local to workers/api.ts (#9001): the same
// pathname reaches three different label sinks, and only one of them was
// masking. workers/data-api.ts named its trace span with the raw pathname and
// passed the raw pathname to captureDataApiError, so error tracking in
// production was producing a SEPARATE fingerprint per block height:
//
//   /api/v1/blocks/8675340:Error   1
//   /api/v1/blocks/8673156:Error   1
//   /api/v1/blocks/8648718:Error   1
//   ...
//
// which is exactly the "one issue per occurrence" pathology that hides the
// pattern the fingerprint exists to reveal. A label sink with unbounded
// cardinality is not merely expensive; it is unreadable.
//
// A masked segment keeps the SHAPE of the route, which is the part that
// carries meaning: `/api/v1/blocks/:n` groups every failing block read
// together, which is the question anyone actually asks.

/**
 * Replace identifier-looking path segments with a stable placeholder.
 *
 * The patterns are deliberately narrow -- a segment is masked only when it can
 * be recognised as an identifier by shape alone, never by position -- because a
 * false positive silently merges two genuinely different routes into one label,
 * which is harder to notice than an unmasked one.
 */
export function maskRouteParams(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (/^\d+$/.test(segment)) return ":n";
      if (/^0x[0-9a-fA-F]{6,}$/.test(segment)) return ":hash";
      // #9001: UUIDs are neither digits, nor 0x-prefixed, nor base58, so they
      // were emitted verbatim -- unbounded label cardinality that grows with
      // the number of users, on /api/v1/webhooks/subscriptions/{uuid} and
      // /api/v1/alerts/triggers/{uuid}. Both are per-caller identifiers.
      if (
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
          segment,
        )
      )
        return ":uuid";
      // Checked last: base58 excludes 0, O, I and l, so this cannot match a hex
      // hash or a UUID, but it is the loosest of the four and should not get
      // first refusal on anything.
      if (/^[1-9A-HJ-NP-Za-km-z]{47,48}$/.test(segment)) return ":ss58";
      return segment;
    })
    .join("/");
}
