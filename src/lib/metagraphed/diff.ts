// Minimal line-based diff (LCS) for readable schema drift view.
// Not optimized for huge files but fine for typical schema sizes.

export type DiffLine =
  | { kind: "ctx"; text: string; aLine: number; bLine: number }
  | { kind: "add"; text: string; bLine: number }
  | { kind: "del"; text: string; aLine: number };

export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;
  // LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ kind: "ctx", text: A[i], aLine: i + 1, bLine: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: A[i], aLine: i + 1 });
      i++;
    } else {
      out.push({ kind: "add", text: B[j], bLine: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: A[i], aLine: ++i });
  while (j < m) out.push({ kind: "add", text: B[j], bLine: ++j });
  return out;
}

export function diffStats(lines: DiffLine[]): {
  added: number;
  removed: number;
  unchanged: number;
} {
  let added = 0,
    removed = 0,
    unchanged = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
    else unchanged++;
  }
  return { added, removed, unchanged };
}
