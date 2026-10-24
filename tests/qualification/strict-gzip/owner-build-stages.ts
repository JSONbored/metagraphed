import {
  inheritOwnerProofReason,
  ownerProofReasonMarker,
} from "./owner-proof-reasons.ts";
// Failure-only fixed stage labels. Never supplies acceptance evidence.
import { optionalProofDiagnosticMarkers } from "./optional-pg-import.ts";
import { publicInputDiagnosticMarkers } from "./owner-input-diagnostics.ts";
export const OWNER_BUILD_STAGES = Object.freeze({
  "raw-build": Object.freeze([
    "source-pins",
    "builder",
    "output-inventory",
    "output-bytes",
    "optional-proof",
    "entry-exports",
    "output-graph",
    "source-contributions",
    "input-custody",
    "association-serialization",
  ]),
  "optional-adapter": Object.freeze([
    "environment",
    "workspace-custody",
    "native-absence",
    "source-bytes",
    "discarded-input-sources",
    "erasure-config-sources",
    "proof",
  ]),
  preserve: Object.freeze([
    "directory",
    "workspace-custody",
    "modules",
    "entry",
    "sources",
    "association",
    "manifest",
  ]),
  validate: Object.freeze([
    "runtime-identity",
    "directory",
    "manifest",
    "modules",
    "entry",
    "sources",
    "association",
  ]),
  association: Object.freeze([
    "setup",
    "workspace-custody",
    "queue-envelope",
    "queue-modules",
    "queue-source-maps",
    "raw-envelope",
    "raw-inputs",
    "raw-output-inventory",
    "raw-source-maps",
    "optional-proof",
    "raw-modules",
    "raw-closure",
    "raw-contributions",
  ]),
});
const marked = new WeakMap<object, string>();
export function ownerBuildDiagnosticMarkers(error: unknown): string {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  )
    return "";
  return (
    marked.get(error as object) ??
    (publicInputDiagnosticMarkers(error) ||
      optionalProofDiagnosticMarkers(error))
  );
}
export function ownerBuildStageFailure(
  scope: unknown,
  stage: unknown,
  cause: unknown,
): unknown {
  if (
    ((typeof cause === "object" && cause !== null) ||
      typeof cause === "function") &&
    ownerBuildDiagnosticMarkers(cause) !== ""
  )
    return cause;
  const validScope =
    typeof scope === "string" && Object.hasOwn(OWNER_BUILD_STAGES, scope);
  const allowed = validScope
    ? (OWNER_BUILD_STAGES[
        scope as keyof typeof OWNER_BUILD_STAGES
      ] as readonly string[])
    : [];
  const validStage = typeof stage === "string" && allowed.includes(stage);
  const reason = ownerProofReasonMarker(cause);
  const error = inheritOwnerProofReason(
    new Error(
      `[owner-build-proof-failed:${validScope ? scope : "unknown"}:${validStage ? stage : "unknown"}]` +
        (reason ? "\n" + reason : ""),
      { cause },
    ),
    cause,
  );
  marked.set(error, error.message);
  return error;
}
