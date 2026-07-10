/**
 * Layout tokens for the subnets compare drawer grid (#3933).
 *
 * The comparison table grows one column per selected subnet. `w-full` on the
 * table pins it to the drawer width and prevents horizontal scroll — use `w-max`
 * inside an `overflow-x-auto` shell instead.
 *
 * @see https://github.com/JSONbored/metagraphed/issues/3933
 */

/** Vertical scroll shell — preserves the existing 55vh cap. */
export const COMPARE_GRID_OUTER_CLASS = "border-t border-border max-h-[55vh] overflow-y-auto";

/** Horizontal scroll shell — table may exceed drawer width as columns are added. */
export const COMPARE_TABLE_SCROLL_CLASS = "overflow-x-auto";

/** Intrinsic table width: at least full container, grows with column count. */
export const COMPARE_TABLE_CLASS = "w-max min-w-full text-[12px]";

/** Per-subnet columns — avoid squashing SN labels / metric values on narrow viewports. */
export const COMPARE_SUBNET_COLUMN_CLASS = "min-w-[8.5rem] whitespace-nowrap";
