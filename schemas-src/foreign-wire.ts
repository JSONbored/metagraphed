// Responses from services this repo does NOT operate (#11194).
//
// ## The line between this file and internal-wire.ts
//
// Who wrote the bytes. `internal-wire.ts` holds the shapes our own Workers,
// Durable Objects and stores produce -- if one of those drifts, the fix is in
// this repository. Everything here comes from GitHub, PostHog and Cloudflare's
// own APIs: we cannot fix a drift, we can only notice it, and noticing is the
// entire reason these are schemas rather than casts.
//
// ## Why none of these is `.strict()`
//
// A foreign API adds fields without telling anyone, and a `.strict()` schema
// over one is a self-inflicted outage the first time it does. Zod's DEFAULT is
// exactly right here: an undeclared key is stripped, not refused. So these need
// none of the open spellings `validate-no-passthrough` bans -- an unknown field
// costs nothing and a missing one still fails.
//
// What is declared is only what a reader actually depends on, which makes this
// file the honest inventory of what this repo needs from each foreign API,
// in one place rather than spread across the readers.
import { z } from "zod";

/**
 * One issue from `GET /repos/{repo}/issues`, as the lane alarm reads it.
 *
 * `pull_request` is `unknown` and PRESENT-OR-ABSENT is the whole signal: the
 * issues endpoint returns pull requests too, and the alarm closes anything
 * whose title matches. A PR that happened to match would have been closed as
 * though it were an alarm, so this field is checked for existence and never
 * for shape -- which is exactly what `unknown` says.
 */
export const GithubIssueSchema = z.object({
  number: z.number().nullish(),
  title: z.string().nullish(),
  pull_request: z.unknown().optional(),
});
export type GithubIssue = z.infer<typeof GithubIssueSchema>;

/**
 * `GET /repos/{repo}/issues?state=open` — the list, which must be a LIST.
 *
 * `z.unknown()` elements, parsed one at a time by the reader, and the
 * asymmetry is deliberate: the same rule SubnetStatusHub's `/notify-changed`
 * follows. A body that is not an array means the request did not do what we
 * asked and no alarm state can be derived from it. One unreadable ISSUE among
 * a hundred means one issue is unreadable -- refusing the whole page there
 * would drop every open alarm and re-raise all of them, from a single row
 * GitHub decided to shape differently.
 */
export const GithubIssueListSchema = z.array(z.unknown());

/** `POST /repos/{repo}/issues` — only the created number is read. */
export const GithubCreatedIssueSchema = z.object({
  number: z.number().optional(),
});

/**
 * PostHog's `/flags` evaluation response.
 *
 * A flag's value is read as `=== true` and nothing else, so the enabled member
 * is the only thing declared. The per-flag object is optional-and-open because
 * PostHog has changed this payload's shape more than once and a flag lookup
 * that throws would take out the feature gate rather than the flag.
 */
export const PostHogFlagsResponseSchema = z.object({
  flags: z
    .record(z.string(), z.object({ enabled: z.boolean().optional() }).nullish())
    .optional(),
});

/**
 * Cloudflare Analytics Engine SQL's response body.
 *
 * `data` is the only member this repo reads, and a body without an ARRAY there
 * is already treated as a failure by the caller ("response had no data array").
 * Declaring it required here moves that check into the parse, so the two cannot
 * disagree about what a usable response is.
 *
 * Rows stay unknown-valued: the columns depend entirely on the query, and every
 * caller narrows the ones it selected.
 */
export const AnalyticsEngineSqlResponseSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
});
