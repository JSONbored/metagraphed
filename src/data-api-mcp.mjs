// MCP helpers for the Postgres-backed all-events tier (ADR 0013), reached through
// the DATA_API service binding — the same path REST proxy routes use. Keeps the
// postgres.js driver out of the main Worker bundle.

function throwToolError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  throw error;
}

export async function dataApiFetchJson(ctx, pathAndQuery) {
  if (ctx.env?.DATA_RATE_LIMITER?.limit) {
    const { success } = await ctx.env.DATA_RATE_LIMITER.limit({
      key: `data:${ctx.clientIp}`,
    });
    if (!success) {
      throwToolError(
        "data_rate_limited",
        "Too many data API requests from this client; slow down.",
      );
    }
  }

  const dataApi = ctx.env?.DATA_API;
  if (!dataApi?.fetch) {
    throwToolError(
      "tier_unavailable",
      "The all-events data tier is unavailable (the data Worker is not bound to " +
        "this deployment). Try again against the production endpoint.",
    );
  }

  let response;
  try {
    response = await dataApi.fetch(new Request(`https://d${pathAndQuery}`));
  } catch {
    throwToolError(
      "tier_unavailable",
      "The all-events data tier could not be reached. Try again shortly.",
    );
  }

  if (response.status === 400) {
    let message = "Invalid request to the all-events data tier.";
    try {
      const body = await response.json();
      if (typeof body?.error === "string" && body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throwToolError("invalid_params", message);
  }

  if (!response.ok) {
    throwToolError(
      "tier_unavailable",
      `The all-events data tier returned an error (status ${response.status}). ` +
        "Try again shortly.",
    );
  }

  return response.json();
}

export async function loadBlockChainEvents(ctx, blockNumber) {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throwToolError(
      "invalid_params",
      "block_number must be a non-negative integer.",
    );
  }
  const data = await dataApiFetchJson(
    ctx,
    `/api/v1/blocks/${blockNumber}/chain-events`,
  );
  return {
    schema_version: 1,
    block_number: data?.block_number ?? blockNumber,
    event_count: data?.count ?? 0,
    events: Array.isArray(data?.events) ? data.events : [],
  };
}

const COMPOSITE_REF_RE = /^(\d+)-(\d+)$/;

export async function loadExtrinsicChainEvents(ctx, ref) {
  const composite = COMPOSITE_REF_RE.exec(String(ref));
  const blockNumber = composite ? Number(composite[1]) : NaN;
  const extrinsicIndex = composite ? Number(composite[2]) : NaN;
  if (
    !composite ||
    !Number.isSafeInteger(blockNumber) ||
    !Number.isSafeInteger(extrinsicIndex)
  ) {
    throwToolError(
      "invalid_params",
      "ref must be the composite id 'block_number-extrinsic_index' (e.g. '4200000-3').",
    );
  }
  const data = await dataApiFetchJson(
    ctx,
    `/api/v1/chain-events?block=${blockNumber}&extrinsic=${extrinsicIndex}&limit=200`,
  );
  return {
    schema_version: 1,
    ref,
    block_number: blockNumber,
    extrinsic_index: extrinsicIndex,
    event_count: data?.count ?? 0,
    next_cursor: data?.next_cursor ?? null,
    events: Array.isArray(data?.events) ? data.events : [],
  };
}
