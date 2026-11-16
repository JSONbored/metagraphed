// Deployment policy for Cloudflare's separately billed telemetry ingestion.
// Keep direct PostHog capture independent of the Worker platform switches.
type Row = Record<string, unknown>;

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

export function cloudflareObservabilityErrors(config: Row): string[] {
  const observability = row(config.observability);
  const logs = row(observability.logs);
  const traces = row(observability.traces);
  const errors: string[] = [];
  if (row(observability.issues).enabled === true) {
    errors.push("observability.issues.enabled must not be true");
  }
  for (const [name, value] of [
    ["logpush", config.logpush],
    ["observability.enabled", observability.enabled],
    ["observability.logs.enabled", logs.enabled],
    ["observability.logs.invocation_logs", logs.invocation_logs],
    ["observability.logs.persist", logs.persist],
    ["observability.traces.enabled", traces.enabled],
    ["observability.traces.persist", traces.persist],
  ] as const) {
    if (value !== false) errors.push(`${name} must be explicitly false`);
  }
  for (const [name, value] of [
    ["observability.head_sampling_rate", observability.head_sampling_rate],
    ["observability.logs.head_sampling_rate", logs.head_sampling_rate],
    ["observability.traces.head_sampling_rate", traces.head_sampling_rate],
  ] as const) {
    if (value !== 0) errors.push(`${name} must be explicitly zero`);
  }
  for (const [name, value] of [
    ["tail_consumers", config.tail_consumers],
    ["observability.logs.destinations", logs.destinations],
    ["observability.traces.destinations", traces.destinations],
  ] as const) {
    if (!Array.isArray(value) || value.length !== 0) {
      errors.push(`${name} must be an explicit empty array`);
    }
  }
  for (const [name, environment] of Object.entries(row(config.env))) {
    for (const error of cloudflareObservabilityErrors({
      ...config,
      ...row(environment),
      env: undefined,
    })) {
      errors.push(`env.${name}: ${error}`);
    }
  }
  return errors;
}
