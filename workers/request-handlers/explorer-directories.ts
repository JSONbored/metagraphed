// Canonical website projections share the same handlers at both entry points.
import { envelopeResponse, publishedAt } from "../responses.ts";
import { tryDataApiTier } from "../data-api-tier.ts";
import { NO_ALPHA_PRICES } from "../../src/metagraph-neurons.ts";
import { buildAccountHolderDirectory } from "../../src/account-holder-directory.ts";
import { buildValidatorOperatorDirectory } from "../../src/validator-operator-directory.ts";
import {
  readCurrentAccountDirectory,
  readCurrentValidatorDirectory,
} from "../../src/explorer-directory-current.ts";
import { metagraphMeta } from "../responses.ts";
export async function handleValidatorOperatorDirectory(
  request: Request,
  env: Env,
) {
  const publishedAtPromise = publishedAt(env);
  const materialized =
    env.METAGRAPH_NEURONS_SOURCE === "data-api"
      ? await readCurrentValidatorDirectory(env.METAGRAPH_CONTROL)
      : null;
  const data =
    materialized ??
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildValidatorOperatorDirectory> | null) ??
    buildValidatorOperatorDirectory(null);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/validators/operators.json",
        data.captured_at,
        publishedAtPromise,
      ),
    },
    "short",
  );
}

export async function handleAccountHolderDirectory(request: Request, env: Env) {
  const publishedAtPromise = publishedAt(env);
  const materialized =
    env.METAGRAPH_NEURONS_SOURCE === "data-api"
      ? await readCurrentAccountDirectory(env.METAGRAPH_CONTROL)
      : null;
  const data =
    materialized ??
    ((await tryDataApiTier(
      env,
      request,
      "METAGRAPH_NEURONS_SOURCE",
    )) as ReturnType<typeof buildAccountHolderDirectory> | null) ??
    buildAccountHolderDirectory([], { priceByNetuid: NO_ALPHA_PRICES });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        "/metagraph/accounts/directory.json",
        data.captured_at,
        publishedAtPromise,
      ),
    },
    "short",
  );
}
