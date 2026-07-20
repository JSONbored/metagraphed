import { useEffect, useMemo } from "react";
import { GraphiQL } from "graphiql";
import { createGraphiQLFetcher } from "@graphiql/toolkit";
import { createClient, type Client } from "graphql-ws";
import { useTheme } from "@/lib/theme";
import { classNames } from "@/lib/metagraphed/format";
import "graphiql/style.css";
import "./graphiql-explorer.css";

// GraphiQL persists the query-editor/response split ratio to localStorage
// under "graphiql:editorFlex" (@graphiql/react's internal horizontal resize
// hook -- undocumented, no prop exposes it). The default 1:1 split leaves
// most of the response pane looking like dead space until a query runs.
// Only seed a wider editor share at desktop widths (matches the >=1024px
// breakpoint in graphiql-explorer.css that also relaxes the pane's
// min-width there) -- at narrower widths CodeMirror's own content width
// already governs a reasonable split, and forcing this ratio there would
// fight that and clip the query text instead. First-visit only: once a
// user drags the divider, their own ratio takes over here.
try {
  if (
    typeof window !== "undefined" &&
    window.innerWidth >= 1024 &&
    !window.localStorage.getItem("graphiql:editorFlex")
  ) {
    window.localStorage.setItem("graphiql:editorFlex", "1.6");
  }
} catch {
  // ignore quota / privacy-mode errors
}

const DEFAULT_QUERY = `{
  subnet(netuid: 7) {
    name
    health {
      status
    }
    surfaces {
      kind
      url
    }
    economics {
      emission_share
    }
  }
}
`;

export interface GraphiqlExplorerBodyProps {
  endpoint: string;
  /**
   * WebSocket URL for `graphql-transport-ws` subscriptions (#7009 / #4983).
   * Same path as the HTTP GraphQL endpoint (`/api/v1/graphql`), with
   * `https`→`wss` / `http`→`ws`. When omitted, subscriptions stay unsupported.
   */
  subscriptionUrl?: string;
  heightClassName: string;
}

export function GraphiqlExplorerBody({
  endpoint,
  subscriptionUrl,
  heightClassName,
}: GraphiqlExplorerBodyProps) {
  const { resolved } = useTheme();

  const wsClient = useMemo<Client | undefined>(() => {
    if (!subscriptionUrl) return undefined;
    return createClient({
      url: subscriptionUrl,
      // Open the socket only when a subscription actually runs.
      lazy: true,
    });
  }, [subscriptionUrl]);

  useEffect(() => {
    return () => {
      wsClient?.dispose();
    };
  }, [wsClient]);

  const fetcher = useMemo(
    () =>
      createGraphiQLFetcher({
        url: endpoint,
        ...(wsClient ? { wsClient } : {}),
      }),
    [endpoint, wsClient],
  );

  return (
    <div
      className={classNames(
        "mg-graphiql-frame overflow-hidden rounded-lg border border-border",
        heightClassName,
      )}
    >
      <GraphiQL
        fetcher={fetcher}
        defaultQuery={DEFAULT_QUERY}
        forcedTheme={resolved}
        showPersistHeadersSettings={false}
      />
    </div>
  );
}
