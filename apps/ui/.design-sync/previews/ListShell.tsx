import { ListShell } from "metagraphed-ui";

function DemoTable() {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-muted">
          <th className="px-3 py-2">Subnet</th>
          <th className="px-3 py-2">Health</th>
        </tr>
      </thead>
      <tbody>
        <tr className="border-b border-border/60">
          <td className="px-3 py-2 text-ink-strong">64 — Chutes</td>
          <td className="px-3 py-2 text-health-ok">OK</td>
        </tr>
        <tr>
          <td className="px-3 py-2 text-ink-strong">1 — Text Prompting</td>
          <td className="px-3 py-2 text-health-warn">Degraded</td>
        </tr>
      </tbody>
    </table>
  );
}

export function Default() {
  return (
    <ListShell
      filters={<span className="text-xs text-ink-muted">2 subnets</span>}
      table={<DemoTable />}
    />
  );
}
