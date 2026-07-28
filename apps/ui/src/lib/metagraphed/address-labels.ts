import { useCallback, useEffect, useState } from "react";

/**
 * Private, local-first address labels (#8484): "which of these is mine?" —
 * the counterpart to #8372's public nametag layer. Lives in its own
 * localStorage key with its own versioned envelope, following the same
 * migration-tolerant read / cross-tab sync conventions as `watchlist.ts`, but
 * kept as a separate store rather than folded into it: watchlist is a set of
 * ids, this is a map of ids to user-authored text, and the two have
 * different privacy postures (a starred subnet is not sensitive; a name for
 * your own wallet is closer to PII — see this module's own privacy notes
 * below and #8270).
 *
 * `resolveAddress` (resolve-address.ts) already has a `localLabel` parameter
 * with "private label wins" precedence, tested and unused until this module
 * wires real storage into it — see that file's own header comment.
 */

const STORAGE_KEY = "metagraphed:address-labels";

export const ADDRESS_LABELS_SCHEMA_VERSION = 1;

/** A pathological write (e.g. a corrupted import loop) can't wedge storage. */
export const MAX_LABELS = 200;
export const MAX_NAME_LENGTH = 40;
export const MAX_NOTE_LENGTH = 200;

export interface AddressLabel {
  name: string;
  note?: string;
  updated_at: string;
}

interface AddressLabelsFile {
  version: number;
  labels: Record<string, AddressLabel>;
}

function clampText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

/**
 * Accepts only the v1 `{ version, labels }` envelope — there is no bare-array
 * predecessor to stay compatible with the way `watchlist.ts`'s v1 shape is.
 * Anything unparseable, corrupt, or from an unknown future version reads as
 * empty rather than throwing: a broken label store must never take a page
 * down with it.
 */
function parseAddressLabels(raw: string | null): Record<string, AddressLabel> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const { version, labels } = parsed as Partial<AddressLabelsFile>;
    if (typeof version !== "number" || version > ADDRESS_LABELS_SCHEMA_VERSION) return {};
    if (!labels || typeof labels !== "object") return {};
    const out: Record<string, AddressLabel> = {};
    for (const [ss58, entry] of Object.entries(labels)) {
      const name = typeof entry?.name === "string" ? clampText(entry.name, MAX_NAME_LENGTH) : "";
      if (!name) continue;
      const note =
        typeof entry?.note === "string" && entry.note.trim()
          ? clampText(entry.note, MAX_NOTE_LENGTH)
          : undefined;
      const updated_at =
        typeof entry?.updated_at === "string" ? entry.updated_at : new Date(0).toISOString();
      out[ss58] = note ? { name, note, updated_at } : { name, updated_at };
    }
    return out;
  } catch {
    return {};
  }
}

function readAddressLabels(): Record<string, AddressLabel> {
  if (typeof window === "undefined") return {};
  try {
    return parseAddressLabels(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

function writeAddressLabels(labels: Record<string, AddressLabel>): void {
  if (typeof window === "undefined") return;
  try {
    const file: AddressLabelsFile = { version: ADDRESS_LABELS_SCHEMA_VERSION, labels };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
  } catch {
    // Storage can be full or disabled (private browsing) — a label is a
    // convenience, not a data-loss risk, so fail silently (same posture as
    // watchlist.ts's writeWatchlist).
  }
}

function notifyThisTab(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
}

/** Every label in one envelope — what the /settings export button downloads.
 * Same shape conventions as `WatchlistExport` (watchlist.ts): version +
 * exported_at + the payload, per #8484's own requirement to reuse that
 * shape's conventions rather than invent a second serialization idiom. */
export interface AddressLabelsExport {
  version: number;
  exported_at: string;
  labels: Record<string, AddressLabel>;
}

export function exportAddressLabels(): AddressLabelsExport {
  return {
    version: ADDRESS_LABELS_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    labels: readAddressLabels(),
  };
}

/**
 * Merges an exported file into the current labels rather than replacing them
 * — importing on a device that already has labels should never silently
 * overwrite a name the user chose there. An ss58 already labeled locally is
 * left untouched even if the import has a different name for it (mirrors
 * `importWatchlists`'s "never deletes/overwrites what's already on this
 * device" posture — here extended to "never overwrites", since unlike a
 * watchlist star a label carries user-authored text that could conflict).
 *
 * Throws on a file this can't interpret; the caller surfaces that to the user.
 */
export function importAddressLabels(raw: string): number {
  const parsed: unknown = JSON.parse(raw);
  const incoming = (parsed as Partial<AddressLabelsExport> | null)?.labels;
  if (!incoming || typeof incoming !== "object") {
    throw new Error("Not a Metagraphed address-labels file — expected a `labels` object.");
  }
  const current = readAddressLabels();
  let added = 0;
  for (const [ss58, entry] of Object.entries(incoming)) {
    if (current[ss58]) continue;
    if (Object.keys(current).length + added >= MAX_LABELS) break;
    const name = typeof entry?.name === "string" ? clampText(entry.name, MAX_NAME_LENGTH) : "";
    if (!name) continue;
    const note =
      typeof entry?.note === "string" && entry.note.trim()
        ? clampText(entry.note, MAX_NOTE_LENGTH)
        : undefined;
    const updated_at =
      typeof entry?.updated_at === "string" ? entry.updated_at : new Date().toISOString();
    current[ss58] = note ? { name, note, updated_at } : { name, updated_at };
    added++;
  }
  if (added > 0) {
    writeAddressLabels(current);
    notifyThisTab();
  }
  return added;
}

/**
 * `labels` starts empty on every render (server and the first client render
 * alike) and is populated from localStorage in an effect — an effect never
 * runs during SSR, so this can never produce a hydration mismatch the way
 * reading localStorage in the initializer would (same rule as `useWatchlist`,
 * see docs/ssr-safety.md).
 */
export function useAddressLabels() {
  const [labels, setLabels] = useState<Record<string, AddressLabel>>(() => ({}));

  useEffect(() => {
    setLabels(readAddressLabels());
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setLabels(readAddressLabels());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const getLabel = useCallback(
    (ss58: string): AddressLabel | null => labels[ss58] ?? null,
    [labels],
  );

  /** Empty/whitespace-only `name` removes the label instead of writing a
   * blank one — matches the editor's own "clear name to remove" affordance. */
  const setLabel = useCallback((ss58: string, name: string, note?: string) => {
    const trimmedName = clampText(name, MAX_NAME_LENGTH);
    setLabels((prev) => {
      const next = { ...prev };
      if (!trimmedName) {
        delete next[ss58];
        writeAddressLabels(next);
        return next;
      }
      if (!prev[ss58] && Object.keys(prev).length >= MAX_LABELS) return prev;
      const trimmedNote = note && note.trim() ? clampText(note, MAX_NOTE_LENGTH) : undefined;
      next[ss58] = {
        name: trimmedName,
        ...(trimmedNote ? { note: trimmedNote } : {}),
        updated_at: new Date().toISOString(),
      };
      writeAddressLabels(next);
      return next;
    });
    notifyThisTab();
  }, []);

  const removeLabel = useCallback((ss58: string) => {
    setLabels((prev) => {
      if (!prev[ss58]) return prev;
      const next = { ...prev };
      delete next[ss58];
      writeAddressLabels(next);
      return next;
    });
    notifyThisTab();
  }, []);

  return { labels, getLabel, setLabel, removeLabel, count: Object.keys(labels).length };
}
