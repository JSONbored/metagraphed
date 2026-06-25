import { Component, type ErrorInfo, type ReactNode } from "react";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import { ErrorState } from "./states";
import { reportError } from "@/lib/error-reporting";

interface Props {
  children: ReactNode;
  fallback?: (error: unknown, retry: () => void) => ReactNode;
}
interface State {
  error: unknown;
}

export class QueryErrorBoundary extends Component<Props, State> {
  // Read the QueryClient from context so reset() can actually re-run failing
  // queries instead of just re-rendering the same bad cached data (retry loop).
  static contextType = QueryClientContext;
  declare context: QueryClient | undefined;

  state: State = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Single centralized seam — real telemetry can be wired behind reportError
    // without touching every boundary.
    reportError(error, { boundary: "query_error_boundary", componentStack: info.componentStack });
  }

  reset = () => {
    // Invalidate active queries so a transient failure gets a fresh fetch on
    // retry. Without this, reset() re-renders the same errored cache entry and
    // the boundary trips again immediately (infinite retry loop).
    void this.context?.invalidateQueries({ type: "active" });
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return <ErrorState error={this.state.error} onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
