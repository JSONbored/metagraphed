// Re-exported from scripts/lib so the suites and the validator scripts share
// ONE definition -- both drive the same Worker handlers and both need the same
// partial env (#11339). The doc comment explaining the single cast lives there.
export {
  apiEnv,
  dataApiEnv,
  registrySyncEnv,
} from "../../scripts/lib/worker-env.ts";
