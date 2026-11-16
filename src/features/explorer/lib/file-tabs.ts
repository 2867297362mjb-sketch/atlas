// The docked tree beside a file tab. Which tab types are file tabs is a fact
// of the tab registry (`isFileTab`, `fileTabPath` in `@/lib/tab-registry`).

/**
 * The docked tree's width beside a file: 38% of the column, held between
 * 14rem and 20rem, so a narrow panel still gives the file most of its width. `cqw` is the column's own width (its content box is an
 * inline-size container), so the tree and the room the file leaves for it
 * resolve to the same length without either measuring the other.
 */
export const FILE_DOCK_WIDTH = "clamp(14rem, 38cqw, 20rem)";

/** The CSS variable a file tab's frame sets to the room its body leaves for
 *  the docked tree: {@link FILE_DOCK_WIDTH} while the tree is beside it, 0
 *  otherwise. A file view's body (not its header) applies it as its right
 *  margin, so the header runs the column's full width over the tree. */
export const FILE_DOCK_RESERVE_VAR = "--file-dock-reserve";
export const FILE_DOCK_RESERVE = `var(${FILE_DOCK_RESERVE_VAR}, 0px)`;
