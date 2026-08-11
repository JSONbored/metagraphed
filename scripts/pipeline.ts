import { spawnSync } from "node:child_process";
import { stableStringify } from "./lib.ts";

interface Step {
  script: string;
  env: Record<string, string>;
}

interface StepResult {
  script: string;
  status: "passed" | "failed";
  elapsed_ms: number;
}

const args = new Set(process.argv.slice(2));
const refresh = args.has("--refresh");
const check = args.has("--check") || !refresh;

const startedAt = new Date().toISOString();
const refreshTimestamp = process.env.METAGRAPH_BUILD_TIMESTAMP || startedAt;
const commands = check ? checkCommands() : refreshCommands(refreshTimestamp);
const results: StepResult[] = [];

for (const command of commands) {
  const started = performance.now();
  const result = spawnSync("npm", ["run", command.script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(command.env || {}),
    },
    stdio: "pipe",
  });
  const elapsedMs = Math.round(performance.now() - started);
  results.push({
    script: command.script,
    status: result.status === 0 ? "passed" : "failed",
    elapsed_ms: elapsedMs,
  });

  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");

  if (result.status !== 0) {
    console.error(
      stableStringify({
        mode: check ? "check" : "refresh",
        failed_script: command.script,
        results,
      }),
    );
    process.exit(result.status || 1);
  }
}

console.log(
  stableStringify({
    mode: check ? "check" : "refresh",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    result_count: results.length,
    results,
  }),
);

function checkCommands(): Step[] {
  return [
    step("artifacts:prepare-local"),
    step("sync:subnets:dry-run"),
    step("discover:candidates:dry-run"),
    step("verify:candidates:dry-run"),
    step("curate:baseline:dry-run"),
    step("review:promote:dry-run"),
    step("schemas:snapshot:dry-run"),
    step("adapters:snapshot:dry-run"),
    step("openapi:generate:dry-run"),
    step("r2:manifest:dry-run"),
    step("validate"),
    step("validate:schemas"),
    step("validate:api"),
    step("validate:mcp"),
    step("validate:mcp-route-map"),
    step("validate:mcp-input-parity"),
    step("validate:tool-route-divergence"),
    step("validate:query-vocabulary"),
    step("validate:route-query-parity"),
    step("validate:ai"),
    step("validate:openapi"),
    step("validate:types"),
    step("validate:contract-drift"),
    step("validate:db-types-drift"),
    step("validate:lakehouse-types-drift"),
    step("validate:client-sdk-sync"),
    step("validate:schema-enums"),
    step("validate:openapi-examples"),
    step("validate:generated-client"),
    step("validate:graphql-types-drift"),
    step("validate:worker-types-parity"),
    step("validate:graphql-route-parity"),
    step("validate:graphql-hand-written-checks"),
    step("validate:graphql-component-parity"),
    step("validate:graphql-query-arguments"),
    step("validate:published-names"),
    step("validate:graphql-tier-parity"),
    step("validate:committed-seed"),
    step("validate:artifact-budgets"),
    step("validate:docs"),
    // Companion to validate:docs: it checks each artifact/route is MENTIONED
    // in docs/backend-artifact-contracts.md, this one checks a bullet did not
    // silently outlive the behavior it describes. Diff-scoped -- with no merge
    // base resolvable it skips, so a local run stays quiet on a clean tree.
    step("validate:contract-doc-sync"),
    // #8917: apps/ui/content/docs/api-reference is generated from
    // openapi.json, so a CONTRACT change invalidates it -- but that lands
    // in a backend PR that need never touch apps/ui, and the only prior
    // check lived in the separately path-gated `ui` CI job. Checked here so
    // the PR that causes the drift can see it locally.
    step("validate:ui-docs-drift"),
    // The unrendered-route ceiling (#10300). Sibling of validate:ui-docs-drift
    // and here for the same reason: a route lands in a BACKEND PR that never
    // touches apps/ui, so the gap it opens is invisible to the change that
    // caused it. Reads API_ROUTES against apps/ui sources -- no network, no
    // build artifacts.
    step("validate:ui-route-coverage"),
    step("validate:untyped-db-reads"),
    step("validate:untyped-lakehouse-reads"),
    step("validate:declared-tables-exist"),
    // Same shape, and it was in neither the pipeline nor CI until #10251: the
    // registry README's catalog section is generated, so a registry change
    // invalidates it without touching the README.
    step("validate:readme-catalog"),
    // Runs in publish-cloudflare.yml / sync-subnets.yml, so it had CI coverage
    // but no local one -- 0.2s, and an adapter edit is exactly the change a
    // contributor wants told about before pushing (#10251).
    step("validate:adapters"),
    step("validate:intake"),
    step("validate:surface"),
    step("validate:revenue-provenance"),
    // #8658: runs after the build steps above, so the staged surfaces.json
    // exists to compare the callable catalog against.
    step("validate:operational-surface-parity"),
    step("validate:workflows"),
    step("validate:migrations"),
    step("worker:test"),
    step("worker:deploy:dry-run"),
    step("scan:public-safety"),
    step("validate:no-hand-written-mjs"),
    step("validate:single-schema-source"),
    step("validate:schema-opacity"),
    step("validate:schema-vocabularies"),
    step("validate:unreferenced-modules"),
    step("validate:unreferenced-exports"),
    step("validate:module-state-resets"),
    step("validate:pg-json-binds"),
    step("validate:private-boundary"),
    step("test"),
  ];
}

function refreshCommands(refreshTimestamp: string): Step[] {
  const refreshEnv = {
    METAGRAPH_BUILD_TIMESTAMP: refreshTimestamp,
    METAGRAPH_DISCOVERY_OBSERVED_AT: refreshTimestamp,
    METAGRAPH_PERSIST_DISCOVERY_OBSERVED_AT: "1",
    METAGRAPH_VERIFICATION_OBSERVED_AT: refreshTimestamp,
  };
  const commands = [
    step("sync:subnets"),
    step("discover:candidates", refreshEnv),
    step("verify:candidates", refreshEnv),
    step("curate:baseline", refreshEnv),
    step("review:promote"),
    step("review:queue", refreshEnv),
    step("adapters:snapshot", refreshEnv),
    step("build", refreshEnv),
    step("schemas:snapshot", refreshEnv),
    step("capture:fixtures", refreshEnv),
  ];

  if (process.env.METAGRAPH_WRITE_PROBE_RESULTS === "1") {
    commands.push(
      step("probes:smoke", refreshEnv),
      step("build", refreshEnv),
      step("schemas:snapshot", refreshEnv),
      step("capture:fixtures", refreshEnv),
      step("build-summary:refresh", refreshEnv),
    );
  }

  commands.push(step("r2:manifest", refreshEnv));

  return [
    ...commands,
    step("validate"),
    step("validate:schemas"),
    step("validate:api"),
    step("validate:mcp"),
    step("validate:mcp-route-map"),
    step("validate:mcp-input-parity"),
    step("validate:tool-route-divergence"),
    step("validate:query-vocabulary"),
    step("validate:route-query-parity"),
    step("validate:ai"),
    step("validate:openapi"),
    step("validate:types"),
    step("validate:contract-drift"),
    step("validate:db-types-drift"),
    step("validate:lakehouse-types-drift"),
    step("validate:client-sdk-sync"),
    step("validate:schema-enums"),
    step("validate:openapi-examples"),
    step("validate:generated-client"),
    step("validate:graphql-types-drift"),
    step("validate:worker-types-parity"),
    step("validate:graphql-route-parity"),
    step("validate:graphql-hand-written-checks"),
    step("validate:graphql-component-parity"),
    step("validate:graphql-query-arguments"),
    step("validate:published-names"),
    step("validate:graphql-tier-parity"),
    step("validate:committed-seed"),
    step("validate:artifact-budgets"),
    step("validate:docs"),
    // Companion to validate:docs: it checks each artifact/route is MENTIONED
    // in docs/backend-artifact-contracts.md, this one checks a bullet did not
    // silently outlive the behavior it describes. Diff-scoped -- with no merge
    // base resolvable it skips, so a local run stays quiet on a clean tree.
    step("validate:contract-doc-sync"),
    // #8917: apps/ui/content/docs/api-reference is generated from
    // openapi.json, so a CONTRACT change invalidates it -- but that lands
    // in a backend PR that need never touch apps/ui, and the only prior
    // check lived in the separately path-gated `ui` CI job. Checked here so
    // the PR that causes the drift can see it locally.
    step("validate:ui-docs-drift"),
    // The unrendered-route ceiling (#10300). Sibling of validate:ui-docs-drift
    // and here for the same reason: a route lands in a BACKEND PR that never
    // touches apps/ui, so the gap it opens is invisible to the change that
    // caused it. Reads API_ROUTES against apps/ui sources -- no network, no
    // build artifacts.
    step("validate:ui-route-coverage"),
    step("validate:untyped-db-reads"),
    step("validate:untyped-lakehouse-reads"),
    step("validate:declared-tables-exist"),
    // Same shape, and it was in neither the pipeline nor CI until #10251: the
    // registry README's catalog section is generated, so a registry change
    // invalidates it without touching the README.
    step("validate:readme-catalog"),
    // Runs in publish-cloudflare.yml / sync-subnets.yml, so it had CI coverage
    // but no local one -- 0.2s, and an adapter edit is exactly the change a
    // contributor wants told about before pushing (#10251).
    step("validate:adapters"),
    step("validate:intake"),
    step("validate:surface"),
    step("validate:revenue-provenance"),
    // #8658: runs after the build steps above, so the staged surfaces.json
    // exists to compare the callable catalog against.
    step("validate:operational-surface-parity"),
    step("validate:workflows"),
    step("validate:migrations"),
    step("worker:test"),
    step("worker:deploy:dry-run"),
    step("scan:public-safety"),
    step("validate:no-hand-written-mjs"),
    step("validate:single-schema-source"),
    step("validate:schema-opacity"),
    step("validate:schema-vocabularies"),
    step("validate:unreferenced-modules"),
    step("validate:unreferenced-exports"),
    step("validate:module-state-resets"),
    step("validate:pg-json-binds"),
    step("validate:private-boundary"),
    step("test"),
  ];
}

function step(script: string, env: Record<string, string> = {}): Step {
  return { script, env };
}
