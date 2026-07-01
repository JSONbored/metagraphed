// Per-extrinsic detail with embedded account_events (#1849): shared D1 loader for
// REST GET /extrinsics/{ref} and MCP get_extrinsic. Ref is a 0x hash or composite
// block_number-extrinsic_index; unknown refs return extrinsic:null + events:[].

import {
  ACCOUNT_EVENT_COLUMNS,
  formatAccountEvent,
} from "./account-events.mjs";
import { EXTRINSIC_READ_COLUMNS, buildExtrinsic } from "./extrinsics.mjs";

const COMPOSITE_REF_RE = /^(\d+)-(\d+)$/;
const MAX_EMBEDDED_EVENTS = 50;

export async function loadExtrinsicDetail(d1, ref) {
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(String(ref));
  let rows;
  if (isHash) {
    rows = await d1(
      `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics WHERE extrinsic_hash = ? ORDER BY block_number DESC, extrinsic_index DESC LIMIT 1`,
      [String(ref).toLowerCase()],
    );
  } else {
    const composite = COMPOSITE_REF_RE.exec(String(ref));
    const blockNumber = composite ? Number(composite[1]) : NaN;
    const extrinsicIndex = composite ? Number(composite[2]) : NaN;
    rows =
      composite &&
      Number.isSafeInteger(blockNumber) &&
      Number.isSafeInteger(extrinsicIndex)
        ? await d1(
            `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics WHERE block_number = ? AND extrinsic_index = ? LIMIT 1`,
            [blockNumber, extrinsicIndex],
          )
        : [];
  }

  const resolved = rows[0];
  let events = [];
  if (
    resolved &&
    resolved.block_number != null &&
    resolved.extrinsic_index != null
  ) {
    const eventRows = await d1(
      `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events WHERE block_number = ? AND extrinsic_index = ? ORDER BY event_index ASC LIMIT ?`,
      [resolved.block_number, resolved.extrinsic_index, MAX_EMBEDDED_EVENTS],
    );
    events = (eventRows || []).map(formatAccountEvent).filter(Boolean);
  }

  return buildExtrinsic(resolved, ref, events);
}
