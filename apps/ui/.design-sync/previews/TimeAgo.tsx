import { TimeAgo } from "metagraphed-ui";

const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();

export function Default() {
  return (
    <span className="font-mono text-xs text-ink-muted">
      <TimeAgo at={recent} />
    </span>
  );
}

export function Missing() {
  return (
    <span className="font-mono text-xs text-ink-muted">
      <TimeAgo at={null} />
    </span>
  );
}
