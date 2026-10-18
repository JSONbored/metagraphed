import { subnetsQuery } from "./queries";
import { SUBNETS_ALL_LIMIT } from "./subnet-list-limit";

// Every field the directory actually reads. The unprojected registry row now
// carries dozens of enrichment fields and made this SSR document cross its
// 430 KiB payload ratchet as that data grew, even though none was displayed.
const SUBNET_DIRECTORY_FIELDS = [
  "netuid",
  "slug",
  "name",
  "native_name",
  "subnet_type",
  "surface_count",
  "status",
  "logo_url",
  "website_url",
  "source_repo",
  "updated_at",
  "integration_readiness",
  "curation_level",
].join(",");

/** The route loader and directory render must prime/read the same projected cache entry. */
export const subnetDirectoryQuery = () =>
  subnetsQuery({ limit: SUBNETS_ALL_LIMIT, fields: SUBNET_DIRECTORY_FIELDS });
