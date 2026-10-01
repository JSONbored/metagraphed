/** Method-level checks after the shared JSON-RPC envelope has been parsed. */
export class ChainBlockUnavailableError extends Error {}

export function chainBlockHash(value: unknown, method: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${method}: response was not a block hash`);
  }
  return value;
}

export function chainHeaderNumber(value: unknown): number {
  if (value === null) {
    throw new ChainBlockUnavailableError(
      "chain_getHeader: pinned block unavailable",
    );
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("chain_getHeader: response was not a header");
  }
  const number = (value as { number?: unknown }).number;
  if (typeof number !== "string" || !/^0x[0-9a-f]+$/i.test(number)) {
    throw new Error(
      "chain_getHeader: response had no hexadecimal block number",
    );
  }
  const blockNumber = Number(number);
  if (!Number.isSafeInteger(blockNumber)) {
    throw new Error(
      "chain_getHeader: block number exceeds safe integer precision",
    );
  }
  return blockNumber;
}

/** Empty changes are valid unset storage; an absent changeset is unavailable. */
export function chainStorageChanges(
  value: unknown,
  at: string,
): [string, string | null][] {
  if (value === null || (Array.isArray(value) && value.length === 0)) {
    throw new ChainBlockUnavailableError(
      "state_queryStorageAt: pinned block unavailable",
    );
  }
  if (!Array.isArray(value)) {
    throw new Error("state_queryStorageAt: response was not a changeset array");
  }
  const changes: [string, string | null][] = [];
  for (const page of value) {
    if (
      page === null ||
      typeof page !== "object" ||
      !Array.isArray(page.changes)
    ) {
      throw new Error("state_queryStorageAt: response had no changes array");
    }
    if (page.block !== undefined && page.block !== at) {
      throw new Error(
        "state_queryStorageAt: changeset did not match the pinned block",
      );
    }
    for (const pair of page.changes) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        (pair[1] !== null && typeof pair[1] !== "string")
      ) {
        throw new Error(
          "state_queryStorageAt: response had a malformed storage change",
        );
      }
      changes.push([pair[0], pair[1]]);
    }
  }
  return changes;
}

export function chainStorageKeys(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((key) => typeof key === "string")) {
    throw new Error("state_getKeysPaged: response was not a key array");
  }
  return value;
}

/** Only explicit pinned-block unavailability can restart a complete sample. */
export function chainBlockUnavailable(error: unknown): boolean {
  return (
    error instanceof ChainBlockUnavailableError ||
    (error instanceof Error &&
      /^(?:chain_getHeader|state_queryStorageAt|state_getStorage|state_getKeysPaged): .*UnknownBlock\b/.test(
        error.message,
      ))
  );
}
