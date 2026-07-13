import { Component, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { SectionAnchor, TimeAgo, type SectionTone } from "@jsonbored/ui-kit";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { classNames, isStaleFreshness, isUsableTimestamp } from "@/lib/metagraphed/format";
import { reportError } from "@/lib/error-reporting";

interface MetaInfo {
  generatedAt?: string;
  stale?: boolean;
}

interface PanelShellProps {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  info?: string;
  right?: ReactNode;
  meta?: MetaInfo;
  /** Query keys to invalidate when the user hits the inline refresh button. */
  refreshQueryKeys?: QueryKey[];
  isLoading?: boolean;
  skeletonHeight?: number;
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  tone?: SectionTone;
  children: ReactNode;
}

/**
 * Universal section wrapper used by every overview panel on /subnets/:netuid.
 * Provides a consistent freshness pill, optional inline refresh, skeleton,
 * empty state, and an error boundary with retry.
 */
export function PanelShell({
  id,
  title,
  subtitle,
  info,
  right,
  meta,
  refreshQueryKeys,
  isLoading,
  skeletonHeight = 160,
  isEmpty,
  emptyTitle,
  emptyDescription,
  tone,
  children,
}: PanelShellProps) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const stale = meta?.stale ?? isStaleFreshness(meta?.generatedAt);

  const onRefresh = async () => {
    if (!refreshQueryKeys?.length) return;
    setRefreshing(true);
    try {
      await Promise.all(
        refreshQueryKeys.map((key) =>
          queryClient.invalidateQueries({ queryKey: key, refetchType: "active" }),
        ),
      );
    } finally {
      setRefreshing(false);
    }
  };

  const headerRight = (
    <div className="flex items-center gap-2 min-w-0">
      {isUsableTimestamp(meta?.generatedAt) ? (
        <span
          className={
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] " +
            (stale
              ? "border-health-warn/40 bg-health-warn/10 text-health-warn"
              : "border-border bg-paper/60 text-ink-muted")
          }
          title={meta?.generatedAt}
        >
          {stale ? "stale · " : "updated "}
          <TimeAgo at={meta!.generatedAt} />
        </span>
      ) : null}
      {refreshQueryKeys?.length ? (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh panel"
          className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-ink-muted hover:text-ink-strong hover:border-ink/30 disabled:cursor-progress disabled:opacity-60"
        >
          <RefreshCw className={classNames("size-3", refreshing && "animate-spin")} />
        </button>
      ) : null}
      {right}
    </div>
  );

  return (
    <SectionAnchor
      id={id}
      title={title}
      subtitle={subtitle}
      info={info}
      right={headerRight}
      tone={tone}
    >
      <PanelErrorBoundary
        refreshQueryKeys={refreshQueryKeys}
        onRefresh={onRefresh}
        context={typeof title === "string" ? title : id}
      >
        {isLoading ? (
          <div
            className="rounded-xl border border-border bg-card p-4"
            aria-busy="true"
            aria-live="polite"
          >
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-3 h-8 w-full" />
            <Skeleton className="mt-2 h-8 w-3/4" />
            <div style={{ height: Math.max(0, skeletonHeight - 76) }} aria-hidden />
          </div>
        ) : isEmpty ? (
          <EmptyState
            title={emptyTitle ?? "Nothing to show"}
            description={emptyDescription}
            lastChecked={meta?.generatedAt}
          />
        ) : (
          <div className={classNames(refreshing && "mg-refreshing")}>{children}</div>
        )}
      </PanelErrorBoundary>
    </SectionAnchor>
  );
}

interface BoundaryProps {
  children: ReactNode;
  context: string;
  refreshQueryKeys?: QueryKey[];
  onRefresh: () => void | Promise<void>;
}
interface BoundaryState {
  error: unknown;
}

class PanelErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown, info: { componentStack?: string }) {
    // Single centralized seam — real telemetry is wired behind reportError.
    reportError(error, {
      boundary: "panel_shell",
      context: this.props.context,
      componentStack: info.componentStack,
    });
  }
  retry = async () => {
    await this.props.onRefresh();
    this.setState({ error: null });
  };
  render() {
    if (this.state.error) {
      return (
        <ErrorState error={this.state.error} onRetry={this.retry} context={this.props.context} />
      );
    }
    return this.props.children;
  }
}
