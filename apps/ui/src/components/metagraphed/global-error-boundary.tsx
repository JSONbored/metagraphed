import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Copy, Home, RefreshCw } from "lucide-react";
import { reportError } from "@/lib/error-reporting";

interface Props {
  children: ReactNode;
}
interface State {
  error: unknown;
  copied: boolean;
}

/**
 * Global styled error boundary. Wraps the app tree in __root so that any
 * render-time throw that escapes route-level `errorComponent` (portals,
 * event handlers that force a re-render, provider crashes) still lands on a
 * branded Bone & Ink fallback instead of a black/blank page.
 *
 * On catch it stamps a `mg:last-crash` session flag so the blank-screen
 * watchdog can distinguish "genuine runtime error" from "silent blank".
 */
export class GlobalErrorBoundary extends Component<Props, State> {
  state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, copied: false };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportError(error, { boundary: "global", componentStack: info.componentStack });
    try {
      sessionStorage.setItem("mg:last-crash", String(Date.now()));
    } catch {
      /* private mode / disabled storage — best-effort only */
    }
  }

  private reset = () => {
    try {
      sessionStorage.removeItem("mg:last-crash");
    } catch {
      /* noop */
    }
    this.setState({ error: null, copied: false });
  };

  private reload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  private goHome = () => {
    if (typeof window !== "undefined") window.location.assign("/");
  };

  private copyDetails = async () => {
    const err = this.state.error;
    const text =
      err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 1500);
    } catch {
      /* noop */
    }
  };

  render() {
    if (this.state.error == null) return this.props.children;

    const err = this.state.error;
    const message = err instanceof Error ? err.message : String(err);

    return (
      <div className="min-h-dvh bg-paper px-4 py-10 text-ink-strong">
        <div className="mx-auto max-w-3xl">
          <main aria-labelledby="ge-title">
            <div className="mg-label flex items-center gap-2">
              <AlertTriangle className="size-3.5 text-health-warn" />
              Metagraphed / runtime error
            </div>
            <h1
              id="ge-title"
              className="mt-3 font-display text-3xl font-semibold leading-tight text-ink-strong md:text-4xl"
            >
              Something broke while rendering this page.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-muted md:text-base">
              The rest of the registry is unaffected — you can retry this view, go back to the
              overview, or copy the error details for a bug report.
            </p>

            <div className="mt-6 rounded-xl border border-border bg-card p-4">
              <div className="mg-label">Error message</div>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-paper p-2 font-mono text-[12px] text-ink">
                {message || "Unknown error"}
              </pre>
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={this.reset}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-accent/60 bg-primary-soft px-4 text-sm font-medium text-ink-strong transition-colors hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RefreshCw className="size-4" /> Try again
              </button>
              <button
                type="button"
                onClick={this.reload}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm text-ink-muted transition-colors hover:border-accent/60 hover:text-ink-strong"
              >
                Hard reload
              </button>
              <button
                type="button"
                onClick={this.goHome}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm text-ink-muted transition-colors hover:border-accent/60 hover:text-ink-strong"
              >
                <Home className="size-4" /> Overview
              </button>
              <button
                type="button"
                onClick={this.copyDetails}
                aria-live="polite"
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm text-ink-muted transition-colors hover:border-accent/60 hover:text-ink-strong"
              >
                <Copy className="size-4" />
                {this.state.copied ? "Copied" : "Copy error details"}
              </button>
            </div>
          </main>
        </div>
      </div>
    );
  }
}
