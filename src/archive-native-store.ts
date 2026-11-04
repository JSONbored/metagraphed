/** Raw manifest records retain the existing archive format and CAS semantics. */
export interface ArchiveCatalogStore {
  read(keys: string[]): Promise<{ key: string; payload: string }[]>;
  insert(key: string, payload: string): Promise<{ key: string }[]>;
  replace(
    key: string,
    previous: string,
    payload: string,
    updatedAt: string,
  ): Promise<{ key: string }[]>;
}

/** Immutable, checksum-addressed chunks; an absent selected chunk is an error. */
export interface ArchiveContentStore {
  get(sha256: string, signal: AbortSignal): Promise<Response>;
}
