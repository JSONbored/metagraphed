// #10932: the producer behind /subnets/{netuid}/cost-to-participate.
//
// The card shipped in #11041 reading a table nothing wrote. This is the lane
// that writes it: one message per registered min_compute surface, an hourly
// heartbeat tick, and a read that records WHAT it read and WHEN alongside the
// declaration itself.
//
// ## WHY THIS IS NOT A ROUTE, AND NOT IN THE PRIVATE REPO EITHER
//
// A write path must not be a public surface -- a secret-gated route still
// appears in openapi.json and a maintainer tool still appears in the served
// tool list, which advertises an action nobody else can take. A queue-backed
// lane is neither: it has no path, no tool entry, and no caller outside the
// scheduled handler.
//
// That also puts it in the SAME repo as the schema it writes against, which
// matters more than it sounds. `compute_declarations`'s CHECK constraints, the
// Zod shape, the tri-state rule and this producer are one contract; splitting
// the writer into metagraphed-infra would have meant the only thing that can
// violate them lives where none of them are tested. The three lanes already on
// this heartbeat (attribution-sweep, origin-reachability, revenue-probe) write
// Neon from here for the same reason.
//
// ## WHAT A ROW MEANS, AND WHAT NO ROW MEANS
//
// A row means we FETCHED the file and read it. A surface that 404s -- Djinn's
// does, today -- writes NOTHING: "we could not read it" is not "we read it and
// it declared nothing", and the health prober already reports that surface as
// dead (it is a `data-artifact`, so it is probed every 15 minutes). Conflating
// the two would put a `found: false` measurement behind a file nobody has ever
// seen.
//
// A row with `found: false` is the real middle state: the file was fetched at a
// commit and carried no parseable `compute_spec`.
//
// ## THE CITATION IS RESOLVED, NOT ASSUMED
//
// 14 of the 17 registered surfaces point at `main`, which moves under the
// claim. The reading resolves the commit that last touched THAT PATH rather
// than the branch head, because a branch head advances on commits that never
// went near this file -- so `read_at_sha` would change hourly and a re-read
// diff would report a declaration that moved when nothing did.
import { parse as parseYaml } from "yaml";
import {
  consumeBatch,
  enqueueAll,
  type ConsumeResult,
  type EnqueueResult,
  type LaneMessage,
  type LaneQueue,
} from "./lane-queue.ts";
import { probeJob } from "./probe-jobs.ts";

type Row = Record<string, unknown>;

/** The lane's own name, in lane_health and in LANE_PRODUCERS. */
export const COMPUTE_DECLARATIONS_LANE = "compute-declarations";

/**
 * Which registered surfaces are min_compute declarations.
 *
 * BY URL, not by id or title. The ids are hand-written and inconsistent
 * (`sn-3-templar-min-compute-spec`, `sn-16-bitads-min-compute`), and one subnet
 * spells the FILE differently -- SN81 registers `compute.min.yaml`. Matching the
 * filename catches all 17 and cannot be broken by someone renaming a surface.
 */
export const MIN_COMPUTE_FILENAME =
  /\/(?:min[_-]compute|compute\.min)\.ya?ml$/i;

/** A response larger than this is not a compute spec. The largest registered
 * file is under 8 KB; the cap exists so a repo serving something else entirely
 * cannot make one message expensive. */
export const COMPUTE_SPEC_MAX_BYTES = 256 * 1024;

/** Aliases are how a small YAML file becomes a large object. `yaml` defaults to
 * 100, which is already a guard; naming it here says the limit is deliberate
 * for input we do not control. */
export const COMPUTE_SPEC_MAX_ALIASES = 100;

export interface ComputeDeclarationMessage {
  netuid: number;
  source_url: string;
}

/** A registry surface, as much of one as this lane reads. */
export interface SurfaceRef {
  netuid?: unknown;
  url?: unknown;
  kind?: unknown;
  public_safe?: unknown;
}

/**
 * Every min_compute surface worth reading.
 *
 * `public_safe` is required for the same reason the link lane requires it: a
 * surface marked otherwise is not one we fetch on a schedule.
 */
export function minComputeSurfaces(
  surfaces: readonly SurfaceRef[] | null | undefined,
): ComputeDeclarationMessage[] {
  const out: ComputeDeclarationMessage[] = [];
  for (const surface of surfaces ?? []) {
    const url = surface?.url;
    const netuid = Number(surface?.netuid);
    if (typeof url !== "string" || !MIN_COMPUTE_FILENAME.test(url)) continue;
    if (surface?.public_safe !== true) continue;
    if (!Number.isInteger(netuid) || netuid < 0) continue;
    out.push({ netuid, source_url: url });
  }
  // Deterministic order so a partial send is a prefix rather than a lottery.
  //
  // Code-unit comparison, NOT localeCompare: this is a machine ordering, and a
  // locale-aware one is a function of the runtime's ICU data -- which differs
  // between the test runtime and workerd, and would make "which surfaces
  // survive a partial send" depend on where the code ran.
  return out.sort(
    (a, b) =>
      a.netuid - b.netuid ||
      (a.source_url < b.source_url ? -1 : a.source_url > b.source_url ? 1 : 0),
  );
}

export async function enqueueComputeDeclarations(
  queue: LaneQueue<ComputeDeclarationMessage> | null | undefined,
  messages: ComputeDeclarationMessage[],
): Promise<EnqueueResult> {
  return enqueueAll(
    queue,
    messages.map((message) => probeJob("compute-declaration", { ...message })),
    "no_min_compute_surfaces",
  );
}

/** A raw.githubusercontent.com URL, split into what the commits API needs. */
export interface RawGithubRef {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

const SHA_REF = /^[0-9a-f]{40}$/i;

/**
 * Parse `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path...}`.
 *
 * Returns null for any other host. Every registered min_compute surface is on
 * raw.githubusercontent today, and a non-GitHub one would need its own way to
 * name the version it was read at -- so it is skipped rather than read without
 * a citation, which is the one thing a reading may not be.
 */
export function rawGithubRef(url: string): RawGithubRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "raw.githubusercontent.com")
    return null;
  const [owner, repo, ref, ...rest] = parsed.pathname
    .split("/")
    .filter(Boolean);
  if (!owner || !repo || !ref || rest.length === 0) return null;
  return { owner, repo, ref, path: rest.join("/") };
}

export interface ComputeReadDeps {
  fetchImpl?: typeof fetch;
  /** Authorization header for api.github.com, when a token is configured.
   * Without one the API allows 60 requests an hour, which still covers this
   * lane's 17 surfaces; with one it is 5,000. */
  githubAuth?: string | null;
  now?: () => number;
}

/**
 * The commit this file's content came from.
 *
 * NOT the branch head. `GET /commits?path=…` answers the last commit that
 * touched THIS PATH, so the citation changes when the declaration changes and
 * not when the repo does — which is what makes a re-read's diff mean something.
 * A ref that is already a 40-hex sha is its own answer and costs no request.
 */
export async function resolveReadSha(
  ref: RawGithubRef,
  deps: ComputeReadDeps = {},
): Promise<string | null> {
  if (SHA_REF.test(ref.ref)) return ref.ref;
  const doFetch = deps.fetchImpl ?? fetch;
  const url =
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits` +
    `?path=${encodeURIComponent(ref.path)}&sha=${encodeURIComponent(ref.ref)}&per_page=1`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "metagraphed-compute-declarations",
  };
  if (deps.githubAuth) headers.authorization = deps.githubAuth;
  const res = await doFetch(url, { headers });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  const sha = Array.isArray(body) ? (body[0] as Row | undefined)?.sha : null;
  return typeof sha === "string" && sha.length >= 7 ? sha : null;
}

export interface ParsedComputeSpec {
  spec_version: string | null;
  miner: Row | null;
  validator: Row | null;
}

/**
 * The two stanzas, RAW.
 *
 * Nothing here normalises, converts or coerces: the tri-state rule and every
 * unit live in src/cost-to-participate.ts and run at SERVING time, so improving
 * the interpretation never means re-fetching 17 files. This only has to answer
 * "did this document contain a compute_spec, and what were its two roles".
 *
 * Returns null when the document is not a mapping at all -- an empty file, a
 * list, HTML from a redirect. `{miner: null, validator: null}` is different and
 * real: a compute_spec that declares neither role.
 */
export function parseComputeSpec(text: string): ParsedComputeSpec | null {
  let doc: unknown;
  try {
    doc = parseYaml(text, { maxAliasCount: COMPUTE_SPEC_MAX_ALIASES });
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    return null;
  const root = doc as Row;
  const spec = root.compute_spec;
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return null;
  }
  const object = (value: unknown): Row | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Row)
      : null;
  const version = root.version;
  return {
    // A YAML `version: 0.3.6` is a number, and `version: '0.3.6'` a string.
    // Both are the file's own answer; the column is TEXT so both survive.
    spec_version:
      typeof version === "string" || typeof version === "number"
        ? String(version)
        : null,
    miner: object((spec as Row).miner),
    validator: object((spec as Row).validator),
  };
}

export interface ComputeDeclarationRecord {
  netuid: number;
  source_url: string;
  read_at_sha: string;
  observed_at: number;
  found: boolean;
  spec_version: string | null;
  miner: Row | null;
  validator: Row | null;
}

/**
 * Read one surface into a row, or answer null.
 *
 * NULL IS NOT A FAILURE TO REPORT UP -- it is "nothing may be written for this
 * surface", and the caller acks. Three ways to get there, and none of them is a
 * measurement:
 *
 *   - the URL is not a raw.githubusercontent path, so a reading could not name
 *     the version it was taken at;
 *   - the fetch did not serve the document (404, 5xx, oversized). The health
 *     prober owns dead surfaces and already reports Djinn's as `dead`;
 *   - the commit could not be resolved, so there is no citation.
 *
 * A reading without a citation is not a reading, and a `found: false` written
 * for a file nobody could open would be a claim about a subnet we never read.
 */
export async function readComputeDeclaration(
  message: ComputeDeclarationMessage,
  deps: ComputeReadDeps = {},
): Promise<ComputeDeclarationRecord | null> {
  const ref = rawGithubRef(message.source_url);
  if (!ref) return null;
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(message.source_url, {
    headers: { "user-agent": "metagraphed-compute-declarations" },
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length > COMPUTE_SPEC_MAX_BYTES) return null;
  const sha = await resolveReadSha(ref, deps);
  if (!sha) return null;
  const parsed = parseComputeSpec(text);
  return {
    netuid: message.netuid,
    source_url: message.source_url,
    read_at_sha: sha,
    observed_at: (deps.now ?? Date.now)(),
    // FOUND IS ABOUT THE DOCUMENT, not about the hardware. A file that parses
    // with a compute_spec declaring neither role is still a document we read.
    found: parsed !== null,
    spec_version: parsed?.spec_version ?? null,
    miner: parsed?.miner ?? null,
    validator: parsed?.validator ?? null,
  };
}

export interface ComputeStoreDb {
  run?: (sql: string, params: unknown[]) => Promise<unknown>;
  prepare?: (sql: string) => {
    bind: (...params: unknown[]) => { run: () => Promise<unknown> };
  };
}

/**
 * Upsert one reading.
 *
 * `first_seen` is preserved by the conflict clause rather than recomputed, so
 * "we have been watching this since" survives a file that moves weekly. The
 * CHECK constraints do the rest of the arguing: a `found: false` row carrying a
 * stanza, or a `found: true` row carrying none, is refused by the database
 * whatever this function believes.
 */
export async function persistComputeDeclaration(
  db: ComputeStoreDb | null | undefined,
  record: ComputeDeclarationRecord,
): Promise<{ ok: boolean }> {
  if (!db?.run) return { ok: false };
  // A found:false row must carry no stanza, which the constraint enforces and
  // this makes true at the source rather than relying on the write to bounce.
  const miner = record.found ? record.miner : null;
  const validator = record.found ? record.validator : null;
  await db.run(
    `INSERT INTO compute_declarations
       (netuid, source_url, read_at_sha, observed_at, first_seen, found,
        spec_version, miner, validator)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (netuid, source_url) DO UPDATE SET
       read_at_sha = EXCLUDED.read_at_sha,
       observed_at = EXCLUDED.observed_at,
       found = EXCLUDED.found,
       spec_version = EXCLUDED.spec_version,
       miner = EXCLUDED.miner,
       validator = EXCLUDED.validator`,
    [
      record.netuid,
      record.source_url,
      record.read_at_sha,
      record.observed_at,
      record.observed_at,
      record.found,
      record.spec_version,
      miner === null ? null : JSON.stringify(miner),
      validator === null ? null : JSON.stringify(validator),
    ],
  );
  return { ok: true };
}

/**
 * Consume a batch of surfaces.
 *
 * A surface that yields no row is ACKED, not retried: none of the three reasons
 * changes on redelivery within a batch's budget, and retrying a 404 spends the
 * whole budget to reach the dead letter with a message nobody can act on.
 */
export async function handleComputeDeclarationBatch(
  messages: LaneMessage[],
  db: ComputeStoreDb | null | undefined,
  deps: ComputeReadDeps = {},
): Promise<ConsumeResult> {
  return consumeBatch(messages, {
    parse: (body) => {
      const message = body as ComputeDeclarationMessage | null;
      const netuid = Number(message?.netuid);
      const url = message?.source_url;
      return Number.isInteger(netuid) && typeof url === "string" && url
        ? { netuid, source_url: url }
        : null;
    },
    run: async (message) => {
      const record = await readComputeDeclaration(message, deps);
      // Nothing to write is a completed subject, not a failed one.
      if (!record) return true;
      return (await persistComputeDeclaration(db, record)).ok;
    },
  });
}
