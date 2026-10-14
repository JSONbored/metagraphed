/** Exact decimal aggregation for both SQLite and PostgreSQL. Each source row
 * is a u64 rao string and the qualified census is capped at1million rows.
 * Three base1e9 limb sums stay below signed64-bit bounds. Division subtracts
 * the remainder first: neither provider may round a carry. */
const BASE = 1_000_000_000;
const limb = (offset: number) =>
  `CAST(SUBSTR('000000000000000000000000000'||np.alpha_rao,LENGTH(np.alpha_rao)+${offset},9) AS BIGINT)`;
const carry = (value: string) => `((${value}-(${value}%${BASE}))/${BASE})`;
const padded = (value: string) =>
  `SUBSTR('000000000'||CAST(${value} AS TEXT),LENGTH(CAST(${value} AS TEXT))+1,9)`;

export function alphaHolderCte(capturedAt: number, predicate = "1=1"): string {
  if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0)
    throw new TypeError("Invalid qualified Alpha capture");
  const middle = `(s.am+${carry("s.al")})`;
  return `limbs AS (
    SELECT np.netuid,np.coldkey,SUM(${limb(1)}) ah,SUM(${limb(10)}) am,SUM(${limb(19)}) al,
      COUNT(DISTINCT np.hotkey) hotkey_count,MAX(np.captured_at) positions_captured_at
    FROM nominator_positions np JOIN alpha_snapshot_passes p ON p.captured_at=np.captured_at
      AND p.selected=1 AND p.completed_at IS NOT NULL
    WHERE np.source='alpha' AND np.netuid>0 AND np.captured_at=${capturedAt} AND (${predicate})
    GROUP BY np.netuid,np.coldkey),
    normalized AS (SELECT s.netuid,s.coldkey,s.hotkey_count,s.positions_captured_at,
      CAST(s.ah+${carry(middle)} AS BIGINT) ah,
      CAST(${middle}%${BASE} AS BIGINT) am,CAST(s.al%${BASE} AS BIGINT) al FROM limbs s),
    exact AS (SELECT n.*,${padded("n.ah")}||${padded("n.am")}||${padded("n.al")} alpha_key FROM normalized n),
    holder AS (SELECT e.*,CASE WHEN e.alpha_key='000000000000000000000000000' THEN '0'
      ELSE LTRIM(e.alpha_key,'0') END alpha_rao,
      CAST(e.alpha_key AS DOUBLE PRECISION)/1000000000 alpha FROM exact e)`;
}
