// Changelog diff — extracted from build-artifacts.mjs (#1003) so both the build
// (which emits an empty placeholder) and the publish-time real diff
// (scripts/build-changelog.mjs) share one implementation. Pure functions, no
// build side effects.
//
// Once subnets/coverage are R2-only there is no committed baseline at BUILD
// time, so the build calls this with null previous* and gets an EMPTY changelog
// (not an everything-added one). The publish step then recomputes it against
// the previous R2 publish and overwrites the staged copy before upload.

export function buildChangelog({
  contractVersion,
  currentArtifacts,
  currentCoverage,
  currentSubnets,
  generatedAt: timestamp,
  previousArtifacts,
  previousCoverage,
  previousSubnets,
}) {
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
    ? diffSubnets(previousSubnets.subnets || [], currentSubnets.subnets || [])
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

export function diffSubnets(previousSubnets, currentSubnets) {
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
        previousByNetuid.get(subnet.netuid).name !== subnet.name,
    )
    .map((subnet) => ({
      netuid: subnet.netuid,
      before: previousByNetuid.get(subnet.netuid).name,
      after: subnet.name,
    }));

  return { added, removed, renamed };
}

function delta(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return null;
  }
  return {
    before,
    after,
    delta: after - before,
  };
}
