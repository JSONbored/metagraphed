import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FilterInput } from "@jsonbored/ui-kit";
import { isValidH160, isValidSs58, normalizeH160 } from "@/lib/metagraphed/accounts";
import { lookupVerdict } from "./accounts-index-logic";

/**
 * The address lookup, directly under the hero sentence.
 *
 * One decision point: `lookupVerdict` says what the input is and the form
 * acts on it. The previous page decided in three places -- an effect that
 * navigated on paste, a submit handler and a separate H160 branch -- which is
 * why an invalid paste could navigate and an invalid submit could not.
 *
 * Rejection is one 11px line under the field, not a toast: the reader is
 * looking at the field they just typed into, and a message that appears in
 * the corner and disappears is a message they may never see.
 */
export function AccountLookup() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const verdict = lookupVerdict(value, isValidSs58, isValidH160, normalizeH160);
    if (verdict.kind === "empty") return;
    if (verdict.kind === "invalid") {
      setError(verdict.message);
      return;
    }
    setError(null);
    if (verdict.kind === "ss58") {
      void navigate({ to: "/accounts/$ss58", params: { ss58: verdict.path } });
      return;
    }
    void navigate({ to: "/accounts", search: verdict.search });
  };

  return (
    <form className="mg-lookup" onSubmit={submit} role="search">
      <FilterInput
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          if (error) setError(null);
        }}
        placeholder="ss58 or EVM address"
        aria-label="Look up an account by address"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "account-lookup-error" : undefined}
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="mg-hero-icon-action">
        Look up
      </button>
      {error ? (
        <p id="account-lookup-error" className="mg-lookup-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
