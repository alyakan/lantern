/**
 * The order the sidebar lists projects in: the user's own, saved (folder paths, first at the top). A project that isn't
 * in it yet (one just opened) goes at the top, so it's where you'd look for it, and is saved there. A saved project that
 * isn't listed now (removed from the recents) keeps its entry, so it comes back where it was.
 */

/** Saved entries kept at most; the oldest beyond this are forgotten. */
export const ORDER_LIMIT = 200;

/**
 * `folders`: the projects to list, newest first (the recents' order). Returns them in the saved order, with the new ones
 * on top in the order given, and the order to save (`order` itself when nothing was added).
 */
export function orderProjects(folders: string[], order: string[]): { listed: string[]; order: string[] } {
  const known = new Set(order);
  const fresh = folders.filter((f) => !known.has(f));
  const next = fresh.length === 0 ? order : [...fresh, ...order].slice(0, ORDER_LIMIT);
  const listing = new Set(folders);
  return { listed: next.filter((f) => listing.has(f)), order: next };
}

/**
 * The saved order with `folder` moved to `index` among the `listed` projects (what the sidebar shows). Projects not
 * listed keep their place relative to their neighbours: each stays right after the listed project it followed.
 */
export function moveProject(order: string[], listed: string[], folder: string, index: number): string[] {
  const from = listed.indexOf(folder);
  const to = Math.max(0, Math.min(index, listed.length - 1));
  if (from < 0 || from === to) return order;
  const moved = listed.filter((f) => f !== folder);
  moved.splice(to, 0, folder);
  // Each unlisted entry rides along behind the listed one before it (or leads, if none is before it).
  const shown = new Set(listed);
  const riders = new Map<string | null, string[]>();
  let last: string | null = null;
  for (const f of order) {
    if (shown.has(f)) last = f;
    else riders.set(last, [...(riders.get(last) ?? []), f]);
  }
  return [...(riders.get(null) ?? []), ...moved.flatMap((f) => [f, ...(riders.get(f) ?? [])])];
}
