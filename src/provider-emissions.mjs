// #6644: per-provider emission leaderboard — a cross-source rollup that sums,
// for each provider, the current network-emission of every subnet it backs.
//
// Two already-existing artifacts are joined, no new ingestion (the issue's
// explicit non-goal): the providers registry (`providers.json`, each provider
// carrying the `netuids` it backs) and the economics snapshot (`economics.json`,
// each subnet carrying `emission_share` — its fraction 0..1 of total network
// emission — and `emission_tao`, the absolute rate when present). "Owner" is not
// separately modeled as a clean provider→subnet tie (subnet ownership is an
// on-chain `owner_coldkey`, not a provider id), so this aggregates over the
// registry's existing provider→subnets "backs" association, which is the clean
// 1:many link that already exists.
//
// This is the CURRENT emission snapshot aggregated per provider, not a
// cumulative-historical total — no per-subnet lifetime-emission series exists to
// sum, and building one would be new ingestion (out of scope). Fields are named
// for what they are (`emission_share` / `emission_tao`), not "lifetime".

function toFiniteNumber(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// Emission fractions are small (sum of 0..1 shares); keep 9 decimals like the
// other tao/share rollups (account-portfolio) so a provider's share doesn't lose
// precision when many small subnet shares are summed.
function round9(value) {
  return Math.round(value * 1e9) / 1e9;
}

/**
 * Build the ranked per-provider emission leaderboard from the providers and
 * economics artifacts.
 *
 * @param providersArtifact `{ providers: [{ id, name, kind, authority, netuids }] }`
 * @param economicsArtifact `{ subnets: [{ netuid, emission_share, emission_tao }] }`
 * @returns rows sorted by aggregate `emission_share` descending, each stamped
 *   with a 1-based `rank`. A provider whose backed subnets carry no emission data
 *   sorts last with `emission_share: 0` (still listed — absence of emission is a
 *   real, informative state, not a reason to drop the provider).
 */
export function buildProviderEmissionsLeaderboard(
  providersArtifact,
  economicsArtifact,
) {
  const emissionByNetuid = new Map();
  for (const subnet of economicsArtifact?.subnets ?? []) {
    const netuid = toFiniteNumber(subnet?.netuid);
    if (netuid != null) emissionByNetuid.set(netuid, subnet);
  }

  const rows = (providersArtifact?.providers ?? []).map((provider) => {
    const netuids = Array.isArray(provider?.netuids) ? provider.netuids : [];
    let shareSum = 0;
    let taoSum = 0;
    let taoContributors = 0;
    let matched = 0;
    for (const raw of netuids) {
      const netuid = toFiniteNumber(raw);
      if (netuid == null) continue;
      const subnet = emissionByNetuid.get(netuid);
      if (!subnet) continue;
      matched += 1;
      const share = toFiniteNumber(subnet.emission_share);
      if (share != null) shareSum += share;
      const tao = toFiniteNumber(subnet.emission_tao);
      if (tao != null) {
        taoSum += tao;
        taoContributors += 1;
      }
    }
    return {
      id: provider?.id ?? null,
      name: provider?.name ?? null,
      kind: provider?.kind ?? null,
      authority: provider?.authority ?? null,
      subnet_count: netuids.length,
      // How many of the provider's subnets actually resolved to an economics
      // row — lets a consumer tell "0 emission" from "no data for these subnets".
      emission_subnet_count: matched,
      emission_share: round9(shareSum),
      // null (not 0) when none of the matched subnets reported an absolute rate,
      // so a genuine 0 is distinguishable from "tao not published".
      emission_tao: taoContributors > 0 ? round9(taoSum) : null,
      netuids,
    };
  });

  rows.sort(
    (a, b) =>
      b.emission_share - a.emission_share ||
      (b.emission_tao ?? 0) - (a.emission_tao ?? 0) ||
      String(a.name ?? a.id ?? "").localeCompare(String(b.name ?? b.id ?? "")),
  );

  return rows.map((row, index) => ({ rank: index + 1, ...row }));
}
