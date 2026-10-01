/** Classify a transient connection failure, without granting any SQL retry.
 * The writer must independently establish safe replay or acknowledge its
 * existing commit; additive statements cannot be retried from this alone. */
export function isD1ConnectionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(?:D1_ERROR: )?(?:Network connection lost\.|Replica disconnected from primary\.|D1 DB reset because its code was updated\.|Internal error (?:while starting up|in) D1 DB storage caused object to be reset\.|Cannot resolve D1 DB due to transient issue on remote node\.|internal error; reference = e_[A-Za-z0-9_-]+)$/.test(
      error.message,
    )
  );
}
