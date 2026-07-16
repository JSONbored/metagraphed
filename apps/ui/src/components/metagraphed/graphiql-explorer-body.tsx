import { useMemo } from "react";
import { GraphiQL } from "graphiql";
import { createGraphiQLFetcher } from "@graphiql/toolkit";
import { useTheme } from "@/lib/theme";
import "graphiql/style.css";
import "./graphiql-explorer.css";

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
}

export function GraphiqlExplorerBody({ endpoint }: GraphiqlExplorerBodyProps) {
  const { resolved } = useTheme();
  const fetcher = useMemo(() => createGraphiQLFetcher({ url: endpoint }), [endpoint]);

  return (
    <div className="mg-graphiql-frame h-[640px] overflow-hidden rounded-lg border border-border">
      <GraphiQL
        fetcher={fetcher}
        defaultQuery={DEFAULT_QUERY}
        forcedTheme={resolved}
        showPersistHeadersSettings={false}
      />
    </div>
  );
}
