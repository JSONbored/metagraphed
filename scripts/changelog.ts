// Changelog diff — extracted from build-artifacts.ts (#1003) so both the build
// (which emits an empty placeholder) and the publish-time real diff
// (scripts/build-changelog.ts) share one implementation. Pure functions, no
// build side effects.
//
// Once subnets/coverage are R2-only there is no committed baseline at BUILD
// time, so the build calls this with null previous* and gets an EMPTY changelog
// (not an everything-added one). The publish step then recomputes it against
// the previous R2 publish and overwrites the staged copy before upload.

type Row = Record<string, unknown>;

export interface ArtifactEntry {
  path: string;
  hash: string;
  [key: string]: unknown;
}

/**
 * A subnet, as the diff identifies one. Unlike coverage, these fields are NOT
 * ceremony: `netuid` is the Map key the entire diff turns on, and `name` is
 * what a rename is detected from. See `subnetEntries` for why they are checked
 * rather than declared.
 */
export interface SubnetEntry {
  netuid: number;
  name: string;
  slug: string;
  [key: string]: unknown;
}

/**
 * The identifiable subnets in a list, dropping the rest.
 *
 * Callers hold `Record<string, unknown>` rows -- one from this build, one
 * parsed from the previous publish's JSON -- and used to assert them into
 * `SubnetEntry[]` wholesale. An entry missing `netuid` then keys
 * `previousByNetuid` under `undefined`, so every other unidentifiable entry
 * collides with it and the diff reports one arbitrary subnet renamed from and
 * to whatever those rows happened to hold.
 *
 * Dropping rather than throwing is deliberate: the previous side of this diff
 * is a document some earlier deploy wrote, and one unreadable historical row
 * should cost that row, not the publish.
 */
function subnetEntries(rows: readonly Row[]): SubnetEntry[] {
  const entries: SubnetEntry[] = [];
  for (const row of rows) {
    const { netuid, name, slug } = row;
    if (
      typeof netuid === "number" &&
      typeof name === "string" &&
      typeof slug === "string"
    ) {
      entries.push({ ...row, netuid, name, slug });
    }
  }
  return entries;
}

/** The `subnets` list out of a subnets artifact, or nothing. Extraction only --
 *  `diffSubnets` does the identifying. */
export function subnetsOf(artifact: Row | null | undefined): readonly Row[] {
  const subnets = artifact?.subnets;
  return Array.isArray(subnets) ? subnets : [];
}

/**
 * A coverage artifact, as loosely as this module actually reads one.
 *
 * This used to declare the four counts as required numbers, and every one of
 * the four call sites had to assert its way past that -- including
 * `(currentCoverage || {}) as unknown as CoverageSnapshot` in
 * build-changelog.ts, which claimed four required numbers about `{}`. Nothing
 * needed the declaration: `delta` below takes `unknown` and checks, which is
 * the right thing to do with a document a PREVIOUS publish wrote. So the
 * checking stays and the claim goes.
 */
export type CoverageSnapshot = Row;

export function buildChangelog({
  contractVersion,
  currentArtifacts,
  currentCoverage,
  currentSubnets,
  generatedAt: timestamp,
  previousArtifacts,
  previousCoverage,
  previousSubnets,
}: {
  contractVersion: unknown;
  currentArtifacts: ArtifactEntry[];
  currentCoverage: CoverageSnapshot;
  // `subnets` is REQUIRED, and that is the whole reason this compiles honestly.
  // With it optional the property is a "weak type" match, and TypeScript does
  // not check a source index signature against an optional target property --
  // so a bare `Record<string, unknown>` read straight from JSON satisfied this
  // parameter with no cast and no complaint, and `subnets` was trusted as
  // SubnetEntry[] the whole way down. Callers go through `subnetEntriesOf`.
  currentSubnets: { subnets: readonly Row[] };
  generatedAt: unknown;
  previousArtifacts?: ArtifactEntry[] | null;
  previousCoverage?: CoverageSnapshot | null;
  previousSubnets?: { subnets: readonly Row[] } | null;
}): Row {
  const previousArtifactList = previousArtifacts || [];
  const previousMap = new Map(
    previousArtifactList.map((artifact) => [artifact.path, artifact]),
  );
  const currentMap = new Map(
    currentArtifacts.map((artifact) => [artifact.path, artifact]),
  );
  const addedArtifacts = currentArtifacts.filter(
    (artifact) => !previousMap.has(artifact.path),
  );
  const removedArtifacts = previousArtifactList.filter(
    (artifact) => !currentMap.has(artifact.path),
  );
  const modifiedArtifacts = currentArtifacts.filter((artifact) => {
    const previous = previousMap.get(artifact.path);
    return previous && previous.hash !== artifact.hash;
  });

  // A null subnet baseline means "no previous publish to diff against" (the
  // build, pre-publish) → empty, NOT everything-added.
  const subnetChanges = previousSubnets
    ? diffSubnets(previousSubnets.subnets, currentSubnets.subnets)
    : { added: [], removed: [], renamed: [] };
  const coverageDelta = previousCoverage
    ? {
        candidate_count: delta(
          previousCoverage.candidate_count,
          currentCoverage.candidate_count,
        ),
        curated_overlay_count: delta(
          previousCoverage.curated_overlay_count,
          currentCoverage.curated_overlay_count,
        ),
        native_only_count: delta(
          previousCoverage.native_only_count,
          currentCoverage.native_only_count,
        ),
        provider_count: null,
        surface_count: delta(
          previousCoverage.surface_count,
          currentCoverage.surface_count,
        ),
      }
    : null;

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: timestamp,
    source: "generated-artifact-diff",
    notes: [
      "This changelog compares the latest published artifacts against the previous R2 publish.",
      "It is computed at publish time and stored in R2 (ADR-0006); local/CI builds emit an empty placeholder.",
    ],
    summary: {
      artifact_added_count: addedArtifacts.length,
      artifact_modified_count: modifiedArtifacts.length,
      artifact_removed_count: removedArtifacts.length,
      netuid_added_count: subnetChanges.added.length,
      netuid_removed_count: subnetChanges.removed.length,
      netuid_renamed_count: subnetChanges.renamed.length,
      coverage_delta: coverageDelta,
    },
    artifacts: {
      added: addedArtifacts.slice(0, 250),
      modified: modifiedArtifacts.slice(0, 250),
      removed: removedArtifacts.slice(0, 250),
    },
    subnets: subnetChanges,
  };
}

export function diffSubnets(
  previousRows: readonly Row[],
  currentRows: readonly Row[],
): { added: Row[]; removed: Row[]; renamed: Row[] } {
  // Identified here rather than by the caller, so there is no version of this
  // that skips the check. The parameters are deliberately `Row[]`: both sides
  // are read from JSON some publish wrote, and a signature promising
  // SubnetEntry[] only moved the assertion up one frame -- which is exactly
  // where it used to live.
  const previousSubnets = subnetEntries(previousRows);
  const currentSubnets = subnetEntries(currentRows);
  const previousByNetuid = new Map(
    previousSubnets.map((subnet) => [subnet.netuid, subnet]),
  );
  const currentByNetuid = new Map(
    currentSubnets.map((subnet) => [subnet.netuid, subnet]),
  );
  const added = currentSubnets
    .filter((subnet) => !previousByNetuid.has(subnet.netuid))
    .map((subnet) => ({
      netuid: subnet.netuid,
      name: subnet.name,
      slug: subnet.slug,
    }));
  const removed = previousSubnets
    .filter((subnet) => !currentByNetuid.has(subnet.netuid))
    .map((subnet) => ({
      netuid: subnet.netuid,
      name: subnet.name,
      slug: subnet.slug,
    }));
  const renamed = currentSubnets
    .filter(
      (subnet) =>
        previousByNetuid.has(subnet.netuid) &&
        previousByNetuid.get(subnet.netuid)?.name !== subnet.name,
    )
    .map((subnet) => ({
      netuid: subnet.netuid,
      before: previousByNetuid.get(subnet.netuid)?.name,
      after: subnet.name,
    }));

  return { added, removed, renamed };
}

function delta(
  before: unknown,
  after: unknown,
): { before: number; after: number; delta: number } | null {
  // `typeof` first so the narrowing is real. Number.isFinite does not widen a
  // guard into a type, which is why the three assertions below it existed --
  // and it accepts only actual numbers, so this rejects exactly what it did.
  if (typeof before !== "number" || typeof after !== "number") return null;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return { before, after, delta: after - before };
}
