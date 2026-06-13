import { Component, type ReactNode } from "react";
import { ErrorState } from "./states";

interface Props {
  children: ReactNode;
  fallback?: (error: unknown, retry: () => void) => ReactNode;
}
interface State {
  error: unknown;
}

export class QueryErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error("[QueryErrorBoundary]", error);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return <ErrorState error={this.state.error} onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
