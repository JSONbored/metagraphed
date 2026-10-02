import { useEffect, useRef, useState } from "react";
import { Route } from "./apis.native";
import { DataTable, EntityHero, FactSentence, type DataTableColumn } from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiNavigation } from "@/components/metagraphed/apis/api-navigation";
import { NativeCallWallet } from "@/components/metagraphed/native-call-wallet";
import { apiFetch } from "@/lib/metagraphed/client";
import { useNetwork } from "@/hooks/use-api-base";
import { getApiBase, onApiBaseChange } from "@/lib/metagraphed/config";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import {
  NATIVE_FEATURES,
  featureOperations,
  describedMembers,
  memberOperation,
  entryOperation,
  nativePageCursor,
  nativeTypeLabel,
  nativeValueRows,
  nativePageOffset,
  type NativeArtifact,
  type NativeFeature,
  type NativeOperation,
  type NativeValueRow,
} from "@/lib/metagraphed/native-runtime";

const control =
  "w-full min-w-0 rounded border border-border bg-surface px-3 py-2 text-13 text-ink-strong focus:outline-accent";
const button =
  "rounded border border-border bg-card px-3 py-2 text-13 font-medium text-ink-strong hover:border-ink/30 disabled:opacity-50";
const columns: DataTableColumn<NativeValueRow>[] = [
  { key: "field", label: "Field", value: (row) => row.field },
  { key: "value", label: "Exact value", kind: "identifier", value: (row) => row.value },
];

/** User-initiated reads only. Remount on network/origin change, aborting the
 * previous request so its source and call bytes cannot cross partitions. */
export function NativeRuntimeRoutePage() {
  const search = Route.useSearch();
  return (
    <NativeRuntimePage initialNetuid={search.netuid || "19"} initialColdkey={search.coldkey} />
  );
}

export function NativeRuntimePage({
  initialNetuid,
  initialColdkey,
}: {
  initialNetuid: string;
  initialColdkey: string;
}) {
  const { network } = useNetwork();
  const [apiBase, setApiBase] = useState(getApiBase);
  useEffect(() => onApiBaseChange(setApiBase), []);
  return (
    <AppShell>
      <EntityHero
        className="mg-hero--directory"
        name="Native chain"
        sentence={
          <FactSentence>
            Read current Bittensor state and prepare calls from the chain’s own contract.
          </FactSentence>
        }
      />
      <ApiNavigation />
      <NativeRuntimeExplorer
        key={`${apiBase}:${network.id}:${initialNetuid}:${initialColdkey}`}
        network={network.label}
        initialNetuid={initialNetuid}
        initialColdkey={initialColdkey}
      />
    </AppShell>
  );
}

function NativeRuntimeExplorer({
  network,
  initialNetuid,
  initialColdkey,
}: {
  network: string;
  initialNetuid: string;
  initialColdkey: string;
}) {
  useRegisterApiSource(["/api/v1/native-runtime"], []);
  const [feature, setFeature] = useState<NativeFeature>("mechanisms");
  const [netuid, setNetuid] = useState(initialNetuid);
  const [coldkey, setColdkey] = useState(initialColdkey);
  const [hotkey, setHotkey] = useState("");
  const [namespace, setNamespace] = useState("SubtensorModule");
  const [api, setApi] = useState(false);
  const [offset, setOffset] = useState(0);
  const [description, setDescription] = useState<NativeArtifact | null>(null);
  const [memberIndex, setMemberIndex] = useState(0);
  const [args, setArgs] = useState("[]");
  const [result, setResult] = useState<NativeArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const read = async (operations: NativeOperation[], discovery = false, asOf?: string) => {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await apiFetch<NativeArtifact>("/api/v1/native-runtime", {
        signal: active.signal,
        init: {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ operations, ...(asOf ? { as_of: asOf } : {}) }),
        },
      });
      if (active.signal.aborted) return;
      if (discovery) {
        setDescription(response.data);
        setMemberIndex(0);
        setArgs("[]");
      } else setResult(response.data);
    } catch (failure) {
      if (!active.signal.aborted)
        setError(
          failure instanceof Error ? failure.message : "The request could not be completed.",
        );
    } finally {
      if (!active.signal.aborted) setBusy(false);
    }
  };
  const action = (build: () => NativeOperation[], asOf?: string) => {
    try {
      void read(build(), false, asOf);
    } catch (failure) {
      setResult(null);
      setError(failure instanceof Error ? failure.message : "Check the arguments.");
    }
  };
  const discover = (next: number, target = { api, name: namespace }) => {
    setOffset(next);
    void read(
      [
        {
          kind: "describe",
          ...(target.api ? { api: target.name } : { pallet: target.name }),
          offset: next,
          limit: 32,
        },
      ],
      true,
    );
  };
  const selected = NATIVE_FEATURES.find((item) => item.id === feature)!;
  const members = description ? describedMembers(description) : [];
  const member = members[memberIndex];
  const next = description ? nativePageOffset(description) : null;
  const shown = result ?? description;

  return (
    <div className="space-y-8 py-6">
      <section aria-labelledby="native-features" className="space-y-4">
        <div>
          <h2 id="native-features" className="font-display text-18 text-ink-strong">
            Protocol state
          </h2>
          <p className="text-13 text-ink-muted">
            Choose a feature and read its finalized state on {network}. Quantities retain their
            exact atomic units and fixed-point bits.
          </p>
        </div>
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            action(() => featureOperations(feature, netuid, coldkey, hotkey));
          }}
        >
          <label className="space-y-1 text-13">
            Feature
            <select
              disabled={busy}
              className={control}
              value={feature}
              onChange={(event) => {
                setFeature(event.target.value as NativeFeature);
                setResult(null);
              }}
            >
              {NATIVE_FEATURES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-13">
            Subnet
            <input
              disabled={busy}
              className={control}
              inputMode="numeric"
              value={netuid}
              onChange={(event) => {
                setNetuid(event.target.value);
                setResult(null);
              }}
            />
          </label>
          {selected.account && (
            <label className="space-y-1 text-13">
              Coldkey
              <input
                disabled={busy}
                className={control}
                value={coldkey}
                onChange={(event) => {
                  setColdkey(event.target.value);
                  setResult(null);
                }}
                placeholder="SS58 address or 0x…"
              />
            </label>
          )}
          {selected.hotkey && (
            <label className="space-y-1 text-13">
              Hotkey
              <input
                disabled={busy}
                className={control}
                value={hotkey}
                onChange={(event) => {
                  setHotkey(event.target.value);
                  setResult(null);
                }}
                placeholder="SS58 address or 0x…"
              />
            </label>
          )}
          <div className="flex items-end">
            <button className={button} disabled={busy} type="submit">
              Read state
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="native-contract" className="space-y-4">
        <div>
          <h2 id="native-contract" className="font-display text-18 text-ink-strong">
            Runtime contract
          </h2>
          <p className="text-13 text-ink-muted">
            Browse storage, constants, read APIs and native calls. The argument types come from the
            selected runtime.
          </p>
        </div>
        <button
          className={button}
          disabled={busy}
          onClick={() => {
            setApi(true);
            setNamespace("EthereumRuntimeRPCApi");
            setDescription(null);
            discover(0, { api: true, name: "EthereumRuntimeRPCApi" });
          }}
        >
          Explore EVM execution
        </button>
        <button
          className={button}
          disabled={busy}
          onClick={() => {
            setApi(true);
            setNamespace("ContractsApi");
            setDescription(null);
            discover(0, { api: true, name: "ContractsApi" });
          }}
        >
          Explore Wasm contracts
        </button>
        {api && namespace === "EthereumRuntimeRPCApi" && (
          <p className="text-13 text-ink-muted">
            Call and create simulate execution at a finalized block. Supply a positive gas_limit;
            each request can use up to 1,000,000 gas. Return data and reverts are preserved.
          </p>
        )}
        {api && namespace === "ContractsApi" && (
          <p className="text-13 text-ink-muted">
            Call, instantiate and upload_code simulate at a finalized block. Use an explicit Some
            gas_limit with ref_time and proof_size. A request permits up to 250,000,000,000 reference
            picoseconds, 65,536 proof bytes and one code upload of up to 16,384 bytes. Deposits,
            return bytes and reverts are preserved; simulation does not publish code or a contract.
          </p>
        )}
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            discover(0);
          }}
        >
          <label className="space-y-1 text-13">
            Contract
            <select
              disabled={busy}
              className={control}
              value={api ? "api" : "pallet"}
              onChange={(event) => {
                setApi(event.target.value === "api");
                setDescription(null);
                setResult(null);
              }}
            >
              <option value="pallet">Pallet</option>
              <option value="api">Runtime API</option>
            </select>
          </label>
          <label className="min-w-0 flex-1 space-y-1 text-13">
            Name
            <input
              disabled={busy}
              className={control}
              value={namespace}
              onChange={(event) => {
                setNamespace(event.target.value);
                setDescription(null);
                setResult(null);
              }}
              placeholder={api ? "SubnetInfoRuntimeApi" : "SubtensorModule"}
            />
          </label>
          <button className={button} disabled={busy || !namespace} type="submit">
            Inspect contract
          </button>
        </form>
        {description && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <label className="min-w-0 flex-1 space-y-1 text-13">
                Operation
                <select
                  disabled={busy}
                  className={control}
                  value={memberIndex}
                  onChange={(event) => {
                    setMemberIndex(Number(event.target.value));
                    setArgs("[]");
                    setResult(null);
                  }}
                >
                  {members.map((item, index) => (
                    <option key={`${item.kind}:${item.member}`} value={index}>
                      {item.kind} · {item.member}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-end gap-2">
                <button
                  className={button}
                  disabled={busy || offset === 0}
                  onClick={() => discover(Math.max(0, offset - 32))}
                >
                  Previous
                </button>
                <button
                  className={button}
                  disabled={busy || next === null}
                  onClick={() => next !== null && discover(next)}
                >
                  Next
                </button>
              </div>
            </div>
            {member && (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  action(
                    () => [memberOperation(member, args)],
                    description.source.finalized_block_hash,
                  );
                }}
              >
                <dl className="grid gap-2 sm:grid-cols-2">
                  {member.args.map((field, index) => (
                    <div className="min-w-0 text-13" key={index}>
                      <dt className="text-ink-muted">{field.name ?? `Argument ${index + 1}`}</dt>
                      <dd className="break-all font-mono text-ink-strong">
                        {nativeTypeLabel(description, field.type)}
                      </dd>
                    </div>
                  ))}
                </dl>
                <label className="block space-y-1 text-13">
                  Arguments (JSON array)
                  <textarea
                    disabled={busy}
                    className={`${control} font-mono`}
                    rows={3}
                    value={args}
                    onChange={(event) => {
                      setArgs(event.target.value);
                      setResult(null);
                    }}
                    spellCheck={false}
                  />
                </label>
                <p className="text-13 text-ink-muted">
                  Use decimal strings for large integers, hex for bytes and public keys, and{" "}
                  {'{"variant":"Some","fields":…}'} for enums. Prepared call bytes can be reviewed
                  and imported into a metadata-aware wallet; preparing a call does not sign or send
                  it.
                </p>
                <button className={button} disabled={busy} type="submit">
                  {member.kind === "prepare" ? "Prepare unsigned call" : "Read operation"}
                </button>
                {member.kind === "storage" && member.args.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-13 text-ink-muted">
                      Browse records with [] for all keys, or supply leading keys to narrow the map.
                      Each page stays at the same finalized block.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={button}
                        disabled={busy}
                        type="button"
                        onClick={() =>
                          action(
                            () => [entryOperation(member, args)],
                            description.source.finalized_block_hash,
                          )
                        }
                      >
                        Browse records
                      </button>
                      {result?.results[0]?.kind === "entries" && nativePageCursor(result) && (
                        <button
                          className={button}
                          disabled={busy}
                          type="button"
                          onClick={() =>
                            action(
                              () => [entryOperation(member, args, nativePageCursor(result)!)],
                              result.source.finalized_block_hash,
                            )
                          }
                        >
                          Next records
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </form>
            )}
          </div>
        )}
      </section>

      {busy && (
        <p role="status" className="text-13 text-ink-muted">
          Reading finalized runtime…
        </p>
      )}
      {error && (
        <p role="alert" className="rounded border border-border p-3 text-13 text-health-down">
          {error}
        </p>
      )}
      {shown && (
        <section aria-labelledby="native-result" className="min-w-0 space-y-4">
          <h2 id="native-result" className="font-display text-18 text-ink-strong">
            {result ? "Result" : "Contract source"}
          </h2>
          <dl className="grid gap-3 text-13 sm:grid-cols-3">
            <div>
              <dt className="text-ink-muted">Runtime</dt>
              <dd>
                v{shown.source.runtime_spec_version} · metadata v{shown.source.metadata_version}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Finalized block</dt>
              <dd>{shown.source.finalized_block}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-muted">Block hash</dt>
              <dd className="break-all font-mono">{shown.source.finalized_block_hash}</dd>
            </div>
          </dl>
          {result && (
            <DataTable
              rows={nativeValueRows(result)}
              columns={columns}
              rowKey={(row) => row.key}
              caption="Exact native runtime results"
            />
          )}
          {result?.results.map(
            (item, index) =>
              item.kind === "prepare" && (
                <NativeCallWallet
                  key={`${result.source.finalized_block_hash}:${item.call_data}:${index}`}
                  artifact={result}
                  index={index}
                />
              ),
          )}
          <details>
            <summary className="cursor-pointer text-13 text-ink-muted">
              Complete response and shared type contract
            </summary>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded border border-border p-3 text-12">
              {JSON.stringify(shown, null, 2)}
            </pre>
          </details>
        </section>
      )}
    </div>
  );
}
